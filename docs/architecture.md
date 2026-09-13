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
lastReviewedAt: 2026-09-13
lastReviewedCommit: ba2c97947a9be5d9e99e473963e7fbf6efbdf8b1
lastReviewedNote: "Release #72: reviewed canonical repository identity migration to tiangong-lca/release-workflows; architecture, Workflow boundaries, and publication semantics unchanged."
related:
  - ../AGENTS.md
  - ../README.md
  - ../workflows/README.md
---

# Architecture

## 架构单位

本项目的主要架构单位是根目录 Workflow，而不是跨项目 stage machine，也不是 `src/` 中的模块目录。

```text
Repository
├── README.md
├── AGENTS.md
├── workflows/
│   ├── calculation/
│   ├── result-materialization/
│   ├── release-candidate/
│   ├── dataset-transformation/
│   └── publication/
├── docs/
├── test/                    # repository toolchain/automation contracts only
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── .github/workflows/
```

一个 Workflow 可以在自己的目录下包含说明、Agent 契约、模板、schemas、fixtures、验证器和代码。不是所有 Workflow 都需要相同子目录，也不建立通用 Workflow DSL。

## Workflow 拓扑

默认生产路径是：

```text
ResultSet / Closure / Worker Job
              |
              v
         Calculation
              |
              v
      Calculation Bundle
              |
              v
   Result Materialization
              |
              v
Canonical Dataset Collection
              |
              v
      Release Candidate
```

Candidate 冻结后形成两个恢复方向：

```text
Release Candidate
  |
  +--> Publication
  |      component/exact scope -> forward closure + reverse pruning
  |      -> exact payload -> Target Snapshot -> approved Executable Plan
  |      -> resumable execution -> independent readback
  |
  +--> Dataset Transformation
         choose Unit Process or Result Process semantics
         -> exact Candidate data -> transformed canonical data
         -> Unit Process: Calculation -> Result Materialization
         -> Result Process: Result Materialization
         -> new Candidate
```

这些路径不共享 mutable `currentStage`。每个节点通过精确 identity、version、hash、artifact 和决定证据恢复。

## 控制关系

```text
用户
  <-> Agent / Operator
        -> Calculation Workflow
        -> Result Materialization Workflow
        -> Release Candidate Workflow
        -> Dataset Transformation Workflow
        -> Publication Workflow

Workflow
  -> release-owned adapter
  -> existing API / CLI / deterministic executable
  -> external authoritative system
```

Workflow 拥有意图整理、动作选择、本地证据和恢复上下文。外部系统继续拥有远程鉴权、任务状态、计算真相、数据库状态和发布事实。

外部访问分为三个平面：

- 控制面：actor-scoped Edge/API/RPC，负责业务动作、权限、任务、审批和原子状态转换；
- 数据库数据面：参数化、有界的批量读取，以及未来明确授权后的 staging 写入；
- artifact 数据面：S3 manifest、partition、Parquet、NDJSON 和 package 的本地传输与完整性校验。

## Artifact authority

本项目区分：

- Remote Resource：ResultSet、Closure Check、Worker Job、Result Package、Publication；
- Local Artifact：下载的 manifest、dataset、report、package 和 readback 文件；
- Semantic Draft：用户意图、字段建议和未决问题；
- Frozen Spec：可执行的 Transformation、Package 或 Candidate 输入规格；
- Release Candidate：通过完整资格验证、`publicationAuthorized=false` 的不可变发布输入；
- Candidate Publication Catalog：Candidate v2 内 hash-bound 的 exact identity/reference/component handoff；
- Publication Scope Resolution：Publication 对 request 的确定性闭包与剪枝证据；
- Publication Draft Plan：绑定 Candidate/scope/target intent、尚未授权且不可原地修改的本地计划；
- Publication Executable Plan：绑定 payload、Target Snapshot、状态 mapping 和每个 exact operation 的待批准计划；
- Publication Approval / Execution / Readback：F4 授权、哈希链执行和独立终态证据；
- Decision Evidence：绑定精确 subject hash、target 和决定人的范围或授权证据。

Remote Resource 的状态由外部系统权威持有。本地 artifact 由内容 hash 标识。Draft 可以修改；Frozen Spec、Candidate 和已执行产物不得原地改写。

## Release Candidate 边界

Release Candidate Workflow 拥有：

- Release Intake 和依赖补齐；
- Package Plan；
- TIDAS/eILCD validation、conversion、round-trip 和 package build；
- Candidate qualification；
- failed build evidence；
- exclusion impact report、人工审核视图和 scope decision；
- 派生 Candidate 的完整重建与验证。

Candidate dataset bytes、identity、version 或 package 内容发生变化时，必须创建新 Package Plan 和新 Candidate。原 Candidate 不被删除、覆盖或重新解释。

Candidate v2 在构建时生成 `publication-catalog.json`，把 canonical index、exact references、Unit Process/Result roots 和 component closure 绑定到 manifest。Publication 可以引用 component 或精确 dataset 子集，不修改 Candidate。

## Dataset Transformation 边界

Dataset Transformation 以父 Candidate 和精确 dataset identity/version/hash 为输入。DSL v0 的 Draft 与 conflict report 先保留 Agent 对 Unit/Result 路线的推荐和用户确认，再处理权重与业务字段语义；Frozen Spec 用明确 operation type 展开确定性权重、业务字段值和 metadata policy。

