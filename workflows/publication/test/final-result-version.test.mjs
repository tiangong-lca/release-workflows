import test from "node:test";
import assert from "node:assert/strict";
import {
  preflightFinalResultVersion,
  validateFinalResultPublicationPlan,
  prepareFinalResultPublication,
  finalResultSelection,
} from "../lib/final-result-publication-plan.mjs";
import { canonicalJson, sha256Bytes, hashJson } from "../lib/common.mjs";
import path from "node:path";
const id = (n) => `96100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = "a".repeat(64);
const occupant = {
  releaseRunId: id(1),
  publishPlanHash: hash,
  format: "final-result-pair.v2",
  status: "prepared",
  candidateHash: hash,
  targetHash: hash,
  replacesReleaseRunId: null,
  replaceable: true,
};

test("version preflight is read-only and distinguishes free, occupied, stale and unreplaceable versions", async () => {
  const state = { releaseVersion: "2026.11.0", occupant: null };
  const calls = [];
  const actor = {
    version: async (v) => {
      calls.push(v);
      return state;
    },
    prepare: () => assert.fail("no business write"),
  };
  assert.equal(
    await preflightFinalResultVersion({
      releaseVersion: state.releaseVersion,
      actor,
    }),
    null,
  );
  state.occupant = structuredClone(occupant);
  await assert.rejects(
    preflightFinalResultVersion({
      releaseVersion: state.releaseVersion,
      actor,
    }),
    (e) =>
      e.code === "final_result_release_version_conflict" &&
      e.details.versionState.occupant.releaseRunId === id(1),
  );
  await assert.rejects(
    preflightFinalResultVersion({
      releaseVersion: state.releaseVersion,
      actor,
      replaceDraftRunId: id(99),
    }),
    { code: "final_result_draft_replacement_conflict" },
  );
  const binding = await preflightFinalResultVersion({
    releaseVersion: state.releaseVersion,
    actor,
    replaceDraftRunId: id(1),
  });
  assert.deepEqual(binding, { releaseRunId: id(1), publishPlanHash: hash });
  state.occupant.publishPlanHash = "b".repeat(64);
  assert.equal(
    binding.publishPlanHash,
    hash,
    "observed predecessor is frozen, not a mutable reference",
  );
  for (const status of [
    "approved",
    "published",
    "unpublished",
    "readback_verified",
  ]) {
    state.occupant.status = status;
    state.occupant.replaceable = false;
    await assert.rejects(
      preflightFinalResultVersion({
        releaseVersion: state.releaseVersion,
        actor,
        replaceDraftRunId: id(1),
      }),
      { code: "final_result_draft_not_replaceable" },
    );
  }
  assert.equal(calls.length, 8);
});

function localPlan() {
  const selection = finalResultSelection([
    { uuid: id(10), version: "01.00.000" },
  ]);
  const planText = canonicalJson({
    schemaVersion: "tiangong.final-result-publish-plan.v2",
    releaseRunId: id(2),
    releaseVersion: "2026.11.0",
    candidateSha256: hash,
    targetHash: hash,
    selectionHash: selection.selectionHash,
    selectionCount: 1,
    expectedCurrentPublicationId: null,
    rollbackOfPublicationId: null,
    reason: "replace synthetic draft",
  });
  return {
    schemaVersion: "tiangong.final-result-publication-local-plan.v2",
    replacement: { releaseRunId: id(1), publishPlanHash: hash },
    actorId: id(3),
    apiTargetHash: hash,
    candidateDir: path.resolve("synthetic-candidate"),
    planText,
    publishPlanHash: sha256Bytes(Buffer.from(planText)),
    members: selection.members,
    publicationAuthorized: false,
  };
}
test("replacement confirmation binds predecessor and immutable new plan; changed predecessor cannot reach reads", async () => {
  const local = localPlan(),
    confirm = hashJson(local);
  assert.equal(
    validateFinalResultPublicationPlan(local).localPlanHash,
    confirm,
  );
  local.replacement.publishPlanHash = "b".repeat(64);
  assert.notEqual(
    validateFinalResultPublicationPlan(local).localPlanHash,
    confirm,
  );
  await assert.rejects(
    prepareFinalResultPublication({
      local,
      confirmLocalPlanHash: confirm,
      actor: {
        actorId: id(3),
        apiTargetHash: hash,
        run: () => assert.fail("no read"),
      },
      record: () => assert.fail("no intent"),
    }),
    { code: "final_publication_confirmation_mismatch" },
  );
});
test("replacement prepare retains exact predecessor on lost ACK and reconciles without ordinary prepare or duplicate replacement", async () => {
  const local = localPlan(),
    plan = JSON.parse(local.planText),
    events = [];
  let snapshot = null,
    writes = 0;
  const actor = {
    actorId: local.actorId,
    apiTargetHash: hash,
    run: async () => structuredClone(snapshot),
    draft: async () => ({
      releaseRunId: plan.releaseRunId,
      publishPlanHash: local.publishPlanHash,
      replacesReleaseRunId: local.replacement.releaseRunId,
      replacesPublishPlanHash: local.replacement.publishPlanHash,
      replacedByReleaseRunId: null,
    }),
    prepare: async (args) => {
      writes++;
      assert.deepEqual(args.replacement, local.replacement);
      snapshot = {
        ...plan,
        publishPlanHash: local.publishPlanHash,
        candidateHash: plan.candidateSha256,
        registeredResultCount: 1,
        selectionSealed: true,
        status: "prepared",
        publicationAuthorized: false,
      };
      throw Object.assign(new Error("lost acknowledgement"), {
        code: "final_publication_outcome_unknown",
      });
    },
  };
  const args = {
    local,
    confirmLocalPlanHash: hashJson(local),
    actor,
    record: async (e) => events.push(e),
  };
  await prepareFinalResultPublication(args);
  await prepareFinalResultPublication(args);
  assert.equal(writes, 1);
  assert.deepEqual(events[0].replacement, local.replacement);
  snapshot.status = "abandoned";
  await assert.rejects(prepareFinalResultPublication(args), {
    code: "final_publication_draft_retired",
  });
});

test("existing new run cannot satisfy a replacement confirmed against different predecessor history", async () => {
  const local = localPlan(),
    plan = JSON.parse(local.planText);
  const actor = {
    actorId: local.actorId,
    apiTargetHash: hash,
    run: async () => ({
      ...plan,
      publishPlanHash: local.publishPlanHash,
      candidateHash: plan.candidateSha256,
      registeredResultCount: 1,
      selectionSealed: true,
      status: "prepared",
      publicationAuthorized: false,
    }),
    draft: async () => ({
      releaseRunId: plan.releaseRunId,
      publishPlanHash: local.publishPlanHash,
      replacesReleaseRunId: id(99),
      replacesPublishPlanHash: hash,
      replacedByReleaseRunId: null,
    }),
    prepare: () => assert.fail("must not replace again"),
    members: () => assert.fail("must not extend wrong history"),
    seal: () => assert.fail("must not seal wrong history"),
  };
  await assert.rejects(
    prepareFinalResultPublication({
      local,
      confirmLocalPlanHash: hashJson(local),
      actor,
      record: async () => {},
    }),
    { code: "final_result_draft_replacement_conflict" },
  );
});
