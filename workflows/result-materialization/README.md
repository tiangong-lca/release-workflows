---
title: Result Materialization Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户需要把 Calculation Bundle 或派生结果组装成标准 Process、LifecycleModel 和 canonical dataset collection 时
whenToUpdate:
  - 当 materialization recipe、身份版本、数据集关系、验证或输出变化时
checkPaths:
  - workflows/result-materialization/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: current Bundle-only intake and unsupported Derived Result handoff are explicit; materialization and path behavior remain unchanged."
related:
  - AGENTS.md
  - design/result-process-and-lifecycle-model.md
  - ../../README.md
---

# Result Materialization Workflow

## 目标

把已验证的 Calculation Bundle，确定性地组装为符合标准、具有稳定身份和版本、内部引用一致的 LCA 数据集集合。

这个 Workflow 解决的是“数值和图证据如何成为 Process/LifecycleModel”，不是重新计算，也不是打包发布。

## 可以从哪里开始

- Calculation Workflow 下载并验证的 Calculation Bundle；
- 已由本 Workflow 验证的 Calculation Bundle intake，其中包含 source closure、graph evidence 和 result arrays；
- 已有请求与精确输入，用于重新执行或核验已有完整产物；部分生成结果不构成独立输入或 checkpoint；
- 已完成 materialization、但需要针对新 recipe 或上一版 manifest 重新生成的 dataset collection。

Dataset Transformation 已输出 `status=ready_for_result_materialization` handoff，绑定 Frozen Spec、Execution Receipt、Derived Result identity/version/hash 和父 Candidate；但本 Workflow 尚未实现该输入的消费者，当前 CLI 仍只接受 Calculation Bundle intake。不得将 handoff 改名为 Bundle 或补造 LifecycleModel。Result-only materialization 也尚不受 Release Candidate 的 package profile 支持；本节点产物完成不表示可直接构建新 Candidate。

## 为什么是独立 Workflow

它拥有与 Calculation、Transformation、Release 不同的输入、决定、产物和验证：

- Calculation 产生数值、图证据和 Calculation Bundle；
- Transformation 改变模型或结果的业务语义；
- Result Materialization 把冻结语义投影为标准数据集；
- Release Candidate 消费已经 materialize 的数据集，负责验证、打包和冻结 Candidate；Publication 单独负责远程发布。

Materialization 失败时，可以修复 recipe、字段或引用并重新生成，不需要重新计算或进入远程发布。

## 数据集关系

```text
M(P)
├── reference process instance -> U(P)
├── direct provider instance   -> R(Q1)
├── direct provider instance   -> R(Q2)
└── referenceToResultingProcess -> R(P)
```

- 源 Unit Process 不因计算或 materialization 而改变。
- LifecycleModel 和 Result Process 使用独立 UUID lineage 和 dataset version。
- LifecycleModel 必须引用同一次 materialization 中的精确 Result Process identity/version。
- 首版 LifecycleModel 使用 `resolved-one-hop-aggregated-background.v1` profile：根 instance 引用 `U(P)`，每条有效 direct provider edge 的 instance 引用对应聚合 `R(Q)`。
- `R(Q)` 是 terminal aggregated background；Model 不递归展开 provider 的 LifecycleModel 或完整上游网络。
- LCI 是 Result Process 的基础结果层。
- LCIA 默认作为同一 Result Process 上的可选结果层，不单独制造只有 LCIA、没有 LCI 的 Process。
- 如果未来标准或消费者确实要求独立 LCIA Process，再增加经过验证的 recipe。

对象关系、生成模式和 provider 连接原则见 [Result Process 与 LifecycleModel 的关系与生成原则](design/result-process-and-lifecycle-model.md)。

CLI 默认使用 `.release/` 下的内容寻址路径，不再要求用户手写 `--out-dir`。路径、materialization key、验证后复用和显式输出规则见正式契约：[本地产物默认路径设计](design/local-artifact-path-convention.md)。

## 一个入口，由三个选择决定执行图

