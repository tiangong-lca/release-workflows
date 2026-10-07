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
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: smaller stable context, scoped routing and truthful handoff boundaries; ownership, immutable evidence and authorization constraints are retained."
related:
  - AGENTS.md
  - docs/architecture.md
  - workflows/README.md
---

# TianGong LCA Release Workflows

本仓库是面向人和 Agent 的本地数据产品工作台，调用外部系统已有能力，保存精确输入、用户决定、验证证据、输出与恢复入口。它不拥有求解器、数据库 schema、鉴权或远程发布事实。

## 选择 Workflow

| Workflow                                                             | 当前职责与入口                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Calculation](workflows/calculation/README.md)                       | ResultSet、Closure、计算任务、Calculation Bundle 下载与完整性验证                                |
| [Result Materialization](workflows/result-materialization/README.md) | 从已验证 Calculation Bundle 生成 Result Process / LifecycleModel 与 canonical dataset collection |
| [Release Candidate](workflows/release-candidate/README.md)           | 闭合输入、四包验证、失败影响分析与不可变 Candidate                                               |
| [Dataset Transformation](workflows/dataset-transformation/README.md) | Candidate 中精确 Unit/Result Process 的语义决策、确定性加权、验证与 handoff                      |
| [Publication](workflows/publication/README.md)                       | Candidate 精确范围、审批、可恢复发布与独立回读；另有 opt-in Portal LCIA recipe                   |

默认路径：

```text
Calculation -> Result Materialization -> Release Candidate -> Publication
                                              |
                                              +-> Dataset Transformation
                                                  -> validated output + handoff
```

Candidate 构建不构成发布授权。Publication 可选择引用完整的子集，但不能修改 Candidate；内容变化需要新的 Candidate。

## 当前交接限制

Transformation 的 inspect、freeze、execute 已实现；其 `completed` 只证明本节点产物和 handoff 已生成。Unit 聚合使旧 Result evidence 失效，需要新的计算；Result 聚合产生 Derived Result，不重新求解或补造 LifecycleModel。

**后继路线不是现成的自动闭环。** Materialization 当前入口只消费 Calculation Bundle intake，尚未消费 Transformation 的 Derived Result handoff；Release Candidate 当前只支持 LifecycleModel full-closure profile，拒绝 Result-only materialization。进入后继 Workflow 前应核对其真实输入契约；不能通过重命名产物、复用旧证据或补造 Model 绕过限制。具体节点和限制由各 Workflow 文档维护。

## 开发与阅读

Agent 从 [AGENTS.md](AGENTS.md) 进入，按路径读取 scoped contract。根 [Workflow 导航](workflows/README.md) 帮助选择动作；跨 Workflow 所有权、证据与交接设计见 [architecture](docs/architecture.md)。操作命令在各 Workflow README 与 CLI help 中维护。

精确工具链以 `.node-version` 和根 `package.json` 为准；安装及验证入口见根 AGENTS。运行产物放在 ignored `.release/`。机密配置仅按 `.env.example` 和所属 Workflow 契约使用，不加入源码或运行证据。
