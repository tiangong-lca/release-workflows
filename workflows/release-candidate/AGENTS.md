---
title: Release Candidate Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Release Candidate Workflow 时
whenToUpdate:
  - 当 intake、package、candidate qualification、scope refinement 或 Candidate 后继路径变化时
checkPaths:
  - workflows/release-candidate/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: available Transformation help is distinct from unsupported downstream consumption and Result-only packaging; qualification and authorization are unchanged."
related:
  - README.md
  - ../AGENTS.md
---

# Release Candidate Workflow Agent Contract

## 按动作读取

读取 `workflows/AGENTS.md`；运行 cache、intake、package 或 failure 动作时，只展开 README 的相应章节及 CLI 指定模板。跨 Workflow 能力限制见 README 的 package profile 说明；下一步导航不授予操作权限。

## Agent 的职责

- 解析精确输入和已有 candidate 状态。
- 根据用户目标提出 package recipe，不擅自扩大 Candidate 内容。
- 验证 Result Materialization 输出与 frozen dataset bytes 的精确绑定。
- 调用确定性 validator、converter 和 packager。
- 当本地 package validation 发现数据错误时，使用冻结的 issue spool、精确 dataset identity、Calculation graph 和 Materialization lineage 生成完整排除影响报告；不得把报错数据直接称为孤儿。
- 从权威 impact report 生成供用户审核的 Excel 工作簿，逐页做视觉检查，并在回复中同时提供 JSON 和 Excel；审核表准备好之前不得请求排除确认。
- 把修复、完整集合排除或停止决定绑定到精确 impact-report hash；只有完整集合排除被明确确认后才允许构建新的 scope-filtered Candidate。
- 汇总候选、验证证据和 plan hash 供用户决定。
- Candidate 成功后展示 Publication planning 和 Dataset Transformation 两个后继方向。

## 可自动执行的动作

- 只读检查输入、manifest 和既有 Candidate 状态；
- 构建本地 Package Plan；
- 运行不产生远程副作用的验证和打包；
- 生成有界 candidate report；
- 对 preserved failed build 执行只读影响分析，并生成不改变权威证据的本地 Excel 审核视图；

## 当前本地 Package 契约

