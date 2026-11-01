# 最终结果发布范围

说明 {{command}} 的 {{outcome}}、{{completeness}}、releaseRunId 与本地 artifacts。
plan 只冻结选择与 current 前置条件；prepare 只登记并封存选择；status 只是当前观察。
三者都不批准或激活。approval-plan/activation-plan 只冻结待确认意图；approve/activate
只按独立观察报告实际批准或激活状态。激活回执的 publicReadbackVerified=false 意味着
公开查询验证尚未完成，不能称为完整发布验证通过。明确区分 localPlanHash 与数据库 publishPlanHash，不互相代替。

按实际 status 描述历史或当前事实，不能将已撤回、已替换的历史记录称为当前发布。
只提供 nextActions 中的实际动作；失败保留证据，按精确 run 查询后再决定恢复。
不输出凭据、内部服务地址或完整结果索引。
