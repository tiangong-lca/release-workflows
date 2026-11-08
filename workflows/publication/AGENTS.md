---
title: Publication Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Candidate-bound Publication 时
  - 当 Agent 发布 Portal LCIA V3 package 或 finalize/verify/revoke public projection 时
whenToUpdate:
  - 当 Publication 的范围、状态、授权、写入、恢复或回读规则变化时
checkPaths:
  - workflows/publication/**
lastReviewedAt: 2026-11-08
lastReviewedCommit: df7d513a37111f16a1ea11afd4bbc6aebf80d6a3
lastReviewedNote: "Release #135: reviewed Environment workflow ownership, shared scoped configuration, diagnostic/local setup boundaries and unchanged business artifact/authorization semantics."
related:
  - README.md
  - ../AGENTS.md
---

# Publication Workflow Agent Contract

## 按 recipe 读取

先读 `workflows/AGENTS.md` 与本文件，再按当前 recipe 展开 README：Candidate dataset planning/execution、Result Process prepare/execute/verify、Portal LCIA package/projection。改 Result RPC 时读取 `contracts/result-process-publication-transport.md` 的 Release 消费备注并核对 Database 权威契约；只有显式 live 验收才读取 `live/README.md`。回复读取 CLI 指定模板，不把所有 recipe 的操作手册作为默认上下文。

## 职责

- Candidate dataset recipe 只消费不可变、未授权且带 hash-bound Publication catalog 的 Release Candidate v2；
- 解析 Unit Process、Result、Both 和 exact include/exclude；
- 计算 forward dependency closure 与 reverse-dependent pruning；
- 从 Candidate TIDAS ZIP 物化且仅物化最终选中数据；
- 以 actor-scoped session 检查 exact UUID + Version、canonical content、owner 和 state；
- 只允许用户批准精确 Executable Plan SHA-256；
- 对缺失 row 创建，对同内容 draft 切换状态，对已发布 row 幂等跳过（Result Process 除外，见下）；
- 用哈希链事件实现安全恢复，并用独立查询生成 Readback Receipt。
- Result Process 永不使用 generic no-op：即使观察到的 `120` row 内容一致，仍必须经 manager command 与 exact receipt 释放；
- 按 dataset role 逐 operation 派生目标状态：`result_process → 120`，普通 Unit Process / LifecycleModel / support → 现有 `100`；dependency member 永远跟随自己的 role，不跟随选中组件；
- Result Process 路线只调用 Database-owned `api.qry_result_process_publish_prepare_v1`、`api.cmd_result_process_publish_v1` 和 `api.qry_result_process_publication_readback_v1`，直接创建 120 且从不使用平台 `0`/`100` 命令；
- 通过显式 opt-in 的 Portal LCIA projection recipe，先按 exact Database publish-plan hash 发布具备 Worker prepared typed projection 的 V3 LCIA package，再绑定、独立回读或撤回 public projection；不读取 private artifact locator。

## Representation Decision

- Scope Request：F2；
- Scope Resolution、Payload Manifest、Target Snapshot v2：F3；
- Draft Plan、Executable Plan v2、Approval v2、Manager Attestation、Result Process Preparation、Execution Intent/Event/Receipt v2、Readback Receipt v2：F4。
- Manager Attestation 是 F4 授权与审计记录，记录的事实是 `manager_attestation`（Data Product Manager 的不可变断言），**不是**机器验证的计算血缘。它精确绑定 UUID、version、实际 content hash、`result_process` role、目标状态、真实 candidate/source 证据（来自已验证 payload manifest，不接受 null 占位）和 plan SHA-256，并由单一 validator 重算 rowsHash 与逐行绑定，明确 `lineage: not_machine_verified`，并永不原地更新或升级为 machine provenance。
- 三个 hash 必须保持分离：Database `preparationHash`、Release `executablePlanHash`、Release `approvalHash`。Release 不要求 prepare 依赖未来的 plan 或 approval，不制造循环依赖。
- 两个 hash domain 不得假定相等：`result-process-content.v1` 是精确存储 bytes 的 SHA-256；客户端 RFC 8785 canonicalization 与数据库 jsonb canonicalization 不被假定一致。保留入站 Candidate bytes，不做归一化；若未来允许归一化，必须新增独立 canonical hash 定义。
- 两个 domain 在 durable artifact 中不得互相顶替：共享 event 的 `canonicalContentHash` 只能是 canonical JSON content identity；Result 专属 event 的 `contentSha256` 只能是 stored-byte hash。byte hash 不得被标记为 canonical，也不得为了形状兼容而改用它填充 canonical 字段。
- Portal LCIA Package Publication Plan 与 Projection Plan：F4 授权边界；统一 Portal LCIA Lifecycle Event：F3/F4 严格、只追加的恢复与终态观察。Event 只保存 immutable parent hash、目标、actor、精确主体和该阶段新增观察，不复制完整上游 evidence，不保存临时 RPC response hash、远端 URL 或 artifact locator；Database publication/projection 状态仍是权威真相。
- Portal LCIA 回复模板：F1 Agent 表达指导，只按 Plan prepared、Lifecycle result、Command failed 三种沟通语义分组；exact truth 继续来自 CLI JSON 与 Plan/Event artifact，不为每个命令复制字段契约。

F4 artifact 必须拒绝未知字段、绑定所有上游 hash，并保存在新的输出目录。Execution events 是唯一例外：同一 execution 目录中只追加有序、前向 hash-linked 文件，不修改旧 event。

## 自动执行边界

- Candidate、catalog、package 和 payload 校验是只读操作；
- Target Inspection 和 Readback 是 actor-scoped 只读远程操作；
- Result Process Preparation 是只读远程 prepare：只读取已冻结的 Approval、Executable Plan 和 payload bytes，加上服务端对 identity/content 的分类；
- 只有未过期 Approval 严格绑定当前 Plan/Payload/Snapshot 且 target precondition 通过后，才可调用远程写接口；时间戳畸形的 Approval 一律拒绝，不得因 `NaN` 比较而放行；
- 已完成的发布可以在 Approval 过期后由 verify 入口重新验证：授权在运行当时有效，且每条 RPC 仍重新校验 live manager role；
- 普通数据集远程执行只使用 `app_dataset_create`、`save_lifecycle_model_bundle` 和 `app_dataset_publish`；
- Result Process 120 写入只使用 Database-owned 的 prepare/publish/readback RPC；三者在执行时都以 `Content-Profile: api` 调用，actor 由服务端 `auth.uid()` 派生，每条路径（含 readback 与每次 retry）重新校验 live manager role；
- Portal LCIA projection 只调用 Database-owned `api.qry_portal_lcia_result_package_publish_prepare_v1`、`api.cmd_portal_lcia_result_package_publish_v1`、`api.qry_portal_lcia_projection_prepare_v1`、`api.cmd_portal_lcia_projection_finalize_publication_v1`、`api.qry_portal_lcia_projection_publication_readback_v1` 和 `api.cmd_portal_lcia_projection_revoke_publication_v1`；所有 PostgREST RPC 请求显式选择 `Content-Profile: api`；package publish、projection finalize、revoke 分别要求 exact Package Plan、Projection Plan、finalized Event SHA-256 confirmation；
- actor publication recipes 不接受、读取或建议 service-role secret；最终 Result v3 存储 adapter 的受控数据面 CONN 例外见下，它不取得 actor 发布权限；
- `live/` 下的 opt-in live 验收使用真实 transport 与真实本地 PostgREST：CLI 入口不注入 transport；只需 loopback 字面量、拒绝共享/默认本地端口、要求 operator 声明的 instance label 与 exact expected endpoint、并校验有界 timeout。它不属于 `prepush:gate`，未运行时**不是**通过，也不得被表述为 live 证明。离线 mock 只覆盖 wire shape，不得被当作 live 证据。

## 必须 fail closed

- Candidate、plan、payload、snapshot、approval 或 event chain hash 漂移；
- unknown identity、component mismatch、引用缺失、剪枝后空集合；
- TIDAS ZIP 缺少选中 member、重复 member bytes 不一致或 payload content hash 不符；
- target 同 UUID + Version 内容冲突、不可见 owner、不可直接发布 state；
- Approval confirm hash 不匹配、过期、actor/target 改变；
- operation 的 `targetStateCode` 与该 dataset role 的目标不一致，或请求用全局 `published-state-code` 覆盖 role 映射；
- 旧的全部 state `100`（或任何缺少 per-operation target）的 Result approval 试图授权 Result 写入；历史证据保持可读，但读取不构成新授权；
- 含 Result Process operation 的 Approval 缺少 manager attestation，或执行 actor 不是 attestation 记录的 manager user ID；
- 任一 F4 artifact 出现未知字段，或 attestation/plan/receipt 的 identity、content、role、target、source、actor 与 plan hash 不一致；
- 把 Result Process identity 路由到平台 `0`/`100` 命令，或在缺少远程 prepared request 时执行 Result 写入；
- 把内容一致的 `120` 观察当作 Result Process 的授权或 no-op；
- 在未重新校验 approval 有效期、copied approval/plan hash 与 preparation operation-set digest 的情况下执行 Result 写入；
- 在 execute/readback 时未把 preparation 的实测 approval/plan/payload hash 与调用方选定的证据逐字绑定；
- 把 approval 过期当作否定已完成的发布回读的理由（过期只限制新的执行；回读的 live manager 校验不得削弱）；
- execute 前 target drift，或 create/publish 后 exact readback 不一致；
- independent readback 任一 identity 的 content/state 不一致。
- Projection prepare/finalize/readback 的 exact publication、package version/result hash、projection content/evidence/axis hash、row count 或 source published timestamp 不一致；
- Package publication 的 exact package/projection/artifact hash、Process-set、display default、current-publication 前置条件或 Database `publishPlanHash` 漂移；
- Projection source publication 已 supersede/unpublish、binding 已 revoked，或 finalize 后缺少一轮新的 current readback；
- Projection readback 不是同时 `isCurrent=true` 与 `isPubliclyVisible=true`；
- finalize/revoke transport outcome 不确定且 exact readback 不能安全调和。

## 禁止

- 修改 Candidate 或把纯选择解释为新 Candidate；
- 在 Publication 内修改、聚合或重算 dataset；
- 把 dependency member 的目标状态改写为选中组件的目标状态，尤其是把 support/Unit/Model 映射到 `120`；
- 把 manager attestation 表述为机器验证的计算血缘、把它原地更新，或在冲突时静默提升/降级既有 `120` row；
- 把平台四 ZIP release control-plane `tiangong.release.publish-plan.v1` 与本 Workflow Draft/Executable Plan 混用；
- 绕过 exact plan-hash confirmation；
- 在失败后删除或覆盖 event 以伪造整洁历史；
- 声称多请求远程写入具有平台未提供的全局事务原子性；
- 把 execute transport success 当作独立回读成功。
- 从 private Storage/S3 下载 projection artifact、持久化 locator，或让 Portal projection recipe 改写既有 Candidate Publication payload/state。
- 依赖通用公开读取或任意 row lookup 完成 Result Process readback；
- 把服务端 `verified` 布尔当作可替代本地重算的结论，或接受其中任一为 false、缺失或非布尔；
- 声称跨 RPC 或跨 identity 的全局原子性；
- 从 Process JSON 推断 semantic Result role，或声称任何历史 legacy 数据迁移。

## 完成条件

Publication 只有在以下条件全部满足时完成：

- effective set 引用完整且 payload 只含该集合；
- target inspection 无 blocker；
- Approval 精确绑定 Executable Plan 且执行时有效；
- 每个 approved identity 有 completed event；
- Execution Receipt 覆盖全部 identities；
- 新的一轮 actor-scoped 查询验证全部 canonical content hash 和该 role 的目标发布状态；
- Readback Receipt `status=verified`。

Result Process 120 路线在上述条件之上还要求：Database 返回的 receipt 与 Release 的
`preparationHash` / `executablePlanHash` / `approvalHash`、identity、content hash、
sourceKind、idempotency key 与 reason 精确一致（execute 的 receipt 与 readback 的 receipt
走同一个 binding validator）；独立 readback 必须来自 exact receipt
binding，**同时**满足服务端 `verified` 三个布尔存在且全为 true，**并**由 Release 自己重算
stored-byte hash 与 canonical Candidate content identity。两者都必需，互不替代：本地重算
不能证明 live manager membership。丢失响应只有 exact receipt 可以调和；确定性失败必须整
事务回滚，不得留下 partial row 或声称成功。执行按 operation 顺序进行，跨 RPC 无事务。

Portal LCIA projection recipe 只有在 exact Package Publication Plan 已确认且 package-published Event 已通过独立 prepare 回读、exact Projection Plan 已确认、idempotent finalize 成功、projection-verified Event 来自独立 readback 且同时验证 publication/package/content/evidence/count、`isCurrent=true` 和 `isPubliclyVisible=true` 后完成。Revoke 只有在 exact finalized Event 已确认且 revoked Event 来自独立 `revoked`、`isPubliclyVisible=false` 回读后完成。Supersede/unpublish 必须使后续 verification fail closed。

## 最终 Result v3 存储适配

最终完整包固定为 `result.tidas.7z` 和 `result.ilcd.7z`，与 Candidate 中实际归档的 hash/bytes 绑定；不能把旧 ZIP 仅改扩展名。已知 413/EntityTooLarge 在完整 GET 未恢复匹配对象时报告 `final_storage_object_too_large`，保留固定文件名、字节数、上传阶段、HTTP 状态和 multipart 清理状态。不得返回 provider 原文，也不得建议原样重试。丢失响应仍先完整 GET 调和，只中止本次已知 multipart。

- `lib/final-result-storage.mjs` 只消费重新验证的配对 Candidate v3。inspect 在本地绑定 Candidate/目标/完整文件集/行映射；execute 必须确认完全相同的 storage plan hash。`result-storage inspect/execute` 是独立 opt-in CLI；它不替代后继发布选择、reader readiness、actor approval 或 activation。inspect 不打开远程客户端，不要求 S3 写凭据；execute 在确认及新输出目录检查之后才构造受控 adapter。
- `adapters/final-result-object-store.mjs` 使用显式数据面 S3/IAM 凭据；`adapters/final-result-registry.mjs` 使用受保护 CONN、单客户端参数化事务与服务角色，除 Environment 的固定只读连接探测 SQL 外，仅调用五个 Database-owned v2 query/Candidate 存储 RPC 与四个 readiness begin/artifacts/seal/describe RPC。不读取 actor token，不接受任意 SQL，不写 canonical/state 120，不调用批准/激活接口。
- 对象键只从 artifact UUID/manifest hash、Candidate byte hash 和固定文件名派生。PUT 和 multipart complete 使用 `If-None-Match: *`，不覆盖已有文件；只可中止本次已知 multipart upload，不能 DeleteObject。每次执行与重试都完整 GET 校验 bytes/hash，不把 ETag 或原数据库 seal 当成当前文件可用性的证明。
- 最终 Result 的 publication-catalog 仅接收精简 v2 成员；完整图只由 Release 构建验证，不上传或交给 Database 遍历。实时支持数据权限与批次绑定保持。
- 本地已验证的索引/7z 与远端 GET 字节摘要相同后才按产物登记实际 Result 轴和完整包范围，行使用内容指纹与 Candidate 根关联。行按 500 条且 JSONB logical size 不超过 1 MiB 分批，映射摘要必须与 Database 的 ASCII 500-row block contract 一致。
- 超时、响应丢失与并发同键写入必须先精确回读。query/Candidate seal 响应不明时用 service-only describe 恢复原回执；不能换 artifact、Candidate、Result 版本或覆盖原回执。中止分片无法确认或创建分片响应丢失时明确 `multipartCleanupRequired`，不得声称清理完成。
- 目标 fingerprint 绑定数据库连接身份（不含密码）、规范化存储 endpoint/region/bucket/prefix。根 endpoint 的身份不变；Supabase 精确 `/storage/v1/s3` base path 必须同时保留在哈希与 SDK 请求中，不能退化为 origin。配置必须指向已经治理的非公开存储；adapter 不改变 bucket policy，也不能以文件核验代替非公开环境准入。原 actor recipes 与 Portal projection 的 secret/locator 禁止仍保持。
- storage/readiness 通过 Environment 加载器读取进程值及固定仓库 `.env`/显式 `--config-env` 文件；各命令只读取自己的白名单，不扫描其他目录或 AWS credential provider；纯加载器不修改调用者，独立 CLI 只应用自身白名单。CA/TLS 文件统一解析并在提供 CA 时强制 verify-full，不改变数据库目标身份。storage 的只读 inspect/preflight 不读取 S3/actor/reader secrets；actor-only 命令只加载用户白名单，不接入数据面凭据或会话 bootstrap。
- storage `preflight` 只校验本地 Candidate 与数据库 describe 状态；`execute` 必须在第一笔对象上传/登记前执行同样检查。已知连接/TLS/认证失败与只读查询失败不归为写入不明；真正已派发写入后的不明结果继续精确回读恢复。错误只保留白名单 code、阶段和 SQLSTATE，不输出原始异常、连接串或凭据。
- 证据输出必须位于冻结 Candidate 外部，含符号链接解析。每次 execute/preflight 使用新的输出目录：先写 attempt、成功后写相应 receipt/report；失败保留 attempt/failure。配置错误须先修配置，不能推荐原样重试上传；恢复仍用同一 Candidate/target/hash，不能删除记录伪造完成。
- 该阶段只产生不可变存储登记证据，始终 `publicationAuthorized=false`。普通用户访问、完整 7z 授权及原子 current 切换由版本化 Database/Edge/Platform 接入另行完成。

## 最终 Result reader 验证

- `adapters/final-result-reader.mjs` 是受控服务验证 transport，只签名固定
  `/internal/results/query-v2` 的 readiness scope、精确 artifact 与 Result；不接受
  publication scope、任意 URL path、过滤器或原始 locator。每个请求及冷缓存重试前
  必须重新通过 actor 权限检查，服务密钥与 actor session 分离，拒绝重定向。
- `lib/final-result-reader-verification.mjs` 从与 Candidate 完全一致的冻结 final input
  重建预期投影，逐项核对实际 reader 返回的定量参考、单位、LCI 非零项、全部分页和
  LCIA；明确区分 LCIA 缺失与 LCIA 零。首个 LCI 页大小为 1，以覆盖有多项时的 cursor。
  每页绑定准入 reader binary SHA、runtime revision、选择及 live manager 前置条件；
  最后一次响应后再次核对权限。权限回调接收 AbortSignal，必须使用可取消的有界调用。
- 新 `verifyQuery/verifyCandidate` 只完整 GET 校验，缺失或损坏时失败，不修复、不上传。
  只读回读不能使用 `ensure*` 的缺失补传行为。
- `tiangong.final-result-reader-probe.v1` 是单个精确 Result 的实测证据，不是发布范围
  全覆盖、数据库 readiness seal 或批准。整体 verifier 按下述契约枚举选中范围并登记证据；Database 在激活时仍须独立核对。
  `result-readiness inspect/verify` 提供配置预检与整体验证入口；不能把验证回执当成发布完成状态。

## 最终 Result 整体就绪验证

- `adapters/final-result-actor.mjs` 只以用户 JWT 调用两个固定的、显式 `api`
  profile 的 probe RPC。只允许 HTTPS 或字面量 loopback HTTP origin，拒绝重定向、
  secret/service token 与过期会话；JWT 解码只排除错误凭据类型，权限由服务器每次
  校验。读取与响应体均有期限和大小限制；原始远端错误与凭据不进入输出。
- `lib/final-result-readiness.mjs` 对同一 Candidate/final input 先枚举完整的选中
  artifact 范围，严格验证分页、唯一性、选中数量与首末 probe；绑定用户、目标、
  Candidate、选择、runtime revision 与 reader SHA。数据面数据库 target hash
  必须与对象存储 target 的数据库身份相同。
- attempt 时钟在远端 GET 前开始。完整核验四个 Candidate 文件和全部选中 artifact
  文件后，再运行独立数值 probe，避免较慢 GET 提前耗尽 reader 的有效窗口。
  每个 Worker 请求仍重新检查用户权限；seal 前再读取当前上下文。
- 调用者必须在新的不可变本地证据目录实现 `record(event)`：attempt、header、每个
  artifact proof 必须在相应下一次数据库写入之前持久化。未落盘就停止。每个 proof
  不超过 Database 的 64 KiB JSONB 预算，单 artifact 分批登记；完整 seal 的数量、
  上下文和有效期必须独立 describe 回读一致后才能记录成功。
- 仅对提交结果不明的同一不可变 payload 重试一次，数据库以原 UUID 仲裁；连续不明
  或冲突必须停止。失败重开验证使用新 UUID 与新观察，不能延长、改写或补造历史证据。
  成功回执仍 `publicationAuthorized=false`；不生成批准、不激活、不写业务数据。
- 整体本地资格验证须覆盖真实 Toolkit 7z、Release HDF5、S3 SDK/HTTP、Worker
  与隔离 PostgreSQL 的 identity/storage/selection/runtime/readiness RPC。测试用
  HTTP facade 只接收固定合成 token 并执行真实 actor SQL；不将其描述为 hosted JWT、
  Edge 或 Platform 的端到端证明。

- `result-storage inspect/preflight/execute` 与 `result-readiness inspect/verify`
  统一使用 Environment 的固定仓库 `.env` 或 `--config-env`，按命令白名单读取，
  拒绝与非空进程值冲突；纯加载器无全局副作用，独立 CLI 只应用自身有效值。
  只有 readiness 显式传入 `--bootstrap-session` 且缺少 JWT 时才调用现有用户 session
  helper 换取短期会话，返回 token 不持久化、不自动刷新。actor-only 命令接受 `--config-env` 用户白名单，但不接受 bootstrap。
- Runtime preparation 统一项目 origin/精确 `/functions/v1` base，显式 CA 文件只增强为
  verify-full，保持数据库 target identity；reader 密钥只能来自一个显式环境/file/SSH
  来源。SSH 仅执行固定、有界、非交互的只读 key 提取，不接受任意命令、不传其他凭据，
  不复制整个远端配置，不写远端或持久化用户 token/reader secret。
- `inspect` 只检查本地 Candidate、已登记存储/完整选择/runtime 及每个 artifact 的
  实际 reader overview，前后重查 live actor。它不构造 object-store、不登记 readiness、
  不证明完整远端文件或冻结数值；成功只返回独立新目录的 verify continuation。
- `verify` 在 Candidate/final input 外创建新的私有目录；证据使用独占创建、
  文件模式 `0600` 与 Node `flush` 落盘，再登记远端证据。失败保留 attempt/proof，
  新验证用新目录与 UUID；不复用历史时间戳、不修复远端文件、不批准或激活。

## 最终 Result 用户发布控制面

- `result-publication plan/prepare/status` 只使用显式用户 JWT 与公开客户端 key，
  不读取数据面凭据、不自动登录。probe adapter 仍只读；共享 HTTP 实现只允许固定
  v2 routine，响应受期限/大小约束，写调用不明结果必须独立精确回读。
- 本地计划是 F4 envelope：绑定 actor、API origin hash、冻结 Candidate 本地路径、
  exact members 与数据库计划原始文本。`localPlanHash` 确认本地 envelope，
  `publishPlanHash` 标识 Database plan bytes，两者不可互代。未知字段和漂移拒绝。
- 选择可缩小 Result 集合但不添加 Candidate 外成员、父 Result 或修改内容；
  全部默认范围也必须显式确认。current 前置条件在 plan 时冻结，后续不得自动重基。
- prepare 先落盘意图和有界成员批次，再调用 actor RPC；run/selection seal 必须
  独立回读。历史 sealed run 只观察，不重开、不续期。普通用户的状态只由 Database
  当次权限决定。status 的 run 状态与 publication 当前性必须分开表达。
- approve/activate 传输原语不构成用户授权，也不绕过上层 intent 的精确确认；
  它们不接受 client-supplied actor。真正批准/激活仍由 Database 原子检查，
  确认入口按下节执行，独立公开查询由 `result-publication readback` 执行。

## 最终 Result 批准与激活意图

- Approval Intent 与 Activation Intent 均为 F4：拒绝未知字段，绑定精确本地计划
  hash、用户/API target、就绪回执和操作身份；意图准备只读，执行必须确认该意图 hash。
- 批准人可不同于计划创建人，执行人可不同于批准人；readiness 必须绑定批准人，
  不能把执行人的 probe 权限冒充批准人的就绪证明。数据库执行时仍检查两者资格。
- 批准意图冻结 expected active approval、原因与至多 24 小时的未来有效期；
  激活意图冻结精确 approval hash、verification、执行 key 和会话指纹。
  指纹是版本域分离的 JWT SHA-256，仅用于审计绑定；原令牌和解码 claims 不落盘。
- 新执行在落盘后重新校验上下文，首次激活要求会话指纹未变；用户会话续期不自动
  改写旧意图。恢复已提交操作允许同一用户以新会话查询原审计，但不能产生新写入。
- 写响应不明必须独立读取原 identity，无精确观察则停止；不自动重试批准或激活。
  历史 consumed/expired/revoked approval 和非 current publication 只恢复观察，
  不复活授权。记录失败时保留意图和已有证据，新尝试仍用原操作身份查询恢复。
- 激活在全局发布锁内核对所有历史已发布成员。同一 Result UUID/version 的标准文档内容冲突时，回到上游分配版本并重新构建配对 Candidate。
- 数据库激活观察不是公开读取完成；回执必须保持 `publicReadbackVerified=false`，
  不能在未通过真实 Edge/Platform/下载链路检查时宣称发布验证完成。

## 最终 Result 公开回读

`result-publication readback` 只使用当前 actor 和相同 API origin 的公开 Edge。
逐一对全部选定 Result 的冻结标准投影核对 overview、完整 LCI 和声明的 LCIA，
固定 publication/runtime；查询失败不得用原 Bundle 或私有 reader 成功替代。
可授权 7z 必须独立完整 GET 校验长度/hash，明确不可用单独记录，其余错误失败。
签名 URL 只在内存中使用，不保存、不转发 actor 凭据、不跟随跳转。

观测原文必须先独占落盘，再登记 immutable manager attestation，并独立读回原文摘要。
Database 重新检查 current、选择、reader、实时角色/7z 权限和新鲜度。写入结果不明
先恢复同一 run 记录，禁止换新内容覆盖凭证。`readback_verified` 是发布后的审计状态，
不能作为首次公开可见性的额外门槛；失败不隐式撤回、回滚或再次激活。历史凭证不
承诺当前持续可用，也不冒充浏览器交互或 hosted JWT 验收。
