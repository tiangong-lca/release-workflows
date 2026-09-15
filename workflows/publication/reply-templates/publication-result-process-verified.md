# Result Process 独立回读已验证

- Result Process 操作数：`{{operationCount}}`
- 目标状态码：`{{targetStateCode}}`
- Verified Set SHA-256：`{{verifiedSetHash}}`
- Readback Receipt SHA-256：`{{readbackReceiptSha256}}`
- Readback Receipt：`{{artifacts.readbackReceipt}}`

两个检查都必需，且互不替代：

1. 服务端 `verified` 的三个布尔必须**存在且全部为 true**（`rowMatchesReceipt`、
   `receiptMatchesRequest`、`liveManager`）。本地重算只能证明内容绑定，**不能**证明读取者
   仍持有 live Data Product Manager role；该标志为 false、缺失或非布尔一律 fail closed；
2. Release 自己重算精确存储 bytes 的 `result-process-content.v1` hash、Candidate canonical
   content identity，以及 receipt 的完整绑定（actor/id/version/key/source/plan/approval/
   preparationHash/reason/120）。

Result Process 的 120 发布闭环完成。
