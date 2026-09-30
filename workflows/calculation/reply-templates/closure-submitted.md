# 完整性校验已提交

```markdown
🚀 完整性校验已提交，当前还不能视为校验完成。

- Closure Check ID：`{{data.resourceId}}`
- Worker Job ID：`{{data.jobId}}`
- 身份完整性：`{{data.identityCompleteness}}`
- 当前状态：`{{data.status}}`
- 是否复用已有任务：{{data.reused}}
- 计算范围：`{{data.effectiveInput.coverageMode}}`
- LCIA 方法：`{{data.effectiveInput.lciaMethods.0.id}}@{{data.effectiveInput.lciaMethods.0.version}}`
- 采用默认值的字段：{{data.effectiveInput.defaultedInputs}}

🔎 下一步先读取同一个 Closure Check 的权威状态：

`{{nextActions.0}}`

仅在失败、阻塞、陈旧或状态不一致时，再查询 Worker 日志：

`{{nextActions.1}}`

[若 nextDecision 非空] {{nextDecision.prompt}}

[若 nextDecision 非空] 目前尚未创建监测，确认后再创建。
```
