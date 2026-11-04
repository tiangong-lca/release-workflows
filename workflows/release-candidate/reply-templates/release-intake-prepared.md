# Release Intake 已准备

```markdown
✅ Release Intake 已冻结，原 Materialization Intake 未被修改。

- Release Intake：`{{releaseIntake}}`
- LCIA Method 引用的唯一 Flow 数量：{{uniqueReferenceCount}}
- 新补齐的精确 Flow 数量：{{addedExactFlowCount}}
- 使用的共享 Elementary Flow 缓存记录数：{{elementaryFlowCacheRecordCount}}
- Intake manifest：`{{artifacts.releaseIntakeManifest}}`
- 依赖扩展报告：`{{artifacts.dependencyExpansionReport}}`

下一步按用户已明确的产物目标继续；已有选择时使用 `nextActions`，没有选择时展示 `nextDecision`，不要默认执行旧四包：

- {{nextDecision.choices.0.label}}：`{{nextDecision.choices.0.command}}`
- {{nextDecision.choices.1.label}}：`{{nextDecision.choices.1.command}}`

Result ZIP + HDF5 路线从同一冻结结果生成两种产物，后续依次 inspect、versions、授权 register、build。旧四包路线不生成 HDF5。Intake 本身尚未生成 ZIP 或 HDF5。

该动作只执行了参数化只读查询并生成本地产物，没有修改数据库、上传或发布任何内容。
```
