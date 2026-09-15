---
title: Result-only Live Acceptance (opt-in)
docType: reference
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 operator 要在本地 PostgREST 实例上验收 Result-only Publication 全链路时
whenToUpdate:
  - 当 live acceptance 的环境变量、覆盖步骤、保留证据或重置方式变化时
checkPaths:
  - workflows/publication/live/**
related:
  - ../README.md
  - ../contracts/result-process-publication-transport.md
---

# Result-only Live Acceptance

这是一个**显式 opt-in 的 live 验收运行器**，不是单元测试、不是 mock，也**不包含在
`pnpm run prepush:gate` 中**。CLI 入口（`result-only-acceptance.mjs`）**不传入任何 `fetchImpl`**，因此真正执行的是生产
`globalThis.fetch` 与真实 `lib/result-process*.mjs` adapter；运行结果只来自 operator 提供的
真实 HTTP PostgREST 端点。

说明：`live-acceptance.mjs` 导出函数带一个 `fetchImpl` 参数，**仅为 guard 自测**留出离线注入
点。因此本项目**不声称**该模块"结构上无法被 mock"；可执行保证是：CLI 入口不注入、manifest
记录本次运行的 endpoint/host/port 供人工核对。

它**不会**启动、reset、迁移或 provision 任何数据库、Docker 或 Supabase。它只访问 operator
已经准备好的 loopback 实例。

## 与离线 mock 的区别

|           | 离线 suite                                         | live acceptance                                                          |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| transport | in-process mock，仅验证 wire shape 与 adapter 分支 | 真实 `fetch` + 真实 PostgREST                                            |
| 证据      | 合成响应                                           | 端点实际返回的 receipt/回读内容                                          |
| 覆盖      | adapter 分支                                       | 直插 120、字节级回读、幂等重试、typed conflict、RLS 隔离、真实 role 判定 |
| 执行      | `prepush:gate` 的一部分                            | 需要 operator 显式 opt-in 与本地实例                                     |

mock **不会**被改成看起来像 live 证明；它继续只覆盖 wire shape，也**不会**模拟
`result_publication_busy`（该错误码只在真实 `cmd_result_process_publish_v1` 的 actor-fence
竞争下产生，运行器以 typed 409 原样透出，不自动重试）。

## 前置条件

- 一个由 main provision 的**本地专用** PostgREST 实例，已应用 reviewed
  `20260915150000_result_process_publication.sql`。端点必须是 loopback **字面量**
  （`127.0.0.1` / `[::1]` / `localhost`）；共享/默认本地端口（54321、54322、55321、55322、
  56321、56322、57321、57322、58321、58322）一律拒绝。本任务的专用实例端口形如 `61321`
  或 `63321`。
- 一个**当前持有 live `data_product_manager` role** 的 actor JWT 与其 publishable key。
  这是唯一需要的 grant；**不需要** Candidate 注册，也不引入新 role。
- 一个**全新、未被使用**的 fixture UUID（该实例上 `state_code` 不存在该 identity）。
- 可选：第二个**非** manager actor 的 JWT，用于真实 denial 证明。

运行器自身会断言 preconditions，但不**创建**任何 precondition。

## 必需环境变量

| 变量                                      | 说明                                        |
| ----------------------------------------- | ------------------------------------------- |
| `TIANGONG_RELEASE_LIVE_ACCEPTANCE`        | 必须精确为 `1`；否则拒绝运行                |
| `TIANGONG_LCA_API_BASE_URL`               | 必须是 loopback；hosted/shared 端点一律拒绝 |
| `TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY`   | publishable key；`sb_secret_` 前缀一律拒绝  |
| `TIANGONG_LCA_ACCESS_TOKEN`               | manager actor JWT                           |
| `TIANGONG_RELEASE_LIVE_FIXTURE_UUID`      | 全新 identity，小写 UUID                    |
| `TIANGONG_RELEASE_LIVE_INSTANCE`          | 本次授权写入的实例标签（operator 声明）     |
| `TIANGONG_RELEASE_LIVE_EXPECTED_ENDPOINT` | 必须与 `TIANGONG_LCA_API_BASE_URL` 完全一致 |

可选：

| 变量                                      | 说明                                                               |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `TIANGONG_RELEASE_LIVE_NON_MANAGER_TOKEN` | 第二个非 manager JWT；缺省时 denial 步骤记为 `skipped`，不伪造证明 |
| `TIANGONG_RELEASE_LIVE_FIXTURE_VERSION`   | 默认 `01.00.000`                                                   |
| `TIANGONG_RELEASE_LIVE_TIMEOUT_MS`        | 整数毫秒，范围 `1000`..`300000`，默认 `30000`；非法值直接拒绝      |

### operator 声明 vs server 验证

- `TIANGONG_RELEASE_LIVE_INSTANCE` 与 `TIANGONG_RELEASE_LIVE_EXPECTED_ENDPOINT` 是
  **operator 声明**的绑定，运行器无法从服务端证明实例标签本身；
- 运行器能做的 server 侧验证是：以真实 reviewed prepare envelope 探测该端点，并确认 fixture
  identity 在那里**不存在**（`classification=absent`）；
- manifest 同时记录 `declaredEndpoint` 与 `requestedEndpoint`，供人工核对二者一致。

不要把这些值写进任何文件、命令参数或 issue。运行器只从环境读取，且不打印 token/key/原始
失败 body。

## 运行

```bash
TIANGONG_RELEASE_LIVE_ACCEPTANCE=1 \
TIANGONG_LCA_API_BASE_URL=http://127.0.0.1:61321 \
TIANGONG_RELEASE_LIVE_EXPECTED_ENDPOINT=http://127.0.0.1:61321 \
TIANGONG_RELEASE_LIVE_INSTANCE=<task-instance-label> \
TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY=<publishable-key> \
TIANGONG_LCA_ACCESS_TOKEN=<manager-actor-jwt> \
TIANGONG_RELEASE_LIVE_FIXTURE_UUID=<fresh-uuid> \
node workflows/publication/live/result-only-acceptance.mjs \
  --out-dir .release/publication/live-acceptance/<run>
```

`.release/` 已 gitignored。`--out-dir` 必须是**不存在**的目录：已存在的运行目录会被拒绝，
避免把两次运行的证据混在一起。

## 覆盖步骤

1. **fixture**：用非 canonical bytes（缩进、换行、制表符、非 ASCII）构造 Result-only
   Candidate/plan/payload，断言 stored-byte hash ≠ canonical content hash；
2. **instance sanity**：以真实 `qry_result_process_publish_prepare_v1` 探测端点，要求
   `classification=absent`，否则拒绝运行；
3. **inspection**：真实 `target inspect`，要求恰好一个 `result_process` operation 且
   `action=reconcile_via_manager_command`、`remoteWrites=true`；
4. **approval**：真实 manager attestation，记录真实 `candidateSetHash` 与
   `sourceManifestHash`；
5. **prepare**：真实只读 RPC，要求返回 `absent` 与正确的 byte/canonical hash 绑定；
6. **execute**：真实 `cmd_result_process_publish_v1`，直接创建 `120`；
7. **readback**：真实 `qry_result_process_publication_readback_v1`，要求
   `stateCode=120`、`observedByteHash` = 冻结字节 hash、
   `observedCanonicalContentHash` = canonical hash、三个 `verified` 布尔全为 true；
8. **retry**：同一 frozen request 在新输出目录重试，覆盖丢失响应场景。Proof 来自**重试自身**的
   execution event 与重试后的新回读：要求 `disposition=reused_identical_receipt`、event 记录的
   `remoteReceiptId` 等于首次回读的 `receiptId`、且重试后回读仍是同一 `receiptId`。首次回读的
   receiptId **不会**被当作重试证据；本地 hash 相同本身不构成"未产生重复行"的证明，行级
   census 由 main 在特权侧完成；
9. **conflict**：同一 identity 换新 `idempotencyKey`，要求 typed `409`
   `result_publication_conflict`；
10. **generic read 隔离**：普通 authenticated `/rest/v1/processes` 查询必须**看不到**该
    `120` row；
11. **non-manager denial**（仅当提供第二个 token）：manager-only RPC 必须返回
    `not_data_product_manager` 或 `auth_required`。

`result_publication_busy` 会被原样呈现为 typed `409`，运行器**不做**自动重试或 backoff，
也不迁移任何既有 `100` row。

## 未自动化的部分

- **Revocation readback 不自动化。** 角色撤回需要 operator SQL 步骤（`main` 拥有），运行器
  不会伪造该证明。Release 侧的行为已经离线验证：把 live manager role 置为不存在时，
  readback 以自身类型化错误 `not_data_product_manager`（语义 403）失败，而不是被折叠成
  content/state 不一致。
  真实证明由 main 完成，需要**精确身份**，因此从本次成功运行的 manifest 读取
  `approval.attestedByUserId`（该 actor 就是尝试 readback 的 actor）：

  ```bash
  # 1) 在专用实例上撤回该 actor 的 manager role
  psql "$DB_URL" -X -At -v ON_ERROR_STOP=1 -c \
    "delete from private.roles where user_id='<attestedByUserId>' and role='data_product_manager';"

  # 2) 用同一 actor token 对已完成的 execution 重新运行 readback
  node workflows/publication/cli.mjs result-process verify \
    --execution-dir <run>/result-execution --payload-dir <run>/payload \
    --out-dir <run>-revoked-readback --json
  # 期望：错误码 not_data_product_manager

  # 3) 恢复 role
  psql "$DB_URL" -X -At -v ON_ERROR_STOP=1 -c \
    "insert into private.roles(user_id,team_id,role) values('<attestedByUserId>','00000000-0000-0000-0000-000000000000','data_product_manager');"
  ```

  第 2 步的 CLI JSON 就是独立证据，和两个 manifest 一起留档。`main` 可以扩展 coordinator
  wrapper 以自动完成这三步；Release 不会代跑 SQL。

- 普通 Edge 命令（`app_dataset_create` / `app_dataset_publish` /
  `save_lifecycle_model_bundle`）在本地未运行，因此**不在**本验收范围内。本验收只证明
  Result-only CLI/RPC 链路。

## 保留证据与重置

- manifest 在**第一次远程写入之前**先写入初始版本（fixture、instance、artifact 路径清单），
  之后每完成一步就原子更新一次（temp write + rename）；**成功与失败都会落盘**，失败时包含
  已完成的步骤与非 secret 的错误码；
- manifest 记录本次运行的全部 artifact 路径（fixture 根目录、`payloadDir`、`planDir`、
  精确 payload member、以及 inspection/approval/preparation/execution/readback 目录），
  以便后续独立复核 revocation 时能找到必需的 payload；
- 只记录 allowlist 内的字段：非 secret 的 ID、hash、receipt、状态码与计数；未知的远端
  `code` 折叠为 `unexpected_remote_code`，原始响应 body 永不记录；
- 创建的 `120` row **故意保留**，运行器不删除、不修改、不降级、不绕过 trigger；
- **重置方式**：由 coordinator 在**该专用实例**上重置（丢弃/重建该 instance，而不是在共享
  stack 上定点删除），并保留本 manifest 作为留档。不要在共享实例上做定点清理。

## Guard 自测

`workflows/publication/test/live-acceptance.test.mjs` 在离线 gate 中验证运行器自身的边界：
opt-in、loopback-only、secret key 拒绝、fixture 校验、redaction、`result_publication_busy`
typed 409 且无自动重试、unusable envelope 不重试、并发调用不共享可变状态。这些是**guard
测试**，不是 live 验收；live 验收只以真实运行成功为准。
