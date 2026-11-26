import {
  BusinessError, badRequest, notFound, conflict, forbidden,
  nextId, isoTime, asId, idList, pickFirst, findOrThrow,
  passengerById, ticketForPassenger, roadById, vehicleById, shelterById,
  addEvent, verifyIdentity, listPartyPassengerIds, reservationCounts,
  assertShelterCapacity, activeAllocationForPassenger, getArrangement, getAllocation,
  arrangementPassengerIds, addArrangementEvent, syncArrangementStatus,
  releaseArrangement,
} from './dispatch-core.mjs';

const RECEIPT_STATUS_MAP = {
  accepted: 'accepted', 受理: 'accepted', 已受理: 'accepted',
  pending: 'pending', 处理中: 'pending', 待处理: 'pending',
  confirmed: 'confirmed', 确认: 'confirmed', 已确认: 'confirmed',
  rejected: 'rejected', 拒绝: 'rejected', 已拒绝: 'rejected',
  returned: 'returned', 退回: 'returned', 已退回: 'returned',
  unknown: 'unknown', 未明: 'unknown', 回执未明: 'unknown',
};

export function normalizeReceiptStatus(value) {
  if (!value) return null;
  return RECEIPT_STATUS_MAP[String(value).trim()] ?? String(value).trim();
}

export function upsertPassengerFromRoster(state, entry, serviceId) {
  if (typeof entry === 'string') return passengerById(state, entry);
  const id = asId(entry);
  let passenger = state.passengers.find(p => p.id === id);
  let ticketId = asId(entry.ticketId ?? entry.ticket);
  if (entry.ticket && typeof entry.ticket === 'object') {
    const ticketData = entry.ticket;
    ticketId = asId(ticketData.id ?? ticketId) ?? `TK-${id}`;
    if (!state.tickets.some(t => t.id === ticketId)) {
      state.tickets.push({
        id: ticketId,
        operator: ticketData.operator ?? entry.operator ?? 'OP-UNKNOWN',
        legs: ticketData.legs ?? entry.legs ?? [],
      });
    }
  } else if (ticketId && !state.tickets.some(t => t.id === ticketId)) {
    state.tickets.push({ id: ticketId, operator: entry.operator ?? 'OP-UNKNOWN', legs: entry.legs ?? [] });
  }
  if (!passenger) {
    passenger = {
      id: id ?? nextId(state, 'PA'),
      ticket: ticketId ?? nextId(state, 'TK'),
      party: entry.party ?? entry.partyId ?? null,
      needs: entry.needs ?? [],
      identityRef: entry.identityRef ?? entry.identityId ?? null,
      synthetic: true,
    };
    if (!state.tickets.some(t => t.id === passenger.ticket)) {
      state.tickets.push({ id: passenger.ticket, operator: entry.operator ?? 'OP-UNKNOWN', legs: entry.legs ?? [] });
    }
    state.passengers.push(passenger);
  } else {
    if (ticketId) passenger.ticket = ticketId;
    if (entry.party ?? entry.partyId) passenger.party = entry.party ?? entry.partyId;
    if (Array.isArray(entry.needs)) passenger.needs = [...new Set([...(passenger.needs ?? []), ...entry.needs])];
    if (entry.identityRef) passenger.identityRef = entry.identityRef;
  }
  if (!state.passengerStates[passenger.id]) {
    state.passengerStates[passenger.id] = { status: 'unknown', serviceId, history: [] };
  }
  return passenger;
}

export function createAffectedService(state, body = {}) {
  const id = asId(body.id ?? body.serviceId ?? body.tripId ?? body.incidentId) ?? nextId(state, 'SVC', 'service');
  if (state.affectedServices.some(s => s.id === id)) {
    const existing = state.affectedServices.find(s => s.id === id);
    const incoming = idList(body.passengerIds ?? body.passengers).map(asId);
    if (incoming.length && JSON.stringify([...incoming].sort()) !== JSON.stringify([...existing.passengerIds].sort())) {
      throw conflict('SERVICE_ID_CONFLICT', '受影响班次编号已对应不同旅客清单', { id });
    }
    return existing;
  }
  const roster = body.passengers ?? body.passengerList ?? body.passengerIds ?? [];
  const passengers = (Array.isArray(roster) ? roster : [roster]).map(entry => upsertPassengerFromRoster(state, entry, id));
  const passengerIds = [...new Set(passengers.map(p => p.id))];
  const service = {
    id,
    serviceNo: body.serviceNo ?? body.tripNo ?? body.trainNo ?? id,
    type: body.type ?? 'affected-service',
    operator: body.operator ?? body.originalOperator ?? null,
    originalVehicleId: asId(body.originalVehicleId ?? body.vehicleId) ?? null,
    currentLocationId: asId(body.currentLocationId ?? body.locationId ?? body.at) ?? null,
    destinationId: asId(body.destinationId ?? body.to) ?? null,
    legs: body.legs ?? [],
    occurredAt: body.occurredAt ? isoTime(body.occurredAt) : null,
    receivedAt: isoTime(body.receivedAt ?? body.at),
    status: body.status ?? 'active',
    passengerIds,
    rosterKey: body.rosterKey ?? null,
  };
  state.affectedServices.push(service);
  for (const pid of passengerIds) {
    state.passengerStates[pid] ??= { status: 'unknown', history: [] };
    state.passengerStates[pid].serviceId = id;
  }
  addEvent(state, { type: 'affected-service.received', serviceId: id, passengerIds });
  return service;
}

export function confirmSituation(state, passengerId, body = {}) {
  const passenger = passengerById(state, passengerId);
  if (body.ticketId || body.identityRef || body.identity) verifyIdentity(state, passenger, body);
  const at = isoTime(body.at ?? body.observedAt ?? body.occurredAt);
  let status = body.status ? String(body.status) : null;
  if (!status) {
    if (body.missing === true || body.unreachable === true) status = 'unreachable';
    else if (body.onOriginalVehicle === true) status = 'on_original_vehicle';
    else if (body.onOriginalVehicle === false) status = 'off_original_vehicle';
    else if (body.reported === true) status = 'reported';
  }
  const record = {
    at,
    actorId: body.actorId ?? body.confirmedBy ?? body.responsibleId ?? 'station-a',
    onOriginalVehicle: body.onOriginalVehicle,
    status: status ?? 'unknown',
    currentLocationId: asId(body.currentLocationId ?? body.locationId ?? body.whereabouts) ?? null,
    intention: body.intention ?? body.choice ?? body.destinationChoice ?? null,
    note: body.note ?? body.remark ?? null,
    sourceChangeId: body.sourceChangeId ?? null,
  };
  const current = state.passengerStates[passenger.id] ?? { history: [] };
  const next = { ...current, ...record, history: [...(current.history ?? []), record] };
  state.passengerStates[passenger.id] = next;
  addEvent(state, { type: 'passenger.situation_confirmed', passengerId: passenger.id, ...record });
  return passengerView(state, passenger.id);
}

