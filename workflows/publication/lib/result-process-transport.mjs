import { fail, hashJson, sha256Bytes } from "./common.mjs";
import { RESULT_PROCESS_CONTENT_HASH_DOMAIN } from "./publication-state.mjs";

export const PREPARE_FUNCTION = "qry_result_process_publish_prepare_v1";
export const EXECUTE_FUNCTION = "cmd_result_process_publish_v1";
export const READBACK_FUNCTION = "qry_result_process_publication_readback_v1";
export const SOURCE_KIND = "manager_attestation";
export const API_SCHEMA = "api";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u;
const CLASSIFICATIONS = new Set([
  "absent",
  "candidate_content_matches_existing",
  "conflict",
]);
/**
 * `published_at` is `timestamptz`. Postgres renders it as `...Z` or as an offset,
 * and may elide trailing fractional zeros.
 */
const TIMESTAMPTZ =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;

const RECEIPT_KEYS = [
  "schemaVersion",
  "receiptId",
  "actorUserId",
  "id",
  "version",
  "stateCode",
  "role",
  "targetState",
  "contentSha256",
  "hashDomain",
  "sourceKind",
  "candidateSetHash",
  "sourceManifestHash",
  "executablePlanHash",
  "approvalHash",
  "preparationHash",
  "idempotencyKey",
  "publishedAt",
  "reason",
];
const PREPARE_KEYS = [
  "schemaVersion",
  "preparationHash",
  "actorUserId",
  "id",
  "version",
  "contentSha256",
  "hashDomain",
  "sourceKind",
  "classification",
  "existingState",
];
const READBACK_DATA_KEYS = ["receipt", "row", "verified"];
const READBACK_ROW_KEYS = ["stateCode", "contentSha256", "contentText"];
const READBACK_VERIFIED_KEYS = [
  "rowMatchesReceipt",
  "receiptMatchesRequest",
  "liveManager",
];

/**
 * A transport-level failure whose remote outcome is unknown. The caller must
 * resolve it with an exact-binding readback before deciding anything.
 */
export function isAmbiguousTransportError(error) {
  return (
    error?.code === "publication_remote_unavailable" ||
    error?.code === "publication_remote_response_invalid"
  );
}

export function buildPrepareRequest(operation) {
  return {
    table: operation.table,
    id: operation.uuid,
    version: operation.version,
    contentText: operation.contentText,
    contentSha256: operation.contentSha256,
    sourceKind: SOURCE_KIND,
    source: {
      candidateSetHash: operation.candidateSetHash,
      sourceManifestHash: operation.sourceManifestHash,
    },
    audit: { reason: operation.reason },
  };
}

export function buildExecuteRequest(operation, { preparationHash }) {
  return {
    ...buildPrepareRequest(operation),
    source: {
      candidateSetHash: operation.candidateSetHash,
      sourceManifestHash: operation.sourceManifestHash,
      executablePlanHash: operation.executablePlanHash,
      approvalHash: operation.approvalHash,
    },
    expectedPreparationHash: preparationHash,
    idempotencyKey: operation.idempotencyKey,
  };
}

export function buildReadbackRequest(operation) {
  return {
    id: operation.uuid,
    version: operation.version,
    idempotencyKey: operation.idempotencyKey,
  };
}

export async function invokeResultProcessPrepare({
  runtime,
  operation,
  fetchImpl = globalThis.fetch,
}) {
  const payload = await invokeResultProcessRpc({
    runtime,
    functionName: PREPARE_FUNCTION,
    body: { p_request: buildPrepareRequest(operation) },
    fetchImpl,
  });
  return validatePrepareResponse({
    payload,
    operation,
    actorUserId: runtime.actorUserId,
  });
}

export async function invokeResultProcessExecute({
  runtime,
  operation,
  preparationHash,
  fetchImpl = globalThis.fetch,
}) {
  const payload = await invokeResultProcessRpc({
    runtime,
    functionName: EXECUTE_FUNCTION,
    body: { p_request: buildExecuteRequest(operation, { preparationHash }) },
    fetchImpl,
  });
  return validateExecuteResponse({
    payload,
    operation,
    actorUserId: runtime.actorUserId,
  });
}

