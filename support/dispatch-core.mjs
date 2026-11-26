import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'records.json');

export class BusinessError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'BusinessError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new BusinessError(400, 'BAD_REQUEST', message, details);
export const notFound = (message, details) => new BusinessError(404, 'NOT_FOUND', message, details);
export const conflict = (code, message, details) => new BusinessError(409, code, message, details);
export const forbidden = (message, details) => new BusinessError(403, 'FORBIDDEN', message, details);

export function readFixture() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

export function freshState(now = new Date().toISOString()) {
  const data = readFixture();
  return {
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    seq: {},
    actors: data.actors ?? [],
    passengers: structuredClone(data.passengers ?? []),
    tickets: structuredClone(data.tickets ?? []),
    roads: structuredClone(data.roads ?? []),
    vehicles: (data.vehicles ?? []).map(v => ({ vehicleType: 'coach', features: [], capabilities: {}, ...structuredClone(v) })),
    shelters: (data.shelters ?? []).map(s => ({ facilities: [], ...structuredClone(s) })),
    sourceChanges: structuredClone(data.sourceChanges ?? []),
    restrictionInputs: structuredClone(data.restrictionInputs ?? []),
    // restrictionInputs 按 docs/data.md 约定只是演练/预警输入，不能自动当成已发布限行。
    restrictions: [],
    affectedServices: [],
    passengerStates: {},
    arrangements: [],
    reservations: [],
    dispatchRequests: [],
    receipts: [],
    handovers: [],
    events: [],
    legConfirmations: [],
    refundRequests: [],
    consents: [],
    contingencies: [],
    roadStatusUpdates: [],
    shelterStatusUpdates: [],
    idempotencyRecords: [],
    audit: [],
  };
}

export function loadState(file) {
  if (!file || file === ':memory:') return freshState();
  try {
    if (!existsSync(file)) return freshState();
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const base = freshState(parsed.createdAt);
    const state = { ...base, ...parsed };
    // 兼容手工/旧版本状态：集合必须存在。
    for (const key of Object.keys(base)) {
      if (state[key] === undefined) state[key] = base[key];
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return freshState();
    throw error;
  }
}

export function saveState(file, state) {
  if (!file || file === ':memory:') return;
  mkdirSync(dirname(file), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

export function nextId(state, prefix, sequenceKey = prefix) {
  state.seq[sequenceKey] = (state.seq[sequenceKey] ?? 0) + 1;
  return `${prefix}-${String(state.seq[sequenceKey]).padStart(4, '0')}`;
}

export function isoTime(value, fallback = new Date().toISOString()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw badRequest(`时间格式不符：${value}`);
  return new Date(ms).toISOString();
}

export function asId(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return value.id ?? value.passengerId ?? value.roadId ?? value.vehicleId ?? value.shelterId;
}

export function idList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map(asId).filter(Boolean))];
}

export function pickFirst(body, keys) {
  for (const key of keys) {
    if (body?.[key] !== undefined) return body[key];
  }
  return undefined;
}

export function findOrThrow(rows, id, label) {
  const row = rows.find(item => item.id === id);
  if (!row) throw notFound(`${label}不存在：${id}`, { id });
  return row;
}

export function passengerById(state, id) {
  return findOrThrow(state.passengers, asId(id), '旅客');
}

export function ticketForPassenger(state, passenger) {
  return findOrThrow(state.tickets, passenger.ticket, '原票');
}

export function vehicleById(state, id) {
  return findOrThrow(state.vehicles, asId(id), '车辆');
}

export function shelterById(state, id) {
  return findOrThrow(state.shelters, asId(id), '安置点');
}

export function roadById(state, id) {
  return findOrThrow(state.roads, asId(id), '路段');
}

export function addEvent(state, event) {
  const record = {
    id: nextId(state, 'EVT', 'event'),
    at: new Date().toISOString(),
    ...event,
  };
  state.events.push(record);
  state.audit.push({ ...record });
  return record;
}

export function rememberIdempotency(state, key, fingerprint, status, body) {
  if (!key) return;
  state.idempotencyRecords.push({ key, fingerprint, status, body, at: new Date().toISOString() });
}

export function findIdempotent(state, key, fingerprint) {
  if (!key) return null;
  const record = state.idempotencyRecords.find(item => item.key === key);
  if (!record) return null;
  if (record.fingerprint !== fingerprint) {
    throw conflict('IDEMPOTENCY_CONFLICT', '同一幂等键对应不同请求内容', { key });
  }
  return record;
}