用户先选择范围，再选择最终对象，以及本次需要生成的 Result Process 内容层。公开 CLI 只有一个 `materialize` 动作；下面的 recipe 由这三个选择组合得到，不是需要手动串联的子命令。LifecycleModel 本身没有 LCI/LCIA 结果字段，第三个选择只控制 `R(P)` 和依赖 `R(Q)` 的内容：

1. `lci-result-process`
   - 生成 quantitative reference 和聚合 LCI exchanges；
   - 不包含 LCIAResults；
   - 可作为不需要模型文档的独立结果数据集。
2. `lci-lcia-result-process`
   - 包含完整 LCI；
   - 增加绑定精确方法 ID/version 的 LCIAResults；
   - 方法集变化必须进入版本和 provenance 判断。
3. `lifecycle-model-with-result`
   - 生成 LifecycleModel；
   - 同时生成 LCI-only 或 LCI + LCIA 的 resulting/dependency Result Process；
   - 首版使用 `resolved-one-hop-aggregated-background.v1` 组合 profile；
   - 将根 `U(P)`、direct provider `R(Q)`、connections、multiplication factors 和 resulting `R(P)` 精确绑定。

稳定的请求维度是：

1. `scope`：单条、指定一批或全部 eligible Process，显式选择使用 `UUID@version`；
2. `outputType`：`result-process` 或 `lifecycle-model`；
3. `resultProcessLayer`：本次生成的 Result Process 包含 `lci` 或 `lci-lcia`，不支持 LCIA-only；它不是 LifecycleModel 的结果层。

`result-process` 对每个 root 只生成一个主要 `R(P)`，不扩展 provider。`lifecycle-model` 对每个 root 生成一个主要 `M(P)`，并在同一次动作的内部执行图中生成 resulting `R(P)` 和 direct provider dependency `R(Q)`。这些 Result datasets 是 Model 闭合所需的组成部分，不是额外的主要用户输出，也不会计入主要对象数量；不会自动生成 provider 的 `M(Q)`。身份与版本集合必须在一次 materialization 中共同求解，不能各自生成后再猜测引用。

## 主路线

```text
读取并验证冻结输入
  -> 冻结 scope + outputType + resultProcessLayer
  -> 仅在 lifecycle-model 模式从 direct edges 派生 required Result set
  -> 确认 metadata completion policy
  -> 派生稳定 identity lineage并读取上一版 manifest
  -> 仅按执行图逐条生成 required Result drafts
  -> 求解并冻结 Result version set / Result Catalog
  -> 仅在 lifecycle-model 模式使用精确 R(Q)/R(P) references 逐条生成 M(P)
  -> 求解 Model version set并渲染精确 references
  -> 生成 canonical dataset collection
  -> schema / reference / LCI-LCIA parity / one-hop reconstruction validation
  -> Materialization Manifest + Dataset Index
```

## 当前可执行入口

第一阶段已经提供 workflow-local 薄 CLI，不增加 `tiangong-release` 顶层命令：

```bash
pnpm install --frozen-lockfile
cd workflows/result-materialization

# 一次性导入本地 Calculation Bundle；支持 evidence ZIP 或解压目录
node cli.mjs intake \
  --bundle /path/to/calculation-evidence-bundle.zip \
  --json

# 生成指定 root 的 LCI + LCIA Result Process
node cli.mjs materialize \
  --intake /path/to/intakes/<bundle-content-hash> \
  --processes <UUID@VERSION> \
  --output-type result-process \
  --result-process-layer lci-lcia \
  --first-generation \
  --json

# 一次完成依赖规划、Result Catalog 和 resolved one-hop LifecycleModel
node cli.mjs materialize \
  --intake /path/to/intakes/<bundle-content-hash> \
  --processes <UUID@VERSION> \
  --output-type lifecycle-model \
  --result-process-layer lci-lcia \
  --first-generation \
  --json
```

