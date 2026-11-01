import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fail, canonicalJson, hashJson, sha256Bytes } from "./common.mjs";
import { loadFinalResultCandidate } from "../../release-candidate/lib/final-result-candidate.mjs";
import { safeFile } from "../../release-candidate/lib/final-result-files.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u,
  VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const uuid = (v) => typeof v === "string" && UUID.test(v),
  hash = (v) => typeof v === "string" && HASH.test(v);
const nullableUuid = (v) => v === null || uuid(v),
  key = (r) => `${r.uuid}@${r.version}`;
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function required(value, code = "final_publication_plan_invalid") {
  if (!value)
    fail(
      code,
      "Final Result publication plan or current binding does not match",
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
export function finalResultSelection(members) {
  required(
    Array.isArray(members) && members.length >= 1 && members.length <= 2000000,
  );
  const sorted = members
    .map((r) => {
      exact(r, ["uuid", "version"]);
      required(
        uuid(r.uuid) &&
          typeof r.version === "string" &&
          VERSION.test(r.version),
      );
      return { uuid: r.uuid, version: r.version };
    })
    .sort((a, b) => order(key(a), key(b)));
  const blocks = [];
  let text = "",
    previous;
  for (const [i, r] of sorted.entries()) {
    const current = key(r);
    required(current !== previous);
    previous = current;
    text += `${current}\n`;
    if ((i + 1) % 500 === 0 || i === sorted.length - 1) {
      blocks.push(sha256Bytes(Buffer.from(text)));
      text = "";
    }
  }
  return {
    members: sorted,
    selectionHash: sha256Bytes(
      Buffer.from(`tiangong.final-result-selection.v1\n${blocks.join("\n")}\n`),
    ),
  };
}
export function validateFinalResultPublicationPlan(local) {
  exact(local, [
    "schemaVersion",
    "actorId",
    "apiTargetHash",
    "candidateDir",
    "planText",
    "publishPlanHash",
    "members",
    "publicationAuthorized",
  ]);
  required(
    typeof local.candidateDir === "string" &&
      path.isAbsolute(local.candidateDir),
  );
  required(
    local.schemaVersion === "tiangong.final-result-publication-local-plan.v1" &&
      uuid(local.actorId) &&
      hash(local.apiTargetHash) &&
      local.publicationAuthorized === false &&
      typeof local.planText === "string" &&
      Buffer.byteLength(local.planText) <= 16384 &&
      hash(local.publishPlanHash),
  );
  let plan;
  try {
    plan = JSON.parse(local.planText);
  } catch {
    required(false);
  }
  exact(plan, [
    "schemaVersion",
    "releaseRunId",
    "releaseVersion",
    "candidateSha256",
    "targetHash",
    "selectionHash",
    "selectionCount",
    "expectedCurrentPublicationId",
    "rollbackOfPublicationId",
    "reason",
  ]);
  required(
    plan.schemaVersion === "tiangong.final-result-publish-plan.v2" &&
      uuid(plan.releaseRunId) &&
      typeof plan.releaseVersion === "string" &&
      /^\d{4}\.\d{2}\.\d+$/u.test(plan.releaseVersion) &&
      plan.releaseVersion.length <= 64 &&
      [plan.candidateSha256, plan.targetHash, plan.selectionHash].every(hash) &&
      nullableUuid(plan.expectedCurrentPublicationId) &&
      nullableUuid(plan.rollbackOfPublicationId) &&
      typeof plan.reason === "string" &&
      plan.reason.trim().length > 0 &&
      [...plan.reason].length <= 2000,
  );
  required(
    canonicalJson(plan) === local.planText &&
      sha256Bytes(Buffer.from(local.planText)) === local.publishPlanHash,
  );
  const selection = finalResultSelection(local.members);
  required(
    hashJson(local.members) === hashJson(selection.members) &&
      plan.selectionHash === selection.selectionHash &&
      plan.selectionCount === selection.members.length,
  );
  return { plan, localPlanHash: hashJson(local) };
}
export async function buildFinalResultPublicationPlan({
  candidateDir,
  targetHash,
  actor,
  members = null,
  releaseRunId = randomUUID(),
  releaseVersion,
  rollbackOfPublicationId = null,
  reason,
}) {
  required(
    hash(targetHash) &&
      uuid(releaseRunId) &&
      nullableUuid(rollbackOfPublicationId) &&
      uuid(actor?.actorId) &&
      hash(actor?.apiTargetHash),
  );
  const loaded = await loadFinalResultCandidate(candidateDir);
  const bytes = await readFile(
    await safeFile(loaded.root, "release-candidate.json"),
  );
  required(hashJson(JSON.parse(bytes)) === hashJson(loaded.candidate));
  const available = loaded.queryCatalog.results.map(({ uuid, version }) => ({
    uuid,
    version,
  }));
  const selection = finalResultSelection(members ?? available),
    keys = new Set(available.map(key));
  required(selection.members.every((r) => keys.has(key(r))));
  // Read only after validating the local scope. The target's current publication
  // is a CAS precondition, never a mutable default at activation time.
  const current = await actor.head();
  required(current === null || uuid(current.publicationId));
  const plan = {
    schemaVersion: "tiangong.final-result-publish-plan.v2",
    releaseRunId,
    releaseVersion: releaseVersion ?? loaded.candidate.releaseVersion,
    candidateSha256: sha256Bytes(bytes),
    targetHash,
    selectionHash: selection.selectionHash,
    selectionCount: selection.members.length,
    expectedCurrentPublicationId: current?.publicationId ?? null,
    rollbackOfPublicationId,
    reason,
  };
  const planText = canonicalJson(plan);
  const local = {
    schemaVersion: "tiangong.final-result-publication-local-plan.v1",
    actorId: actor.actorId,
    apiTargetHash: actor.apiTargetHash,
    candidateDir: loaded.root,
    planText,
    publishPlanHash: sha256Bytes(Buffer.from(planText)),
    members: selection.members,
    publicationAuthorized: false,
  };
  const checked = validateFinalResultPublicationPlan(local);
  return { local, ...checked, candidateDir: path.resolve(candidateDir) };
}
function assertSnapshot(snapshot, plan, local) {
  required(
    snapshot &&
      snapshot.releaseRunId === plan.releaseRunId &&
      snapshot.publishPlanHash === local.publishPlanHash &&
      snapshot.releaseVersion === plan.releaseVersion &&
      snapshot.candidateHash === plan.candidateSha256 &&
      snapshot.targetHash === plan.targetHash &&
      snapshot.selectionHash === plan.selectionHash &&
      snapshot.selectionCount === plan.selectionCount &&
      snapshot.expectedCurrentPublicationId ===
        plan.expectedCurrentPublicationId &&
      snapshot.rollbackOfPublicationId === plan.rollbackOfPublicationId &&
      Number.isSafeInteger(snapshot.registeredResultCount) &&
      snapshot.registeredResultCount >= 0 &&
      snapshot.registeredResultCount <= plan.selectionCount &&
      typeof snapshot.selectionSealed === "boolean" &&
      snapshot.publicationAuthorized === false,
    "final_publication_snapshot_mismatch",
  );
}
export async function prepareFinalResultPublication({
  local,
  confirmLocalPlanHash,
  actor,
  record,
}) {
  local = structuredClone(local);
  const persist = async (event) => record(structuredClone(event));
  const { plan, localPlanHash } = validateFinalResultPublicationPlan(local);
  required(
    confirmLocalPlanHash === localPlanHash,
    "final_publication_confirmation_mismatch",
  );
  required(
    actor.actorId === local.actorId &&
      actor.apiTargetHash === local.apiTargetHash,
    "final_publication_actor_target_mismatch",
  );
  required(typeof record === "function");
  const args = {
    releaseRunId: plan.releaseRunId,
    publishPlanHash: local.publishPlanHash,
  };
  await persist({
    kind: "prepare-intent",
    schemaVersion: "tiangong.final-result-prepare-intent.v1",
    localPlanHash,
    ...args,
    actorId: actor.actorId,
    apiTargetHash: actor.apiTargetHash,
    publicationAuthorized: false,
  });
  let snapshot = await actor.run(plan.releaseRunId);
  if (!snapshot) {
    try {
      await actor.prepare({
        planText: local.planText,
        idempotencyKey: `final-result:${plan.releaseRunId}`,
      });
    } catch (e) {
      if (e.code !== "final_publication_outcome_unknown") throw e;
    }
    snapshot = await actor.run(plan.releaseRunId);
    required(snapshot, "final_publication_outcome_unknown");
  }
  assertSnapshot(snapshot, plan, local);
  if (!snapshot.selectionSealed) {
    required(
      snapshot.status === "prepared",
      "final_publication_selection_unavailable",
    );
    for (let i = 0; i < local.members.length; i += 500) {
      const rows = local.members.slice(i, i + 500);
      await persist({ kind: "member-batch", offset: i, ...args, rows });
      try {
        await actor.members({ ...args, rows });
      } catch (e) {
        if (e.code !== "final_publication_outcome_unknown") throw e;
        // Reobserve immutable run before the single exact idempotent retry. Counts
        // alone do not establish which members were written, so replay the same batch.
        assertSnapshot(await actor.run(plan.releaseRunId), plan, local);
        await actor.members({ ...args, rows });
      }
    }
    await persist({ kind: "selection-seal-intent", ...args });
    try {
      await actor.seal(args);
    } catch (e) {
      if (e.code !== "final_publication_outcome_unknown") throw e;
    }
    snapshot = await actor.run(plan.releaseRunId);
    assertSnapshot(snapshot, plan, local);
  }
  required(
    snapshot.selectionSealed &&
      snapshot.registeredResultCount === plan.selectionCount,
    "final_publication_selection_not_sealed",
  );
  const receipt = {
    schemaVersion: "tiangong.final-result-selection-receipt.v1",
    localPlanHash,
    ...args,
    selectionHash: plan.selectionHash,
    selectionCount: plan.selectionCount,
    observedAt: new Date().toISOString(),
    status: snapshot.status,
    publicationAuthorized: false,
  };
  await persist({ kind: "selection-receipt", receipt });
  return receipt;
}