export function verifyIdentity(state, passenger, body = {}) {
  const ticketId = asId(pickFirst(body, ['ticketId', 'ticket', 'ticketNo']));
  if (ticketId && passenger.ticket !== ticketId) {
    throw forbidden('原票与旅客关联不符', { passengerId: passenger.id, ticketId });
  }
  const identityRef = pickFirst(body, ['identityRef', 'identityId', 'identity', 'idRef', 'credentialRef']);
  if (identityRef) {
    if (passenger.identityRef && passenger.identityRef !== identityRef) {
      throw forbidden('身份关联不符', { passengerId: passenger.id });
    }
    if (!passenger.identityRef) passenger.identityRef = String(identityRef);
  }
  return { ticketId: passenger.ticket, identityRef: passenger.identityRef ?? null, verified: true };
}

export function listPartyPassengerIds(state, passenger) {
  if (!passenger.party) return [passenger.id];
  return state.passengers.filter(p => p.party === passenger.party).map(p => p.id);
}

export function hasSplitConsent(state, passengerIds, body = {}) {
  const requested = new Set(passengerIds);
  const parties = new Set(state.passengers.filter(p => requested.has(p.id) && p.party).map(p => p.party));
  // 同批已包含同一同行组全部成员时，不需要拆分同意。
  for (const partyId of parties) {
    const all = state.passengers.filter(p => p.party === partyId).map(p => p.id);
    if (all.every(id => requested.has(id))) continue;
    const explicit = body.splitConsent === true || body.consent === true || body.guardianConsent === true;
    const grantedBy = body.consentBy ?? body.guardianId ?? body.actorId ?? null;
    const recorded = state.consents.some(c =>
      c.status !== 'revoked' &&
      (c.partyId === partyId || requested.has(c.passengerId)) &&
      (c.scope === 'split' || c.scope === 'companion-split') &&
      c.authorized !== false,
    );
    if (!explicit && !recorded) {
      const err = conflict('SPLIT_CONSENT_REQUIRED', '同行旅客不能在没有旅客或有权监护人同意时拆开', {
        partyId,
        requiredCompanionIds: all.filter(id => !requested.has(id)),
      });
      err.details.partyId = partyId;
      throw err;
    }
    if (explicit) {
      state.consents.push({
        id: nextId(state, 'CONSENT'),
        type: 'split',
        scope: 'split',
        partyId,
        passengerId: body.consentPassengerId ?? passengerIds[0],
        grantedBy,
        guardianId: body.guardianId ?? null,
        authorized: true,
        at: isoTime(body.at ?? body.consentedAt),
        source: body.source ?? 'http',
      });
    }
  }
  return true;
}

const VEHICLE_CAPABILITY_ALIASES = {
  wheelchairLift: ['wheelchair-lift', 'wheelchair_lift', 'lift', '升降装置', '轮椅升降'],
  childSeat: ['child-seat', 'child_seat', '儿童座椅'],
  guideDog: ['guide-dog', 'guide_dog', '导盲犬'],
  visualAssistance: ['visual-assistance', 'visual_assistance', '视觉协助'],
  hearingAssistance: ['hearing-assistance', 'hearing_assistance', '听觉协助'],
  specialPickup: ['special-pickup', 'special_pickup', '专门接送', '特殊接送'],
};

export function passengerTransportNeeds(passenger) {
  const needs = new Set((passenger.needs ?? []).map(String));
  if (passenger.mobility === 'wheelchair' || passenger.accessibility === 'wheelchair') needs.add('wheelchair');
  if (passenger.specialPickup === true) needs.add('special-pickup');
  for (const need of passenger.pickupRequirements ?? []) needs.add(String(need));
  return [...needs];
}

export function allocationKindFor(passenger) {
  const needs = passengerTransportNeeds(passenger);
  return needs.includes('wheelchair') ? 'wheelchair' : 'ordinary';
}

