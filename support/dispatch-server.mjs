import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BusinessError, badRequest, notFound, conflict,
  loadState, saveState, nextId, isoTime, asId, idList,
  roadById, addEvent, evaluateRoute, createArrangement, getArrangement,
  releaseArrangement, expireReservations,
} from './dispatch-core.mjs';
import {
  createAffectedService, confirmSituation, prepareDispatch, recordExternalResult,
  applyReceipt, recordCheckpoint, departArrangement, handoverArrangement,
  updateShelterReceiving, updateContingency, openContingency,
  createRefund, decideRefund, confirmLegFulfillment, passengerView,
  vehicleView, shelterView, operatorView, carrierManifest,
} from './dispatch-ops.mjs';
import { submitDispatches, fetchDispatch } from './carrier.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function fingerprintBody(body) {
  return JSON.stringify(body ?? {});
}

const SNAKE_ALIASES = {
  passenger_id: 'passengerId',
  passenger_ids: 'passengerIds',
  passenger_list: 'passengers',
  ticket_id: 'ticketId',
  identity_ref: 'identityRef',
  service_id: 'serviceId',
  arrangement_id: 'arrangementId',
  assignment_id: 'assignmentId',
  plan_id: 'planId',
  vehicle_id: 'vehicleId',
  shelter_id: 'shelterId',
  road_id: 'roadId',
  road_ids: 'roadIds',
  route_ids: 'routeIds',
  current_location_id: 'currentLocationId',
  location_id: 'locationId',
  new_confirmed_location_id: 'newConfirmedLocationId',
  new_shelter_id: 'newShelterId',
  temporary_responsible_id: 'temporaryResponsibleId',
  responsible_id: 'responsibleId',
  actor_id: 'actorId',
  operator_id: 'operatorId',
  carrier_id: 'carrierId',
  guardian_id: 'guardianId',
  roster_key: 'rosterKey',
  list_key: 'listKey',
  dispatch_key: 'dispatchKey',
  request_key: 'requestKey',
  idempotency_key: 'idempotencyKey',
  request_id: 'requestId',
  ttl_minutes: 'ttlMinutes',
  hold_minutes: 'holdMinutes',
  departure_at: 'departureAt',
  arrival_at: 'arrivalAt',
  occurred_at: 'occurredAt',
  last_arrival: 'lastArrival',
  vehicle_types: 'vehicleTypes',
  wheelchair_slots: 'wheelchairSlots',
  accessible_beds: 'accessibleBeds',
  all_unfulfilled: 'allUnfulfilled',
  abandon_continuation: 'abandonContinuation',
  split_consent: 'splitConsent',
  original_vehicle_will_run: 'originalVehicleWillRun',
  confirmed_by: 'confirmedBy',
  received_by: 'receivedBy',
  source_change_id: 'sourceChangeId',
};

function normalizeRequestKeys(value) {
  if (Array.isArray(value)) {
    value.forEach(normalizeRequestKeys);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  for (const [snake, camel] of Object.entries(SNAKE_ALIASES)) {
    if (value[camel] === undefined && value[snake] !== undefined) value[camel] = value[snake];
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') normalizeRequestKeys(child);
  }
  return value;
}

function publishRestriction(state, roadId, body = {}) {
  const road = roadById(state, roadId ?? asId(body.roadId ?? body.road));
  const vehicleTypes = body.vehicleTypes ?? body.vehicleType ?? ['coach'];
  const restriction = {
    id: asId(body.id ?? body.restrictionId) ?? nextId(state, 'CLOSE', 'restriction'),
    road: road.id,
    direction: `${road.from}->${road.to}`,
    vehicleTypes: Array.isArray(vehicleTypes) ? vehicleTypes : [vehicleTypes],
    start: body.start ? isoTime(body.start) : isoTime(body.at ?? body.effectiveAt),
    end: body.end ? isoTime(body.end) : (body.until ? isoTime(body.until) : null),
    reason: body.reason ?? null,
    status: 'published',
    sourceChangeId: body.sourceChangeId ?? null,
    publishedBy: body.actorId ?? body.publishedBy ?? 'dispatch',
    publishedAt: new Date().toISOString(),
  };
  if (state.restrictions.some(r => r.id === restriction.id)) throw conflict('RESTRICTION_ID_EXISTS', '限行编号已存在', { id: restriction.id });
  state.restrictions.push(restriction);
  addEvent(state, { type: 'restriction.published', restrictionId: restriction.id, roadId: road.id });
  return restriction;
}

function publishRestrictionInput(state, inputId, body = {}) {
  const input = state.restrictionInputs?.find(r => r.id === asId(inputId));
  if (!input) throw notFound('未找到限行输入资料', { inputId });
  const existing = state.restrictions.find(r => r.id === (body.id ?? input.id));
  if (existing?.status === 'published') return existing;
  return publishRestriction(state, input.road, { ...input, ...body, id: body.id ?? input.id });
}

function liftRestriction(state, restrictionId, body = {}) {
  const restriction = state.restrictions.find(r => r.id === asId(restrictionId));
  if (!restriction) throw notFound('未找到限行记录', { restrictionId });
  if (restriction.status !== 'lifted') {
    restriction.status = 'lifted';
    restriction.liftedAt = isoTime(body.at);
    restriction.liftedBy = body.actorId ?? body.liftedBy ?? 'dispatch';
    restriction.liftReason = body.reason ?? null;
    addEvent(state, { type: 'restriction.lifted', restrictionId: restriction.id, roadId: restriction.road });
  }
  return restriction;
}

async function readJsonBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new BusinessError(413, 'PAYLOAD_TOO_LARGE', '请求资料过大');
  }
  if (!raw) return {};
  try { return normalizeRequestKeys(JSON.parse(raw)); } catch { throw badRequest('JSON 格式不符'); }
}

