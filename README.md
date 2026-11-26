# 冰雪封路后的旅客接续与安置移交

本仓库保存该业务的合成登记资料、原始变更资料，以及客运调度、站点、安置人员协同使用的本地 Node.js 后端和接续承运合作方协议服务。所有机构、人员、金额和文书均为虚构，不连接真实业务系统，也不使用真实出行人员资料。

## 运行环境

使用 Node.js 22.23.4。没有第三方 npm 依赖，`package-lock.json` 锁定当前依赖清单。

```bash
npm ci --ignore-scripts
npm run build
npm test
```

## 启动业务后端

```bash
npm start
# 或 npm run start:dispatch
```

业务服务默认监听 `4318` 端口：

- `GET /health`：存活检查
- `GET /api`：中文接口索引
- `GET /api/passengers/PA-1`：旅客当前应去哪里、谁负责、哪些票段已履行、退款进度
- `GET /api/vehicles/BUS-A`：车辆已承诺、已上车、实际到达人数和轮椅位能力
- `GET /api/shelters/SHELTER-A`：安置点已承诺、实际到达、无障碍床位和容量

可用环境变量：

```bash
DISPATCH_PORT=4318 \
DISPATCH_STATE=.local/dispatch.json \
CARRIER_URL=http://127.0.0.1:4317 \
npm start
```

完整 HTTP 操作和示例见 [docs/api.md](./docs/api.md)。业务状态默认写入 `.local/dispatch.json`，停止进程后用同一状态文件启动会保留全部处置、派车未明、退款和移交记录。

## 同时启动业务服务与合作方替身

```bash
npm run start:partner   # 终端一：4317
npm start               # 终端二：4318，并设置 CARRIER_URL
```

或：

```bash
npm run start:all
```

`start:all` 默认把业务服务指向 `http://127.0.0.1:4317`。合作方协议见 [docs/partner.md](./docs/partner.md)。

合作方也可单独运行：

```bash
PORT=4317 PARTNER_STATE=.local/partner.json npm run start:partner
```

## 本地检查

```bash
npm run build
npm test
```

测试使用临时状态目录和随机本地端口，覆盖：

- 定向、分车型、分时段道路限行，以及解除一条不限定反向/相邻路段；
- 同行拆分同意、轮椅位和专门接送条件匹配；
- 多请求并发下车辆和安置点不超占；
- 预留期限、派车回执未明锁定、确认原车不执行后释放；
- 外部合作方断线、持久 unknown、后续轮询确认和旧回执失效；
- 报到、上车、发车复核、到站移交、重复名册幂等；
- 安置点停收后的当前位置、临时责任人和新确认地点；
- 票段履行、未履行段退款、运营方数据范围和上车后禁止重复占座；
- 服务重启后的处置保留。

## Docker

当前 Dockerfile 默认启动合作方协议服务并暴露 `4317`：

```bash
docker build -t snow-rescue:local .
docker run --rm -p 4317:4317 snow-rescue:local
```

容器要保留状态时，将可写目录挂载到 `/app/.local`；该目录需允许容器 `node` 用户写入。需要在一个容器中同时运行业务服务与合作方时，可将启动命令改为 `npm run start:all`，并映射 `4317`、`4318`。

## 资料

`fixtures/records.json` 是业务原始资料，`sourceChanges` 保存后续收到的变更或申请，均没有自动导入成已批准决定。`fixtures/relations.json` 声明登记资料的关联字段，`docs/data.md` 解释计量和身份语义。`fixtures/partner.json` 定义合作方接口名称及字段；`support/peer.mjs` 提供合作方行为，`tests/partner.test.mjs` 检查该协议和资料关系。

业务核心代码：

- `support/dispatch-core.mjs`：状态初始化、持久化、道路/容量/同行等领域规则；
- `support/dispatch-ops.mjs`：班次、旅客确认、派车回执、检查点、安置异常、退款和视图；
- `support/dispatch-server.mjs`：HTTP 服务、串行事务和外部承运台适配；
- `tests/dispatch.test.mjs`：业务处置场景测试。
