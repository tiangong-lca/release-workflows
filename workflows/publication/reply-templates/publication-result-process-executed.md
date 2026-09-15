# Result Process 已写入 state 120

- Result Process 操作数：`{{operationCount}}`
- 已完成 identities：`{{completedKeys}}`
- Execution Receipt SHA-256：`{{executionReceiptSha256}}`
- 是否复用既有 receipt：`{{reused}}`
- Execution Receipt：`{{artifacts.executionReceipt}}`
- 哈希链事件目录：`{{artifacts.executionEvents}}`

每个 identity 都直接创建在 `state_code=120`，没有中间 `0` 或 `100` row，也没有走平台
`app_dataset_create` / `app_dataset_publish`。response 丢失时只用 exact receipt binding 的
readback 调和，不猜测结果。

远程写入已完成，仍需独立回读验证。

下一步：`{{nextActions.0.command}}`