export function createDispatchServer(first = {}, maybeOptions = {}) {
  if (typeof maybeOptions === 'string') maybeOptions = { stateFile: maybeOptions };
  let normalizedFirst = first;
  if (first && typeof first === 'object' && !Array.isArray(first) && Array.isArray(first.passengers) && first.seq && first.state === undefined && first.stateFile === undefined) {
    normalizedFirst = { state: first, ...maybeOptions };
  }
  const options = typeof normalizedFirst === 'string' ? { stateFile: normalizedFirst, ...maybeOptions } : { ...normalizedFirst, ...maybeOptions };
  const stateFile = options.stateFile ?? process.env.DISPATCH_STATE ?? process.env.RESCUE_STATE ?? process.env.DATA_FILE ?? process.env.STATE_FILE ?? '.local/dispatch.json';
  const persist = options.persist ?? (!options.state || options.stateFile !== undefined);
  let state = options.state ? structuredClone(options.state) : loadState(stateFile);
  const carrierUrl = options.carrierUrl ?? process.env.CARRIER_URL ?? process.env.PARTNER_URL ?? null;
  const fetchImpl = options.fetch ?? fetch;

  let queue = Promise.resolve();
  function tx(work) {
    const run = queue.then(async () => {
      // 业务操作整体同步修改状态；失败时回滚内存状态且不落盘，避免半条安排/部分同意生效。
      const snapshot = structuredClone(state);
      try {
        const value = await work(state);
        if (persist) saveState(stateFile, state);
        server.dispatchState.state = state;
        return value;
      } catch (error) {
        state = structuredClone(snapshot);
        server.dispatchState.state = state;
        throw error;
      }
    });
    // 不让一次失败中断后续事务队列。
    queue = run.then(() => {}, () => {});
    return run;
  }

  function send(res, status, value) {
    if (res.writableEnded) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, Dispatch-Key, X-Actor-Id',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    });
    res.end(JSON.stringify(value));
  }

  async function handle(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, Dispatch-Key, X-Actor-Id',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      });
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    const body = await readJsonBody(req);
    const idemHeader = req.headers['idempotency-key'];
    if (!body.idempotencyKey) body.idempotencyKey = idemHeader ?? body.idempotency_key ?? body.requestId ?? body.request_id;
    let pathname = url.pathname.replace(/^\/api(?:\/v\d+)?(?=\/|$)/, '');
    pathname = pathname.replace(/^\/v\d+(?=\/|$)/, '') || '/';
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
    const seg = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const singularAliases = {
      passenger: 'passengers',
      arrangement: 'arrangements',
      assignment: 'arrangements',
      continuation: 'arrangements',
      plan: 'plans',
      service: 'services',
      'affected-service': 'services',
      trip: 'services',
      incident: 'services',
      ticket: 'tickets',
      road: 'roads',
      restriction: 'restrictions',
      closure: 'restrictions',
      closures: 'restrictions',
      'road-closure': 'restrictions',
      'road-closures': 'restrictions',
      shelter: 'shelters',
      vehicle: 'vehicles',
      bus: 'vehicles',
      refund: 'refunds',
      contingency: 'contingencies',
      consent: 'consents',
      handover: 'handovers',
      dispatch: 'dispatch-requests',
    };
    if (singularAliases[seg[0]]) seg[0] = singularAliases[seg[0]];
    const query = normalizeRequestKeys(Object.fromEntries(url.searchParams.entries()));
    const method = req.method;

    const result = await route(method, seg, body, query, req);
    if (result === undefined) return send(res, 404, { ok: false, success: false, error: 'NOT_FOUND', code: 'NOT_FOUND', message: '没有对应的调度处置接口' });
    if (result && typeof result === 'object') {
      if (result.ok === undefined) result.ok = true;
      result.success = result.ok !== false;
    }
    const status = typeof result.httpStatus === 'number' ? result.httpStatus : 200;
    delete result.httpStatus;
    return send(res, status, result);
  }

  async function route(method, seg, body, query, req) {
    const s = seg[0];
    const id = seg[1];
    const action = seg[2];
    const subAction = seg[3];
    const actorId = body.actorId ?? req.headers['x-actor-id'] ?? null;
    const operatorContext = body.operatorId ?? req.headers['x-operator-id'] ?? operatorFromActor(state, actorId);
    if (actorId && !body.actorId) body.actorId = actorId;

    if (!s && method === 'GET') return apiIndex();
    if (s === 'health' && method === 'GET') return { ok: true, status: 'ok', service: 'snow-rescue-dispatch', carrierUrl: carrierUrl ? 'configured' : 'manual' };
    if ((s === 'state' || (s === 'control' && id === 'state')) && method === 'GET') return tx(st => ({ ...st }));
    if (s === 'control' && id === 'expire' && method === 'POST') {
      await tx(st => expireReservations(st, body.at));
      return { ok: true };
    }

    // 受影响班次与清单。
    if (['services', 'affected-services', 'trips', 'incidents'].includes(s)) {
      if (method === 'GET' && !id) return tx(st => ({ services: st.affectedServices, data: st.affectedServices }));
      if (method === 'POST' && !id) return tx(st => createAffectedService(st, body));
      if (id && method === 'GET') return tx(st => {
        const service = st.affectedServices.find(x => x.id === id);
        if (!service) throwNotFound('受影响班次不存在', id);
        return { service, passengers: service.passengerIds.map(pid => passengerView(st, pid)) };
      });
      if (id && ['confirm', 'confirm-passengers', 'passenger-status'].includes(action) && method === 'POST') {
        return tx(st => {
          const service = st.affectedServices.find(x => x.id === id) ?? throwNotFound('受影响班次不存在', id);
          const updates = body.updates ?? body.passengers ?? [];
          if (Array.isArray(updates) && updates.length) {
            for (const update of updates) {
              const pid = asId(update.passengerId ?? update.id);
              confirmSituation(st, pid, { actorId: body.actorId, ...update });
            }
          } else {
            for (const pid of service.passengerIds) confirmSituation(st, pid, body);
          }
          return { ok: true, service, passengers: service.passengerIds.map(pid => passengerView(st, pid)) };
        });
      }
    }

    // 旅客查询与状态确认。
    if (s === 'passengers') {
      if (method === 'GET' && !id) return tx(st => ({ passengers: st.passengers.map(p => passengerView(st, p.id, query)), data: st.passengers.map(p => passengerView(st, p.id, query)) }));
      if (method === 'POST' && !id) return tx(st => upsertPassengerRoute(st, body));
      if (id === 'lookup' && method === 'POST') return tx(st => lookupPassenger(st, body));
      if (!id) return undefined;
      if (method === 'GET' && !action) return tx(st => withSelf(passengerView(st, id, query), 'passenger'));
      if (['confirm', 'situation', 'status', 'location'].includes(action) && ['POST', 'PUT', 'PATCH'].includes(method)) {
        return tx(st => withSelf(confirmSituation(st, id, body), 'passenger'));
      }
      if (action === 'verify' && method === 'POST') return tx(st => ({ verified: true, ...verifyIdentityRoute(st, id, body) }));
      if (['refunds', 'refund', 'refund-status', 'refund-progress'].includes(action)) {
        if (method === 'GET') return tx(st => ({ refunds: st.refundRequests.filter(r => r.passengerId === id), refundProgress: st.refundRequests.flatMap(r => r.progress) }));
        if (method === 'POST' && ['refunds', 'refund'].includes(action)) return tx(st => createRefund(st, id, body, operatorContext));
      }
      if (action === 'consent' && method === 'POST') return tx(st => addConsent(st, id, body));
    }

    // 原票履行与退款。
    if (s === 'tickets') {
      if (method === 'GET' && !id) return tx(st => ({ tickets: st.tickets }));
      if (id && method === 'GET') return tx(st => {
        const ticket = st.tickets.find(t => t.id === id) ?? throwNotFound('原票不存在', id);
        return { ticket, passengers: st.passengers.filter(p => p.ticket === id).map(passenger => passengerView(st, passenger.id)) };
      });
      if (action === 'legs' && seg[3] && seg[4] === 'fulfill' && method === 'POST') {
        return tx(st => confirmLegFulfillment(st, { operatorId: operatorContext ?? undefined, ...body, ticketId: id, leg: seg[3] }));
      }
      if (action === 'fulfill' && body.leg) return tx(st => confirmLegFulfillment(st, { operatorId: operatorContext ?? undefined, ...body, ticketId: id }));
    }
    if (s === 'legs' && id && action === 'fulfill' && method === 'POST') {
      return tx(st => confirmLegFulfillment(st, { operatorId: operatorContext ?? undefined, ...body, leg: id }));
    }

    // 道路与限行。
    if (s === 'roads') {
      if (method === 'GET' && !id) return tx(st => ({ roads: st.roads.map(r => roadView(st, r.id, query)), restrictions: st.restrictions }));
      if (id && method === 'GET' && !action) return tx(st => roadView(st, id, query));
      if (id && ['restrictions', 'close', 'closure'].includes(action) && method === 'POST') {
        return tx(st => publishRestriction(st, id, body));
      }
      if (id && action === 'open' && method === 'POST') {
        return tx(st => {
          if (body.restrictionId) return liftRestriction(st, body.restrictionId, body);
          const active = st.restrictions.filter(r => r.road === id && r.status === 'published');
          return { lifted: active.map(r => liftRestriction(st, r.id, body)), note: '仅解除该定向路段上的限行，不推断反向或相邻路段' };
        });
      }
      if (id && action === 'route' && method === 'POST') return tx(st => evaluateRoute(st, { ...body, from: body.from ?? id }));
    }
    if (['restriction-inputs', 'restrictionInputs', 'road-restriction-inputs'].includes(s)) {
      if (method === 'GET' && !id) return tx(st => ({ restrictionInputs: st.restrictionInputs }));
      if (id && method === 'GET') return tx(st => st.restrictionInputs.find(r => r.id === id) ?? throwNotFound('限行输入不存在', id));
      if (id && ['publish', 'apply', 'confirm'].includes(action) && method === 'POST') return tx(st => publishRestrictionInput(st, id, body));
    }
    if (s === 'restrictions') {
      if (method === 'GET' && !id) return tx(st => ({ restrictions: st.restrictions, restrictionInputs: st.restrictionInputs }));
      if (method === 'POST' && !id) return tx(st => publishRestriction(st, asId(body.roadId ?? body.road), body));
      if (id && ['publish', 'apply'].includes(action) && method === 'POST') {
        return tx(st => st.restrictions.some(r => r.id === id)
          ? st.restrictions.find(r => r.id === id)
          : publishRestrictionInput(st, id, body));
      }
      if (id && ['lift', 'revoke', 'cancel'].includes(action) && method === 'POST') return tx(st => liftRestriction(st, id, body));
      if (id && method === 'DELETE') return tx(st => liftRestriction(st, id, body));
    }

    // 方案、接续安排、派车。
    if (['plans', 'arrangements', 'assignments', 'continuations'].includes(s)) {
      const proposalOnly = s === 'plans';
      if (method === 'GET' && !id) return tx(st => listArrangements(st, query, proposalOnly));
      if (method === 'POST' && !id) return tx(st => withSelf(createArrangement(st, body, { proposalOnly }), proposalOnly ? 'plan' : 'arrangement'));
      if (!id) return undefined;
      if (method === 'GET' && !action) return tx(st => withSelf(getArrangement(st, id), s === 'plans' ? 'plan' : 'arrangement'));
      if (action === 'route-check' && method === 'POST') return tx(st => evaluateRoute(st, { ...getArrangement(st, id).route, ...body }));
      if (['release', 'cancel'].includes(action) && method === 'POST') return tx(st => withSelf(releaseArrangement(st, id, body), 'arrangement'));
      if (['check-in', 'checkin', 'report'].includes(action) && method === 'POST') return tx(st => recordCheckpoint(st, id, 'report', body));
      if (['board', 'pickup', 'pick-up'].includes(action) && method === 'POST') return tx(st => recordCheckpoint(st, id, 'board', body));
      if (action === 'depart' && method === 'POST') return tx(st => departArrangement(st, id, body));
      if (action === 'arrive' && method === 'POST') return tx(st => recordCheckpoint(st, id, 'arrive', body));
      if (['handover', 'handoff', 'transfer'].includes(action) && method === 'POST') return tx(st => handoverArrangement(st, id, body));
      if (['no-show', 'missing'].includes(action) && method === 'POST') return tx(st => recordCheckpoint(st, id, 'no-show', body));
      if (['dispatch', 'send', 'send-to-carrier'].includes(action) && method === 'POST') return dispatchRoute(id, body);
      if (action === 'receipt' && method === 'POST') return tx(st => applyReceipt(st, id, body));
      if (action === 'poll' && method === 'POST') return pollDispatchRoute(id, body);
    }

    if (s === 'reservations' || s === 'holds' || s === 'bookings') {
      if (method === 'GET' && !id) return tx(st => ({ reservations: st.reservations, data: st.reservations }));
      if (id && method === 'GET') return tx(st => st.reservations.find(r => r.id === id) ?? throwNotFound('预留记录不存在', id));
      if (id && ['renew', 'extend'].includes(action) && method === 'POST') {
        return tx(st => {
          const reservation = st.reservations.find(r => r.id === id) ?? throwNotFound('预留记录不存在', id);
          if (!['held'].includes(reservation.status)) throw conflict('RESERVATION_NOT_HELD', '只有有效预留可以延期', { status: reservation.status });
          reservation.expiresAt = body.expiresAt ? isoTime(body.expiresAt) : new Date(Date.now() + Number(body.ttlMinutes ?? 15) * 60000).toISOString();
          return reservation;
        });
      }
      if (id && ['release', 'cancel'].includes(action) && method === 'POST') {
        return tx(st => {
          const reservation = st.reservations.find(r => r.id === id) ?? throwNotFound('预留记录不存在', id);
          reservation.status = 'released';
          reservation.releasedAt = isoTime(body.at);
          reservation.releaseReason = body.reason ?? '人工释放预留';
          return reservation;
        });
      }
    }

    if (s === 'dispatch-requests' || s === 'dispatches') {
      if (method === 'GET' && !id) return tx(st => ({ dispatchRequests: st.dispatchRequests }));
      if (method === 'POST' && !id) {
        let arrangementIdValue = asId(body.arrangementId ?? body.arrangement ?? body.assignmentId ?? body.planId);
        if (!arrangementIdValue && body.id && state.arrangements.some(a => a.id === body.id)) arrangementIdValue = body.id;
        if (!arrangementIdValue && (body.passengerIds || body.passengers || body.passengerId)) {
          const created = await tx(st => createArrangement(st, body));
          arrangementIdValue = created.id;
        }
        if (arrangementIdValue) return dispatchRoute(arrangementIdValue, body);
      }
      if (id && method === 'GET') return tx(st => {
        const req = st.dispatchRequests.find(r => r.id === id || r.items.some(i => i.dispatchNo === id)) ?? throwNotFound('派车请求不存在', id);
        return { dispatchRequest: req, request: req };
      });
      if (id && ['receipt', 'callback', 'settle'].includes(action) && method === 'POST') return tx(st => applyReceipt(st, id, body));
      if (id && action === 'poll' && method === 'POST') return pollDispatchRoute(id, body);
      if (id === 'receipt' && method === 'POST') return tx(st => applyReceipt(st, body.dispatchRequestId ?? body.id ?? body.dispatchNo, body));
    }
    if (s === 'coach' && ['manifest', 'passengers'].includes(id) && method === 'GET') {
      return tx(st => carrierManifest(st, query.carrierId ?? query.operatorId, query.vehicleId ?? body.vehicleId));
    }
    if (s === 'carrier' && id === 'receipt' && method === 'POST') {
      return tx(st => applyReceipt(st, body.dispatchRequestId ?? body.id ?? body.dispatchNo, body));
    }

    // 报到/上车/移交等通用名册接口。
    if (s === 'recommend' && method === 'POST') {
      return tx(st => withSelf(createArrangement(st, body, { proposalOnly: true }), 'plan'));
    }
    if (s === 'routes') {
      if (['recommend', 'plan', 'proposal'].includes(id) && method === 'POST') {
        return tx(st => withSelf(createArrangement(st, body, { proposalOnly: true }), 'plan'));
      }
      if (['evaluate', 'check', 'route-check'].includes(id) && method === 'POST') return tx(st => evaluateRoute(st, body));
      if (method === 'POST' && !id) return tx(st => evaluateRoute(st, body));
    }
    if (['check-in', 'checkin', 'report'].includes(s) && method === 'POST') return checkpointFromBody('report');
    if (['board', 'pickup', 'pick-up'].includes(s) && method === 'POST') return checkpointFromBody('board');
    if (s === 'depart' && method === 'POST') {
      const arrangementId = asId(body.arrangementId ?? body.arrangement ?? body.assignmentId ?? body.id);
      return tx(st => departArrangement(st, arrangementId, body));
    }
    if (s === 'arrive' && method === 'POST') return checkpointFromBody('arrive');
    if (s === 'no-show' && method === 'POST') return checkpointFromBody('no-show');
    if (s === 'release' && method === 'POST') {
      const arrangementId = asId(body.arrangementId ?? body.arrangement ?? body.assignmentId ?? body.id);
      return tx(st => releaseArrangement(st, arrangementId, body));
    }
    if (['check-ins', 'checkins', 'reports'].includes(s) && method === 'POST') return checkpointFromBody('report');
    if (['boardings', 'pickups', 'pick-ups'].includes(s) && method === 'POST') return checkpointFromBody('board');
    if (s === 'departures' && method === 'POST') {
      const arrangementId = asId(body.arrangementId ?? body.arrangement ?? body.assignmentId);
      return tx(st => departArrangement(st, arrangementId, body));
    }
    if (s === 'arrivals' && method === 'POST') return checkpointFromBody('arrive');
    if (s === 'handovers') {
      if (method === 'GET' && !id) return tx(st => ({ handovers: st.handovers }));
      if (method === 'POST' && !id) return tx(st => handoverArrangement(st, asId(body.arrangementId ?? body.arrangement), body));
      if (id && method === 'GET') return tx(st => st.handovers.find(h => h.id === id) ?? throwNotFound('移交记录不存在', id));
    }

    // 安置点。
    if (['shelters', 'shelter'].includes(s)) {
      if (method === 'GET' && !id) return tx(st => ({ shelters: st.shelters.map(x => shelterView(st, x.id)), data: st.shelters.map(x => shelterView(st, x.id)) }));
      if (method === 'POST' && !id) return tx(st => createResource(st, 'shelters', body));
      if (!id) return undefined;
      if (method === 'GET' && ['occupancy', 'counts'].includes(action)) return tx(st => shelterView(st, id));
      if (method === 'GET' && !action) return tx(st => withSelf(shelterView(st, id), 'shelter'));
      if (method === 'PATCH' && !action) return updateShelterRoute(id, body);
      if (method === 'PUT' && !action) return updateShelterRoute(id, body);
      if (method === 'POST' && !action) return updateShelterRoute(id, body);
      if (['acceptance', 'receiving', 'stop-receiving', 'stop', 'close', 'status'].includes(action) && method === 'POST') {
        return updateShelterRoute(id, ['stop-receiving', 'stop', 'close'].includes(action) ? { ...body, accepting: false } : body);
      }
      if (action === 'open-receiving' && method === 'POST') return updateShelterRoute(id, { ...body, accepting: true });
    }

    // 车辆与承运人名册。
    if (['vehicles', 'vehicle', 'buses'].includes(s)) {
      if (method === 'GET' && !id) return tx(st => ({ vehicles: st.vehicles.map(v => vehicleView(st, v.id)), data: st.vehicles.map(v => vehicleView(st, v.id)) }));
      if (method === 'POST' && !id) return tx(st => createResource(st, 'vehicles', body));
      if (!id) return undefined;
      if (method === 'GET' && ['manifest', 'passengers'].includes(action)) return tx(st => carrierManifest(st, query.carrierId ?? body.carrierId, id));
      if (method === 'GET' && !action) return tx(st => withSelf(vehicleView(st, id), 'vehicle'));
      if (['PATCH', 'PUT'].includes(method) && !action) return tx(st => updateVehicle(st, id, body));
      if (method === 'POST' && !action) return tx(st => updateVehicle(st, id, body));
    }
    if (s === 'carriers') {
      if (id && seg[2] === 'vehicles' && seg[3] && seg[4] === 'manifest') {
        const vehicleId = seg[3];
        return tx(st => carrierManifest(st, id, vehicleId));
      }
      if (id && action === 'manifest' && method === 'GET') return tx(st => carrierManifest(st, id, query.vehicleId));
      if (id && method === 'GET' && !action) return tx(st => operatorView(st, id));
    }

    // 安置异常/在途接续处置。
    if (s === 'contingencies') {
      if (method === 'GET' && !id) return tx(st => ({ contingencies: st.contingencies }));
      if (method === 'POST' && !id) return tx(st => openContingency(st, body));
      if (!id) return undefined;
      if (method === 'GET' && !action) return tx(st => st.contingencies.find(c => c.id === id) ?? throwNotFound('接续处置事项不存在', id));
      if (['update', 'confirm', 'confirm-location', 'location', 'resolve'].includes(action) && method === 'POST') {
        return tx(st => updateContingency(st, id, { ...body, confirm: ['confirm', 'confirm-location', 'location'].includes(action) ? true : body.confirm, resolve: action === 'resolve' ? true : body.resolve }));
      }
      if (method === 'PATCH') return tx(st => updateContingency(st, id, body));
    }

    // 退款与运营方范围。
    if (s === 'refunds') {
      if (method === 'GET' && !id) return tx(st => ({ refunds: st.refundRequests }));
      if (method === 'POST' && !id) return tx(st => createRefund(st, asId(body.passengerId ?? body.passenger), body, operatorContext));
      if (id && method === 'GET') return tx(st => ({ refund: st.refundRequests.find(r => r.id === id) ?? throwNotFound('退款申请不存在', id) }));
      if (id && ['approve', 'approved'].includes(action) && method === 'POST') return tx(st => decideRefund(st, id, { ...body, status: 'approved' }, operatorContext));
      if (id && ['reject', 'rejected'].includes(action) && method === 'POST') return tx(st => decideRefund(st, id, { ...body, status: 'rejected' }, operatorContext));
      if (id && ['process', 'processing'].includes(action) && method === 'POST') return tx(st => decideRefund(st, id, { ...body, status: 'processing' }, operatorContext));
      if (id && ['refund', 'refunded', 'complete'].includes(action) && method === 'POST') return tx(st => decideRefund(st, id, { ...body, status: 'refunded' }, operatorContext));
      if (id && action === 'decision' && method === 'POST') return tx(st => decideRefund(st, id, body, operatorContext));
    }
    if (s === 'operators') {
      const operatorId = id;
      if (!operatorId) return undefined;
      if (method === 'GET' && !action) return tx(st => operatorView(st, operatorId));
      if (action === 'refunds' && !subAction) {
        if (method === 'GET') return tx(st => ({ ...operatorView(st, operatorId), refunds: st.refundRequests.filter(r => r.operator === operatorId) }));
        if (method === 'POST') {
          const passengerId = asId(body.passengerId ?? body.passenger);
          return tx(st => createRefund(st, passengerId, body, operatorId));
        }
      }
      if (action === 'refunds' && seg[3] && seg[4] === 'decision') {
        return tx(st => decideRefund(st, seg[3], body, operatorId));
      }
      if (action === 'refunds' && seg[3] && ['approve', 'reject', 'refund'].includes(seg[4] ?? '')) {
        const refundId = seg[3];
        const status = seg[4] === 'approve' ? 'approved' : seg[4] === 'reject' ? 'rejected' : 'refunded';
        return tx(st => decideRefund(st, refundId, { ...body, status }, operatorId));
      }
      if (action === 'tickets' && method === 'GET') return tx(st => operatorView(st, operatorId));
    }

    // 同行同意。
    if (s === 'consents') {
      if (method === 'GET') return tx(st => ({ consents: st.consents }));
      if (method === 'POST') return tx(st => addConsent(st, body.passengerId ?? body.passenger, body));
    }

    // 原始变更收件箱：保留来源，显式应用，不自动视为批准。
    if (s === 'source-changes' || s === 'changes') {
      if (method === 'GET' && !id) return tx(st => ({ sourceChanges: st.sourceChanges }));
      if (id && method === 'GET') return tx(st => st.sourceChanges.find(c => c.id === id) ?? throwNotFound('来源变更不存在', id));
      if (id && ['apply', 'process', 'confirm'].includes(action) && method === 'POST') return applySourceChange(id, body);
    }

    if (s === 'overview' && method === 'GET') return tx(st => overview(st));
    return undefined;

    async function dispatchRoute(arrangementIdValue, dispatchBody) {
      if (!dispatchBody.dispatchKey && req.headers['dispatch-key']) dispatchBody.dispatchKey = req.headers['dispatch-key'];
      const arrangementId = asId(arrangementIdValue);
      const prepared = await tx(st => prepareDispatch(st, arrangementId, dispatchBody));
      if (prepared.httpStatus) return prepared;
      let external = null;
      if (carrierUrl) {
        external = await submitDispatches({ baseUrl: carrierUrl, key: prepared.key, items: prepared.items, fetchImpl });
        await tx(st => recordExternalResult(st, prepared.request.id, external));
      }
      const fresh = await tx(st => ({
        arrangement: getArrangement(st, arrangementId),
        request: st.dispatchRequests.find(r => r.id === prepared.request.id),
      }));
      return {
        httpStatus: external?.unknown ? 202 : 200,
        ok: true,
        status: fresh.arrangement.dispatchState,
        dispatchState: fresh.arrangement.dispatchState,
        carrier: carrierUrl ? (external.unknown ? 'receipt_unknown' : external.status) : 'manual-receipt-endpoint',
        external,
        ...fresh,
      };
    }

    async function pollDispatchRoute(target, pollBody) {
      if (!carrierUrl) {
        return tx(st => applyReceipt(st, target, pollBody));
      }
      const request = await tx(st => {
        const r = st.dispatchRequests.find(x => x.id === asId(target)) ?? st.dispatchRequests.find(x => x.items.some(i => i.dispatchNo === asId(target)));
        if (!r) throwNotFound('派车请求不存在', target);
        return r;
      });
      const receipts = [];
      for (const item of request.items) {
        const remote = await fetchDispatch({ baseUrl: carrierUrl, dispatchNo: item.dispatchNo, fetchImpl });
        if (remote.ok && remote.body) receipts.push({ dispatchNo: item.dispatchNo, ...remote.body });
      }
      return tx(st => {
        let last;
        for (const receipt of receipts) last = applyReceipt(st, receipt.id ?? target, { status: receipt.status, details: receipt.details, ...pollBody });
        return last ?? { ok: false, message: '承运台暂无可读取回执' };
      });
    }

    async function checkpointFromBody(checkAction) {
      const arrangementId = asId(body.arrangementId ?? body.arrangement ?? body.assignmentId ?? body.arrangement_id ?? body.id);
      if (!arrangementId) throw badRequest('必须提供 arrangementId');
      return tx(st => recordCheckpoint(st, arrangementId, checkAction, body));
    }

    async function updateShelterRoute(shelterIdValue, updateBody) {
      return tx(st => {
        if (updateBody.capacity !== undefined) st.shelters.find(x => x.id === shelterIdValue).capacity = Number(updateBody.capacity);
        if (updateBody.accessibleBeds !== undefined) st.shelters.find(x => x.id === shelterIdValue).accessibleBeds = Number(updateBody.accessibleBeds);
        if (Array.isArray(updateBody.facilities)) st.shelters.find(x => x.id === shelterIdValue).facilities = updateBody.facilities;
        if (updateBody.lastArrival !== undefined) st.shelters.find(x => x.id === shelterIdValue).lastArrival = updateBody.lastArrival ? isoTime(updateBody.lastArrival) : null;
        if (updateBody.accepting !== undefined || updateBody.stopped !== undefined || updateBody.open !== undefined) {
          return updateShelterReceiving(st, shelterIdValue, updateBody);
        }
        return withSelf(shelterView(st, shelterIdValue), 'shelter');
      });
    }

    async function applySourceChange(changeId, applyBody) {
      return tx(st => {
        const change = st.sourceChanges.find(c => c.id === changeId) ?? throwNotFound('来源变更不存在', changeId);
        const decision = applyBody.decision ?? applyBody.action ?? 'apply';
        if (decision === 'reject' || decision === 'ignore') return { ok: true, applied: false, change, decision };
        if (change.road || change.roadId) {
          const restriction = publishRestriction(st, change.road ?? change.roadId, { ...change, ...applyBody, id: applyBody.id ?? change.id });
          return { ok: true, applied: true, restriction };
        }
        if (change.shelter) {
          const result = updateShelterReceiving(st, change.shelter, { accepting: change.accepting ?? false, reason: change.reason, ...applyBody });
          return { ok: true, applied: true, ...result };
        }
        if (change.leg) {
          const records = confirmLegFulfillment(st, { ...change, ...applyBody, sourceChangeId: change.id, actorId: applyBody.actorId ?? 'operator-a' });
          return { ok: true, applied: true, records };
        }
        if (change.passenger || change.passengers) {
          if (change.wish === 'cancel-unfulfilled' || applyBody.createRefund) {
            const pid = change.passenger ?? change.passengers?.[0];
            const refund = createRefund(st, pid, { allUnfulfilled: true, ...applyBody });
            return { ok: true, applied: true, ...refund };
          }
          if (change.splitConsent !== undefined || change.party) {
            return { ok: true, applied: false, effect: 'split-consent-claim-recorded', change, message: 'false 不构成拆分同意；如需拆分必须提交有权同意' };
          }
        }
        return { ok: true, applied: false, message: '该来源事项需要人工选择处理动作', change };
      });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      const status = error instanceof BusinessError ? error.status : 500;
      const payload = {
        ok: false,
        success: false,
        code: error.code ?? 'INTERNAL_ERROR',
        error: error.code ?? 'INTERNAL_ERROR',
        errorCode: error.code ?? 'INTERNAL_ERROR',
        message: status === 500 ? '调度服务内部错误' : error.message,
        details: error.details ?? {},
      };
      if (status === 500) console.error(JSON.stringify({ level: 'error', message: error.message, stack: error.stack }));
      if (!res.writableEnded) send(res, status, payload);
    });
  });
  server.dispatchState = { state, stateFile, tx };
  return server;
}

