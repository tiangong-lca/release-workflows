---
title: Publication Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户准备从不可变 Release Candidate 选择并发布 Unit Process、Result 或 Both 时
  - 当需要执行目标检查、精确批准、平台发布或独立回读时
whenToUpdate:
  - 当发布选择、目标差异、状态转换、写入、审批、恢复或回读规则变化时
checkPaths:
  - workflows/publication/**
lastReviewedAt: 2026-11-01
lastReviewedCommit: 466d56389f1d9f0c71bd14d587bd51b0458a1801
lastReviewedNote: "Release #99: reviewed actor-only bounded probe transport, complete selected-artifact/file/numeric readiness orchestration, durable-before-write evidence, immutable unknown-ACK recovery and real local PostgreSQL/Worker qualification. CLI, approval, activation and hosted adoption remain separate."
related:
  - AGENTS.md
  - ../release-candidate/README.md
  - ../../README.md
---

# Publication Workflow

Publication 消费不可变 Release Candidate v2，在不修改 Candidate 的前提下完成选择、精确载荷物化、目标检查、明确批准、远程发布和独立回读。它还提供一个独立、显式 opt-in 的 Portal LCIA projection recipe：先按 Database-computed exact plan hash 发布具备 prepared typed projection 的 V3 LCIA package，再 finalize、独立验证或撤回公开 projection binding。

```text
Release Candidate v2
  -> Scope Request + dependency-safe Resolution
  -> Publication Draft Plan (未授权)
  -> exact selected TIDAS payload
  -> actor-scoped Target Snapshot
  -> Publication Executable Plan (未授权)
  -> exact plan-hash Approval
  -> resumable create/state-transition execution
  -> independent content/state readback
```

Dataset Transformation 不属于本 Workflow。任何 Process/LifeCycleModel 内容修改、规则聚合、UUID/Version 改变或重新计算，都必须先产生新的 Candidate，再进入 Publication。

## 最终 Result v3 文件存储

`lib/final-result-storage.mjs` 提供 `inspectFinalResultStorage` 和
`executeFinalResultStorage`，消费已通过真实 HDF5/ZIP 回读及全局身份登记的
Candidate v3。inspect 仅本地读取，返回精确 storage plan/hash；execute 需要同一
hash 确认，并重新验证 Candidate。CLI 为 `result-storage inspect/execute`；原 `plan prepare` 等命令
仍按下文 Candidate v2/actor recipe 运行，不能用它们发布 v3。

受控 S3 adapter 只写入 `<prefix>/query-artifacts/<artifactId>/<manifestSha256>/`
和 `<prefix>/release-candidates/<candidateSha256>/` 下的固定文件名。后者包括
`release-candidate.json`、`publication-catalog.json`、`result.tidas.zip`、
`result.ilcd.zip`。存储命名不改变 ZIP 内部内容与原下载文件名。

进程环境必须显式提供 `CONN`、`S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`，
可选 `S3_PREFIX`。inspect 只解析目标并校验本地 Candidate，不联网、不读取
S3 secret。execute 还要求 `S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`，可选
`S3_SESSION_TOKEN`；不会隐式读取 `.env` 或其他 AWS credential provider。
目标必须是已经治理的非公开存储，CLI 不改变 bucket policy。

```bash
node workflows/publication/cli.mjs result-storage inspect \
  --candidate /absolute/path/final-candidate --out-dir /absolute/path/storage-plan --json
```

检查输出目录中的 `storage-plan.json` 与不含密码的 `storage-target.json`，再使用
CLI 返回的绝对路径 `nextActions`。`storage-plan.json` 保存无末尾换行的 canonical
JSON，其文件 SHA-256 等于返回的 `storagePlanHash`；确认值直接取该字段。

```bash
node workflows/publication/cli.mjs result-storage execute \
  --candidate /absolute/path/final-candidate --confirm '<storagePlanHash>' \
  --out-dir /absolute/path/storage-attempt-1 --json
```

存储证据目录必须在冻结 Candidate 外部；符号链接别名也不能绕过此边界。
execute 在确认 hash、校验 Candidate 和检查新输出目录后才构造远程客户端。
它先保留 `storage-attempt.json`，成功后写 `storage-receipt.json`；失败保留
attempt 与可写入的 `storage-failure.json`，不覆盖历史，也不输出原始连接/provider
异常。使用相同 Candidate、目标和确认值，在新目录重试；数据库回执及远端完整
GET 决定恢复结果，不能以本地旧 receipt 跳过回读。成功仍然
`publicationAuthorized=false`，CLI 明确报告后继发布适配尚未完成。

每个对象最大 32 GiB，16 MiB 顺序分片；默认每请求/完整 GET 最长 15 分钟，可在 100 ms 至
1 小时内显式配置。内存按单分片和有界元数据使用，不把整张矩阵或 ZIP 读进内存。

写入使用 S3 条件创建，现有相同 bytes 通过完整 GET 后复用；现有不同 bytes
直接拒绝。上传响应丢失或条件冲突先完整回读，不无条件覆盖。分片失败只尝试
Abort 本次 upload；创建响应丢失而没有 upload ID、或 Abort 失败会明确报告
`multipartCleanupRequired`。它不是删除历史文件或共享文件的许可；目标环境
需要独立的未完成 multipart 保留/清理策略。

数据库 adapter 调用 Database #879 的五个 v2 存储 RPC 和四个 readiness 证据 RPC。目标 hash 同时绑定
CONN 的 host/port/database/user 身份和 S3 origin/region/bucket/prefix，密码
轮换不改变目标。CONN 只允许 PostgreSQL URI 与 TLS 参数，拒绝 query 参数
覆盖连接身份。原 actor token/publishable-key transport 保持独立；数据面凭据
不放入命令参数、输出或回执。环境治理必须先确保 bucket/prefix 非公开；本模块
不修改 IAM/bucket policy，完整 GET 也不证明隐私配置或 reader readiness。

先核对远端全部 query 文件，再分批登记准确 Result 行并 seal；完整 ZIP/catalog
回读通过后才登记 Candidate。seal 响应不明用 describe 查询权威原回执，重试
始终复用同一身份。存储 receipt 明确 `publicationAuthorized=false`，还需要发布
选择、非公开 reader/权限就绪验证、actor 批准、原子激活和发布后验证。

验证入口为 `test/final-result-object-store.test.mjs`（真实 SDK 对 loopback 合成
HTTP 服务）和 `test/final-result-storage.test.mjs`。后者还通过真实子进程 CLI 验证 inspect、execute 和只读复用；其实际产物/数据库联调
显式要求 `RELEASE_PAIR_TIDAS_BIN` 与 `RELEASE_STORAGE_TEST_CONN`，且拒绝
`127.0.0.1:61432/postgres` 以外的连接；它只用于 Database #879 拥有的本地合成库。
默认测试跳过该联调，不能称为通过。测试实际生成三个 Result、两组 HDF5 和两个
ZIP，验证丢失 S3/数据库响应后的恢复、重试无对象写入以及远端损坏拒绝；身份和
登记元数据留在任务测试库供 owner reset，HTTP 服务及临时文件在测试结束时释放。

依赖锁定 `@aws-sdk/client-s3` 3.1161.0 与 `pg` 8.23.1（Node 24.22.0），原
Calculation/Candidate 依赖不升级。条件写入依据 [S3 官方契约](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
和所安装 SDK 的 `PutObject` / `CompleteMultipartUpload` 类型文档；ETag 仅用于
multipart 协议，不充当内容摘要。

### 私有 reader 验证库

`createFinalResultProbeVerifier({candidateDir, inputDir, reader})` 消费同一冻结输入和
Candidate v3；`verify(probe, {authorize})` 核对 Database 的精确 probe 描述，每次网络
请求前和最后响应后通过 `authorize(signal)` 重查同一 actor/runtime/选择/权限上下文。
返回单个 Result 的 `tiangong.final-result-reader-probe.v1`，始终
`publicationAuthorized=false`。调用者必须保留 final input，不能用 HDF5 自身作为预期数值。

`createFinalResultReader({endpoint, secret, timeoutMs, preparingMs})` 使用独立的服务密钥，
只访问固定 v2 readiness 接口。默认请求/权限检查期限 30 秒，冷缓存准备窗口 5 分钟；
响应上限 2 MiB。只允许 HTTPS，测试可用字面 loopback HTTP；不跟随重定向。
对象 adapter 的 `verifyQuery/verifyCandidate` 只做完整 GET，与上传入口分开。

单 Result probe 不进行 Database readiness seal、审批或 current 切换。完整范围由下述
整体 verifier 处理；readiness CLI、批准/激活操作和发布后验证仍待接入。

合成联调使用实际 Release 编码器/Toolkit ZIP 和独立 Worker binary：

```bash
RELEASE_PAIR_TIDAS_BIN=/absolute/path/to/tidas \
RELEASE_QUERY_WORKER_BIN=/absolute/path/to/result_query_service \
node --test workflows/publication/test/final-result-reader.test.mjs \
  workflows/publication/test/final-result-reader-verification.test.mjs \
  workflows/publication/test/final-result-object-store.test.mjs
```

测试只启动本地临时 HTTP 对象服务和自有 Worker/cache，退出时关闭并清理；不需要业务
数据库或云凭据。未提供上述 binary 的 opt-in 用例会跳过，不能记为真实链路通过。

## 发布语义

用户首先选择 `unit-process`、`result` 或 `both`，并可用 exact identity 缩小范围。

- exact identity 格式：`<datasetType>:<uuid>@<version>`；
- `--include` 替代 component 默认 roots，并自动补齐 forward dependencies；
- `--exclude` 剔除指定数据，同时递归剔除所有因此引用不完整的 reverse dependents；
- 最终集合必须非空、完全来自 Candidate，且 required references 完整；
- 纯选择不会形成新 Candidate。

目标平台按 UUID + Version + canonical content hash + **该 dataset role 的目标状态** 分类：

- 不存在：创建精确 Candidate 数据，然后切换到该 role 的目标状态；
- 已存在且内容相同、尚未发布：不覆盖内容，只切换状态；
- 已存在且内容相同、已经发布：幂等 no-op（**仅限普通数据集；Result Process 见下**）；
- 已存在但内容不同、当前 actor 无发布权、或处于不可直接发布状态：在批准前 fail closed。

## 混合状态映射

发布目标状态按 **dataset role** 逐 operation 派生，不再存在全局发布状态：

| role              | 目标状态 | 写入路径                                                       |
| ----------------- | -------- | -------------------------------------------------------------- |
| `result_process`  | `120`    | Database-owned manager-attested command（见下）                |
| `unit_process`    | `100`    | 现有平台 `app_dataset_create` / `app_dataset_publish`          |
| `lifecycle_model` | `100`    | 现有平台 `save_lifecycle_model_bundle` / `app_dataset_publish` |
| `support`         | `100`    | 现有平台 `app_dataset_create` / `app_dataset_publish`          |

dependency member 永远跟随自己的 role。Result 闭包中被引用的 support Flow、Unit Process
和 LifecycleModel 仍是普通数据集，**不会**因为“被 Result 组件选中”而被提升到 120。

**Result Process 没有 generic no-op。** 即使 actor-scoped 观察已经看到内容一致的 `120` row，
该 operation 仍然是 `action=reconcile_via_manager_command`、`remoteWrites=true`：内容候选
永远不是授权，也不是 no-op，只有 exact receipt 可以释放该 identity。只有普通数据集才可能
是 `already_published_noop`。

Executable Plan v2 的每个 operation 都携带 `role`、`contentType`、`targetStateCode` 和
`remoteWrites`；Target Snapshot v2 记录 `stateMapping.roleTargets` 与
`singleGlobalState=false`。`--published-state-code` 只保留为 fail-closed guard：传入 100
以外的值会被拒绝，因为状态不再由全局参数决定。

### Result Process 120 路线

Result Process 的 120 写入必须经过 Database-owned 的 manager-only RPC；Release 侧分三步，全部要求
actor 就是 manager attestation 记录的 Data Product Manager：

```bash
node workflows/publication/cli.mjs result-process prepare \
  --approval-dir .release/publication/<run>/approval \
  --payload-dir .release/publication/<run>/payload \
  --out-dir .release/publication/<run>/result-preparation \
  --json
```

`prepare` 是**只读**远程调用 `api.qry_result_process_publish_prepare_v1`。它重新校验精确
Candidate bytes，绑定 stored-byte content hash（`result-process-content.v1`）、manager
attestation、idempotency key、source 与 audit reason，并取回 server `preparationHash`。
它**不产生任何远程写入**，也不构成发布授权——授权来自已经绑定的 Executable Plan 和
Approval。

返回的 `preparationClassification` 只是**内容候选**分类：`candidate_content_matches_existing`
仅表示存在一个 stored content hash 相同的 120 row，它**不**比较 actor、source 绑定或 audit
reason，**不**表示已授权，也**不是** no-op 证据。

```bash
node workflows/publication/cli.mjs result-process execute \
  --result-preparation-dir .release/publication/<run>/result-preparation \
  --payload-dir .release/publication/<run>/payload \
  --out-dir .release/publication/<run>/result-execution \
  --json
```

`execute` 会先用同一个严格 loader 重新绑定 approval/plan/payload（包括 copied artifacts 的
hash 与 approval 有效期），再调用 `api.cmd_result_process_publish_v1`，把 identity 直接创建在
`state_code=120`——**没有中间 `0` 或 `100` row**，也从不使用平台
`app_dataset_create` / `app_dataset_publish`。请求携带 `expectedPreparationHash` 和由
`plan|key|contentSha256` 派生的 `idempotencyKey`。

丢失响应或冲突答复**不**单独判定成败：只有针对相同 actor + identity + version +
idempotency key 的 exact receipt 才算已发布，此时 Event 记录
`disposition=reconciled_after_transport_loss`。确定性的命令错误让整个事务回滚，不留下
partial row，也不声称成功。

```bash
node workflows/publication/cli.mjs result-process verify \
  --execution-dir .release/publication/<run>/result-execution \
  --payload-dir .release/publication/<run>/payload \
  --out-dir .release/publication/<run>/result-readback \
  --json
```

`verify` 调用 `api.qry_result_process_publication_readback_v1`，只按 exact receipt binding
取回**精确存储内容**，不做通用公开读取，也不做任意 row lookup。

两个检查都必需，互不替代：服务端 `verified` 的三个布尔必须存在且全部为 true
（`rowMatchesReceipt`、`receiptMatchesRequest`、`liveManager`）——本地重算只能证明内容绑定，
不能证明读取者仍持有 live manager role；同时 Release 自己重算 stored-byte hash、Candidate
canonical content identity 和 receipt 的完整绑定（含 `preparationHash`）。任一不成立即 fail
closed。

同样，`publish execute` 收到的 receipt 也会把 `preparationHash` 与本地 prepared 值逐字比较：
格式正确的其他 digest 不会被当作成功。

执行按 plan 中的 operation 顺序逐个进行，**跨 RPC 没有事务**。Result Process 走 manager
attested command，普通数据集走平台命令；前者成功后后者失败会留下已经提交的 `120` row，
Workflow 报告可恢复的 partial state，并且**不写最终 receipt、不声称成功**。

两个 hash domain 在 durable 事件和 receipt 里必须保持分离，绝不互相顶替：

| 字段                                                                 | domain                                              | 来源                                |
| -------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| `publication-execution-event.v2.canonicalContentHash`                | canonical JSON content identity                     | 冻结 Candidate 的 canonical dataset |
| `result-process-execution-event.v1.contentSha256`                    | `result-process-content.v1`（精确存储 UTF-8 bytes） | reviewed command 返回的 receipt     |
| readback receipt `observedByteHash` / `observedCanonicalContentHash` | 分别为 byte 与 canonical                            | Release 在 readback 时各自独立重算  |

存储字节的 hash **不会**被标记为 canonical。当冻结 bytes 不是 canonical 序列化时两者确实不相等。

独立的 `result-process execute|verify` 与混合的 `publish execute` / `readback verify` 走**同一个**
严格绑定路径：approval、executable plan、payload manifest、preparation 与 payload 的 hash
互相绑定，preparation 的 operation-set digest 必须覆盖其自身内容，重复 identity 直接失败
而不是静默覆盖。专用入口不是更弱的授权路径。

**两层绑定，缺一不可。** 第一层校验 preparation 与其自身 copied artifacts 一致；第二层再把
其实效 approval hash / executable plan hash / payload manifest hash 与**调用方选定的**证据
逐字比较（`result_process_evidence_binding_mismatch`）。因此"同一 payload、同一 actor 的
另一个 approval"的 preparation 无法在 approval A 下执行或回读——否则会出现用 B 的
preparation 发出 Result RPC，而普通执行与 receipt 声称 A 的情况。preparation header
（`targetId`、`contractVersion`、`sourceKind`、endpoint fingerprint、actor）必须与已验证的
copied evidence 对齐，不能只是文件内部自洽。

**新鲜度与证据有效性是两件事。** approval 过期只限制**新的执行**：两个 execute 入口在任何
写入前拒绝过期或时间戳畸形的 approval（`publication_approval_invalid`，畸形值不会因
`NaN` 比较而绕过）。两个 verify 入口则**允许**在 approval 过期后重新验证已经完成的发布，
因为其授权在运行当时有效；这些路径的每个 RPC 仍会重新校验 live manager role，因此撤回
角色依然会阻断回读。

恢复执行会复用同一个 execution 目录；已存在的 copied artifact 必须与 preparation 的来源
证据一致，否则 fail closed，不会静默保留不匹配的证据。

manager attestation 的每一行都绑定**真实**的 source 证据（`candidateSetHash` =
payload `datasetSetHash`，`sourceManifestHash` = candidate `packageSetHash`），并会被重新校验：
rows hash、逐行 identity/role/target/content/source/plan 绑定与覆盖集合都必须成立，任何篡改
在**任何远程调用之前**失败。

`publish execute` 与 `readback verify` 混合状态路径需要 `--result-preparation-dir`；缺少时在
**任何写入之前** fail closed 为 `result_process_preparation_required`，不会因为缺少参数而崩溃。

契约形状与已确认的消费行为记录在
[`contracts/result-process-publication-transport.md`](contracts/result-process-publication-transport.md)。

只在本地 PostgREST 实例上运行的 **opt-in live 验收**（不在 `prepush:gate` 内，需要 operator
显式 opt-in）：[`live/README.md`](live/README.md)。它使用真实 transport，覆盖直插 120、字节级
回读、幂等重试、typed conflict、generic read 隔离与真实 role 判定；revocation readback 需要
独立的 operator SQL 步骤，未自动化。

### 已知限制

- 更新后的 Release **拒绝**旧的 Result `100` plan：`publication-executable-plan.v1` /
  `publication-approval.v1` 不再被接受为 Result 写入授权（历史证据仍可读，但读取不构成
  新授权）；
- `sourceKind` 始终是 `manager_attestation`，即 Data Product Manager 的断言，**不是**
  machine-verified calculation lineage；Release 也**没有**从 Process JSON 推断 semantic
  Result role 的能力——role 来自 Candidate catalog 中冻结的 canonical dataset index；
- 不声称跨 RPC 或跨 identity 的全局原子性：平台没有跨多个请求的事务，执行是
  idempotent + resumable；
- 不做任何历史数据迁移。

## 授权语义

- Approval v2 携带不可变的 `managerAttestation`（`manager-attestation.v1`）。
  Data Product Manager 是授权 attestor；普通 ownership、客户端 role 声明或 service
  credential 单独都不足够。
- attestation 精确绑定 UUID、version、实际 content hash、`result_process` role、目标 120、
  candidate/source 证据与 plan SHA-256，并明确 `lineage: not_machine_verified`。
  它**不是**机器验证的计算血缘。
- attestation 不原地更新，也不升级为 machine provenance。冲突的发布必须使用新的、
  显式授权的 identity/version。
- 执行 actor 必须是 attestation 记录的 manager user ID。
- 旧的全部 state `100` 的 Result approval **不能**授权 Result 写入：`publish execute`
  在任何写入前拒绝并返回 `historicalEvidenceReadable=true`。历史证据仍然可读，只是读取
  它不构成新的授权。

## CLI 完整流程

安装并查看帮助：

```bash
pnpm install --frozen-lockfile
node workflows/publication/cli.mjs --help
```

### 1. 准备范围

```bash
node workflows/publication/cli.mjs plan prepare \
  --candidate .release/candidates/<candidate> \
  --component both \
  --target tiangong-lca-platform \
  --out-dir .release/publication/<run>/plan \
  --json
```

可重复使用 `--include` / `--exclude`。输出：

```text
publication-scope-request.json
publication-scope-resolution.json
publication-draft-plan.json
```

这里使用 `publication-draft-plan.v1`，避免与平台已有、用于四个 Release ZIP 的 `tiangong.release.publish-plan.v1` 发生 schema 名称碰撞。

### 2. 物化精确载荷

```bash
node workflows/publication/cli.mjs payload materialize \
  --candidate .release/candidates/<candidate> \
  --plan-dir .release/publication/<run>/plan \
  --out-dir .release/publication/<run>/payload \
  --json
```

该命令重新验证 Candidate 与两个 TIDAS ZIP，只提取 resolution 中的精确成员；相同数据同时出现在 Unit/Result ZIP 时必须具有完全相同 bytes。输出 `publication-payload-manifest.json` 和 `datasets/`，被剪枝的数据不会进入载荷。

### 3. 检查目标并形成可执行计划

远程命令只接受 actor-scoped session：

```text
TIANGONG_LCA_API_BASE_URL
TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY
TIANGONG_LCA_ACCESS_TOKEN 或 TIANGONG_LCA_API_KEY
```

禁止使用 service-role secret。

```bash
node workflows/publication/cli.mjs target inspect \
  --plan-dir .release/publication/<run>/plan \
  --payload-dir .release/publication/<run>/payload \
  --out-dir .release/publication/<run>/inspection \
  --json
```

输出 `publication-target-snapshot.json` 和 `publication-executable-plan.json`。Snapshot 绑定 actor、目标 endpoint 指纹、`stateMapping.roleTargets`、每个 UUID + Version 的内容/状态分类和整体 fingerprint；Executable Plan 仍记录 `publicationAuthorized=false` 与 `resultPublicationAuthorized=false`。

### 4. 批准精确计划

```bash
node workflows/publication/cli.mjs approval create \
  --inspection-dir .release/publication/<run>/inspection \
  --confirm <executable-plan-sha256> \
  --approved-by <stable-actor-id> \
  --expires-at <future-ISO-8601-timestamp> \
  --reason "approved release scope" \
  --out-dir .release/publication/<run>/approval \
  --json
```

`--confirm` 必须逐字符等于 CLI 返回的 Executable Plan SHA-256。Approval 绑定 Draft Plan、payload、target snapshot、fingerprint、状态 mapping、批准人和过期时间；任一上游 artifact 漂移都会失效。

计划含 `result_process` operation 时还必须提供
`--attested-by-user-id <data-product-manager-uuid>`；缺少时 fail closed 为
`publication_manager_attestation_actor_invalid`。CLI 的 `nextActions` 会在需要时自动带上该参数。

### 5. 执行发布

```bash
node workflows/publication/cli.mjs publish execute \
  --approval-dir .release/publication/<run>/approval \
  --payload-dir .release/publication/<run>/payload \
  --out-dir .release/publication/<run>/execution \
  --json
```

执行前会重新检查目标。第一次执行要求和批准快照一致；恢复执行允许已经由同一执行产生、内容正确的 draft/published row。普通数据集继续使用平台 `app_dataset_create`、`save_lifecycle_model_bundle` 和 `app_dataset_publish`；任一 `targetStateCode=120` 的 operation 需要 Database-owned Result transport，缺失时在写入前 fail closed。每个 identity 完成后重新读取内容和状态。

平台没有跨多个 Edge Function 请求的一次性事务，因此 Workflow 不声称全局 atomic。它使用：

- 固定 Approval/Plan/Payload hash；
- `publication-execution-intent.json` 防止目录被其他计划复用；
- `events/000001.json...` 哈希链记录 started/success/failure；
- 每次恢复重新读取远端，只跳过已经验证完成的 identity；
- `publication-execution-receipt.json` 只在全部 identities 完成后生成。

如果失败，保留同一个 `--out-dir` 重试即可。CLI 会报告已完成和失败 identity，不会扩大范围或删除远端数据。

### 6. 独立回读

```bash
node workflows/publication/cli.mjs readback verify \
  --execution-dir .release/publication/<run>/execution \
  --payload-dir .release/publication/<run>/payload \
  --out-dir .release/publication/<run>/readback \
  --json
```

该命令发起一轮新的 exact REST 查询，不复用 execute 的响应。每个 UUID + Version 都必须同时满足 canonical content hash 和**该 role 的目标状态码**；全部通过后写出不可变 `publication-readback-receipt.json`，此时 Publication 才完整结束。含 `targetStateCode=120` 的 operation 需要 Result Process readback 路径，缺失时 fail closed。

## 权限和可见性边界

- `app_dataset_publish` 当前只允许 dataset owner 直接发布；目标检查会对可见 draft 校验 owner。
- Actor-scoped REST 可能看不到其他用户的私有同键数据。此时检查会把它视为 absent，创建时平台唯一约束仍会 fail closed；已经完成的其他 identity 会保留在执行事件中并可恢复，不做破坏性回滚。
- 该可见性限制正是 120 Result 不能依赖通用公开读取的原因：Result readback 必须走 exact receipt binding 的授权路径，不能放宽公开读取。
- 状态不再由全局参数决定：`--published-state-code` 只接受普通状态 100，其他值在检查前被拒绝。
- Transport `ok` 不代表完成；只有独立 Readback Receipt 的 `status=verified` 表示 Publication 完成。Result Process 120 写入需要远程 prepared request，且其 readback 只走 exact receipt binding 的 manager-only 路径。

## 主要契约

- Scope Request：F2 用户选择投影；
- Scope Resolution、Payload Manifest、Target Snapshot v2：F3 稳定、hash-bound 证据；
- Draft Plan、Executable Plan v2、Approval v2 + Manager Attestation、Execution Intent/Event/Receipt v2、Readback Receipt v2、Result Process Preparation：F4 严格审计与授权边界；
- 所有计划、批准和终态 receipt 都不可原地覆盖；Execution event 只追加。

## Portal LCIA projection recipe

这个显式 opt-in recipe 不属于 Candidate dataset create/publish 链，也不改变 V1/V2 请求、artifact、signed download 或回读行为。它只编排 Database-owned actor RPC，使用 publishable key + actor session；不接受 service-role，不读取 private artifact，也不把 URL、bucket、object path 或 locator 写入本地产物。

Database publication/projection 状态是远程权威真相。Release 只拥有三个本地契约：

- Package Publication Plan：F4，绑定 Database `publishPlanHash`、exact package/projection/artifact evidence、当前 Process set、current-publication 前置条件和请求理由；
- Projection Plan：F4，在 package publish 后绑定 exact publication、projection evidence、source `publishedAt` 和 idempotency key；
- Lifecycle Event：严格、只追加的恢复/终态观察，统一表达 `package_published`、`projection_finalized`、`projection_verified`、`projection_revoked`。

Lifecycle Event 只记录 immutable parent artifact SHA-256、target、actor、精确 subject 和该阶段新增 observation。它不复制完整上游 package/projection/artifact evidence，也不保存临时 prepare/publish/readback response body hash。

Agent 回复模板不是第四类契约。它们只提供 F1 表达指导，并按三种沟通语义复用：两个 prepare 命令使用 Plan prepared，四个写入/回读结果使用 Lifecycle result，所有失败使用 Command failed。模板只要求共同的 outcome、completeness、artifact 和 next action；exact identity/hash 直接来自当前 CLI JSON 与 Plan/Event artifact，不在每个命令模板中重复声明。

```text
ready V3 LCIA package + Worker prepared typed projection
  -> Package Publication Plan + exact confirmation
  -> idempotent package publish + independent projection-prepare readback
  -> package_published Event
  -> Projection Plan + exact confirmation
  -> idempotent finalize
  -> projection_finalized Event
  -> independent current + publicly-visible readback
  -> projection_verified Event
```

### 1. 准备并确认 V3 package publication

```bash
node workflows/publication/cli.mjs projection package-plan \
  --package-id <package-uuid> \
  --default-impact-category <impact-category-id> \
  --reason "publish Portal LCIA projection" \
  --out-dir .release/publication/<run>/package-publication-plan \
  --json

node workflows/publication/cli.mjs projection package-publish \
  --package-plan-dir .release/publication/<run>/package-publication-plan \
  --confirm <exact-local-package-publication-plan-sha256> \
  --out-dir .release/publication/<run>/package-publication \
  --json
```

Prepare 是只读操作。写入前 CLI 重新读取 exact evidence；Database 在 publication lock 内重新计算并要求相同 `publishPlanHash`。Commit 后 response 丢失时，只允许相同 expected hash 的幂等 retry，再以 `api.qry_portal_lcia_projection_prepare_v1` 独立核对 publication/package/projection。

Package publish 会立即 supersede 旧 current publication，而新 projection 尚未 finalize。这个 durable partial state 由 `package_published` Event 表示；两步之间 Portal LCIA 数值可以暂时 unavailable，但旧 projection 不能冒充新 publication。

### 2. 准备并确认 projection finalize

```bash
node workflows/publication/cli.mjs projection prepare \
  --package-publication-dir .release/publication/<run>/package-publication \
  --out-dir .release/publication/<run>/projection-plan \
  --json

node workflows/publication/cli.mjs projection finalize \
  --plan-dir .release/publication/<run>/projection-plan \
  --confirm <exact-projection-plan-sha256> \
  --out-dir .release/publication/<run>/projection-finalization \
  --json
```

Projection Plan 绑定 `package_published` Event SHA-256，并冻结 Database 返回的 exact publication/package/projection evidence。Finalize 前重新 prepare；任一 identity、version、content/evidence/axis/count 或 source timestamp 漂移都会拒绝写入。Finalize response 丢失时，只有新的 exact readback 已证明同一 binding 为 current/finalized，才生成 `projection_finalized` Event；否则返回可重试状态，不猜测结果。

`projection_finalized` 仍记录 `independentReadbackVerified=false`，所以此时不能声称公开投影闭环完成。

### 3. 独立验证公开终态

```bash
node workflows/publication/cli.mjs projection verify \
  --finalization-dir .release/publication/<run>/projection-finalization \
  --out-dir .release/publication/<run>/projection-readback \
  --json
```

新的 actor-scoped readback 必须匹配 exact projection/publication/package identity、package version、projection content/evidence hash、process/impact/value count 和 finalized timestamp，并同时满足 `status=finalized`、`isCurrent=true`、`isPubliclyVisible=true`。只有成功写出的 `projection_verified` Event 表示 Portal LCIA projection publication 完成。

### 4. 精确撤回

```bash
node workflows/publication/cli.mjs projection revoke \
  --finalization-dir .release/publication/<run>/projection-finalization \
  --confirm <exact-finalized-event-sha256> \
  --reason "withdraw public projection" \
  --out-dir .release/publication/<run>/projection-revocation \
  --json
```

Revoke 只作用于 finalized Event 绑定的 exact publication + projection content hash。成功响应或 response loss 后都必须独立回读；只有 `status=revoked`、`isCurrent=false`、`isPubliclyVisible=false` 才生成 `projection_revoked` Event。请求理由的 `reasonPersistence` 区分首次记录、reused 未重写和 response-loss 后未知，Database audit 继续是理由持久化的权威记录。

### 完成和非回归边界

- 三个契约均使用 Draft 2020-12 strict schema，未知字段被拒绝；
- package publish 和 projection finalize 是两个独立远程写入，不虚构跨 RPC 事务；
- supersession/unpublish 通过 Database current-publication 事实即时使旧 projection 不再可验证/可见；
- transport success 不代表完成；verified/revoked Event 必须来自独立 readback；
- 所有输出目录不可覆盖，Plan/Event locator-free，stdout 只返回有界 identity/hash/count 和本地 artifact path；
- 所有 RPC 显式发送 `Content-Profile: api`，不依赖默认 `public` schema；
- recipe 不改 package/artifact bytes、Candidate dataset publication 或 private artifact ACL。

### 整体就绪验证库

`verifyFinalResultReadiness` 接收同一 `candidateDir`/`inputDir`、精确 run/plan hash、
新的 verification UUID、用户只读 actor adapter、只读 object store、受控 registry、
reader 与持久化 `record` 回调。它枚举全部选中 artifact，先完整 GET 四个 Candidate
文件和所有选中文件，再从冻结输入重建预期数值、验证每个 artifact 的首末选中 Result。
LCI 全部分页和 LCIA 明确可用性均须通过。上下文、数量或权限变化立即停止。

验证事件必须先落盘再登记数据库。单 artifact proof 受 64 KiB 限制，seal 由 Database
检查完整范围与有效期；调用者独立 describe 回读原回执后才记录成功。同一不可变写入
丢失响应时只精确重试一次，不能延长证据时间或把已有观察换成新内容。失败后用新的
UUID 开始一轮实际验证。回执不等于批准或发布，仍需后继 actor 流程。

`createFinalResultActor` 使用显式 origin、publishable key 和 actor JWT；只调用固定
probe API，不接受服务凭据、不调用批准/激活。每次由数据库验证 live manager 资格。
它不自动登录或刷新会话。用户凭据、Worker HMAC 与数据面 CONN/S3 凭据分别保管。

除上述真实文件/Worker 验证外，可在 owner-reset 的任务专用合成数据库使用
`RELEASE_READINESS_TEST_CONN` 运行 `final-result-readiness-database.test.mjs`。
该测试强制本地 `127.0.0.1:61432/postgres` 和 `hdf5-final-879` owner 标签，验证真实
SQL 登记与 lost-ACK 恢复，保留不可变合成审计供 owner reset。它的 HTTP 用户认证是
固定 token 测试 facade，不替代 hosted PostgREST/Edge/Platform 验证。不要对共享或
业务数据库运行该测试，也不要用合成回执执行真实发布。
