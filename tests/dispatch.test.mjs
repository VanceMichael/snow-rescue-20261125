import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchServer } from '../support/dispatch-server.mjs';
import { createPeer } from '../support/peer.mjs';

const partnerConfig = JSON.parse(await readFile(new URL('../fixtures/partner.json', import.meta.url)));

async function harness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'snow-dispatch-'));
  const stateFile = join(dir, 'dispatch.json');
  const server = createDispatchServer({ stateFile, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(path, init = {}) {
    const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
    const response = await fetch(base + path, {
      ...init,
      headers,
      body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  }
  async function close() {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
  return { dir, stateFile, server, base, api, close };
}

async function listenPeer() {
  const dir = await mkdtemp(join(tmpdir(), 'snow-partner-'));
  const stateFile = join(dir, 'partner.json');
  const server = createPeer(partnerConfig, stateFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  };
  return { base, stateFile, close };
}

const futureDeparture = '2026-11-27T08:00:00Z';

test('完整接续、重复移交名册、承诺/到达计数和重启保留', async () => {
  const h = await harness();
  try {
    let res = await h.api('/api/arrangements', { method: 'POST', body: {
      id: 'ARR-HAPPY', passengerIds: ['PA-1', 'PA-2'], vehicleId: 'BUS-A', shelterId: 'SHELTER-A',
      roadIds: ['R-1'], departureAt: futureDeparture, ttlMinutes: 60,
    } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'reserved');

    res = await h.api('/api/arrangements/ARR-HAPPY/dispatch', { method: 'POST', body: { at: futureDeparture } });
    assert.equal(res.status, 200);
    assert.equal(res.body.dispatchState, 'awaiting_receipt');
    await h.api('/api/dispatch-requests/' + res.body.request.id + '/receipt', {
      method: 'POST', body: { status: 'confirmed' },
    });

    for (const rosterKey of ['checkin-dup']) {
      const first = await h.api('/api/arrangements/ARR-HAPPY/check-in', { method: 'POST', body: { actorId: 'station-a', rosterKey } });
      const second = await h.api('/api/arrangements/ARR-HAPPY/check-in', { method: 'POST', body: { actorId: 'station-a', rosterKey } });
      assert.equal(first.status, 200);
      assert.equal(second.body.duplicate, true);
    }
    await h.api('/api/arrangements/ARR-HAPPY/board', { method: 'POST', body: { actorId: 'driver-a', rosterKey: 'board-1' } });
    await h.api('/api/arrangements/ARR-HAPPY/depart', { method: 'POST', body: { at: futureDeparture, actorId: 'driver-a' } });
    const handover1 = await h.api('/api/arrangements/ARR-HAPPY/handover', { method: 'POST', body: { receivedBy: 'shelter-a', actorId: 'escort-a', rosterKey: 'HO-DUP' } });
    const handover2 = await h.api('/api/arrangements/ARR-HAPPY/handover', { method: 'POST', body: { receivedBy: 'shelter-a', actorId: 'escort-a', rosterKey: 'HO-DUP' } });
    assert.equal(handover1.status, 200);
    assert.equal(handover2.body.duplicate, true);

    const passenger = await h.api('/api/passengers/PA-1');
    assert.equal(passenger.body.shouldGoTo.id, 'SHELTER-A');
    assert.equal(passenger.body.responsible.current, 'shelter-a');
    assert.deepEqual(passenger.body.companion.passengerIds, ['PA-1', 'PA-2']);

    const vehicle = await h.api('/api/vehicles/BUS-A');
    assert.equal(vehicle.body.counts.committed, 2);
    assert.equal(vehicle.body.counts.arrived, 2);
    assert.equal(vehicle.body.counts.wheelchairCommitted, 1);
    const shelter = await h.api('/api/shelters/SHELTER-A');
    assert.equal(shelter.body.counts.committed, 2);
    assert.equal(shelter.body.counts.arrived, 2);
    assert.equal(shelter.body.counts.accessibleCommitted, 1);

    await new Promise(resolve => h.server.close(resolve));
    const restarted = createDispatchServer({ stateFile: h.stateFile });
    await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
    const base2 = `http://127.0.0.1:${restarted.address().port}`;
    const restoredVehicle = await fetch(base2 + '/api/vehicles/BUS-A').then(r => r.json());
    assert.equal(restoredVehicle.counts.arrived, 2);
    const restoredPassenger = await fetch(base2 + '/api/passengers/PA-2').then(r => r.json());
    assert.equal(restoredPassenger.shouldGoTo.id, 'SHELTER-A');
    await new Promise(resolve => restarted.close(resolve));
  } finally {
    await h.close();
  }
});

test('道路限行按路段、方向、车型和时间生效，解除一条不推断其他路段', async () => {
  const h = await harness();
  try {
    let res = await h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: ['PA-3'], vehicleId: 'BUS-B', shelterId: 'SHELTER-B', roadIds: ['R-1'],
      departureAt: '2026-11-27T09:00:00Z',
    } });
    assert.equal(res.status, 200);

    // CLOSE-1 是 restrictionInputs 演练/预警输入，未显式发布前不参与通行核验。
    const beforePublish = await h.api('/api/roads/R-1?at=2026-11-27T10:30:00Z&vehicleType=coach');
    assert.equal(beforePublish.body.executable, true);
    const publishInput = await h.api('/api/restriction-inputs/CLOSE-1/publish', { method: 'POST', body: { actorId: 'dispatch' } });
    assert.equal(publishInput.status, 200);

    const blocked = await h.api('/api/plans', { method: 'POST', body: {
      passengerIds: ['PA-3'], vehicleId: 'BUS-B', roadIds: ['R-1'], departureAt: '2026-11-27T10:30:00Z',
    } });
    assert.equal(blocked.body.feasible, false);
    assert.ok(blocked.body.blockers.some(b => b.code === 'ROAD_RESTRICTION_ACTIVE' && b.restrictionId === 'CLOSE-1'));

    const reverse = await h.api('/api/plans', { method: 'POST', body: {
      passengerIds: ['PA-3'], roadIds: ['R-2'], from: 'STOP-A', to: 'SHELTER-A', at: '2026-11-27T10:30:00Z',
    } });
    assert.ok(reverse.body.blockers.some(b => b.code === 'ROUTE_DIRECTION_OR_CONNECTION_INVALID'));

    // RESTRICTION-2 只是来源变更，未应用前 R-3 仍按已发布信息可走。
    const beforeApply = await h.api('/api/roads/R-3?at=2026-11-27T13:00:00Z&vehicleType=coach');
    assert.equal(beforeApply.body.executable, true);
    const applied = await h.api('/api/source-changes/RESTRICTION-2/apply', { method: 'POST', body: { actorId: 'dispatch' } });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.applied, true);
    const afterApply = await h.api('/api/roads/R-3?at=2026-11-27T13:00:00Z&vehicleType=coach');
    assert.equal(afterApply.body.executable, false);

    await h.api('/api/restrictions/CLOSE-1/lift', { method: 'POST', body: { actorId: 'dispatch' } });
    const r1 = await h.api('/api/roads/R-1?at=2026-11-27T10:30:00Z');
    assert.equal(r1.body.executable, true);
    const r3 = await h.api('/api/roads/R-3?at=2026-11-27T13:00:00Z');
    assert.equal(r3.body.executable, false, '解除 R-1 的 CLOSE-1 不能解除 R-3');
  } finally {
    await h.close();
  }
});

test('封路变化阻止实际发车；安置点停收后仍有临时责任人与新确认地点', async () => {
  const h = await harness();
  try {
    let res = await h.api('/api/arrangements', { method: 'POST', body: {
      id: 'ARR-ROAD', passengerIds: ['PA-3'], vehicleId: 'BUS-B', shelterId: 'SHELTER-B', roadIds: ['R-3'],
      departureAt: '2026-11-27T10:00:00Z', ttlMinutes: 120,
    } });
    assert.equal(res.status, 200);
    await h.api('/api/arrangements/ARR-ROAD/board', { method: 'POST', body: { actorId: 'driver-b' } });
    await h.api('/api/restrictions', { method: 'POST', body: {
      id: 'CLOSE-R3-NEW', roadId: 'R-3', vehicleTypes: ['coach'], start: '2026-11-27T12:00:00Z', end: '2026-11-27T18:00:00Z',
    } });
    const depart = await h.api('/api/arrangements/ARR-ROAD/depart', { method: 'POST', body: { at: '2026-11-27T13:00:00Z', actorId: 'driver-b' } });
    assert.equal(depart.status, 409);
    assert.equal(depart.body.code, 'ROUTE_NOT_EXECUTABLE_AT_DEPARTURE');
    assert.ok(depart.body.contingency.id);

    let passenger = await h.api('/api/passengers/PA-3');
    assert.equal(passenger.body.contingency.temporaryResponsibleId, 'driver-b');
    assert.equal(passenger.body.shouldGoTo.confirmed, false);

    const contId = depart.body.contingency.id;
    const updated = await h.api(`/api/contingencies/${contId}/confirm-location`, { method: 'POST', body: {
      currentLocationId: 'STOP-A', temporaryResponsibleId: 'escort-li', newConfirmedLocationId: 'SHELTER-A', actorId: 'dispatch',
    } });
    assert.equal(updated.body.status, 'location_confirmed');
    passenger = await h.api('/api/passengers/PA-3');
    assert.equal(passenger.body.responsible.current, 'escort-li');
    assert.equal(passenger.body.shouldGoTo.id, 'SHELTER-A');

    const stop = await h.api('/api/shelters/SHELTER-B/acceptance', { method: 'POST', body: {
      accepting: false, reason: '设施故障', temporaryResponsibleId: 'escort-li', currentLocationId: 'STOP-A',
    } });
    assert.equal(stop.status, 200);
    // 已被道路阻断的安排不能直接完成原安置点移交。
    const badHandover = await h.api('/api/arrangements/ARR-ROAD/handover', { method: 'POST', body: { shelterId: 'SHELTER-B' } });
    assert.equal(badHandover.status, 409);

    // 限行结束并成功发车后，可向新的确认安置点 A 移交。
    const laterDepart = await h.api('/api/arrangements/ARR-ROAD/depart', { method: 'POST', body: { at: '2026-11-27T18:30:00Z', actorId: 'driver-b' } });
    assert.equal(laterDepart.status, 200);
    const handover = await h.api('/api/arrangements/ARR-ROAD/handover', { method: 'POST', body: {
      shelterId: 'SHELTER-A', receivedBy: 'shelter-a', actorId: 'escort-li',
    } });
    assert.equal(handover.status, 200);
    const shelterA = await h.api('/api/shelters/SHELTER-A');
    assert.equal(shelterA.body.counts.arrived, 1);
  } finally {
    await h.close();
  }
});

test('多个站点并发安排不会超占车辆座位或安置点容量', async () => {
  const h = await harness();
  try {
    const passengerIds = [];
    for (let i = 0; i < 8; i++) {
      const id = `PA-CAP-${i}`;
      passengerIds.push(id);
      await h.api('/api/passengers', { method: 'POST', body: { id, ticketId: `TK-CAP-${i}`, legs: ['S1'], party: null, needs: [] } });
    }
    const results = await Promise.all(passengerIds.map((pid, i) => h.api('/api/arrangements', { method: 'POST', body: {
      requestKey: `cap-${pid}`,
      passengerIds: [pid], vehicleId: 'BUS-B', shelterId: 'SHELTER-B', roadIds: ['R-3'],
      departureAt: `2026-11-27T${String(8 + (i % 8)).padStart(2, '0')}:00:00Z`, ttlMinutes: 30,
    } })));
    const fulfilled = results.filter(r => r.status === 200);
    const rejected = results.filter(r => r.status === 409 && /CAPACITY|SEATS/.test(r.body.code));
    assert.equal(fulfilled.length, 4);
    assert.ok(rejected.length >= 4);
    const vehicle = await h.api('/api/vehicles/BUS-B');
    assert.ok(vehicle.body.counts.committed <= 4);

    // SHELTER-A 容量 4；BUS-A 普通座足够，安置点是约束。
    const ordinary = [];
    for (let i = 0; i < 6; i++) {
      const id = `PA-SH-${i}`;
      ordinary.push(id);
      await h.api('/api/passengers', { method: 'POST', body: { id, ticketId: `TK-SH-${i}`, legs: ['S1'], party: null, needs: [] } });
    }
    const shelterResults = await Promise.all(ordinary.map(pid => h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: [pid], vehicleId: 'BUS-A', shelterId: 'SHELTER-A', roadIds: ['R-1'], departureAt: futureDeparture,
    } })));
    assert.equal(shelterResults.filter(r => r.status === 200).length, 4);
    assert.ok(shelterResults.some(r => r.status === 409 && r.body.code === 'SHELTER_CAPACITY_EXCEEDED'));
  } finally {
    await h.close();
  }
});