export const createServer = createDispatchServer;
export const createApp = createDispatchServer;

function throwNotFound(message, id) { throw notFound(message, { id }); }

function operatorFromActor(state, actorId) {
  if (!actorId) return null;
  const actor = state.actors?.find(a => a.id === actorId);
  return actor?.role === 'operator' ? (actor.operator ?? null) : null;
}

function withSelf(resource, key) {
  return { ...resource, [key]: resource };
}

function listArrangements(state, query, proposalOnly) {
  let rows = state.arrangements.filter(a => a.kind === (proposalOnly ? 'proposal' : 'arrangement'));
  if (query.passengerId) rows = rows.filter(a => a.passengerIds.includes(query.passengerId));
  if (query.vehicleId) rows = rows.filter(a => a.vehicleId === query.vehicleId);
  if (query.shelterId) rows = rows.filter(a => a.shelterId === query.shelterId);
  if (query.status) rows = rows.filter(a => a.status === query.status);
  return proposalOnly ? { plans: rows, data: rows } : { arrangements: rows, assignments: rows, data: rows };
}

function roadView(state, roadId, query = {}) {
  const road = roadById(state, roadId);
  const restrictions = state.restrictions.filter(r => r.road === roadId);
  const restrictionInputs = (state.restrictionInputs ?? []).filter(r => r.road === roadId);
  const at = query.at ?? new Date().toISOString();
  const vehicleType = query.vehicleType ?? 'coach';
  const check = evaluateRoute(state, { roadIds: [roadId], at, vehicleType, ignoreConnectivity: true });
  return { ...road, restrictions, restrictionInputs, executable: check.ok, blockers: check.blockers, direction: `${road.from}→${road.to}` };
}