export function assertVehicleFeatures(vehicle, passengers) {
  const features = new Set([
    ...(vehicle.features ?? []),
    ...Object.entries(vehicle.capabilities ?? {}).filter(([, v]) => v === true).map(([k]) => k),
  ].map(x => String(x).toLowerCase().replace(/[\s_]+/g, '-')));
  const missing = [];
  for (const passenger of passengers) {
    for (const need of passengerTransportNeeds(passenger)) {
      if (need === 'wheelchair' || need === 'guardian-companion') continue;
      const normalized = need.toLowerCase().replace(/[\s_]+/g, '-');
      const aliases = [normalized];
      for (const [capability, names] of Object.entries(VEHICLE_CAPABILITY_ALIASES)) {
        const normalizedCapability = capability.toLowerCase().replace(/[\s_]+/g, '-');
        if (names.map(n => n.toLowerCase().replace(/[\s_]+/g, '-')).includes(normalized) || normalizedCapability === normalized) {
          aliases.push(normalizedCapability);
        }
      }
      if (!aliases.some(a => features.has(a))) missing.push({ passengerId: passenger.id, need });
    }
  }
  if (missing.length) {
    throw conflict('VEHICLE_SPECIAL_PICKUP_NOT_MATCHED', '普通座位有空也不能接：车辆缺少所需专门接送条件', { missing });
  }
}

export function assertShelterFacilities(shelter, passengers) {
  const facilities = new Set((shelter.facilities ?? []).map(x => String(x).toLowerCase().replace(/[\s_]+/g, '-')));
  const vehicleOnlyNeeds = new Set(['lift', 'wheelchair-lift', 'wheelchair_lift', 'child-seat', 'child_seat', 'special-pickup', 'door-to-door']);
  const missing = [];
  for (const passenger of passengers) {
    const explicitRequirements = passenger.shelterRequirements ?? passenger.facilityRequirements ?? [];
    const inferredRequirements = passengerTransportNeeds(passenger).filter(need => {
      const normalized = String(need).toLowerCase().replace(/[\s_]+/g, '-');
      return need !== 'wheelchair' && need !== 'guardian-companion' && !vehicleOnlyNeeds.has(normalized);
    });
    for (const need of [...explicitRequirements, ...inferredRequirements]) {
      const normalized = String(need).toLowerCase().replace(/[\s_]+/g, '-');
      if (!facilities.has(normalized)) missing.push({ passengerId: passenger.id, need });
    }
  }
  if (missing.length) throw conflict('SHELTER_FACILITY_NOT_MATCHED', '安置点缺少特殊需求设施', { missing });
}

export function expireReservations(state, at = new Date().toISOString()) {
  let changed = false;
  for (const reservation of state.reservations) {
    if (reservation.status === 'held' && reservation.expiresAt && Date.parse(reservation.expiresAt) <= Date.parse(at)) {
      reservation.status = 'expired';
      reservation.expiredAt = at;
      changed = true;
      addEvent(state, { type: 'reservation.expired', reservationId: reservation.id, arrangementId: reservation.arrangementId });
    }
  }
  for (const arrangement of state.arrangements) {
    if (arrangement.status === 'reserved' && arrangement.expiresAt && Date.parse(arrangement.expiresAt) <= Date.parse(at)) {
      arrangement.status = 'expired';
      arrangement.expiredAt = at;
      changed = true;
    }
  }
  return changed;
}

const VEHICLE_ACTIVE_STATUSES = new Set(['held', 'boarded']);
const VEHICLE_COMMITTED_STATUSES = new Set(['held', 'boarded', 'completed']);
const SHELTER_COMMITTED_STATUSES = new Set(['held', 'occupied']);

export function reservationCounts(state, resourceType, resourceId) {
  const rows = state.reservations.filter(r => r.resourceType === resourceType && r.resourceId === resourceId);
  const count = (statuses, kind) => rows
    .filter(r => statuses.has(r.status) && (!kind || r.kind === kind))
    .reduce((sum, r) => sum + (r.quantity ?? 1), 0);
  return {
    rows,
    committed: count(resourceType === 'vehicle' ? VEHICLE_COMMITTED_STATUSES : SHELTER_COMMITTED_STATUSES),
    active: count(resourceType === 'vehicle' ? VEHICLE_ACTIVE_STATUSES : SHELTER_COMMITTED_STATUSES),
    boarded: count(new Set(['boarded'])),
    arrived: resourceType === 'vehicle' ? count(new Set(['completed'])) : count(new Set(['occupied'])),
    ordinaryCommitted: count(resourceType === 'vehicle' ? VEHICLE_COMMITTED_STATUSES : SHELTER_COMMITTED_STATUSES, 'ordinary'),
    wheelchairCommitted: count(resourceType === 'vehicle' ? VEHICLE_COMMITTED_STATUSES : SHELTER_COMMITTED_STATUSES, 'wheelchair'),
    accessibleCommitted: count(SHELTER_COMMITTED_STATUSES, 'accessible'),
  };
}