业务字段差异和 aggregation-target 未确认属于 `needs_decision`，不是 terminal failure。加权 Unit Process 改变过程清单语义，把旧 Result evidence 标记为 invalidated，并返回 Calculation。加权 Result Process 只接受共同 Calculation lineage、相同 exchange identity set 和 LCIA method set，生成 Derived Result 后返回 Result Materialization；它不重新求解供应链，也不隐式生成 LifecycleModel。

## Publication 边界

Publication 的 Candidate dataset recipe 只消费不可变 Candidate v2。它支持 Unit Process、Result、Both 和 exact include/exclude，计算 forward closure、transitive reverse pruning 和 reference-complete effective set，并只物化选中 TIDAS payload。

Actor-scoped Target Snapshot 按 UUID + Version、canonical content、owner 和 state 分类；用户只批准 exact Executable Plan hash。执行使用现有平台 dataset commands，对缺失 row 创建、对 matching draft 转换状态、对 matching published 幂等跳过，并用哈希链 event 在部分失败后恢复。平台未提供跨多个 Edge 请求的全局事务，因此该边界明确是 resumable/idempotent，不声称 atomic promotion。只有新一轮 exact remote queries 生成的 Readback Receipt 才证明完成。Publication 不拥有内容变换或包重建。

Publication 内另有独立的 Portal LCIA projection recipe。它从 ready V3 package 和 Worker prepared projection 开始，只调用 Database-owned actor RPC。Package prepare 冻结 package/projection/artifact hash、Process-set 与 current-publication precondition，由 Database 计算 exact `publishPlanHash`；第一个 confirmation 执行幂等 package publish 和独立 projection-prepare readback。第二个 confirmation 执行 projection finalize，新的 readback 必须通过与匿名 RLS 相同的完整 public-visibility predicate。Package Publication Plan 与 Projection Plan 是两个 F4 授权边界；package-published、projection-finalized、projection-verified 和 projection-revoked 使用一个严格 lifecycle-event contract，只记录 immutable parent、主体与该阶段新增观察，不复制完整上游证据，也不保存临时 RPC response hash。Revoke 绑定 exact finalized event 和 projection content hash，并以 revoked readback 收敛。Package publish 与 projection finalize 没有跨 RPC 事务，中间状态由 event 保留且 Portal 数值可以 unavailable。该 recipe 不进入 Candidate dataset payload/create/publish 路径，不访问 private artifact 数据面；Database publication/projection 状态继续是权威真相。

## 恢复模型

每个 Workflow 自己保存：

- 入口资源；
- 已完成动作；
- 当前观察到的外部状态；
- 本地产物和证据；
- 等待用户回答的问题；
- 可执行动作；
- blocker 与最早返回点。

关闭终端或切换 Agent 后，通过精确资源 ID 和本地 evidence 恢复。一个 Workflow 可以建议进入另一个 Workflow，但不得把建议解释成授权执行。

## 实现边界

- 外部 API、CLI 和 executable 通过本仓库 adapter 调用；
- 全仓运行时固定为 Node `24.19.0` 和 pnpm `11.24.0`，六个 package 共用根 workspace 与唯一 lock；项目级 engine、peer、lockfile、save-prefix 和 package-manager mismatch policy 只由 `pnpm-workspace.yaml` 的 camelCase 设置拥有，并通过 pnpm 的有效配置输出验证；
- CI 由不可变 `pnpm/setup` 提供精确 Node/pnpm，production graph audit 通过 `process.execPath + npm_execpath` 且禁用 shell，避免 Windows `.cmd` shim 差异；
- 当前实现保持纯 JavaScript/MJS，生产依赖图不得因 SDK 或工具链迁移重新引入 TypeScript、compiler 或 schema codegen；
- 外部 provider schema 只在 adapter 边界解析；
- Workflow 文档拥有行为语义，adapter 不拥有业务路线；
- 确定性计算、验证和打包不得由 Agent 模拟；
- 共享代码只提取已被多个 Workflow 实际复用的机制；
- 不为目录对称创建空运行时抽象；
- Dataset Transformation 只实现已确认的 Unit/Result weighted-aggregate operations，不通过通用 patch、隐式 LifecycleModel 聚合或表达式扩大语义；Publication 只实现已确认的 exact-plan-hash、actor-scoped 平台 adapter、状态 mapping，以及 Database-owned Portal LCIA V3 package publish 和 projection finalize/readback/revoke 契约。

## 当前实现基线

- Calculation 已实现 ResultSet、Closure/Calculation 提交、任务查询和数据库/S3 Calculation Bundle 数据面。
- Result Materialization 已实现 intake、Result Process/LifecycleModel 生成、验证和本地后台 Job。
- Release Candidate 已实现 Elementary Flow cache、Release Intake、Package build、失败影响分析、人工审核和 Candidate qualification。
- Dataset Transformation 已实现 aggregation-target recommendation/decision、Draft inspect、conflict/decision、Frozen Spec、加权 Unit/Result Process、validation/conditional handoff、CLI、schemas、测试和真实三 Process 试验。
- Publication 已实现 Candidate v2 handoff、范围解析、exact payload、Target Snapshot、Approval、可恢复执行、独立回读，以及 opt-in Portal LCIA V3 package plan/publish、projection prepare/finalize/verify/revoke、CLI 和测试。
