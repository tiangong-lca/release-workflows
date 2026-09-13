---
title: tiangong-lca-release Repository Contract
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
lastReviewedAt: 2026-09-13
lastReviewedCommit: ba2c97947a9be5d9e99e473963e7fbf6efbdf8b1
lastReviewedNote: "Release #72: reviewed canonical repository identity migration to tiangong-lca/release-workflows; stale feature/issue-59 branch and closed tracking-issue branch facts removed per live GitHub evidence; repo contract and hard boundaries unchanged."
related:
  - README.md
  - .docpact/config.yaml
  - docs/architecture.md
  - workflows/README.md
---

# Repository Contract

`tiangong-lca-release` 是面向人和 Agent 的本地数据产品工作台。它通过根目录 Workflow 组织 Calculation、Result Materialization、Release Candidate、Dataset Transformation 和 Publication，调用其他系统已经存在的能力，但不要求修改其他仓库。

## 当前实施基线

旧业务 `src/`、`scripts/`、`specs/`、`test/`、tsconfig 和 operator skill 已删除。根 `test/` 现在只拥有仓库级工具链、CI 和生产依赖图契约；不得在其中恢复旧 20-stage runtime、业务测试、默认兼容层或长期 legacy 目录。

后续工作一次只优化一个根 Workflow。新增业务实现、schema、fixture 或测试必须放在对应 `workflows/<name>/` 下，并遵守该目录的 README/AGENTS；只有跨 Workflow 的仓库工具链/自动化 contract test 放在根 `test/`。Calculation 的 ResultSet create/list/get 已按此结构实现；不得把它重新聚合到仓库级 CLI。

## 加载顺序

1. `AGENTS.md`：仓库所有权、硬边界和确认状态；
2. `README.md`：项目目标、五个 Workflow 和待确认点；
3. `.docpact/config.yaml`：机器可读 ownership、routing、coverage 和 rules；
4. `workflows/AGENTS.md`：所有 Workflow 的共享契约；
5. 目标 `workflows/<name>/AGENTS.md`；
6. 目标 `workflows/<name>/README.md`；
7. 只有在目标 Workflow 开始实现后，才读取该目录新增的源码、规格和测试。

## Workflow 结构

本仓库当前有五个顶层 Workflow：

- `workflows/calculation`：ResultSet、Closure、计算任务和 Calculation Bundle；
- `workflows/result-materialization`：Result Process、LifecycleModel、identity/version 和 canonical dataset collection；
- `workflows/release-candidate`：Release Intake、Package Plan、validation、失败修复范围决定和不可变 Candidate v2 handoff；
- `workflows/dataset-transformation`：Candidate-bound DSL v0、Unit/Result aggregation-target 决策、业务字段冲突、确定性加权执行、验证和条件 handoff；
- `workflows/publication`：Candidate-bound 范围解析、精确 payload、target inspection、hash-bound Approval、可恢复平台写入、状态转换和独立回读；另有显式 opt-in 的 Portal LCIA V3 package plan/publish 与 projection finalize/verify/revoke 编排，只调用 Database-owned actor RPC，不读取 private artifact；Candidate adapter 继续发布到 state code `100`。

完整性验证属于 Calculation；LCI/LCIA Result Process 生成和 LifecycleModel 组合属于 Result Materialization；Packaging 和 Candidate qualification 属于 Release Candidate。它们可以作为独立恢复节点或 recipe，但不是额外顶层 Workflow。Publication 不得在远程执行期间改变 Candidate 内容。

## 所有权

本仓库拥有：

- 根目录 Workflow 的说明、Agent 契约、产物、恢复和实现；
- 本地工作上下文、外部资源引用和 artifact lineage；
- Agent 对用户意图的整理、候选方案和待确认问题；
- 后续确认后的确定性 Transformation spec，以及当前 Package spec 的本地实现；
- Result Process、LifecycleModel、identity/version 和 canonical dataset collection 的确定性 materialization；
- Release Candidate、后续精确审批、发布编排和独立回读；
- `tiangong-release` 操作入口及其有界 JSON 输出。
- 面向批量、非常规数据处理的受控数据库/S3 数据面 adapter，包括参数化只读查询、本地 artifact 传输、完整性验证，以及后续明确授权的 staging 写入。
- Release-owned 缓存格式、远端只读导出编排、临时 S3 传输校验和本地原子安装；Worker EC2 只作为受管执行位置，不把缓存语义转交给 Worker 仓库。

本仓库不拥有：

- Next 页面行为；
- Worker 求解器和远程任务生命周期；
- Database schema、RLS、权限和发布事实；
- Edge Function 业务实现；
- 其他仓库的 CLI、TIDAS schema、SDK 或打包算法源码。

其他系统只作为外部能力被调用。缺少能力时停止并报告，不扩大修改范围。

## 硬边界