export async function invokeResultProcessReadback({
  runtime,
  operation,
  fetchImpl = globalThis.fetch,
}) {
  const payload = await invokeResultProcessRpc({
    runtime,
    functionName: READBACK_FUNCTION,
    body: { p_request: buildReadbackRequest(operation) },
    fetchImpl,
  });
  return validateReadbackResponse({ payload, operation });
}

async function invokeResultProcessRpc({
  runtime,
  functionName,
  body,
  fetchImpl,
}) {
  const url = `${runtime.projectBaseUrl}/rest/v1/rpc/${functionName}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        apikey: runtime.publishableKey,
        Authorization: `Bearer ${runtime.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Profile": API_SCHEMA,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(
      "publication_remote_unavailable",
      `Result Process publication request failed: ${functionName}`,
      { cause: error instanceof Error ? error.name : "unknown" },
    );
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    fail(
      "publication_remote_unavailable",
      `Result Process publication response body was unavailable: ${functionName}`,
      { cause: error instanceof Error ? error.name : "unknown" },
    );
  }
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    fail(
      "publication_remote_response_invalid",
      `Result Process endpoint returned non-JSON: ${functionName}`,
      { httpStatus: response.status },
    );
  }
  // The contract carries the semantic class inside the JSON body. `ok` and
  // `code` decide; the HTTP status is only reported.
  if (payload?.ok === false) {
    const error = new Error(
      String(payload.message ?? "Result Process RPC failed"),
    );
    error.code = String(
      payload.code ?? "result_process_rpc_failed",
    ).toLowerCase();
    error.details = {
      rpc: functionName,
      semanticStatus: Number.isInteger(payload.status) ? payload.status : null,
      httpStatus: response.status,
      ...(payload.details === undefined
        ? {}
        : { remoteDetails: payload.details }),
    };
    throw error;
  }
  // Anything that is neither an explicit failure nor an explicit success leaves
  // the remote outcome unknown, so it is reported as an unusable response rather
  // than being guessed at. Callers treat this exactly like a lost response.
  if (payload?.ok !== true)
    fail(
      "publication_remote_response_invalid",
      `Result Process endpoint returned an unusable envelope: ${functionName}`,
      { httpStatus: response.status },
    );
  return payload;
}

