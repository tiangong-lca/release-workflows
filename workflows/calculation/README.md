---
title: Calculation Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户需要创建或接入 ResultSet、执行完整性验证、计算或下载结果时
whenToUpdate:
  - 当 Calculation 的入口、用户决定、远程能力或产物变化时
checkPaths:
  - workflows/calculation/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: scoped reading and profile authority; existing task, Bundle and monitoring contracts retain their runtime behavior."
related:
  - AGENTS.md
  - ../../README.md
---

# Calculation Workflow

## 目标

把用户的计算意图连接到现有 TianGong LCA 线上能力，并在本地留下可恢复、可验证的计算上下文和产物。

完成状态不是“所有步骤都执行过”，而是用户指定的计算结果已经由权威远程任务产生，所需产物已下载并通过完整性校验。

## 可以从哪里开始

- 只有一个新的计算意图和 ResultSet 名称；
- 已有 ResultSet；
- 已有 Closure Check；
- 已有 Closure Report/Certificate；
- 已有计算任务或 Worker Job；
- 已有 Result Package；
- 已有本地或远程 Calculation Bundle。

Workflow 首先识别当前入口，不能要求用户为了流程完整而重新创建已有对象。

## 主路线

```text
识别入口
  -> 创建或接入 ResultSet
  -> 确认 scope / LCIA methods
  -> 询问是否启动完整性验证
  -> 跟踪 Closure Check
  -> 展示报告和阻塞项
  -> 询问是否启动计算
  -> 跟踪计算任务
  -> 下载并验证 Calculation Bundle
```

每个箭头都是可恢复节点，不是强制 stage number。

## Workflow-local CLI

Calculation 的操作入口由本目录拥有，不通过仓库级 `tiangong-release` CLI 聚合：

```bash
node workflows/calculation/cli.mjs result-set list --limit 20
node workflows/calculation/cli.mjs result-set get --result-set-id <uuid>
node workflows/calculation/cli.mjs result-set create --name <name> --confirm-create
node workflows/calculation/cli.mjs closure start --coverage-mode global_eligible --method <uuid>@<00.00.000> --idempotency-token <token> --confirm-start
node workflows/calculation/cli.mjs closure get --closure-check-id <uuid>
node workflows/calculation/cli.mjs calculation start --name <name> --closure-check-id <uuid> --requested-scope-hash <hash> --policy-fingerprint <hash> --coverage-mode global_eligible --method <uuid>@<00.00.000> --idempotency-key <key> --confirm-start
node workflows/calculation/cli.mjs calculation get --job-id <uuid>
node workflows/calculation/cli.mjs calculation-bundle list --limit 20
node workflows/calculation/cli.mjs calculation-bundle get --package-id <uuid>
node workflows/calculation/cli.mjs calculation-bundle download --package-id <uuid> --concurrency 8
node workflows/calculation/cli.mjs environment sync --confirm-sync
node workflows/calculation/cli.mjs worker logs --job-id <uuid>
```

上面的便携写法以仓库根目录为起点；如果当前目录已经是 `workflows/calculation`，可使用 `node cli.mjs ...`。CLI 自己在 help、错误恢复和 `nextActions` 中输出当前机器上的绝对 `cli.mjs` 路径，因此这些返回命令可以从任意工作目录直接复制执行，不使用 cwd-sensitive 的 `npm --prefix workflows/calculation`。委托 `workspace_ops` 的 Worker 日志命令也会显式进入 workspace 根目录。

所有命令都支持 `--format json`。JSON stdout 使用
`tiangong.calculation-cli-result.v1`，包含结果、完整性、错误和下一步，不混入日志。
每次动作还返回 `replyTemplate`，其中包含稳定模板 ID、仓库相对路径、Markdown 格式、占位符
语法和回复所需事实；Agent 应读取 `reply-templates/` 下可直接填值的正文模板，再基于本次真实
结果替换 `{{...}}`、删除不适用的条件行并回复用户。

回复模板是 F2 回复草稿，不是远程事实或固定渲染 schema。模板提供固定段落与状态 emoji，并
控制如何区分提交与完成、下一步如何表达；CLI 结果继续作为事实来源。

ResultSet 创建或读取成功后，CLI 同时返回 `nextDecision` 和绑定精确 `resultSetId` 的 Closure
命令。回复必须先询问用户是否采用 `global_eligible + 25 个 reviewed LCIA 方法`；只有用户确认后
才执行该命令。需要确认的节点以决定提示导航，可执行节点以精确命令导航，两者不能互相替代。

外部 ResultSet payload 先由 adapter 转换为 Calculation 自有的最小引用：

```json
{
  "id": "<uuid>",
  "name": "<display name>",
  "createdAt": "<timestamp-or-null>",
  "source": {
    "system": "tiangong-lca",
    "externalSchemaVersion": "<observed-version-or-null>"
  }
}
```