export function prepareDispatch(state, arrangementId, body = {}) {
  const arrangement = getArrangement(state, arrangementId);
  if (arrangement.kind === 'proposal') throw conflict('PROPOSAL_NOT_ARRANGEMENT', '推荐线路尚未形成接续安排，不能派车');
  if (['released', 'cancelled', 'expired', 'dispatch_rejected'].includes(arrangement.status)) {
    throw conflict('ARRANGEMENT_NOT_DISPATCHABLE', '安排已失效，不能派车；需重新安排', { status: arrangement.status });
  }
  if (arrangement.dispatchRequestId && !body.resend) {
    const existing = state.dispatchRequests.find(r => r.id === arrangement.dispatchRequestId);
    if (existing) return { ok: true, idempotent: true, arrangement, request: existing, key: existing.key, items: existing.items };
  }
  const at = body.at ?? body.dispatchAt ?? new Date().toISOString();
  const routeCheck = (() => {
    // 派车时按预定发车时间复核；未给发车时间则按当前/指定时刻复核。
    const departureAt = body.departureAt ?? arrangement.departureAt ?? at;
    const { evaluateRoute } = requireCore();
    return evaluateRoute(state, { ...arrangement.route, roadIds: body.roadIds ?? arrangement.roadIds, vehicleType: body.vehicleType, at, departureAt });
  })();
  if (!routeCheck.ok) {
    return { ok: false, status: 409, code: 'ROUTE_NOT_EXECUTABLE_AT_DISPATCH', message: '道路信息已变化，方案在派车时不可执行', blockers: routeCheck.blockers, arrangement };
  }
  if (arrangement.shelterId) {
    const shelter = shelterById(state, arrangement.shelterId);
    if (shelter.accepting === false) {
      return { ok: false, status: 409, code: 'SHELTER_NOT_ACCEPTING', message: '目的地安置点已停收，不能按原方案派车', shelterId: shelter.id, arrangement };
    }
  }
  const key = body.dispatchKey ?? arrangement.dispatchKey ?? `DISPATCH-KEY-${arrangement.id}`;
  const prefix = body.dispatchNoPrefix ?? arrangement.id;
  const items = arrangement.passengers.map((p, index) => ({
    dispatchNo: p.dispatchNo ?? `${prefix}-${p.passengerId}`.slice(0, 100),
    reference: body.reference ?? `synthetic-${arrangement.id}-${index + 1}`,
    // 仅包含运输执行所需范围；不含原票、身份资料、退款进度。
    passengerScope: {
      passengerId: p.passengerId,
      seatKind: p.kind,
      needs: p.needs ?? [],
      pickupLocationId: arrangement.fromLocationId,
      companionGroup: arrangement.passengerIds.length > 1 ? (body.companionGroup ?? arrangement.serviceId ?? arrangement.id) : null,
    },
  }));
  for (const [i, item] of items.entries()) arrangement.passengers[i].dispatchNo = item.dispatchNo;
  const request = {
    id: nextId(state, 'DSP', 'dispatchRequest'),
    key,
    arrangementId: arrangement.id,
    vehicleId: arrangement.vehicleId,
    carrierId: arrangement.carrierId,
    items,
    status: 'awaiting_receipt',
    receiptStatus: 'unknown',
    transmission: body.carrierUrl || process.env.CARRIER_URL || process.env.PARTNER_URL ? 'external-partner' : 'manual',
    createdAt: isoTime(at),
    attempts: [],
    receipts: [],
  };
  state.dispatchRequests.push(request);
  arrangement.dispatchRequestId = request.id;
  arrangement.dispatchState = 'awaiting_receipt';
  if (arrangement.status === 'reserved') arrangement.status = 'dispatch_pending';
  addArrangementEvent(arrangement, 'dispatch.requested', { dispatchRequestId: request.id, key });
  addEvent(state, { type: 'dispatch.requested', dispatchRequestId: request.id, arrangementId: arrangement.id });
  return { ok: true, arrangement, request, key, items };
}

// 避免循环导入层面的不便：延迟从全局已导入模块取 evaluateRoute。
import * as Core from './dispatch-core.mjs';
function requireCore() { return Core; }

export function recordExternalResult(state, requestId, result) {
  const request = findOrThrow(state.dispatchRequests, requestId, '派车请求');
  const at = new Date().toISOString();
  request.attempts.push({ at, ok: result.ok, status: result.status ?? null, unknown: !!result.unknown, error: result.error ?? null });
  if (result.unknown) {
    request.receiptStatus = 'unknown';
    request.status = 'unknown';
    const arrangement = getArrangement(state, request.arrangementId);
    arrangement.dispatchState = 'unknown';
    if (['dispatch_pending', 'reserved'].includes(arrangement.status)) arrangement.status = 'dispatch_unknown';
    addArrangementEvent(arrangement, 'dispatch.receipt_unknown', { error: result.error });
    return { request, arrangement };
  }
  if (result.ok && result.body?.results) {
    for (const remote of result.body.results) {
      const item = request.items.find(i => i.dispatchNo === remote.id || i.dispatchNo === remote.dispatchNo);
      if (item) item.remoteStatus = remote.status;
    }
    const statuses = result.body.results.map(r => normalizeReceiptStatus(r.status) ?? r.status);
    request.remoteResults = result.body.results;
    request.remoteStatuses = statuses;
    if (statuses.length && statuses.every(s => s === 'pending')) request.receiptStatus = 'pending';
    else if (statuses.length && statuses.every(s => s === 'rejected')) request.receiptStatus = 'rejected';
    else if (statuses.length && statuses.every(s => s === 'accepted')) request.receiptStatus = 'accepted';
    else request.receiptStatus = 'received';
  } else {
    request.receiptStatus = result.ok ? 'received' : 'http_error';
    request.httpError = result.body ?? { status: result.status };
  }
  const arrangement = getArrangement(state, request.arrangementId);
  arrangement.dispatchState = request.receiptStatus;
  if (request.receiptStatus === 'accepted' && ['reserved', 'dispatch_pending', 'dispatch_unknown'].includes(arrangement.status)) {
    arrangement.status = 'carrier_accepted';
  } else if (request.receiptStatus === 'pending' && ['reserved', 'dispatch_pending', 'dispatch_unknown'].includes(arrangement.status)) {
    arrangement.status = 'dispatch_pending';
  }
  return { request, arrangement };
}

export function findDispatchTarget(state, target, body = {}) {
  const id = asId(target);
  let request = state.dispatchRequests.find(r => r.id === id) ??
    state.dispatchRequests.find(r => r.key === id) ??
    state.dispatchRequests.find(r => r.items.some(i => i.dispatchNo === id || i.dispatchNo === body.dispatchNo));
  if (!request) {
    const arrangement = state.arrangements.find(a => a.id === id);
    if (arrangement?.dispatchRequestId) request = state.dispatchRequests.find(r => r.id === arrangement.dispatchRequestId);
  }
  if (!request && body.dispatchNo) {
    request = state.dispatchRequests.find(r => r.items.some(i => i.dispatchNo === body.dispatchNo));
  }
  if (!request) throw notFound('未找到派车请求或逐项编号', { target: id });
  return request;
}

export function renewExpiredHoldsIfPossible(state, arrangement, at = new Date().toISOString()) {
  const shortages = [];
  const ttlMs = 15 * 60000;
  const expired = state.reservations.filter(r => r.arrangementId === arrangement.id && r.status === 'expired');
  for (const reservation of expired) {
    if (reservation.resourceType === 'vehicle') {
      const vehicle = vehicleById(state, reservation.resourceId);
      const activeSameKind = state.reservations.filter(r =>
        r.resourceType === 'vehicle' && r.resourceId === vehicle.id &&
        ['held', 'boarded'].includes(r.status) && r.kind === reservation.kind).length;
      const limit = reservation.kind === 'wheelchair' ? (vehicle.wheelchairSlots ?? 0) : (vehicle.seats ?? 0);
      if (activeSameKind >= limit) {
        shortages.push({ reservationId: reservation.id, resourceId: vehicle.id, kind: reservation.kind, reason: 'vehicle-capacity-taken' });
        continue;
      }
      reservation.status = 'held';
      reservation.expiresAt = new Date(Date.parse(at) + ttlMs).toISOString();
      reservation.renewedAt = at;
      reservation.renewReason = '承运确认到达后重新核验容量并续期';
    } else if (reservation.resourceType === 'shelter') {
      const shelter = shelterById(state, reservation.resourceId);
      if (shelter.accepting === false) {
        shortages.push({ reservationId: reservation.id, resourceId: shelter.id, reason: 'shelter-not-accepting' });
        continue;
      }
      const counts = reservationCounts(state, 'shelter', shelter.id);
      if (counts.committed >= (shelter.capacity ?? 0)) {
        shortages.push({ reservationId: reservation.id, resourceId: shelter.id, reason: 'shelter-capacity-taken' });
        continue;
      }
      if (reservation.kind === 'accessible' && counts.accessibleCommitted >= (shelter.accessibleBeds ?? 0)) {
        shortages.push({ reservationId: reservation.id, resourceId: shelter.id, reason: 'accessible-bed-taken' });
        continue;
      }
      reservation.status = 'held';
      reservation.expiresAt = new Date(Date.parse(at) + ttlMs).toISOString();
      reservation.renewedAt = at;
      reservation.renewReason = '承运确认到达后重新核验容量并续期';
    }
  }
  if (shortages.length) {
    arrangement.status = 'blocked';
    arrangement.holdRenewalShortages = shortages;
    const contingency = openContingency(state, {
      arrangementId: arrangement.id,
      type: 'carrier_confirmed_after_hold_expired',
      reason: '承运回执到达时预留已过期且容量已被其他安排使用，不能自动恢复承诺',
      currentLocationId: arrangement.fromLocationId,
      temporaryResponsibleId: arrangement.responsible?.dispatchActorId,
      shortages,
    });
    return { ok: false, shortages, contingency };
  }
  return { ok: true, renewed: expired.length };
}

