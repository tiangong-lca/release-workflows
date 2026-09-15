import path from "node:path";
import { fail, hashJson } from "./common.mjs";
import {
  assertExactObject,
  deepAssertExactObject,
  readJson,
  verifyJsonHash,
  writeCanonical,
  writeImmutableDirectory,
} from "./io.mjs";
import {
  RESULT_PROCESS_ROLE,
  RESULT_PROCESS_TARGET_STATE,
  assertOperationsAuthorizePerRoleTarget,
  isResultProcessRole,
} from "./publication-state.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const VERSION = /^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u;
const ATTESTATION_SCHEMA = "tiangong.release.manager-attestation.v1";
const ATTESTATION_ROW_SHAPE = {
  assertedRole: undefined,
  uuid: undefined,
  version: undefined,
  canonicalContentHash: undefined,
  targetStateCode: undefined,
  candidateSetHash: undefined,
  sourceManifestHash: undefined,
  planSha256: undefined,
};
const ATTESTATION_SHAPE = {
  schemaVersion: undefined,
  status: undefined,
  assertion: undefined,
  lineage: undefined,
  attestedBy: undefined,
  attestedByUserId: undefined,
  attestedAt: undefined,
  executablePlanSha256: undefined,
  resultProcessOperationCount: undefined,
  rowsHash: undefined,
  rows: [ATTESTATION_ROW_SHAPE],
};
const OPERATION_SHAPE = {
  key: undefined,
  role: undefined,
  contentType: undefined,
  table: undefined,
  uuid: undefined,
  version: undefined,
  expectedCanonicalContentHash: undefined,
  targetStateCode: undefined,
  action: undefined,
  remoteWrites: undefined,
  classification: undefined,
  observedStateCode: undefined,
  observedContentHash: undefined,
};

export async function createPublicationApproval({
  inspectionDir,
  outDir,
  confirmPlanSha256,
  approvedBy,
  expiresAt,
  reason = null,
  attestedByUserId = null,
  now = () => new Date(),
}) {
  const inspectionRoot = path.resolve(inspectionDir);
  const artifacts = await loadInspectionArtifacts(inspectionRoot);
  const executablePlanSha256 = hashJson(artifacts.executablePlan);
  if (confirmPlanSha256 !== executablePlanSha256)
    fail(
      "publication_approval_confirmation_mismatch",
      "Approval confirmation must exactly match the executable Publication Plan SHA-256",
      { expected: executablePlanSha256, received: confirmPlanSha256 ?? null },
    );
  const approver = String(approvedBy ?? "").trim();
  if (!approver || approver.length > 256)
    fail(
      "publication_approver_invalid",
      "Approval requires a stable approver identifier of at most 256 characters",
    );
  const approvedAtDate = now();
  const expiresAtDate = expiresAt
    ? new Date(expiresAt)
    : new Date(approvedAtDate.getTime() + 60 * 60 * 1000);
  if (
    Number.isNaN(expiresAtDate.getTime()) ||
    expiresAtDate.getTime() <= approvedAtDate.getTime()
  )
    fail(
      "publication_approval_expiration_invalid",
      "Approval expiration must be a valid future timestamp",
    );
  const normalizedReason = reason === null ? null : String(reason).trim();
  if (
    normalizedReason !== null &&
    (!normalizedReason || normalizedReason.length > 1000)
  )
    fail(
      "publication_approval_reason_invalid",
      "Approval reason must contain 1-1000 characters when provided",
    );
  const resultOperations = artifacts.executablePlan.operations.filter((op) =>
    isResultProcessRole(op.role),
  );
  const managerAttestation = resultOperations.length
    ? buildManagerAttestation({
        operations: resultOperations,
        executablePlanSha256,
        approver,
        attestedByUserId,
        approvedAtDate,
        // The source evidence comes from the verified payload manifest that the
        // target inspection copied next to the plan. The executable operations
        // do not carry it, so reading it from there would always yield null.
        sourceBindings: sourceBindingsFromManifest(artifacts.payloadManifest),
      })
    : null;
  const approval = {
    schemaVersion: "tiangong.release.publication-approval.v2",
    status: "approved",
    publicationAuthorized: true,
    resultPublicationAuthorized: resultOperations.length > 0,
    contractVersion: 2,
    targetId: artifacts.executablePlan.targetId,
    executablePlanSha256,
    publicationDraftPlanSha256:
      artifacts.executablePlan.publicationDraftPlanSha256,
    payloadManifestSha256: artifacts.executablePlan.payloadManifestSha256,
    targetSnapshotSha256: artifacts.executablePlan.targetSnapshotSha256,
    targetFingerprint: artifacts.executablePlan.targetFingerprint,
    stateMapping: artifacts.executablePlan.stateMapping,
    managerAttestation,
    approvedBy: approver,
    approvedAt: approvedAtDate.toISOString(),
    expiresAt: expiresAtDate.toISOString(),
    reason: normalizedReason,
  };
  const target = path.resolve(outDir);
  await writeImmutableDirectory(target, async (staging) => {
    await writeCanonical(
      path.join(staging, "publication-draft-plan.json"),
      artifacts.draftPlan,
    );
    await writeCanonical(
      path.join(staging, "publication-payload-manifest.json"),
      artifacts.payloadManifest,
    );
    await writeCanonical(
      path.join(staging, "publication-target-snapshot.json"),
      artifacts.snapshot,
    );
    await writeCanonical(
      path.join(staging, "publication-executable-plan.json"),
      artifacts.executablePlan,
    );
    await writeCanonical(
      path.join(staging, "publication-approval.json"),
      approval,
    );
  });
  return {
    path: target,
    approval,
    approvalSha256: hashJson(approval),
    executablePlanSha256,
  };
}