- 不把数据库连接串、S3 credential、Supabase service-role 或其他 secret 放入源码、stdout、命令参数或恢复产物。
- 允许所属 Workflow 通过 ignored `.env` 使用受控数据库/S3 数据面；SQL 必须参数化、有界并声明读写模式。未经 Workflow 契约和用户明确授权，不得直接修改 canonical 业务表；批量写入应采用 staging、验证和原子提升边界。
- 不导入其他 workspace 子仓的内部源码。
- 不解码、打印、持久化或放入命令参数的用户凭据。
- 不持久化 signed URL；本地批量 artifact 传输优先使用受控 S3 数据面，避免逐 artifact 签名。
- 临时 cache transfer 的 presigned URL 只可保存在当前进程内，不得进入 stdout、manifest、错误详情或恢复命令；成功安装前必须删除对应临时对象。
- 不从 mutable `latest` 推断缺失的 identity、version、graph 或 method。
- 不让 LLM 直接生成最终数值、hash 或发布证据。
- 不把 transport success 当作 domain validity、publication 或 readback success。
- 不把派生数据自动写入普通 authoring tables。
- 大型 artifacts 写入文件或对象存储，stdout 只返回有界摘要和引用。
- 未经精确内容和 target 审批不得远程发布。
- Release Candidate 一经冻结不得原地改写；Publication 可以用 hash-bound plan 选择引用完整的子集，但数据内容、identity、version 或 package 变化必须产生新 Candidate。
- Dataset Transformation 的 aggregation-target 未确认、业务字段差异和不兼容 selection 必须进入 `needs_decision`，不得作为 terminal failure；只有 hash drift、malformed contract、系统故障或生成结果缺陷使用技术异常。Publication 远程执行只能使用其 Workflow 已冻结的 actor-scoped、exact-plan-hash 和 independent-readback 契约，不得从根文档另行拼装写入。

## Runtime 与分支事实

- Node：精确 `24.19.0`
- package manager：精确 `pnpm@11.24.0`，六个 package 共用根 `pnpm-workspace.yaml` 和唯一 `pnpm-lock.yaml`；`engineStrict=true`、`strictPeerDependencies=true`、`sharedWorkspaceLockfile=true`、`savePrefix=""` 与 `pmOnFail=error` 必须由 workspace YAML 形成可被 `pnpm config list --location=project --json` 观察到的有效项目配置，不保留无效的项目 `.npmrc`
- 运行时：纯 JavaScript/MJS；不得为了工具链命名对齐引入 TypeScript、compiler 或 codegen
- CI：使用不可变提交的 `pnpm/setup` 一次安装精确 Node/pnpm，随后显式执行 frozen install；生产图审计只通过当前 pnpm JavaScript entry 和 `shell:false` 运行
- branch model：M1
- daily trunk / routine PR base：`main`
- 本地运行产物根目录：`.release/`，必须 gitignored
- 当前仓库验证门：`pnpm run prepush:gate`

## 文档规则

- 根 `README.md` 只描述当前项目目标和跨 Workflow 关系。
- `workflows/README.md` 只做 Workflow 导航。
- `workflows/AGENTS.md` 只拥有共享规则。
- 每个子 Workflow 的 `README.md` 和 `AGENTS.md` 只描述该 Workflow。
- 不把旧 20-stage 的纠正说明、事故或迁移叙事重新加入活动文档。
- 只有仍有用的安全原则可以转写为当前 Workflow 规则。

## 当前完成条件

- 旧 runtime 和耦合配置已删除；
- 根 README 清楚表达项目目标、五个 Workflow 和 Candidate 后的 Publication/Transformation 两个方向；
- 每个 Workflow 有 README 和 AGENTS；
- Docpact 能覆盖和路由 `workflows/**`；
- Calculation 的 ResultSet create/list/get、Closure/计算提交、数据库/S3 Bundle list/get/download 和 Worker 日志委托保持 workflow-local，确认、provider compatibility、参数化只读 SQL、artifact 完整性、内部最小引用、恢复和错误路径测试通过；
- Result Materialization 通过一个 workflow-local `materialize` 入口冻结 scope、最终对象和 Result Process 内容层；Result-only 不扩展 provider，LifecycleModel 在内部完成 Result Catalog 与 Model 收敛，并对多 exact axes 的 Result lineage 冲突 fail closed；
- Result Materialization 输出并由 manifest hash 绑定 canonical dataset index；Release Candidate 从不可变的 Materialization Intake 准备独立 Release Intake，按精确版本补齐 LCIA Method characterisation Flow，再组装本地 TIDAS 输入并委托 `tidas-tools` 验证、转换和生成四个 ZIP；
- Release Candidate 显式保持 `publicationAuthorized=false`，本地 package build 不构成审批或发布授权；
- preserved failed build 可生成完整 exclusion impact report；范围排除必须由 hash-bound decision 明确确认，并通过新的 Package Plan 重跑全部 validator，不能绕过错误或修改失败 Candidate；
- Dataset Transformation 的 aggregation-target recommendation/confirmation、inspect、`needs_decision`、Frozen DSL、加权 Unit/Result Process、validation receipt 和条件 handoff 真实可执行；Unit Process 路线不得复用旧 Result evidence，Result Process 路线只组合 hash-bound 兼容 Result；
- Publication 的范围规划、payload、target inspection、Approval、可恢复远程执行和 independent readback 真实可执行；没有 Readback Receipt 不得声称完成；
- 当前变更通过仓库门禁并形成独立 Git commit。
- Portal LCIA projection 在 exact Package Publication/Projection Plan 两次 confirmation、幂等远程写入和独立 current + publicly-visible readback 后才完成；中间和终态只追加统一 lifecycle event，revoke 绑定 exact finalized event 并以 revoked readback 完成，既有 Candidate Publication 回归保持全绿。
