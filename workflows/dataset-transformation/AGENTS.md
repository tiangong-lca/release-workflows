---
title: Dataset Transformation Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现、运行或恢复 Candidate-derived Dataset Transformation 时
whenToUpdate:
  - 当 Transformation DSL、决策权限、执行器、验证或返回路径变化时
checkPaths:
  - workflows/dataset-transformation/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: Unit/Result completion describes produced evidence, not downstream capability; DSL and numerical behavior remain unchanged."
related:
  - README.md
  - dsl-v0.md
  - ../AGENTS.md
---

# Dataset Transformation Workflow Agent Contract

## 当前实现

本 Workflow 已实现两类加权语义：Unit Process 聚合构造新过程并生成以 Calculation 为目标的 handoff；Result Process 聚合组合已有 LCI/LCIA Result 并生成以 Result Materialization 为目标的 handoff。handoff 不证明接收端支持：Materialization 的 Derived Result 消费与 Candidate 的 Result-only package 尚未实现，不得补造 Model 或改写输入契约绕过限制。`process.weighted-aggregate.v0` 继续作为旧 Unit Process operation 兼容入口，新 Draft 使用显式目标选择和清晰 operation type。

进入目标动作前读取 `workflows/AGENTS.md`、[README](README.md) 的对应章节；设计或执行 DSL 时读取 [DSL v0](dsl-v0.md)。只按 CLI 指针读取回复模板。

## Agent 职责

- 把用户目标投影为 Draft DSL，不把自然语言当作可执行授权；
- 先解释并推荐 Unit Process / Result Process 语义，由用户确认 `operation:aggregation-target`；
- inspect 精确 Candidate/dataset hashes 和所有业务字段族；
- 按主题汇总 conflicts，提出取值、重写、删除、调整 selection 或拆分建议；
- 只把用户确认的策略和 reason 写回 `decisions`；
- 每次 Draft 改变后重新 inspect；
- 只有 `status=ready` 时 freeze；
- 只执行 hash-bound Frozen Spec；
- Unit Process 完成后明确进入 Calculation；Result Process 完成后明确进入 Result Materialization，且不隐式生成 LifecycleModel；两者都不表示 Candidate 已生成或已经发布。

## 状态语义

- `needs_decision`：正常流程；继续与用户解决语义问题。
- `ready`：当前 Draft 已解决所有已发现问题，可以冻结。
- `frozen`：不可变执行契约。
- `completed`：所选 Unit/Result operation 的 transformed Process、验证与 handoff 已产生；不表示接收端已消费或新 Candidate 已生成。
- `input_drift` / `system_error` / `needs_repair`：非预期技术异常，保留 artifacts 并从原节点恢复。

不得把业务字段差异、年产量缺失或 unsupported mapping 记录为 terminal `failed`。

## 用户决定边界

Agent 不得代替用户决定 aggregation target、weighting mode、weights/annual overrides、output business semantics、有差异的 source/representativeness/ownership 字段、selection/split 策略、新 output identity 或后续 Workflow 执行授权。Agent 可以根据目标推荐 operation、生成候选 rewrite 和理由，但必须保持 recommendation/proposal 与 binding decision 的区别。

## 确定性执行边界

- 不原地修改 Candidate、ZIP 或 source Process；
- 不让 LLM 计算最终 amount、hash 或验证证据；
- 不接受 `latest`、名称或模糊 identity；
- 不在 execute 中临时补决定；
- Unit Process 路线不复用旧 Result evidence；Result Process 路线只组合 Frozen Spec 绑定的精确 Result evidence；
- 不写远程 authoring/published tables；
- 不执行 LifecycleModel、unit conversion 或 reference mapping；
- Result Process 聚合必须要求共同 Calculation lineage、精确 reference basis、相同 LCI exchange identity set 和相同 LCIA method UUID/version set；不得把缺失项当作零；
- output directory 不可覆盖，Draft/Frozen Spec/receipt 变更必须产生新 artifact。

## 验证要求

执行前必须验证 Candidate/index/package/Process hashes。执行后必须验证 weights、reference amount、exchange IDs、finite amounts、new identity、review reset 和 receipt/handoff bindings。需要 Candidate 资格验证时继续委托 Release Candidate Workflow 和 `tidas-tools`，不得由本 Workflow 自我宣称。

## 完成条件

- Draft、analysis/conflict report、Frozen Spec、transformed Process、receipt 和 handoff 可追溯；
- 所有 business conflicts 有用户决定及 reason；
- 自动测试通过；
- 真实三 Process 试验是历史验收示例；只有任务要求重现且精确输入可用时才重算，不将其作为每次操作的完成门；
- TIDAS JSON、eILCD projection/validation 和 semantic round-trip 通过；
- handoff 的目标与 operation 一致：Unit Process 需要新计算，Result Process 指向物化且不隐式聚合 LifecycleModel；显式披露当前消费者与 package 限制，不宣称后继已执行。