export function applyReceipt(state, target, body = {}) {
  const request = findDispatchTarget(state, target, body);
  const arrangement = getArrangement(state, request.arrangementId);
  const rawStatus = body.status ?? body.receiptStatus ?? body.state;
  const status = normalizeReceiptStatus(rawStatus) ?? 'accepted';
  const at = isoTime(body.at ?? body.receivedAt ?? body.occurredAt);
  const details = body.details ?? body.payload ?? {};
  const fingerprint = JSON.stringify({ status, details, dispatchNo: body.dispatchNo ?? null });
  if (request.terminalFingerprint && request.terminalFingerprint === fingerprint) {
    return { idempotent: true, request, arrangement };
  }

  // 晚到旧回执：只要旅客当前有效安排已经不是该旧安排，就只能留档，不能覆盖。
  const stalePassengers = [];
  for (const item of request.items) {
    const active = activeAllocationForPassenger(state, item.passengerId);
    if (active && active.arrangement.id !== arrangement.id) {
      stalePassengers.push({ passengerId: item.passengerId, currentArrangementId: active.arrangement.id });
    }
  }
  const arrangementInactive = ['released', 'cancelled', 'expired'].includes(arrangement.status);
  if (stalePassengers.length || (arrangementInactive && !body.allowResurrect)) {
    const receipt = {
      id: nextId(state, 'RCP'),
      dispatchRequestId: request.id,
      arrangementId: arrangement.id,
      status, at, details, fingerprint,
      applied: false,
      reason: stalePassengers.length ? 'later_confirmed_arrangement_exists' : 'arrangement_released',
      stalePassengers,
    };
    state.receipts.push(receipt);
    request.receipts.push(receipt.id);
    return {
      httpStatus: 409,
      code: 'STALE_DISPATCH_RECEIPT',
      message: '这是晚到的旧派车回执，不能覆盖后来已确认或仍有效的接续安排',
      receipt,
      stalePassengers,
      currentArrangementId: stalePassengers[0]?.currentArrangementId ?? null,
    };
  }

  const receipt = {
    id: nextId(state, 'RCP'), dispatchRequestId: request.id, arrangementId: arrangement.id,
    status, at, details, fingerprint, applied: true,
  };
  state.receipts.push(receipt);
  request.receipts.push(receipt.id);
  request.lastReceiptAt = at;
  request.receiptStatus = status;
  request.status = status;
  request.details = details;
  if (['confirmed', 'rejected', 'returned'].includes(status)) request.terminalFingerprint = fingerprint;

  for (const remote of body.results ?? []) {
    const item = request.items.find(i => i.dispatchNo === (remote.id ?? remote.dispatchNo));
    if (item) item.remoteStatus = normalizeReceiptStatus(remote.status) ?? remote.status;
  }

  arrangement.dispatchState = status;
  arrangement.lastReceiptAt = at;
  if (status === 'confirmed') {
    const renewal = renewExpiredHoldsIfPossible(state, arrangement, at);
    if (!renewal.ok) {
      return {
        httpStatus: 409,
        code: 'HOLD_EXPIRED_CAPACITY_UNAVAILABLE',
        message: '承运回执已记录，但预留期限已过且资源不足；不能自动恢复原承诺，已进入接续处置',
        receipt, request, arrangement, ...renewal,
      };
    }
    const routeCheck = Core.evaluateRoute(state, { ...arrangement.route, at: body.at ?? new Date().toISOString() });
    arrangement.executableAtConfirmation = routeCheck.ok;
    arrangement.routeCheckAtConfirmation = routeCheck;
    if (!routeCheck.ok) {
      arrangement.status = 'blocked';
      const contingency = openContingency(state, {
        arrangementId: arrangement.id,
        type: 'route_blocked_after_carrier_confirmation',
        reason: '承运方已确认，但道路复核不可执行，需调度接续',
        blockers: routeCheck.blockers,
        currentLocationId: arrangement.fromLocationId,
        temporaryResponsibleId: arrangement.responsible?.dispatchActorId,
      });
      return { ok: true, executable: false, arrangement, request, receipt, contingency };
    }
    if (!['boarded', 'partially_boarded', 'departed', 'arrived', 'partially_handed_over', 'handed_over'].includes(arrangement.status)) {
      arrangement.status = 'confirmed';
    }
  } else if (status === 'accepted' || status === 'pending') {
    if (!['boarded', 'partially_boarded', 'departed', 'arrived', 'partially_handed_over', 'handed_over'].includes(arrangement.status)) {
      arrangement.status = status === 'pending' ? 'dispatch_pending' : 'carrier_accepted';
    }
  } else if (status === 'rejected' || status === 'returned') {
    arrangement.status = 'dispatch_rejected';
    for (const p of arrangement.passengers) if (p.status === 'reserved' || p.status === 'reported') p.status = 'released';
    for (const r of state.reservations.filter(r => r.arrangementId === arrangement.id && r.status === 'held')) {
      r.status = 'released';
      r.releasedAt = at;
      r.releaseReason = `承运方${status === 'rejected' ? '拒绝' : '退回'}`;
    }
  }
  addArrangementEvent(arrangement, 'dispatch.receipt', { receiptId: receipt.id, status });
  addEvent(state, { type: 'dispatch.receipt', arrangementId: arrangement.id, status });
  return { ok: true, applied: true, arrangement, request, receipt };
}

