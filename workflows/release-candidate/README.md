---
title: Release Candidate Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户需要组织、验证、打包或重新收敛不可变 Release Candidate 时
whenToUpdate:
  - 当 intake、包的语义、候选构建、scope refinement 或 Candidate 后继路径变化时
checkPaths:
  - workflows/release-candidate/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: available Transformation help is distinct from unsupported downstream consumption and Result-only packaging; qualification and authorization are unchanged."
related:
  - AGENTS.md
  - ../../README.md
---

# Release Candidate Workflow

## 目标

把精确、冻结并具备必要证据的输入组织成不可变、可审查、尚未授权发布的 Release Candidate。

这个 Workflow 不负责产生原始计算结果、组装 Result Process/LifecycleModel、修改 Candidate 数据或执行远程发布。

## 可以从哪里开始

- Result Materialization Workflow 生成并验证的 canonical dataset collection；
- 对应的 dataset index、materialization manifest 和 validation report；
- 作为审计附件的 Calculation Bundle 或 Transformation Manifest；
- 已有 Package Plan、preserved failed build 或尚未发布的 Release Candidate。

## 输入契约

Release Candidate Workflow 先从冻结的 Materialization Intake 和 materialization 输出准备独立的 Release Intake，再由 Package build 只消费这个 Release Intake。两个 Intake 语义不同：前者证明结果生成时使用的输入，后者补齐独立分发所需的依赖；任何阶段都不得原地修改已冻结 manifest。

输入至少包括：

- canonical dataset collection；
- dataset index；
- materialization manifest；
- identity/version plan 引用；
- TIDAS、引用闭合和 numerical parity evidence；
- 每个 dataset role、UUID、version 和 canonical content hash。

Materialization evidence 与实际 dataset bytes 不一致时，返回 Result Materialization Workflow 修复。