依赖只从仓库根唯一 `pnpm-lock.yaml` 安装。Process 和 LifeCycleModel 的 schema 门禁使用发布版 `@tiangong-lca/tidas-sdk@0.2.0`；本 Workflow 保持纯 JavaScript/MJS，不携带 TypeScript compiler 或 schema codegen 运行时。

大批量任务使用同一个 materialization engine 的薄 `nohup` 包装：

```bash
# 立即返回 jobId、PID、日志路径和下一条查询命令
node cli.mjs materialize start \
  --intake /path/to/intakes/<bundle-content-hash> \
  --all \
  --output-type lifecycle-model \
  --result-process-layer lci-lcia \
  --first-generation \
  --json

node cli.mjs job get --job-id <UUID> --json
node cli.mjs job logs --job-id <UUID> --tail 100 --json
node cli.mjs job cancel --job-id <UUID> --json
```

顶层命令和每一个可执行动作都支持就地帮助，例如 `intake --help`、
`materialize --help`、`materialize start --help`、`job get --help`、
`job logs --help` 和 `job cancel --help`。帮助请求退出码为 0，不要求业务参数，
也不会启动或读取任务。

CLI 在 JSON 中返回结构化 `nextAction`（`kind`、`description`、可执行时的 `command` 和可选
alternatives），所有命令使用当前机器上的绝对 `cli.mjs` 入口，不依赖调用者 cwd。Intake 完成后先让
用户选择范围、最终对象和 Result Process 内容层；后台任务运行时优先读取同一 Job 状态，日志只作为
诊断；成功终态直接给出绑定当前 Materialization 与原始 Intake 的 Release Intake 准备命令。

生成阶段默认使用 2 个有界 render/write worker，可以用 `--concurrency 1..16` 调整。并发只控制已经冻结版本后的逐条渲染和写入，不改变 selection、identity/version 规划顺序，也不会启动无界任务集合。增加并发前应先观察相同样本的 RSS、heap、吞吐和磁盘余量。

默认 Job 目录位于 `.release/result-materialization/jobs/<jobId>/`，默认 intake 和 materialization 则分别位于 `intakes/<calculation-id>/<bundle-content-hash>/` 与 `materializations/<calculation-id>/<bundle-content-hash>/<materialization-key-sha256>/`。`--artifact-root` 可以整体迁移这个本地 workspace。高级场景仍可显式提供 `--out-dir`，但不会覆盖已有目录。

后台命令不建立 daemon、队列或自动重试。`start` 只表示本地请求已经持久化并交给 `nohup` runner；只有 `job get` 返回 `succeeded` 且最终 manifest 存在时，Materialization 才成功。状态可区分 `queued`、`running`、`cancelling`、`succeeded`、`failed`、`cancelled` 和 `interrupted`。`job logs` 默认返回最后 100 行，允许 1–500 行，并截断超长单行，避免把大型内容写入 stdout。

Runner 在 phase/progress 更新以及每 5 秒记录结构化资源采样。`job get` 的 `resources` 提供 RSS、heap used/limit、external/array buffers、CPU、阶段/总耗时、当前吞吐、ETA、已写 canonical bytes 和目标磁盘可用空间；`job logs` 中的 `resource_sample` 用于观察趋势。采样是 best-effort，不参与 canonical identity、version 或成功判定。

一次请求只加载一次 Calculation Bundle Context。Result Process 和 LifecycleModel 先用轻量 descriptor 冻结版本，再以有界并发逐条渲染、立即写入，内存中只保留 catalog metadata；Result Catalog 校验逐条读取，不保留所有 Result JSON。LifecycleModel 路线在同一个 staging collection 中追加 Model，不再生成 `results`/`complete` 两套 Result Process，最终验证后只进行一次原子 rename。

`job cancel` 只会向 PID 和 command line 都匹配该精确 Job 目录的 runner 发送 `SIGTERM`，避免 PID 被操作系统复用后终止无关进程。取消或异常退出不会提交 canonical target；可能遗留的 `.work-*`/`.tmp-*` 仍不是有效产物，可以在确认 runner 已停止后清理。首版不提供 checkpoint/resume，失败或中断使用同一冻结输入重新提交。