/**
 * Validate a manager attestation against the plan it authorizes and the source
 * evidence it claims.
 *
 * This is the single validator for every path that consumes an attestation, so an
 * attestation cannot be shape-valid in one code path and unverified in another.
 * It recomputes `rowsHash` and binds every row back to the approved operation and
 * to the verified payload manifest.
 */
export function assertManagerAttestation({
  attestation,
  executablePlanSha256,
  operations,
  payloadManifest,
}) {
  const code = "publication_manager_attestation_invalid";
  deepAssertExactObject(
    attestation,
    ATTESTATION_SHAPE,
    code,
    "Publication manager attestation",
  );
  if (
    attestation.schemaVersion !== ATTESTATION_SCHEMA ||
    attestation.status !== "asserted" ||
    attestation.assertion !== "manager_attested_authorization"
  )
    fail(code, "Manager attestation does not carry the expected assertion", {
      schemaVersion: attestation.schemaVersion,
      status: attestation.status,
      assertion: attestation.assertion,
    });
  if (attestation.lineage !== "not_machine_verified")
    fail(
      code,
      "Manager attestation must record unattested computational lineage",
      {
        lineage: attestation.lineage,
      },
    );
  if (
    !UUID.test(String(attestation.attestedByUserId ?? "")) ||
    typeof attestation.attestedBy !== "string" ||
    !attestation.attestedBy ||
    // Typed before parsing: `Date.parse` would coerce a number.
    typeof attestation.attestedAt !== "string" ||
    !Number.isFinite(Date.parse(attestation.attestedAt))
  )
    fail(code, "Manager attestation actor fields are malformed", {
      attestedByUserId: attestation.attestedByUserId ?? null,
      attestedBy: attestation.attestedBy ?? null,
      attestedAt: attestation.attestedAt ?? null,
    });
  if (attestation.executablePlanSha256 !== executablePlanSha256)
    fail(code, "Manager attestation does not bind this executable plan", {
      expected: executablePlanSha256,
      observed: attestation.executablePlanSha256 ?? null,
    });

  const rows = attestation.rows;
  if (
    !Array.isArray(rows) ||
    rows.length !== attestation.resultProcessOperationCount
  )
    fail(
      code,
      "Manager attestation row count does not match its own declaration",
      {
        declared: attestation.resultProcessOperationCount ?? null,
        observed: Array.isArray(rows) ? rows.length : null,
      },
    );
  // Recompute the row digest before trusting any row content.
  if (hashJson(rows) !== attestation.rowsHash)
    fail(code, "Manager attestation rows hash has drifted", {
      expected: attestation.rowsHash ?? null,
      observed: hashJson(rows),
    });

  const { candidateSetHash, sourceManifestHash } =
    sourceBindingsFromManifest(payloadManifest);
  const byId = new Map();
  for (const row of rows) {
    if (
      !UUID.test(String(row.uuid ?? "")) ||
      !VERSION.test(String(row.version ?? "")) ||
      !HASH.test(String(row.canonicalContentHash ?? "")) ||
      !HASH.test(String(row.candidateSetHash ?? "")) ||
      !HASH.test(String(row.sourceManifestHash ?? "")) ||
      !HASH.test(String(row.planSha256 ?? "")) ||
      row.assertedRole !== RESULT_PROCESS_ROLE ||
      row.targetStateCode !== RESULT_PROCESS_TARGET_STATE
    )
      fail(code, "Manager attestation row is malformed or untyped", {
        uuid: row.uuid ?? null,
        version: row.version ?? null,
      });
    const identity = `${String(row.uuid).toLowerCase()}@${row.version}`;
    if (byId.has(identity))
      fail(code, "Manager attestation repeats an identity", { identity });
    byId.set(identity, row);
    if (
      row.candidateSetHash !== candidateSetHash ||
      row.sourceManifestHash !== sourceManifestHash
    )
      fail(
        code,
        "Manager attestation source evidence does not match the verified payload manifest",
        {
          identity,
          expected: { candidateSetHash, sourceManifestHash },
          observed: {
            candidateSetHash: row.candidateSetHash,
            sourceManifestHash: row.sourceManifestHash,
          },
        },
      );
    if (row.planSha256 !== executablePlanSha256)
      fail(code, "Manager attestation row does not bind this executable plan", {
        identity,
      });
  }

  const approved = new Map(
    operations.map((operation) => [
      `${String(operation.uuid).toLowerCase()}@${operation.version}`,
      operation,
    ]),
  );
  if (approved.size !== operations.length)
    fail(
      "publication_executable_plan_invalid",
      "Publication executable plan repeats an operation identity",
    );
  if (approved.size !== byId.size)
    fail(
      "publication_approval_attestation_coverage_mismatch",
      "Manager attestation does not cover exactly the approved Result Process operations",
      {
        attested: [...byId.keys()].sort(),
        approved: [...approved.keys()].sort(),
      },
    );
  for (const [identity, row] of byId) {
    const operation = approved.get(identity);
    if (!operation)
      fail(
        "publication_approval_attestation_coverage_mismatch",
        `Manager attestation names an operation the plan does not authorize: ${identity}`,
      );
    if (
      row.canonicalContentHash !== operation.expectedCanonicalContentHash ||
      row.targetStateCode !== operation.targetStateCode
    )
      fail(
        "publication_approval_attestation_binding_mismatch",
        `Manager attestation row does not match the approved operation: ${identity}`,
        {
          expected: {
            canonicalContentHash: operation.expectedCanonicalContentHash,
            targetStateCode: operation.targetStateCode,
          },
          observed: {
            canonicalContentHash: row.canonicalContentHash,
            targetStateCode: row.targetStateCode,
          },
        },
      );
  }
  return attestation;
}

