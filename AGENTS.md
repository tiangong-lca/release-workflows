---
title: Release Workflows Repository Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当任务可能改变 Release 项目目标、根 Workflow、运行时、契约或验证时
  - 当从 lca-workspace 路由工作到本仓库时
  - 当需要决定一项能力属于本仓库还是外部系统时
whenToUpdate:
  - 当项目目标、Workflow 边界、所有权、分支策略或验证门变化时
  - 当 Docpact ownership、coverage、routing 或 rules 变化时
checkPaths:
  - AGENTS.md
  - README.md
  - .docpact/config.yaml
  - docs/architecture.md
  - workflows/**
  - test/**
  - package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - .node-version
  - .github/workflows/ci.yml
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: smaller stable context, scoped routing and truthful handoff boundaries; ownership, immutable evidence and authorization constraints are retained."
related:
  - README.md
  - .docpact/config.yaml
  - docs/architecture.md
  - workflows/README.md
---

# Release Workflows — Repository Contract

本仓库是本地数据产品工作台，拥有 Workflow 编排、确定性本地产物、证据与恢复入口；外部系统继续拥有计算、鉴权、数据库和远程发布事实。

## 入口与加载

- `workflows/README.md`：选择 Calculation、Result Materialization、Release Candidate、Dataset Transformation 或 Publication。
- 进入目标 Workflow 时，读取 `workflows/AGENTS.md`、该目录 `AGENTS.md` 和与当前动作相关的 README 章节；按其指针读取专门契约。
- 编码或 Review 前核对相关源码、schema 和测试；文档描述的路线不等于接收端已实现。
- 工作区内使用根 `scripts/docpact route --root <本仓库绝对路径> --paths <目标路径> --format json`，读取返回的必要文档。治理配置交给工具解析，调整治理规则时才直接读取 `.docpact/config.yaml`。
- 跨 Workflow 的拓扑或所有权决策读取 `docs/architecture.md`；开发交付与分支策略遵循 workspace 契约。独立 checkout 不具备 workspace wrapper 时，明确报告缺失，不猜测替代入口。

## 所有权与硬边界

- 业务实现、schema、fixture 和测试属于 `workflows/<name>/`；根 `test/` 只拥有仓库工具链和跨 Workflow 自动化契约。操作入口保持 workflow-local。
- 调用外部公开 API、CLI 或受控数据面 adapter；不导入子仓内部源码。外部能力不足时报告 blocker，不自行扩大仓库范围。
- 确定性实现生成最终数值、hash 和验证证据；Agent 整理意图和提出建议，不能模拟结果或把建议当作授权。
- 使用精确 identity、version、hash 和 target；不得通过 mutable `latest` 补齐缺失证据。
- Candidate 与冻结证据不可原地改写。内容、identity、version 或 package 变化必须生成新 Candidate；Publication 只可选择引用完整的子集。
- 发布必须绑定精确内容、target 和审批，并以独立回读证明完成。transport success、本地打包成功均不能替代发布事实。具体授权与执行规则只按 Publication 契约实施。
- 凭据不得进入源码、stdout、命令参数或恢复产物；用户凭据不得解码、打印或持久化，signed URL 只可存于当前进程。ignored `.env` 的数据库/S3 配置只能由所属 Workflow 的受控 adapter 使用；SQL 参数化、有界并声明模式，canonical 写入需要契约及明确授权。
- 大型产物保存为文件或对象；stdout 只返回有界摘要及引用。本地运行产物默认放在 gitignored `.release/`。

## 开发与验证

- JavaScript/MJS；不为工具链对齐引入 TypeScript、compiler 或 codegen。
- 精确 Node 版本读 `.node-version`，package manager 读根 `package.json`；workspace 策略读 `pnpm-workspace.yaml`，全仓只维护一个 lockfile。
- 仅在仓库根安装：`pnpm install --frozen-lockfile`。
- 仓库验证门：`pnpm run prepush:gate`；局部测试入口读目标 package 的 `scripts.test`。
- 发布 live 验收是单独的 opt-in 操作，按 `workflows/publication/live/README.md` 执行；离线测试不证明 live 发布成功。

## 文档维护

每个事实只指定一个维护源：manifest/config/schema/test 拥有可执行事实，Workflow 契约解释语义和原因。根文档只保留稳定边界和导航；实现状态、迁移清单及当次任务验收留在对应 Issue/PR，不累计到本文件。
