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
lastReviewedAt: 2026-11-05
lastReviewedCommit: 009e3df54b4cde0eaac2b80f8ce99cf3b3229e54
lastReviewedNote: "Release #126: compact membership handoff, local closure validation and complete ZIP listing proof."
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

Release Candidate Workflow 先从冻结的 Materialization Intake 和 materialization 输出准备独立的 Release Intake，再按目标产物选择 Result ZIP + HDF5 配对路线或显式 legacy 四包路线。两个 Intake 语义不同：前者证明结果生成时使用的输入，后者补齐独立分发所需的依赖；任何阶段都不得原地修改已冻结 manifest。

输入至少包括：

- canonical dataset collection；
- dataset index；
- materialization manifest；
- identity/version plan 引用；
- TIDAS、引用闭合和 numerical parity evidence；
- 每个 dataset role、UUID、version 和 canonical content hash。

Materialization evidence 与实际 dataset bytes 不一致时，返回 Result Materialization Workflow 修复。

Candidate 成功后的 `nextDecision` 提供 Publication 与 Transformation 的绝对 CLI help 入口。Transformation 本地 inspect/freeze/execute 已可用，但 handoff 不代表新 Candidate 已生成；Derived Result 消费与 Result-only 配对步骤见 [Transformation](../dataset-transformation/README.md#result-evidence-与返回路径)。

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

# 需要 Result ZIP + HDF5：使用 intake prepare 返回的配对路线
node cli.mjs result intake \
  --release-intake /path/to/release-intake \
  --out-dir /path/to/result-intake \
  --tidas-bin /path/to/tidas \
  --json
# 之后按返回命令 inspect → freeze → build；不重新计算。

# 仅当用户明确需要旧四包（不含 HDF5）时：
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

`--tidas-bin` 可省略，此时读取 `TIDAS_BIN`，再回退到 `PATH` 中的 `tidas`。完整闭包构建默认使用 Release-owned `2048 MiB` 内存预算；`--tidas-memory-budget-mib` 优先于 `TIDAS_MEMORY_BUDGET_MIB`，选择值会一致传给 build、preflight 和四包 qualification 的每个 TIDAS 子进程。`memory_budget_exceeded` 会保留资源失败证据并返回同一冻结输入、提高预算的精确重试命令，不触发数据排除分析。开始组装前会执行 `version` 与 `validate --describe` 握手，并要求 `tidas.operation-report.v1`、`tidas.validation-describe.v1`、`document-validation-batch.v1` 与 `package.name=tidas`；不绑定精确版本号，缺少必需能力的二进制会在产生 staging 输出前以可操作错误停止。命令随后生成本地 package build，并用最终 ZIP 做 qualification；只有全部通过才形成 Candidate。整个动作不上传、不批准、也不发布。

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

`intake prepare --delivery-format result-zip-hdf5` 将后续命令指向 `result intake`；`--delivery-format legacy-four-zips` 指向 `package build`。未提供时返回 `nextDecision` 的两种明确选择，`nextActions` 为空，避免静默选择旧四包。Agent 应复用用户已经明确的目标，无需反复确认。已有 Release Intake 可直接进入相应路线；已有 legacy Candidate 不会原地补成 v3，配对路线从同一冻结 Release Intake 新建 Result-only 产物。若旧 Candidate 曾做排除或 Transformation，应先使用对应的新输入，不能把原始全量 Intake 当作同一 scope。

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

该 v1 catalog 只用于 legacy Candidate v2；配对 Candidate v3 使用下述精简 v2 成员契约。每个 dataset 的 `references` 是去重后的 exact dataset key 字符串数组（`kind:uuid@version`），不是含 `target/location/role` 的引用对象；所有消费者与 JSON Schema 都使用此冻结形式。原始引用位置仅用于构建时的错误诊断，不进入 catalog 的引用数组。

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

## 最终 Result 查询文件生成内核

内部 `buildFinalResultArtifacts({canonicalRoot, index, results, outDir, encoder})` 从已冻结 canonical index 的真实 bytes 提取 Result；`results` 显式给出 UUID/version、layer、expectedMethods、direct/derived 及精确 sources。每个文件重新检查大小、SHA-256 和 canonical content hash，单位和指标仅从冻结依赖解析。v1 profile 要求 `resultingAmount`，缺失/无效最终值会失败，不回退旧 `meanAmount`。

reference Flow Property 或参考 Unit 的 `meanValue ≠ 1` 不再阻断：投影记录 `nonunit_reference_property` / `nonunit_reference_unit` 告警，按 Result+Flow 去重、排序并限制 20 条（超出时追加 `warnings_truncated`），仅在 CLI JSON 与人类输出中呈现。告警不进入 `input-plan.json`、冻结输入、encoding receipt、parity 或 Candidate schema，不改变任何 hash，也不换算或归一化数值；非法或非有限的 `meanValue` 仍然失败；`result verify` 不重算告警。

按能力/方法集分别生成 `tiangong.query-artifact.v2`：`results.json.gz` 使用最终 Result 身份，`inventory-items.json.gz` 固定完整清单键，`impacts.json.gz` 保存精确指标；`lci.h5` 为 uint64 CSR 索引及 float64 值，`lcia.h5` 为按行分块 float64 矩阵。LCI-only 不生成 LCIA 文件。每组 manifest 绑定输入及全部文件 hash/size。

执行 `pnpm run native:build` 构建 Release 自有工具；内部调用通过 `RELEASE_HDF5_BIN` 或 `encoder` 显式指定二进制。`native/Cargo.lock` 锁定依赖；使用 [hdf5 0.8.1](https://docs.rs/crate/hdf5/0.8.1) 的静态 HDF5/zlib，构建需要 Rust/CMake。`pnpm run prepush:gate` 验证 Rust 格式/Clippy、构建、领域样本和实际 HDF5 回读；CI 原生样本覆盖 Linux x64、Windows x64、macOS ARM64。

原生内部协议为 `TGQNUM02` + little-endian uint64 的行数/清单列数/指标数；每行写入 uint64 非零数、递增唯一的 uint64 列号/float64 数值，再跟完整 LCIA float64 行。编码器拒绝非有限值、重复/越界列、截断或尾随 bytes；重新打开实际 HDF5 与该精确流逐行对照。JS 测试另用手写期望数值验证文件，避免只证明同一提取器自洽。

预算：普通文档/投影 8 MiB，LCIA Method 文档 64 MiB，查询索引/投影缓存元数据 128 MiB，本地输入计划单独 512 MiB，最多 200 万结果/清单列及 4096 指标，spool/数值流/总文件各受 32 GiB 上限约束；数值按单行处理，索引留在受限内存。输出路径不可覆盖，receipt 最后提交；仅有部分文件不构成完成。

Method 上限按完整 canonical 文档计量，并在 direct/Derived Intake、冻结读取、HDF5 编码和 ZIP 回读中一致使用；其他文档仍受 8 MiB 限制。完整闭包仍逐份验证；LCIA Method factors 引用的所有 Flow 保留在 ZIP 中，只有最终 Result exchange 引用的 Flow 进入数值投影缓存。数值投影逐份验证完整文档及 hash 后只保留 Method 名称、定量参考等必要元数据，不把 characterisation factors 全文重复复制给每条 Result。完整 Method 仍进入 ZIP，完整内容 hash 仍绑定 Result 投影；精简查询元数据不改变数值、依赖语义或发布内容。128 MiB 限制用于索引和保留的投影元数据，不是所有 Method 文件大小之和。本地输入计划仅保存精确身份与内容指纹；Intake inspection、final input 与 Candidate readback 使用同一 512 MiB 计划文件上限。

超限分别返回 `canonical_document_budget` 、`canonical_metadata_budget` 或 `canonical_input_plan_budget`，携带 `budget.kind/path/datasetType/uuid/version/actualBytes/limitBytes`（字段按上下文提供）；Intake 的 `failed-intake.json` 保留相同诊断。应检查具体输入与资源策略，解决容量后重试新输出目录，不通过删减结果或改写冻结文件绕过限制。

此内核产生 `final-result-encoding.v1` 本地证据，明确 `candidateQualified=false`、`publicationAuthorized=false`。现有 `package build` 仍保持四包资格流程；配对 ZIP 校验和 v2 发布接入完成前，不把内核输出作为可发布 Candidate，也不授予普通用户读取资格。

### 最终 Result 双产物配对

`lib/final-result-pair.mjs` 的 `buildFinalResultPair` 接受冻结 canonical collection、完整 index、精确 Result selection、release version，以及显式 Toolkit/encoder。它复制并重验输入，在同一输入上构建 HDF5 和 `result-process-full-closure.v1` 的 TIDAS/ILCD 两包；Toolkit 握手必须同时声明该 profile 和 `tidas.release-report.v2`，不按版本号猜能力。

包实际解压后再次通过各格式验证，并在两个 ZIP 的实际内容之间执行 semantic round-trip。`final-result-parity.mjs` 从解压后的 TIDAS 文档及语义依赖重新形成期望值，核对完整 Result/Flow/Method 轴、单位、参考量、直接/派生元数据、所有 LCI 非零及 LCIA 数值，再调用原生工具逐行比较真实 HDF5。冻结 index 的每个成员都必须出现在所选 Result 完整闭包中；多余输入不能静默遗漏。LCI-only 与不同指标集合分别生成 artifact，零 LCIA 不表示缺少能力。

返回 `tiangong.release.final-result-pair.v1`，明确 `pairQualified=true`、`candidateQualified=false`、`publicationAuthorized=false`，并绑定实际包、query manifests、回读和 parity 证据。失败时保留唯一工作目录、成功产物及结构化诊断；不出现成功的配对输出，不覆盖已有目录。当前该模块是内部构建能力；原 `package build` CLI 和 legacy Candidate v2 四包语义不变。可信来源关联以及配对 Candidate 冻结仍由后续 Candidate 集成完成，不能把这个 receipt 直接交给旧发布入口。

使用支持新 profile 的真实 Toolkit 运行可重复的跨项目资格测试：

```bash
RELEASE_PAIR_TIDAS_BIN=/absolute/path/to/tidas node --test workflows/release-candidate/test/final-result-pair.test.mjs
```

测试输入完全合成，包含同 UUID 两版本、LCI-only、LCIA 42/0、LCI 2.5/0/-3 和参考量 -2；另以手写二进制期望值验证实际 HDF5。未配置测试专用 `RELEASE_PAIR_TIDAS_BIN` 时只有真实 Toolkit 集成项明确 skipped，其余能力拒绝、输出保留及篡改反例照常执行；不能把 skipped 描述为双产物资格通过。`fixtures/paired-final-results.json` 保留全部输入与 provenance，不需要其他仓库私有模块。

### 冻结最终输入

`result inspect` 复核 canonical 文件、完整依赖和结构化来源，返回精确 input hash。确认该 hash 后，`result freeze` 在独立本地目录逐份复核副本，生成 `final-result-input.json`、输入计划和来源清单。每个 Result 绑定规范内容与语义依赖的指纹，不需要数据库连接或登记回执。输入格式为 v2。此前生成的 v1 Result Intake 可从原冻结 Release Intake 或已验证的 Derived Materialization 重新准备。

显式使用 `result versions` 可只读查看历史全局登记占用并生成上游版本建议。该命令不参与离线出包和批次发布。对已发布的 direct Result，使用上游 Materialization 的 `--previous-manifest` 依据原版本规则分配版本。派生 Result 的版本由 Transformation 在冻结时确定。两条路线都先生成新版本的标准数据集，再重新准备、冻结并生成 HDF5 与 ZIP。

### 配对 Candidate v3

Result-only 的发布主体只包括 `result_process`。Result 通过 `referenceToIncludedProcesses` 等标准引用依赖的 Unit Process 保留原文和 `unit_process` 类型，作为 Result 闭包进入两种 ZIP，不成为独立 Unit 发布组件，也不产生 HDF5 行。构建时验证根的完整依赖闭包；重读核对精简成员与冻结索引的精确一致性。legacy 四包的主体选择不变。

内部 `buildFinalResultCandidate({finalInputDir, confirmInputHash, outDir, releaseVersion, tidasBin, encoder})` 重新加载 final input，并对实际 canonical bytes 重算每个内容指纹；确认后生成并核验两类文件。最终 `release-candidate.json` 使用 v3，绑定 `final-result-input.json`、`input-plan.json`、`source-lineage.json`、canonical index、`publication-catalog.json`、`query-results.json` 与 `pair/` 中的两包和查询文件。`query-results.json` 逐个保存精确 Result、内容指纹、层能力、直接/派生关联和 artifact/ordinal；不是对用户公开的 DTO。

`publication-catalog.json` 现在使用 `tiangong.release.candidate-publication-catalog.v2`：顶层只有 schemaVersion、canonicalDatasetIndexSha256、datasetCount、datasets；成员只有 datasetType、uuid、version、role、canonicalContentHash。完整引用图只在 Release 构建时验证，不落盘、不上传、不交给 Database 重复遍历。已有 index/配对证据绑定完整 ZIP，精简成员用于数据库批次、Result 覆盖和实时 ZIP 支持数据权限。没有新增身份登记、hash 台账或发布前远程依赖。旧全图格式的本地配对候选需要从相同冻结输入在新目录重建；不提供兼容读取，不改写已留存证据。

ZIP 成员列表按完整输出流逐条验证并计数，不能使用命令诊断尾部作为列表。空包、绝对/父目录路径、异常超长条目和读取失败均在解压前拒绝。

`loadFinalResultCandidate` 验证 v3 manifest/hash 链、真实包和 HDF5 bytes、结果轴完整覆盖，再允许本地消费者读取。Candidate 移动目录不会改变语义绑定。候选清单的 `validation.finalInputBinding` 记录输入校验。失败后使用同一输入和新的输出目录重试。

Transformation 已能读取合格 v3 的 Result 包并核对实际 Process bytes；它的权重、共同 Calculation lineage、字段决定和授权约束不变。此能力通过 `result` CLI 命令族进入；后继使用 Publication 已实现的 `result-storage`、`result-readiness` 与 `result-publication` v2 命令族，不能把 v3 交给旧四包发布入口。

### Result-only 命令路线

Result-only Materialization 的 Catalog 使用 JCS 内容 hash；既有 `resolved-one-hop-aggregated-background.v1` Model producer 使用 canonical 文件字节 hash（含末尾换行）。消费者按明确 producer profile 校验对应域，不改写已冻结 Manifest，也不接受任意 hash 回退。

直接结果先复用 `intake prepare` 补齐冻结的 LCIA Method Flow 依赖；它接受 Result-only Materialization，不要求虚构 Model。随后使用新路线：

`result intake`/`inspect`/`versions`/`register`/`build` 的 JSON 仅在存在数据质量告警时附带 `warnings`，人类输出在 `Warnings:` 下列出；告警不阻断，也不写入冻结产物，`verify` 不重算。

```bash
node workflows/release-candidate/cli.mjs result intake \
  --release-intake <release-intake-dir> --out-dir <final-intake-dir> \
  --tidas-bin <capability-complete-tidas> --json
node workflows/release-candidate/cli.mjs result inspect \
  --result-intake <final-intake-dir> --json
```

派生结果在 `materialize derived` 之后，从真实父包继承所需支持数据：

```bash
node workflows/release-candidate/cli.mjs result intake \
  --materialization <derived-materialization-dir> \
  --candidate <parent-candidate-dir> --transformation <transformation-output-dir> \
  --out-dir <final-intake-dir> --tidas-bin <capability-complete-tidas> --json
```

legacy 父 Candidate 还必须提供 `--parent-materialization <original-materialization-dir>`；旧 Transformation output 若未带 frozen spec，显式提供 `--spec <spec-dir>`。Intake 重新执行 producer replay，核对加工后的实际 bytes 和父关联；不从文字说明建立原过程映射。真实 ZIP 成员逐项按 index 校验，原有 publication reference catalog 用于选择 Result component，Toolkit 负责完整标准闭包与 TIDAS qualification。未被 Result 引用的 Unit、Model 或其他支持内容不进入新输入；缺失依赖直接失败，不猜 latest。

直接路线的层来自 producer catalog，预期方法来自同一 hash-bound source intake 的 process axis/LCIA records；不会通过读取不完整最终文档缩小期望集合。派生路线使用 producer replay 后的层/方法契约。Intake、inspect、freeze、build、verify 都不连接身份数据库；inspect 会重新核对原始 producer 证据及必要的 replay。运行时路径保存在权限受限 `runtime-locators.json`，不进入语义 input hash。

使用 inspection 返回的精确 hash 冻结并构建：

```bash
node workflows/release-candidate/cli.mjs result freeze \
  --result-intake <final-intake-dir> --confirm-input-sha256 <inspected-hash> \
  --out-dir <frozen-input-dir> --json
node workflows/release-candidate/cli.mjs result build \
  --final-input <frozen-input-dir> --confirm-input-sha256 <inspected-hash> \
  --release-version <confirmed-YYYY.MM.N> --out-dir <candidate-dir> \
  --tidas-bin <capability-complete-tidas> --hdf5-bin <release-result-hdf5> --json
node workflows/release-candidate/cli.mjs result verify --candidate <candidate-dir> --json
```

省略 build 的 release version 会返回两包文件名和版本确认，且不启动构建。失败保留成功文件和不完整目标，资格标记最后提交。

CLI 返回有界状态、产物路径、input hash 和下一步命令，不输出 provider 错误正文、连接串或服务 secret。`result verify` 证明本地资格；上传、readiness、审批与原子生效由后继版本化 Publication 流程负责。