export function recordCheckpoint(state, arrangementId, action, body = {}) {
  const arrangement = getArrangement(state, arrangementId);
  const ids = arrangementPassengerIds(body, arrangement);
  const at = isoTime(body.at ?? body.occurredAt);
  const actorId = body.actorId ?? body.confirmedBy ?? body.responsibleId ?? body.staffId ?? null;
  const locationId = asId(body.locationId ?? body.currentLocationId ?? body.atLocation) ?? null;
  const rosterKey = body.rosterKey ?? body.listKey ?? body.duplicateKey ?? null;
  state.rosterOperations ??= [];
  if (rosterKey) {
    const prior = state.rosterOperations.find(op => op.rosterKey === rosterKey && op.action === action);
    if (prior) {
      return { idempotent: true, duplicate: true, operation: prior, arrangement };
    }
    const conflictKey = state.rosterOperations.find(op => op.rosterKey === rosterKey && op.action !== action);
    if (conflictKey) throw conflict('ROSTER_KEY_CONFLICT', '重复名单键用于不同报到/上车动作');
  }

  const results = [];
  for (const pid of ids) {
    const item = getAllocation(arrangement, pid);
    if (action === 'report' || action === 'check-in') {
      if (['released', 'no_show', 'cancelled'].includes(item.status)) throw conflict('PASSENGER_NOT_ACTIVE', '旅客安排已失效，不能报到', { passengerId: pid, status: item.status });
      if (!['reported', 'boarded', 'arrived', 'handed_over'].includes(item.status)) item.status = 'reported';
      item.reportedAt ??= at;
      item.reportedBy ??= actorId;
      item.reportLocationId ??= locationId;
      results.push({ passengerId: pid, status: item.status, duplicate: item.reportedAt !== at && item.status !== 'reported' ? false : undefined });
    } else if (action === 'board' || action === 'pickup') {
      if (['released', 'no_show', 'cancelled'].includes(item.status)) throw conflict('PASSENGER_NOT_ACTIVE', '旅客安排已失效，不能上车', { passengerId: pid, status: item.status });
      if (item.status === 'boarded' || item.status === 'arrived' || item.status === 'handed_over') {
        results.push({ passengerId: pid, status: item.status, duplicate: true });
        continue;
      }
      item.status = 'boarded';
      item.boardedAt = at;
      item.boardedBy = actorId;
      item.boardLocationId = locationId;
      const vehicleReservation = state.reservations.find(r => r.id === item.vehicleReservationId || (r.arrangementId === arrangement.id && r.passengerId === pid && r.resourceType === 'vehicle' && ['held', 'boarded'].includes(r.status)));
      if (vehicleReservation) vehicleReservation.status = 'boarded';
      state.passengerStates[pid] ??= { history: [] };
      state.passengerStates[pid].currentLocationId = arrangement.vehicleId ? `车辆:${arrangement.vehicleId}` : locationId;
      state.passengerStates[pid].onBoardArrangementId = arrangement.id;
      results.push({ passengerId: pid, status: 'boarded' });
    } else if (action === 'arrive') {
      if (item.status === 'handed_over' || item.status === 'arrived') {
        results.push({ passengerId: pid, status: item.status, duplicate: true });
        continue;
      }
      if (item.status !== 'boarded') throw conflict('PASSENGER_NOT_BOARDED', '旅客尚未由责任人确认上车，不能确认随车到达', { passengerId: pid, status: item.status });
      item.status = 'arrived';
      item.arrivedAt = at;
      item.arrivedBy = actorId;
      item.arrivalLocationId = locationId ?? arrangement.toLocationId;
      const vehicleReservation = state.reservations.find(r => r.arrangementId === arrangement.id && r.passengerId === pid && r.resourceType === 'vehicle' && r.status === 'boarded');
      if (vehicleReservation) vehicleReservation.status = 'completed';
      results.push({ passengerId: pid, status: 'arrived' });
    } else if (action === 'no-show' || action === 'missing') {
      item.status = 'no_show';
      item.noShowAt = at;
      item.noShowBy = actorId;
      item.noShowReason = body.reason ?? body.note ?? '失联或未到';
      for (const r of state.reservations.filter(r => r.arrangementId === arrangement.id && r.passengerId === pid && r.status === 'held')) {
        r.status = 'no_show';
        r.releasedAt = at;
      }
      openContingency(state, {
        arrangementId: arrangement.id,
        passengerIds: [pid],
        type: 'passenger_missing',
        reason: item.noShowReason,
        currentLocationId: locationId ?? arrangement.fromLocationId,
        temporaryResponsibleId: actorId ?? arrangement.responsible?.stationActorId,
      });
      results.push({ passengerId: pid, status: 'no_show' });
    } else {
      throw badRequest(`不支持的检查点动作：${action}`);
    }
  }
  if (action === 'report' || action === 'check-in') arrangement.responsible.stationActorId ??= actorId;
  if (action === 'board' || action === 'pickup') arrangement.responsible.pickupActorId ??= actorId;
  if (action === 'arrive') arrangement.responsible.vehicleActorId ??= actorId;
  syncArrangementStatus(arrangement);
  const operation = { id: nextId(state, 'ROSTER'), rosterKey, action, arrangementId: arrangement.id, passengerIds: ids, at, actorId, results };
  state.rosterOperations.push(operation);
  addArrangementEvent(arrangement, `checkpoint.${action}`, { operationId: operation.id, rosterKey, passengerIds: ids });
  addEvent(state, { type: `checkpoint.${action}`, arrangementId: arrangement.id, passengerIds: ids, rosterKey });
  return { ok: true, operation, arrangement, results };
}

export function departArrangement(state, arrangementId, body = {}) {
  const arrangement = getArrangement(state, arrangementId);
  const at = isoTime(body.at ?? body.departureAt);
  const route = Core.evaluateRoute(state, {
    ...arrangement.route,
    roadIds: body.roadIds ?? arrangement.roadIds,
    at,
    departureAt: at,
  });
  if (!route.ok) {
    const contingency = openContingency(state, {
      arrangementId: arrangement.id,
      type: 'road_closed_at_departure',
      reason: '实际发车前复核发现路线不可执行，已阻止发车',
      blockers: route.blockers,
      currentLocationId: body.currentLocationId ?? arrangement.fromLocationId,
      temporaryResponsibleId: body.actorId ?? arrangement.responsible?.vehicleActorId ?? arrangement.responsible?.dispatchActorId,
    });
    arrangement.lastDepartureCheck = { at, ok: false, route };
    return { httpStatus: 409, code: 'ROUTE_NOT_EXECUTABLE_AT_DEPARTURE', message: '已封闭/限行路段仍不可执行，不能为保持承诺而发车', route, contingency, arrangement };
  }
  arrangement.status = 'departed';
  arrangement.departedAt = at;
  arrangement.departedBy = body.actorId ?? body.confirmedBy ?? null;
  arrangement.actualRouteCheck = { at, ok: true, route };
  arrangement.roadIds = route.roadIds;
  addArrangementEvent(arrangement, 'vehicle.departed', { at, by: arrangement.departedBy });
  addEvent(state, { type: 'vehicle.departed', arrangementId: arrangement.id });
  return { ok: true, arrangement, route };
}

