---
title: TianGong LCA Release 项目说明
docType: guide
scope: repo
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当需要理解 Release 项目的当前目标、Workflow 边界和确认状态时
  - 当需要决定一项工作属于 Calculation、Result Materialization、Release Candidate、Dataset Transformation 还是 Publication 时
  - 当准备实现、运行或审查任一 Workflow 时
whenToUpdate:
  - 当项目目标、Workflow 划分、跨 Workflow 关系或确认结论变化时
  - 当新增、删除或重新定义根目录 workflows 子目录时
checkPaths:
  - README.md
  - AGENTS.md
  - docs/architecture.md
  - workflows/**
  - .docpact/config.yaml
lastReviewedAt: 2026-09-13
lastReviewedCommit: ba2c97947a9be5d9e99e473963e7fbf6efbdf8b1
lastReviewedNote: "Release #72: reviewed canonical repository identity migration to tiangong-lca/release-workflows; project goals and five Workflow navigation unchanged."
related:
  - AGENTS.md
  - docs/architecture.md
  - workflows/README.md
---

# TianGong LCA Release

`tiangong-lca-release` 是一个面向人和 Agent 的本地数据产品工作台。它组织计算、标准数据集生成、Candidate 构建、可选再加工和正式发布，同时保存每一步使用的精确输入、用户决定、验证证据、输出产物和恢复入口。

这个项目不是前端、计算引擎或数据库服务。它调用其他系统已经提供的能力，但不修改其他仓库，也不从 mutable `latest` 猜测 identity、version、graph 或 method。

## 当前 Workflow 结构

```text
workflows/
├── calculation/
├── result-materialization/
├── release-candidate/
├── dataset-transformation/
└── publication/
```

当前默认主线是：

```text
Calculation
  -> Result Materialization
  -> Release Candidate
```

Release Candidate 完成后提供两个明确方向：

```text
Release Candidate
  ├─ Publication -> full/selective dependency-closed Publish Plan
  └─ data refinement -> Dataset Transformation -> new Candidate
```

Candidate 和变换产物都不可原地改写。Publication 可以从 Candidate 选择引用完整的发布子集；任何数据内容变化仍必须产生新 Candidate，并绑定父 Candidate 与变换证据。

## 1. Calculation Workflow

Calculation 负责从计算意图或已有远程资源继续工作，直到所需 Calculation Bundle 已可靠下载到本地。

它负责：

- 创建或接入 ResultSet；
- 确认 scope 和 LCIA 方法集；
- 启动、跟踪 Closure Check 和计算任务；
- 展示报告、阻塞项和可恢复动作；
- 下载并校验 Calculation Bundle；
- 绑定远程资源 identity 与本地产物证据。

完整性验证属于 Calculation 内部的可恢复节点，不是独立顶层 Workflow。

详见 [Calculation Workflow](workflows/calculation/README.md)。

## 2. Result Materialization Workflow

Result Materialization 负责把 Calculation Bundle 或其他已经冻结并验证的结果，确定性地组装为标准 LCA 数据集。

它负责：

- 冻结 scope、最终对象和 Result Process 内容层；
- 生成 LCI 或 LCI + LCIA Result Process；
- 生成引用精确 Result Process 的 resolved one-hop LifecycleModel；
- 求解并冻结 identity/version；
- 验证 TIDAS schema、引用闭合、数值一致性和 Model 重构；
- 输出 canonical dataset collection、dataset index 和 materialization manifest。

LCI Result Process、LCI + LCIA Result Process 和 LifecycleModel 是本 Workflow 下的 recipe，不是额外顶层 Workflow。

详见 [Result Materialization Workflow](workflows/result-materialization/README.md)。

## 3. Release Candidate Workflow

Release Candidate 负责把已经 materialize 并验证的数据组织为不可变、可审查、尚未授权发布的 Candidate。

它负责：

- 从冻结上游准备 Release Intake；
- 补齐独立分发所需的精确支持数据；
- 冻结 Package Plan；
- 执行 TIDAS/eILCD 验证、转换、语义 round-trip 和确定性打包；
- 对失败构建生成完整影响报告和人工审核视图；
- 将范围排除绑定到精确影响报告 hash；
- 通过新的 Package Plan 重跑全部验证；
- 冻结 `publicationAuthorized=false` 的 Release Candidate。

Packaging 和 Candidate qualification 都属于本 Workflow。生成 ZIP 不等于 Candidate 已通过资格验证，Candidate 构建成功也不等于已经获得发布授权。

Candidate 完成后必须展示两个后续方向：

1. 进入 Publication，选择 Unit Process、Result、Both 或精确 datasets，生成依赖闭合的 Publish Plan；
2. 选择精确 Candidate 数据进入 Dataset Transformation，再生成新 Candidate。

Release Candidate v2 额外冻结 `publication-catalog.json`，让 Publication 在不改变 Candidate 的前提下执行确定性的正向依赖补齐和反向剪枝。

详见 [Release Candidate Workflow](workflows/release-candidate/README.md)。

## 4. Dataset Transformation Workflow

Dataset Transformation 是 Candidate 完成后的可选再加工入口。当前 DSL v0 先让 Agent 解释并推荐 Unit Process 或 Result Process 聚合语义，再由用户确认目标；随后从 Candidate v1/v2 选择匹配 role 的精确 Process，以显式权重或 `annualSupplyOrProductionVolume` 证据形成加权聚合。

Workflow 先生成完整业务字段冲突报告。字段差异、年产量缺失或取值不明确进入 `needs_decision`，由 Agent 提出策略并把用户决定写回 DSL；它们不是失败。决定完整后冻结 Candidate/dataset hashes、weights、字段值和 metadata policy，再由确定性执行器归一化参考 amount、聚合 exchanges、生成新 identity、重置 review，并输出 validation receipt 和 lineage。

加权 Unit Process 改变过程清单语义，因此旧 Result evidence 明确失效，完成后返回 `Calculation -> Result Materialization -> Release Candidate`。加权 Result Process 只组合 hash-bound、共同 Calculation lineage、exchange set 和 LCIA method set 兼容的已有 Result，完成后直接返回 `Result Materialization -> Release Candidate`，不重新求解，也不隐式聚合 LifecycleModel。父 Candidate 不被覆盖，Transformation 也不产生发布副作用。

详见 [Dataset Transformation Workflow](workflows/dataset-transformation/README.md)。

## 5. Publication Workflow

Publication 负责消费不可变 Release Candidate，在精确选择和授权后改变 TianGong LCA 平台上的发布状态，并独立确认终态。

当前已经实现完整 Publication 闭环：

- 用户选择发布 Unit Process、Result、Both 或精确 datasets；
- Publication 从 Candidate v2 的 hash-bound catalog 计算 forward closure 和 exclude 的 transitive reverse pruning；
- request、resolution 和 Draft Plan 原子写入，且明确 `publicationAuthorized=false`；
- 从 Candidate TIDAS ZIP 只物化 dependency-safe effective set；
- actor-scoped target inspection 按 UUID + Version + canonical content + state 分类；
- 用户用 exact Executable Plan SHA-256 形成带过期时间的 Approval；
- missing row 创建后发布、matching draft 只切状态、matching published 幂等跳过；
- 执行使用哈希链事件安全恢复，并以独立远程回读生成最终 Receipt。
- 对具备 Worker prepared projection 的 ready V3 LCIA package，显式 opt-in recipe 先确认 Database-computed exact package publish plan，再确认 projection finalize，并通过独立 public-visibility readback 或精确 revoke 收敛终态。

远程发布规则是：

- 平台已存在精确 UUID + Version 的数据时，发布动作改变其生命周期状态；
- 平台不存在该主键时，发布动作写入精确 Candidate 数据并进入发布态；
- 发布计划必须区分用户选择的 roots 与保证引用完整性所需的有效发布集合；
- 当前 semantic `published` 映射到平台 `state_code=100`；未来切换到例如 `120` 时必须同步升级平台 adapter；
- 平台未提供跨多个 Edge Function 请求的全局事务，因此 Workflow 明确采用幂等、可恢复执行，不虚构 atomic promotion。

Publication 不修改 Candidate；纯范围选择生成 hash-bound Draft/Executable Plan 和精确 payload。内容变化必须返回 Release Candidate、Dataset Transformation 或更早上游生成新 Candidate。

Portal LCIA projection recipe 与 Candidate dataset publication 相互独立：前者不创建/发布 TIDAS dataset，不读取 private LCIA artifact，只发布 exact V3 LCIA result package，并把 Worker 已准备、Database 重新核对的 typed numeric projection 绑定到该 publication。Package publish 与 projection finalize 是两个独立 Plan confirmation 边界；中间和终态用一个只追加 lifecycle-event contract 记录，Database 仍拥有远程真相。两步之间可能短暂 unavailable，不伪造原子切换。现有 artifact、signed-download 和 Candidate Publication 行为保持不变。

详见 [Publication Workflow](workflows/publication/README.md)。

## Candidate 的两个后续方向

### 直接发布

Publication 以 Candidate v2 为不可变输入。用户确认 component、精确 scope 和 target intent，Workflow 生成未授权 Draft Plan；目标检查后，用户再确认 exact Executable Plan hash。

### 选择性发布

Publication 可以选择 component 或包内具体 dataset：

```text
Candidate
  -> scope selection
  -> forward dependency expansion
  -> transitive reverse pruning for exclusions
  -> reference-complete effective set
  -> exact payload + Target Snapshot
  -> approved Executable Plan
  -> resumable execution + independent readback
```

剔除集合必须递归包含所有因此失去完整性的关联数据。原 Candidate、package 和上游 materialization 均保持不变。

### 再加工

Dataset Transformation 只能读取并验证 Candidate 数据，不能覆盖它。用户先确认 Unit Process 或 Result Process 加权语义：Unit Process 路线返回 Calculation 后重新产生 Result evidence；Result Process 路线产生 Derived Result 并返回 Result Materialization，不隐式聚合 LifecycleModel。两条路线最终都构建新的 Candidate。

## 共享边界

- Workflow 可以从已有精确资源或 artifact 继续，不要求从第一步重跑。
- 远程副作用、耗时计算、Candidate 范围、变换语义和正式发布都需要明确用户决定。
- 数值计算、格式验证、hash 和打包必须由确定性实现完成，不能由语言模型直接生成。
- 大型 artifacts 写入文件或对象存储，stdout 只返回有界摘要和引用。
- 其他系统能力不存在时报告 `capability_unavailable`，不扩大修改范围。
- Candidate 构建与 Publication 是不同权限边界；本地验证成功不能替代远程发布授权或独立回读。

## 当前实施状态

- Calculation 已实现 workflow-local ResultSet、Closure、计算任务、Bundle 数据面和 Worker 日志委托入口。
- Result Materialization 已实现 intake、Result Process/LifecycleModel 生成、验证和本地后台 Job。
- Release Candidate 已实现 Elementary Flow cache、Release Intake、Package build、失败影响分析、人工审核工作簿、scope decision 和 Candidate qualification。
- Dataset Transformation 已实现 DSL v0、Candidate v1/v2 精确读取、Unit/Result aggregation-target 决策、业务字段冲突决策、显式/年产量权重、加权 Unit/Result Process、LCI/LCIA 兼容性验证、条件 handoff、CLI、schemas、回复模板和真实三 Process 试验。
- Publication 已实现 Candidate v2 catalog、范围解析、精确 payload、目标检查、hash-bound Approval、可恢复远程发布、独立回读，以及显式 opt-in 的 Portal LCIA V3 package plan/publish 和 projection prepare/finalize/verify/revoke；两条路径各自使用严格 schemas、CLI、回复模板和 fail-closed 测试，Candidate 执行 adapter 继续只支持平台发布状态码 `100`。
