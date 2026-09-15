import path from "node:path";
import { fail, hashJson } from "./common.mjs";
import {
  assertExactObject,
  readJson,
  verifyJsonHash,
  writeCanonical,
  writeImmutableDirectory,
} from "./io.mjs";
import { loadVerifiedPayload } from "./payload.mjs";
import { inspectDataset, resolvePublicationRuntime } from "./remote.mjs";
import {
  buildPublicationOperations,
  isResultProcessRole,
  ORDINARY_TARGET_STATE,
  stateMapping,
  targetStateCodeForRole,
} from "./publication-state.mjs";

export async function inspectPublicationTarget({
  planDir,
  payloadDir,
  outDir,
  publishedStateCode = ORDINARY_TARGET_STATE,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  if (!Number.isInteger(publishedStateCode) || publishedStateCode < 0)
    fail(
      "publication_state_mapping_invalid",
      "Published state code must be a non-negative integer",
    );
  if (publishedStateCode !== ORDINARY_TARGET_STATE)
    fail(
      "publication_state_mapping_out_of_scope",
      "Publication derives each operation state from its dataset role; a global published state code cannot be overridden",
      {
        requested: publishedStateCode,
        ordinaryStateCode: ORDINARY_TARGET_STATE,
      },
    );
  const planningRoot = path.resolve(planDir);
  const { value: draftPlan } = await readJson(
    path.join(planningRoot, "publication-draft-plan.json"),
    "publication_draft_plan_missing",
  );
  if (draftPlan.schemaVersion !== "tiangong.release.publication-draft-plan.v1")
    fail(
      "publication_draft_plan_unsupported",
      "Target inspection requires a Publication Draft Plan",
    );
  const payload = await loadVerifiedPayload(payloadDir);
  verifyJsonHash(
    draftPlan,
    payload.manifest.publicationDraftPlanSha256,
    "publication_payload_plan_binding_mismatch",
    "Publication Draft Plan",
  );
  const runtime = await resolvePublicationRuntime({ env, fetchImpl });
  if (!runtime.actorUserId)
    fail(
      "publication_actor_identity_unavailable",
      "Actor JWT must contain a subject identifier for Publication inspection",
    );

  const rows = [];
  const blockers = [];
  const observationByKey = new Map();
  for (const dataset of payload.datasets) {
    const row = await inspectDataset({ runtime, dataset, fetchImpl });
    const observed = classifyRow({
      dataset,
      row,
      actorUserId: runtime.actorUserId,
      publishedStateCode: targetStateCodeForRole(dataset.role),
    });
    rows.push(observed);
    observationByKey.set(dataset.key, observed);
    if (observed.blocker)
      blockers.push({ key: dataset.key, ...observed.blocker });
  }
  if (blockers.length)
    fail(
      "publication_target_inspection_blocked",
      "Target inspection found content, ownership, or state conflicts",
      { blockers },
    );
  const operations = buildPublicationOperations({
    datasets: payload.datasets,
    observationByKey,
  });
  const fingerprintRows = rows.map(
    ({
      key,
      table,
      uuid,
      version,
      classification,
      stateCode,
      observedContentHash,
    }) => ({
      key,
      table,
      uuid,
      version,
      classification,
      stateCode,
      observedContentHash,
    }),
  );
  const operationFingerprintRows = operations.map(
    ({ key, role, targetStateCode, action, observedStateCode }) => ({
      key,
      role,
      targetStateCode,
      action,
      observedStateCode,
    }),
  );
  const snapshot = {
    schemaVersion: "tiangong.release.publication-target-snapshot.v2",
    targetId: draftPlan.target.id,
    targetEndpointFingerprint: runtime.targetEndpointFingerprint,
    actorUserId: runtime.actorUserId,
    observedAt: now().toISOString(),
    stateMapping: stateMapping(),
    datasetCount: rows.length,
    resultProcessDatasetCount: operations.filter((op) =>
      isResultProcessRole(op.role),
    ).length,
    ordinaryDatasetCount: operations.filter(
      (op) => !isResultProcessRole(op.role),
    ).length,
    rows,
    fingerprint: hashJson(fingerprintRows),
  };
  const executablePlan = {
    schemaVersion: "tiangong.release.publication-executable-plan.v2",
    status: "ready_for_approval",
    publicationAuthorized: false,
    resultPublicationAuthorized: false,
    targetId: draftPlan.target.id,
    contractVersion: 2,
    publicationDraftPlanSha256: hashJson(draftPlan),
    payloadManifestSha256: payload.manifestSha256,
    targetSnapshotSha256: hashJson(snapshot),
    targetFingerprint: snapshot.fingerprint,
    stateMapping: snapshot.stateMapping,
    operationCount: operations.length,
    resultProcessOperationCount: snapshot.resultProcessDatasetCount,
    operationFingerprint: hashJson(operationFingerprintRows),
    operations,
  };
  const target = path.resolve(outDir);
  await writeImmutableDirectory(target, async (staging) => {
    await writeCanonical(
      path.join(staging, "publication-draft-plan.json"),
      draftPlan,
    );
    await writeCanonical(
      path.join(staging, "publication-payload-manifest.json"),
      payload.manifest,
    );
    await writeCanonical(
      path.join(staging, "publication-target-snapshot.json"),
      snapshot,
    );
    await writeCanonical(
      path.join(staging, "publication-executable-plan.json"),
      executablePlan,
    );
  });
  return {
    path: target,
    snapshot,
    executablePlan,
    executablePlanSha256: hashJson(executablePlan),
  };
}

export function classifyRow({ dataset, row, actorUserId, publishedStateCode }) {
  const base = {
    key: dataset.key,
    table: dataset.table,
    uuid: dataset.uuid,
    version: dataset.version,
    expectedCanonicalContentHash: dataset.canonicalContentHash,
  };
  if (!row)
    return {
      ...base,
      classification: "absent",
      stateCode: null,
      ownerUserId: null,
      observedContentHash: null,
      blocker: null,
    };
  const observedContentHash = hashJson(row.json_ordered);
  const stateCode = Number.isInteger(row.state_code) ? row.state_code : null;
  if (observedContentHash !== dataset.canonicalContentHash)
    return {
      ...base,
      classification: "content_conflict",
      stateCode,
      ownerUserId: row.user_id ?? null,
      observedContentHash,
      blocker: {
        code: "content_conflict",
        expected: dataset.canonicalContentHash,
        observed: observedContentHash,
      },
    };
  if (stateCode === publishedStateCode)
    return {
      ...base,
      classification: "matching_published",
      stateCode,
      ownerUserId: row.user_id ?? null,
      observedContentHash,
      blocker: null,
    };
  if (row.user_id !== actorUserId)
    return {
      ...base,
      classification: "matching_not_publishable",
      stateCode,
      ownerUserId: row.user_id ?? null,
      observedContentHash,
      blocker: { code: "dataset_owner_required" },
    };
  if (stateCode !== null && stateCode >= 20)
    return {
      ...base,
      classification: "matching_not_publishable",
      stateCode,
      ownerUserId: row.user_id ?? null,
      observedContentHash,
      blocker: { code: "dataset_state_not_directly_publishable", stateCode },
    };
  return {
    ...base,
    classification: "matching_unpublished",
    stateCode,
    ownerUserId: row.user_id ?? null,
    observedContentHash,
    blocker: null,
  };
}