export function handoverArrangement(state, arrangementId, body = {}) {
  const arrangement = getArrangement(state, arrangementId);
  const ids = arrangementPassengerIds(body, arrangement);
  const requestedShelterId = asId(body.shelterId ?? body.toShelterId) ?? arrangement.shelterId;
  if (!requestedShelterId) throw badRequest('到站移交必须给出接收安置点');
  const shelter = shelterById(state, requestedShelterId);
  const at = isoTime(body.at ?? body.handedOverAt ?? body.receivedAt);
  const rosterKey = body.rosterKey ?? body.handoverKey ?? body.listKey ?? null;
  state.rosterOperations ??= [];
  if (arrangement.lastDepartureCheck?.ok === false) {
    const recovered = arrangement.actualRouteCheck?.ok &&
      arrangement.actualRouteCheck.at &&
      arrangement.lastDepartureCheck.at &&
      Date.parse(arrangement.actualRouteCheck.at) >= Date.parse(arrangement.lastDepartureCheck.at);
    if (!recovered) {
      const contingency = openContingency(state, {
        arrangementId: arrangement.id,
        passengerIds: ids,
        type: 'blocked_departure_handover_attempt',
        reason: '发车前道路复核未通过，不能把旅客重复计为已到站移交',
        blockers: arrangement.lastDepartureCheck.route?.blockers ?? [],
        currentLocationId: asId(body.currentLocationId) ?? arrangement.fromLocationId,
        temporaryResponsibleId: body.actorId ?? arrangement.responsible?.vehicleActorId ?? arrangement.responsible?.dispatchActorId,
      });
      return { httpStatus: 409, code: 'DEPARTURE_ROUTE_BLOCKED', message: '方案在实际发车时不可执行，尚未形成合法到站移交；已转入调度接续处置', contingency, arrangement };
    }
  }
  if (rosterKey) {
    const prior = state.handovers.find(h => h.rosterKey === rosterKey);
    if (prior) return { ok: true, idempotent: true, duplicate: true, handover: prior, arrangement };
  }

  // 先做全部接收资格预检，避免名单中一人失败导致部分移交。
  const toCreate = [];
  for (const pid of ids) {
    const item = getAllocation(arrangement, pid);
    if (item.status === 'handed_over' && item.handoverShelterId === shelter.id) continue;
    if (['released', 'no_show', 'cancelled'].includes(item.status)) {
      throw conflict('PASSENGER_NOT_ACTIVE', '旅客状态不是待移交，不能重复移交', { passengerId: pid, status: item.status });
    }
    if (shelter.accepting === false) {
      const contingency = openContingency(state, {
        arrangementId: arrangement.id,
        passengerIds: ids,
        type: 'shelter_stopped_at_handover',
        shelterId: shelter.id,
        reason: body.reason ?? '安置点已停收，移交未完成',
        currentLocationId: asId(body.currentLocationId ?? body.locationId) ?? arrangement.toLocationId ?? shelter.id,
        temporaryResponsibleId: body.actorId ?? body.escortId ?? arrangement.responsible?.temporaryActorId ?? arrangement.responsible?.vehicleActorId,
      });
      return { httpStatus: 409, code: 'SHELTER_NOT_ACCEPTING', message: '安置点当前停收；旅客仍由临时责任人负责，已进入接续处置', contingency, arrangement };
    }
    if (shelter.lastArrival && Date.parse(at) > Date.parse(shelter.lastArrival) && body.lateArrivalApproved !== true) {
      const contingency = openContingency(state, {
        arrangementId: arrangement.id,
        passengerIds: ids,
        type: 'arrived_after_last_arrival',
        shelterId: shelter.id,
        reason: '晚于最晚到达时间，安置点未确认接收',
        currentLocationId: asId(body.currentLocationId) ?? shelter.id,
        temporaryResponsibleId: body.actorId ?? arrangement.responsible?.vehicleActorId,
      });
      return { httpStatus: 409, code: 'SHELTER_LAST_ARRIVAL_PASSED', message: '已超过安置点最晚到达时间，不能自动按已安置处理', contingency, arrangement };
    }
    const existingReservation = state.reservations.find(r =>
      r.arrangementId === arrangement.id && r.passengerId === pid && r.resourceType === 'shelter' && r.resourceId === shelter.id && ['held', 'occupied'].includes(r.status));
    if (!existingReservation) {
      const kind = item.kind === 'wheelchair' ? 'accessible' : item.kind === 'accessible' ? 'accessible' : 'ordinary';
      try {
        assertShelterCapacity(state, shelter, [{ kind }]);
      } catch (error) {
        if (error instanceof BusinessError) {
          const contingency = openContingency(state, {
            arrangementId: arrangement.id, passengerIds: ids, type: 'shelter_full_at_handover', shelterId: shelter.id,
            reason: error.message, currentLocationId: shelter.id,
            temporaryResponsibleId: body.actorId ?? arrangement.responsible?.vehicleActorId,
          });
          return { httpStatus: error.status, code: error.code, message: error.message, details: error.details, contingency, arrangement };
        }
        throw error;
      }
      toCreate.push({ pid, kind });
    }
  }

  for (const { pid, kind } of toCreate) {
    state.reservations.push({
      id: nextId(state, 'RSV-S'), type: 'shelter-place', resourceType: 'shelter', resourceId: shelter.id,
      arrangementId: arrangement.id, passengerId: pid, kind, quantity: 1, status: 'occupied', createdAt: at, occupiedAt: at,
    });
  }

  const handover = {
    id: nextId(state, 'HO'),
    arrangementId: arrangement.id,
    shelterId: shelter.id,
    passengerIds: [],
    receivedBy: body.receivedBy ?? body.receiverId ?? body.shelterActorId ?? null,
    handedOverBy: body.actorId ?? body.handedOverBy ?? body.escortId ?? null,
    rosterKey,
    at,
  };
  for (const pid of ids) {
    const item = getAllocation(arrangement, pid);
    if (item.status === 'handed_over' && item.handoverId) {
      if (item.handoverShelterId === shelter.id) { handover.passengerIds.push(pid); continue; }
      throw conflict('PASSENGER_ALREADY_HANDED_OVER', '旅客已移交其他安置点，重复名单不能覆盖事实', { passengerId: pid });
    }
    item.status = 'handed_over';
    item.handedOverAt = at;
    item.handedOverBy = handover.handedOverBy;
    item.receivedBy = handover.receivedBy;
    item.handoverId = handover.id;
    item.handoverShelterId = shelter.id;
    const reservation = state.reservations.find(r => r.arrangementId === arrangement.id && r.passengerId === pid && r.resourceType === 'shelter' && r.resourceId === shelter.id && r.status === 'held');
    if (reservation) {
      reservation.status = 'occupied';
      reservation.occupiedAt = at;
    }
    for (const oldReservation of state.reservations.filter(r => r.arrangementId === arrangement.id && r.passengerId === pid && r.resourceType === 'shelter' && r.resourceId !== shelter.id && r.status === 'held')) {
      oldReservation.status = 'released';
      oldReservation.releasedAt = at;
      oldReservation.releaseReason = `改向确认安置点 ${shelter.id}`;
    }
    const vehicleReservation = state.reservations.find(r => r.arrangementId === arrangement.id && r.passengerId === pid && r.resourceType === 'vehicle' && ['boarded', 'held'].includes(r.status));
    if (vehicleReservation) vehicleReservation.status = 'completed';
    state.passengerStates[pid] ??= { history: [] };
    state.passengerStates[pid].status = 'sheltered';
    state.passengerStates[pid].currentLocationId = shelter.id;
    state.passengerStates[pid].responsibleActorId = handover.receivedBy;
    handover.passengerIds.push(pid);
  }
  state.handovers.push(handover);
  arrangement.responsible.shelterActorId = handover.receivedBy;
  if (arrangement.shelterId !== shelter.id) arrangement.alternateShelterId = shelter.id;
  syncArrangementStatus(arrangement);
  state.rosterOperations.push({ id: nextId(state, 'ROSTER'), rosterKey, action: 'handover', arrangementId: arrangement.id, passengerIds: ids, at });
  closeContingenciesForHandover(state, arrangement.id, shelter.id, handover.id);
  addArrangementEvent(arrangement, 'handover.completed', { handoverId: handover.id, shelterId: shelter.id, rosterKey });
  addEvent(state, { type: 'handover.completed', handoverId: handover.id, arrangementId: arrangement.id, shelterId: shelter.id });
  return { ok: true, handover, arrangement };
}

export function openContingency(state, input = {}) {
  const passengerIds = input.passengerIds ?? (input.arrangementId ? getArrangement(state, input.arrangementId).passengerIds : []);
  let contingency = input.id ? state.contingencies.find(c => c.id === input.id) : state.contingencies.find(c =>
    c.arrangementId === input.arrangementId && c.status !== 'resolved' && c.type === input.type);
  if (!contingency) {
    contingency = {
      id: nextId(state, 'CONT'),
      status: 'open',
      type: input.type ?? 'dispatch_continuation',
      arrangementId: input.arrangementId ?? null,
      passengerIds: [...new Set(passengerIds)],
      shelterId: input.shelterId ?? null,
      reason: input.reason ?? null,
      blockers: input.blockers ?? [],
      currentLocationId: input.currentLocationId ?? null,
      temporaryResponsibleId: input.temporaryResponsibleId ?? null,
      newConfirmedLocationId: input.newConfirmedLocationId ?? input.newShelterId ?? null,
      createdAt: new Date().toISOString(),
      updates: [],
    };
    state.contingencies.push(contingency);
  } else {
    Object.assign(contingency, {
      reason: input.reason ?? contingency.reason,
      blockers: input.blockers ?? contingency.blockers,
      currentLocationId: input.currentLocationId ?? contingency.currentLocationId,
      temporaryResponsibleId: input.temporaryResponsibleId ?? contingency.temporaryResponsibleId,
      newConfirmedLocationId: input.newConfirmedLocationId ?? contingency.newConfirmedLocationId,
    });
    contingency.passengerIds = [...new Set([...contingency.passengerIds, ...passengerIds])];
  }
  const complete = !!(contingency.currentLocationId && contingency.temporaryResponsibleId && contingency.newConfirmedLocationId);
  contingency.status = complete ? 'location_confirmed' : 'awaiting_details';
  contingency.missing = [
    !contingency.currentLocationId && 'currentLocationId',
    !contingency.temporaryResponsibleId && 'temporaryResponsibleId',
    !contingency.newConfirmedLocationId && 'newConfirmedLocationId',
  ].filter(Boolean);
  contingency.updates.push({ at: new Date().toISOString(), ...input.update });
  if (input.arrangementId) {
    const arrangement = state.arrangements.find(a => a.id === input.arrangementId);
    if (arrangement) {
      arrangement.contingencyId = contingency.id;
      arrangement.responsible.temporaryActorId = contingency.temporaryResponsibleId ?? arrangement.responsible.temporaryActorId;
      if (!['handed_over', 'partially_handed_over'].includes(arrangement.status)) arrangement.contingencyStatus = contingency.status;
    }
  }
  addEvent(state, { type: 'contingency.opened_or_updated', contingencyId: contingency.id, arrangementId: input.arrangementId ?? null });
  return contingency;
}

