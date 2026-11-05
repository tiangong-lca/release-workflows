已执行 `{{command}}`，结果为 **{{outcome}}**。

验证范围：{{completeness}}。本地产物与证据：{{artifacts}}。

发布授权：{{publicationAuthorized}}。本地 Candidate 资格和发布授权分别记录。

数据质量警告：{{warnings}}

下一步：{{nextActions}}。

- inspect 复核本地输入；freeze 按确认的 input hash 冻结副本；可选的 versions 只查询历史版本占用。
- build/verify 使用本地文件，不运行计算、不上传、不发布。
- 无告警时写“无”。告警只涉及非单位参考属性/参考单位（`nonunit_reference_property`、`nonunit_reference_unit`），不改变冻结内容、schema 或 hash，也不会换算数值；`result verify` 不重算告警。
- 若返回版本确认，使用对应的版本确认模板；推荐版本不构成用户确认。
- v3 使用独立 Publication v2 命令族；verify 返回本地 storage inspect 入口。上传、readiness、批准、激活和公开回读均有独立边界，不得交给 legacy 四包发布命令。
