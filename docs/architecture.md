---
title: Release Workflow Architecture
docType: architecture
scope: repo
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当需要理解根 Workflow、外部系统、产物血缘和执行实现之间的关系时
  - 当决定新文件、契约或代码属于哪个 Workflow 时
whenToUpdate:
  - 当 Workflow 拓扑、外部能力边界、artifact authority 或运行结构变化时
checkPaths:
  - docs/architecture.md
  - AGENTS.md
  - README.md
  - .docpact/config.yaml
  - workflows/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: smaller stable context, scoped routing and truthful handoff boundaries; ownership, immutable evidence and authorization constraints are retained."
related:
  - ../AGENTS.md
  - ../README.md
  - ../workflows/README.md
---

# Release Workflow Architecture

## 所有权与拓扑

架构单位是 `workflows/<name>/`：它拥有本地实现、schema、测试、证据及恢复。根目录拥有工具链、共享治理与导航，根 `test/` 仅承载仓库自动化契约。不要建立统一 stage machine、mutable `currentStage` 或为目录对称引入通用 Workflow DSL。

```text
Calculation -> verified Calculation Bundle
  -> Result Materialization -> canonical dataset collection
  -> Release Candidate -> immutable Candidate
       +-> Publication -> approved plan -> execution -> independent readback
       +-> Dataset Transformation -> validated Unit/Result output + handoff
```

Calculation 内部包含完整性验证；Result/Model 是 Materialization recipe；packaging/qualification 属于 Candidate。它们不是新增顶层 Workflow。Publication 内的 Portal LCIA recipe 从 ready V3 package / prepared projection 开始，与 Candidate dataset recipe 独立。

Transformation handoff 表达目标：Unit 返回计算，Result 返回物化，最终形成新 Candidate。**当前接收边界未闭合**：Materialization 只接受 Calculation Bundle intake，未实现 Derived Result handoff 消费；Candidate 拒绝 Result-only profile。不得把 producer 输出、接口字段或设计箭头当作消费者实现证据。补齐路线需要各 owner 的明确契约与真实跨节点验证。

## 权威来源

| 事实                                 | 维护源                                                                |
| ------------------------------------ | --------------------------------------------------------------------- |
| 仓库所有权、安全红线、最小加载入口   | 根 AGENTS 与 workspace 治理                                           |
| scoped 行为与权限语义                | `workflows/AGENTS.md`、目标 Workflow AGENTS                           |
| 参数、默认值与当前动作               | Workflow CLI help、配置及对应 README                                  |
| artifact 字段与可执行拒绝条件        | 消费者 schema / validator / 行为测试                                  |
| runtime 版本与安装策略               | `.node-version`、package manifests、`pnpm-workspace.yaml` 与 lockfile |
| 文档 ownership、路由、维护义务       | `.docpact/config.yaml`，由 Docpact 解析                               |
| 远程任务、鉴权、数据库和发布事实     | 对应外部系统及其当前契约                                              |
| 当次范围、TODO、验证、交付与集成状态 | Issue / PR / Project                                                  |

文档解释原因和边界，不能替代当前外部状态；代码现状也不能自行赋予操作权限。发现来源冲突时先核对与修正，不能择取更宽松的一条。

## 控制面与数据面

控制面以 actor-scoped API/CLI/RPC 实行业务动作、权限和状态转换。数据库数据面只允许 adapter 中参数化、有界的批量读取，以及契约和用户明确授权后的 staging 写入；artifact 数据面负责传输与完整性校验。远程状态仍由外部系统持有。

Release 自己拥有 cache 格式、只读远端导出编排、临时传输校验与本地安装；Worker EC2 是受管执行位置，不因执行位置转移缓存语义所有权。具体流程见 [Release Candidate](../workflows/release-candidate/AGENTS.md)。

## 证据与恢复

- Remote Resource 用精确 identity/version 引用；本地 artifact 用 hash 标识，路径只负责导航。
- Semantic Draft（如 Transformation Draft DSL）可以修改，修改后必须重新 inspect。Publication Draft Plan 虽名为 Draft，仍是独立的不可原地修改、hash-bound artifact。
- Frozen Spec、Candidate、Approval 与完成的产物不可原地改写；改变内容需创建新对象。Execution events 只追加并保持 hash chain。
- Candidate 一直保持 `publicationAuthorized=false`；它证明本地资格，不授予远程发布权限。
- Publication 的独立 readback 才能证明远程终态，不能用 transport success 替代；多请求可恢复执行不能被描述为不存在的全局事务。
- 恢复保留精确入口、决定、观察、artifact 引用、blocker 与下一动作；一个 Workflow 的建议不等于后继已获授权。

## 按任务读取

| 决策                                                     | 专项说明                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Result/Model 含义、one-hop 连接与 quantitative reference | [领域原则](../workflows/result-materialization/design/result-process-and-lifecycle-model.md)                          |
| 默认产物路径、key、复用与冲突                            | [路径契约](../workflows/result-materialization/design/local-artifact-path-convention.md)                              |
| Unit/Result 加权、字段决定与 Frozen Spec                 | [DSL v0](../workflows/dataset-transformation/dsl-v0.md)                                                               |
| Candidate dataset / Result / Portal 授权和回读           | [Publication AGENTS](../workflows/publication/AGENTS.md)                                                              |
| Result RPC 与 hash domain                                | [Release 消费备注](../workflows/publication/contracts/result-process-publication-transport.md)；Database 契约仍为权威 |
| 真实本地 PostgREST 验收                                  | [opt-in live 验收](../workflows/publication/live/README.md)                                                           |

## 实现原则

确定性实现生成数值、hash、验证和 package；Agent 不模拟这些结果。provider payload 在 adapter 边界解析，不让外部非破坏性字段影响内部路线。共享代码只提取多个 Workflow 已实际复用的机制。

JavaScript/MJS 与禁止生产 compiler/codegen 的约束由依赖图测试守护；精确工具链、workspace 有效配置、单一 lockfile 和 CI 行为由根工具链测试验证。文档不重复这些配置值。业务协议、授权与 numerical invariants 的测试留在各 Workflow。
