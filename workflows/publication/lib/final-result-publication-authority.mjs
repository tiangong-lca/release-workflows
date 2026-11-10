import { randomUUID } from "node:crypto";
import { fail, hashJson } from "./common.mjs";
import { finalResultReadinessContext } from "./final-result-readiness.mjs";
import {
  validateFinalResultPublicationPlan,
  assertFinalResultPublicationSnapshot,
} from "./final-result-publication-plan.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  HASH = /^[0-9a-f]{64}$/u;
const uuid = (v) => typeof v === "string" && UUID.test(v),
  hash = (v) => typeof v === "string" && HASH.test(v);
const same = (a, b) =>
  a !== undefined && b !== undefined && hashJson(a) === hashJson(b);
function required(v, code = "final_authority_binding_invalid") {
  if (!v)
    fail(
      code,
      "Final Result authority intent or current evidence does not match",
    );
}
function exact(v, keys) {
  required(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
  );
}
const RECEIPT_EXTRA = [
  "schemaVersion",
  "verificationId",
  "artifactCount",
  "probeCount",
  "fileCount",
  "coverageHash",
  "expiresAt",
  "sealedAt",
];
function readinessContext(receipt, local, plan) {
  const context = finalResultReadinessContext(receipt, RECEIPT_EXTRA);
  required(
    receipt.schemaVersion === "tiangong.final-result-readiness.v1" &&
      uuid(receipt.verificationId) &&
      hash(receipt.coverageHash) &&
      Number.isFinite(Date.parse(receipt.expiresAt)) &&
      Number.isFinite(Date.parse(receipt.sealedAt)) &&
      Date.parse(receipt.sealedAt) < Date.parse(receipt.expiresAt),
  );
  required(
    [receipt.artifactCount, receipt.probeCount, receipt.fileCount].every(
      (n) => Number.isSafeInteger(n) && n >= 1 && n <= 20000000,
    ) &&
      receipt.probeCount >= receipt.artifactCount &&
      receipt.probeCount <= 2 * receipt.artifactCount,
  );
  required(
    context.releaseRunId === plan.releaseRunId &&
      context.publishPlanHash === local.publishPlanHash &&
      context.candidateHash === plan.candidateSha256 &&
      context.targetHash === plan.targetHash &&
      context.selectionHash === plan.selectionHash &&
      context.selectionCount === plan.selectionCount,
  );
  return context;
}
function fresh(receipt) {
  required(
    Date.parse(receipt.expiresAt) > Date.now(),
    "final_authority_readiness_expired",
  );
}
function futureApproval(expiresAt) {
  const time = Date.parse(expiresAt),
    now = Date.now();
  required(
    Number.isFinite(time) && time > now && time <= now + 86400000,
    "final_authority_expiry_invalid",
  );
}
function actorBinding(local, actor) {
  required(
    uuid(actor.actorId) && actor.apiTargetHash === local.apiTargetHash,
    "final_authority_actor_target_mismatch",
  );
}
const approvalContext = (r, expectedApprovalId) => ({
  schemaVersion: "tiangong.final-result-approval.v2",
  verificationId: r.verificationId,
  expectedApprovalId,
  candidateHash: r.candidateHash,
  targetHash: r.targetHash,
  selectionHash: r.selectionHash,
  runtimeRevision: r.runtimeRevision,
  readerSha256: r.readerSha256,
  permissionHash: r.permissionHash,
});
const approvedContext = (r) => ({
  candidateHash: r.candidateHash,
  targetHash: r.targetHash,
  selectionHash: r.selectionHash,
  runtimeRevision: r.runtimeRevision,
  readerSha256: r.readerSha256,
  permissionHash: r.permissionHash,
});
async function live(
  local,
  plan,
  readiness,
  actor,
  probeActor,
  requireApprover,
) {
  actorBinding(local, actor);
  required(probeActor.actorId === actor.actorId);
  const snapshot = await actor.run(plan.releaseRunId);
  assertFinalResultPublicationSnapshot(snapshot, plan, local);
  required(
    snapshot.selectionSealed &&
      snapshot.registeredResultCount === plan.selectionCount &&
      snapshot.publication === null &&
      ["prepared", "ready_for_approval", "approved"].includes(snapshot.status),
    "final_authority_release_unavailable",
  );
  const page = await probeActor.probePage({
    releaseRunId: plan.releaseRunId,
    publishPlanHash: local.publishPlanHash,
    runtimeRevision: readiness.runtimeRevision,
    limit: 1,
  });
  const actual = finalResultReadinessContext(page, [
      "artifacts",
      "nextArtifactCursor",
    ]),
    expected = readinessContext(readiness, local, plan);
  if (requireApprover)
    required(same(actual, expected) && readiness.actorId === actor.actorId);
  else {
    const drop = (v) =>
      Object.fromEntries(
        Object.entries(v).filter(
          ([k]) => !["actorId", "permissionHash"].includes(k),
        ),
      );
    required(same(drop(actual), drop(expected)));
  }
  return snapshot;
}
export function validateFinalResultApprovalIntent(intent, local) {
  const { plan, localPlanHash } = validateFinalResultPublicationPlan(local);
  exact(intent, [
    "schemaVersion",
    "localPlanHash",
    "actorId",
    "apiTargetHash",
    "readiness",
    "approvalId",
    "expectedApprovalId",
    "expiresAt",
    "reason",
    "publicationAuthorized",
  ]);
  required(
    intent.schemaVersion === "tiangong.final-result-approval-intent.v1" &&
      intent.localPlanHash === localPlanHash &&
      intent.apiTargetHash === local.apiTargetHash &&
      uuid(intent.actorId) &&
      uuid(intent.approvalId) &&
      (intent.expectedApprovalId === null || uuid(intent.expectedApprovalId)) &&
      typeof intent.expiresAt === "string" &&
      Number.isFinite(Date.parse(intent.expiresAt)) &&
      typeof intent.reason === "string" &&
      intent.reason.trim().length > 0 &&
      [...intent.reason].length <= 2000 &&
      intent.publicationAuthorized === false,
  );
  readinessContext(intent.readiness, local, plan);
  required(intent.readiness.actorId === intent.actorId);
  return { plan, intentHash: hashJson(intent) };
}
export async function buildFinalResultApprovalIntent({
  local,
  readiness,
  actor,
  probeActor,
  expiresAt,
  reason,
  approvalId = randomUUID(),
}) {
  local = structuredClone(local);
  readiness = structuredClone(readiness);
  const { plan, localPlanHash } = validateFinalResultPublicationPlan(local);
  readinessContext(readiness, local, plan);
  fresh(readiness);
  futureApproval(expiresAt);
  const snapshot = await live(local, plan, readiness, actor, probeActor, true);
  const intent = {
    schemaVersion: "tiangong.final-result-approval-intent.v1",
    localPlanHash,
    actorId: actor.actorId,
    apiTargetHash: actor.apiTargetHash,
    readiness,
    approvalId,
    expectedApprovalId: snapshot.activeApproval?.approvalId ?? null,
    expiresAt,
    reason,
    publicationAuthorized: false,
  };
  return { intent, ...validateFinalResultApprovalIntent(intent, local) };
}
function observedApproval(approval, intent, plan, local) {
  required(
    approval &&
      approval.approvalId === intent.approvalId &&
      approval.releaseRunId === plan.releaseRunId &&
      approval.publishPlanHash === local.publishPlanHash &&
      hash(approval.approvalHash) &&
      approval.approvedBy === intent.actorId &&
      Date.parse(approval.expiresAt) === Date.parse(intent.expiresAt) &&
      approval.reason === intent.reason &&
      same(
        approval.context,
        approvalContext(intent.readiness, intent.expectedApprovalId),
      ),
    "final_authority_approval_mismatch",
  );
}
export async function approveFinalResultPublication({
  local,
  intent,
  confirmIntentHash,
  actor,
  probeActor,
  record,
}) {
  local = structuredClone(local);
  intent = structuredClone(intent);
  const { plan, intentHash } = validateFinalResultApprovalIntent(intent, local);
  required(
    confirmIntentHash === intentHash,
    "final_authority_confirmation_mismatch",
  );
  actorBinding(local, actor);
  required(intent.actorId === actor.actorId && typeof record === "function");
  await record({
    kind: "approval-execution-intent",
    intent: structuredClone(intent),
    intentHash,
  });
  let approval = await actor.approval({
    releaseRunId: plan.releaseRunId,
    approvalId: intent.approvalId,
  });
  if (!approval) {
    fresh(intent.readiness);
    futureApproval(intent.expiresAt);
    const snapshot = await live(
      local,
      plan,
      intent.readiness,
      actor,
      probeActor,
      true,
    );
    required(
      (snapshot.activeApproval?.approvalId ?? null) ===
        intent.expectedApprovalId,
      "final_authority_approval_changed",
    );
    try {
      await actor.approve({
        releaseRunId: plan.releaseRunId,
        publishPlanHash: local.publishPlanHash,
        verificationId: intent.readiness.verificationId,
        approvalId: intent.approvalId,
        expectedApprovalId: intent.expectedApprovalId,
        expiresAt: intent.expiresAt,
        reason: intent.reason,
      });
    } catch (e) {
      if (e.code !== "final_publication_outcome_unknown") throw e;
    }
    approval = await actor.approval({
      releaseRunId: plan.releaseRunId,
      approvalId: intent.approvalId,
    });
    required(approval, "final_publication_outcome_unknown");
  }
  observedApproval(approval, intent, plan, local);
  const receipt = {
    schemaVersion: "tiangong.final-result-approval-observation.v1",
    intentHash,
    releaseRunId: plan.releaseRunId,
    publishPlanHash: local.publishPlanHash,
    approval,
    observedAt: new Date().toISOString(),
    publicationAuthorized: false,
  };
  await record({
    kind: "approval-observation",
    receipt: structuredClone(receipt),
  });
  return receipt;
}
export function validateFinalResultActivationIntent(intent, local) {
  const { plan, localPlanHash } = validateFinalResultPublicationPlan(local);
  exact(intent, [
    "schemaVersion",
    "localPlanHash",
    "actorId",
    "apiTargetHash",
    "readiness",
    "approvalId",
    "approvalHash",
    "approvedBy",
    "idempotencyKey",
    "credentialFingerprint",
    "publicationAuthorized",
  ]);
  required(
    intent.schemaVersion === "tiangong.final-result-activation-intent.v1" &&
      intent.localPlanHash === localPlanHash &&
      intent.apiTargetHash === local.apiTargetHash &&
      uuid(intent.actorId) &&
      uuid(intent.approvalId) &&
      hash(intent.approvalHash) &&
      uuid(intent.approvedBy) &&
      typeof intent.idempotencyKey === "string" &&
      intent.idempotencyKey.length >= 1 &&
      intent.idempotencyKey.length <= 128 &&
      intent.idempotencyKey.trim() === intent.idempotencyKey &&
      hash(intent.credentialFingerprint) &&
      intent.publicationAuthorized === false,
  );
  readinessContext(intent.readiness, local, plan);
  required(intent.readiness.actorId === intent.approvedBy);
  return { plan, intentHash: hashJson(intent) };
}
function activationApproval(approval, intent, plan, local) {
  required(
    approval &&
      approval.releaseRunId === plan.releaseRunId &&
      approval.publishPlanHash === local.publishPlanHash &&
      approval.approvalId === intent.approvalId &&
      approval.approvalHash === intent.approvalHash &&
      approval.approvedBy === intent.approvedBy &&
      approval.status === "approved" &&
      Date.parse(approval.expiresAt) > Date.now(),
    "final_authority_approval_unavailable",
  );
  const context = Object.fromEntries(
    Object.entries(approval.context).filter(
      ([k]) =>
        !["schemaVersion", "verificationId", "expectedApprovalId"].includes(k),
    ),
  );
  required(
    approval.context.schemaVersion === "tiangong.final-result-approval.v2" &&
      same(context, approvedContext(intent.readiness)),
    "final_authority_approval_context_changed",
  );
}
export async function buildFinalResultActivationIntent({
  local,
  readiness,
  approvalId,
  actor,
  probeActor,
  idempotencyKey = `final-result-execution:${randomUUID()}`,
}) {
  local = structuredClone(local);
  readiness = structuredClone(readiness);
  const { plan, localPlanHash } = validateFinalResultPublicationPlan(local);
  readinessContext(readiness, local, plan);
  fresh(readiness);
  required(uuid(approvalId));
  const approval = await actor.approval({
    releaseRunId: plan.releaseRunId,
    approvalId,
  });
  required(approval, "final_authority_approval_unavailable");
  const intent = {
    schemaVersion: "tiangong.final-result-activation-intent.v1",
    localPlanHash,
    actorId: actor.actorId,
    apiTargetHash: actor.apiTargetHash,
    readiness,
    approvalId,
    approvalHash: approval.approvalHash,
    approvedBy: approval.approvedBy,
    idempotencyKey,
    credentialFingerprint: actor.credentialFingerprint,
    publicationAuthorized: false,
  };
  const checked = validateFinalResultActivationIntent(intent, local);
  activationApproval(approval, intent, plan, local);
  const snapshot = await live(local, plan, readiness, actor, probeActor, false);
  required(
    snapshot.activeApproval?.approvalId === approvalId &&
      snapshot.activeApproval.approvalHash === intent.approvalHash,
  );
  return { intent, ...checked };
}
function observedPublication(snapshot, intent, plan, local) {
  assertFinalResultPublicationSnapshot(snapshot, plan, local);
  const p = snapshot.publication;
  required(
    p &&
      uuid(p.publicationId) &&
      p.approvalId === intent.approvalId &&
      p.approvalHash === intent.approvalHash &&
      p.approvedBy === intent.approvedBy &&
      p.executedBy === intent.actorId &&
      p.idempotencyKey === intent.idempotencyKey &&
      p.credentialFingerprint === intent.credentialFingerprint &&
      p.verificationId === intent.readiness.verificationId &&
      p.previousPublicationId === plan.expectedCurrentPublicationId &&
      p.rollbackOfPublicationId === plan.rollbackOfPublicationId,
    "final_authority_publication_mismatch",
  );
  return p;
}
export async function activateFinalResultPublication({
  local,
  intent,
  confirmIntentHash,
  actor,
  probeActor,
  record,
}) {
  local = structuredClone(local);
  intent = structuredClone(intent);
  const { plan, intentHash } = validateFinalResultActivationIntent(
    intent,
    local,
  );
  required(
    confirmIntentHash === intentHash,
    "final_authority_confirmation_mismatch",
  );
  actorBinding(local, actor);
  required(intent.actorId === actor.actorId && typeof record === "function");
  await record({
    kind: "activation-execution-intent",
    intent: structuredClone(intent),
    intentHash,
  });
  let snapshot = await actor.run(plan.releaseRunId);
  assertFinalResultPublicationSnapshot(snapshot, plan, local);
  if (!snapshot.publication) {
    // The confirmed fingerprint audits the intent's originating session.
    // A fresh session for the same bound actor may execute it; live manager,
    // readiness, approval, target and current-publication checks still apply.
    fresh(intent.readiness);
    const approval = await actor.approval({
      releaseRunId: plan.releaseRunId,
      approvalId: intent.approvalId,
    });
    activationApproval(approval, intent, plan, local);
    snapshot = await live(
      local,
      plan,
      intent.readiness,
      actor,
      probeActor,
      false,
    );
    required(
      snapshot.activeApproval?.approvalId === intent.approvalId &&
        snapshot.activeApproval.approvalHash === intent.approvalHash,
      "final_authority_approval_changed",
    );
    try {
      await actor.activate({
        releaseRunId: plan.releaseRunId,
        publishPlanHash: local.publishPlanHash,
        approvalId: intent.approvalId,
        approvalHash: intent.approvalHash,
        verificationId: intent.readiness.verificationId,
        idempotencyKey: intent.idempotencyKey,
        credentialFingerprint: intent.credentialFingerprint,
      });
    } catch (e) {
      if (e.code !== "final_publication_outcome_unknown") throw e;
    }
    snapshot = await actor.run(plan.releaseRunId);
    required(snapshot?.publication, "final_publication_outcome_unknown");
  }
  const publication = observedPublication(snapshot, intent, plan, local);
  const receipt = {
    schemaVersion: "tiangong.final-result-activation-observation.v1",
    intentHash,
    releaseRunId: plan.releaseRunId,
    publishPlanHash: local.publishPlanHash,
    publication,
    observedAt: new Date().toISOString(),
    publicReadbackVerified: false,
  };
  await record({
    kind: "activation-observation",
    receipt: structuredClone(receipt),
  });
  return receipt;
}
