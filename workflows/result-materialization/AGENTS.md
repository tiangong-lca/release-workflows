---
title: Result Materialization Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Result Materialization Workflow 时
whenToUpdate:
  - 当 recipe、identity/version、metadata、reference、validation 或输出契约变化时
checkPaths:
  - workflows/result-materialization/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: current Bundle-only intake and unsupported Derived Result handoff are explicit; materialization and path behavior remain unchanged."
related:
  - README.md
  - design/result-process-and-lifecycle-model.md
  - design/local-artifact-path-convention.md
  - ../AGENTS.md
---

# Result Materialization Workflow Agent Contract

## 按动作读取

读取 `workflows/AGENTS.md`；运行时读取本目录 README 的对应动作，改 Result/Model 语义时读取 `design/result-process-and-lifecycle-model.md`，改产物定位与复用时读取 `design/local-artifact-path-convention.md`。不为局部修改加载整份根 README/config。

## 本地验证

从仓库根运行 `pnpm --filter @tiangong-lca/release-result-materialization-workflow test` 验证本 Workflow；`pnpm test` 已包含全部 Workflow case。Process 与 LifeCycleModel 必须由真实 `@tiangong-lca/tidas-sdk@0.2.0` schema 验证，生产依赖图不得带入 TypeScript/compiler/codegen。

## Agent 的职责

- 识别 Calculation Bundle 或已有 materialization artifact；当前 CLI 只消费已验证的 Calculation Bundle intake。
- Dataset Transformation 的 `ready_for_result_materialization` 是尚待接通的接收边界，不能直接作为当前 intake 使用。收到该 handoff 时保留 Derived Result/receipt 并报告能力缺口；不得伪装为 Bundle、重用旧 Result evidence 或补造 LifecycleModel。Result-only 输出还受 Release Candidate package profile 限制。
- 展示可用 recipe、已有证据和必须由用户决定的模型/metadata 问题。
- 冻结精确 Materialization Request。
- 冻结 requested roots、最终输出类型、Result Process 内容层、required Result set 和 direct-edge evidence。
- 调用确定性 identity、version、materializer 和 validator 实现。
- 先冻结 Result Catalog，再使用精确 provider Result references 组合 LifecycleModel。
- 保存 dataset collection、manifest、报告和血缘。
- 只把通过验证的 canonical dataset collection 交给 Release Candidate Workflow。
- Manifest 中每个 dataset 的 exact `sourceProcess`、`processIndex`、role 和 materializationRole 必须足以让 Release 对 validation failure 做反向影响分析；不得仅靠 UUID 或文件名猜测派生关系。
- Worker Calculation Bundle v2 的 content hash 必须在原始 canonical manifest bytes 上移除顶层 `bundleContentHash` 后验证；不得先把任意 JSON number 转成 JavaScript `number` 再重序列化，因为超出安全整数范围时会改变证据字节。
- 正常运行必须使用 `design/local-artifact-path-convention.md` 定义的内容寻址默认路径；路径只用于导航，`materialization-key.json`、manifest、精确 identity/version 和 SHA-256 才是权威证据。
- canonical 路径已存在时必须先验证完整产物：完全一致返回 `reused_existing`，残缺或漂移返回 `artifact_path_conflict`；不得提供静默覆盖 canonical artifact 的 `--force`。

## 本地后台 Job