function lookupPassenger(state, body) {
  const ticketId = asId(body.ticketId ?? body.ticket);
  const identityRef = body.identityRef ?? body.identityId ?? body.identity;
  let passenger = state.passengers.find(p => (!ticketId || p.ticket === ticketId) && (!identityRef || p.identityRef === identityRef));
  if (!passenger && ticketId && !identityRef) passenger = state.passengers.find(p => p.ticket === ticketId);
  if (!passenger) throw notFound('未找到原票与身份关联的旅客（仅使用合成资料）');
  return withSelf(passengerView(state, passenger.id), 'passenger');
}

function verifyIdentityRoute(state, passengerId, body) {
  const passenger = state.passengers.find(p => p.id === asId(passengerId)) ?? throwNotFound('旅客不存在', passengerId);
  const ticketId = asId(body.ticketId ?? body.ticket);
  if (ticketId && passenger.ticket !== ticketId) throw conflict('IDENTITY_TICKET_MISMATCH', '原票关联不符');
  if (body.identityRef && passenger.identityRef && passenger.identityRef !== body.identityRef) throw conflict('IDENTITY_MISMATCH', '身份关联不符');
  if (body.identityRef && !passenger.identityRef) passenger.identityRef = body.identityRef;
  return { passengerId: passenger.id, ticketId: passenger.ticket, identityLinked: !!passenger.identityRef };
}

