# 旅客接续与安置处置 HTTP API

本服务只使用 `fixtures/records.json` 中的合成机构、旅客、票据和设施资料。所有“人员”均为虚构，不包含真实出行人员资料。

- 业务服务默认端口：`4318`
- 默认持久文件：`.local/dispatch.json`
- 可用环境变量：`DISPATCH_PORT`、`PORT`、`DISPATCH_STATE`、`STATE_FILE`、`CARRIER_URL` / `PARTNER_URL`
- 合作方承运台仍默认在 `4317`，协议见 [partner.md](./partner.md)
- `npm run start:all` 会同时启动业务服务与合作方替身，并把业务服务指向 `http://127.0.0.1:4317`

所有写操作均以单个 Node 进程内的串行事务提交；失败的业务校验不会半写入状态。状态文件采用临时文件加重命名，服务重启后继续保留。多个站点对同一服务进程并发请求时，容量检查和预留写入不会交叉超占。

## 核心边界

以下事实不能互相替代：

1. `POST /plans` 只给出按当前道路信息可核验的推荐线路，不占座、不占安置位。
2. `POST /arrangements` 才会原子锁定同行关系、车辆座位/轮椅位、安置床位/无障碍床位及预留期限。
3. `POST /arrangements/:id/dispatch` 只表示向承运人发出派车要求；`accepted` 也只是承运合作方受理，不是最终执行。
4. 承运回执超时、断连或 pending 时，派车状态为 `unknown` / `awaiting_receipt`，同一旅客不能改派另一辆车。
5. 只有明确确认“原车/原派车不再执行”后，才能调用 `/release` 释放并重新安排。
6. 晚到的旧回执如果指向已释放安排，或旅客已有更新的有效安排，只留档为 `STALE_DISPATCH_RECEIPT`，不覆盖新安排。
7. 实际报到、上车、发车、到达、到站移交必须分别由责任人确认；重复 `rosterKey` 或重复旅客名单不会增加人数。
8. 失联/未到必须显式登记为 `no-show` / `unreachable`，不会自动变成已安置。

## 常用接口

路径可带或不带 `/api` 前缀，也兼容 `/api/v1`；资源名单复数和常见英文别名均可。

### 接收班次和旅客状态

```http
POST /api/services
Content-Type: application/json

{
  "id": "SVC-001",
  "currentLocationId": "STOP-A",
  "destinationId": "DEST",
  "passengerIds": ["PA-1", "PA-2", "PA-3"]
}
```

也可在 `passengers` 中提交新的合成旅客对象；如带 `ticket` 对象或 `ticketId + legs`，会建立对应合成原票。

确认旅客是否仍在原车、当前位置和意向：

```http
POST /api/passengers/PA-3/confirm

{
  "onOriginalVehicle": false,
  "currentLocationId": "STOP-A",
  "intention": "shelter",
  "actorId": "station-a"
}
```

`intention` 支持 `continue` / `destination`（继续到目的地）和 `shelter`（先安置），也可提交中文状态字段。

### 道路与限行

发布定向、分车型、有有效时间的限行：

```http
POST /api/roads/R-3/restrictions

{
  "id": "CLOSE-R3",
  "vehicleTypes": ["coach"],
  "start": "2026-11-27T12:00:00Z",
  "end": "2026-11-27T18:00:00Z",
  "reason": "合成降雪管控"
}
```

`fixtures/records.json` 中的 `restrictionInputs`（例如 `CLOSE-1`）只是演练/预警输入，不会自动发布；需调用 `POST /api/restriction-inputs/CLOSE-1/publish` 或直接发布一条新限行后才参与路线核验。

解除指定限行：

```http
POST /api/restrictions/CLOSE-R3/lift
{ "actorId": "dispatch" }
```

只解除该限制记录对应的路段、方向和车型；反向路段（例如 `R-2` 相对于 `R-1`）和相邻路段（例如 `R-3`）不会被推断为开通。

查询某时刻某车型是否可走：

```http
GET /api/roads/R-1?at=2026-11-27T10:30:00Z&vehicleType=coach
```

路线按 `roadIds` 的顺序和 `roads[].from -> roads[].to` 的方向核验，并按路段 `minutes` 推算通行区间是否与限行时间重叠。

### 方案与接续安排

推荐方案：

```http
POST /api/plans

{
  "passengerIds": ["PA-1", "PA-2"],
  "vehicleId": "BUS-A",
  "shelterId": "SHELTER-A",
  "roadIds": ["R-1"],
  "departureAt": "2026-11-27T08:00:00Z"
}
```

可执行安排：

```http
POST /api/arrangements

{
  "id": "ARR-0001",
  "passengerIds": ["PA-1", "PA-2"],
  "vehicleId": "BUS-A",
  "shelterId": "SHELTER-A",
  "roadIds": ["R-1"],
  "departureAt": "2026-11-27T08:00:00Z",
  "ttlMinutes": 30
}
```

安排创建时会原子检查：

- 同行组是否全部安排，或是否存在旅客/有权监护人的拆分同意；
- 旅客是否已被未结束安排或未明派车锁定；
- 普通座位、轮椅位、安置点总容量、无障碍床位；
- 特殊接送条件是否被车辆能力覆盖；
- 路线在预定通行时间是否可执行；
- 预计到达是否早于安置点 `lastArrival`；
- 安置点是否当前接收。

预留可用 `expiresAt` 或 `ttlMinutes/holdMinutes` 指定期限。到期预留会在下次容量事务中惰性释放；旅客派车锁定不会因容量预留到期而被猜测为“无派车”。

### 派车、未明回执和重排