export function assertVehicleCapacity(state, vehicle, allocations) {
  const counts = reservationCounts(state, 'vehicle', vehicle.id);
  const addOrdinary = allocations.filter(a => a.kind === 'ordinary').length;
  const addWheelchair = allocations.filter(a => a.kind === 'wheelchair').length;
  if (counts.active + allocations.length > (vehicle.seats ?? 0) + (vehicle.wheelchairSlots ?? 0)) {
    // 兜底总容量；通常下面两类分别给出更准确错误。
  }
  const ordinaryActive = counts.rows.filter(r => VEHICLE_ACTIVE_STATUSES.has(r.status) && r.kind === 'ordinary').length;
  const wheelchairActive = counts.rows.filter(r => VEHICLE_ACTIVE_STATUSES.has(r.status) && r.kind === 'wheelchair').length;
  if (ordinaryActive + addOrdinary > (vehicle.seats ?? 0)) {
    throw conflict('VEHICLE_SEATS_EXCEEDED', '车辆普通座位不足，不能超占', {
      vehicleId: vehicle.id, seats: vehicle.seats, ordinaryActive, addOrdinary,
    });
  }
  if (wheelchairActive + addWheelchair > (vehicle.wheelchairSlots ?? 0)) {
    throw conflict('VEHICLE_WHEELCHAIR_SLOTS_EXCEEDED', '车辆轮椅位不足；普通座位有空不代表能接', {
      vehicleId: vehicle.id, wheelchairSlots: vehicle.wheelchairSlots, wheelchairActive, addWheelchair,
    });
  }
}

export function assertShelterCapacity(state, shelter, allocations) {
  const counts = reservationCounts(state, 'shelter', shelter.id);
  const addTotal = allocations.length;
  const addAccessible = allocations.filter(a => a.kind === 'accessible' || a.kind === 'wheelchair').length;
  if (counts.committed + addTotal > (shelter.capacity ?? 0)) {
    throw conflict('SHELTER_CAPACITY_EXCEEDED', '安置点接收人数已满，不能超占', {
      shelterId: shelter.id, capacity: shelter.capacity, committed: counts.committed, addTotal,
    });
  }
  if (counts.accessibleCommitted + addAccessible > (shelter.accessibleBeds ?? 0)) {
    throw conflict('SHELTER_ACCESSIBLE_BEDS_EXCEEDED', '安置点无障碍床位不足', {
      shelterId: shelter.id, accessibleBeds: shelter.accessibleBeds, accessibleCommitted: counts.accessibleCommitted, addAccessible,
    });
  }
}

export function restrictionApplies(restriction, vehicleType) {
  const types = restriction.vehicleTypes ?? restriction.vehicleType;
  if (!types || (Array.isArray(types) && types.length === 0)) return true;
  const list = Array.isArray(types) ? types : [types];
  return list.includes(vehicleType) || list.includes('all') || list.includes('全部车型');
}

