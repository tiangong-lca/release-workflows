# 最终结果发布范围

说明 {{command}} 的 {{outcome}}、{{completeness}}、releaseRunId 与本地 artifacts。
plan 只冻结选择与 current 前置条件；prepare 只登记并封存选择；status 只是当前观察。
三者都不批准或激活。明确区分 localPlanHash 与数据库 publishPlanHash，不互相代替。

按实际 status 描述历史或当前事实，不能将已撤回、已替换的历史记录称为当前发布。
只提供 nextActions 中的实际动作；失败保留证据，按精确 run 查询后再决定恢复。
不输出凭据、内部服务地址或完整结果索引。