/**
 * The exact source evidence a Result Process attestation binds, taken from the
 * verified Publication payload manifest.
 *
 * Both values are mandatory: an attestation that cannot name the exact Candidate
 * set and package-set it authorizes would not be a source binding at all.
 */
export function sourceBindingsFromManifest(payloadManifest) {
  const candidateSetHash = payloadManifest?.datasetSetHash;
  const sourceManifestHash = payloadManifest?.candidate?.packageSetHash;
  if (
    !HASH.test(candidateSetHash ?? "") ||
    !HASH.test(sourceManifestHash ?? "")
  )
    fail(
      "publication_manager_attestation_source_unavailable",
      "Manager attestation requires the verified payload manifest's dataset-set and package-set hashes",
      {
        candidateSetHash: candidateSetHash ?? null,
        sourceManifestHash: sourceManifestHash ?? null,
      },
    );
  return { candidateSetHash, sourceManifestHash };
}

/**
 * The immutable manager assertion.
 *
 * It records exactly what the Data Product Manager confirmed: that these exact
 * Result Process identities, at their exact version, with this actual content
 * hash, may be published to the Result Process target state. It never claims
 * machine-verified computational lineage, and it is never updated in place.
 */
function buildManagerAttestation({
  operations,
  executablePlanSha256,
  approver,
  attestedByUserId,
  approvedAtDate,
  sourceBindings,
}) {
  if (!UUID.test(String(attestedByUserId ?? "").trim()))
    fail(
      "publication_manager_attestation_actor_invalid",
      "A Result Process approval requires the live Data Product Manager user ID that made the assertion",
      { expected: "uuid", received: attestedByUserId ?? null },
    );
  const rows = operations.map((operation) => ({
    assertedRole: RESULT_PROCESS_ROLE,
    uuid: operation.uuid,
    version: operation.version,
    canonicalContentHash: operation.expectedCanonicalContentHash,
    targetStateCode: operation.targetStateCode,
    candidateSetHash: sourceBindings.candidateSetHash,
    sourceManifestHash: sourceBindings.sourceManifestHash,
    planSha256: executablePlanSha256,
  }));
  return {
    schemaVersion: ATTESTATION_SCHEMA,
    status: "asserted",
    assertion: "manager_attested_authorization",
    lineage: "not_machine_verified",
    attestedBy: approver,
    attestedByUserId: String(attestedByUserId).trim().toLowerCase(),
    attestedAt: approvedAtDate.toISOString(),
    executablePlanSha256,
    resultProcessOperationCount: rows.length,
    rowsHash: hashJson(rows),
    rows,
  };
}