export function evaluateRoute(state, input = {}) {
  const vehicleType = input.vehicleType ?? input.vehicle?.vehicleType ?? 'coach';
  let roadIds = idList(input.roadIds ?? input.routeIds ?? input.roads ?? input.route ?? input.roadId);
  const from = asId(pickFirst(input, ['fromLocationId', 'from', 'currentLocationId', 'startLocationId']));
  const to = asId(pickFirst(input, ['toLocationId', 'to', 'destinationId', 'targetLocationId']));
  const at = isoTime(input.at ?? input.departureAt ?? input.time, new Date().toISOString());

  if (!roadIds.length && from && to) {
    const direct = state.roads.find(r => r.from === from && r.to === to);
    if (direct) roadIds = [direct.id];
    else roadIds = findGraphRoute(state.roads, from, to);
  }
  if (!roadIds.length) {
    return { ok: false, code: 'ROUTE_NOT_FOUND', blockers: [{ message: '未提供可核验的定向路段' }], roadIds: [] };
  }

  const segments = [];
  const blockers = [];
  let cursor = Date.parse(input.departureAt ?? at);
  let previousTo = from;
  for (const roadId of roadIds) {
    const road = roadById(state, roadId);
    if (previousTo && road.from !== previousTo && !input.ignoreConnectivity) {
      blockers.push({ roadId, code: 'ROUTE_DIRECTION_OR_CONNECTION_INVALID', message: `路段 ${roadId} 不能按当前方向/衔接接在 ${previousTo} 后`, road });
    }
    if (from && roadIds[0] === roadId && road.from !== from && !input.ignoreConnectivity) {
      blockers.push({ roadId, code: 'ROUTE_DIRECTION_INVALID', message: `路段 ${roadId} 方向为 ${road.from}→${road.to}，不能从 ${from} 逆行`, road });
    }
    const start = new Date(cursor).toISOString();
    const endMs = cursor + (road.minutes ?? 0) * 60000;
    const end = new Date(endMs).toISOString();
    for (const restriction of state.restrictions) {
      if (restriction.road !== road.id || restriction.status !== 'published') continue;
      if (!restrictionApplies(restriction, vehicleType)) continue;
      const rStart = restriction.start ? Date.parse(restriction.start) : -8640000000000000;
      const rEnd = restriction.end ? Date.parse(restriction.end) : 8640000000000000;
      if (rStart < endMs && rEnd > cursor) {
        blockers.push({
          roadId: road.id,
          restrictionId: restriction.id,
          code: 'ROAD_RESTRICTION_ACTIVE',
          message: `路段 ${road.id}（${road.from}→${road.to}）在通行时段内对 ${vehicleType} 限行`,
          start, end, restriction,
        });
      }
    }
    if (state.roadClosures?.[road.id]?.closed) {
      blockers.push({ roadId: road.id, code: 'ROAD_CLOSED', message: `路段 ${road.id} 已封闭` });
    }
    segments.push({ roadId: road.id, from: road.from, to: road.to, start, end, minutes: road.minutes ?? 0 });
    cursor = endMs;
    previousTo = road.to;
  }
  if (to && previousTo !== to && !input.ignoreConnectivity) {
    blockers.push({ code: 'ROUTE_END_MISMATCH', message: `路线终点 ${previousTo} 与确认地点 ${to} 不符` });
  }
  return {
    ok: blockers.length === 0,
    code: blockers.length ? blockers[0].code : 'ROUTE_EXECUTABLE',
    blockers,
    roadIds,
    segments,
    from: segments[0]?.from ?? from ?? null,
    to: segments.at(-1)?.to ?? to ?? null,
    departureAt: new Date(Date.parse(input.departureAt ?? at)).toISOString(),
    arrivalAt: new Date(cursor).toISOString(),
    totalMinutes: segments.reduce((sum, s) => sum + s.minutes, 0),
  };
}