export function updateContingency(state, id, body = {}) {
  const contingency = findOrThrow(state.contingencies, asId(id), '接续处置事项');
  const currentLocationId = asId(pickFirst(body, ['currentLocationId', 'currentLocation', 'locationId'])) ?? contingency.currentLocationId;
  const temporaryResponsibleId = asId(pickFirst(body, ['temporaryResponsibleId', 'temporaryResponsible', 'responsibleId', 'caretakerId'])) ?? contingency.temporaryResponsibleId;
  const newConfirmedLocationId = asId(pickFirst(body, ['newConfirmedLocationId', 'confirmedLocationId', 'newLocationId', 'newShelterId', 'destinationId'])) ?? contingency.newConfirmedLocationId;
  contingency.currentLocationId = currentLocationId;
  contingency.temporaryResponsibleId = temporaryResponsibleId;
  contingency.newConfirmedLocationId = newConfirmedLocationId;
  if (newConfirmedLocationId && state.shelters.some(s => s.id === newConfirmedLocationId)) {
    contingency.newShelterId = newConfirmedLocationId;
  }
  if (body.note) contingency.updates.push({ at: isoTime(body.at), note: body.note, actorId: body.actorId });
  const missing = [
    !currentLocationId && 'currentLocationId',
    !temporaryResponsibleId && 'temporaryResponsibleId',
    !newConfirmedLocationId && 'newConfirmedLocationId',
  ].filter(Boolean);
  contingency.missing = missing;
  if (body.confirm === true || body.status === 'confirmed' || body.complete === true) {
    if (missing.length) throw conflict('CONTINGENCY_DETAILS_INCOMPLETE', '必须明确当前位置、临时责任人和新的确认地点', { missing });
    contingency.status = 'location_confirmed';
    contingency.confirmedAt = isoTime(body.at);
    contingency.confirmedBy = body.actorId ?? null;
  } else {
    contingency.status = missing.length ? 'awaiting_details' : 'location_confirmed';
  }
  if (body.resolve === true) contingency.status = 'resolved';
  const arrangement = contingency.arrangementId ? state.arrangements.find(a => a.id === contingency.arrangementId) : null;
  if (arrangement) {
    arrangement.responsible.temporaryActorId = temporaryResponsibleId;
    arrangement.contingencyStatus = contingency.status;
  }
  addEvent(state, { type: 'contingency.updated', contingencyId: contingency.id, status: contingency.status });
  return contingency;
}

export function closeContingenciesForHandover(state, arrangementId, shelterId, handoverId) {
  for (const contingency of state.contingencies.filter(c => c.arrangementId === arrangementId && c.status !== 'resolved')) {
    if (!contingency.newConfirmedLocationId || contingency.newConfirmedLocationId === shelterId) {
      contingency.status = 'resolved';
      contingency.resolvedAt = new Date().toISOString();
      contingency.resolvedByHandoverId = handoverId;
    }
  }
}

export function updateShelterReceiving(state, shelterId, body = {}) {
  const shelter = shelterById(state, shelterId);
  const accepting = body.accepting ?? (body.open !== undefined ? body.open : body.stopped !== undefined ? !body.stopped : true);
  shelter.accepting = accepting;
  const record = {
    id: nextId(state, 'SHELTER-UPD'), shelterId: shelter.id, accepting,
    reason: body.reason ?? body.note ?? null,
    actorId: body.actorId ?? body.updatedBy ?? 'shelter-a',
    at: isoTime(body.at),
  };
  state.shelterStatusUpdates.push(record);
  const contingencies = [];
  if (accepting === false) {
    const arrangements = state.arrangements.filter(a => a.shelterId === shelter.id && !['released', 'cancelled', 'expired', 'handed_over'].includes(a.status));
    for (const arrangement of arrangements) {
      const activePassengerIds = arrangement.passengers.filter(p => ['reserved', 'reported', 'boarded', 'arrived'].includes(p.status)).map(p => p.passengerId);
      if (!activePassengerIds.length) continue;
      const contingency = openContingency(state, {
        arrangementId: arrangement.id,
        passengerIds: activePassengerIds,
        type: 'shelter_stopped_receiving',
        shelterId: shelter.id,
        reason: body.reason ?? '安置点停止接收',
        currentLocationId: body.currentLocationId ?? arrangement.lastKnownLocationId ?? (['departed', 'boarded'].includes(arrangement.status) ? null : arrangement.fromLocationId),
        temporaryResponsibleId: body.temporaryResponsibleId ?? arrangement.responsible?.temporaryActorId ?? arrangement.responsible?.vehicleActorId ?? arrangement.responsible?.pickupActorId,
        newConfirmedLocationId: body.newConfirmedLocationId ?? null,
      });
      contingencies.push(contingency);
    }
  }
  addEvent(state, { type: 'shelter.receiving_updated', shelterId: shelter.id, accepting });
  return { shelter, record, contingencies };
}

export function confirmedLegs(state, passengerId, ticketId) {
  return [...new Set(state.legConfirmations
    .filter(l => l.passengerId === passengerId && (!ticketId || l.ticketId === ticketId) && l.status !== 'revoked')
    .map(l => l.leg))];
}

export function confirmLegFulfillment(state, body = {}) {
  const leg = asId(body.leg ?? body.legId ?? body.segmentId);
  if (!leg) throw badRequest('必须提供已履行票段 leg');
  const passengerIds = idList(body.passengerIds ?? body.passengers ?? body.passengerId);
  if (!passengerIds.length && body.ticketId) {
    passengerIds.push(...state.passengers.filter(p => p.ticket === body.ticketId).map(p => p.id));
  }
  if (!passengerIds.length) throw badRequest('必须提供旅客或原票');
  const at = isoTime(body.at ?? body.occurredAt ?? body.fulfilledAt);
  const records = [];
  for (const pid of passengerIds) {
    const passenger = passengerById(state, pid);
    const ticket = ticketForPassenger(state, passenger);
    if (body.operatorId && ticket.operator !== body.operatorId) throw forbidden('原运营方只能确认本方票务履行', { ticketId: ticket.id, operator: ticket.operator });
    if (!ticket.legs.includes(leg)) throw badRequest('票段不属于该原票', { ticketId: ticket.id, leg });
    let record = state.legConfirmations.find(l => l.passengerId === pid && l.leg === leg && l.status !== 'revoked');
    if (!record) {
      record = {
        id: nextId(state, 'LEG'), passengerId: pid, ticketId: ticket.id, leg,
        operator: ticket.operator, confirmedBy: body.actorId ?? body.operatorId ?? 'operator-a',
        sourceChangeId: body.sourceChangeId ?? null, at, status: 'fulfilled',
      };
      state.legConfirmations.push(record);
      addEvent(state, { type: 'ticket.leg_fulfilled', passengerId: pid, leg, ticketId: ticket.id });
    }
    records.push(record);
  }
  return records;
}

