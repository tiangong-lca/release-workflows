const DATABASE_CODES = [
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
];
export function safePublicationDatabaseDetails(error) {
  const details = error?.details ?? {};
  return {
    ...(/^[0-9A-Z]{5}$/u.test(details.sqlState ?? "")
      ? { sqlState: details.sqlState }
      : {}),
    ...(["connect", "begin", "role", "query", "commit"].includes(
      details.databaseStage,
    )
      ? { databaseStage: details.databaseStage }
      : {}),
    ...(DATABASE_CODES.includes(details.databaseCode)
      ? { databaseCode: details.databaseCode }
      : {}),
    ...(details.phase === "database_preflight"
      ? {
          phase: details.phase,
          uploadAttempted: false,
          registryWriteAttempted: false,
        }
      : {}),
  };
}