export function findGraphRoute(roads, from, to) {
  const queue = [{ at: from, ids: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const node = queue.shift();
    for (const road of roads.filter(r => r.from === node.at)) {
      if (seen.has(road.to)) continue;
      const ids = [...node.ids, road.id];
      if (road.to === to) return ids;
      seen.add(road.to);
      queue.push({ at: road.to, ids });
    }
  }
  return [];
}

export function activeAllocationForPassenger(state, passengerId) {
  for (const arrangement of state.arrangements) {
    const item = arrangement.passengers?.find(p => p.passengerId === passengerId);
    if (!item) continue;
    if (['reserved', 'reported', 'boarded', 'arrived'].includes(item.status)) {
      return { arrangement, item };
    }
  }
  return null;
}

export function assertNoActiveArrangement(state, passengerIds, options = {}) {
  for (const id of passengerIds) {
    const active = activeAllocationForPassenger(state, id);
    if (active && active.arrangement.id !== options.excludeArrangementId) {
      throw conflict('PASSENGER_ALREADY_LOCKED_TO_ARRANGEMENT', '旅客已有未结束接续或派车未明，不能重复安排/重复占座', {
        passengerId: id,
        arrangementId: active.arrangement.id,
        status: active.item.status,
        dispatchState: active.arrangement.dispatchRequest?.receiptStatus ?? active.arrangement.dispatchState ?? null,
      });
    }
  }
}

export function normalizeArrangementInput(state, body) {
  let passengerIds = idList(pickFirst(body, ['passengerIds', 'passengers', 'passengerId', 'passenger', 'ids']));
  if (!passengerIds.length && body.serviceId) {
    const service = findOrThrow(state.affectedServices, asId(body.serviceId), '受影响班次');
    passengerIds = [...service.passengerIds];
  }
  if (!passengerIds.length && body.partyId) {
    passengerIds = state.passengers.filter(p => p.party === body.partyId).map(p => p.id);
  }
  if (!passengerIds.length) throw badRequest('必须提供旅客、同行组或受影响班次清单');
  const passengers = passengerIds.map(id => passengerById(state, id));
  const vehicleId = asId(pickFirst(body, ['vehicleId', 'vehicle', 'busId']));
  const shelterId = asId(pickFirst(body, ['shelterId', 'shelter', 'shelterPointId']));
  const vehicle = vehicleId ? vehicleById(state, vehicleId) : null;
  let shelter = shelterId ? shelterById(state, shelterId) : null;
  const routeInput = { ...body, vehicleType: body.vehicleType ?? vehicle?.vehicleType ?? 'coach' };
  let route = evaluateRoute(state, routeInput);
  if (!shelter && route.to && state.shelters.some(s => s.id === route.to)) {
    shelter = state.shelters.find(s => s.id === route.to);
  }
  if (shelter && !route.to) route = evaluateRoute(state, { ...routeInput, to: shelter.id });
  return { passengerIds, passengers, vehicle, shelter, route };
}

export function createArrangement(state, body = {}, options = {}) {
  expireReservations(state, isoTime(body.now));
  const proposalOnly = options.proposalOnly ?? body.proposalOnly ?? body.plan === true;
  const normalized = normalizeArrangementInput(state, body);
  const { passengerIds, passengers, vehicle, shelter } = normalized;
  let route = normalized.route;

  verifyIdentityMaybe(state, passengers, body);
  hasSplitConsent(state, passengerIds, body);
  if (!proposalOnly) assertNoActiveArrangement(state, passengerIds, { excludeArrangementId: body.expectedArrangementId });

  const allocations = passengers.map(p => ({
    passengerId: p.id,
    kind: allocationKindFor(p),
    needs: passengerTransportNeeds(p),
    status: 'reserved',
  }));

  const blockers = [...route.blockers];
  if (vehicle) assertVehicleFeatures(vehicle, passengers);
  if (shelter) assertShelterFacilities(shelter, passengers);
  if (!proposalOnly) {
    if (route.blockers.length) throw conflict('ROUTE_NOT_EXECUTABLE', '当前线路不可执行，不能形成可承诺接续', { blockers: route.blockers });
    if (vehicle) assertVehicleCapacity(state, vehicle, allocations);
    if (shelter) {
      assertShelterCapacity(state, shelter, allocations.map(a => ({ ...a, kind: a.kind === 'wheelchair' ? 'accessible' : 'ordinary' })));
      const arrivalAt = isoTime(body.arrivalAt ?? route.arrivalAt ?? body.at);
      if (shelter.lastArrival && Date.parse(arrivalAt) > Date.parse(shelter.lastArrival)) {
        throw conflict('SHELTER_LAST_ARRIVAL_EXCEEDED', '预计到达晚于安置点最晚接收时间', { arrivalAt, lastArrival: shelter.lastArrival });
      }
      if (shelter.accepting === false && !body.allowExistingStop) {
        throw conflict('SHELTER_NOT_ACCEPTING', '安置点当前停收，不能作出新的安置承诺', { shelterId: shelter.id });
      }
    }
  }

  const requestKey = body.requestKey ?? body.idempotencyKey ?? body.key ?? body.requestId ?? body.request_id ?? null;
  if (requestKey) {
    const fingerprint = JSON.stringify({ passengerIds, vehicleId: vehicle?.id, shelterId: shelter?.id, roadIds: route.roadIds });
    const existing = state.idempotencyRecords.find(r => r.key === `arrangement:${requestKey}`);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw conflict('IDEMPOTENCY_CONFLICT', '同一请求键对应不同安排');
      return state.arrangements.find(a => a.id === existing.body.id);
    }
  }

  const id = asId(body.id) ?? nextId(state, proposalOnly ? 'PLAN' : 'ARR', 'arrangement');
  if (state.arrangements.some(a => a.id === id)) {
    if (body.requestKey || body.idempotent) return state.arrangements.find(a => a.id === id);
    throw conflict('ARRANGEMENT_ID_EXISTS', '安排编号已存在', { id });
  }
  const createdAt = isoTime(body.at ?? body.createdAt);
  const ttlMinutes = Number(body.ttlMinutes ?? body.holdMinutes ?? state.reservationTtlMinutes ?? 15);
  const expiresAt = body.expiresAt ? isoTime(body.expiresAt) : new Date(Date.parse(createdAt) + ttlMinutes * 60000).toISOString();
  const arrangement = {
    id,
    kind: proposalOnly ? 'proposal' : 'arrangement',
    status: proposalOnly ? 'proposed' : 'reserved',
    feasible: route.ok,
    blockers,
    serviceId: asId(body.serviceId) ?? null,
    passengerIds,
    passengers: allocations,
    vehicleId: vehicle?.id ?? null,
    carrierId: vehicle?.operator ?? body.carrierId ?? null,
    shelterId: shelter?.id ?? null,
    roadIds: route.roadIds,
    route,
    fromLocationId: route.from ?? asId(body.fromLocationId) ?? null,
    toLocationId: route.to ?? shelter?.id ?? asId(body.toLocationId) ?? null,
    departureAt: body.departureAt ? isoTime(body.departureAt) : null,
    arrivalAt: body.arrivalAt ? isoTime(body.arrivalAt) : route.arrivalAt ?? null,
    expiresAt: proposalOnly ? null : expiresAt,
    requestKey,
    dispatchKey: body.dispatchKey ?? `DISPATCH-KEY-${id}`,
    dispatchState: 'not_sent',
    dispatchRequestId: null,
    responsible: {
      dispatchActorId: body.dispatchActorId ?? body.actorId ?? 'dispatch',
      stationActorId: body.stationActorId ?? null,
      pickupActorId: body.pickupActorId ?? null,
      vehicleActorId: body.vehicleActorId ?? null,
      shelterActorId: body.shelterActorId ?? null,
      temporaryActorId: null,
    },
    createdAt,
    updatedAt: createdAt,
    version: 1,
    events: [],
  };
  state.arrangements.push(arrangement);

  if (!proposalOnly) {
    if (vehicle) {
      for (const allocation of allocations) {
        const reservation = {
          id: nextId(state, 'RSV-V'),
          type: 'vehicle-seat',
          resourceType: 'vehicle',
          resourceId: vehicle.id,
          arrangementId: id,
          passengerId: allocation.passengerId,
          kind: allocation.kind,
          quantity: 1,
          status: 'held',
          expiresAt,
          createdAt,
        };
        state.reservations.push(reservation);
        allocation.vehicleReservationId = reservation.id;
      }
    }
    if (shelter) {
      for (const allocation of allocations) {
        const kind = allocation.kind === 'wheelchair' ? 'accessible' : (allocation.kind === 'accessible' ? 'accessible' : 'ordinary');
        const reservation = {
          id: nextId(state, 'RSV-S'),
          type: 'shelter-place',
          resourceType: 'shelter',
          resourceId: shelter.id,
          arrangementId: id,
          passengerId: allocation.passengerId,
          kind,
          quantity: 1,
          status: 'held',
          expiresAt,
          createdAt,
        };
        state.reservations.push(reservation);
        allocation.shelterReservationId = reservation.id;
      }
    }
    addEvent(state, { type: 'arrangement.reserved', arrangementId: id, passengerIds, vehicleId: vehicle?.id, shelterId: shelter?.id, expiresAt });
  } else {
    addEvent(state, { type: 'plan.proposed', arrangementId: id, feasible: route.ok });
  }
  if (requestKey) rememberIdempotency(state, `arrangement:${requestKey}`, JSON.stringify({ passengerIds, vehicleId: vehicle?.id, shelterId: shelter?.id, roadIds: route.roadIds }), 200, { id });
  return arrangement;
}