Candidate 成功后的 `nextDecision` 提供 Publication 与 Transformation 的绝对 CLI help 入口。Transformation 本地 inspect/freeze/execute 已可用，但 handoff 不代表新 Candidate 已生成；Derived Result 消费与 Result-only package 的限制见 [Transformation](../dataset-transformation/README.md#result-evidence-与返回路径)。

## 包的组织维度

Package 不应由大量互斥枚举硬编码，而是由经过验证的 recipe 组合以下维度：

- Root：Unit Process、LifecycleModel、Result Process；
- Result layer：无结果、LCI、LCI + LCIA；
- Closure：引用式或 full self-contained；
- Format：TIDAS、ILCD；
- Grouping：合并包或每个 root 独立包。

以下是产品建模维度中的候选 recipe，不是当前 CLI 的支持矩阵；当前仅支持下文明确列出的 full-closure profile：

1. Unit Process + 完整支持闭合，不含计算结果；
2. LifecycleModel + Unit Process 闭合；
3. LifecycleModel + Result Process + LCI + 完整闭合；
4. LifecycleModel + Result Process + LCI + LCIA + 完整闭合；
5. 独立 Calculation/Validation Evidence 包。

具体支持矩阵必须经过 TIDAS/ILCD 语义验证，不能仅因为配置可以表达就允许构建。

## 主路线

```text
选择冻结输入
  -> 选择或生成 Package Recipe
  -> 构造 Package Plan
  -> TIDAS validation
  -> ILCD conversion / validation
  -> semantic round-trip / package closure / cross-package consistency
  -> deterministic package build
  -> Release Candidate v2 + Publication catalog
  -> Publication planning / Dataset Transformation
```

如果 Package build 或 qualification 发现数据错误，当前 Candidate 路线立即停止并保留 failed build。恢复路线是：

```text
preserved failed build + exact issue spool
  -> failure analyze
  -> invalid datasets + reverse-dependent roots + derived Result/Model + unreachable support
  -> failure review -> JSON + Excel + SVG human-review bundle
  -> 用户选择 repair / confirm complete exclusion set / stop
  -> immutable scope decision
  -> 新 Package Plan
  -> 全量 TIDAS/eILCD validation 和 ZIP readback
  -> 新 Candidate
```

影响分析不是与“排除”和“停止”并列的可选动作，而是任何排除的强制前置条件。一个数据集没有 inbound reference 并不自动意味着 orphan；如果它本身是冻结发布 root，删除它仍然改变发布范围。

Package build 是本 Workflow 的子过程，不是独立顶层 Workflow。

## 当前可执行入口

首个本地 Release Intake 与 Package route 已实现为 Workflow-local 薄 CLI：

```bash
pnpm install --frozen-lockfile
cd workflows/release-candidate

node cli.mjs cache status --json

# 仅在状态为 missing/stale/invalid 且用户确认后显式刷新
node cli.mjs cache refresh --json

# 只有远端路径不可用且操作员明确接受慢速直连时才使用
node cli.mjs cache refresh --execution local --json

node cli.mjs intake prepare \
  --materialization /path/to/materialized-lifecycle-model \
  --source-intake /path/to/verified-materialization-intake \
  --out-dir /path/to/release-intake \
  --json

node cli.mjs package build \
  --release-intake /path/to/release-intake \
  --profile standalone-lifecyclemodel-result-full-closure.v1 \
  --release-version 2026.08.0 \
  --out-dir /path/to/release-candidate \
  --tidas-bin /path/to/tidas \
  --json

# preserved failed build 上只读计算完整排除影响
node cli.mjs failure analyze \
  --failed-build /path/to/preserved-failed-build \
  --release-intake /path/to/original-release-intake \
  --out-dir /path/to/exclusion-impact \
  --json

# 使用 Release 自有依赖生成 Excel，并逐页检查 SVG 预览
node cli.mjs failure review \
  --impact-report /path/to/exclusion-impact/exclusion-impact-report.json \
  --preview-dir /path/to/exclusion-impact-review-previews \
  --out-dir /path/to/exclusion-impact-review \
  --json

# 用户确认报告中的完整集合和精确报告 hash 后记录决定
node cli.mjs failure decide \
  --impact-report /path/to/exclusion-impact/exclusion-impact-report.json \
  --action exclude \
  --reason "confirmed complete exclusion set" \
  --decided-by "release-operator@example.com" \
  --confirm-impact-sha256 <exact-report-sha256> \
  --out-dir /path/to/scope-decision \
  --json

# 新 Candidate 消费确认后的范围并重新跑所有 validator
node cli.mjs package build \
  --release-intake /path/to/release-intake \
  --profile standalone-lifecyclemodel-result-full-closure.v1 \
  --scope-decision /path/to/scope-decision \
  --release-version 2026.08.0 \
  --out-dir /path/to/new-release-candidate \
  --json
```

`--tidas-bin` 可省略，此时读取 `TIDAS_BIN`，再回退到 `PATH` 中的 `tidas`。完整闭包构建默认使用 Release-owned `2048 MiB` 内存预算；`--tidas-memory-budget-mib` 优先于 `TIDAS_MEMORY_BUDGET_MIB`，选择值会一致传给 build、preflight 和四包 qualification 的每个 TIDAS 子进程。`memory_budget_exceeded` 会保留资源失败证据并返回同一冻结输入、提高预算的精确重试命令，不触发数据排除分析。开始组装前会执行 `version` 与 `validate --describe` 握手，并要求精确的 `tidas v0.2.0` 与既定 validation protocol；旧版本会在产生 staging 输出前以可操作错误停止。命令随后生成本地 package build，并用最终 ZIP 做 qualification；只有全部通过才形成 Candidate。整个动作不上传、不批准、也不发布。

如果省略 `--release-version`，命令不会开始构建，而是以 `release_version_confirmation_required` 返回按 Asia/Shanghai 当前年月生成的推荐版本（例如 `2026.08.0`）、四个预期文件名和专用回复模板。Agent 必须先请用户确认或替换版本号，再使用返回的 argv 带上 `--release-version` 重跑；显式传入版本号即表示该前置确认已经完成。

CLI 同时面向人和 Agent：默认输出简洁的 `Summary / Next / Reply using template`；`--json` 输出一个有界对象，包含 `outcome`、`completeness`、精确 artifact 路径、结构化 `nextActions[]` 和 workflow-local `replyTemplate`。未知或重复参数会被拒绝，失败时使用非零退出码，并提供错误代码、恢复动作和对应回复模板。

CLI 返回的自身命令以及返回 Result Materialization 的命令均使用绝对脚本入口，可从任意工作目录
执行。Release Intake 准备成功后会给出确定的本地 Candidate 目录；随后省略版本号的 `package build`
只触发版本确认，不开始构建。缓存模板直接引用 `nextActions.0.command`，不会把结构化对象原样展示给用户。

回复模板位于 `reply-templates/`，目前覆盖：

- ✅ 本地 Candidate 已构建并验证；
- ⚠️ ZIP 已生成但 qualification 未通过，失败构建已保留用于诊断；
- ⚠️ frozen input 与当前字节发生漂移；
- ❌ 参数、依赖、profile 或工具执行失败。
- ⚠️ 排除影响分析已完成，等待用户选择修复、确认完整排除集合或停止；
- 🧾 Release 范围决定已冻结，但尚未构建或授权发布。

Agent 使用 CLI 返回的模板路径和 `requiredFacts` 填写回复。模板中的“成功”只表示本地候选构建完成，永远不表示已经批准、上传或发布。

`cache refresh` 是独立且需要显式执行的维护动作。默认 `--execution remote`：CLI 使用 `--remote-host` 或 `RELEASE_FLOW_CACHE_REMOTE_HOST` 指定的受管 Worker EC2 SSH host，把 workflow 自带的 Python exporter 复制到远端临时目录，并只通过 SSH stdin 传入当前进程的 `CONN` 与 S3 数据面配置。两者都未提供时 fail closed，不猜测具体运行实例。远端先确认数据库连接和 Supabase Storage endpoint 属于同一 project，再建立只读 repeatable-read snapshot；查询在靠近 Supabase 的 EC2 上流式筛选全部已发布 Elementary Flow，生成 gzip artifact 并上传到 `${RELEASE_FLOW_CACHE_S3_PREFIX:-_temporary/release/elementary-flow-cache}`。对象与 GET/DELETE presigned URL 均使用一小时 expiry；URL、连接串和 secret 不进入 CLI 输出或文件。

本地通过 presigned GET 下载压缩包，先核对压缩字节数与 SHA-256，再逐条解压并验证 NDJSON identity、Elementary Flow 类型、记录数和未压缩 SHA-256。全部通过后，CLI 必须先用 presigned DELETE 删除临时对象，才写入 cache manifest 并替换原缓存；失败保持旧缓存不变，且不会静默切到本地数据库路径。远端运行时必须提供 `python3`、`psql`、`boto3` 和 `botocore`。只有远端 SSH、依赖或 Storage 路径暂时无法恢复时，操作员才显式使用 `--execution local`；该 fallback 保留原有的 Node/Postgres 单 cursor 只读下载语义。

两条执行路径生成相同的 `tiangong.release.elementary-flow-cache.v1`：manifest 记录内容 SHA-256、记录数以及数据库 watermark（已发布 Flow 数量与 `MAX(modified_at)`）。`cache status` 用一次轻量查询比较 watermark，并验证本地 artifact；因此能够区分 `fresh`、`missing`、`stale` 与 `invalid`。S3 `Expires` header 和 presigned URL expiry 只限制临时对象的可用期，不等同于自动删除；正常路径通过显式 DELETE 立即清理，异常终止遗留对象仍应由 Storage prefix lifecycle 兜底。

`intake prepare` 不再隐式执行长时数据库下载。它只接受 fresh 缓存，扫描 source closure 中 LCIA Method 的 `characterisationFactors`，提取带精确 UUID/version 的 `referenceToFlowDataSet`，并从缓存匹配缺失的精确版本后冻结 dependency supplement。缓存缺失或过期会 fail closed，同时输出显式刷新命令。该过程不修改 Materialization Intake，也不把新增 Flow 误记为参与了原始计算。Release Intake manifest 只记录内容 hash；本地绝对路径单独保存在权限受限的 runtime locator 中，不进入可移植计划语义。

CLI 会自动加载 Release 仓根目录 ignored `.env` 中已有的 `CONN` 和 S3 数据面变量。远端刷新要求通过 `RELEASE_FLOW_CACHE_REMOTE_HOST` 或 `--remote-host` 提供 SSH host，并配置 `CONN`、`S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`；可选使用 `S3_SESSION_TOKEN`。`RELEASE_FLOW_CACHE_PROJECT_REF` 可作为从连接串和 endpoint 推导所得 project ref 的额外精确断言，但不能替代两者自身的可验证 identity。如尚未同步，先使用 Calculation Workflow 的 `environment sync` 将 workspace 根 `.env` 中允许的数据面变量补入 Release `.env`；Release Intake 不直接读取 workspace 根配置，也不会在输出中披露任何凭据或 presigned URL。

执行过程：

```text
验证 Materialization Manifest + canonical-dataset-index
  -> 验证精确 Materialization Intake identity/hash
  -> 准备 Release Intake 并补齐 LCIA Method -> exact Flow
  -> 冻结 dependency expansion report
  -> Package build 重新验证 Release Intake 及两个上游 hash
  -> 从 source_closure + dependency supplement 组装数据集
  -> 生成完整 canonical-dataset-index
  -> 冻结 Package Plan
  -> 调用 tidas release build-packages
  -> 以正式数据库发行名称保存四个确定性 ZIP
  -> 逐包重新读取 ZIP member、隔离解压并执行 TIDAS/eILCD validation
  -> 保存 tidas report + package-verification-report
  -> 全部通过：冻结 publicationAuthorized=false 的 Release Candidate
  -> 任一失败：保留 failed build，不创建 Candidate
```

Release Candidate Workflow 只实现当前产品契约明确要求的 LCIA Method characterisation Flow 扩展，不复制通用闭包遍历。完整引用闭合、TIDAS/eILCD validation、schema-ordered conversion 和 semantic round-trip 仍由 `tidas-tools` 权威实现。Node 层验证交接证据、准备 Release Intake、组装本地 canonical input、执行有界 subprocess、核对四个 ZIP 并保存候选证据。

当前只支持 `standalone-lifecyclemodel-result-full-closure.v1`。Result Process-only materialization 会以 `package_profile_unsupported` 停止；只有未来 `tidas-tools` 增加并验证对应 profile 后才扩展。

内部 profile ID 用于闭包求解和机器验证，不作为独立分发文件名。外部产品名称按 LCA 数据库内容区分：`UnitProcessDatabase` 表示可继续建模的单元过程数据库，`ResultDatabase` 表示包含 LifecycleModel、LCI/LCIA Result Process 及其自包含依赖的结果数据库。显式 `--release-version` 同时进入 Package Plan、Candidate 和四个文件名，禁止 mutable `latest`。

打包完成后的验证以最终 ZIP 字节为输入，而不是复用 staging 结论。Workflow 先读取完整 member catalog 并拒绝空包、绝对路径和 `..` 路径，再隔离解压；两个 `.tidas.zip` 分别调用 `tidas release validate-tidas`，两个 `.ilcd.zip` 分别调用 `tidas release validate-ilcd`。任一归档无法读取、解压或验证时都不会冻结 Candidate，但已经生成的包和诊断证据不会删除。

Package build 与 Candidate qualification 是两个明确边界：生成 ZIP 只说明构建产物存在；TIDAS/eILCD 回读全部通过后，它们才具备成为 Candidate 的资格。失败时，用户请求的 Candidate 目录保持不存在，Workflow 将 staging 原子保留到同级唯一目录 `<candidate>.failed-<run-suffix>/`。该目录包含 `failed-package-build.json`、已有的四个 ZIP、`package-verification-report.json`（若已进入逐包验证）以及 `validation-readback/`。CLI 返回这些精确路径和查看命令，便于定位 schema、转换或数据字段问题；失败构建始终记录 `candidateCreated=false` 和 `publicationAuthorized=false`。

当失败证据包含可验证的 TIDAS issue spool 时，CLI 同时给出 `failure analyze` 恢复动作。分析以 exact UUID/version 为起点，用 Calculation graph 求所有反向依赖 roots，再通过 Materialization lineage 找出对应 Result Process/LifecycleModel，并按字段路径保留 canonical 文档引用的 TIDAS 角色。`referenceToPrecedingDataSetVersion` 是允许指向包外历史版本的 lineage，不参与包内可达性或剩余引用冲突；其他 closure dependency 仍然 fail closed。只要仍有可达文档通过 closure dependency 引用建议排除集合，报告就设置 `safeToExclude=false`，禁止生成 exclusion decision。

Agent 随后执行 `failure review`。Workflow 使用自身 `package.json` 声明的 ExcelJS 生成七个工作表的 `exclusion-impact-review.xlsx`，重新读取 XLSX、检查 Summary 的值与公式、扫描公式错误，并从同一 workbook model 生成七张 SVG 预览供逐页视觉检查。该命令不依赖客户端私有 runtime、`@oai/artifact-tool` 或外部 `node_modules` 路径。`exclusion-impact-review-receipt.json` 记录源报告 hash、workbook hash、大小、工作表清单、XLSX 回读和预览验证范围。Excel 是方便用户排序、筛选和审阅的可编辑视图；权威范围仍由不可变 JSON 及其 SHA-256 定义。

用户确认排除时，`failure decide` 将原始 failed build、Release Intake、Materialization、source intake、issue spool、完整排除集合和 resulting dataset count 绑定到不可变决定。后续 `package build --scope-decision` 会重新核对全部 hash，按 canonical path 构造新的 Candidate 输入并重新委托完整验证。原 failed build、Materialization 和源数据保持不变；范围决定不构成批准、上传或发布授权。

如果 `tidas release build-packages --format json` 在构建阶段非零退出，Workflow 会把有界 stdout 解析为结构化 operation report 并保存在 `failed-package-build.json` 的 `failure.diagnostics.operationReport`；stdout 不是有效 JSON 时才保存有界 `stdoutTail`。这样字段级 validation issues 不会因 stderr 为空或只含摘要而丢失。

Candidate 目录包含：

```text
package-plan.json
canonical-dataset-index.json
tidas-release-report.json
package-verification-report.json
publication-catalog.json                 # exact identity/reference/component handoff
release-candidate.json                   # v2 binds Publication catalog hash
packages/                              # exactly four deterministic ZIPs
  TiangongLCA-<version>-UnitProcessDatabase.tidas.zip
  TiangongLCA-<version>-UnitProcessDatabase.ilcd.zip
  TiangongLCA-<version>-ResultDatabase.tidas.zip
  TiangongLCA-<version>-ResultDatabase.ilcd.zip
```

## Candidate 完成后的选择

Candidate 成功冻结后必须展示两个互斥的当前方向：

1. 进入 Publication Workflow，选择 component 或精确 datasets，生成依赖闭合、未授权的 Publish Plan；
2. 选择精确 Candidate 数据进入 Dataset Transformation，完成再加工后生成新 Candidate。

Candidate v2 在 canonical bytes 仍可验证时生成 `publication-catalog.json`，记录 exact identity、required references 和 Unit Process/Result component sets。Publication 的纯 include/exclude 只引用 Candidate 子集，不改变 Candidate；只有 dataset bytes、identity、version 或 package 内容变化才形成新 Candidate。

## 失败与恢复

- 本地验证失败返回到拥有错误输入或 recipe 的最早节点。
- 包已生成但 TIDAS/eILCD qualification 失败时，先检查 CLI 返回的 `failed-package-build.json` 和保留包，不要盲目重跑；修正数据后使用新的 Candidate 输出路径重新构建。
- scope decision、父 Candidate 或上游 hash 漂移时 fail closed。
- 一个通过资格验证的 Candidate 不能通过重跑或下游 Workflow 被静默改变。

## 不属于本 Workflow

- 创建或修复远程源数据；
- Worker 求解；
- 未冻结的语义探索；
- 生成或修改 Result Process、LifecycleModel、identity 或 dataset version；
- Candidate-derived 数据加工；
- 把派生数据写回 authoring tables；
- Publish Plan、正式发布授权、平台写入、状态转换和独立远程回读。

后两类分别属于 Dataset Transformation 和 Publication Workflow。

## 后续增强点

1. 为 Dataset Transformation 派生 Candidate 增加显式 `parentCandidateHash` 与 transformation evidence binding。
2. 在 Publication target inspection 契约确定后，把 Candidate component metadata 与远程 target classification 对接。
