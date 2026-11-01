import pg from "pg";
import { canonicalJson, hashJson, fail } from "./common.mjs";
import {
  FINAL_RESULT_HASH_DOMAIN,
  FINAL_RESULT_PROJECTION,
} from "./final-result-projection.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const DEPENDENCY =
  /^(flow|flowproperty|unitgroup|lciamethod):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@\d{2}\.\d{2}\.\d{3}$/u;
const MAX_REQUEST = 8 * 1024 * 1024;
function requireValue(value, code = "final_identity_contract_invalid") {
  if (!value) fail(code, "Invalid final Result identity contract");
}
export function identityRegistrationRequest(projection) {
  requireValue(projection?.schemaVersion === FINAL_RESULT_PROJECTION);
  const request = {
    schemaVersion: "tiangong.final-result-identity-request.v1",
    result: projection.identity,
    hashDomain: projection.hashDomain,
    canonicalContentHash: projection.canonicalContentHash,
    semanticDependencies: projection.semanticDependencies,
    contentHash: projection.contentHash,
    producer: "release-workflows",
  };
  validateRequest(request);
  return structuredClone(request);
}
function validateRequest(request) {
  requireValue(
    request?.schemaVersion === "tiangong.final-result-identity-request.v1" &&
      Object.keys(request).length === 7 &&
      UUID.test(request.result?.uuid ?? "") &&
      VERSION.test(request.result?.version ?? "") &&
      Object.keys(request.result).length === 2 &&
      request.hashDomain === FINAL_RESULT_HASH_DOMAIN &&
      HASH.test(request.canonicalContentHash ?? "") &&
      HASH.test(request.contentHash ?? "") &&
      typeof request.producer === "string" &&
      request.producer.length > 0 &&
      request.producer.length <= 64,
  );
  const deps = request.semanticDependencies;
  requireValue(Array.isArray(deps) && deps.length > 0 && deps.length <= 50000);
  let previous = null;
  for (const d of deps) {
    requireValue(
      d &&
        Object.keys(d).length === 2 &&
        DEPENDENCY.test(d.key ?? "") &&
        HASH.test(d.contentHash ?? "") &&
        (previous === null || previous < d.key),
    );
    previous = d.key;
  }
  requireValue(
    hashJson({
      hashDomain: request.hashDomain,
      canonicalContentHash: request.canonicalContentHash,
      semanticDependencies: deps,
    }) === request.contentHash,
    "final_identity_content_hash_mismatch",
  );
  requireValue(Buffer.byteLength(canonicalJson(request)) <= MAX_REQUEST);
}
export function verifyIdentityReceipt(request, response) {
  validateRequest(request);
  const r = response?.data;
  requireValue(
    response?.ok === true &&
      r?.schemaVersion === "tiangong.final-result-identity-receipt.v1" &&
      UUID.test(r.registrationId ?? "") &&
      r.result?.uuid === request.result.uuid &&
      r.result.version === request.result.version &&
      r.hashDomain === request.hashDomain &&
      r.canonicalContentHash === request.canonicalContentHash &&
      r.contentHash === request.contentHash &&
      r.contentRef === `urn:sha256:${request.canonicalContentHash}` &&
      typeof r.createdAt === "string" &&
      Number.isFinite(Date.parse(r.createdAt)),
    "final_identity_receipt_mismatch",
  );
  return {
    schemaVersion: r.schemaVersion,
    registrationId: r.registrationId,
    result: { uuid: r.result.uuid, version: r.result.version },
    hashDomain: r.hashDomain,
    canonicalContentHash: r.canonicalContentHash,
    contentHash: r.contentHash,
    contentRef: r.contentRef,
    createdAt: r.createdAt,
  };
}
// No arbitrary SQL, table access or actor service key. The operator explicitly
// supplies a connection; only these Database-owned service RPCs are admitted.
export function createFinalResultIdentityStore({
  connectionString,
  Pool = pg.Pool,
}) {
  requireValue(
    typeof connectionString === "string" && connectionString.length > 0,
    "final_identity_connection_required",
  );
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    application_name: "release-final-result-identity",
  });
  // A disconnected idle pool must not print a connection string or raw PG error.
  pool.on?.("error", () => {});
  async function call(sql, parameters, { readOnly = false } = {}) {
    let client;
    let began = false;
    try {
      client = await pool.connect();
      await client.query(readOnly ? "begin read only" : "begin");
      began = true;
      await client.query("set local role service_role");
      await client.query("set local lock_timeout = '5s'");
      const response = await client.query(sql, parameters);
      await client.query("commit");
      return response.rows[0]?.result;
    } catch (error) {
      if (began) await client.query("rollback").catch(() => {});
      const code =
        error.code === "23505"
          ? "final_identity_content_conflict"
          : error.code === "55000"
            ? "final_identity_legacy_occupied"
            : "final_identity_outcome_unknown";
      // No automatic new-version retry: an acknowledgement may be lost after commit.
      fail(
        code,
        code === "final_identity_outcome_unknown"
          ? "Reconcile or retry the same immutable registration input; never change version after an unknown outcome"
          : "Regenerate upstream with a new version; never reuse the old document hash",
        {
          sqlState: /^[0-9A-Z]{5}$/u.test(error.code ?? "") ? error.code : null,
        },
      );
    } finally {
      client?.release();
    }
  }
  return {
    async register(request) {
      validateRequest(request);
      return verifyIdentityReceipt(
        request,
        await call(
          "select api.svc_result_identity_register($1::jsonb) as result",
          [request],
        ),
      );
    },
    async versions(uuid, { beforeVersion = null, limit = 100 } = {}) {
      requireValue(
        UUID.test(uuid ?? "") &&
          (beforeVersion === null || VERSION.test(beforeVersion)) &&
          Number.isInteger(limit) &&
          limit >= 1 &&
          limit <= 256,
      );
      const response = await call(
        "select api.svc_result_identity_versions($1::uuid,$2::text,$3::integer) as result",
        [uuid, beforeVersion, limit],
        { readOnly: true },
      );
      const data = response?.data;
      requireValue(
        response?.ok === true &&
          data?.resultId === uuid &&
          Array.isArray(data.versions) &&
          data.versions.length <= limit,
        "final_identity_versions_mismatch",
      );
      let previous = beforeVersion;
      for (const item of data.versions) {
        requireValue(
          VERSION.test(item.version ?? "") &&
            (previous === null || previous > item.version) &&
            ["registered", "legacy_requires_equivalence"].includes(item.status),
          "final_identity_versions_mismatch",
        );
        if (item.status === "registered")
          requireValue(
            UUID.test(item.registrationId ?? "") &&
              item.hashDomain === FINAL_RESULT_HASH_DOMAIN &&
              HASH.test(item.contentHash ?? ""),
            "final_identity_versions_mismatch",
          );
        else
          requireValue(
            item.registrationId === null &&
              item.hashDomain === null &&
              item.contentHash === null,
            "final_identity_versions_mismatch",
          );
        previous = item.version;
      }
      requireValue(
        data.nextBeforeVersion ===
          (data.versions.length === limit ? previous : null),
        "final_identity_versions_mismatch",
      );
      return {
        resultId: data.resultId,
        versions: data.versions.map(
          ({ version, registrationId, status, hashDomain, contentHash }) => ({
            version,
            registrationId,
            status,
            hashDomain,
            contentHash,
          }),
        ),
        nextBeforeVersion: data.nextBeforeVersion,
      };
    },
    close: () => pool.end(),
  };
}