function verifyIdentityMaybe(state, passengers, body) {
  // 只有调用方提供票据/身份字段时才强校验；业务查询接口另有显式核验。
  if (body.ticketId || body.identityRef || body.identity) {
    for (const passenger of passengers) verifyIdentity(state, passenger, body);
  }
}

export function getArrangement(state, id) {
  return findOrThrow(state.arrangements, asId(id), '接续安排');
}

export function getAllocation(arrangement, passengerId) {
  const item = arrangement.passengers.find(p => p.passengerId === passengerId);
  if (!item) throw badRequest('旅客不属于该接续安排', { arrangementId: arrangement.id, passengerId });
  return item;
}

export function arrangementPassengerIds(body, arrangement) {
  const ids = idList(pickFirst(body, ['passengerIds', 'passengers', 'passengerId']));
  return ids.length ? ids : arrangement.passengers.map(p => p.passengerId);
}

export function addArrangementEvent(arrangement, type, payload = {}) {
  const event = { at: new Date().toISOString(), type, ...payload };
  arrangement.events.push(event);
  arrangement.updatedAt = event.at;
  arrangement.version += 1;
  return event;
}

export function syncArrangementStatus(arrangement) {
  const statuses = arrangement.passengers.map(p => p.status);
  if (statuses.every(s => s === 'handed_over')) arrangement.status = 'handed_over';
  else if (statuses.some(s => s === 'handed_over') && statuses.every(s => ['handed_over', 'no_show', 'released'].includes(s))) arrangement.status = 'partially_handed_over';
  else if (statuses.every(s => s === 'arrived' || s === 'handed_over')) arrangement.status = 'arrived';
  else if (statuses.some(s => s === 'boarded') && statuses.every(s => ['boarded', 'arrived', 'handed_over'].includes(s))) arrangement.status = 'boarded';
  else if (statuses.some(s => s === 'boarded')) arrangement.status = 'partially_boarded';
  else if (statuses.every(s => s === 'reported' || ['reserved', 'reported'].includes(s))) arrangement.status = 'reported';
  return arrangement.status;
}