Workflow 不依赖某个固定的外部 `schemaVersion`，也不要求 provider payload 只能包含一组精确字段。adapter 忽略附加字段，兼容当前 identity/name/time 字段别名，并只在 UUID 或名称等必要语义缺失时失败。`externalSchemaVersion` 仅用于观察和排障，不参与 Workflow 决策。

- `list` 只返回有界的最近结果，并明确标记可能不完整；远程契约当前没有 cursor 或总数。
- `get` 只接受精确 UUID，不根据名称猜测对象。
- `create` 是远程副作用，必须传入 `--confirm-create`；远程契约当前没有 idempotency key，结果不确定时不得盲目重试。
- `create` 未提供名称时不访问网络，而是按 Asia/Shanghai 当前时间推荐 `ResultSet-YYYYMMDD-HHmm`，返回可复制的确认命令；推荐值不会自动创建，用户也可以换成业务语义更强的名称。

运行时通过 `TIANGONG_LCA_DATA_PRODUCT_COMMAND_URL` 或
`TIANGONG_LCA_API_BASE_URL` 定位 `app_data_product_commands`，并需要
`TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY`。认证优先采用显式 actor-scoped
`TIANGONG_LCA_ACCESS_TOKEN`；未提供时，使用已有 `TIANGONG_LCA_API_KEY` 用户 bootstrap
交换短期 session。CLI 启动时读取本地 ignored `.env`，token 只存在于当前进程内存，不写入
stdout、命令参数、session cache 或恢复文件。

Closure 和 Calculation 的 `start` 也使用同一个 actor-scoped endpoint，且必须显式传入
`--confirm-start` 与幂等 token/key。`--method` 和 subset 模式下的 `--process` 可重复，格式为
`<uuid>@<00.00.000>`。Calculation 必须显式绑定已选择 Closure 的 ID、requested scope hash
和 policy fingerprint；CLI 不从 mutable 状态推断这些值。返回值只投影任务/资源 ID 和状态，
忽略 provider 附加字段及 schema 版本。

提交后任务仍为 `queued` 或 `running` 时，CLI 在 `nextActions` 中追加持续监测询问，
并返回 `nextDecision.kind=confirm_task_monitoring` 和 `requiresConfirmation=true`。
Agent 必须询问是否创建持续监测的定时任务或进程：状态不变时保持安静，仅在完成、失败、
阻塞或需要用户处理时通知，并在任务终态停止监测。这个提示不创建监测；用户确认后才通过
当前环境可用的调度能力创建。已处于终态的复用任务不显示询问，`nextDecision` 为 `null`。

异步 Calculation 提交以 Worker Job ID 作为最低稳定成功身份。Result Package/Build ID 尚未
materialize 时返回 `resourceId: null` 和 `identityCompleteness: job_only`，不误报
`remote_outcome_unknown`；资源 ID 出现后为 `complete`。Closure 提交仍必须同时返回 Closure
Check ID 和 Worker Job ID。只有无法确认最低稳定身份时才使用结果未知恢复路径。

未传 `--coverage-mode` 和 `--method` 时，当前 Workflow profile 使用：

- coverage：`global_eligible`；
- LCIA method set：当前已审核静态 catalog 中的完整 25 个精确 `{id, version}` identity；
- default impact category：Climate change / GWP，`6209b35f-9447-40b5-b68c-a1099e3674a0`。

默认影响类别只决定 Result Package 初始展示哪个结果，不缩小 Closure 或 Calculation 的方法范围。
25 个 identity 及其精确版本由 `contracts/default-profile.mjs` 持有；Closure 和 Calculation 必须从
同一 profile 取值，避免 certificate scope 与 build scope 不一致。该配置同时记录每个方法的
英文名称和 impact indicator，供 Agent、文档和 CLI 展示；adapter 仍只向远程 scope 发送稳定的
`{id, version}` identity，不把展示字段加入 provider 契约。

JSON 结果的 `effectiveInput.defaultedInputs` 会明确列出采用默认值的字段。显式参数始终覆盖
对应默认值；subset 仍必须提供至少一个 `--process`。

`closure get` 是异步 Closure Check 的只读恢复节点，只按精确 `closureCheckId` 查询。它返回
`runStatus`、`scanCompleteness`、`certificateValidity`、Worker identity、
`requestedScopeHash` 和 `policyFingerprint`，并且只有在 `passed + complete + valid` 且两个绑定值
齐全时才标记 `calculationReady=true`。provider 当前不在该查询中返回完整 method/process identity，
所以 CLI 会明确披露 `scopeIdentityReturned=false`；继续计算必须沿用创建该 Closure 时相同的显式
scope，不能从 `latest` 猜测，也不能假设当前默认 profile 与旧 Closure 相同。无法恢复原始 selection
时，CLI 明确返回人工恢复提示而不是生成看似可执行但不完整的 scope 命令。

Worker 主机、SSH 和 journal 由根 workspace 的 `workspace_ops` 拥有。`worker logs` 不读取日志，
而是输出应从 `lca-workspace` 根目录执行的精确委托命令：