function addConsent(state, passengerIdValue, body) {
  const passengerId = asId(passengerIdValue ?? body.passengerId ?? body.passenger);
  const passenger = state.passengers.find(p => p.id === passengerId) ?? throwNotFound('旅客不存在', passengerId);
  if (body.authorized === false || body.consent === false || body.splitConsent === false) {
    throw conflict('SPLIT_CONSENT_DENIED', '未获得旅客或有权监护人同意，不能拆分同行');
  }
  const consent = {
    id: nextId(state, 'CONSENT'),
    passengerId: passenger.id,
    partyId: passenger.party ?? body.partyId ?? null,
    guardianId: body.guardianId ?? null,
    grantedBy: body.grantedBy ?? body.actorId ?? null,
    scope: body.scope ?? 'split',
    authorized: true,
    at: isoTime(body.at),
    note: body.note ?? null,
  };
  state.consents.push(consent);
  addEvent(state, { type: 'consent.granted', consentId: consent.id, passengerId });
  return consent;
}

function upsertPassengerRoute(state, body) {
  // 延迟导入避免顶部过多内部函数；该函数只在 HTTP 建册时使用。
  const { upsertPassengerFromRoster } = requireOps();
  const passenger = upsertPassengerFromRoster(state, body);
  return withSelf(passengerView(state, passenger.id), 'passenger');
}

