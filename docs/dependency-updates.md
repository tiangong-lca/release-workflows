---
title: Release 依赖更新维护
docType: guide
scope: repo
status: active
authoritative: false
owner: release
language: zh-CN
whenToUse:
  - 当审查依赖或 GitHub Actions 更新 PR 时
  - 当修改 Dependabot 监控范围、分组或节奏时
whenToUpdate:
  - 当依赖监控、验证入口或兼容性审查要求变化时
checkPaths:
  - .github/dependabot.yml
  - docs/dependency-updates.md
  - pnpm-lock.yaml
lastReviewedAt: 2026-10-16
lastReviewedCommit: e742f068222fe625faaa591f45c9dd832dd3d7b1
lastReviewedNote: "Release #82 adds scoped monitoring using existing CI; lock-only maintenance retains review guidance without mandatory metadata churn, while manifests, source and runtime contracts keep their existing review requirements."
related:
  - ../AGENTS.md
  - ../.github/workflows/ci.yml
  - architecture.md
---

# 依赖更新

Dependabot 从仓库根监控唯一 pnpm workspace，覆盖根工具链及五个 Workflow package；不分别建立安装树或 lockfile。npm 每周五 04:00、GitHub Actions 每周五 04:20 检查，时区均为 Asia/Shanghai，冷却期均为七天。npm 最多两个版本更新 PR，Actions 最多一个；安全更新不受该版本更新冷却期限制。

Postgres 的 `pg` 与 `pg-query-stream`、AWS SDK 与 Smithy 分别组合兼容的 minor/patch 更新；其余运行时和开发依赖按角色分组。package major 更新保持独立可见。`@tiangong-lca/*` 不进入运行时批量分组，尤其 pre-1.0 SDK 的 minor 更新也须单独检查公开 API 与数据契约。Actions 更新使用独立分组，未配置自动合并。

现有 CI 已对 PR、`main` push 和手动运行执行 frozen install 与 `pnpm run prepush:gate`。依赖 PR 直接复用这一无发布凭据的验证入口，不增加其他 gate。仅从仓库根执行：

```bash
pnpm install --frozen-lockfile
pnpm run prepush:gate
```

审查实际 manifest/lockfile diff、升级说明和测试结果；保留 `.node-version` 与根 manifest 指定的工具链、`pnpm-workspace.yaml` 的有效策略、`exceljs>uuid` override，以及精确内部 SDK 引用。更新这些契约时，需要显式兼容性判断及相关 Workflow 验证；不得为了让依赖 PR 通过而放宽生产依赖图、API、schema 或数值测试。

仅有 lock resolution 变化时，Docpact 要求根契约与本指南存在，不强制制造文档 review metadata diff；仍须人工检查解析变化并运行既有测试。manifest、workspace 策略、运行时、源码及 Workflow 的既有 review 义务保持有效；包含这些路径的混合变更继续触发它们，不能借 lockfile 规则豁免。

配置从 `main` 生效；合并配置和本地测试通过不等于 GitHub updater 已运行或完成首次 lockfile 更新。另行检查仓库安全设置、首次实际更新日志与 PR。依赖监控不授予数据库、S3、计算任务或 Publication 操作权限；远程发布仍须按所属契约绑定精确输入、审批和独立回读。

参考：[Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)、[version-update configuration](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-version-updates)。