export function createRefund(state, passengerId, body = {}, operatorContext = null) {
  const passenger = passengerById(state, passengerId);
  const ticket = ticketForPassenger(state, passenger);
  const operatorId = operatorContext ?? body.operatorId ?? null;
  if (operatorId && ticket.operator !== operatorId) {
    throw forbidden('原运营方只处理本方票务', { ticketId: ticket.id, ticketOperator: ticket.operator, operatorId });
  }
  if (body.ticketId && body.ticketId !== ticket.id) throw forbidden('原票与退款申请不符');

  const fulfilled = new Set(confirmedLegs(state, passenger.id, ticket.id));
  const passengerRefunds = state.refundRequests.filter(r => r.passengerId === passenger.id && r.ticketId === ticket.id);
  const refunded = new Set(passengerRefunds.filter(r => r.status === 'refunded').flatMap(r => r.legs));
  const pending = new Set(passengerRefunds.filter(r => ['requested', 'approved', 'processing'].includes(r.status)).flatMap(r => r.legs));
  let legs;
  if (body.allUnfulfilled === true || body.legs === 'unfulfilled' || body.unfulfilled === true || body.legs === undefined) {
    legs = ticket.legs.filter(l => !fulfilled.has(l));
  } else {
    legs = idList(body.legs ?? body.leg ?? body.segments);
  }
  if (!legs.length) throw conflict('NO_REFUNDABLE_LEGS', '没有可申请退款的未履行区段', { fulfilled: [...fulfilled], refunded: [...refunded] });
  for (const leg of legs) {
    if (!ticket.legs.includes(leg)) throw badRequest('票段不属于该原票', { leg });
    if (fulfilled.has(leg)) throw conflict('LEG_FULFILLED_NOT_REFUNDABLE', '已实际履行/完成的票段不能退款', { leg });
    if (refunded.has(leg)) throw conflict('LEG_ALREADY_REFUNDED', '票段已退款，不能重复退款', { leg });
  }
  const duplicateLegs = legs.filter(l => pending.has(l));
  if (duplicateLegs.length) {
    const existing = passengerRefunds.find(r => r.legs.some(l => duplicateLegs.includes(l)) && ['requested', 'approved', 'processing'].includes(r.status));
    return { idempotent: true, duplicate: true, refund: existing };
  }

  let releasedArrangement = null;
  const boarded = hasBoardedContinuation(state, passenger.id);
  if (body.abandonContinuation === true || body.declineContinuation === true || body.cancelActiveArrangement === true) {
    if (boarded) {
      throw conflict('ALREADY_BOARDED', '旅客已经登上接续车，不能放弃已开始的接续或重复占座；未履行原票段仍可按退款进度处理', {
        arrangementId: boarded.arrangement.id,
        status: boarded.item.status,
      });
    }
    const { cancelForRefund } = requireCore();
    releasedArrangement = cancelForRefund(state, passenger.id, body);
  } else if (boarded && (body.reserveAnotherSeat === true || body.newArrangement === true || body.occupyAnotherSeat === true)) {
    throw conflict('ALREADY_BOARDED_DUPLICATE_SEAT', '已经登上接续车，不能通过重复申请再占一个位置');
  }

  const request = {
    id: body.id ?? nextId(state, 'RF', 'refund'),
    passengerId: passenger.id,
    ticketId: ticket.id,
    operator: ticket.operator,
    legs,
    reason: body.reason ?? '旅客放弃接续，申请未履行区段退款',
    status: 'requested',
    amount: body.amount ?? null,
    currency: body.currency ?? 'CNY',
    requestKey: body.requestKey ?? body.idempotencyKey ?? null,
    createdAt: isoTime(body.at),
    progress: [{ status: 'requested', at: isoTime(body.at), by: body.actorId ?? passenger.id, note: body.reason ?? null }],
    releasedArrangementId: releasedArrangement?.id ?? null,
  };
  state.refundRequests.push(request);
  addEvent(state, { type: 'refund.requested', refundId: request.id, passengerId: passenger.id, legs });
  return { ok: true, refund: request, releasedArrangement };
}

export function decideRefund(state, refundId, body = {}, operatorContext = null) {
  const refund = findOrThrow(state.refundRequests, asId(refundId), '退款申请');
  if (operatorContext && refund.operator !== operatorContext) throw forbidden('原运营方只能处理本方票务退款');
  if (body.operatorId && refund.operator !== body.operatorId) throw forbidden('原运营方只能处理本方票务退款');
  const status = normalizeRefundStatus(body.status ?? body.action ?? body.decision);
  if (!['approved', 'rejected', 'processing', 'refunded'].includes(status)) throw badRequest('不支持的退款进度状态', { status });
  const at = isoTime(body.at);
  if (refund.status === status && body.note === undefined) return { idempotent: true, refund };
  refund.status = status;
  refund.progress.push({ status, at, by: body.actorId ?? operatorContext ?? body.operatorId ?? 'operator-a', note: body.note ?? null, reference: body.reference ?? null });
  if (status === 'refunded') refund.refundedAt = at;
  addEvent(state, { type: 'refund.updated', refundId: refund.id, status });
  return { ok: true, refund };
}

function normalizeRefundStatus(value) {
  const map = {
    approve: 'approved', approved: 'approved', 批准: 'approved', 同意: 'approved',
    reject: 'rejected', rejected: 'rejected', 拒绝: 'rejected',
    process: 'processing', processing: 'processing', 处理中: 'processing',
    refund: 'refunded', refunded: 'refunded', 已退款: 'refunded', 退款完成: 'refunded',
  };
  return map[value] ?? value;
}

export function openContingencyForMissingLocation() {}

export function latestUsableAllocation(state, passengerId) {
  let latest = null;
  for (const arrangement of state.arrangements) {
    const item = arrangement.passengers?.find(p => p.passengerId === passengerId);
    if (!item || ['released', 'cancelled', 'no_show'].includes(item.status)) continue;
    latest = { arrangement, item };
  }
  return latest;
}

export function hasBoardedContinuation(state, passengerId) {
  for (const arrangement of state.arrangements) {
    const item = arrangement.passengers?.find(p => p.passengerId === passengerId);
    if (item && ['boarded', 'arrived', 'handed_over'].includes(item.status)) return { arrangement, item };
  }
  return null;
}