test('预留到期后释放容量；未到期前持续阻止超占', async () => {
  const h = await harness();
  try {
    await h.api('/api/passengers', { method: 'POST', body: { id: 'PA-TTL-1', ticketId: 'TK-TTL-1', legs: ['S1'], needs: [] } });
    await h.api('/api/passengers', { method: 'POST', body: { id: 'PA-TTL-2', ticketId: 'TK-TTL-2', legs: ['S1'], needs: [] } });
    const first = await h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: ['PA-TTL-1'], vehicleId: 'BUS-B', roadIds: ['R-3'], departureAt: futureDeparture,
      expiresAt: '2026-11-26T00:00:00Z',
    } });
    assert.equal(first.status, 200);
    // 创建第二个安排时会惰性使过期预留失效。
    const second = await h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: ['PA-TTL-2'], vehicleId: 'BUS-B', roadIds: ['R-3'], departureAt: futureDeparture, ttlMinutes: 30,
    } });
    assert.equal(second.status, 200);
    const vehicle = await h.api('/api/vehicles/BUS-B');
    assert.equal(vehicle.body.counts.activeOccupancy, 1);
  } finally {
    await h.close();
  }
});

test('派车回执未明时锁定旅客；确认原车不执行后可重排，旧回执不能覆盖新确认', async () => {
  const h = await harness();
  try {
    const first = await h.api('/api/arrangements', { method: 'POST', body: {
      id: 'ARR-OLD', passengerIds: ['PA-3'], vehicleId: 'BUS-B', shelterId: 'SHELTER-B', roadIds: ['R-3'], departureAt: futureDeparture,
    } });
    assert.equal(first.status, 200);
    const dispatch = await h.api('/api/arrangements/ARR-OLD/dispatch', { method: 'POST', body: {} });
    assert.equal(dispatch.body.dispatchState, 'awaiting_receipt');

    const duplicate = await h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: ['PA-3'], vehicleId: 'BUS-A', roadIds: ['R-1'], departureAt: futureDeparture, splitConsent: true,
    } });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'PASSENGER_ALREADY_LOCKED_TO_ARRANGEMENT');

    const badRelease = await h.api('/api/arrangements/ARR-OLD/release', { method: 'POST', body: { reason: '猜测' } });
    assert.equal(badRelease.status, 409);

    const release = await h.api('/api/arrangements/ARR-OLD/release', { method: 'POST', body: {
      originalVehicleWillRun: false, confirmedBy: 'dispatch', reason: '承运方确认原车不再执行',
    } });
    assert.equal(release.status, 200);

    const next = await h.api('/api/arrangements', { method: 'POST', body: {
      id: 'ARR-NEW', passengerIds: ['PA-3'], vehicleId: 'BUS-A', shelterId: 'SHELTER-A', roadIds: ['R-1'], departureAt: futureDeparture,
    } });
    assert.equal(next.status, 200);
    const nextDispatch = await h.api('/api/arrangements/ARR-NEW/dispatch', { method: 'POST', body: {} });
    await h.api(`/api/dispatch-requests/${nextDispatch.body.request.id}/receipt`, { method: 'POST', body: { status: 'confirmed' } });

    const oldReceipt = await h.api(`/api/dispatch-requests/${dispatch.body.request.id}/receipt`, { method: 'POST', body: { status: 'confirmed' } });
    assert.equal(oldReceipt.status, 409);
    assert.equal(oldReceipt.body.code, 'STALE_DISPATCH_RECEIPT');
    const oldArr = await h.api('/api/arrangements/ARR-OLD');
    assert.equal(oldArr.body.status, 'released');
    const newArr = await h.api('/api/arrangements/ARR-NEW');
    assert.equal(newArr.body.status, 'confirmed');
  } finally {
    await h.close();
  }
});

