---
title: Environment Workflow Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当准备 Release 本机配置、检查环境或修改共享加载机制时
whenToUpdate:
  - 当配置来源、能力检查、引导或本地写入边界变化时
checkPaths:
  - workflows/environment/**
lastReviewedAt: 2026-11-08
lastReviewedCommit: df7d513a37111f16a1ea11afd4bbc6aebf80d6a3
lastReviewedNote: "Release #135: reviewed Environment ownership, shared configuration and bounded read-only diagnostics; business execution and publication authority remain with their workflows."
related:
  - README.md
  - ../AGENTS.md
---

# Environment Workflow

本 Workflow 拥有本机配置准备、共享配置加载、按能力诊断及修复引导。它可在任何业务
Workflow 前使用；不创建统一业务 stage，不接管业务执行、输入资格或发布授权。

## 操作边界

- 从本目录 README 和 CLI help 选择 `check`、`guide`、`init` 或 `sync`。
- `check` / `guide` 不写配置、不安装工具、不交换用户会话、不执行 SSH 密钥提取。
  `--report` 只可新建私有诊断文件，不覆盖历史。
- `init --confirm-init` 只新建空值模板；已有文件拒绝覆盖。
- `sync --source <file> --confirm-sync` 只复制缺失的数据面白名单配置，不复制 actor
  密码/API key/JWT，保留已有值；原 Calculation 环境同步入口委托相同实现。
  不把不同已有数据库连接的 CA 自动混用。
- 默认只读固定仓库位置的 `.env`（不存在时使用进程值）；`--config-env` 显式选择其他
  文件，缺失则失败。不扫描父目录、workspace、shell 配置或 AWS credential chain。
- 非空进程值与同名文件值不同即报冲突。路径相对配置文件目录；工具裸名称保留 PATH
  查找，提供 CA 时统一 verify-full。配置变化不得改变冻结 Candidate 或原目标身份。
- 加载函数返回独立 environment，不修改调用者。独立 CLI 只把当前动作白名单的有效值
  安装到自身进程供已有 adapter/工具使用，不改变父 shell；后续 Release 命令携带配置路径。
- 离线动作不加载数据库/actor/reader 配置；actor-only 动作只加载用户配置。
  Readiness session bootstrap 仍须其独立开关；核验本身不得登录。

## 验证边界

- 仅检查所选能力。缺少数据库凭据不得阻止离线出包；已有编码器不要求 Rust/CMake。
  Node/pnpm 版本差异是诊断，不恢复 engineStrict 安装门禁。
- 本地核验输出路径可写性、可用磁盘/内存；没有显式容量需求时不声称能承载某一批数据。
- `--remote` 才运行有界只读探测：数据库只读事务/服务角色、S3 HeadBucket、当前用户
  GET 和 reader GET /health。借用所属 Workflow 的适配器，不导入其他仓库实现。
- 可选精确 Candidate 的预检复用 Publication 本地绑定校验和 describe，不调用 ensure、
  stage、seal、register、approve 或 activate，不产生上传或登记。
- HEAD 成功不证明写权限/对象大小上限；health 成功不证明签名查询或数值；认证成功
  不证明 data manager 业务权限。用 `not_checked` 明示这些边界，不用历史报告替代执行前检查。
- stdout/报告仅包含有界状态、来源、设置名称、白名单诊断码和修复动作，不含凭据、连接串、
  provider 响应原文。JSON 单对象；阻塞检查非零退出，帮助不读配置或访问网络。

## 完成条件

所选环境条件已逐项诊断，未验证能力明确，阻塞项具有可执行修复入口，用户可按原业务
Workflow 继续。环境检查成功不授权执行计算、上传、登记或发布。
