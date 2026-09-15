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
lastReviewedAt: 2026-09-15
lastReviewedCommit: c7f62de
lastReviewedNote: "Reviewed for Release #74: per-operation role-to-state mapping, no generic no-op for Result Process, the manager-attested transport with exact-receipt recovery, one strict approval/preparation binding and expiry rule on every route, attested real source evidence re-validated by a single validator, strict server verification plus independent recomputation, hash-domain separation, the F4 attestation decision, the legacy all-100 ban, and the no-role-inference / no-migration limits."
related:
  - README.md
  - ../AGENTS.md
---

# Publication Workflow Agent Contract

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
- 不接受、读取或建议 service-role secret；
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
