---
title: Calculation Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Calculation Workflow 时
whenToUpdate:
  - 当入口解析、远程命令、证据绑定、恢复或确认规则变化时
checkPaths:
  - workflows/calculation/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: scoped reading and profile authority; existing task, Bundle and monitoring contracts retain their runtime behavior."
related:
  - README.md
  - ../AGENTS.md
---

# Calculation Workflow Agent Contract

## 加载顺序

1. `workflows/AGENTS.md` 与本文件；
2. 本目录 `README.md` 中对应 ResultSet、任务、Bundle 或环境同步的章节；
3. CLI 返回 `replyTemplate` 时读取指定模板；调用外部能力时读取其最小版本契约。

只在需要跨 Workflow 选择时读取根导航；默认方法集与展示类别以 `contracts/default-profile.mjs` 为准，修改时核对其契约测试。

## Agent 必须先做的事

- 解析用户提供的是名称、ResultSet、Closure、Job、Package 还是 Bundle。
- 如果名称对应多个对象，停止并要求精确选择。
- 读取权威远程状态，不根据本地旧摘要猜测。
- 输出当前已有证据、仍需决定的问题、允许动作和阻塞动作。

## 可自动执行的只读动作

- 查询已有对象和任务；
- 读取有界报告和 artifact metadata；
- 下载用户已经明确要求的产物；
- 校验大小、hash、版本和 manifest 引用；
- 恢复一个已有任务的状态观察。

## ResultSet 操作入口

