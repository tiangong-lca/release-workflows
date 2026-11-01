---
title: Result Process 与 LifecycleModel 的关系与生成原则
docType: design
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当理解 Result Process 与 LifecycleModel 分别表达什么时
  - 当决定一次物化要生成哪类对象、覆盖哪些 Process 时
  - 当判断 LifecycleModel 应连接哪些过程时
whenToUpdate:
  - 当 Result Process 或 LifecycleModel 的领域含义发生变化时
  - 当范围、Result Process 内容层或模型连接原则变化时
checkPaths:
  - workflows/result-materialization/**
lastReviewedAt: 2026-11-01
lastReviewedCommit: e417d3adbd28878ee05218b992b5f1f700dcfada
lastReviewedNote: "Release #99: reviewed separate Derived Result handoff verification, byte-preserving SDK-validated Materialization, content-addressed paths and explicit pending association/Candidate gates; no solver or publication authority moves."
related:
  - ../README.md
  - ../AGENTS.md
  - ../../release-candidate/README.md
---

# Result Process 与 LifecycleModel 的关系与生成原则

## 这一步要解决什么问题

计算完成后，我们已经知道某个过程的清单结果和环境影响结果，但这些结果还只是 Calculation Bundle 中的数值。Result Materialization 要把它们转成可以独立保存、引用和发布的 TIDAS 数据集。

这一步只在本地生成数据集。它不上传数据库，也不发布版本；组包与 Candidate 冻结属于后续 Release Candidate Workflow，远程发布属于 Publication Workflow。

用户在开始时只需要回答三个问题：

1. **处理哪些数据**：一条 Process、指定的一批 Process，或者全部符合条件的 Process；
2. **生成什么对象**：Result Process，还是 LifecycleModel；
3. **生成哪种 Result Process**：只包含 LCI，还是同时包含 LCI 和 LCIA。

这三个选择彼此独立。范围决定“处理谁”，对象类型决定主要交付物是 `R(P)` 还是 `M(P)`，第三项决定本次生成的 `R(P)` 和依赖 `R(Q)` 包含哪些计算结果。

LifecycleModel 本身没有 LCI 或 LCIA 结果字段。它保存过程实例和连接关系，并通过精确 UUID/version 引用 Result Process。因此，“LCI 或 LCI + LCIA”始终是在描述 Result Process，不是在描述 LifecycleModel。

## 三种对象

对任意一个被选中的过程 `P`，可以区分三种对象：

| 记号   | 对象              | 它回答的问题                                                 |
| ------ | ----------------- | ------------------------------------------------------------ |
| `U(P)` | 原始 Unit Process | 这个过程本身如何生产、消耗和排放？                           |
| `R(P)` | Result Process    | 把背景系统求解进去以后，这个过程最终对应多少 LCI/LCIA 结果？ |
| `M(P)` | LifecycleModel    | 原始过程与直接背景结果是怎样连接起来，从而得到 `R(P)` 的？   |

可以把它们简单理解为：

- `U(P)` 是原始配方；
- `R(P)` 是按统一基准算出的最终结果；
- `M(P)` 是说明原始配方如何连接背景结果的组装关系。

`R(P)` 和 `M(P)` 不是同一种信息的两种文件格式。`R(P)` 侧重“结果是多少”，`M(P)` 侧重“结果由什么关系构成”。

## M(P) 的物理意义

`M(P)` 表达的是：**为了按照 `P` 的 quantitative reference 生产一个归一化单位的参考产品，前景过程 `U(P)` 需要多少直接背景产品或服务，以及这些需求由哪些背景结果过程提供。**

它包含三类物理含义不同的元素：

- 根 instance `U(P)` 表示被研究的前景生产活动，并按照 quantitative reference 的归一化基准缩放；
- 每个 provider instance `R(Q)` 表示满足某一条直接 technosphere 输入所需的背景产品或服务；
- connection 表示 `U(P)` 的一项具体需求由哪个 `R(Q)` 满足，以及需要多少。

例如，生产一吨产品 `P` 需要 500 kWh 电力和 20 tkm 运输，那么 `M(P)` 表达的是“一吨产品的前景过程 + 满足 500 kWh 电力需求的背景结果 + 满足 20 tkm 运输需求的背景结果”这套产品系统关系。它不是把电力和运输的 LCIA 指标连接到 `P`，而是连接实际的产品或服务需求；环境结果仍保存在对应的 Result Process 中。

因此，`M(P)` 的功能单位由 `P` 的 quantitative reference 决定，provider 的 multiplication factor 则表示在这个功能单位下所需的背景活动量。连接的方向、单位、换算、分配和权重都必须来自同一次计算的已冻结证据。

当前 `M(P)` 是一个 **one-hop resolved、background aggregated** 的产品系统：

- 它显式保留 `U(P)` 与直接 provider 之间的物理需求关系；
- 它不展开 `Q` 内部更上游的过程网络；
- `R(Q)` 已经聚合承载 `Q` 及其上游系统的计算结果；
- `R(P)` 是这套模型关系在相同基准下得到的 resulting Process。

所以 `M(P)` 既不是原始 Unit Process，也不是完整展开的供应链图，更不是 LCI/LCIA 结果容器。它是一份**可重构 `R(P)` 的、边界明确的产品系统结构说明**。

## 两种生成模式

### 生成 Result Process

如果用户选择 `Result Process`，每个被选中的根 Process 只生成一个主要对象 `R(P)`。

```text
U(P) + Calculation Bundle 中 P 的结果
                    |
                    v
                  R(P)
```

这个模式不需要为了表达模型关系而额外生成直接 provider 的 Result Process。用户选择一条根 Process，就得到一条主要 Result Process。

### 生成 LifecycleModel

如果用户选择 `LifecycleModel`，每个被选中的根 Process 生成一个主要对象 `M(P)`。为了让这个模型中的引用完整，还需要准备：

- 根过程的结果 `R(P)`，作为模型的 resulting Process；
- 每个有效直接 provider `Q` 的结果 `R(Q)`，作为背景 process instance。

```text
R(Q1) ----+
R(Q2) ----+--> M(P): U(P) 与直接背景结果的连接 --> R(P)
R(Q3) ----+
```

因此，选择一个 root 后，本地文件数量可能大于一，但主要交付对象仍然只有一个 `M(P)`。`R(P)` 和 `R(Q)` 是这个模型所依赖的结果数据集，不表示用户另外选择了多个 root。

LifecycleModel 模式不会为 provider 自动生成 `M(Q)`。背景 `R(Q)` 已经是计算得到的聚合结果；如果继续展开 `M(Q)`，模型会从一跳关系变成完整供应链递归，既改变当前模型的含义，也可能在循环供应链中无法自然终止。

当前采用的这套组合策略叫做 `resolved-one-hop-aggregated-background.v1`。它是 LifecycleModel 的一种生成策略，不是整个 Result Materialization 工作流的名称。

## 哪些过程可以连接进 M(P)

并不是所有与 `P` 有关的 Process 都会进入 `M(P)`。一个 provider `Q` 只有在 Calculation Bundle 已经把某条输入关系明确求解为 `Q -> P` 时，才可以作为 `R(Q)` 连接进模型。

一条连接至少要满足：

- 它确实服务于根过程 `P` 的某条 technosphere 输入；
- provider `Q` 和双方对应的 exchange 都已经被计算任务明确解析；
- flow、单位、方向和位置关系彼此兼容；
- 该连接的用量、分配和权重有完整的计算证据；
- 用量是有限且非零的；
- `R(Q)` 已经以精确 UUID 和 version 出现在本次冻结的 Result Catalog 中。

这意味着：

- elementary flow 不会被当成 provider Process；
- 仅仅因为两个 Process 都在用户选择范围内，不代表它们应该连接；
- 工作流不会根据名称或“看起来相似”去猜 provider；
- 不能完整解释的连接会阻止 `M(P)` 生成，而不是被静默忽略。

如果同一条输入由多个 provider 分摊，每条已求解的 provider 关系都要单独表达。即使多个连接引用同一个 `R(Q)`，它们的用量、exchange 和证据仍可能不同，不能为了减少节点而随意合并。

## Result Process 包含 LCI 还是 LCI + LCIA

无论主要对象是哪一种，LCI/LCIA 选择都只作用于本次生成的 Result Process：

| 主要对象       | Result Process 内容                                       | LifecycleModel 中的表达 |
| -------------- | --------------------------------------------------------- | ----------------------- |
| Result Process | `R(P)` 包含 LCI，或同时包含 LCI 和 LCIA                   | 不生成 Model            |
| LifecycleModel | resulting `R(P)` 和 dependency `R(Q)` 按选择包含 LCI/LCIA | `M(P)` 只引用这些结果   |

所以不存在“带有 LCIA 的 LifecycleModel”这种数据含义。准确说法是：“LifecycleModel 引用的 Result Process 同时包含 LCI 和 LCIA”。

## 数值关系

`M(P)` 应该能够解释 `R(P)`。直观地说，根过程自身的直接清单，加上每个直接背景结果按已求解用量缩放后的清单，应当重构出 `R(P)`：

```text
R(P)
  ~= U(P) 的直接清单
     + 每个直接 provider R(Q) 的缩放结果之和
```

这里的用量、正负号、分配、provider 权重和单位换算都来自 Calculation Bundle。Materialization 只忠实表达已经求解并验证过的关系，不在本地重新计算供应链，也不自行修正数值。

比较时允许使用预先规定的数值容差，但不能用容差掩盖缺失连接、错误方向或错误引用。

## Quantitative reference 的原则

Result Process 必须沿用计算时真正使用的归一化基准，不能假设 quantitative reference 永远是正值 Output。

如果源 Process 的 reference exchange 是 Input，或者 amount 带有负号，生成结果时仍要保留它的方向含义。简单来说：

- `R(P)` 保留原 reference exchange 的方向；
- reference amount 被归一化到计算使用的基准；
- `M(P)` 中根 `U(P)` 的缩放倍数与同一个归一化基准一致。

这样 `U(P)`、`M(P)` 与 `R(P)` 描述的是同一次计算，而不会因为生成数据集时擅自把 reference 改成 Output 而改变含义。

## 稳定身份与精确版本

Result Process 的 UUID 表示稳定的业务 lineage。它由源 Process 的 UUID 和 reference Flow 的 UUID 决定，因此同一业务对象在重复生成时保持稳定。

源 Process 的精确 version 不进入 UUID，但会进入 Result Process 和 LifecycleModel 的 dataset version 与 provenance。这解决了两个不同问题：

- UUID 回答“它是不是同一个业务结果对象”；
- version 回答“它对应源数据的哪一次精确修订”。

因此，同一 Process UUID 的多个 source versions 可以共享一个 Result UUID，也可以共享一个 LifecycleModel UUID，但必须分别生成不同的 dataset versions。版本在写文件前按整个批次统一规划，避免两个精确源版本争用同一个 UUID/version。LifecycleModel 和 provider instance 始终引用本次计算对应的精确版本，不读取可变化的 `latest`。

内容没有变化时可以复用已有版本；metadata 变化和结果语义变化按版本规则分别演进。具体版本分配算法属于执行契约，记录在 Workflow README 和代码测试中。

## 一个简单例子

假设 `P` 是“一吨产品”的 Unit Process。计算任务确认它有两条直接背景输入：电力由 `Q1` 提供，运输由 `Q2` 提供。

如果用户选择：

```text
范围：P
对象：Result Process
Result Process 内容：LCI + LCIA
```

主要输出是一个包含 LCI 和 LCIA 的 `R(P)`。

如果用户改为：

```text
范围：P
对象：LifecycleModel
引用的 Result Process 内容：LCI + LCIA
```

主要输出是一个 `M(P)`。为了让它完整可读，本地还会生成或复用 `R(P)`、`R(Q1)` 和 `R(Q2)`。`M(P)` 表达 `U(P)` 如何按计算确定的用量连接 `R(Q1)` 和 `R(Q2)`，并指向最终的 `R(P)`。

它不会继续生成 `M(Q1)` 或 `M(Q2)`。

## 工作流边界

无论选择哪种模式，Result Materialization 都遵守以下边界：

- 只使用已下载并通过完整性校验的 Calculation Bundle 和精确源数据；
- 不修改原始 Unit Process；
- 不重新求解 LCI 或 LCIA；
- 不根据 mutable `latest` 补全引用；
- 不把无法解释的 provider 关系静默丢弃；
- 先在本地生成、验证并冻结，再交给 Release Candidate Workflow 组包；远程发布由 Publication Workflow 单独负责。

CLI 参数、请求结构、Result Catalog、文件目录、hash、版本分配和验证命令等工程契约见 [Result Materialization Workflow](../README.md)。Agent 执行顺序和阻塞条件见 [Workflow Agent Guide](../AGENTS.md)。

## 已加工 Derived Result 的接收

Result aggregation 已改变最终结果内容，接收入口 `materialize derived` 必须保留
其最终字节、已冻结 identity/version 和 parent Result 集合。Transformation producer
负责重放核验业务权重，Materialization 负责 SDK 验证及 canonical collection/catalog
冻结，不再求解、不补造 M(P)。该结果是独立 Derived Result，不能被标记为任一源
Unit Process 的 direct result。没有结构化父血缘时，原过程关联显式待解决；不能从
说明文字推导发布关联，也不能据本地冻结成功跳过身份登记和 ZIP/HDF5 配对门禁。
