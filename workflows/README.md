---
title: Release Workflows 导航
docType: index
scope: workflows
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当需要选择或组合一个 Release Workflow 时
whenToUpdate:
  - 当顶层 Workflow 新增、删除、重命名或重新划分时
checkPaths:
  - workflows/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: smaller stable context, scoped routing and truthful handoff boundaries; ownership, immutable evidence and authorization constraints are retained."
related:
  - ../README.md
  - AGENTS.md
---

# Workflows

| 目标                                                           | 入口                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| 创建/查询 ResultSet、检查 Closure、提交/跟踪计算、下载 Bundle  | [Calculation](calculation/README.md)                       |
| 从 Calculation Bundle 生成标准 Result Process / LifecycleModel | [Result Materialization](result-materialization/README.md) |
| 补齐输入、验证打包、审核失败影响、冻结 Candidate               | [Release Candidate](release-candidate/README.md)           |
| 对 Candidate 中的 Unit/Result Process 做语义决策与加权         | [Dataset Transformation](dataset-transformation/README.md) |
| Candidate 发布，或 opt-in Portal LCIA package/projection 操作  | [Publication](publication/README.md)                       |

进入目标目录，读取本目录 [AGENTS.md](AGENTS.md)、目标 AGENTS 和当前动作对应的 README 章节。CLI 返回 `replyTemplate` 时只读取指定模板，以真实结果填充。

主线及当前跨 Workflow 能力限制见[根 README](../README.md#当前交接限制)。handoff 只表达目标与证据；执行前必须验证接收端确实支持该输入，不把导航或建议当作授权。
