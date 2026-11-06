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
lastReviewedAt: 2026-11-06
lastReviewedCommit: 454db011153b5298c3c484708a497a30fd49ac45
lastReviewedNote: "Release #124: reviewed Result-only roots, typed Process support closure, paired archive/query coverage and isolated reader/download/rollback proof."
related:
  - ../README.md
  - AGENTS.md
---

# Workflows

| 目标                                                          | 入口                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| 创建/查询 ResultSet、检查 Closure、提交/跟踪计算、下载 Bundle | [Calculation](calculation/README.md)                       |
| 从 Bundle 生成 Result/Model，或接收精确加工后 Derived Result  | [Result Materialization](result-materialization/README.md) |
| 补齐输入、验证打包、审核失败影响、冻结 Candidate              | [Release Candidate](release-candidate/README.md)           |
| 对 Candidate 中的 Unit/Result Process 做语义决策与加权        | [Dataset Transformation](dataset-transformation/README.md) |
| Candidate 发布，或 opt-in Portal LCIA package/projection 操作 | [Publication](publication/README.md)                       |

进入目标目录，读取本目录 [AGENTS.md](AGENTS.md)、目标 AGENTS 和当前动作对应的 README 章节。CLI 返回 `replyTemplate` 时只读取指定模板，以真实结果填充。

主线及当前跨 Workflow 能力限制见[根 README](../README.md#当前交接限制)。handoff 只表达目标与证据；执行前必须验证接收端确实支持该输入，不把导航或建议当作授权。

最终 Result 的查询投影与原生 HDF5 编码由 [Release Candidate](release-candidate/README.md) 拥有。它与计算解耦；本地编码证据不替代 ZIP、Candidate 或 Publication 门禁。

Publication 的最终 Result v3 `result-storage inspect/execute` 消费冻结 Candidate，负责精确计划确认、不可覆盖上传、完整 GET 和 Database v2 存储登记；用户发布选择、批准和激活通过独立意图确认入口执行，`result-publication readback` 已接通公开数值/ZIP 回读与不可变凭证，详见其 README 的 recipe 边界。
