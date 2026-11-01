import pg from "pg";
import { fail, hashJson } from "../lib/common.mjs";

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
      began = false;
    try {
      client = await pool.connect();
      await client.query(readOnly ? "begin read only" : "begin");
      began = true;
      await client.query("set local role service_role");
      await client.query("set local lock_timeout = '5s'");
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
      await client.query("commit");
      return response.data;
    } catch (error) {
      if (began) await client.query("rollback").catch(() => {});
      if (error.code === "final_storage_registry_response_invalid") throw error;
      fail(
        error.code === "23505"
          ? "final_storage_registry_conflict"
          : error.code === "22023" || error.code === "55000"
            ? "final_storage_registry_invalid"
            : "final_storage_registry_outcome_unknown",
        "Reconcile the same immutable storage identity before retrying; never replace a receipt after an uncertain outcome",
        {
          sqlState: /^[0-9A-Z]{5}$/u.test(error.code ?? "") ? error.code : null,
        },
      );
    } finally {
      client?.release();
    }
  }
  return {
    databaseTargetHash,
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