import * as Ops from './dispatch-ops.mjs';
function requireOps() { return Ops; }

function createResource(state, collection, body) {
  const id = asId(body.id) ?? nextId(state, collection === 'shelters' ? 'SHELTER' : 'BUS', collection);
  if (state[collection].some(x => x.id === id)) throw conflict('ID_EXISTS', '编号已存在', { id });
  const resource = { ...body, id };
  state[collection].push(resource);
  return resource;
}

function updateVehicle(state, vehicleId, body) {
  const vehicle = state.vehicles.find(v => v.id === vehicleId) ?? throwNotFound('车辆不存在', vehicleId);
  for (const key of ['seats', 'wheelchairSlots', 'operator', 'vehicleType', 'features', 'capabilities', 'specialPickup']) {
    if (body[key] !== undefined) vehicle[key] = body[key];
  }
  return withSelf(vehicleView(state, vehicleId), 'vehicle');
}

function overview(state) {
  expireReservations(state);
  return {
    counts: {
      passengers: state.passengers.length,
      affectedServices: state.affectedServices.length,
      arrangements: state.arrangements.length,
      openContingencies: state.contingencies.filter(c => c.status !== 'resolved').length,
      refunds: state.refundRequests.length,
      restrictions: state.restrictions.filter(r => r.status === 'published').length,
    },
    openContingencies: state.contingencies.filter(c => c.status !== 'resolved'),
    unknownDispatches: state.dispatchRequests.filter(r => ['unknown', 'awaiting_receipt'].includes(r.receiptStatus)),
  };
}

