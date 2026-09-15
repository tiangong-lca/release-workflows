---
title: Publication Reply Templates
docType: reference
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Publication CLI 返回 replyTemplate 时
whenToUpdate:
  - 当 Publication CLI outcome、artifact 或恢复动作变化时
checkPaths:
  - workflows/publication/reply-templates/**
  - workflows/publication/reply-template-registry.mjs
  - workflows/publication/cli.mjs
related:
  - ../README.md
  - ../AGENTS.md
---

# Publication 回复模板

- 回复模板是 F1 Agent 表达指导，不是远程状态、授权或审计事实来源；权威值来自 CLI JSON 和本地 artifact；
- 只使用 CLI 返回的真实事实替换占位符；
- 模板按真实沟通语义划分，不按 CLI 命令数量扩张；Portal LCIA 只使用 Plan prepared、Lifecycle result 和 Command failed 三类；
- 模板只要求 `command`、`outcome`、`completeness`、`artifacts`、`nextActions` 等共同上下文；exact identity/hash 按当前结果择要呈现，不在模板中重复枚举所有 evidence；
- Draft Plan 或 Executable Plan 准备成功不表示已经审批、写入或发布；
- 回复必须披露自动补齐的依赖和因排除而递归剪枝的数据数量；
- 回复必须披露 mixed-state 目标：Result Process 目标是 120，普通 Unit/Model/support 保持 100；dependency member 不跟随选中组件；
- 不输出 credential、内部 locator 或未确认的远程状态；
- Approval 回复必须展示 exact Executable Plan 和 Approval SHA-256；含 Result Process operation 时还必须说明 manager attestation 是 manager 断言而非机器验证血缘；
- Execution 回复必须披露独立回读仍待完成，并给出 Receipt/events；
- 只有 Readback Receipt `status=verified` 时才能回复 Publication 已完成；
- Result Process 准备回复必须披露 `prepare` 只做只读远程准备：`candidate_content_matches_existing` 仅是内容候选观察，不是授权也不是 no-op 证据；不得声称已写入。Result execute 必须披露没有中间 `0`/`100` row，Result verify 必须披露 Release 自己重算了 byte hash 与 canonical content identity；
- Portal LCIA Plan 只是未授权计划，只有 exact Plan SHA-256 确认后才能执行相应写入；
- Portal LCIA V3 package publish 与 projection finalize 是两个独立 exact-confirmation 边界；package-published Event 必须披露 projection 仍 pending 和可能的 unavailable 间隔；
- Projection-finalized Event 明确保留 `independentReadbackVerified=false`，只有独立回读生成 verified Event 后才能声称公开投影闭环完成；
- Projection revoke 必须展示精确 finalized Event SHA-256，且只有独立回读为 `revoked` 后才能声称已停止公开；
- Package/revoke reused 或 response-loss Event 必须展示 `reasonPersistence`，不把本次请求理由冒充远端已持久化理由；
- 失败回复使用 CLI 提供的恢复入口，不建议删除或覆盖 execution event；只有新增独立的安全或沟通语义时才增加模板。
