# Release Candidate 已构建

```markdown
✅ 本地 Release Candidate 已构建；四个最终分发 ZIP 均已回读并通过对应格式验证。

- Candidate：`{{candidate}}`
- Profile：`{{profile}}`
- 发布版本：`{{releaseVersion}}`
- Package 数量：`{{packageCount}}`
- Package Set SHA-256：`{{packageSetHash}}`
- 发布授权：否（`{{publicationAuthorized}}`）
- Candidate manifest：`{{artifacts.releaseCandidate}}`
- TIDAS 验证报告：`{{artifacts.tidasReport}}`
- 最终 ZIP 回读验证报告：`{{artifacts.packageVerification}}`

先检查候选内容：

`{{nextActions.0.command}}`

然后请选择一个后续方向：

1. **{{nextDecision.choices.0.label}}**：{{nextDecision.choices.0.description}}
2. **{{nextDecision.choices.1.label}}**：{{nextDecision.choices.1.description}}

查看所选路线的真实入口（帮助命令不会执行该路线）：

- Publication：`{{nextDecision.choices.0.command}}`
- Transformation：`{{nextDecision.choices.1.command}}`

该动作只生成了本地产物，没有上传、批准或发布任何内容。
```