- `intake prepare` 从不可变的 Materialization Intake 和完整 LifecycleModel materialization 生成独立 Release Intake；不得原地修改任一上游 manifest。
- Release Intake 按精确 UUID/version 补齐 LCIA Method characterisation factor 引用但 source closure 缺失的 Flow。常规 Intake 只消费项目级 Elementary Flow 缓存；以 published count 和 `MAX(modified_at)` 判断缓存 freshness，缺失或过期时 fail closed，并只提示显式刷新命令。缓存刷新必须使用有界、只读 snapshot，不得由 Intake 隐式触发。显式 `cache refresh` 默认把导出放到受管 Worker EC2 上执行：Release 通过 SSH stdin 传递本次进程内数据面配置，远端不落凭据文件；远端向同一 Supabase project 的 Storage 写入一小时有效的临时 gzip artifact，本地下载并逐条校验后先删除临时对象，再原子替换共享缓存。数据库与 Storage project binding 无法一致验证时必须 fail closed。
- 慢速本机数据库流式刷新只可通过显式 `--execution local` 使用；远端路径失败时不得静默降级。
- `package build` 只接受已准备并重新验证上游 hash 的 Release Intake，以及 `standalone-lifecyclemodel-result-full-closure.v1`。
- `failure analyze` 只接受 preserved failed build、其原始 Release Intake 和可验证的 TIDAS issue spool。它必须同时遍历 exact Process axis、technosphere 反向依赖、Materialization `processIndex/sourceProcess` lineage 和 canonical 文档引用；canonical 引用必须保留字段路径和 TIDAS 语义角色，`referenceToPrecedingDataSetVersion` 只作为 lineage，不参与包内可达性或剩余引用冲突。输出中分别列出初始错误、受影响 Process roots、派生 Result/Model、变得不可达的 support datasets 和剩余引用冲突。
- `failure review` 使用 Workflow 声明的公开 spreadsheet dependency，从 exact impact report 生成 `exclusion-impact-review.xlsx`、七张 project-owned SVG 预览与 review receipt；不得要求客户端 Agent 提供私有 runtime 或额外 `node_modules` 路径。工作簿必须包含 Summary、Invalid Data、Affected Roots、Derived Data、Unreachable Support、Complete Exclusion Set 和 Reference Conflicts 七个工作表，并在回复用户前完成 XLSX 回读、关键范围、公式错误和全部工作表的视觉检查。
- 没有 inbound reference 不能单独证明 orphan。只要一个数据集本身是冻结发布 root，就必须标记为 `invalid_selected_root`，并将删除它视为发布范围变化。
- `failure decide` 必须记录非空 `--reason` 和 `--decided-by`；`--action exclude` 还必须携带与报告 canonical SHA-256 完全一致的 `--confirm-impact-sha256`。确认对象是完整 `excludedSetHash`，不是最初报错的 UUID 列表。`repair` 保持推荐动作，`stop` 保留 failed build 而不创建 Candidate。
- Exclusion impact report 是稳定的 F3 Workflow contract；改变发布内容的 scope decision 是 F4 审计证据。Excel 是可编辑的 F2 派生审核视图，只通过 receipt 绑定源报告 hash 和当前 workbook hash，不参与 scope decision hash。权威报告和决定均不可原地修改，运行时绝对路径单独保存在权限受限 locator 中。
- `package build --scope-decision` 只消费 `action=exclude`、hash 与全部冻结上游仍匹配且 `safeToExclude=true` 的决定。它按精确 canonical path 过滤完整影响集合，冻结新的 Package Plan，再重新执行全部 TIDAS/eILCD、closure、round-trip 和最终 ZIP readback validation；不得复用失败构建的通过结论。
- Result Materialization 的 Index 只描述新生成数据集；Release 从 source closure 与冻结的 dependency supplement 加入 Unit Process 和支持数据集，生成供 `tidas-tools` 使用的完整 Index。
- source closure artifact hash、record count、每条 document canonical hash，以及 materialized dataset bytes 必须在调用外部工具前重新验证。
- Package Plan 不记录机器绝对路径；它只绑定 manifest/index/bundle hashes 和 canonical input summary，保证换目录重放不改变计划语义。
- Release 只遍历当前契约明确声明的 LCIA Method -> Flow 依赖；通用引用闭合、TIDAS/eILCD validation、conversion、round-trip 和四包构建必须委托 `tidas-tools release build-packages`，不得在本 Workflow 重写。
- 委托前必须对所选 `TIDAS_BIN` 执行 `version` 与 `validate --describe` 握手，并精确要求已治理的 `tidas v0.2.0` 与 `document-validation-batch.v1`；不得用 PATH 中的旧二进制静默降级。
- Release Candidate 的完整闭包构建和逐包 qualification 必须显式向全部 TIDAS 子进程传递同一内存预算。默认值由本 Workflow 拥有并设为 `2048 MiB`；调用者可通过 `--tidas-memory-budget-mib` 或 `TIDAS_MEMORY_BUDGET_MIB` 覆盖。`memory_budget_exceeded` 是可恢复的资源配置失败，必须保留失败证据并返回同一冻结输入、提高预算的精确重试命令，不得建议 `failure analyze` 或数据排除。
- Candidate 必须正好包含四个 ZIP、每个文件的 byte size/SHA-256、完整工具报告、hash-bound `publication-catalog.json`，并显式记录 `publicationAuthorized=false`。
- Candidate v2 的 Publication catalog 必须从当前 canonical bytes 确定性提取 exact required references，绑定 canonical index hash，并冻结 Unit Process/Result roots 与 component closure；不得从 ZIP 名称推断。
- 四个分发包必须使用显式 release version 和产品级数据库名称；内部 profile ID 只保留在机器证据中。每个最终 ZIP 必须在候选冻结前重新列举、隔离解压，并分别通过 TIDAS 或 eILCD validation。
- 用户未提供 release version 时，Agent 必须使用 CLI 返回的推荐版本和专用回复模板请求确认；确认前不得启动构建。不得把年月推荐值或 mutable `latest` 当作用户已确认。
- 输出目录不可覆盖。只有四包回读校验全部通过才能原子提交可见 Candidate；包已经生成但 qualification 失败时，必须把 ZIP、结构化失败清单、已有验证报告和逐包回读目录保留为唯一 sibling failed build，并明确 `candidateCreated=false`、`publicationAuthorized=false`。它是诊断产物，不是 Candidate，也不得被发布。
- `tidas release build-packages --format json` 非零退出时，必须把有界 stdout 解析为结构化 operation report 并写入 failed-build diagnostics；只有 stdout 不是有效 JSON 时才保留有界文本尾部。不得只保留 stderr 而丢失字段级 validation evidence。
- CLI 的人类输出必须包含有界 `Summary / Next / Reply using template`；JSON 输出必须保持单对象、可解析，并携带 `outcome`、`completeness`、artifact 引用、`nextActions[]` 和 `replyTemplate`。
- Candidate 成功结果还必须携带结构化 `nextDecision`，列出 Publication planning 和已可用的 Dataset Transformation inspect/freeze/execute 入口，同时披露 Derived Result 消费与 Result-only package 的能力缺口；不把可执行的本地节点描述成已完成的端到端路线。
- cache refresh 的 CLI 输出和错误不得包含连接串、S3 secret 或 presigned URL。成功结果可以披露 execution mode 与 SSH host，但不能披露临时 object locator。
- CLI 返回的自身命令和跨 Result Materialization 命令必须使用由 `import.meta.url` 生成的绝对入口，确保从任意 cwd 可复制执行。Release Intake 准备成功后应返回确定的 Candidate 输出目录，不把 `<CANDIDATE_DIR>` 留给 Agent 猜测。
- CLI 必须拒绝未知和重复参数。失败使用非零退出码，并区分人类可读 stderr 与 `--json` 结构化 stderr。
- Agent 回复必须读取 CLI 指定的 workflow-local 模板，以真实字段替换占位符；不得把 Candidate build 回复成批准、上传或发布完成。
- Agent 在 `failure analyze` 后必须继续完成 `failure review`，向用户提供可点击的 JSON/Excel 路径、分类计数、排除前后数据量及 repair/exclude/stop 三种选择；不得把只包含计数而没有完整 Excel 清单的回复当作排除确认请求。

