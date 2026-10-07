---
title: Result Materialization 本地产物默认路径设计
docType: design
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当实现或评审 .release 下的默认产物路径时
  - 当设计 intake、materialization 的复用和冲突行为时
  - 当决定 CLI 应自动选择路径还是接受显式覆盖时
whenToUpdate:
  - 当默认路径、复用或冲突行为变化时
  - 当 artifact identity、manifest 或跨 Workflow handoff 变化时
checkPaths:
  - workflows/calculation/**
  - workflows/result-materialization/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: current Bundle-only intake and unsupported Derived Result handoff are explicit; materialization and path behavior remain unchanged."
related:
  - ../README.md
  - ../AGENTS.md
  - ../../calculation/README.md
---

# Result Materialization 本地产物默认路径设计

## 目标

用户正常运行 Workflow 时不应手工设计目录名。默认路径应当做到：

- 从路径可以判断产物属于哪个 Workflow、哪次 Calculation 和哪个冻结请求；
- 相同输入和决定得到相同路径；
- 不同输入或决定不会互相覆盖；
- 已有完整产物可以经过验证后复用；
- 路径不承担业务 identity、版本或发布事实。

`.release/` 是本地工作区，不是数据库、对象存储或发布记录的替代品。目录名用于导航；目录内 manifest、精确 UUID/version 和 SHA-256 才是权威证据。

## 默认根目录

默认 artifact root 固定为仓库根目录下的：

```text
<release-repo>/.release/
```

它必须相对于仓库位置解析，不能依赖调用命令时的 current working directory。

推荐 CLI 提供：

```text
--artifact-root <path>
```

用于整体迁移本地 artifact workspace。未提供时使用仓库 `.release/`。它比逐个命令传 `--out-dir` 更适合正常工作流。

## 推荐目录结构

Calculation 已有路径保持兼容，Result Materialization 在同一个根目录下增加自己的命名空间：

```text
.release/
├── calculation/
│   ├── result-sets/
│   │   └── <result-set-id>.json
│   └── bundles/
│       └── <result-package-id>/
└── result-materialization/
    ├── jobs/
    │   └── <job-id>/
    ├── intakes/
    │   └── <calculation-id>/
    │       └── <bundle-content-hash>/
    └── materializations/
        └── <calculation-id>/
            └── <bundle-content-hash>/
                └── <materialization-key-sha256>/
```

各层含义：

| 路径段                       | 含义                                     | 为什么使用它                                   |
| ---------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `result-package-id`          | 远程 Calculation Bundle package identity | 与下载接口和恢复入口一致                       |
| `calculation-id`             | 结果所属的精确 Calculation               | 便于人和 Agent 按任务浏览                      |
| `bundle-content-hash`        | 已验证 Bundle 的不可变内容身份           | 同一 Calculation 的不同 Bundle 不会混淆        |
| `materialization-key-sha256` | 本次冻结生成意图的确定性 hash            | 不同范围、对象和 Result Process 内容层不会覆盖 |

canonical 路径使用完整 UUID 和完整 SHA-256，不使用短 hash。CLI 可以在摘要中显示短形式，但不能用短形式作为目录 identity。

## Materialization key

`materialization-key-sha256` 不是对一条命令字符串做 hash。它应当对 canonical JSON key 计算 SHA-256，至少包含：

```json
{
  "schemaVersion": "tiangong.release.materialization-key.v1",
  "source": {
    "calculationId": "<uuid>",
    "bundleContentHash": "<sha256>"
  },
  "scope": {
    "mode": "selected | all_eligible",
    "resolvedProcesses": ["<process-uuid>@<version>"]
  },
  "outputType": "result-process | lifecycle-model",
  "resultProcessLayer": "lci | lci-lcia",
  "modelProfile": "<profile-or-null>",
  "generationBase": {
    "mode": "first-generation | previous-manifest",
    "previousManifestSha256": "<sha256-or-null>"
  },
  "metadataPolicySha256": "<sha256>",
  "recipeContractVersion": "<version>"
}
```

规则：

- `resolvedProcesses` 使用精确 UUID@version，去重后按 canonical 顺序排列；
- `all_eligible` 仍记录本次 Bundle 实际解析出的完整 root set，不能只记录字符串 `all`；
- previous manifest 会影响 dataset version 分配，因此其内容 hash 必须进入 key；
- metadata completion policy 会改变最终 dataset 内容，因此必须进入 key；
- recipe/renderer 的语义契约发生变化时必须改变 `recipeContractVersion`；
- 时间、用户显示名称、命令参数顺序和绝对文件路径不得进入 key。

这使路径表达“同一来源下的同一冻结生成意图”，同时避免把路径误当成 Result Process 或 LifecycleModel 的业务 UUID。

## 默认 CLI 行为

目标交互为：

```bash
# 自动写入 canonical intake 路径
node workflows/result-materialization/cli.mjs intake \
  --bundle .release/calculation/bundles/<result-package-id> \
  --json

# 自动写入 canonical materialization 路径
node workflows/result-materialization/cli.mjs materialize \
  --intake <canonical-intake-path> \
  --processes <UUID@VERSION,...> \
  --output-type lifecycle-model \
  --result-process-layer lci-lcia \
  --first-generation \
  --json
```

正常使用不要求 `--out-dir`。CLI 在验证输入并冻结 key 后计算目标路径。

JSON 输出至少披露：

```json
{
  "artifactRoot": "<absolute-path>",
  "artifactPath": "<absolute-path>",
  "pathPolicy": "canonical-content-addressed.v1",
  "artifactIdentity": {
    "calculationId": "<uuid>",
    "bundleContentHash": "<sha256>",
    "materializationKeySha256": "<sha256-or-null>"
  },
  "disposition": "created | reused_existing"
}
```

Agent 不需要从路径反向解析身份；输出和 manifest 必须显式提供这些字段。

## 已有目录的处理

默认路径已经存在时不得直接报错，也不得直接认为成功：

1. 读取目录内的权威 manifest；
2. 校验 manifest schema、identity/hash 和完成状态；
3. 校验关键文件仍然存在且内容 hash 匹配；
4. 完全匹配时返回 `reused_existing`；
5. 缺失、未完成或不一致时返回 `artifact_path_conflict`，保留原目录并 fail closed。

不提供 `--force` 覆盖 canonical artifact。需要重新生成时，必须先解释为什么 key 应变化，或者由用户显式处理冲突目录。

## 临时目录和并发

写入继续采用目标目录旁的临时 sibling：

```text
<target>.tmp-<random>   # intake
<target>.work-<random>  # materialization
```

只有完整验证后才原子 rename 到 canonical target。失败时清理本次临时目录，不修改已有 target。

两个进程并发生成同一个 key 时，只允许一个原子提交成功。另一个进程应验证胜出者的最终产物；完全一致则返回 `reused_existing`，否则返回冲突。

## 显式路径覆盖

`--out-dir` 可以保留为高级能力，用于测试、隔离实验或向外部介质导出，但应满足：

- intake 和前台 materialize 中与 `--artifact-root` 互斥；后台 `materialize start` 可同时使用两者，此时 `--out-dir` 只指定输出，`--artifact-root` 只定位 Job 记录；
- 仍然不可覆盖已有目录；
- 不改变 materialization key、dataset identity 或 version；
- JSON 输出设置 `pathPolicy: explicit-output.v1`；
- 同时返回 `recommendedCanonicalPath`，便于 Agent 说明当前产物不在默认 workspace；
- Release Candidate Workflow 接收它之前仍按 manifest/hash 验证，不因路径是用户指定就降低门禁。

推荐日常工作使用默认路径或 `--artifact-root`，不推荐为每次运行手写 `--out-dir`。

## 不采用的命名方式

canonical 路径不使用：

- ResultSet 名称、Process 名称等可变显示文本；
- `ResultSet-YYYYMMDD` 等推荐名称；
- 单独的时间戳或随机 UUID；
- `latest`、`current`、`final` 等可变目录；
- 只包含 `result-process` 或 `lifecycle-model` 的固定输出目录；
- 被截断的 hash。

这些信息可以出现在人类摘要或未来的非权威索引中，但不能代替内容寻址路径。

## 契约验证要求

实现必须持续通过以下行为测试：

- intake 和 materialize 在省略 `--out-dir` 时生成上述默认路径；
- Calculation 的 next action 不再输出 `<path>` 占位符；
- 相同输入和 key 可以验证后复用；
- 不同 Bundle、scope、output type、Result Process 内容层和 previous manifest 得到不同路径；
- 并发相同 key 不产生两个 canonical 目录；
- 冲突、残缺或 hash 不一致时 fail closed；
- `--artifact-root` 和显式 `--out-dir` 的行为、JSON 输出和错误均有测试。