`intake` 会验证 Calculation Bundle manifest、每个压缩 artifact 的 hash/size，以及 gzip 解压后的 hash/size/record count，再原子地冻结为 Release 自有的 `materialization-intake.v1`。Worker v2 的 `bundleContentHash` 基于原始 canonical manifest bytes（移除顶层 hash 字段）验证，不能先解析为 JavaScript number 再序列化，否则大整数会发生精度变化并产生假 mismatch。默认路径存在时先验证，完整一致则返回 `reused_existing`；残缺或不一致则 fail closed。

`materialize` 与 `materialize start` 使用同一个确定性 engine，冻结相同的 `materialization-request.json`，并根据 `outputType` 选择内部执行图。Result-only 路线只生成 selected `R(P)`；LifecycleModel 路线自动完成 direct provider Result 扩展、Result Catalog 冻结和 requested-root `M(P)` 生成。用户不需要、也不应该先单独运行一次 Result Process 生成。`R(P)` 的 UUIDv5 name 只包含 `U(P) UUID + reference flow UUID`，其他变化由 profile、semantic hash、dataset version 和 provenance 表达。

生成命令必须二选一提供 `--first-generation` 或 `--previous-manifest <path>`。相同 semantic hash 与 version-significant hash 复用版本；语义变化升 major；仅 metadata 等公开内容变化升 minor；同一 UUID/version 出现不同 canonical content时 fail closed。

同一次请求中多个 exact axes 可以共享一个 Result UUID lineage。Workflow 不按 UUID 去重，而是为每个 exact source Process revision 分配独立 dataset version；previous manifest 按 source UUID@version 精确匹配，LifecycleModel 也按 process index 引用对应的 Result UUID@version。first generation 和新增 revision 使用确定性顺序分配未占用的 major version。

Quantitative reference 不假设为 Output。新 process-axis v2 直接提供 raw direction/amount、signed coefficient、normalization scale 和 normalized coefficient；`R(P)` 保留原始方向并使用 normalized amount，`M(P)` 的根 `U(P)` instance 使用 normalization scale。旧 Bundle 只从 intake 内已经 hash 校验的 exact source closure 回推这些字段并记录 legacy fallback evidence，不访问数据库或 mutable latest。领域原则见 [Result Process 与 LifecycleModel 的关系与生成原则](design/result-process-and-lifecycle-model.md)。整个过程不会上传或发布。

`R(P)` 的 reference exchange 不是源 Unit Process exchange 的整体副本。Renderer 只投影已验证的 Flow reference、可选 location、raw direction、normalized amount 和生成状态；allocation、`referenceToVariable`、formula、uncertainty 等依赖源文档其他节点的字段不会跨文档继承。写出前还会检查 generated Process 内 quantitative reference、exchange ID、allocation co-product 和 variable reference 的局部闭合；完整 TIDAS/eILCD 语义校验仍由 Release 阶段执行。

CLI 的 `--json` 输出保持有界，包含 completeness、产物路径和状态感知的下一条可复制命令；错误也返回
当前动作的绝对 help 恢复命令。大数据集始终写入文件。

## 需要用户决定的内容

- 选择处理范围；
- 选择最终对象 `result-process` 或 `lifecycle-model`；
- 是否显式选择未来新增、已经过验证的非默认模型组织 profile；
- 本次生成并由 Model 引用的 Result Process 是 LCI-only 还是 LCI + LCIA；
- 需要使用的上一版 Release Manifest；
- 无法从输入确定的名称、描述、分类、地理、时间、技术和来源字段；
- metadata 冲突时继承、声明或阻塞。

## 主要产物

```text
materialization-request.json
result-catalog.json
model-catalog.json                  # lifecycle-model 模式
canonical-dataset-index.json        # 生成数据集的精确 path/bytes/hash index
canonical-datasets/
materialization-manifest.json
materialization-report.json
```