## 必须明确确认的动作

- 选择最终 Candidate 内容和 package recipe；
- 确认排除影响报告中的完整数据集集合及其 hash；
- 冻结 Release Candidate；

## 硬边界

- 不使用 service-role、secret key 或直接 SQL/REST mutation。
- 不解码、打印、持久化或放入命令参数的用户凭据。
- 不从 mutable `latest` 补齐 graph、exchange、provider、method 或 version。
- 不在 Package build 中生成或修改 Result Process、LifecycleModel、identity 或 dataset version。
- 不把 partial closure 或未通过必要验证的 package 冻结为 Candidate。
- 不把 validation error 降级为 warning，不提供忽略错误继续打包的开关，也不把 mutable `latest` 作为替换候选自动应用。
- 不直接从失败 Candidate 删除文件；排除只能生成新的 immutable scope decision、Package Plan 和 Candidate。
- 不执行 prepare、upload、approve、publish、supersede、unpublish 或撤回等远程发布动作；这些动作属于 Publication Workflow。
- 不在 Dataset Transformation 或 Publication 中原地修改本 Workflow 冻结的 Candidate。
- 不因缺失外部能力修改其他仓库。

## 完成条件

Release Candidate 只有在以下条件同时成立时完成：

- 精确输入、Package Plan 和 dataset bytes 绑定一致；
- 所有要求的 TIDAS/eILCD、closure、round-trip 和最终 ZIP readback validation 通过；
- Candidate 原子冻结且明确记录 `publicationAuthorized=false`；
- 证据和恢复信息已保存；
- 下一步明确指向原 Candidate 的 Publication planning 或 Dataset Transformation。
