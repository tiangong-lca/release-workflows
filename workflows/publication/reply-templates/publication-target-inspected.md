# Publication 目标已检查

- 数据集：`{{datasetCount}}`（Result Process `{{resultProcessDatasetCount}}`，普通 `{{ordinaryDatasetCount}}`）
- 目标指纹：`{{targetFingerprint}}`
- 状态映射：`{{stateMapping.roleTargets.result_process}}` / `{{stateMapping.roleTargets.support}}`（`singleGlobalState={{stateMapping.singleGlobalState}}`）
- Executable Plan SHA-256：`{{executablePlanSha256}}`
- Target Snapshot：`{{artifacts.targetSnapshot}}`
- Executable Plan：`{{artifacts.executablePlan}}`

尚未发生远程写入。只能批准上面这个精确 Plan SHA-256。每个 operation 的目标状态由该
dataset 的 role 决定，Result Process 为 120，普通数据集保持 100。

下一步：`{{nextActions.0.command}}`