`canonical-dataset-index.json` 使用 `tiangong.release.canonical-dataset-index.v1`，把每个已生成数据集的 type、role、UUID/version、相对路径、原始文件 SHA-256、canonical content hash 和 byte size 冻结为 `tidas-tools` 可消费的交接契约。Materialization Manifest 绑定该 Index 的 canonical SHA-256。Result-only 模式的 canonical datasets 只有 primary Result Processes；LifecycleModel 模式同时包含 primary Models、resulting Result Processes 和 dependency Result Processes。

Materialization Manifest 还保留 exact source Process、process index、role 和 materialization role。Release validation 失败时，这些 lineage 字段与冻结的 Calculation graph 一起用于计算受影响 roots 及其 Result/Model；Release 不会据此改写本 Materialization。只有完整影响报告证明未排除 roots 不受影响时，后续 Package Plan 才能引用原有 exact outputs 的子集。若修复版本、provider 或 graph，必须创建新的 Materialization Request 并重新验证。

Materialization Manifest 至少绑定：

- 输入 Calculation Bundle 或 Derived Result hash；
- source closure 和 graph evidence；
- recipe ID/version；
- identity、version 和 metadata policy；
- 每个输出数据集的 role、UUID、version、hash 和来源；
- validator 版本和验证结果。

## 必须通过的验证

- TIDAS schema 和 canonical JSON；
- quantitative reference 唯一且完整；
- generated Process 的 exchange ID、allocation co-product 和 variable reference 在文档内闭合；
- source Process、LifecycleModel、Result Process identity/version 一致；
- LifecycleModel resulting Process 引用闭合；
- 每条有效 direct provider edge 与 LifecycleModel provider instance 一一对应；
- Unit、Flow、direction 和 location 映射正确；
- Calculation Bundle 到 Result Process 的 LCI/LCIA 数值一致；
- one-hop Model 重构库存与对应 Result Process 数值一致；
- one-hop 比较只在相同 direction/unit 的可比数量组内确定尺度，当前冻结容差为 `1e-10 + 1e-8 × groupScale`；绝对项容纳近零 quantity 的正常求解消减残差，相对项不跨方向或物理单位放宽校验，超出边界的缺失 flow 与实质数值差异仍然阻塞；
- 相同输入和 recipe 重放得到相同内容；
- 同一 dataset identity/version 不对应冲突内容；
- 版本集合能够收敛。

源 Process 的 `treatmentStandardsRoutes` 或 `mixAndLocationTypes` 缺失/为空时，两个 renderer 都在独立文档副本上使用单空格占位符完成既有 TIDAS 兼容，不修改 intake context。Result Process 与 LifecycleModel 对同一稳定 UUID lineage 的多个 exact source revisions 都先完成批次级版本规划，再并发写入；因此每个 revision 获得独立 dataset version 和文件路径。

任一并发 worker 失败后，调度器停止领取新项并等待已启动 worker 收敛，随后才清理 workspace。任务始终报告最早的领域错误；若清理也失败，只把清理信息附加到原错误，不用 `ENOTEMPTY` 覆盖根因。

## 不属于本 Workflow

- Worker 求解和 Calculation Bundle 生产；
- 用户加权组合等业务语义变换；
- ZIP/分发包构建；
- 人工发布审批和远程写入；
- 把生成数据自动写回 authoring tables。

ZIP/分发包构建属于 Release Candidate Workflow；人工发布审批和远程写入属于 Publication Workflow；业务语义变换属于 Dataset Transformation Workflow。

## 后续增强点

1. 使用真实完整 Calculation Bundle 做大范围 replay、性能和内存基准。
2. 根据真实 replay 继续验证 LCI-only 与 LCI + LCIA 的 lineage/version policy。
3. 增加 metadata completion decision artifact，而不是对无法继承的字段做隐式猜测。
4. 把完成的 `materialization-manifest.json` 接入 Release Candidate Workflow 的候选构建入口。