function assertExactKeys(value, allowed, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(code, `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length)
    fail(code, `${label} contains unknown fields`, { unknown: unknown.sort() });
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length)
    fail(code, `${label} is missing fields`, { missing: missing.sort() });
  return value;
}

function assertHash(value, code, label) {
  if (typeof value !== "string" || !HASH.test(value))
    fail(code, `${label} must be a lowercase SHA-256 hex string`);
  return value;
}

/**
 * A JSON string only. Guards against `String(value)` style coercion accepting an
 * array, object or number where the contract promises a scalar.
 */
function assertString(value, code, label, { pattern, maxLength } = {}) {
  if (typeof value !== "string")
    fail(code, `${label} must be a string`, { observedType: typeName(value) });
  if (pattern && !pattern.test(value))
    fail(code, `${label} does not match the required format`);
  if (maxLength !== undefined && value.length > maxLength)
    fail(code, `${label} is longer than ${maxLength} characters`);
  return value;
}

function assertUuid(value, code, label) {
  return assertString(value, code, label, { pattern: UUID });
}

function assertVersion(value, code, label) {
  return assertString(value, code, label, { pattern: VERSION });
}

function assertTimestamp(value, code, label) {
  assertString(value, code, label, { pattern: TIMESTAMPTZ });
  if (Number.isNaN(Date.parse(value)))
    fail(code, `${label} is not a real timestamp`);
  return value;
}

function assertIntegerOrNull(value, code, label) {
  if (value !== null && !Number.isInteger(value))
    fail(code, `${label} must be an integer or null`, {
      observedType: typeName(value),
    });
  return value;
}

function assertBoolean(value, code, label) {
  if (typeof value !== "boolean")
    fail(code, `${label} must be a boolean`, {
      observedType: typeName(value),
    });
  return value;
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

export function validatePrepareResponse({ payload, operation, actorUserId }) {
  const data = assertExactKeys(
    payload.data,
    PREPARE_KEYS,
    "result_process_prepare_response_invalid",
    "Result Process prepare data",
  );
  if (data.schemaVersion !== "result-process.publish-prepare.v1")
    fail(
      "result_process_prepare_response_invalid",
      "Result Process prepare returned an unsupported schema version",
      { observed: data.schemaVersion ?? null },
    );
  assertHash(
    data.preparationHash,
    "result_process_prepare_response_invalid",
    "preparationHash",
  );
  assertHash(
    data.contentSha256,
    "result_process_prepare_response_invalid",
    "contentSha256",
  );
  if (
    data.actorUserId !== actorUserId ||
    data.id !== operation.uuid ||
    data.version !== operation.version ||
    data.contentSha256 !== operation.contentSha256 ||
    data.hashDomain !== RESULT_PROCESS_CONTENT_HASH_DOMAIN ||
    data.sourceKind !== SOURCE_KIND ||
    !CLASSIFICATIONS.has(data.classification)
  )
    fail(
      "result_process_prepare_response_binding_mismatch",
      "Result Process prepare response does not match the attested request binding",
      {
        expected: {
          actorUserId,
          id: operation.uuid,
          version: operation.version,
          contentSha256: operation.contentSha256,
          hashDomain: RESULT_PROCESS_CONTENT_HASH_DOMAIN,
          sourceKind: SOURCE_KIND,
        },
        observed: {
          actorUserId: data.actorUserId ?? null,
          id: data.id ?? null,
          version: data.version ?? null,
          contentSha256: data.contentSha256 ?? null,
          hashDomain: data.hashDomain ?? null,
          sourceKind: data.sourceKind ?? null,
          classification: data.classification ?? null,
        },
      },
    );
  assertExistingStateConsistency({
    classification: data.classification,
    existingState: data.existingState,
    contentSha256MatchesRequest: data.contentSha256 === operation.contentSha256,
    key: operation.key,
  });
  if (data.classification === "conflict")
    fail(
      "result_process_prepare_conflict",
      `Result Process identity cannot be published from this Candidate: ${operation.key}`,
      { existingState: data.existingState },
    );
  return {
    schemaVersion: data.schemaVersion,
    preparationHash: data.preparationHash,
    actorUserId: data.actorUserId,
    id: data.id,
    version: data.version,
    contentSha256: data.contentSha256,
    hashDomain: data.hashDomain,
    sourceKind: data.sourceKind,
    // Content candidacy only. It is never authorization and never a no-op.
    classification: data.classification,
    existingState: data.existingState,
  };
}

/**
 * `classification` and `existingState` come from one classifier, so they must
 * agree. `private.result_process_publish_classify_v1` decides existence with
 * FOUND, and only reports `candidate_content_matches_existing` when the row is
 * at 120 with an identical stored-byte hash.
 *
 * The version check is conditional on purpose: SQL stores `state_code` as a plain
 * integer, so a row carrying a legacy state the classifier does not recognise
 * falls into `conflict` while still reporting its real `existingState`.
 */
function assertExistingStateConsistency({
  classification,
  existingState,
  contentSha256MatchesRequest,
}) {
  const at = { classification, existingState };
  if (existingState !== null && !Number.isInteger(existingState))
    fail(
      "result_process_prepare_response_binding_mismatch",
      "Result Process prepare existingState must be an integer or null",
      { ...at, observedType: typeName(existingState) },
    );
  if (classification === "absent") {
    if (existingState !== null)
      fail(
        "result_process_prepare_response_binding_mismatch",
        "Result Process prepare reported an existing state for an absent identity",
        at,
      );
    return;
  }
  if (classification === "candidate_content_matches_existing") {
    if (existingState !== 120)
      fail(
        "result_process_prepare_response_binding_mismatch",
        "Result Process prepare reported content candidacy for a row that is not at 120",
        at,
      );
    if (!contentSha256MatchesRequest)
      fail(
        "result_process_prepare_response_binding_mismatch",
        "Result Process prepare reported content candidacy for different content",
        at,
      );
    return;
  }
  // conflict: the classifier reports the row's real state, which may legitimately
  // be null (a row that exists with a null state_code) or a value outside the
  // well-known lifecycle set.
  assertIntegerOrNull(
    existingState,
    "result_process_prepare_response_binding_mismatch",
    "Result Process prepare existingState",
  );
}

export function validateExecuteResponse({ payload, operation, actorUserId }) {
  const receipt = validateReceipt({
    receipt: payload.data,
    operation,
    actorUserId,
    code: "result_process_execute_response_invalid",
  });
  if (typeof payload.reused !== "boolean")
    fail(
      "result_process_execute_response_invalid",
      "Result Process execute response must carry a boolean reused flag",
    );
  return { receipt, reused: payload.reused };
}

export function validateReadbackResponse({ payload, operation }) {
  const data = assertExactKeys(
    payload.data,
    READBACK_DATA_KEYS,
    "result_process_readback_response_invalid",
    "Result Process readback data",
  );
  const row = assertExactKeys(
    data.row,
    READBACK_ROW_KEYS,
    "result_process_readback_response_invalid",
    "Result Process readback row",
  );
  const verified = assertExactKeys(
    data.verified,
    READBACK_VERIFIED_KEYS,
    "result_process_readback_response_invalid",
    "Result Process readback verified flags",
  );
  assertIntegerOrNull(
    row.stateCode,
    "result_process_readback_response_invalid",
    "row.stateCode",
  );
  if (row.stateCode !== 120)
    fail(
      "result_process_readback_state_mismatch",
      `Readback row is not at the Result Process target state: ${operation.key}`,
      { stateCode: row.stateCode },
    );
  if (typeof row.contentText !== "string")
    fail(
      "result_process_readback_response_invalid",
      "Result Process readback row must carry the exact stored content text",
    );
  // The server's own verdicts are mandatory, not advisory. Release recomputes
  // content and receipt binding independently, but only the server can attest
  // that the reading actor still holds the live manager role at read time; a
  // false, missing or non-boolean flag therefore fails closed and nothing is
  // reported as verified.
  const serverVerified = {
    rowMatchesReceipt: assertBoolean(
      verified.rowMatchesReceipt,
      "result_process_readback_server_verification_invalid",
      "verified.rowMatchesReceipt",
    ),
    receiptMatchesRequest: assertBoolean(
      verified.receiptMatchesRequest,
      "result_process_readback_server_verification_invalid",
      "verified.receiptMatchesRequest",
    ),
    liveManager: assertBoolean(
      verified.liveManager,
      "result_process_readback_server_verification_invalid",
      "verified.liveManager",
    ),
  };
  const untruthful = Object.entries(serverVerified)
    .filter(([, value]) => value !== true)
    .map(([flag]) => flag);
  if (untruthful.length)
    fail(
      "result_process_readback_server_verification_failed",
      `Server-side readback verification is not fully true: ${operation.key}`,
      { serverVerified, failedFlags: untruthful },
    );
  return {
    receipt: assertReceiptShape({
      receipt: data.receipt,
      code: "result_process_readback_response_invalid",
    }),
    row: {
      stateCode: row.stateCode,
      contentSha256: assertHash(
        row.contentSha256,
        "result_process_readback_response_invalid",
        "row.contentSha256",
      ),
      contentText: row.contentText,
    },
    // Recorded so the receipt can show what the server asserted, alongside the
    // independently recomputed values. Both checks are required: neither
    // substitutes for the other.
    serverVerified,
  };
}

function assertReceiptShape({ receipt, code }) {
  const value = assertExactKeys(
    receipt,
    RECEIPT_KEYS,
    code,
    "Result Process receipt",
  );
  if (value.schemaVersion !== "result-process.publication-receipt.v1")
    fail(code, "Result Process receipt has an unsupported schema version", {
      observed: value.schemaVersion ?? null,
    });
  for (const field of [
    "contentSha256",
    "candidateSetHash",
    "sourceManifestHash",
    "executablePlanHash",
    "approvalHash",
    "preparationHash",
  ])
    assertHash(value[field], code, `receipt.${field}`);
  // Each scalar is type-checked before any pattern test. A pattern test alone is
  // not enough: `RegExp.test` stringifies its argument, so a one-element array
  // such as `["<uuid>"]` would otherwise pass as a valid identity.
  assertUuid(value.receiptId, code, "receipt.receiptId");
  assertUuid(value.actorUserId, code, "receipt.actorUserId");
  assertUuid(value.id, code, "receipt.id");
  assertVersion(value.version, code, "receipt.version");
  assertTimestamp(value.publishedAt, code, "receipt.publishedAt");
  assertString(value.idempotencyKey, code, "receipt.idempotencyKey", {
    maxLength: 200,
  });
  assertString(value.reason, code, "receipt.reason", { maxLength: 1000 });
  if (
    value.stateCode !== 120 ||
    value.targetState !== 120 ||
    value.role !== "result_process" ||
    value.hashDomain !== RESULT_PROCESS_CONTENT_HASH_DOMAIN ||
    value.sourceKind !== SOURCE_KIND
  )
    fail(
      code,
      "Result Process receipt does not record the Result Process target semantics",
    );
  return value;
}

/**
 * Bind a receipt to the exact approved operation.
 *
 * Every attested value is compared against what Release froze, not against what
 * the server echoed back.
 */
export function validateReceipt({ receipt, operation, actorUserId, code }) {
  const value = assertReceiptShape({ receipt, code });
  const mismatches = [];
  const expect = (field, expected, observed) => {
    if (observed !== expected) mismatches.push({ field, expected, observed });
  };
  expect("actorUserId", actorUserId, value.actorUserId);
  expect("id", operation.uuid, value.id);
  expect("version", operation.version, value.version);
  expect("contentSha256", operation.contentSha256, value.contentSha256);
  expect(
    "candidateSetHash",
    operation.candidateSetHash,
    value.candidateSetHash,
  );
  expect(
    "sourceManifestHash",
    operation.sourceManifestHash,
    value.sourceManifestHash,
  );
  expect(
    "executablePlanHash",
    operation.executablePlanHash,
    value.executablePlanHash,
  );
  expect("approvalHash", operation.approvalHash, value.approvalHash);
  // The server preparation digest is bound here, on every path, so a
  // syntactically valid digest from a different preparation can never be
  // recorded as a successful publication.
  expect("preparationHash", operation.preparationHash, value.preparationHash);
  expect("idempotencyKey", operation.idempotencyKey, value.idempotencyKey);
  expect("reason", operation.reason, value.reason);
  if (mismatches.length)
    fail(
      "result_process_receipt_binding_mismatch",
      `Result Process receipt does not bind the approved publication: ${operation.key}`,
      { mismatches },
    );
  return value;
}

/**
 * Independently verify a readback against the frozen Candidate.
 *
 * Three separate checks, none of which are taken from the server's own
 * `verified` booleans:
 *   1. the exact stored bytes hashed in `result-process-content.v1`;
 *   2. the canonical Candidate content identity of the returned document;
 *   3. the receipt's preparation hash matching the one this run prepared.
 */
export function verifyReadbackContent({ readback, operation }) {
  const observedByteHash = sha256Bytes(
    Buffer.from(readback.row.contentText, "utf8"),
  );
  if (observedByteHash !== readback.row.contentSha256)
    fail(
      "result_process_readback_byte_hash_mismatch",
      `Readback content does not hash to its own recorded bytes: ${operation.key}`,
      { recorded: readback.row.contentSha256, recomputed: observedByteHash },
    );
  if (observedByteHash !== operation.contentSha256)
    fail(
      "result_process_readback_content_drift",
      `Readback content differs from the frozen Candidate bytes: ${operation.key}`,
      { expected: operation.contentSha256, observed: observedByteHash },
    );
  let document;
  try {
    document = JSON.parse(readback.row.contentText);
  } catch {
    fail(
      "result_process_readback_content_invalid",
      `Readback content is not valid JSON: ${operation.key}`,
    );
  }
  const observedCanonical = hashJson(document);
  if (observedCanonical !== operation.candidateCanonicalContentHash)
    fail(
      "result_process_readback_canonical_identity_mismatch",
      `Readback document is not the exact Candidate content: ${operation.key}`,
      {
        expected: operation.candidateCanonicalContentHash,
        observed: observedCanonical,
      },
    );
  if (observedCanonical !== operation.expectedCanonicalContentHash)
    fail(
      "result_process_readback_canonical_identity_mismatch",
      `Readback document does not match the approved operation content: ${operation.key}`,
      {
        expected: operation.expectedCanonicalContentHash,
        observed: observedCanonical,
      },
    );
  return {
    observedByteHash,
    observedCanonicalContentHash: observedCanonical,
    byteHashDomain: RESULT_PROCESS_CONTENT_HASH_DOMAIN,
  };
}