export function releaseArrangement(state, id, body = {}) {
  const arrangement = getArrangement(state, id);
  if (['released', 'cancelled', 'expired'].includes(arrangement.status)) return arrangement;
  const authoritativeNoRun = body.originalVehicleWillRun === false ||
    body.vehicleWillRun === false ||
    body.willRun === false ||
    body.confirmNoService === true ||
    body.noLongerRuns === true ||
    body.confirmedVehicleWillNotRun === true;
  if (!authoritativeNoRun && body.force !== true) {
    throw conflict('ORIGINAL_SERVICE_STATUS_UNKNOWN', '派车回执未明期间必须保持锁定；只有确认原车/原派车不再执行后才能释放', {
      arrangementId: arrangement.id,
      dispatchState: arrangement.dispatchState,
    });
  }
  if (arrangement.passengers.some(p => ['boarded', 'arrived'].includes(p.status))) {
    throw conflict('PASSENGER_ALREADY_BOARDED', '旅客已经上车或到达，不能按未派车释放；应走在途接续/移交处置');
  }
  arrangement.status = 'released';
  arrangement.releasedAt = isoTime(body.at);
  arrangement.releaseReason = body.reason ?? body.note ?? '确认原车不再执行';
  arrangement.releasedBy = body.actorId ?? body.confirmedBy ?? 'dispatch';
  for (const p of arrangement.passengers) {
    if (['reserved', 'reported'].includes(p.status)) p.status = 'released';
  }
  for (const r of state.reservations.filter(r => r.arrangementId === arrangement.id && r.status === 'held')) {
    r.status = 'released';
    r.releasedAt = arrangement.releasedAt;
    r.releaseReason = arrangement.releaseReason;
  }
  addArrangementEvent(arrangement, 'arrangement.released', { by: arrangement.releasedBy, reason: arrangement.releaseReason });
  addEvent(state, { type: 'arrangement.released', arrangementId: arrangement.id });
  return arrangement;
}

export function cancelForRefund(state, passengerId, body = {}) {
  const active = activeAllocationForPassenger(state, passengerId);
  if (!active) return null;
  if (['boarded', 'arrived'].includes(active.item.status)) {
    throw conflict('ALREADY_BOARDED', '旅客已经登上接续车，不能通过放弃接续重复占座或释放已履行运输', {
      arrangementId: active.arrangement.id,
      status: active.item.status,
    });
  }
  return releaseArrangement(state, active.arrangement.id, {
    ...body,
    originalVehicleWillRun: true,
    reason: body.reason ?? '旅客放弃接续并申请退款',
  });
}
