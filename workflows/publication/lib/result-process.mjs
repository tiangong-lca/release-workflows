import { access, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { loadApprovalArtifacts } from "./approval.mjs";
import { fail, hashJson, sha256Bytes } from "./common.mjs";
import {
  assertExactObject,
  containedPath,
  readJson,
  writeCanonical,
  writeImmutableDirectory,
} from "./io.mjs";
import { loadVerifiedPayload } from "./payload.mjs";
import {
  RESULT_PROCESS_CONTENT_HASH_DOMAIN,
  RESULT_PROCESS_TARGET_STATE,
  assertOperationsAuthorizePerRoleTarget,
  contentTypeForRole,
  deriveIdempotencyKey,
  isResultProcessRole,
} from "./publication-state.mjs";
import { resolvePublicationRuntime } from "./remote.mjs";
import {
  isAmbiguousTransportError,
  invokeResultProcessExecute,
  invokeResultProcessPrepare,
  invokeResultProcessReadback,
  validateReceipt,
  verifyReadbackContent,
} from "./result-process-transport.mjs";

export const DEFAULT_AUDIT_REASON = "approved result process publication";
export const MANAGER_ATTESTATION_SOURCE_KIND = "manager_attestation";
export const PREPARATION_SCHEMA =
  "tiangong.release.result-process-preparation.v2";
export const EXECUTION_INTENT_SCHEMA =
  "tiangong.release.result-process-execution-intent.v1";
export const EXECUTION_EVENT_SCHEMA =
  "tiangong.release.result-process-execution-event.v1";
export const EXECUTION_RECEIPT_SCHEMA =
  "tiangong.release.result-process-execution-receipt.v1";
export const READBACK_RECEIPT_SCHEMA =
  "tiangong.release.result-process-readback-receipt.v1";

export const OPERATION_KEYS = [
  "key",
  "role",
  "contentType",
  "table",
  "uuid",
  "version",
  "targetStateCode",
  "contentText",
  "contentSha256",
  "contentHashDomain",
  "contentByteSize",
  "candidateContentPath",
  "candidateSha256",
  "candidateCanonicalContentHash",
  "expectedCanonicalContentHash",
  "candidateSetHash",
  "sourceManifestHash",
  "executablePlanHash",
  "approvalHash",
  "idempotencyKey",
  "reason",
  "managerAttestation",
  "attestationRowHash",
];
export const PREPARED_OPERATION_KEYS = [
  ...OPERATION_KEYS,
  "preparationHash",
  "preparationClassification",
  "preparationExistingState",
];

/**
 * Load the Result Process operations a mixed-state approval authorizes, binding
 * each one to the frozen Candidate bytes and to the manager attestation.
 *
 * The bytes are re-read and re-hashed here instead of trusted from the payload
 * manifest, so a drifted payload fails before any remote call.
 */
export async function loadResultProcessOperations({ approvalDir, payloadDir }) {
  const evidence = await loadApprovalArtifacts(approvalDir);
  const { approval } = evidence;
  const payload = await loadVerifiedPayload(
    payloadDir,
    approval.payloadManifestSha256,
  );
  assertOperationsAuthorizePerRoleTarget({
    operations: evidence.executablePlan.operations,
    publishedStateCode: null,
    executablePlanSha256: approval.executablePlanSha256,
  });
  const datasetByKey = new Map(
    payload.datasets.map((dataset) => [dataset.key, dataset]),
  );
  const operations = [];
  for (const operation of evidence.executablePlan.operations) {
    if (!isResultProcessRole(operation.role) || !operation.remoteWrites)
      continue;
    const dataset = datasetByKey.get(operation.key);
    if (!dataset)
      fail(
        "result_process_publication_payload_missing",
        `Approved Result operation has no verified payload dataset: ${operation.key}`,
      );
    if (dataset.canonicalContentHash !== operation.expectedCanonicalContentHash)
      fail(
        "result_process_publication_content_binding_mismatch",
        `Approved operation content hash differs from the verified payload: ${operation.key}`,
      );
    const bytes = await readFile(
      containedPath(payload.root, dataset.payloadPath),
    );
    if (sha256Bytes(bytes) !== dataset.sha256)
      fail(
        "result_process_publication_member_hash_mismatch",
        `Frozen Candidate bytes drifted for ${operation.key}`,
      );
    const contentText = bytes.toString("utf8");
    const contentSha256 = sha256Bytes(Buffer.from(contentText, "utf8"));
    if (contentSha256 !== dataset.sha256)
      fail(
        "result_process_publication_content_encoding_mismatch",
        `Result payload is not exact UTF-8 for ${operation.key}`,
      );
    const attestationRow = approval.managerAttestation.rows.find(
      (row) => row.uuid === operation.uuid && row.version === operation.version,
    );
    if (!attestationRow)
      fail(
        "result_process_publication_attestation_missing",
        `Manager attestation does not cover the approved Result operation: ${operation.key}`,
      );
    operations.push({
      key: operation.key,
      role: operation.role,
      contentType: contentTypeForRole(operation.role),
      table: operation.table,
      uuid: operation.uuid,
      version: operation.version,
      targetStateCode: RESULT_PROCESS_TARGET_STATE,
      contentText,
      contentSha256,
      contentHashDomain: RESULT_PROCESS_CONTENT_HASH_DOMAIN,
      contentByteSize: bytes.length,
      candidateContentPath: dataset.payloadPath,
      candidateSha256: dataset.sha256,
      candidateCanonicalContentHash: dataset.canonicalContentHash,
      expectedCanonicalContentHash: operation.expectedCanonicalContentHash,
      candidateSetHash: payload.manifest.datasetSetHash,
      sourceManifestHash: payload.manifest.candidate.packageSetHash,
      executablePlanHash: approval.executablePlanSha256,
      approvalHash: evidence.approvalSha256,
      idempotencyKey: deriveIdempotencyKey({
        executablePlanSha256: approval.executablePlanSha256,
        key: operation.key,
        contentSha256,
      }),
      reason: approval.reason ?? DEFAULT_AUDIT_REASON,
      managerAttestation: hashJson(approval.managerAttestation),
      attestationRowHash: hashJson(attestationRow),
    });
  }
  if (!operations.length)
    fail(
      "result_process_publication_scope_empty",
      "Approved operations contain no Result Process write in this mixed-state plan",
    );
  return { evidence, approval, payload, operations };
}

/**
 * Remote prepare.
 *
 * Read-only: it classifies the identity, resolves the server preparation digest
 * and surfaces a conflict before any approval-bound write. The digest is
 * deliberately distinct from the executable plan and approval hashes and is
 * never derived from them, so prepare cannot depend on artifacts that do not
 * exist yet.
 */
export async function prepareResultProcessPublication({
  approvalDir,
  payloadDir,
  outDir,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const { evidence, approval, payload, operations } =
    await loadResultProcessOperations({ approvalDir, payloadDir });
  const runtime = await resolvePublicationRuntime({ env, fetchImpl });
  assertAttestingActor({ approval, runtime });
  for (const operation of operations) {
    const remote = await invokeResultProcessPrepare({
      runtime,
      operation,
      fetchImpl,
    });
    operation.preparationHash = remote.preparationHash;
    // Content candidacy only: never authorization, never a no-op.
    operation.preparationClassification = remote.classification;
    operation.preparationExistingState = remote.existingState;
  }
  const preparation = {
    schemaVersion: PREPARATION_SCHEMA,
    status: "prepared_remote",
    publicationAuthorized: false,
    resultPublicationAuthorized: false,
    targetId: approval.targetId,
    contractVersion: approval.contractVersion,
    actorUserId: runtime.actorUserId,
    targetEndpointFingerprint: runtime.targetEndpointFingerprint,
    approvalSha256: evidence.approvalSha256,
    executablePlanSha256: approval.executablePlanSha256,
    payloadManifestSha256: payload.manifestSha256,
    sourceKind: "manager_attestation",
    candidateSetHash: payload.manifest.datasetSetHash,
    sourceManifestHash: payload.manifest.candidate.packageSetHash,
    operationCount: operations.length,
    operationSetHash: hashJson(operations),
    preparedAt: now().toISOString(),
    operations,
  };
  const target = path.resolve(outDir);
  await writeImmutableDirectory(target, async (staging) => {
    // The approved artifacts are copied verbatim so every downstream step can
    // re-run the same strict approval/plan/payload binding instead of trusting
    // hashes recorded in the preparation file.
    await writeCanonical(
      path.join(staging, "publication-draft-plan.json"),
      evidence.draftPlan,
    );
    await writeCanonical(
      path.join(staging, "publication-approval.json"),
      approval,
    );
    await writeCanonical(
      path.join(staging, "publication-executable-plan.json"),
      evidence.executablePlan,
    );
    await writeCanonical(
      path.join(staging, "publication-target-snapshot.json"),
      evidence.snapshot,
    );
    await writeCanonical(
      path.join(staging, "publication-payload-manifest.json"),
      payload.manifest,
    );
    await writeCanonical(
      path.join(staging, "result-process-preparation.json"),
      preparation,
    );
  });
  return {
    path: target,
    preparation,
    preparationSha256: hashJson(preparation),
  };
}

/**
 * Load a remote-prepared preparation and bind it to the approved mixed-state
 * plan and the verified payload.
 */
/**
 * Resolve and strictly validate everything a Result Process execution depends on.
 *
 * Both the dedicated `result-process execute` command and the mixed
 * `publish execute` path call this, so there is exactly one approval/plan/
 * preparation/payload binding and one expiry rule. The dedicated route reads the
 * approved artifacts copied next to the preparation; the mixed route already
 * holds them. Neither is a weaker authorization path.
 */
export async function loadResultProcessExecution({
  payloadDir,
  preparationDir,
  now = () => new Date(),
  phase = "execute",
  expectedEvidence = null,
}) {
  if (phase !== "execute" && phase !== "readback")
    fail(
      "result_process_preparation_invalid",
      `Unsupported Result Process evidence phase: ${phase}`,
    );
  const root = path.resolve(preparationDir);
  // The copied approval, plan, snapshot and payload manifest are re-verified with
  // the same strict loader the approval directory uses, so a drifted or resealed
  // copy fails here instead of being trusted because it sits next to a preparation.
  const evidence = await loadApprovalArtifacts(root);
  const { approval, executablePlan, payloadManifest } = evidence;

  // The copied evidence must be exactly the evidence the caller selected. A
  // preparation for a different approval of the same payload and actor would
  // otherwise authorize Result RPCs under approval A while claiming approval B.
  if (expectedEvidence) assertEvidenceBinding({ evidence, expectedEvidence });

  // Approval timestamps are always structurally valid, but an expiry only limits
  // new execution. Independent readback re-verifies an already completed
  // publication, whose authorization was valid when it ran; the live manager role
  // is re-checked by every RPC on that path instead.
  // `Date.parse` coerces non-strings (it accepts the number 12345), so the
  // schema types are asserted before parsing rather than inferred from it.
  const expiresAtMs = parseApprovalTimestamp(approval.expiresAt);
  const approvedAtMs = parseApprovalTimestamp(approval.approvedAt);
  if (expiresAtMs === null || approvedAtMs === null)
    fail(
      "publication_approval_invalid",
      "Publication Approval timestamps must be ISO-8601 strings",
      {
        approvedAt: approval.approvedAt ?? null,
        expiresAt: approval.expiresAt ?? null,
      },
    );
  if (phase === "execute" && expiresAtMs <= now().getTime())
    fail("publication_approval_expired", "Publication Approval has expired", {
      expiresAt: approval.expiresAt,
    });

  const payload = await loadVerifiedPayload(
    payloadDir,
    approval.payloadManifestSha256,
  );

  const { value: preparation } = await readJson(
    path.join(root, "result-process-preparation.json"),
    "result_process_preparation_missing",
  );
  assertExactObject(
    preparation,
    [
      "schemaVersion",
      "status",
      "publicationAuthorized",
      "resultPublicationAuthorized",
      "targetId",
      "contractVersion",
      "actorUserId",
      "targetEndpointFingerprint",
      "approvalSha256",
      "executablePlanSha256",
      "payloadManifestSha256",
      "sourceKind",
      "candidateSetHash",
      "sourceManifestHash",
      "operationCount",
      "operationSetHash",
      "preparedAt",
      "operations",
    ],
    "result_process_preparation_invalid",
    "Result Process preparation",
  );
  if (
    preparation.schemaVersion !== PREPARATION_SCHEMA ||
    preparation.status !== "prepared_remote"
  )
    fail(
      "result_process_preparation_invalid",
      "Result Process execution requires a remote-prepared Result Process Preparation v2",
      { observed: preparation.schemaVersion },
    );
  if (
    preparation.approvalSha256 !== hashJson(approval) ||
    preparation.executablePlanSha256 !== hashJson(executablePlan) ||
    preparation.payloadManifestSha256 !== hashJson(payloadManifest)
  )
    fail(
      "result_process_preparation_binding_mismatch",
      "Result Process preparation does not bind this approval, plan and payload",
    );

  const approved = executablePlan.operations.filter((operation) =>
    isResultProcessRole(operation.role),
  );
  const approvedByKey = new Map(
    approved.map((operation) => [operation.key, operation]),
  );
  if (approvedByKey.size !== approved.length)
    fail(
      "publication_executable_plan_invalid",
      "Publication executable plan repeats an operation key",
    );
  if (
    preparation.operations.length !== preparation.operationCount ||
    preparation.operations.length !== approved.length
  )
    fail(
      "result_process_preparation_incomplete",
      "Result Process preparation does not cover exactly the approved Result Process operations",
      {
        prepared: preparation.operations.length,
        declared: preparation.operationCount,
        approved: approved.length,
      },
    );
  const operations = new Map();
  for (const operation of preparation.operations) {
    assertExactObject(
      operation,
      PREPARED_OPERATION_KEYS,
      "result_process_preparation_invalid",
      `Result Process operation ${operation?.key ?? "?"}`,
    );
    // Duplicates fail rather than silently overwriting an earlier entry.
    if (operations.has(operation.key))
      fail(
        "result_process_preparation_invalid",
        `Result Process preparation repeats an operation: ${operation.key}`,
      );
    operations.set(operation.key, operation);
    const expected = approvedByKey.get(operation.key);
    if (
      !expected ||
      operation.uuid !== expected.uuid ||
      operation.version !== expected.version ||
      operation.table !== expected.table ||
      operation.role !== expected.role ||
      operation.contentType !== expected.contentType ||
      operation.expectedCanonicalContentHash !==
        expected.expectedCanonicalContentHash ||
      operation.targetStateCode !== RESULT_PROCESS_TARGET_STATE ||
      operation.executablePlanHash !== hashJson(executablePlan) ||
      operation.approvalHash !== hashJson(approval) ||
      operation.candidateSetHash !== payloadManifest.datasetSetHash ||
      operation.sourceManifestHash !==
        payloadManifest.candidate.packageSetHash ||
      operation.managerAttestation !== hashJson(approval.managerAttestation) ||
      operation.reason !== (approval.reason ?? DEFAULT_AUDIT_REASON)
    )
      fail(
        "result_process_preparation_binding_mismatch",
        `Result Process preparation does not match the approved operation: ${operation.key}`,
        { key: operation.key },
      );
    if (!HASH.test(String(operation.preparationHash ?? "")))
      fail(
        "result_process_preparation_invalid",
        `Result Process preparation digest is missing or malformed: ${operation.key}`,
      );
  }
  // Header fields must align with the verified copied evidence, not merely be
  // self-consistent within the preparation file.
  const headerMismatches = [];
  const expectHeader = (field, expected, observed) => {
    if (observed !== expected)
      headerMismatches.push({ field, expected, observed });
  };
  expectHeader(
    "candidateSetHash",
    payloadManifest.datasetSetHash,
    preparation.candidateSetHash,
  );
  expectHeader(
    "sourceManifestHash",
    payloadManifest.candidate.packageSetHash,
    preparation.sourceManifestHash,
  );
  expectHeader(
    "actorUserId",
    approval.managerAttestation?.attestedByUserId,
    preparation.actorUserId,
  );
  expectHeader("targetId", executablePlan.targetId, preparation.targetId);
  expectHeader("targetId", evidence.snapshot.targetId, preparation.targetId);
  expectHeader(
    "targetEndpointFingerprint",
    evidence.snapshot.targetEndpointFingerprint,
    preparation.targetEndpointFingerprint,
  );
  expectHeader(
    "contractVersion",
    approval.contractVersion,
    preparation.contractVersion,
  );
  // `sourceKind` names the attestation basis and must match the one the verified
  // approval actually carries, not a locally asserted claim.
  expectHeader(
    "sourceKind",
    MANAGER_ATTESTATION_SOURCE_KIND,
    preparation.sourceKind,
  );
  if (headerMismatches.length)
    fail(
      "result_process_preparation_binding_mismatch",
      "Result Process preparation header does not match the approved source evidence",
      { mismatches: headerMismatches },
    );

  assertPreparedOperationsMatchPayload({ preparation, payload });
  // The declared digest must cover the operations actually present, so a resealed
  // preparation file cannot pass on a consistent-looking header alone.
  if (hashJson(preparation.operations) !== preparation.operationSetHash)
    fail(
      "result_process_preparation_invalid",
      "Result Process preparation operation-set hash has drifted",
      {
        expected: preparation.operationSetHash,
        observed: hashJson(preparation.operations),
      },
    );

  return {
    evidence,
    approval,
    executablePlan,
    payload,
    preparation,
    operations,
  };
}

/**
 * Execute one prepared Result Process operation with lost-response recovery.
 *
 * Returns the mixed-state execution outcome shape so the shared executor can
 * record Result and ordinary operations in one hash-linked event chain.
 */
export async function executePreparedResultOperation({
  runtime,
  operation,
  fetchImpl = globalThis.fetch,
}) {
  const result = await executeResultOperation({
    runtime,
    operation,
    fetchImpl,
  });
  // Two different hash domains, reported under names that cannot be confused:
  //
  //   canonicalContentHash - the canonical JSON content identity of the frozen
  //     Candidate dataset, which is what the manager attestation binds. It is
  //     NOT recomputed from the stored bytes here; that happens at readback.
  //   contentSha256 - the `result-process-content.v1` hash over the exact stored
  //     UTF-8 bytes, as verified and recorded by the reviewed command.
  //
  // The stored-byte hash is never reported as a canonical content hash.
  return {
    outcome: result.outcome,
    stateCode: result.receipt.stateCode,
    canonicalContentHash: operation.candidateCanonicalContentHash,
    contentSha256: result.receipt.contentSha256,
    remoteCommands: result.remoteCommands,
    disposition: result.disposition,
    receiptId: result.receipt.receiptId,
  };
}

async function executeResultOperation({ runtime, operation, fetchImpl }) {
  try {
    const { receipt, reused } = await invokeResultProcessExecute({
      runtime,
      operation,
      preparationHash: operation.preparationHash,
      fetchImpl,
    });
    return {
      outcome: reused ? "already_published" : "published",
      disposition: reused ? "reused_identical_receipt" : "published",
      receipt,
      remoteCommands: [
        reused
          ? "cmd_result_process_publish_v1:reused"
          : "cmd_result_process_publish_v1",
      ],
    };
  } catch (error) {
    // A lost response or an apparently conflicting answer may both mean an
    // earlier attempt already committed. Only an exact receipt resolves that.
    if (!isAmbiguousTransportError(error) && !isRecoverableConflict(error))
      throw error;
    const recovered = await reconcileFromReadback({
      runtime,
      operation,
      fetchImpl,
    });
    if (recovered) return recovered;
    if (isAmbiguousTransportError(error))
      error.details = {
        ...(error.details ?? {}),
        resumeSafe: true,
        reconciliation: "readback_found_no_exact_receipt",
      };
    throw error;
  }
}

function isRecoverableConflict(error) {
  return (
    error?.code === "result_publication_conflict" ||
    error?.code === "result_publication_replay_mismatch" ||
    error?.code === "result_preparation_stale"
  );
}

/**
 * Lost-response recovery: the only accepted evidence that a write happened is
 * an exact receipt for this actor, identity, version and idempotency key.
 */
async function reconcileFromReadback({ runtime, operation, fetchImpl }) {
  try {
    const readback = await invokeResultProcessReadback({
      runtime,
      operation,
      fetchImpl,
    });
    // The shared validator already binds the preparation digest, the full
    // receipt and the server's mandatory verification flags; content is then
    // recomputed independently. Neither check substitutes for the other.
    const receipt = validateReceipt({
      receipt: readback.receipt,
      operation,
      actorUserId: runtime.actorUserId,
      code: "result_process_readback_response_invalid",
    });
    verifyReadbackContent({ readback, operation });
    return {
      outcome: "already_published",
      disposition: "reconciled_after_transport_loss",
      receipt,
      remoteCommands: [
        "cmd_result_process_publish_v1",
        "qry_result_process_publication_readback_v1",
      ],
    };
  } catch (readbackError) {
    // Only "there is no receipt for this binding" and "the row is not at the
    // target state" mean the write did not land. A failed server verification or
    // a malformed readback is reported, never downgraded to "not published".
    if (
      readbackError?.code === "result_publication_not_found" ||
      readbackError?.code === "result_process_readback_state_mismatch"
    )
      return null;
    throw readbackError;
  }
}

/**
 * Independently verify one published Result Process operation through the exact
 * receipt binding, returning the same row shape the ordinary readback uses so
 * both role targets flow into a single Readback Receipt.
 *
 * Every value is recomputed locally. The server's own `verified` booleans are
 * recorded for audit but never trusted.
 */
export async function verifyPreparedResultOperation({
  runtime,
  operation,
  fetchImpl = globalThis.fetch,
}) {
  const readback = await invokeResultProcessReadback({
    runtime,
    operation,
    fetchImpl,
  });
  const receipt = validateReceipt({
    receipt: readback.receipt,
    operation,
    actorUserId: runtime.actorUserId,
    code: "result_process_readback_response_invalid",
  });
  // Both halves are mandatory: the shared validator binds the receipt (including
  // the preparation digest) and the server's live-manager verdict, while this
  // recomputes the stored bytes and canonical identity locally.
  const content = verifyReadbackContent({ readback, operation });
  return {
    key: operation.key,
    role: operation.role,
    table: operation.table,
    uuid: operation.uuid,
    version: operation.version,
    expectedCanonicalContentHash: operation.candidateCanonicalContentHash,
    observedCanonicalContentHash: content.observedCanonicalContentHash,
    expectedByteHash: operation.contentSha256,
    observedByteHash: content.observedByteHash,
    byteHashDomain: content.byteHashDomain,
    expectedStateCode: RESULT_PROCESS_TARGET_STATE,
    observedStateCode: readback.row.stateCode,
    receiptId: receipt.receiptId,
    publishedAt: receipt.publishedAt,
    serverVerified: readback.serverVerified,
    verified: true,
  };
}

function assertAttestingActor({ approval, runtime }) {
  const attestedByUserId = approval.managerAttestation?.attestedByUserId;
  if (!attestedByUserId || attestedByUserId !== runtime.actorUserId)
    fail(
      "result_process_attestation_actor_mismatch",
      "The Result Process publication actor must be the Data Product Manager recorded in the manager attestation",
      { attestedByUserId: attestedByUserId ?? null },
    );
}

const HASH = /^[0-9a-f]{64}$/u;

/**
 * Re-verify every hash the prepared request carries against the frozen Candidate
 * and source evidence, so a preparation file cannot be edited into a different
 * publication than the one that was prepared.
 */
/**
 * Bind independently validated evidence to the evidence the caller selected.
 *
 * Both sides are hashes of the approved artifacts, so this is an exact equality
 * check with no tolerance: a preparation that was built for a different approval
 * of the same payload and actor cannot be executed or read back under this one.
 */
/**
 * Parse an approval timestamp, refusing anything that is not a string.
 *
 * `Date.parse(12345)` yields a valid Date, so a numeric timestamp would
 * otherwise satisfy the freshness gate. The contract types these fields as
 * strings, so a non-string is malformed regardless of what `Date.parse` accepts.
 */
export function parseApprovalTimestamp(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Authorization failures apply to the whole call, not to one identity's content,
 * so they are never folded into a per-operation verification result.
 */
export function isAuthorizationError(error) {
  return (
    error?.code === "not_data_product_manager" ||
    error?.code === "auth_required"
  );
}

export function assertEvidenceBinding({ evidence, expectedEvidence }) {
  const mismatches = [];
  const expect = (field, expected, observed) => {
    if (expected !== undefined && observed !== expected)
      mismatches.push({ field, expected, observed });
  };
  expect(
    "approvalSha256",
    expectedEvidence.approvalSha256,
    hashJson(evidence.approval),
  );
  expect(
    "executablePlanSha256",
    expectedEvidence.executablePlanSha256,
    hashJson(evidence.executablePlan),
  );
  expect(
    "payloadManifestSha256",
    expectedEvidence.payloadManifestSha256,
    hashJson(evidence.payloadManifest),
  );
  if (mismatches.length)
    fail(
      "result_process_evidence_binding_mismatch",
      "Result Process preparation is bound to different approved evidence than the one selected",
      { mismatches },
    );
  return evidence;
}

export function assertPreparedOperationsMatchPayload({ preparation, payload }) {
  for (const operation of preparation.operations) {
    for (const field of ["contentSha256", "preparationHash"])
      if (typeof operation[field] !== "string" || !HASH.test(operation[field]))
        fail(
          "result_process_preparation_invalid",
          `Result Process operation ${field} must be a lowercase SHA-256 hex string`,
          { key: operation.key, field },
        );
    const dataset = payload.datasets.find(
      (candidate) => candidate.key === operation.key,
    );
    if (
      !dataset ||
      dataset.uuid !== operation.uuid ||
      dataset.version !== operation.version ||
      dataset.table !== operation.table ||
      dataset.role !== operation.role ||
      dataset.sha256 !== operation.candidateSha256 ||
      dataset.sha256 !== operation.contentSha256 ||
      dataset.canonicalContentHash !==
        operation.candidateCanonicalContentHash ||
      operation.candidateSetHash !== payload.manifest.datasetSetHash ||
      operation.sourceManifestHash !== payload.manifest.candidate.packageSetHash
    )
      fail(
        "result_process_preparation_binding_mismatch",
        `Result Process preparation is bound to a different identity, Candidate or source evidence: ${operation.key}`,
        { key: operation.key },
      );
  }
  return preparation;
}

/**
 * Remotely execute every prepared Result Process identity.
 *
 * Recovery contract: a lost response or an apparently conflicting answer is
 * never treated as success or as failure on its own. Only an exact receipt for
 * this actor, identity, version and idempotency key resolves it, and only then
 * is the identity recorded as completed.
 */
export async function executeResultProcessPublication({
  preparationDir,
  payloadDir,
  outDir,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const { approval, executablePlan, payload, preparation, operations } =
    await loadResultProcessExecution({ payloadDir, preparationDir, now });
  const preparationSha256 = hashJson(preparation);
  const runtime = await resolvePublicationRuntime({ env, fetchImpl });
  if (
    runtime.actorUserId !== preparation.actorUserId ||
    runtime.targetEndpointFingerprint !== preparation.targetEndpointFingerprint
  )
    fail(
      "result_process_execution_actor_or_target_mismatch",
      "Result Process execution actor and target must match the prepared request",
    );
  // No local pre-flight substitute for remote authority: every write below goes
  // through `cmd_result_process_publish_v1`, which re-checks the live manager role
  // and the current preparation itself. Re-deriving the preparation hash here
  // would also reject a legitimate retry, whose precondition legitimately changed
  // from absent to 120 and which the command resolves through its receipt.
  const target = path.resolve(outDir);
  await mkdir(target, { recursive: true });
  await mkdir(path.join(target, "events"), { recursive: true });
  await copyApprovedArtifactsInto(target, preparationDir);
  const intent = {
    schemaVersion: EXECUTION_INTENT_SCHEMA,
    approvalSha256: preparation.approvalSha256,
    executablePlanSha256: preparation.executablePlanSha256,
    payloadManifestSha256: preparation.payloadManifestSha256,
    preparationSha256,
    operationSetHash: preparation.operationSetHash,
    actorUserId: preparation.actorUserId,
  };
  const intentPath = path.join(target, "result-process-execution-intent.json");
  try {
    await access(intentPath);
    const { value: existing } = await readJson(intentPath);
    if (hashJson(existing) !== hashJson(intent))
      fail(
        "result_process_execution_resume_mismatch",
        "Existing Result Process execution directory belongs to a different preparation",
      );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeCanonical(intentPath, intent);
    await writeCanonical(
      path.join(target, "result-process-preparation.json"),
      preparation,
    );
  }

  const receiptPath = path.join(
    target,
    "result-process-execution-receipt.json",
  );
  try {
    await access(receiptPath);
    const { value: existing } = await readJson(receiptPath);
    assertExactObject(
      existing,
      [
        "schemaVersion",
        "status",
        "approvalSha256",
        "executablePlanSha256",
        "payloadManifestSha256",
        "preparationSha256",
        "operationSetHash",
        "actorUserId",
        "completedAt",
        "operationCount",
        "completedKeys",
        "eventCount",
        "eventLogHash",
        "independentReadbackVerified",
      ],
      "result_process_execution_receipt_invalid",
      "Result Process execution receipt",
    );
    if (
      existing.schemaVersion !== EXECUTION_RECEIPT_SCHEMA ||
      existing.preparationSha256 !== preparationSha256
    )
      fail(
        "result_process_execution_receipt_invalid",
        "Existing Result Process execution receipt belongs to a different preparation",
      );
    return {
      path: target,
      receipt: existing,
      receiptSha256: hashJson(existing),
      reused: true,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const history = await loadEventHistory(target);
  const completedKeys = new Set(
    history.events
      .filter(
        (event) =>
          event.outcome === "published" ||
          event.outcome === "already_published",
      )
      .map((event) => event.key),
  );
  const datasetByKey = new Map(
    payload.datasets.map((dataset) => [dataset.key, dataset]),
  );
  for (const operation of preparation.operations) {
    if (completedKeys.has(operation.key)) continue;
    if (!operations.has(operation.key))
      fail(
        "result_process_preparation_binding_mismatch",
        `Prepared operation is not part of the approved plan: ${operation.key}`,
      );
    const dataset = datasetByKey.get(operation.key);
    if (!dataset)
      fail(
        "result_process_execution_payload_missing",
        `Prepared Result operation has no verified payload dataset: ${operation.key}`,
      );
    const bytes = await readFile(
      containedPath(payload.root, dataset.payloadPath),
    );
    if (sha256Bytes(bytes) !== operation.candidateSha256)
      fail(
        "result_process_publication_member_hash_mismatch",
        `Frozen Candidate bytes drifted before execution: ${operation.key}`,
      );
    await appendEvent(target, history, {
      schemaVersion: EXECUTION_EVENT_SCHEMA,
      recordedAt: now().toISOString(),
      key: operation.key,
      role: operation.role,
      targetStateCode: operation.targetStateCode,
      outcome: "started",
      disposition: null,
      remoteReceiptId: null,
      stateCode: null,
      contentSha256: null,
      remoteCommands: [],
      error: null,
    });
    try {
      const outcome = await executePreparedResultOperation({
        runtime,
        operation,
        fetchImpl,
      });
      await appendEvent(target, history, {
        schemaVersion: EXECUTION_EVENT_SCHEMA,
        recordedAt: now().toISOString(),
        key: operation.key,
        role: operation.role,
        targetStateCode: operation.targetStateCode,
        outcome: outcome.outcome,
        disposition: outcome.disposition,
        remoteReceiptId: outcome.receiptId,
        stateCode: outcome.stateCode,
        contentSha256: outcome.contentSha256,
        remoteCommands: outcome.remoteCommands,
        error: null,
      });
      completedKeys.add(operation.key);
    } catch (error) {
      await appendEvent(target, history, {
        schemaVersion: EXECUTION_EVENT_SCHEMA,
        recordedAt: now().toISOString(),
        key: operation.key,
        role: operation.role,
        targetStateCode: operation.targetStateCode,
        outcome: "failed",
        disposition: null,
        remoteReceiptId: null,
        stateCode: null,
        contentSha256: null,
        remoteCommands: [],
        error: {
          code: error?.code ?? "result_process_execution_failed",
          message: error?.message ?? "Result Process execution failed",
          details: error?.details ?? {},
        },
      });
      error.details = {
        ...(error.details ?? {}),
        executionDirectory: target,
        completedKeys: [...completedKeys].sort(),
        failedKey: operation.key,
      };
      throw error;
    }
  }
  const receipt = {
    schemaVersion: EXECUTION_RECEIPT_SCHEMA,
    status: "published",
    approvalSha256: preparation.approvalSha256,
    executablePlanSha256: preparation.executablePlanSha256,
    payloadManifestSha256: preparation.payloadManifestSha256,
    preparationSha256,
    operationSetHash: preparation.operationSetHash,
    actorUserId: preparation.actorUserId,
    completedAt: now().toISOString(),
    operationCount: preparation.operationCount,
    completedKeys: [...completedKeys].sort(),
    eventCount: history.events.length,
    eventLogHash: hashJson(history.events.map((event) => hashJson(event))),
    independentReadbackVerified: false,
  };
  await writeCanonical(receiptPath, receipt);
  return {
    path: target,
    receipt,
    receiptSha256: hashJson(receipt),
    reused: false,
  };
}

/**
 * Independent readback of a Result Process execution.
 *
 * Release recomputes the stored-byte hash, the canonical Candidate content
 * identity and the full receipt binding. The server's own `verified` booleans
 * are recorded for audit and never trusted as evidence.
 */
export async function verifyResultProcessReadback({
  executionDir,
  payloadDir,
  outDir,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const root = path.resolve(executionDir);
  const { value: executionReceipt } = await readJson(
    path.join(root, "result-process-execution-receipt.json"),
    "result_process_execution_receipt_missing",
  );
  const { value: preparation } = await readJson(
    path.join(root, "result-process-preparation.json"),
    "result_process_preparation_missing",
  );
  const { value: intent } = await readJson(
    path.join(root, "result-process-execution-intent.json"),
    "result_process_execution_intent_missing",
  );
  if (
    executionReceipt.schemaVersion !== EXECUTION_RECEIPT_SCHEMA ||
    executionReceipt.status !== "published"
  )
    fail(
      "result_process_execution_receipt_unsupported",
      "Independent readback requires a completed Result Process Execution Receipt",
    );
  // Re-run the same strict approval/plan/preparation/payload binding and expiry
  // rule the execution used, from the artifacts kept beside the execution.
  const {
    approval: boundApproval,
    executablePlan: boundPlan,
    operations: boundOperations,
  } = await loadResultProcessExecution({
    payloadDir,
    preparationDir: root,
    now,
    // Evidence for a completed publication is re-verified even if the approval
    // has since expired; the live manager role is re-checked by every RPC.
    phase: "readback",
    expectedEvidence: {
      approvalSha256: executionReceipt.approvalSha256,
      executablePlanSha256: executionReceipt.executablePlanSha256,
      payloadManifestSha256: executionReceipt.payloadManifestSha256,
    },
  });
  if (executionReceipt.preparationSha256 !== hashJson(preparation))
    fail(
      "result_process_readback_preparation_mismatch",
      "Execution receipt does not bind this Result Process preparation",
    );
  if (
    executionReceipt.approvalSha256 !== hashJson(boundApproval) ||
    executionReceipt.executablePlanSha256 !==
      boundOperations.get(preparation.operations[0].key)?.executablePlanHash
  )
    fail(
      "result_process_readback_approval_mismatch",
      "Execution receipt does not bind the approved artifacts beside it",
    );
  if (intent.preparationSha256 !== executionReceipt.preparationSha256)
    fail(
      "result_process_readback_intent_mismatch",
      "Execution intent does not bind this Result Process preparation",
    );
  if (executionReceipt.actorUserId !== preparation.actorUserId)
    fail(
      "result_process_readback_actor_mismatch",
      "Execution receipt actor does not match the prepared attestation actor",
    );
  const payload = await loadVerifiedPayload(
    payloadDir,
    executionReceipt.payloadManifestSha256,
  );
  const runtime = await resolvePublicationRuntime({ env, fetchImpl });
  if (runtime.actorUserId !== executionReceipt.actorUserId)
    fail(
      "result_process_readback_actor_mismatch",
      "Readback actor must be the actor that performed the publication",
      { expected: executionReceipt.actorUserId },
    );
  const datasetByKey = new Map(
    payload.datasets.map((dataset) => [dataset.key, dataset]),
  );
  const rows = [];
  const failures = [];
  // Iterate the operations the loader proved are part of the approved plan and
  // payload, so readback can never touch an operation that only exists in the
  // preparation file.
  for (const operation of boundOperations.values()) {
    const dataset = datasetByKey.get(operation.key);
    if (!dataset)
      fail(
        "result_process_readback_payload_missing",
        `Published Result operation has no verified payload dataset: ${operation.key}`,
      );
    try {
      rows.push(
        await verifyPreparedResultOperation({ runtime, operation, fetchImpl }),
      );
    } catch (error) {
      if (isAuthorizationError(error)) throw error;
      failures.push({
        key: operation.key,
        code: error?.code ?? "result_process_readback_failed",
        ...(error?.details ?? {}),
      });
    }
  }
  if (failures.length)
    fail(
      "result_process_independent_readback_failed",
      "Independent Result Process readback found content, receipt or state mismatches",
      { failures },
    );
  const receipt = {
    schemaVersion: READBACK_RECEIPT_SCHEMA,
    status: "verified",
    independentlyQueried: true,
    executionReceiptSha256: hashJson(executionReceipt),
    preparationSha256: hashJson(preparation),
    approvalSha256: executionReceipt.approvalSha256,
    executablePlanSha256: executionReceipt.executablePlanSha256,
    payloadManifestSha256: executionReceipt.payloadManifestSha256,
    actorUserId: executionReceipt.actorUserId,
    verifiedAt: now().toISOString(),
    operationCount: rows.length,
    verifiedSetHash: hashJson(
      rows.map(
        ({
          key,
          observedByteHash,
          observedCanonicalContentHash,
          observedStateCode,
          receiptId,
        }) => ({
          key,
          observedByteHash,
          observedCanonicalContentHash,
          observedStateCode,
          receiptId,
        }),
      ),
    ),
    rows,
  };
  const target = path.resolve(outDir);
  await writeImmutableDirectory(target, async (staging) => {
    await writeCanonical(
      path.join(staging, "result-process-execution-receipt.json"),
      executionReceipt,
    );
    await writeCanonical(
      path.join(staging, "result-process-readback-receipt.json"),
      receipt,
    );
  });
  return { path: target, receipt, receiptSha256: hashJson(receipt) };
}

async function loadEventHistory(target) {
  const eventsDir = path.join(target, "events");
  await mkdir(eventsDir, { recursive: true });
  const files = (await readdir(eventsDir))
    .filter((file) => /^\d{6}\.json$/u.test(file))
    .sort();
  const events = [];
  let previous = null;
  for (const [index, file] of files.entries()) {
    const { value: event } = await readJson(path.join(eventsDir, file));
    assertExactObject(
      event,
      [
        "schemaVersion",
        "recordedAt",
        "key",
        "role",
        "targetStateCode",
        "outcome",
        "disposition",
        "remoteReceiptId",
        "stateCode",
        "contentSha256",
        "remoteCommands",
        "error",
        "sequence",
        "previousEventSha256",
      ],
      "result_process_execution_event_invalid",
      "Result Process execution event",
    );
    if (
      event.schemaVersion !== EXECUTION_EVENT_SCHEMA ||
      event.sequence !== index + 1 ||
      event.previousEventSha256 !== previous ||
      file !== `${String(index + 1).padStart(6, "0")}.json`
    )
      fail(
        "result_process_execution_event_chain_invalid",
        "Result Process execution event chain is incomplete or has drifted",
      );
    events.push(event);
    previous = hashJson(event);
  }
  return { events, previous };
}

/**
 * Keep the approved artifacts beside the execution directory.
 *
 * Readback re-runs the same strict approval/plan/payload binding the execution
 * used, so it needs those exact artifacts rather than hashes recorded alongside
 * them. The preparation directory already holds verified copies.
 */
async function copyApprovedArtifactsInto(target, preparationDir) {
  const root = path.resolve(preparationDir);
  for (const name of [
    "publication-draft-plan.json",
    "publication-approval.json",
    "publication-executable-plan.json",
    "publication-target-snapshot.json",
    "publication-payload-manifest.json",
  ]) {
    const { value } = await readJson(
      path.join(root, name),
      "result_process_preparation_incomplete",
    );
    const file = path.join(target, name);
    let existing = null;
    try {
      existing = (await readJson(file, "result_process_preparation_incomplete"))
        .value;
    } catch (error) {
      if (error?.code !== "result_process_preparation_incomplete") throw error;
    }
    if (existing !== null) {
      // A resumed execution reuses this directory. An already-present copy must
      // be the same evidence the preparation was built from, otherwise a stale
      // or swapped artifact would silently stand in for the approved one.
      if (hashJson(existing) !== hashJson(value))
        fail(
          "result_process_execution_evidence_mismatch",
          `Existing execution artifact does not match the prepared evidence: ${name}`,
          { artifact: name },
        );
      continue;
    }
    await writeCanonical(file, value);
  }
}

async function appendEvent(target, history, body) {
  const event = {
    ...body,
    sequence: history.events.length + 1,
    previousEventSha256: history.previous,
  };
  await writeCanonical(
    path.join(
      target,
      "events",
      `${String(event.sequence).padStart(6, "0")}.json`,
    ),
    event,
  );
  history.events.push(event);
  history.previous = hashJson(event);
}