function apiIndex() {
  return {
    ok: true,
    service: '冰雪封路旅客接续与安置移交 API',
    note: '全部人员资料均为合成数据；推荐线路不等于派车、发车、报到、上车或移交事实。',
    endpoints: [
      'POST /api/services 接收受影响班次与旅客清单',
      'POST /api/passengers/:id/confirm 确认原车/去向/位置',
      'POST /api/plans 形成可核验推荐方案（不占容量）',
      'POST /api/arrangements 原子锁定同行、车辆/轮椅位、安置点/无障碍床位和期限',
      'POST /api/arrangements/:id/dispatch 派车；外部承运回执未明时保持旅客锁定',
      'POST /api/dispatch-requests/:id/receipt 登记/轮询承运回执，旧回执不能覆盖新安排',
      'POST /api/arrangements/:id/check-in|board|depart|arrive|handover|no-show',
      'POST /api/roads/:id/restrictions 或 /api/restrictions 发布定向、分车型、有效期限行',
      'POST /api/restrictions/:id/lift 只解除指定限行',
      'POST /api/shelters/:id/acceptance 更新接收状态并生成在途接续处置',
      'PATCH /api/contingencies/:id 明确当前位置、临时责任人、新确认地点',
      'GET /api/passengers/:id 查询去向、责任人、票段履行和退款进度',
      'GET /api/vehicles/:id 与 /api/shelters/:id 核查承诺/实际到达人数',
      'POST /api/passengers/:id/refunds 申请未履行区段退款',
      'GET /api/operators/:operatorId/refunds 原运营方处理本方票务',
      'GET /api/carriers/:carrierId/vehicles/:vehicleId/manifest 承运人最小乘客范围名册',
    ],
  };
}

export function startDispatchServer(options = {}) {
  const stateFile = options.stateFile ?? process.env.DISPATCH_STATE ?? process.env.RESCUE_STATE ?? process.env.DATA_FILE ?? process.env.STATE_FILE ?? '.local/dispatch.json';
  const port = Number(options.port ?? process.env.DISPATCH_PORT ?? process.env.RESCUE_PORT ?? process.env.PORT ?? 4318);
  const server = options.server ?? createDispatchServer({ ...options, stateFile });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, options.host ?? '0.0.0.0', () => {
      console.log(JSON.stringify({ message: '旅客接续处置服务已启动', port: server.address().port, stateFile }));
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDispatchServer().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
