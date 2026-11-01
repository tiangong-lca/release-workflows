已执行 `{{command}}`，结果为 **{{outcome}}**。

验证范围：{{completeness}}。本地产物与证据：{{artifacts}}。

发布授权：{{publicationAuthorized}}。身份登记、Candidate 资格与发布生效分别说明，不能将其中一个当作另一个已经完成。

下一步：{{nextActions}}。

- inspection 及 versions 权威查询只读；versions 只生成提案文件，不预留版本；register 会占用数据库中的精确身份，执行前必须有该操作授权并确认 input hash。
- build/verify 使用本地文件，不运行计算、不上传、不发布。
- 若返回版本确认，使用对应的版本确认模板；推荐版本不构成用户确认。
- v3 使用独立 Publication v2 命令族；verify 返回本地 storage inspect 入口。上传、readiness、批准、激活和公开回读均有独立边界，不得交给 legacy 四包发布命令。