export async function loadApprovalArtifacts(approvalDir) {
  const root = path.resolve(approvalDir);
  const artifacts = await loadInspectionArtifacts(root);
  const { value: approval } = await readJson(
    path.join(root, "publication-approval.json"),
    "publication_approval_missing",
  );
  if (
    approval.schemaVersion !== "tiangong.release.publication-approval.v2" ||
    approval.status !== "approved" ||
    approval.publicationAuthorized !== true ||
    approval.contractVersion !== 2
  )
    fail(
      "publication_approval_unsupported",
      "Publication execution of a mixed-state plan requires an active Publication Approval v2",
      {
        observedSchemaVersion: approval.schemaVersion ?? null,
        requiredSchemaVersion: "tiangong.release.publication-approval.v2",
        historicalEvidenceReadable: true,
      },
    );
  assertExactObject(
    approval,
    [
      "schemaVersion",
      "status",
      "publicationAuthorized",
      "resultPublicationAuthorized",
      "contractVersion",
      "targetId",
      "executablePlanSha256",
      "publicationDraftPlanSha256",
      "payloadManifestSha256",
      "targetSnapshotSha256",
      "targetFingerprint",
      "stateMapping",
      "managerAttestation",
      "approvedBy",
      "approvedAt",
      "expiresAt",
      "reason",
    ],
    "publication_approval_invalid",
    "Publication approval",
  );
  const expectedResultCount = artifacts.executablePlan.operations.filter((op) =>
    isResultProcessRole(op.role),
  ).length;
  // Authorization validity is checked before attestation shape, so a plan that
  // was relabelled to a single legacy state reports the authorization failure.
  assertOperationsAuthorizePerRoleTarget({
    operations: artifacts.executablePlan.operations,
    publishedStateCode: null,
    executablePlanSha256: approval.executablePlanSha256,
  });
  // Bind the copied plan, snapshot and payload manifest first: the attestation is
  // then validated against inputs that are already known to be the approved ones,
  // rather than against whatever happened to be copied next to the approval.
  // Timestamps are validated once, centrally. A malformed value would make every
  // `expiresAt <= now` comparison false and silently bypass the expiry gate.
  const approvedAtMs =
    typeof approval.approvedAt === "string"
      ? Date.parse(approval.approvedAt)
      : NaN;
  const expiresAtMs =
    typeof approval.expiresAt === "string"
      ? Date.parse(approval.expiresAt)
      : NaN;
  if (
    !Number.isFinite(approvedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= approvedAtMs
  )
    fail(
      "publication_approval_invalid",
      "Publication Approval timestamps are malformed or unordered",
      {
        approvedAt: approval.approvedAt ?? null,
        expiresAt: approval.expiresAt ?? null,
      },
    );

  verifyJsonHash(
    artifacts.executablePlan,
    approval.executablePlanSha256,
    "publication_approval_plan_hash_mismatch",
    "Publication executable plan",
  );
  verifyJsonHash(
    artifacts.snapshot,
    approval.targetSnapshotSha256,
    "publication_approval_snapshot_hash_mismatch",
    "Publication target snapshot",
  );
  verifyJsonHash(
    artifacts.payloadManifest,
    approval.payloadManifestSha256,
    "publication_approval_payload_hash_mismatch",
    "Publication payload manifest",
  );
  if (expectedResultCount > 0)
    assertManagerAttestation({
      attestation: approval.managerAttestation,
      executablePlanSha256: approval.executablePlanSha256,
      operations: artifacts.executablePlan.operations.filter((operation) =>
        isResultProcessRole(operation.role),
      ),
      payloadManifest: artifacts.payloadManifest,
    });
  else if (approval.managerAttestation !== null)
    fail(
      "publication_manager_attestation_invalid",
      "An approval without Result Process operations must not carry a manager attestation",
    );
  if (
    expectedResultCount > 0 &&
    (approval.managerAttestation.resultProcessOperationCount !==
      expectedResultCount ||
      approval.managerAttestation.executablePlanSha256 !==
        approval.executablePlanSha256 ||
      approval.managerAttestation.rows.length !== expectedResultCount)
  )
    fail(
      "publication_approval_attestation_coverage_mismatch",
      "Manager attestation coverage does not match the approved mixed-state plan",
      {
        attestationCount:
          approval.managerAttestation.resultProcessOperationCount ?? null,
        expectedResultCount,
      },
    );
  if (
    approval.resultPublicationAuthorized !== expectedResultCount > 0 ||
    approval.stateMapping?.singleGlobalState !== false
  )
    fail(
      "publication_approval_invalid",
      "Approval result-publication authorization or state mapping has drifted",
    );
  return { root, ...artifacts, approval, approvalSha256: hashJson(approval) };
}

async function loadInspectionArtifacts(root) {
  const { value: draftPlan } = await readJson(
    path.join(root, "publication-draft-plan.json"),
    "publication_draft_plan_missing",
  );
  const { value: payloadManifest } = await readJson(
    path.join(root, "publication-payload-manifest.json"),
    "publication_payload_manifest_missing",
  );
  const { value: snapshot } = await readJson(
    path.join(root, "publication-target-snapshot.json"),
    "publication_target_snapshot_missing",
  );
  const { value: executablePlan } = await readJson(
    path.join(root, "publication-executable-plan.json"),
    "publication_executable_plan_missing",
  );
  if (
    executablePlan.schemaVersion !==
      "tiangong.release.publication-executable-plan.v2" ||
    executablePlan.status !== "ready_for_approval" ||
    executablePlan.publicationAuthorized !== false ||
    executablePlan.contractVersion !== 2
  )
    fail(
      "publication_executable_plan_unsupported",
      "Approval requires a ready, unapproved Publication Executable Plan v2",
      {
        observedSchemaVersion: executablePlan.schemaVersion ?? null,
        requiredSchemaVersion:
          "tiangong.release.publication-executable-plan.v2",
        historicalEvidenceReadable: true,
      },
    );
  assertExactObject(
    executablePlan,
    [
      "schemaVersion",
      "status",
      "publicationAuthorized",
      "resultPublicationAuthorized",
      "targetId",
      "contractVersion",
      "publicationDraftPlanSha256",
      "payloadManifestSha256",
      "targetSnapshotSha256",
      "targetFingerprint",
      "stateMapping",
      "operationCount",
      "resultProcessOperationCount",
      "operationFingerprint",
      "operations",
    ],
    "publication_executable_plan_invalid",
    "Publication executable plan",
  );
  const operationKeys = new Set();
  for (const operation of executablePlan.operations)
    deepAssertExactObject(
      operation,
      OPERATION_SHAPE,
      "publication_executable_plan_invalid",
      `Publication executable operation ${operation?.key ?? "?"}`,
    );
  for (const operation of executablePlan.operations) {
    if (operationKeys.has(operation.key))
      fail(
        "publication_executable_plan_invalid",
        `Publication executable plan repeats an operation: ${operation.key}`,
      );
    operationKeys.add(operation.key);
  }
  if (executablePlan.operations.length !== executablePlan.operationCount)
    fail(
      "publication_executable_plan_invalid",
      "Publication executable plan operation count has drifted",
    );
  verifyJsonHash(
    draftPlan,
    executablePlan.publicationDraftPlanSha256,
    "publication_executable_draft_hash_mismatch",
    "Publication Draft Plan",
  );
  verifyJsonHash(
    payloadManifest,
    executablePlan.payloadManifestSha256,
    "publication_executable_payload_hash_mismatch",
    "Publication payload manifest",
  );
  verifyJsonHash(
    snapshot,
    executablePlan.targetSnapshotSha256,
    "publication_executable_snapshot_hash_mismatch",
    "Publication target snapshot",
  );
  return { draftPlan, payloadManifest, snapshot, executablePlan };
}