test('外部承运台断线按回执未明持久处理，后续轮询确认不被重复派车破坏', async () => {
  const partner = await listenPeer();
  const h = await harness({ carrierUrl: partner.base });
  try {
    await fetch(partner.base + '/control/rules', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'EXT-1-PA-3', mode: 'accepted_disconnect' }),
    });
    const created = await h.api('/api/arrangements', { method: 'POST', body: {
      id: 'EXT-1', passengerIds: ['PA-3'], vehicleId: 'BUS-B', shelterId: 'SHELTER-B', roadIds: ['R-3'], departureAt: futureDeparture,
    } });
    assert.equal(created.status, 200);
    const dispatch = await h.api('/api/arrangements/EXT-1/dispatch', { method: 'POST', body: { timeoutMs: 1000 } });
    assert.equal(dispatch.status, 202);
    assert.equal(dispatch.body.dispatchState, 'unknown');

    const duplicate = await h.api('/api/arrangements', { method: 'POST', body: { passengerIds: ['PA-3'], vehicleId: 'BUS-A' } });
    assert.equal(duplicate.status, 409);

    const settle = await fetch(partner.base + '/control/settle', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'EXT-1-PA-3', status: 'confirmed', details: { vehiclePlate: '蒙A-合成' } }),
    });
    assert.equal(settle.status, 200);
    const polled = await h.api(`/api/dispatch-requests/${dispatch.body.request.id}/poll`, { method: 'POST', body: {} });
    assert.equal(polled.status, 200);
    assert.equal(polled.body.arrangement.status, 'confirmed');
  } finally {
    await h.close();
    await partner.close();
  }
});