```bash
python -m workspace_ops.cli worker job <job-id> --all-configs --kind all --execute
```

可以用 `--environment` 和 `--since` 缩小查询范围。Release 不复制远程服务器配置、SSH 或
`journalctl` 实现。`workspace_ops qualification` 是发布候选资格门禁，不是线上 Closure Check
提交入口。

Calculation 状态观察使用 `calculation get --job-id <uuid>`。该命令先分页读取 actor-scoped 数据库
task feed，并只接受精确 Worker Job ID；输出 `workerStatus`、domain status/validity、phase、progress、
ResultSet/Closure/Result Package identity 和投影更新时间。queued/running 状态的下一步仍是数据库状态
查询；只有 failed/blocked/stale，或 Worker completed 但 domain 未通过/无效时，才优先建议
`workspace_ops worker job` 日志诊断。Calculation 成功且 `resultPackageId` 已出现时，下一步进入精确
Bundle metadata 查询；不会退回 ResultSet。日志不覆盖数据库任务投影的产品状态权威性。

Calculation Bundle 使用本地数据面，不再让 Edge 为大量 artifact 串行生成 signed URL：

- `environment sync --confirm-sync` 只把 workspace 根 ignored `.env` 中缺失的 `CONN`、
  `S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`
  复制到 Release ignored `.env`；已有值不覆盖，变量值不进入 stdout；
- `calculation-bundle list` 对 `private.lcia_result_packages` 执行参数化、read-only、有界 SQL，默认 20、
  最大 200，只输出 Package/Bundle identity 和数量摘要，并要求选择精确 `packageId`，不自动采用第一项；
- `calculation-bundle get --package-id` 用精确 UUID 读取一个 Bundle 的稳定 metadata，不输出数据库连接、
  S3 locator 或 signed URL；
- `calculation-bundle download --package-id` 读取内部 manifest locator，通过配置的 S3 bucket 直接下载
  manifest 和 manifest 声明的 artifacts，默认 8 并发、允许 1–32；每个文件都校验 byte size 和 SHA-256，
  已存在且校验一致的文件可恢复复用，不一致则 fail closed，不静默覆盖；
- `--include-products` 可额外下载数据库声明的五类产品文件；默认只下载 Result Materialization 所需的
  canonical Bundle artifacts。

下载输出位于 `.release/calculation/bundles/<packageId>/`，包含原始 `calculation-bundle.json`、manifest
声明的相对路径和 `download-receipt.json`。receipt 记录 Package/Bundle identity、数量、验证状态和本地
路径，不包含 credential、内部 object locator 或 signed URL。下载成功后才提示进入 Result
Materialization；下载或校验失败时不提前询问 recipe/version/range，也不重新触发 Calculation。

成功创建或精确读取后，Workflow 在
`.release/calculation/result-sets/<resultSetId>.json` 写入最小恢复引用。文件只包含远程
Release-owned ResultSet 引用、target fingerprint 和观察时间，不包含原始 provider payload、access token、publishable key 或 signed URL。

## 需要用户决定的内容

- 新 ResultSet 的名称，或需要采用的精确 ResultSet；
- `global_eligible` 还是明确的数据集子集；
- LCIA 方法集；
- 是否启动线上完整性验证；
- 报告存在 warning 时是否继续处理、修复或停止；
- 是否启动线上计算；
- 下载哪些产品文件和审计证据。

## 主要产物

- ResultSet、Closure Check、Worker Job、Result Package 等远程资源引用；
- Closure 的有界摘要、完整机器结果引用和 certificate binding；
- Calculation Bundle 原始 manifest；
- manifest 声明的精确计算 artifacts；
- 下载大小、SHA-256、契约版本和来源证据；
- 当前可继续动作和阻塞原因。

## 失败与恢复

- 浏览器或终端退出不能使远程任务丢失；继续时按精确 ID 查询。
- Closure 运行失败与“Closure 发现数据问题”必须区分。
- Certificate 过期、scope 改变或依赖漂移时重新验证受影响范围。
- 计算任务失败不自动创建第二个任务；先读取权威终态和重试语义。
- 下载失败只重试同一精确 Bundle 下载与完整性校验，不重新计算；受控 S3 数据面不要求 Agent 保存或重新拼装 signed URL。

## 不属于本 Workflow

- Worker 的矩阵构建、求解和数值算法；
- Database/Edge 的权限和任务状态实现；
- 对计算结果做加权、组合或字段重写；
- 把 Calculation Bundle 组装为 Result Process 或 LifecycleModel；
- 正式数据包发布。

业务加权进入 Dataset Transformation，结果物化进入 Result Materialization，打包进入 Release Candidate，远程发布进入 Publication。

## 执行终点

以用户请求的终点为准：只要求检查或提交时不强制继续到下载。已有任务可按精确 ID 接入；scope 和默认方法由当前 profile 与显式选择决定。提交后持续监测须按 CLI 返回的确认提示处理，不把“已提交”描述成“已完成”。