- `materialize start` 只用 `nohup` 启动现有 materialization engine，不拥有独立 recipe、队列、daemon 或自动重试语义。
- 顶层命令及 `intake`、`materialize`、`materialize start`、`job get`、`job logs`、`job cancel` 都必须支持无副作用的 `--help`，以退出码 0 返回当前动作所需参数。
- CLI 返回的帮助、状态、日志、错误恢复和跨 Workflow 命令必须由 `import.meta.url` 生成绝对入口，能够从任意 cwd 复制执行。`nextAction` 必须包含当前状态对应的 `kind`、`description` 和可执行时的 `command`，不能把多个动作压成一段无结构文本。
- 每次后台尝试使用随机 `jobId`；它只标识执行尝试，不进入 Result/Model identity、version 或 canonical 输出路径。
- `job.json` 和 request 创建后不可改写；`job.log` 只追加；`status.json` 使用临时 sibling + rename 原子更新；终态写入 `exit-code` 和 `result.json`。
- `start` 成功只表示请求已持久化且 runner 已启动，不表示 Materialization 成功。
- `materialize start` 和运行中 `job get` 的首要动作是读取同一个 Job 的有界状态，日志是可选诊断动作；`job get` 观察到 `succeeded` 后必须直接提供绑定输出和原始 Intake 的 Release Intake 准备命令。
- `job get` 必须同时核对 PID 存活和 command line 中的 runner/job directory，不能只用 `kill(pid, 0)` 判断或操作进程。
- `job logs` 必须限制 tail 为 1–500，并限制单行长度；不得把数据集内容、secret 或无界错误详情写入 stdout。
- `job cancel` 只向精确匹配的 runner 发送 `SIGTERM`；终态 Job 的 cancel 是无副作用的幂等读取。
- Runner 消失且没有可信 exit code 时标记 `interrupted`，不得猜测成功或自动重试。
- 进度写入属于 best-effort observability，失败不得改变已经确定性生成或提交的 canonical Materialization 结果。
- Runner 每 5 秒以及 phase/progress 更新时记录结构化资源采样；`job get` 返回最新 RSS、heap、CPU、磁盘余量、吞吐和 ETA。资源采样失败只能降低可观测性，不能污染 canonical stdout 或改变任务结果。
- 同一次请求只加载一次只读 Materialization Context；Result/Model 文档必须以有界并发逐条渲染并立即写入，不得用无界 `Promise.all` 或把所有 canonical 文档保存在数组/Map 中。
- LifecycleModel 路线使用一个 staging collection：Result Catalog 冻结后在同一目录追加 Model，全部验证完成后只进行一次原子 rename。
- 默认并发为 2，公开上限为 16；提高并发必须基于资源日志和代表性样本，不得把并发当作默认性能修复。
- 首版不提供 checkpoint/resume。只有实际运行证明重跑代价不可接受时，才提升本地 Job representation 和 runner 复杂度。

## 输入最低要求

- 精确输入 identity 和内容 hash；
- Calculation Bundle 或等价的 graph/LCI/LCIA/source closure evidence；
- recipe ID/version；
- quantitative reference evidence；
- metadata completion policy；
- previous Release Manifest 或显式首次生成决定。

缺少上述任一项时，不得从远程 mutable `latest` 或相似数据集猜测。

## Recipe 规则

- LCI Result Process、LCI + LCIA Result Process、LifecycleModel 是同一 Workflow 的 recipe；LifecycleModel 本身不含 LCI/LCIA 数值，`resultProcessLayer` 只控制它引用的 resulting/dependency Result Process。
- Recipe 必须声明输出 role、依赖、必需证据和 validator。
- 公开入口必须先收敛 `scope + outputType + resultProcessLayer`；内部 Result/Model 两阶段不得要求用户手动串联。
- `materialize-result` 和 `compose-model` 只是一个 `materialize` 请求内的执行节点，不得作为需要用户先后运行的公开工作流呈现。
- `result-process` 只物化 requested roots，不自动扩展 provider；`lifecycle-model` 才扩展 direct provider Results 并在同一次动作中生成 Model。
- `lifecycle-model` 的主要对象是 requested-root `M(P)`；内部 `R(P)` 标记为 resulting、`R(Q)` 标记为 dependency，且不得自动生成 provider `M(Q)`。
- 主数据集、resulting Result 和 dependency Result 必须分别标记并分别计数。
- LCIA recipe 必须包含或引用同一 Result Process 的完整 LCI 层。
- LifecycleModel recipe 必须同时绑定精确 Result Process identity/version。
- 首版 LifecycleModel recipe 使用 `resolved-one-hop-aggregated-background.v1` 组合 profile，并遵守 `design/result-process-and-lifecycle-model.md`。
- 每条有效 direct provider edge 对应一个引用聚合 `R(Q)` 的 provider process instance；不得只用 root `U(P)` 包装聚合 `R(P)`。
- one-hop 是 LifecycleModel recipe 的显式 profile，不得被隐式套用到不生成 LifecycleModel 的 Result-only recipe。

## 身份与版本