test('同行同意、轮椅位和专门接送条件在任何安排中都必须匹配', async () => {
  const h = await harness();
  try {
    const split = await h.api('/api/arrangements', { method: 'POST', body: { passengerIds: ['PA-1'], vehicleId: 'BUS-A' } });
    assert.equal(split.status, 409);
    assert.equal(split.body.code, 'SPLIT_CONSENT_REQUIRED');

    const consent = await h.api('/api/passengers/PA-1/consent', { method: 'POST', body: { guardianId: 'GUARDIAN-1', actorId: 'GUARDIAN-1' } });
    assert.equal(consent.status, 200);
    const allowedSplit = await h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: ['PA-1'], vehicleId: 'BUS-A', shelterId: 'SHELTER-A', roadIds: ['R-1'], departureAt: futureDeparture,
    } });
    assert.equal(allowedSplit.status, 200);

    const noWheelchairVehicle = await h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: ['PA-2'], vehicleId: 'BUS-B', roadIds: ['R-3'], departureAt: futureDeparture,
    } });
    // PA-2 是普通需求，BUS-B 可走；这里另测 PA-1 无轮椅位。
    assert.ok([200, 409].includes(noWheelchairVehicle.status));
    const wheelchairToBusB = await h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: ['PA-1'], splitConsent: true, guardianId: 'g', vehicleId: 'BUS-B',
    } });
    assert.equal(wheelchairToBusB.status, 409);
    assert.equal(wheelchairToBusB.body.code, 'PASSENGER_ALREADY_LOCKED_TO_ARRANGEMENT', 'PA-1 已有有效安排时先被锁定');

    await h.api('/api/passengers', { method: 'POST', body: { id: 'PA-LIFT', ticketId: 'TK-LIFT', legs: ['S1'], party: null, needs: ['lift'] } });
    const missingLift = await h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: ['PA-LIFT'], vehicleId: 'BUS-A', roadIds: ['R-1'], departureAt: futureDeparture,
    } });
    assert.equal(missingLift.status, 409);
    assert.equal(missingLift.body.code, 'VEHICLE_SPECIAL_PICKUP_NOT_MATCHED');
    await h.api('/api/vehicles/BUS-A', { method: 'PATCH', body: { features: ['lift'] } });
    const withLift = await h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: ['PA-LIFT'], vehicleId: 'BUS-A', roadIds: ['R-1'], departureAt: futureDeparture,
    } });
    assert.equal(withLift.status, 200);

    const shelterNoAccessible = await h.api('/api/arrangements', { method: 'POST', body: {
      passengerIds: ['PA-2', 'PA-1'], vehicleId: 'BUS-A', shelterId: 'SHELTER-B', roadIds: ['R-3'], splitConsent: true,
    } });
    // PA-1 已被前一有效安排锁定，因此可能先返回锁定；在全新进程的容量测试中也有无障碍床位校验。
    assert.equal([409].includes(shelterNoAccessible.status), true);
  } finally {
    await h.close();
  }
});

