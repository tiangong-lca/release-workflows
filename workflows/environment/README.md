---
title: Release 环境核验与配置引导
docType: guide
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当首次配置本机、更新代码后核验环境或排查配置问题时
whenToUpdate:
  - 当配置加载、核验入口、检查范围或修复步骤变化时
checkPaths:
  - workflows/environment/**
lastReviewedAt: 2026-11-10
lastReviewedCommit: 26d26485ca0ae10832418e06c6c6f4f43256fbe1
lastReviewedNote: "Release #140: reviewed explicit shared user-session acquisition, Publication prerequisites and same-actor renewal; tokens remain memory-only and business confirmation/server authorization stay mandatory."
related:
  - AGENTS.md
  - ../../.env.example
  - ../README.md
---

# Environment

在首次使用、更新代码或切换机器后，先核验当前要用的能力。Environment 负责本机准备；
Calculation、Materialization、Candidate、Transformation、Publication 继续负责业务动作。

## 开始检查

在仓库根运行项目入口：

```bash
pnpm run doctor
pnpm --silent run doctor --for candidate --json
pnpm --silent run doctor --for storage --remote --json
```

`pnpm run doctor` 默认检查本地运行环境；必须保留 `run`，避免调用 pnpm 自带的 doctor。需要机器解析时使用 silent 模式，避免包管理器
脚本标题混入 JSON。可从任意目录使用 workflow-local CLI 的绝对路径；CLI 返回的
`nextActions[].argv/command` 均为可复制的绝对入口。

| `--for`           | 本地核验                                                     | `--remote` 额外核验                                                                        |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `local`           | Node/pnpm、输出目录可写性、磁盘及内存观察                    | 无                                                                                         |
| `materialization` | 本地条件及 SDK 依赖安装版本                                  | 无                                                                                         |
| `candidate`       | Toolkit Result-only/validation 能力、合格 7-Zip、HDF5 编码器 | 无                                                                                         |
| `calculation`     | 用户/API 配置和凭据来源                                      | 已有 JWT 的当前用户 GET；仅有 bootstrap 时标未验证、不登录                                 |
| `download`        | 数据库、CA/TLS、存储目标和凭据                               | 数据库只读连接、存储桶 HEAD                                                                |
| `storage`         | 上传/登记所需的目标配置                                      | 同上；可附加精确 Candidate describe 预检                                                   |
| `publication`     | 用户会话及发布控制面配置；缺少会话明确阻塞                   | 当前用户验证、manager-only Publication head，只观察、不创建 run；可附加 Candidate 存储绑定 |
| `readiness`       | 存储、用户凭据来源和私有查询服务配置                         | 同上，以及已有用户 GET、reader GET /health                                                 |

`check`、`guide` 默认不联网，不上传或登记。`check --remote --bootstrap-session` 是显式登录例外：仅用既有用户配置获取进程内短期 JWT，再执行只读探测，不创建发布 run 或业务对象。它们不启动业务计算、修改输入、批准或激活。
Toolkit 的 version/describe/help 与本机工具握手属于本地核验，不生成业务产物。

```bash
node workflows/environment/cli.mjs guide --for candidate --json
node workflows/environment/cli.mjs check --for storage \
  --config-env /absolute/path/operator.env --remote \
  --candidate /absolute/path/frozen.candidate \
  --report /absolute/path/new-environment-report.json --json
```

报告包含配置来源、逐项 `passed/blocked/warning/not_checked`、安全诊断码、修复指引、
完整性范围及下一步。普通诊断不需要数据库登记。`--report` 只新建 mode 0600 文件；
不指定时不持久化报告。检查被阻塞退出 1；参数/命令失败退出 2；成功退出 0。

## 一份配置、同一套规则

所有 Release CLI 使用同一个加载器：默认固定仓库根 `.env`；可用 `--config-env` 选择
另一个文件。默认文件不存在允许只使用进程值，显式指定的文件不存在则失败。
不随 cwd 寻找 `.env`，不扫描 workspace 或用户目录，不执行 shell、插值或 AWS 自动发现。

CLI 只加载当前动作需要的白名单：离线处理不读取数据库/用户凭据，actor-only 发布动作
不读取数据面凭据。纯加载函数不修改输入；独立 CLI 将有效配置用于自身进程及现有工具，
不改写父 shell。非空进程值与文件不同报 `final_environment_conflict`，不静默选择。
配置来源记录仅含文件路径和设置名称，任何模式均不输出值。

CA、TLS 文件和带路径的可执行文件相对选中的配置文件目录解析；没有文件时相对 cwd。
裸工具名保留 PATH 查找。`TIDAS_BIN` 为 Toolkit 首选，`TIANGONG_TIDAS_EXECUTABLE`
为备用；编码器默认复用当前仓库已构建的 debug binary，否则设置 `RELEASE_HDF5_BIN`。
提供 `RELEASE_DATABASE_CA_FILE` 时统一使用 verify-full；不同 `sslrootcert` 冲突拒绝。
这些连接准备不改变已有数据库/存储目标 hash。

设置说明及空值示例以根 `.env.example` 为准。业务 Workflow 继续在执行时检查目标、权限
和输入；环境报告只表示观察当时、所选范围的诊断结果。

## Toolkit 二进制准备

`candidate`、`storage`、`readiness` 等需要 Toolkit 的核验与构建使用 `TIDAS_BIN`（其次
`TIANGONG_TIDAS_EXECUTABLE`，最后 PATH 中的 `tidas`）。请使用官方发布的预编译二进制：

1. 从 `https://github.com/tiangong-lca/tidas-toolkit/releases` 下载与当前平台匹配的归档；
2. 使用同一 release 的 `SHA256SUMS` 校验归档，再解压；
3. 将 `TIDAS_BIN` 设为解压后 `bin/tidas` 的绝对路径；
4. 先执行 `pnpm run doctor --for candidate`，确认 `tidas: passed` 后再执行业务构建。

仓库 checkout 内的 `target/` 构建产物只用于当前源码的开发验证，版本可能落后于官方
release，不应作为 Candidate 构建来源。`TIANGONG_TIDAS_TOOLS_EXECUTABLE` 等历史键不在
配置白名单内，不会生效。能力握手只验证协议/能力，不绑定精确版本号。

## 配置引导和本地准备

```bash
node workflows/environment/cli.mjs guide --for storage --json
node workflows/environment/cli.mjs init --confirm-init
node workflows/environment/cli.mjs sync --source /absolute/path/source.env --confirm-sync
```

`guide` 列出缺失设置及工具修复动作，不写文件。`init` 从 `.env.example` 新建空值模板，
有文件时拒绝覆盖。`sync` 必须显式提供源文件，只补缺失的数据面白名单值，保留已有值，不替换符号链接，
不复制用户 API key/JWT；证书路径先相对源文件解析，不把不同已有数据库连接的 CA 自动
混用。查看 `copiedKeys/preservedKeys/missingSourceKeys/skippedKeys` 后再运行相应 check。
Calculation 的原 `environment sync` 委托相同实现。

安装缺失依赖用 `pnpm install --frozen-lockfile`。编码器缺失时可运行
`pnpm run native:build`，此时才需要 Rust/CMake；已有合格编码器时不要求构建工具。
Toolkit 核验实际能力；7-Zip 资格与 Candidate 的现行固定版本一致。Node/pnpm 差异会
显示诊断，但不引入 engineStrict 安装拦截，也不自动修改运行时或升级依赖。

`--output-dir` 只检查最近已存在的父目录，不创建业务目录。默认报告可用空间；
可显式给 `--min-free-gib` 声明本次最低磁盘需求，没有需求时不承诺批次容量。

## 如何理解通过

数据库通过只证明只读事务和角色可用；HEAD 只证明该探测可达，不证明 PUT 权限、
bucket 大小限制或未来传输成功。reader health 有明确服务标识时只证明存活；网关仅返回通用健康响应时保留警告、明确未识别查询服务。它不证明签名密钥一致、
HDF5 数值或选中发布范围。用户认证也不替代具体命令的 manager 授权。

这些未核验能力会明确列出。完整文件回读、reader 数值验证和发布批准仍使用 Publication
自身入口，Environment 不调用这些写入或业务验证动作。

## Publication 用户会话

无需手工复制 JWT。现有 `TIANGONG_LCA_API_KEY` 是用户登录来源，`check` 默认只观察；
进入发布前显式执行：

```bash
pnpm --silent run doctor --for publication --remote --bootstrap-session --json
```

可附加 `--config-env` 和 `--candidate`；后者只验证精确本地 Candidate 和已有存储登记，
不会创建选择/计划/run。`credential_source` 只表示来源已配置；`actor_session` 表示当前
进程有可用会话；`actor_authentication` 和 `publication_access` 分别由服务器验证当前用户
及 manager 权限。仅有 API key、没有现成 JWT 且未显式登录时，Publication/readiness
检查必须阻塞。离线有 JWT 也不表示服务器认证已通过，`operationPrerequisites.ready`
明确区分这些情况，不把 `ok` 当作业务执行许可。

Calculation、readiness、最终 Publication 命令共用 Environment 的用户会话实现。
最终 `result-publication` 和 `result-readiness` 命令均支持 `--bootstrap-session`，每次按需
换取会话，token 只留内存、不写 `.env`、日志、报告或 session cache，不保存 refresh token。
已有显式有效 token 优先；过期/无效显式 token 会报错，需清除该旧进程值后重新显式登录，
不会在错误身份间静默回退。配置引导不要求用户手动提取 JWT。

登录只调用固定 Auth password endpoint；拒绝非 HTTPS/非 loopback、重定向、服务密钥
和无界/超时响应。服务器认证与 manager 检查仍是权限权威；解码 claims 仅用于排除错误
或过期凭据。登录成功不等于批准/激活，业务动作仍要求原来的精确确认。

共享登录使用现有 [Supabase Auth password token 与 current-user API](https://github.com/supabase/auth#endpoints)，不新增 SDK 或服务器版本依赖；服务端仍验证真实用户及其业务权限。
