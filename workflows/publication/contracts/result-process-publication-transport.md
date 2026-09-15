---
title: Result Process Publication Transport (Release-side consumption notes)
docType: contract
scope: workflow
status: active
authoritative: false
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 实现或审查 Release 到 Database #646 manager-only RPC 的 transport adapter 时
  - 当需要确认 Release 已冻结的 Result Process 写入请求语义时
whenToUpdate:
  - 当 Database 冻结的 prepare/publish/readback 请求或响应契约变化时
  - 当 Release 实现或替换该 adapter 时
checkPaths:
  - workflows/publication/contracts/result-process-publication-transport.md
  - workflows/publication/lib/result-process.mjs
related:
  - ../AGENTS.md
  - ../README.md
---

# Result Process Publication Transport

> 这是 Release 侧的消费备注，**不是权威契约**。Database-owned 契约在 Database 仓库的
> `docs/agents/result-process-publication-contract.md`（`status: active`，checkpoint
> `b4d982f6…`，migration `20260915150000_result_process_publication.sql`）；Database 继续拥有
> 远程真相、授权判定和 receipt 存储。
>
> 本文件描述的三个 RPC **已实现**于 `lib/result-process-transport.mjs`，
> 由 Release 的 `result-process prepare|execute|verify` 使用。实现以 review 过的 Database
> 契约为准；若两者冲突，Database 契约优先。

## Release 侧能力边界

Release 已经实现、且完全不依赖 transport 的部分：

- 每个 operation 按 dataset role 派生目标状态：`result_process → 120`，普通
  `unit_process` / `lifecycle_model` / `support → 100`。dependency member 永远跟随自己的
  role，不因为“被 Result 组件选中”而映射到 120；
- mixed-state Executable Plan v2、Target Snapshot v2、Approval v2（含不可变
  `manager_attestation.v1`）、Execution Intent/Event/Receipt v2、Readback Receipt v2；
- 只读 prepare 冻结 exact Candidate bytes、stored-byte content hash、manager attestation、
  idempotency key、source 与 audit reason，并取回 server `preparationHash`。

Release 已实现的部分：三个 RPC 的调用、严格响应校验、丢失响应恢复和独立回读。

重要边界：**Release 并没有从 Process JSON 推断 semantic Result role 的能力**。role 来自
Candidate publication catalog 中冻结的 canonical dataset index，并且必须经 manager
attestation 授权。对任意未注册的 legacy client，后端无法凭 Process 内容判断它是不是
Result Process；本契约也不声称任何历史迁移。

## 已消费的 Database 契约形状

| 用途     | RPC                                                               |
| -------- | ----------------------------------------------------------------- |
| Prepare  | `api.qry_result_process_publish_prepare_v1(p_request jsonb)`      |
| Execute  | `api.cmd_result_process_publish_v1(p_request jsonb)`              |
| Readback | `api.qry_result_process_publication_readback_v1(p_request jsonb)` |

共同要求：actor JWT、显式 `Content-Profile: api`、不接受 service-role、actor 由服务端
`auth.uid()` 派生、`role` 与 `targetState` 由服务端固定且请求中出现即拒绝、每条路径
（含 readback 与每次 retry）重新校验 live manager role。

Release 侧的三条对应关系必须保持分离，不得合并：

| 名称                 | 所有者   | 含义                                                                                               |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `preparationHash`    | Database | server preparation digest，只覆盖不可变输入/actor/precondition                                     |
| `executablePlanHash` | Release  | 本地 Executable Plan SHA-256；execute 时作为 attested 字段传入，Database 只记录不校验上游 artifact |
| `approvalHash`       | Release  | 本地 Approval SHA-256；同上                                                                        |

两个 hash domain 不得假定相等：

- `result-process-content.v1`：对**精确存储的** `json_ordered` UTF-8 bytes 求 SHA-256，
  用于内容身份、receipt 绑定和 readback 校验；
- 客户端 RFC 8785 canonicalization 与数据库 jsonb canonicalization 不被假定一致。

Release 保留精确 Candidate bytes，不做归一化。若未来允许归一化，必须新增独立的
canonical hash 定义，而不是重定义 stored-byte domain。

## Release 期望的 adapter 接口

`lib/result-process.mjs` 的 `requestTransport` 路径已经定义了注入点，因此契约落地后只需
实现 adapter，不必改动已冻结的请求形状：

```text
transport.prepareResultProcessPublication({ operations }) -> remote prepare evidence
```

每个 operation 已经携带：

- `key` / `table` / `uuid` / `version` / `targetStateCode: 120` / `contentType`；
- `candidateContentPath`、`candidateSha256`、`candidateCanonicalContentHash`；
- `contentSha256` + `contentHashDomain: result-process-content.v1` + `contentByteSize`；
- `candidateSetHash`、`sourceManifestHash`、`idempotencyKey`、`reason`；
- `managerAttestation`（整份 attestation 的 SHA-256）与 `attestationRowHash`。

后续 execute 必须携带 `expectedPreparationHash` 与 `idempotencyKey`；readback 必须以
exact receipt binding（actor + id + version + idempotency key）取回 stored content，
不得使用通用公开读取，也不得做任意 row lookup。

## 已确认的消费行为

- RPC 名称、请求/响应字段、error envelope 采用 Database 冻结形状；`status` 是 body 内的语义
  类别，Release 以 `ok`/`code` 分支，不依赖 HTTP status；
- `reused: true` 丢失响应 replay 与 Release 的 idempotency key 推导一致：key 由
  `plan|key|contentSha256` 派生，同一 key 与完整绑定重放返回 identical receipt；
- readback 返回的 `contentText` 就是存储字节；Release 自己重算
  `result-process-content.v1` 并**另外**校验 Candidate canonical content identity；
- readback 的 `verified` 三个布尔是**强制**的：必须存在、必须是布尔、必须全为 true。
  本地重算只能证明内容绑定，不能证明读取者仍持有 live manager role；缺失、false 或非布尔
  一律 fail closed，且不会被降级为"未发布"；
- legacy `100` row 始终返回 `result_publication_conflict`，从不静默提升到 120。

## 已知限制

- 更新后的 Release 拒绝旧的 Result `100` plan：`publication-executable-plan.v1` 与
  `publication-approval.v1` 不再被接受为 Result 写入授权（历史证据仍可读）；
- `sourceKind` 始终是 `manager_attestation`，绝不是 machine-verified calculation lineage；
- 不声称跨 RPC 或跨 identity 的全局原子性：执行按 operation 顺序进行，Result Process
  command 与平台 dataset command 之间没有事务，前者的成功会在后者失败时保留。
