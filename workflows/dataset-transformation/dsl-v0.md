---
title: Dataset Transformation DSL v0 Reference
docType: reference
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 与用户形成、审查或冻结 Dataset Transformation 规则时
  - 当实现或验证 Unit Process / Result Process weighted aggregation 时
whenToUpdate:
  - 当 DSL 字段、冲突策略、权重语义或执行算法变化时
checkPaths:
  - workflows/dataset-transformation/contracts/**
  - workflows/dataset-transformation/lib/**
  - workflows/dataset-transformation/cli.mjs
  - workflows/dataset-transformation/test/**
lastReviewedAt: 2026-10-07
lastReviewedCommit: 89847052770fede8ebe2eeb8aba32af9b3b71989
lastReviewedNote: "Reviewed for Release #80: Unit/Result completion describes produced evidence, not downstream capability; DSL and numerical behavior remain unchanged."
related:
  - README.md
  - contracts/dataset-transformation-dsl.v0.schema.json
---

# Dataset Transformation DSL v0

## 1. 目的与边界

DSL v0 把用户和 Agent 对一组 Candidate Process 的加工决定，转换为可复现的确定性执行规格。加权目标必须先形成明确选择：

```text
unit-process.weighted-aggregate.v1
result-process.weighted-aggregate.v0
```

`process.weighted-aggregate.v0` 保留为既有 Unit Process operation 的兼容入口。新协商从 `weighted-aggregate.choose-target.v0` 开始，由 Agent 解释并推荐，用户确认后改写为上述一个明确 operation。输入必须是同一已验证 Release Candidate v1/v2 中两个或更多、role 与 operation 一致的精确 Process。

Unit Process operation 表达“构造新的代表性过程并重新计算”；Result Process operation 表达“组合已有计算结果而不重新求解供应链”。LifecycleModel、任意表达式、任意 JSON patch、单位映射或参考流转换仍不支持。

## 2. Artifact 生命周期

```text
Draft DSL (可修改，F2)
  -> Agent recommendation + user aggregation-target decision
  -> inspect
Transformation Analysis + Conflict Report
  -> Agent / 用户补全 decisions
Revised Draft DSL
  -> inspect(status=ready)
  -> freeze
Frozen Spec (hash-bound，F3，不可原地修改)
  -> execute
Transformed Process + Execution Receipt + Handoff
  -> intended Unit consumer: Calculation
  -> intended Result consumer: Result Materialization
```

handoff 描述目标与绑定证据，不证明消费者已实现。当前 Materialization 尚不消费 Derived Result handoff，Candidate 不支持 Result-only package；实际接收限制见 [Workflow README](README.md#result-evidence-与返回路径)。不得为打通路线补造 Model、改写输入类型或复用无效证据。

`needs_decision` 是正常业务状态。只有 malformed contract、Candidate/input drift、运行时故障或生成结果违反确定性检查时才返回 system error / `needs_repair`。

## 3. Draft DSL 顶层结构

```json
{
  "schemaVersion": "tiangong.release.dataset-transformation-dsl.v0",
  "status": "draft",
  "operation": {},
  "output": {},
  "policies": {},
  "decisions": []
}
```

Draft 的 JSON Schema 是 [`contracts/dataset-transformation-dsl.v0.schema.json`](contracts/dataset-transformation-dsl.v0.schema.json)。JSON 是 v0 唯一可执行序列化；Agent 可以在对话中用 YAML 或自然语言展示建议，但冻结前必须投影为该 JSON contract。

## 4. 输入与操作

### 4.1 目标选择

尚未确认目标时，Draft 只承载推荐，不执行输入或字段分析：

```json
{
  "operation": {
    "type": "weighted-aggregate.choose-target.v0",
    "targetRecommendation": {
      "recommendedOperation": "result-process.weighted-aggregate.v0",
      "reason": "用户要组合已有省级 Result，而不是构造新的生产模型",
      "sourceRefs": ["conversation:goal"]
    }
  }
}
```

inspect 返回 `operation:aggregation-target`。用户确认后，Draft 使用明确 operation，并保留决定理由：

```json
{
  "conflictId": "operation:aggregation-target",
  "strategy": "select-operation",
  "value": "result-process.weighted-aggregate.v0",
  "reason": "用户确认直接生成已有 Result 的加权组合"
}
```

recommendation 是 F2 建议，不是授权。Frozen Spec 只接受明确 Unit/Result operation；不增加一个会与 operation type 重复的 `targetLayer` 执行字段。

### 4.2 精确输入

```json
{
  "operation": {
    "type": "unit-process.weighted-aggregate.v1",
    "inputs": ["process:<uuid>@<version>", "process:<uuid>@<version>"],
    "weighting": {}
  }
}
```

每个 identity 必须精确匹配 Candidate canonical dataset index 中 operation 要求的 `unit_process` 或 `result_process` role。inspect 会绑定：

- Release Candidate canonical JSON SHA-256；
- canonical dataset index SHA-256；
- package-set hash；
- 每个 Process 的 byte SHA-256 与 canonical content hash；
- 参考 Flow UUID、version、direction 和参考 amount。

Result Process 还绑定 source Process / Calculation lineage、LCI exchange identity signature 和 LCIA method UUID/version signature。

同一 UUID 的其他 version、名称匹配和 `latest` 均不会替代精确输入。

## 5. 权重

### 5.1 显式权重

```json
{
  "mode": "explicit",
  "values": {
    "process:<uuid-a>@01.00.000": 0.5,
    "process:<uuid-b>@01.00.000": 0.3,
    "process:<uuid-c>@01.00.000": 0.2
  }
}
```

每项必须为正有限数。执行器会归一化，不要求用户输入之和恰好为 1。

### 5.2 年产量权重

```json
{
  "mode": "annual-production",
  "overrides": {
    "process:<uuid>@01.00.000": {
      "value": 80000,
      "unit": "kg/year",
      "reason": "原字段为 missing-data-sentinel，用户采用经确认的生产记录",
      "evidence": "source:production-register-2025"
    }
  }
}
```

默认读取：

```text
processDataSet.modellingAndValidation
  .dataSourcesTreatmentAndRepresentativeness
  .annualSupplyOrProductionVolume
```

v0 只接受具有正数前缀和明确 `/year` 单位的值。空值、sentinel、fallback、normalized 描述、无法解析值或单位不同都会产生决策请求。override 必须同时记录 unit、reason，可附 evidence；它是显式用户决定，不是静默混用。

冻结后每个输入都记录 raw value、normalized weight、`annual-field | user-override | explicit` 来源和证据。

## 6. 冲突与 decisions

inspect 对 Process 业务字段按以下 field family 比较完整值：

| Family                             | 业务含义                                     |
| ---------------------------------- | -------------------------------------------- |
| `name`                             | 名称、处理路线、mix/location、功能单位文本   |
| `generalComment`                   | 数据集说明                                   |
| `classificationInformation`        | 分类                                         |
| `time`                             | 参考年和时间代表性                           |
| `geography`                        | 地域与限制说明                               |
| `technology`                       | 技术描述和适用性                             |
| `mathematicalRelations`            | 参数和数学关系                               |
| `lciMethodAndAllocation`           | 数据集类型、LCI 和分配语义                   |
| `dataSourcesAndRepresentativeness` | 来源、cut-off、代表性，不含年产量            |
| `complianceDeclarations`           | 合规声明                                     |
| `commissionerAndGoal`              | 委托与用途                                   |
| `dataGenerator` / `dataEntryBy`    | 生成和录入责任                               |
| `publicationAndOwnership`          | owner、license、copyright；identity 字段除外 |
| `annualVolume`                     | 聚合后年产量语义                             |

每个差异生成稳定 `conflictId`、精确 source values、可选策略和影响。用户决定示例：

```json
{
  "conflictId": "field:geography",
  "strategy": "rewrite",
  "value": {
    "locationOfOperationSupplyOrProduction": {
      "@location": "CN"
    }
  },
  "reason": "输出代表明确确认的中国加权组合"
}
```

v0 支持的决定策略：

- `take-from`：从一个精确 input 继承完整 field family；
- `rewrite`：用用户确认的完整结构重写；
- `drop`：Schema 允许且语义明确时删除；
- `sum-resolved`：仅用于 annual-production 权重下的输出年产量。
- `select-operation`：仅用于 `operation:aggregation-target`，value 必须与明确 operation type 一致。

参考流或 dataset type 不兼容时，v0 不允许用户用“确认”强行跳过。Result Process 还必须共享一个可提取的 Calculation lineage、完全相同的 LCI exchange identity set，以及完全相同的 LCIA method UUID/version set。缺失 method/exchange 不解释为零；Agent 应建议修改 selection、拆分输出、回到 Unit Process 路线或准备共同计算基线，状态仍是 `needs_decision`。

## 7. 输出与系统派生字段

Draft 必须提供新的 UUID、version、匹配 URI 和确定时间：

```json
{
  "output": {
    "identity": {
      "uuid": "<new-uuid>",
      "version": "01.00.000",
      "uri": "<uri-containing-uuid-and-version>"
    },
    "generatedAt": "2026-08-26T00:00:00.000Z"
  }
}
```

以下内容不由用户逐字段选择：

- UUID/version/URI/timestamps 使用 output identity；
- quantitative reference 和 exchanges 由聚合算法生成；
- review 重置为 `Not reviewed`；
- exchange internal IDs 重新生成；
- transformation lineage 写入 general comment；
- Unit Process 路线把旧 Result evidence 标记为 `invalidated`；Result Process 路线把新 evidence 标记为 `derived`。

## 8. Exchange metadata policy

v0 只支持一套经过确认的显式策略：

```json
{
  "exchangeMetadata": {
    "base": "take-from-prototype-then-input-order",
    "dataSources": "union-deduplicate",
    "comments": "replace-with-lineage",
    "uncertainty": "reset",
    "allocations": "reset"
  }
}
```

`prototypeInput` 决定结构原型。同一 exchange group 优先使用 prototype metadata；prototype 没有该 exchange 时按冻结的 input 顺序取第一个。来源引用取并集去重，原 comment 不复制为新的事实陈述，而由 lineage 指回输入证据。旧 uncertainty 和 allocation 不能直接代表加权组合，因此重置。

## 9. 数值语义

输入 Process `i` 的参考 exchange amount 为 `rᵢ`，冻结后的归一化权重为 `wᵢ`。任意 exchange group `g` 的输出 amount 为：

```text
amount(g) = Σᵢ wᵢ × amount(i, g) / rᵢ
```

group identity 是：

```text
Flow UUID + Flow Version + Direction + Location + Function Type
```

由于所有输入要求具有相同 reference Flow/version/direction，输出 reference amount 必须为 1。Unit Process 路线允许某个非参考 exchange 在部分输入缺失，此时该输入贡献 0；Result Process 路线要求完整 exchange identity set 相同，不把缺失 exchange 当作零。

Result Process 的每个 LCIA method `m` 采用相同归一化公式：

```text
LCIA(m) = Σᵢ wᵢ × LCIA(i, m) / rᵢ
```

method 按 UUID + version 对齐，不按数组位置对齐。Result operation 可以处理 LCI-only 的共同空方法集，也可以处理完全一致的 LCI + LCIA method set。

## 10. 冻结、执行和验证

freeze 只有在所有冲突已解决且 inspect artifact 与当前 Draft/Candidate hash 完全一致时才生成 Frozen Spec。Frozen Spec 展开所有 field values 和 resolved weights，执行期间不再调用 Agent 做语义判断。

execute 至少检查：

- Candidate、index 和 Process hashes 未漂移；
- 每个输入恰有一个冻结权重且总和为 1；
- 输出 reference amount 为 1；
- exchange IDs 唯一；
- 所有 amount 有限；
- Result Process 的 Calculation lineage、exchange set、LCIA method set 和 LCIA amounts 有效；
- 新 identity 已应用；
- review 已重置；
- receipt、output 和 handoff hash 可重算。

Unit Process 输出使旧 Result Process/LifecycleModel evidence 无效，handoff 进入 Calculation。Result Process 输出是 hash-bound Derived Result，handoff 指向 Result Materialization，但须等待接收能力实现；Transformation 不调用 Worker Calculation，也不自动生成或聚合 LifecycleModel。Transformation 不会原地改写父 Candidate，也不会自行发布。

## 11. CLI

```bash
node workflows/dataset-transformation/cli.mjs dsl inspect \
  --candidate <candidate-dir> --dsl <draft.json> --out-dir <analysis-dir> --json

node workflows/dataset-transformation/cli.mjs dsl freeze \
  --candidate <candidate-dir> --dsl <draft.json> \
  --analysis-dir <analysis-dir> --out-dir <frozen-dir> --json

node workflows/dataset-transformation/cli.mjs transform execute \
  --candidate <candidate-dir> --spec-dir <frozen-dir> \
  --out-dir <execution-dir> --json
```

所有输出目录都不可覆盖。DSL 或决定变化时必须重新 inspect，并写入新的目录。

## 12. 后续扩展边界

LifecycleModel 加权聚合、跨 Calculation basis 的 Result mapping、reference-flow mapping、unit conversion、部分 LCIA method set 合并和更丰富 uncertainty 算法需要新 operation/version。它们不得通过给现有 operation 增加隐式解释来实现。Promotion 前需要真实数据场景、独立数值验证和明确的 Result evidence 路线。