```http
POST /api/arrangements/ARR-0001/dispatch
```

未配置 `CARRIER_URL` 时，服务登记为人工回执模式。配置 `CARRIER_URL=http://127.0.0.1:4317` 后，会按合作方协议发送 `Dispatch-Key` 和逐项 `dispatchNo`；超时、断连会持久化为 `unknown`。

人工或外部回执：

```http
POST /api/dispatch-requests/DSP-0001/receipt
{ "status": "confirmed", "details": { "reference": "SYN-1" } }
```

状态支持 `accepted`、`pending`、`confirmed`、`rejected`、`returned`、`unknown` 及其中文别名。

轮询外部合作方：

```http
POST /api/dispatch-requests/DSP-0001/poll
```

确认原派车不再执行后释放：

```http
POST /api/arrangements/ARR-0001/release

{
  "originalVehicleWillRun": false,
  "confirmedBy": "dispatch",
  "reason": "承运方确认原车不再执行"
}
```

### 报到、上车、发车、到达和移交

```http
POST /api/arrangements/ARR-0001/check-in
{ "actorId": "station-a", "rosterKey": "station-roster-1" }

POST /api/arrangements/ARR-0001/board
{ "actorId": "driver-a", "rosterKey": "bus-roster-1" }

POST /api/arrangements/ARR-0001/depart
{ "at": "2026-11-27T08:00:00Z", "actorId": "driver-a" }

POST /api/arrangements/ARR-0001/arrive
{ "actorId": "driver-a" }

POST /api/arrangements/ARR-0001/handover
{ "receivedBy": "shelter-a", "actorId": "escort-a", "rosterKey": "handover-1" }
```

`depart` 会在实际发车时刻再次复核道路。若路线已封闭/限行，返回 `409 ROUTE_NOT_EXECUTABLE_AT_DEPARTURE`，阻止发车并生成 `contingency`。

重复提交相同 `rosterKey` 或重复旅客名单会返回 `duplicate: true`，不会增加报到、上车或移交人数。

未到/失联：

```http
POST /api/arrangements/ARR-0001/no-show
{ "actorId": "station-a", "reason": "多次呼叫无应答" }
```

### 安置点停收和在途接续

```http
POST /api/shelters/SHELTER-A/acceptance

{
  "accepting": false,
  "reason": "合成设施故障",
  "temporaryResponsibleId": "escort-li",
  "currentLocationId": "STOP-A"
}
```

服务会为已有承诺但尚未完成移交的安排生成 `contingencies`。必须补齐三项：

```http
POST /api/contingencies/CONT-0001/confirm-location

{
  "currentLocationId": "STOP-A",
  "temporaryResponsibleId": "escort-li",
  "newConfirmedLocationId": "SHELTER-B"
}
```

在三项未明确前，旅客查询会显示待确认地点和临时责任人，不会显示为已安置。

### 旅客、车辆和安置点核查

```http
GET /api/passengers/PA-1
GET /api/vehicles/BUS-A
GET /api/shelters/SHELTER-A
```

旅客视图包含：

- `currentWhereabouts`：当前位置和状态；
- `shouldGoTo`：目的地/安置点/接续临时确认地点；
- `responsible`：当前责任人及角色；
- `ticket.fulfilledLegs` / `unfulfilledLegs` / `refundableLegs`；
- `refunds` 和 `refundProgress`；
- `companion`：同行组及拆分同意要求；
- `arrangement`、`contingency`。

车辆视图的 `counts.committed` 是已承诺人次，`counts.arrived` 是实际随车到达/完成移交人次；另返回普通座和轮椅位的可用量。安置点视图的 `counts.committed` 包含有效预留和已入住，`counts.arrived` 是实际移交入住人数，`accessibleCommitted` 单独核查无障碍床位。

### 票段履行和退款

确认原运营方票段已履行：

```http
POST /api/tickets/TK-1/legs/S1/fulfill

{
  "passengerIds": ["PA-1", "PA-2"],
  "operatorId": "OP-A",
  "actorId": "operator-a"
}
```

申请全部未履行区段退款：

```http
POST /api/passengers/PA-1/refunds
{ "allUnfulfilled": true }
```

也可传 `legs: ["S2"]`。已履行票段返回 `LEG_FULFILLED_NOT_REFUNDABLE`，已退款或处理中的票段不会重复生成退款。

若请求带 `abandonContinuation: true`，未上车时会释放接续预留；已经上车、到达或移交后返回 `ALREADY_BOARDED`，不能借放弃申请再占一座。不带放弃接续的“仅退款进度”申请仍可处理未履行原票段。

运营方范围：

```http
GET  /api/operators/OP-A/refunds
POST /api/operators/OP-A/refunds/RF-0001/approve
POST /api/refunds/RF-0001/refund
```

`OP-B` 处理 `OP-A` 票务会得到 `403`。

### 接续承运人最小名册

```http
GET /api/carriers/OP-B/vehicles/BUS-A/manifest
```

只返回旅客合成 ID、逐项派车号、座位类型、特殊需求、上车点和同行组，不返回原票号、身份关联或退款进度。错误的承运人访问本车名册返回 `403`。

## 来源变更

`fixtures/records.json` 的 `sourceChanges` 仍是未自动批准的来源资料。可显式应用：

```http
POST /api/source-changes/RESTRICTION-2/apply
POST /api/source-changes/S1-FULFILLED/apply
POST /api/source-changes/SHELTER-STOP/apply
POST /api/source-changes/WISH-1/apply
```

`PARTY-REQUEST` 中 `splitConsent: false` 只会留档；`false` 不构成拆分同意。