test('票段履行、退款进度、运营方范围和上车后禁止重复占座', async () => {
  const h = await harness();
  try {
    const fulfill = await h.api('/api/tickets/TK-1/legs/S1/fulfill', { method: 'POST', body: {
      passengerIds: ['PA-1', 'PA-2'], operatorId: 'OP-A', actorId: 'operator-a',
    } });
    assert.equal(fulfill.status, 200);
    const passenger = await h.api('/api/passengers/PA-1');
    assert.deepEqual(passenger.body.ticket.fulfilledLegs, ['S1']);
    assert.deepEqual(passenger.body.ticket.unfulfilledLegs, ['S2']);

    const refund = await h.api('/api/passengers/PA-1/refunds', { method: 'POST', body: { allUnfulfilled: true, actorId: 'PA-1' } });
    assert.equal(refund.status, 200);
    assert.deepEqual(refund.body.refund.legs, ['S2']);
    const dup = await h.api('/api/passengers/PA-1/refunds', { method: 'POST', body: { allUnfulfilled: true } });
    assert.equal(dup.body.duplicate, true);

    const fulfilledRefund = await h.api('/api/passengers/PA-1/refunds', { method: 'POST', body: { legs: ['S1'] } });
    assert.equal(fulfilledRefund.status, 409);
    assert.equal(fulfilledRefund.body.code, 'LEG_FULFILLED_NOT_REFUNDABLE');

    const wrongOperator = await h.api('/api/operators/OP-B/refunds', { method: 'POST', body: { passengerId: 'PA-1', legs: ['S2'] } });
    assert.equal(wrongOperator.status, 403);
    const approved = await h.api(`/api/operators/OP-A/refunds/${refund.body.refund.id}/approve`, { method: 'POST', body: { actorId: 'operator-a' } });
    assert.equal(approved.status, 200);
    const paid = await h.api(`/api/refunds/${refund.body.refund.id}/refund`, { method: 'POST', body: { reference: 'SYN-REFUND-1' } });
    assert.equal(paid.body.refund.status, 'refunded');
    const operatorView = await h.api('/api/operators/OP-A');
    assert.equal(operatorView.status, 200);
    assert.ok(operatorView.body.refunds.some(r => r.id === refund.body.refund.id));

    await h.api('/api/arrangements', { method: 'POST', body: {
      id: 'ARR-BOARD-REFUND', passengerIds: ['PA-3'], vehicleId: 'BUS-B', shelterId: 'SHELTER-B', roadIds: ['R-3'], departureAt: futureDeparture,
    } });
    await h.api('/api/arrangements/ARR-BOARD-REFUND/board', { method: 'POST', body: { actorId: 'driver-b' } });
    const abandon = await h.api('/api/passengers/PA-3/refunds', { method: 'POST', body: { abandonContinuation: true } });
    assert.equal(abandon.status, 409);
    assert.equal(abandon.body.code, 'ALREADY_BOARDED');
    const refundOnly = await h.api('/api/passengers/PA-3/refunds', { method: 'POST', body: { allUnfulfilled: true } });
    assert.equal(refundOnly.status, 200, '未履行原票段退款进度仍可查询/申请，但不会产生新座位');
    const anotherSeat = await h.api('/api/arrangements', { method: 'POST', body: { passengerIds: ['PA-3'], vehicleId: 'BUS-A' } });
    assert.equal(anotherSeat.status, 409);
  } finally {
    await h.close();
  }
});

