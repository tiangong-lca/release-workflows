# 最终结果文件存储

说明 {{command}} 的 {{outcome}} 与 {{completeness}}，展示精确 storagePlanHash
和本地 artifacts。inspect 只完成本地校验；preflight 只读检查数据库连接和精确登记
状态，不上传、不登记；execute 成功才完成文件完整回读与不可变登记。各入口都保持
publicationAuthorized=false，不能称为已发布或可查询。

只提供 nextActions 中的实际下一步。execute 如报告 multipartCleanupRequired，
明确仍需处理本次未确认清理的分片；不建议删除共享对象。失败保留 attempt/failure
证据。配置/TLS 预检失败先修复报告的设置，不建议原样重试上传；真正写入结果不明
才按 nextActions 精确回读并用同一 Candidate、目标和确认 hash 在新目录恢复。

不输出凭据、连接串、内部对象地址或完整结果索引。
