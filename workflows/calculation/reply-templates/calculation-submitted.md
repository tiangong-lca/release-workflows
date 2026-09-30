# 计算任务已提交

```markdown
🚀 计算任务已提交，计算结果尚未确认生成。

- Worker Job ID：`{{data.jobId}}`
- 身份完整性：`{{data.identityCompleteness}}`
  [若 data.resourceId 非空] - Build/Package 资源 ID：`{{data.resourceId}}`
  [若 data.resourceId 为空] - Result Package：尚未 materialize
- 当前状态：`{{data.status}}`
- 是否复用已有任务：{{data.reused}}
- 计算范围：`{{data.effectiveInput.coverageMode}}`
- LCIA 方法：`{{data.effectiveInput.lciaMethods.0.id}}@{{data.effectiveInput.lciaMethods.0.version}}`

🔎 下一步先从数据库任务投影读取状态：

`{{nextActions.0}}`

仅在失败、阻塞、陈旧或状态不一致时，再查询 Worker 日志：

`{{nextActions.1}}`

[若 nextDecision 非空] {{nextDecision.prompt}}

[若 nextDecision 非空] 目前尚未创建监测，确认后再创建。
```