- 从仓库根目录使用 `node workflows/calculation/cli.mjs ...`，或在本目录使用 `node cli.mjs ...`；CLI script 和命令实现都由本目录拥有，不得提升为仓库级 `tiangong-release` CLI。
- CLI help 与 `nextActions` 必须使用由 `import.meta.url` 求得的绝对入口，保证复制命令不依赖调用者 cwd；不得把相对 `npm --prefix workflows/calculation` 作为 Agent-facing 恢复命令。跨到 `workspace_ops` 时必须在命令中显式进入 workspace 根目录。
- `list` 默认最多返回 20 条，最大 200 条，并把无 cursor 的结果标记为 bounded。
- `get` 必须使用精确 `resultSetId`；不得按名称隐式选择。
- `create` 必须在用户确认精确名称后使用 `--confirm-create`。
- 用户未提供名称时，推荐 Asia/Shanghai `ResultSet-YYYYMMDD-HHmm` 并返回确认命令；不得静默采用推荐值或在推荐阶段访问远程能力。
- JSON stdout 必须保持 `tiangong.calculation-cli-result.v1` 可解析；诊断不得混入 stdout。
- 每个 CLI 结果必须返回 `replyTemplate` 的稳定 ID、路径、Markdown 格式、占位符语法和 required facts。Agent 应从可复制正文模板开始，用真实结果替换全部占位符、删除不适用条件行，不让模板覆盖 CLI/远程事实。
- `nextActions` 必须按当前状态指向正确的后继节点：需要人工决定时同时返回明确确认提示；可继续执行时使用精确 identity 和 cwd-independent 命令；不得用泛化说明代替导航，也不得从列表中静默选择第一项。
- provider payload 只在 adapter 中解析；外部新增字段或非破坏性版本变化不得使 Workflow 失败。
- Workflow、CLI 和恢复文件只使用 `id`、`name`、nullable `createdAt` 和来源元数据组成的内部 ResultSet 引用。
- 外部 `schemaVersion` 只作为可选观察信息，不得成为 Workflow 分支条件。
- 创建或读取成功后保存最小本地恢复引用，不保存凭据或 signed URL。
- 创建请求发生 transport failure 或远程 5xx 时返回 `remote_outcome_unknown`，先查询远程状态，不自动重试。
- Closure/Calculation `start` 必须显式确认并携带幂等 token/key；内部只投影稳定 job/resource identity，不以 provider `schemaVersion` 分支。
- Closure 完成后使用精确 ID 的 `closure get` 读取生命周期、证书、Worker identity 和 Calculation binding；只有 `passed + complete + valid` 且 `requestedScopeHash`/`policyFingerprint` 齐全时才能提示计算就绪。provider 未返回 method/process identity 时必须披露这一信息并要求沿用原 Closure scope，不得从 `latest` 猜测。
- Calculation 提交只要有稳定 Worker Job ID 即视为 `submitted`；结果资源未 materialize 时使用 nullable `resourceId` 与 `identityCompleteness=job_only`。Closure 仍要求 Closure/Job 双身份；不得因异步结果 ID 暂缺误报 `remote_outcome_unknown`。
- 未显式选择时使用 `contracts/default-profile.mjs` 的 coverage、完整 reviewed LCIA `{id, version}` 集合及独立的默认展示类别；Closure 与 Calculation 必须使用同一完整方法集。输出必须披露 defaulted inputs，显式参数优先。
- Worker job 日志必须委托给根 workspace 的 `python -m workspace_ops.cli worker job`；本 Workflow 只输出精确命令，不复制服务器配置、SSH 或 journal 逻辑。
- Calculation 日常状态观察必须先使用精确 Job ID 的 actor-scoped 数据库 task feed；queued/running 继续轮询该投影，只有 failed/blocked/stale 或 Worker/domain 终态不一致时才把 `workspace_ops` 日志列为优先诊断动作。日志不得覆盖数据库投影的产品状态权威性。
- Closure/Calculation 提交后的首要后继分别是精确 `closure get` 和 `calculation get`；Worker 日志只作为第二诊断动作。Calculation 成功终态且已有 `resultPackageId` 时必须前进到精确 Calculation Bundle，不得退回 ResultSet。
- Closure/Calculation 提交后仍为 queued/running 时，必须展示 `nextDecision` 和 `nextActions` 中的持续监测询问：是否创建定时任务或进程，仅在完成、失败、阻塞或需要用户处理时通知，并在任务终态停止监测。询问不代表监测已经创建；只有用户确认后才创建。终态复用任务不询问持续监测。
- Calculation Bundle list/get 使用 `CONN` 的参数化 read-only SQL；list 必须有 1–200 的显式边界，get 必须使用精确 Package UUID。不得调用会下载 manifest 并逐 artifact 签名的 Edge Bundle read，也不得把连接串、artifact locator 或 credential 投影到 CLI。
- Calculation Bundle list 只负责展示候选并要求用户选择精确 `packageId`；即使列表非空也不得默认下载第一项。
- Bundle download 使用数据库中的精确 manifest/download metadata 和 allowlisted `S3_*` 配置直接访问单一配置 bucket；先校验 manifest size/hash/schema/content hash/artifact count，再以 1–32 的有界并发下载并校验每个 artifact。已存在文件只有完整性一致时才可复用，不一致时不得覆盖。
- workspace → Release 环境同步只复制缺失的 `CONN`/`S3_*` 白名单，必须显式 `--confirm-sync`，不得打印值或覆盖 Release `.env` 中已有的非空值。
- `workspace_ops qualification` 只用于生产等价发布资格门禁，不得当作线上 Closure Check 提交能力。

## 需要明确确认的动作

- 创建 ResultSet；
- 启动 Closure Check；
- 启动计算任务；
- 改变 scope、方法集或有效证据绑定；
- 创建会取代已有业务对象的新计算分支。

## 硬边界

- 不实现求解器或复制 Worker 逻辑。
- 不在 Calculation Workflow 中生成 Result Process、LifecycleModel 或 package。
- 不从 mutable `latest` 推断缺失身份、版本或计算输入。
- 不把任务 transport success 当作 domain validity。
- 不把 Closure warning 自动解释为可忽略。
- 不持久化 signed URL、access token、用户 API key、数据库连接串、S3 credential 或内部 object locator；本地 receipt 只保存稳定 identity、hash、数量、验证状态和本地路径。
- 认证优先使用显式 actor JWT；否则从 `TIANGONG_LCA_API_KEY` 交换进程内短期 session。不得把 user API key 直接当 bearer、输出 token、建立第二套持久 session cache，或在不同 API key 间静默回退。
- 不因外部能力缺失修改其他仓库。

## 完成条件

用户请求的终点已满足，并且另一位 Agent 能根据精确资源引用、当前状态和证据继续；如果用户只要求验证或启动任务，不应强制继续到下载。
