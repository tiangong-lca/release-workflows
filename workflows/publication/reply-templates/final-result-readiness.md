# 最终结果就绪验证

说明 {{command}} 的 {{outcome}} 和 {{completeness}}，给出 verificationId、expiresAt
与本地 artifacts。成功意味着本次选中范围的文件和 reader 数值已验证并登记，
publicationAuthorized 仍为 false；不能称为已批准、已发布或 Platform 已验证。

只提供 nextActions 中的实际动作。失败保留所有证据，解决原因后用新目录、新 UUID
重新验证，不能覆盖旧证据或续期旧回执。不要输出凭据、内部服务地址或完整结果。
