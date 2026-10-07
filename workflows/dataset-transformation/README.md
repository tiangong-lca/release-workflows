---
title: Dataset Transformation Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户需要基于 Release Candidate 中的精确 Process 执行受控加权聚合时
  - 当需要恢复 Transformation inspect、decision、freeze 或 execute 节点时
whenToUpdate:
  - 当支持的加工机制、DSL、冲突策略、验证或返回路径变化时
checkPaths:
  - workflows/dataset-transformation/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: Unit/Result completion describes produced evidence, not downstream capability; DSL and numerical behavior remain unchanged."
related:
  - AGENTS.md
  - dsl-v0.md
  - ../release-candidate/README.md
  - ../../README.md
---

# Dataset Transformation Workflow

## 当前能力

Dataset Transformation 是 Release Candidate 完成后的可选再加工入口。加权操作先由 Agent 说明并推荐目标层，用户确认后进入对应路线：

```text
Validated Candidate v1/v2
  -> Draft DSL
  -> choose Unit Process or Result Process semantics
  -> exact input inspection
  -> conflict report / needs_decision
  -> Agent + user decisions
  -> Frozen Spec
  -> deterministic weighted Unit/Result Process
  -> validation + lineage + handoff
  -> intended next consumer (must support the exact handoff)
```

支持：

- 两个或更多精确 Unit Process，或两个或更多兼容的 Result Process；
- Draft 中的 Agent recommendation、`operation:aggregation-target` 用户确认和 Frozen operation type；
- 显式正权重；
- `annualSupplyOrProductionVolume` 年产量权重和有 evidence 的逐项 override；
- 完整业务字段族比较；
- `take-from`、`rewrite`、`drop` 和年产量 `sum-resolved` 决定；
- 定量参考归一化后的 exchange 加权；
- Result Process 的共同 Calculation lineage、精确 exchange set 和 LCIA method UUID/version set 检查；
- LCI exchange 与 LCIA result 的确定性加权；
- 新 identity、review reset、lineage、execution receipt 和 operation-specific handoff；
- Release Candidate v1/v2 读取，便于已有验证 Candidate 与新 Candidate 共同使用。

DSL 详细语义见 [Dataset Transformation DSL v0](dsl-v0.md)。

## 核心原则

业务字段不同、年产量缺失、取值不明确或当前 operation 无法表达时，状态是 `needs_decision`，不是失败。Agent 必须展示精确 source values、可选策略和影响；用户决定写回 Draft DSL 后重新 inspect。

错误只保留给 malformed contract、Candidate/input drift、运行时故障或确定性生成结果未通过检查。这些异常从原节点诊断和恢复，不被伪装成业务冲突。

## 产物

| 节点           | Artifact                                                                                    | 可变性                         |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------------------ |
| Agent/用户协商 | Draft DSL JSON                                                                              | 可修改；修改后必须重新 inspect |
| inspect        | `transformation-analysis.json`、`conflict-report.json`                                      | 绑定 Draft/Candidate hash      |
| freeze         | `transformation-frozen-spec.json`                                                           | 不可原地修改                   |
| execute        | transformed Process、`transformation-execution-receipt.json`、`transformation-handoff.json` | 不可原地修改                   |

大型 Candidate 和 Process bytes 继续保存在 ignored `.release/`；CLI stdout 只返回有界摘要和 artifact 路径。

## 状态模型

```text
analyzing
  -> needs_decision -> analyzing
  -> ready -> frozen -> executing -> validating -> completed
```

`needs_decision` 可以反复出现：一个决定可能暴露新的兼容性或字段问题。不存在业务语义上的 terminal `failed` 状态。

## 数值执行

对输入 `i`，先用其精确参考 exchange amount `rᵢ` 归一化，再应用 normalized weight `wᵢ`：

```text
output(g) = Σᵢ wᵢ × input(i, g) / rᵢ
```

exchange 按 Flow UUID/version、direction、location、function type 分组。输出参考 amount 必须为 1。旧 uncertainty 与 allocation 不会被误当作聚合后的统计结论，必须按 v0 policy 重置。

## Result evidence 与返回路径

完成只证明本节点的输出与 handoff；不表示接收端已实现、Candidate 已形成或已经发布。以下是由冻结 operation 指定的目标路线，执行前须核对接收能力：

```text
unit-process.weighted-aggregate.v1
  -> Calculation -> Result Materialization -> Release Candidate

result-process.weighted-aggregate.v0
  -> Result Materialization -> Release Candidate
```

Unit Process 路线改变过程清单语义，因此父 Candidate 中已有 Result Process/LifecycleModel evidence 标记为 `invalidated`。Result Process 路线把输入 Result evidence 标记为 `derived`，不重新调用 Worker，也不隐式聚合 LifecycleModel。父 Candidate 不被覆盖；新 Candidate 必须绑定 Transformation Frozen Spec、Execution Receipt 和对应的新计算或物化证据。

**当前限制：** Materialization 尚未实现 Derived Result handoff 消费，当前入口仍是 Calculation Bundle intake；Candidate 只接受 LifecycleModel full-closure profile，Result-only 输入会被拒绝。Unit handoff 也不能直接作为 Calculation API 输入，必须先满足其业务对象和授权契约。不要将目标路线当作自动可执行闭环。

## CLI

```bash
node workflows/dataset-transformation/cli.mjs dsl inspect \
  --candidate <candidate-dir> --dsl <draft.json> --out-dir <analysis-dir> --json

node workflows/dataset-transformation/cli.mjs dsl freeze \
  --candidate <candidate-dir> --dsl <draft.json> \
  --analysis-dir <analysis-dir> --out-dir <frozen-dir> --json

node workflows/dataset-transformation/cli.mjs transform execute \
  --candidate <candidate-dir> --spec-dir <frozen-dir> \
  --out-dir <execution-dir> --json
```

## 验证与示例

自动测试覆盖 aggregation-target 选择、business conflict、Unit/Result 三 Process 归一化加权、LCIA method 对齐、年产量缺失/sentinel 与 evidenced override、Candidate drift、条件 handoff、CLI 有界输出和回复模板。

真实 Candidate 试验见 [三个相近 Process 的聚合示例](examples/three-process-electricity/README.md)。同一组三省数据同时覆盖 Unit Process 路线和具有 405 个 exchanges、25 个 LCIA methods 的 Result Process 路线。

## 暂不支持

- LifecycleModel 聚合或 composite model；
- reference Flow mapping 和单位换算；
- 任意表达式、脚本或 JSON patch；
- 通用 uncertainty 合并；
- 远程 authoring、Candidate 构建或 Publication side effect。

这些能力需要新的 operation/version 和对应真实证据，不能通过扩大 v0 隐式语义加入。