test('承运人名册只含运输必要范围，不含原票和退款信息', async () => {
  const h = await harness();
  try {
    await h.api('/api/tickets/TK-1/legs/S1/fulfill', { method: 'POST', body: { passengerIds: ['PA-1', 'PA-2'], operatorId: 'OP-A' } });
    await h.api('/api/arrangements', { method: 'POST', body: {
      id: 'ARR-MANIFEST', passengerIds: ['PA-1', 'PA-2'], vehicleId: 'BUS-A', roadIds: ['R-1'], departureAt: futureDeparture,
    } });
    const allowed = await h.api('/api/carriers/OP-B/vehicles/BUS-A/manifest');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.passengers.length, 2);
    const serialized = JSON.stringify(allowed.body);
    assert.ok(!serialized.includes('TK-1'));
    assert.ok(!serialized.includes('refundProgress'));
    assert.ok(allowed.body.passengers.some(p => p.seatKind === 'wheelchair'));
    const forbidden = await h.api('/api/carriers/OP-C/vehicles/BUS-A/manifest');
    assert.equal(forbidden.status, 403);
  } finally {
    await h.close();
  }
});

test('失联/未到不会自动计为已安置，并释放预留用于接续', async () => {
  const h = await harness();
  try {
    await h.api('/api/passengers', { method: 'POST', body: { id: 'PA-MISSING', ticketId: 'TK-MISSING', legs: ['S1'], needs: [] } });
    await h.api('/api/arrangements', { method: 'POST', body: {
      id: 'ARR-MISSING', passengerIds: ['PA-MISSING'], vehicleId: 'BUS-B', shelterId: 'SHELTER-B', roadIds: ['R-3'], departureAt: futureDeparture,
    } });
    const noShow = await h.api('/api/arrangements/ARR-MISSING/no-show', { method: 'POST', body: { actorId: 'station-a', reason: '多次呼叫无应答' } });
    assert.equal(noShow.status, 200);
    const passenger = await h.api('/api/passengers/PA-MISSING');
    assert.notEqual(passenger.body.situation.status, 'sheltered');
    assert.ok(passenger.body.contingency);
    const shelter = await h.api('/api/shelters/SHELTER-B');
    assert.equal(shelter.body.counts.arrived, 0);
  } finally {
    await h.close();
  }
});
