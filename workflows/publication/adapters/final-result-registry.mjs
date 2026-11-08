import pg from "pg";
import { fail, hashJson } from "../lib/common.mjs";

import { safePublicationDatabaseDetails } from "../../environment/lib/database-diagnostics.mjs";
export { safePublicationDatabaseDetails };

export function finalResultDatabaseTargetHash(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    fail(
      "final_storage_connection_required",
      "A protected PostgreSQL CONN setting is required",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.hash ||
    [...url.searchParams.keys()].some(
      (k) => !["sslmode", "sslcert", "sslkey", "sslrootcert"].includes(k),
    )
  )
    fail(
      "final_storage_connection_invalid",
      "Storage registration requires a PostgreSQL URI without target-overriding query parameters",
    );
  return hashJson({
    schemaVersion: "tiangong.final-result-database-target.v1",
    hostname: url.hostname,
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.slice(1) || "postgres"),
    user: decodeURIComponent(url.username),
  });
}

// Restricted data-plane adapter. Actor approval/activation cannot be invoked
// here and no caller-controlled SQL or canonical table write is exposed.
export function createFinalResultRegistry({
  connectionString,
  Pool = pg.Pool,
}) {
  const databaseTargetHash = finalResultDatabaseTargetHash(connectionString);
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 120000,
    application_name: "release-final-result-storage",
  });
  pool.on?.("error", () => {});
  async function call(sql, parameters, readOnly = false) {
    let client,
      began = false,
      stage = "connect";
    try {
      client = await pool.connect();
      stage = "begin";
      await client.query(readOnly ? "begin read only" : "begin");
      began = true;
      stage = "role";
      await client.query("set local role service_role");
      await client.query("set local lock_timeout = '5s'");
      stage = "query";
      const result = await client.query(sql, parameters);
      const response = result.rows[0]?.result;
      if (
        response?.ok !== true ||
        !(
          (readOnly && response.data === null) ||
          (response.data &&
            typeof response.data === "object" &&
            !Array.isArray(response.data))
        )
      )
        fail(
          "final_storage_registry_response_invalid",
          "Invalid final Result storage registry response",
        );
      stage = "commit";
      await client.query("commit");
      return response.data;
    } catch (error) {
      if (began) await client.query("rollback").catch(() => {});
      if (error.code === "final_storage_registry_response_invalid") throw error;
      const sqlState = /^[0-9A-Z]{5}$/u.test(error.code ?? "")
        ? error.code
        : null;
      const tlsCodes = [
        "SELF_SIGNED_CERT_IN_CHAIN",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "CERT_HAS_EXPIRED",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ];
      const connectionCodes = [
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
      ];
      const details = {
        sqlState,
        databaseStage: stage,
        ...(tlsCodes.includes(error.code) ||
        connectionCodes.includes(error.code)
          ? { databaseCode: error.code }
          : {}),
      };
      // A failed connection cannot have dispatched this call's write. Reads
      // cannot create an uncertain registration; actual dispatched writes keep
      // their existing conservative reconciliation contract below.
      if (stage === "connect" && tlsCodes.includes(error.code))
        fail(
          "final_publication_database_tls_failed",
          "Database certificate verification failed; configure RELEASE_DATABASE_CA_FILE or CONN sslrootcert, then run result-storage preflight",
          details,
        );
      if (stage === "connect" && ["28P01", "28000"].includes(sqlState))
        fail(
          "final_publication_database_auth_failed",
          "Database authentication failed; check the protected CONN setting",
          details,
        );
      if (
        stage === "connect" ||
        (readOnly && connectionCodes.includes(error.code))
      )
        fail(
          "final_publication_database_unavailable",
          "Database connection is unavailable; run result-storage preflight before upload",
          details,
        );
      if (readOnly)
        fail(
          sqlState === "42501"
            ? "final_publication_database_permission_denied"
            : sqlState === "57014" || sqlState === "55P03"
              ? "final_publication_database_read_timeout"
              : "final_publication_database_read_failed",
          "Read-only database check failed; inspect the safe stage and SQLSTATE before upload",
          details,
        );
      if (stage === "begin" || stage === "role")
        fail(
          "final_publication_database_session_failed",
          "Database session preparation failed before registry write",
          details,
        );
      fail(
        error.code === "23505"
          ? "final_storage_registry_conflict"
          : error.code === "22023" || error.code === "55000"
            ? "final_storage_registry_invalid"
            : "final_storage_registry_outcome_unknown",
        "Reconcile the same immutable storage identity before retrying; never replace a receipt after an uncertain outcome",
        details,
      );
    } finally {
      client?.release();
    }
  }
  return {
    databaseTargetHash,
    checkConnection: () =>
      call(
        "select jsonb_build_object('ok',true,'data',jsonb_build_object('connected',true)) as result",
        [],
        true,
      ),
    describeQuery: (id, targetHash) =>
      call(
        "select api.svc_result_query_describe_v2($1::uuid,$2::text) as result",
        [id, targetHash],
        true,
      ),
    stageQuery: (artifact, manifestText, rows) =>
      call(
        "select api.svc_result_query_stage_v2($1::jsonb,$2::text,$3::jsonb) as result",
        [JSON.stringify(artifact), manifestText, JSON.stringify(rows)],
      ),
    sealQuery: (id, receipt) =>
      call(
        "select api.svc_result_query_seal_v2($1::uuid,$2::jsonb) as result",
        [id, JSON.stringify(receipt)],
      ),
    describeCandidate: (hash, targetHash) =>
      call(
        "select api.svc_result_candidate_describe_v2($1::text,$2::text) as result",
        [hash, targetHash],
        true,
      ),
    registerCandidate: (candidateText, catalogText, receipt) =>
      call(
        "select api.svc_result_candidate_register_v2($1::text,$2::text,$3::jsonb) as result",
        [candidateText, catalogText, JSON.stringify(receipt)],
      ),
    beginReadiness: (header) =>
      call(
        "select api.svc_final_result_readiness_begin_v2($1::jsonb) as result",
        [JSON.stringify(header)],
      ),
    stageReadiness: (id, proofs) =>
      call(
        "select api.svc_final_result_readiness_artifacts_v2($1::uuid,$2::jsonb) as result",
        [id, JSON.stringify(proofs)],
      ),
    sealReadiness: (id) =>
      call(
        "select api.svc_final_result_readiness_seal_v2($1::uuid) as result",
        [id],
      ),
    describeReadiness: (id) =>
      call(
        "select api.svc_final_result_readiness_describe_v2($1::uuid) as result",
        [id],
        true,
      ),
    close: () => pool.end(),
  };
}
