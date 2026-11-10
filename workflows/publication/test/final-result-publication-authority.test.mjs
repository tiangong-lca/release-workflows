import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { finalResultSelection } from "../lib/final-result-publication-plan.mjs";
import {
  buildFinalResultApprovalIntent,
  approveFinalResultPublication,
  buildFinalResultActivationIntent,
  activateFinalResultPublication,
  validateFinalResultApprovalIntent,
  validateFinalResultActivationIntent,
} from "../lib/final-result-publication-authority.mjs";
const id = (n) => `87980000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  h = (n) => String(n).repeat(64);
function fixture() {
  const selection = finalResultSelection([
    { uuid: id(9), version: "01.00.000" },
  ]);
  const plan = {
    schemaVersion: "tiangong.final-result-publish-plan.v2",
    releaseRunId: id(10),
    releaseVersion: "2026.11.0",
    candidateSha256: h(1),
    targetHash: h(2),
    selectionHash: selection.selectionHash,
    selectionCount: 1,
    expectedCurrentPublicationId: null,
    rollbackOfPublicationId: null,
    reason: "synthetic release",
  };
  const planText = canonicalJson(plan),
    local = {
      schemaVersion: "tiangong.final-result-publication-local-plan.v1",
      actorId: id(1),
      apiTargetHash: h(3),
      candidateDir: path.resolve("synthetic-candidate"),
      planText,
      publishPlanHash: sha256Bytes(Buffer.from(planText)),
      members: selection.members,
      publicationAuthorized: false,
    };
  const context = {
    releaseRunId: plan.releaseRunId,
    publishPlanHash: local.publishPlanHash,
    candidateHash: plan.candidateSha256,
    targetHash: plan.targetHash,
    selectionHash: plan.selectionHash,
    selectionCount: 1,
    runtimeRevision: id(11),
    readerSha256: h(4),
    actorId: id(2),
    permissionHash: h(5),
    scope: {
      kind: "readiness",
      releaseRunId: plan.releaseRunId,
      selectionHash: plan.selectionHash,
    },
    publicationAuthorized: false,
  };
  const readiness = {
    ...context,
    schemaVersion: "tiangong.final-result-readiness.v1",
    verificationId: id(12),
    artifactCount: 1,
    probeCount: 1,
    fileCount: 9,
    coverageHash: h(6),
    sealedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  const snapshot = {
    releaseRunId: plan.releaseRunId,
    publishPlanHash: local.publishPlanHash,
    releaseVersion: plan.releaseVersion,
    candidateHash: plan.candidateSha256,
    targetHash: plan.targetHash,
    selectionHash: plan.selectionHash,
    selectionCount: 1,
    registeredResultCount: 1,
    selectionSealed: true,
    expectedCurrentPublicationId: null,
    rollbackOfPublicationId: null,
    status: "prepared",
    activeApproval: null,
    publication: null,
    publicationAuthorized: false,
  };
  let approval = null;
  const calls = [],
    events = [],
    lost = new Set();
  const actorFor = (n) => ({
    actorId: id(n),
    apiTargetHash: local.apiTargetHash,
    credentialFingerprint: h(n),
    async run() {
      calls.push("run");
      return structuredClone(snapshot);
    },
    async approval() {
      calls.push("approval");
      return structuredClone(approval);
    },
    async approve(a) {
      calls.push("approve");
      approval = {
        approvalId: a.approvalId,
        releaseRunId: a.releaseRunId,
        publishPlanHash: a.publishPlanHash,
        approvalHash: h(7),
        approvedBy: id(n),
        approvedAt: new Date().toISOString(),
        expiresAt: a.expiresAt,
        status: "approved",
        reason: a.reason,
        context: {
          schemaVersion: "tiangong.final-result-approval.v2",
          verificationId: a.verificationId,
          expectedApprovalId: a.expectedApprovalId,
          candidateHash: readiness.candidateHash,
          targetHash: readiness.targetHash,
          selectionHash: readiness.selectionHash,
          runtimeRevision: readiness.runtimeRevision,
          readerSha256: readiness.readerSha256,
          permissionHash: readiness.permissionHash,
        },
      };
      snapshot.status = "approved";
      snapshot.activeApproval = {
        approvalId: a.approvalId,
        approvalHash: approval.approvalHash,
      };
      uncertain("approve");
      return structuredClone(approval);
    },
    async activate(a) {
      calls.push("activate");
      snapshot.status = "published";
      snapshot.publication = {
        publicationId: id(13),
        status: "current",
        isCurrent: true,
        approvalId: a.approvalId,
        approvalHash: a.approvalHash,
        approvedBy: approval.approvedBy,
        executedBy: id(n),
        idempotencyKey: a.idempotencyKey,
        credentialFingerprint: a.credentialFingerprint,
        verificationId: a.verificationId,
        previousPublicationId: null,
        rollbackOfPublicationId: null,
      };
      snapshot.activeApproval = null;
      approval.status = "consumed";
      uncertain("activate");
      return structuredClone(snapshot.publication);
    },
  });
  const probeFor = (n) => ({
    actorId: id(n),
    async probePage() {
      calls.push("probe");
      return {
        ...structuredClone(context),
        actorId: id(n),
        permissionHash: n === 2 ? context.permissionHash : h(8),
        artifacts: [],
        nextArtifactCursor: null,
      };
    },
  });
  function uncertain(k) {
    if (lost.delete(k))
      throw Object.assign(new Error("lost ACK"), {
        code: "final_publication_outcome_unknown",
      });
  }
  const actor = actorFor(2),
    probeActor = probeFor(2),
    record = async (e) => events.push(e);
  const options = {
    local,
    readiness,
    actor,
    probeActor,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    reason: "synthetic approval",
    approvalId: id(14),
  };
  return {
    local,
    plan,
    readiness,
    context,
    snapshot,
    actor,
    probeActor,
    actorFor,
    probeFor,
    record,
    calls,
    events,
    lost,
    options,
    getApproval: () => approval,
  };
}
async function approved(f) {
  const built = await buildFinalResultApprovalIntent(f.options);
  const args = {
    local: f.local,
    intent: built.intent,
    confirmIntentHash: built.intentHash,
    actor: f.actor,
    probeActor: f.probeActor,
    record: f.record,
  };
  const receipt = await approveFinalResultPublication(args);
  return { built, args, receipt };
}
test("approval intent binds approver, exact run/plan/context and replacement without requiring plan creator identity", async () => {
  const f = fixture(),
    built = await buildFinalResultApprovalIntent(f.options);
  assert.notEqual(f.local.actorId, built.intent.actorId);
  assert.equal(built.intent.actorId, f.actor.actorId);
  assert.equal(built.intent.expectedApprovalId, null);
  assert.equal(built.intentHash, hashJson(built.intent));
  assert.deepEqual(f.calls, ["run", "probe"]);
  for (const patch of [
    { extra: 1 },
    { actorId: id(99) },
    { localPlanHash: h(9) },
  ])
    assert.throws(() =>
      validateFinalResultApprovalIntent({ ...built.intent, ...patch }, f.local),
    );
});
test("approval is confirmed, persisted, written once and independently observed after a lost ACK", async () => {
  const f = fixture(),
    built = await buildFinalResultApprovalIntent(f.options);
  f.calls.length = 0;
  f.lost.add("approve");
  const record = async (e) => {
    if (e.kind === "approval-execution-intent") assert.deepEqual(f.calls, []);
    await f.record(e);
  };
  const r = await approveFinalResultPublication({
    local: f.local,
    intent: built.intent,
    confirmIntentHash: built.intentHash,
    actor: f.actor,
    probeActor: f.probeActor,
    record,
  });
  assert.equal(r.approval.status, "approved");
  assert.deepEqual(f.calls, [
    "approval",
    "run",
    "probe",
    "approve",
    "approval",
  ]);
  assert.equal(f.events.at(-1).kind, "approval-observation");
});
test("confirmation and actor target changes cannot send an approval or write evidence", async () => {
  for (const mode of ["hash", "target", "actor"]) {
    const f = fixture(),
      built = await buildFinalResultApprovalIntent(f.options);
    f.calls.length = 0;
    if (mode === "target") f.actor.apiTargetHash = h(9);
    if (mode === "actor") f.actor.actorId = id(99);
    await assert.rejects(
      approveFinalResultPublication({
        local: f.local,
        intent: built.intent,
        confirmIntentHash: mode === "hash" ? h(9) : built.intentHash,
        actor: f.actor,
        probeActor: f.probeActor,
        record: f.record,
      }),
    );
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.events, []);
  }
});
test("live approval/permission changes invalidate a frozen new approval intent", async () => {
  for (const mode of ["approval", "permission"]) {
    const f = fixture(),
      built = await buildFinalResultApprovalIntent(f.options);
    if (mode === "approval") f.snapshot.activeApproval = { approvalId: id(99) };
    else f.context.permissionHash = h(9);
    await assert.rejects(
      approveFinalResultPublication({
        local: f.local,
        intent: built.intent,
        confirmIntentHash: built.intentHash,
        actor: f.actor,
        probeActor: f.probeActor,
        record: f.record,
      }),
    );
    assert.ok(!f.calls.includes("approve"));
  }
});
test("uncommitted unknown approval stops after exact lookup without a second write", async () => {
  const f = fixture(),
    built = await buildFinalResultApprovalIntent(f.options);
  f.calls.length = 0;
  f.actor.approve = async () => {
    f.calls.push("approve");
    throw Object.assign(new Error("unknown"), {
      code: "final_publication_outcome_unknown",
    });
  };
  await assert.rejects(
    approveFinalResultPublication({
      local: f.local,
      intent: built.intent,
      confirmIntentHash: built.intentHash,
      actor: f.actor,
      probeActor: f.probeActor,
      record: f.record,
    }),
    { code: "final_publication_outcome_unknown" },
  );
  assert.equal(f.calls.filter((k) => k === "approve").length, 1);
  assert.ok(!f.events.some((e) => e.kind === "approval-observation"));
});
test("existing consumed approval is recovered even after expiry without a new approval", async () => {
  const f = fixture(),
    a = await approved(f);
  f.getApproval().status = "consumed";
  f.calls.length = 0;
  const original = Date.now;
  Date.now = () => original() + 2 * 86400000;
  try {
    const r = await approveFinalResultPublication(a.args);
    assert.equal(r.approval.status, "consumed");
    assert.deepEqual(f.calls, ["approval"]);
  } finally {
    Date.now = original;
  }
});
test("different executor may activate approver evidence; lost ACK recovers original exact publication", async () => {
  const f = fixture(),
    a = await approved(f),
    actor = f.actorFor(3),
    probeActor = f.probeFor(3);
  const built = await buildFinalResultActivationIntent({
    local: f.local,
    readiness: f.readiness,
    approvalId: a.receipt.approval.approvalId,
    actor,
    probeActor,
  });
  assert.equal(built.intent.approvedBy, id(2));
  assert.equal(built.intent.actorId, id(3));
  f.calls.length = 0;
  f.lost.add("activate");
  const r = await activateFinalResultPublication({
    local: f.local,
    intent: built.intent,
    confirmIntentHash: built.intentHash,
    actor,
    probeActor,
    record: f.record,
  });
  assert.equal(r.publicReadbackVerified, false);
  assert.equal(r.publication.isCurrent, true);
  assert.equal(r.publication.executedBy, id(3));
  assert.equal(f.calls.filter((k) => k === "activate").length, 1);
  assert.equal(f.calls.at(-1), "run");
});
test("new activation rejects stale readiness, changed actor and replaced approval", async () => {
  for (const mode of ["actor", "approval", "expiry"]) {
    const f = fixture(),
      a = await approved(f),
      actor = f.actorFor(3),
      probeActor = f.probeFor(3);
    const b = await buildFinalResultActivationIntent({
      local: f.local,
      readiness: f.readiness,
      approvalId: a.receipt.approval.approvalId,
      actor,
      probeActor,
    });
    f.calls.length = 0;
    const original = Date.now;
    if (mode === "actor") actor.actorId = id(99);
    if (mode === "approval")
      f.snapshot.activeApproval = { approvalId: id(99), approvalHash: h(9) };
    if (mode === "expiry") Date.now = () => original() + 700000;
    try {
      await assert.rejects(
        activateFinalResultPublication({
          local: f.local,
          intent: b.intent,
          confirmIntentHash: b.intentHash,
          actor,
          probeActor,
          record: f.record,
        }),
      );
      assert.ok(!f.calls.includes("activate"));
    } finally {
      Date.now = original;
    }
  }
});
test("withdrawn execution remains recoverable after session renewal without resurrection or live probes", async () => {
  const f = fixture(),
    a = await approved(f),
    actor = f.actorFor(3),
    probeActor = f.probeFor(3);
  const b = await buildFinalResultActivationIntent({
    local: f.local,
    readiness: f.readiness,
    approvalId: a.receipt.approval.approvalId,
    actor,
    probeActor,
  });
  const args = {
    local: f.local,
    intent: b.intent,
    confirmIntentHash: b.intentHash,
    actor,
    probeActor,
    record: f.record,
  };
  await activateFinalResultPublication(args);
  f.snapshot.publication.status = "unpublished";
  f.snapshot.publication.isCurrent = false;
  actor.credentialFingerprint = h(9);
  f.calls.length = 0;
  const r = await activateFinalResultPublication(args);
  assert.equal(r.publication.isCurrent, false);
  assert.equal(r.publication.status, "unpublished");
  assert.deepEqual(f.calls, ["run"]);
  assert.equal(r.publicReadbackVerified, false);
});
test("uncommitted unknown activation never blindly retries", async () => {
  const f = fixture(),
    a = await approved(f),
    actor = f.actorFor(3),
    probeActor = f.probeFor(3);
  const b = await buildFinalResultActivationIntent({
    local: f.local,
    readiness: f.readiness,
    approvalId: a.receipt.approval.approvalId,
    actor,
    probeActor,
  });
  actor.activate = async () => {
    f.calls.push("activate");
    throw Object.assign(new Error("unknown"), {
      code: "final_publication_outcome_unknown",
    });
  };
  f.calls.length = 0;
  await assert.rejects(
    activateFinalResultPublication({
      local: f.local,
      intent: b.intent,
      confirmIntentHash: b.intentHash,
      actor,
      probeActor,
      record: f.record,
    }),
    { code: "final_publication_outcome_unknown" },
  );
  assert.equal(f.calls.filter((k) => k === "activate").length, 1);
});
test("activation context and existing publication identity must exactly match confirmed intent", async () => {
  const f = fixture(),
    a = await approved(f),
    actor = f.actorFor(3),
    probeActor = f.probeFor(3);
  const b = await buildFinalResultActivationIntent({
    local: f.local,
    readiness: f.readiness,
    approvalId: a.receipt.approval.approvalId,
    actor,
    probeActor,
  });
  assert.throws(() =>
    validateFinalResultActivationIntent(
      { ...b.intent, approvedBy: id(99) },
      f.local,
    ),
  );
  const args = {
    local: f.local,
    intent: b.intent,
    confirmIntentHash: b.intentHash,
    actor,
    probeActor,
    record: f.record,
  };
  await activateFinalResultPublication(args);
  f.snapshot.publication.verificationId = id(99);
  await assert.rejects(activateFinalResultPublication(args), {
    code: "final_authority_publication_mismatch",
  });
});
test("failed evidence persistence prevents authority mutation", async () => {
  const f = fixture(),
    built = await buildFinalResultApprovalIntent(f.options);
  f.calls.length = 0;
  await assert.rejects(
    approveFinalResultPublication({
      local: f.local,
      intent: built.intent,
      confirmIntentHash: built.intentHash,
      actor: f.actor,
      probeActor: f.probeActor,
      record: async () => {
        throw new Error("disk-full");
      },
    }),
    /disk-full/,
  );
  assert.deepEqual(f.calls, []);
});

test("same actor can execute a confirmed intent after user login renewal while origin fingerprint remains immutable", async () => {
  const f = fixture(),
    a = await approved(f),
    actor = f.actorFor(3),
    probeActor = f.probeFor(3);
  const b = await buildFinalResultActivationIntent({
    local: f.local,
    readiness: f.readiness,
    approvalId: a.receipt.approval.approvalId,
    actor,
    probeActor,
  });
  const original = b.intent.credentialFingerprint;
  actor.credentialFingerprint = h(9);
  const result = await activateFinalResultPublication({
    local: f.local,
    intent: b.intent,
    confirmIntentHash: b.intentHash,
    actor,
    probeActor,
    record: f.record,
  });
  assert.ok(f.calls.includes("activate"));
  assert.ok(f.calls.includes("probe"));
  assert.equal(b.intent.credentialFingerprint, original);
  assert.ok(!JSON.stringify(result).includes("access_token"));
});