- Identity 由稳定语义输入和 recipe profile 派生，不使用随机 UUID。
- Generated `R(P)` UUIDv5 name 只包含 `U(P)` UUID 和 reference flow UUID，不包含 schema/version 字段，也不依赖 `M(P)` UUID、Result profile、方法集或结果内容；算法与 namespace 只保存在外层 identity evidence。
- 版本规划必须考虑 semantic hash、version-significant hash 和引用版本。
- 先统一解析并冻结 Result UUID/version set，再生成绑定精确 `R(Q)`/`R(P)` references 的 Model version set。
- 同一 Result UUID lineage 可以包含多个 exact source Process revisions；每个 revision 必须获得独立 dataset version，并由 process index/source provenance 精确绑定，不能按 UUID 折叠。
- 同一 LifecycleModel UUID lineage 也可以包含多个 exact source Process revisions；Model 必须沿用相同的批次级 variant 规划，为每个 revision 分配独立 dataset version，而不是把 source version 加入 UUID。
- previous manifest 按 exact source Process UUID@version 匹配 Result variant；新增 revision 按确定性顺序使用未占用的 major version。
- 相互引用的数据集作为集合求解版本，不能分别生成后查询 mutable `latest` 补引用。
- 相同 identity/version 的 canonical content 冲突必须 fail closed。
- 同一 exact source revision 重复出现、Result version 碰撞或同一 identity/version 内容冲突必须 fail closed。
- 缺失或为空的 `treatmentStandardsRoutes`、`mixAndLocationTypes` 使用既有单空格多语言字段兼容；兼容必须对源文档副本显式执行，Result/Model renderer 不得依赖修改共享 context 的副作用。
- 输入或 recipe 改变时，不得静默复用无效 materialization evidence。
- Release 的 exclusion decision 不得原地修改 Materialization。只有报告证明剩余 roots 在冻结 Calculation graph 中不依赖完整排除集合时，Release 才能筛选已经验证的 exact outputs 形成新的 Package Plan；任何替换版本、provider 或 graph 变化都必须回到本 Workflow 重新 materialize。

## Quantitative-reference pivot

- 不得假设 quantitative reference 为 Output；Input/Output、正负 amount 都必须保持 Worker 的 signed normalization 语义。
- 新 Calculation Bundle 必须从 process-axis v2 读取 raw direction/amount、signed coefficient、normalization scale 和 normalized coefficient，并与 exact source closure 交叉验证。
- 旧 Bundle 只允许从 intake 已校验的 exact source-closure Process 回推 pivot；不得查询数据库、mutable latest 或相似版本，并必须在 descriptor 中记录 legacy fallback evidence。
- `R(P)` reference exchange 保留 raw direction、使用 normalized amount；`M(P)` 根 `U(P)` instance 使用 normalization scale。
- `R(P)` reference exchange 必须从已验证的源 reference exchange 做显式字段投影，只保留 Flow reference、可选 location、direction、normalized amount 和生成状态；不得复制依赖源 Process 其他 exchange 或 variable definitions 的 allocation、`referenceToVariable`、formula 或 uncertainty。
- 写出前必须对 generated Process 执行聚焦的内部引用检查：quantitative reference、exchange ID、allocation co-product 和 variable reference 必须在生成文档内闭合。该检查只保护 renderer 自己建立的引用，不复制或替代 Release 的完整 TIDAS/eILCD 语义门禁。

## 可由 Agent 提出的内容

- 候选 recipe；
- metadata 字段草案；
- 缺失信息和可选来源；
- 版本变化解释；
- 验证失败的最早返回点。

Agent 提议不能替代用户对模型结构、重要 metadata 和首次 lineage 的决定。

## 硬边界

- 不重新求解 LCI/LCIA。
- 不执行用户业务加权或模型语义变换。
- 不把 Result weighted aggregation handoff 扩大为 LifecycleModel 聚合；只有独立确认的 model operation 才能引入新的模型图语义。
- 不改写源 Unit Process。
- 不生成只有 LCIA、没有有效 LCI/reference basis 的 Result Process。
- 不让 LifecycleModel 引用另一次 materialization 的未验证 Result Process。
- 不忽略有效 direct provider edge，也不从源 Process 文本猜测 provider connection 或 factor。
- 不跳过 TIDAS、引用闭合和数值一致性验证。
- one-hop 数值一致性按相同 direction/unit 的可比数量组计算尺度，冻结容差为 `1e-10 + 1e-8 × groupScale`；绝对项用于容纳近零 quantity 的正常线性求解消减残差，相对项只使用同 direction/unit 的组内尺度，不得跨方向或单位借用尺度。
- 并发 worker 首次失败后不得领取新任务，必须等待已经启动的 worker 收敛后再清理；清理异常不得覆盖原始业务异常。
- 不打包或远程发布。
- 不写入远程 authoring tables。

## 完成条件

完成的 materialization 必须产生冻结的 selection、Result Catalog、canonical dataset collection、独立 `canonical-dataset-index.v1`、materialization manifest 和验证报告；Manifest 必须绑定 Index hash。每个输出都能追溯到精确输入、recipe、direct edge、identity/version 决策和 validator evidence；每个 one-hop Model 必须在冻结容差内重构对应 Result Process。
