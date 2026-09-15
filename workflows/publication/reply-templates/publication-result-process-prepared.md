# Result Process 写入请求已准备（远程）

- 完成度：`{{completeness}}`
- Result Process 操作数：`{{operationCount}}`
- 目标状态码：`{{targetStateCode}}`
- sourceKind：`{{sourceKind}}`
- Operation Set SHA-256：`{{operationSetHash}}`
- Preparation SHA-256：`{{preparationSha256}}`
- Server Preparation Hash：`{{preparationHash}}`
- 内容候选分类：`{{preparationClassification}}`（existingState `{{existingState}}`）
- Preparation：`{{artifacts.preparation}}`

**还没有发生远程写入。** Prepare 是只读操作：它只解析 server preparation digest 和内容候选
分类。`candidate_content_matches_existing` 只是内容观察，**不是**授权，**不是** no-op 证据，
也不比较 actor、source 绑定或 audit reason；真正是否已发布只能由 execute 的 exact receipt
或 readback 判定。

授权来自已绑定的 Executable Plan 与 manager attestation，sourceKind 始终是
`manager_attestation`（manager 断言，不是机器验证的计算血缘）。

下一步：`{{nextActions.0.command}}`
