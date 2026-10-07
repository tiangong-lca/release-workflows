---
title: Release Workflows Shared Contract
docType: contract
scope: workflows
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 在 workflows 下设计、实现或运行任一 Workflow 时
whenToUpdate:
  - 当所有 Workflow 共享的证据、权限、恢复或文档规则变化时
checkPaths:
  - workflows/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: smaller stable context, scoped routing and truthful handoff boundaries; ownership, immutable evidence and authorization constraints are retained."
related:
  - ../AGENTS.md
  - ../README.md
---

# Workflows 共享契约

Workflow 拥有完整工作包：目标、输入输出、用户决定、确定性证据、外部能力、恢复以及其实现和测试。共享规则在此维护；具体命令、默认值和 recipe 由各目录契约拥有。

## 执行与恢复

- 先 inspect 精确资源和已有证据，再选择动作；不默认从第一步重跑。
- 远程系统拥有远程状态。本地只保存观察、引用和证据，不用旧摘要替代新查询。
- 证据只有在覆盖范围、依赖、hash 与有效期匹配时才能复用；失败不自动使无依赖节点失效。
- 重试停留在同一可恢复节点，或基于新信息创建新节点；不将不确定的远程结果当作可安全重试。
- 本节点完成、生成 handoff、接收端支持和用户授权是四件事。进入后继前读取其输入契约；缺能力则报告 blocker，不修改产物类型以绕过检查。
- stdout 只返回有界摘要与引用；产物写文件或对象存储。CLI 指定的回复模板用于表达，不能覆盖真实状态。

## 用户决定与授权

创建/采用业务对象、耗时计算或远程副作用、Transformation 语义和权重、Candidate 内容及发布动作须有对应用户决定；不能把推荐、默认值、导航或先前不相关授权当作本次决定。

Candidate 成功冻结后不可原地修改。Publication 可规划引用完整的子集；内容变化应生成绑定父 Candidate 的新产物。精确审批及独立回读按 [Publication 契约](publication/AGENTS.md) 执行；Candidate dataset 与 Portal LCIA 是独立 recipe，不混用授权。

## 外部能力与数据面

- 不修改其他仓库或导入其内部源码；控制面调用公开 actor-scoped API/CLI。
- 所属 Workflow 可通过受控 adapter 使用 ignored `.env` 数据库/S3 配置；SQL 参数化、有界并声明读写模式。canonical 写入须同时具备 Workflow 契约和用户明确授权；批量写入采用 staging、验证及原子提升边界。
- 不解码、输出、持久化用户凭据；不把数据库/S3/Supabase secret 放入命令参数、日志或证据。signed URL 不持久化。
- 外部能力不足时报告明确 blocker；transport success 不证明 domain validity 或发布完成。

## 维护与验证

所有 JavaScript/MJS Workflow 共用根 pnpm workspace 和唯一 lockfile；仅从仓库根 frozen install。业务代码、schema、fixture 和测试留在所属 Workflow；根 `test/` 只负责仓库工具链/跨 Workflow 自动化契约。

每个 Workflow 的 AGENTS 维护执行红线及触发式阅读入口，README 维护当前操作与限制。源码、schema、配置和测试解释当前可执行行为；文档与实现冲突时应显式修正，不能擅自改变授权或业务语义。任务进度、历史验收和临时 workaround 不累计为常驻规则。