export function passengerView(state, passengerId, query = {}) {
  const passenger = passengerById(state, passengerId);
  const ticket = ticketForPassenger(state, passenger);
  const fulfilledLegs = confirmedLegs(state, passenger.id, ticket.id);
  const refunds = state.refundRequests.filter(r => r.passengerId === passenger.id);
  const refundedLegs = [...new Set(refunds.filter(r => r.status === 'refunded').flatMap(r => r.legs))];
  const pendingRefundLegs = [...new Set(refunds.filter(r => ['requested', 'approved', 'processing'].includes(r.status)).flatMap(r => r.legs))];
  const unfulfilledLegs = ticket.legs.filter(l => !fulfilledLegs.includes(l));
  const active = activeAllocationForPassenger(state, passenger.id);
  const current = active ?? latestUsableAllocation(state, passenger.id);
  const situation = state.passengerStates[passenger.id] ?? { status: 'unknown', history: [] };
  const contingency = state.contingencies
    .filter(c => c.passengerIds.includes(passenger.id) && c.status !== 'resolved')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
  const partyIds = listPartyPassengerIds(state, passenger);
  let shouldGoTo = null;
  let responsible = {
    dispatchActorId: 'dispatch',
    current: null,
    role: null,
  };
  if (contingency) {
    shouldGoTo = contingency.newConfirmedLocationId ? {
      kind: 'confirmed-contingency-location', id: contingency.newConfirmedLocationId, confirmed: contingency.status === 'location_confirmed',
    } : { kind: 'pending_contingency_location', id: null, confirmed: false };
    if (contingency.temporaryResponsibleId) responsible = { current: contingency.temporaryResponsibleId, role: 'temporary-responsible', temporary: true };
  } else if (current) {
    const a = current.arrangement;
    if (current.item.status === 'handed_over' && current.item.handoverShelterId) {
      shouldGoTo = { kind: 'shelter', id: current.item.handoverShelterId, confirmed: true };
      responsible = { current: current.item.receivedBy ?? a.responsible?.shelterActorId, role: 'shelter-receiver' };
    } else if (a.shelterId) {
      shouldGoTo = { kind: 'shelter', id: a.shelterId, confirmed: ['confirmed', 'boarded', 'departed', 'arrived'].includes(a.status) };
      responsible = {
        current: current.item.status === 'boarded' || a.status === 'departed' ? (a.responsible?.vehicleActorId ?? a.responsible?.pickupActorId) : a.responsible?.dispatchActorId,
        role: current.item.status === 'boarded' ? 'vehicle/pickup' : 'dispatch',
      };
    } else if (a.toLocationId) {
      shouldGoTo = { kind: 'destination', id: a.toLocationId, confirmed: ['confirmed', 'boarded', 'departed', 'arrived'].includes(a.status) };
      responsible = { current: a.responsible?.vehicleActorId ?? a.responsible?.dispatchActorId, role: 'vehicle/dispatch' };
    }
  } else if (situation.intention === 'shelter') {
    shouldGoTo = { kind: 'shelter', id: null, confirmed: false, note: '旅客选择先安置，但尚无确认安置位' };
  } else if (situation.intention === 'destination' || situation.intention === 'continue') {
    shouldGoTo = { kind: 'destination', id: ticket.destinationId ?? null, confirmed: false, note: '旅客希望继续到目的地，但尚无确认接续车' };
  }
  if (!responsible.current) {
    if (situation.status === 'on_original_vehicle') responsible = { current: 'original-vehicle-staff', role: 'original-carrier' };
    else responsible = { current: 'dispatch', role: 'dispatch' };
  }
  const currentWhereabouts = {
    locationId: situation.currentLocationId ?? current?.arrangement.fromLocationId ?? null,
    status: situation.status,
    at: situation.history?.at?.(-1)?.at ?? null,
    onOriginalVehicle: situation.onOriginalVehicle ?? null,
  };
  return {
    ...passenger,
    identityLinked: !!passenger.identityRef,
    ticket: {
      id: ticket.id,
      operator: ticket.operator,
      legs: ticket.legs,
      fulfilledLegs,
      unfulfilledLegs,
      refundableLegs: unfulfilledLegs.filter(l => !refundedLegs.includes(l) && !pendingRefundLegs.includes(l)),
      refundedLegs,
      pendingRefundLegs,
    },
    ticketId: ticket.id,
    companion: {
      partyId: passenger.party ?? null,
      passengerIds: partyIds,
      cannotSplitWithoutConsent: partyIds.length > 1,
    },
    situation,
    currentWhereabouts,
    shouldGoTo,
    responsible,
    arrangement: current ? {
      id: current.arrangement.id,
      status: current.arrangement.status,
      passengerStatus: current.item.status,
      vehicleId: current.arrangement.vehicleId,
      shelterId: current.arrangement.shelterId,
      dispatchState: current.arrangement.dispatchState,
    } : null,
    contingency: contingency ? {
      id: contingency.id, status: contingency.status, missing: contingency.missing,
      currentLocationId: contingency.currentLocationId,
      temporaryResponsibleId: contingency.temporaryResponsibleId,
      newConfirmedLocationId: contingency.newConfirmedLocationId,
    } : null,
    refunds: refunds.map(r => ({ id: r.id, status: r.status, legs: r.legs, progress: r.progress, operator: r.operator })),
    refundProgress: refunds.at(-1)?.progress ?? [],
    labelsZh: {
      passengerStatus: PASSENGER_STATUS_ZH[situation.status] ?? situation.status,
      nextPlace: shouldGoTo?.kind === 'shelter' ? '安置点' : shouldGoTo?.kind === 'destination' ? '目的地' : '待调度确认',
    },
  };
}

const PASSENGER_STATUS_ZH = {
  unknown: '状态待确认', on_original_vehicle: '仍在原车', off_original_vehicle: '已离开原车',
  reported: '已报到', unreachable: '失联/未到', sheltered: '已安置',
};

export function vehicleView(state, vehicleId) {
  const vehicle = vehicleById(state, vehicleId);
  const counts = reservationCounts(state, 'vehicle', vehicle.id);
  const arrangements = state.arrangements.filter(a => a.vehicleId === vehicle.id && a.kind !== 'proposal');
  const passengerIds = [...new Set(state.reservations.filter(r => r.resourceType === 'vehicle' && r.resourceId === vehicle.id).map(r => r.passengerId))];
  return {
    ...vehicle,
    counts: {
      committed: counts.committed,
      reserved: counts.rows.filter(r => r.status === 'held').length,
      boarded: counts.boarded,
      arrived: counts.arrived,
      activeOccupancy: counts.active,
      ordinaryCommitted: counts.ordinaryCommitted,
      wheelchairCommitted: counts.wheelchairCommitted,
      noShow: counts.rows.filter(r => r.status === 'no_show').length,
      released: counts.rows.filter(r => r.status === 'released' || r.status === 'expired').length,
    },
    capacityCheck: {
      seats: vehicle.seats,
      wheelchairSlots: vehicle.wheelchairSlots,
      availableSeats: Math.max(0, (vehicle.seats ?? 0) - counts.rows.filter(r => VEHICLE_ACTIVE.has(r.status) && r.kind === 'ordinary').length),
      availableWheelchairSlots: Math.max(0, (vehicle.wheelchairSlots ?? 0) - counts.rows.filter(r => VEHICLE_ACTIVE.has(r.status) && r.kind === 'wheelchair').length),
    },
    passengerIds,
    arrangements: arrangements.map(a => ({ id: a.id, status: a.status, dispatchState: a.dispatchState, passengerIds: a.passengerIds, departureAt: a.departureAt })),
  };
}
const VEHICLE_ACTIVE = new Set(['held', 'boarded']);

export function carrierManifest(state, carrierId, vehicleId) {
  const view = vehicleView(state, vehicleId);
  if (carrierId && view.operator !== carrierId) throw forbidden('接续承运人只能查看本车执行运输所需乘客范围', { vehicleId, operator: view.operator, carrierId });
  const passengers = [];
  for (const arrangement of state.arrangements.filter(a => a.vehicleId === vehicleId)) {
    for (const item of arrangement.passengers) {
      if (['released', 'no_show'].includes(item.status)) continue;
      const p = state.passengers.find(x => x.id === item.passengerId);
      passengers.push({
        passengerId: item.passengerId,
        dispatchNo: item.dispatchNo ?? `${arrangement.id}-${item.passengerId}`,
        seatKind: item.kind,
        needs: item.needs ?? p?.needs ?? [],
        pickupLocationId: arrangement.fromLocationId,
        companionGroup: arrangement.passengerIds.length > 1 ? arrangement.id : null,
        status: item.status,
      });
    }
  }
  return { carrierId, vehicleId, operator: view.operator, passengers };
}

export function shelterView(state, shelterId) {
  const shelter = shelterById(state, shelterId);
  const counts = reservationCounts(state, 'shelter', shelter.id);
  return {
    ...shelter,
    accepting: shelter.accepting ?? true,
    counts: {
      committed: counts.committed,
      reserved: counts.rows.filter(r => r.status === 'held').length,
      arrived: counts.arrived,
      occupied: counts.rows.filter(r => r.status === 'occupied').length,
      accessibleCommitted: counts.accessibleCommitted,
      noShow: counts.rows.filter(r => r.status === 'no_show').length,
      releasedOrExpired: counts.rows.filter(r => ['released', 'expired'].includes(r.status)).length,
    },
    capacityCheck: {
      capacity: shelter.capacity,
      accessibleBeds: shelter.accessibleBeds,
      availablePlaces: Math.max(0, (shelter.capacity ?? 0) - counts.committed),
      availableAccessibleBeds: Math.max(0, (shelter.accessibleBeds ?? 0) - counts.accessibleCommitted),
    },
    handovers: state.handovers.filter(h => h.shelterId === shelter.id).map(h => ({ id: h.id, at: h.at, passengerIds: h.passengerIds, receivedBy: h.receivedBy })),
  };
}

export function operatorView(state, operatorId) {
  const tickets = state.tickets.filter(t => t.operator === operatorId);
  const ticketIds = new Set(tickets.map(t => t.id));
  const passengers = state.passengers.filter(p => ticketIds.has(p.ticket));
  const passengerIds = new Set(passengers.map(p => p.id));
  return {
    operatorId,
    tickets,
    passengers: passengers.map(p => ({ id: p.id, ticket: p.ticket, identityRef: p.identityRef ? '已关联（脱敏）' : null })),
    refunds: state.refundRequests.filter(r => r.operator === operatorId || passengerIds.has(r.passengerId)),
  };
}
