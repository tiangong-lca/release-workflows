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
lastReviewedAt: 2026-09-15
lastReviewedCommit: c7f62de
lastReviewedNote: "Reviewed for Release #74: the Publication navigation row only. Workflow set and default path unchanged."
related:
  - ../README.md
  - AGENTS.md
---

# Workflows

本目录是 Release 项目的主要入口，不是脚本集合。

| Workflow                                                   | 解决的问题                                                                                                                             | 主要输出                                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Calculation](calculation/README.md)                       | 从 ResultSet/Closure/任务接入，完成验证、计算与下载                                                                                    | Closure evidence、Calculation Bundle                                                                                                                       |
| [Result Materialization](result-materialization/README.md) | 将冻结结果组装为标准 Process/LifecycleModel                                                                                            | Canonical datasets、identity/version plan、manifest                                                                                                        |
| [Release Candidate](release-candidate/README.md)           | 准备闭合输入，验证、打包并冻结不可变 Candidate                                                                                         | Release Intake、Package Plan、Scope Decision、Candidate                                                                                                    |
| [Dataset Transformation](dataset-transformation/README.md) | 选择 Unit/Result 语义，用 DSL 解决冲突并加权精确 Process                                                                               | Frozen Spec、transformed Process、conditional handoff                                                                                                      |
| [Publication](publication/README.md)                       | 消费不可变 Candidate 并按 dataset role 确认发布终态；按 opt-in recipe 发布 V3 LCIA package 并 finalize/verify/revoke Portal projection | 混合状态 Draft/Executable Plan、Approval + Manager Attestation、Result Process Preparation、Execution/Readback Receipt、Portal LCIA Plans/Lifecycle Events |

默认主线是 `Calculation -> Result Materialization -> Release Candidate`。Candidate 完成后进入 Publication 做全量或选择性的依赖闭合范围规划，或进入 Dataset Transformation 再加工并生成新 Candidate。任何分支都不得原地修改已有 Candidate。

Agent 进入具体 Workflow 前，先读取：

1. 根目录 `README.md`；
2. 本目录 `AGENTS.md`；
3. 目标 Workflow 的 `AGENTS.md`；
4. 目标 Workflow 的 `README.md`。
