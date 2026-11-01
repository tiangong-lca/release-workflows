import { randomUUID } from "node:crypto";
import { inspectFinalResultStorage } from "./final-result-storage.mjs";
import { createFinalResultProbeVerifier } from "./final-result-reader-verification.mjs";
import { fail, hashJson } from "./common.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const CONTEXT = [
  "releaseRunId",
  "publishPlanHash",
  "candidateHash",
  "targetHash",
  "selectionHash",
  "selectionCount",
  "runtimeRevision",
  "readerSha256",
  "actorId",
  "permissionHash",
  "scope",
  "publicationAuthorized",
];
const same = (a, b) => {
  try {
    return a !== undefined && b !== undefined && hashJson(a) === hashJson(b);
  } catch {
    return false;
  }
};
function required(value, code = "final_readiness_binding_invalid") {
  if (!value) fail(code, "Final Result readiness verification failed");
}
const keys = (o, k) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  same(Object.keys(o).sort(), [...k].sort());
const resultKey = (r) => `${r.uuid}@${r.version}`;
function contextOf(value, extra) {
  required(keys(value, [...CONTEXT, ...extra]));
  const context = Object.fromEntries(CONTEXT.map((k) => [k, value[k]]));
  required(
    ["releaseRunId", "runtimeRevision", "actorId"].every((k) =>
      UUID.test(context[k] ?? ""),
    ) &&
      [
        "publishPlanHash",
        "candidateHash",
        "targetHash",
        "selectionHash",
        "readerSha256",
        "permissionHash",
      ].every((k) => HASH.test(context[k] ?? "")) &&
      Number.isSafeInteger(context.selectionCount) &&
      context.selectionCount >= 1 &&
      context.selectionCount <= 2000000 &&
      context.publicationAuthorized === false &&
      same(context.scope, {
        kind: "readiness",
        releaseRunId: context.releaseRunId,
        selectionHash: context.selectionHash,
      }),
  );
  return context;
}
async function authority(action) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => action(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("deadline"));
        }, 30000);
      }),
    ]);
  } catch (error) {
    if (
      typeof error.code === "string" &&
      (error.code.startsWith("final_actor_") ||
        error.code.startsWith("final_readiness_"))
    )
      throw error;
    fail(
      "final_readiness_authority_unavailable",
      "Live actor admission is unavailable",
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
async function exactWrite(write) {
  try {
    return await write();
  } catch (error) {
    if (error.code !== "final_storage_registry_outcome_unknown") throw error;
    // Only one retry of the identical immutable payload; the DB arbitrates its
    // identity. A second unknown outcome stops instead of extending the attempt.
    return write();
  }
}

// No upload/repair, approval or activation. Caller owns a new immutable local
// evidence directory; record() must persist each event before the next mutation.
// Failed attempts restart with a new UUID and fresh observations, never retime or
// replace old evidence. SQL remains authoritative for complete coverage/expiry.
export async function verifyFinalResultReadiness({
  candidateDir,
  inputDir,
  releaseRunId,
  publishPlanHash,
  verificationId = randomUUID(),
  objectStore,
  registry,
  actor,
  reader,
  record,
}) {
  required(
    UUID.test(releaseRunId ?? "") &&
      UUID.test(verificationId ?? "") &&
      HASH.test(publishPlanHash ?? "") &&
      typeof record === "function",
  );
  required(
    objectStore.databaseTargetHash === registry.databaseTargetHash,
    "final_readiness_target_mismatch",
  );
  required(
    typeof actor?.probePage === "function" &&
      typeof actor?.probe === "function" &&
      typeof objectStore?.verifyCandidate === "function" &&
      typeof objectStore?.verifyQuery === "function",
  );
  const persist = (event) => record(structuredClone(event));
  const { plan, planHash } = await inspectFinalResultStorage({
    candidateDir,
    targetHash: objectStore.targetHash,
  });
  const verifier = await createFinalResultProbeVerifier({
    candidateDir,
    inputDir,
    reader,
  });
  const localArtifacts = new Map(
    plan.artifacts.map((a) => [a.artifact.artifactId, a]),
  );
  let context = null,
    cursor = null,
    selectedCount = 0;
  const selected = [];
  do {
    const page = await authority((signal) =>
      actor.probePage(
        {
          releaseRunId,
          publishPlanHash,
          runtimeRevision: context?.runtimeRevision ?? null,
          afterArtifactId: cursor,
          limit: 100,
        },
        { signal },
      ),
    );
    const observed = contextOf(page, ["artifacts", "nextArtifactCursor"]);
    required(
      observed.releaseRunId === releaseRunId &&
        observed.publishPlanHash === publishPlanHash &&
        observed.candidateHash === plan.candidateHash &&
        observed.targetHash === plan.targetHash &&
        observed.actorId === actor.actorId &&
        observed.selectionCount <= plan.resultCount,
    );
    if (context) required(same(context, observed));
    else context = observed;
    required(
      Array.isArray(page.artifacts) &&
        page.artifacts.length >= 1 &&
        page.artifacts.length <= 100,
    );
    for (const item of page.artifacts) {
      required(keys(item, ["artifact", "selectedResultCount", "probes"]));
      const local = localArtifacts.get(item.artifact?.artifactId);
      required(
        local &&
          same(item.artifact, local.artifact) &&
          (!cursor || item.artifact.artifactId > cursor) &&
          (!selected.length ||
            item.artifact.artifactId > selected.at(-1).artifact.artifactId) &&
          Number.isSafeInteger(item.selectedResultCount) &&
          item.selectedResultCount >= 1 &&
          item.selectedResultCount <= local.resultCount,
      );
      required(
        Array.isArray(item.probes) &&
          item.probes.length === (item.selectedResultCount === 1 ? 1 : 2) &&
          item.probes.every(
            (r) =>
              keys(r, ["uuid", "version"]) &&
              UUID.test(r.uuid ?? "") &&
              VERSION.test(r.version ?? ""),
          ) &&
          (item.probes.length === 1 ||
            resultKey(item.probes[0]) < resultKey(item.probes[1])),
      );
      selected.push(structuredClone(item));
      selectedCount += item.selectedResultCount;
      required(
        selected.length <= plan.artifacts.length &&
          selectedCount <= context.selectionCount,
      );
    }
    const next = page.nextArtifactCursor;
    required(
      next === null ||
        (UUID.test(next) &&
          next === selected.at(-1).artifact.artifactId &&
          page.artifacts.length === 100),
    );
    cursor = next;
  } while (cursor !== null);
  required(selectedCount === context.selectionCount);
  const startedAt = new Date().toISOString();
  await persist({
    schemaVersion: "tiangong.final-result-readiness-local-attempt.v1",
    verificationId,
    context,
    storagePlanHash: planHash,
    startedAt,
  });
  const checkFile = (response, file) =>
    required(
      response?.targetHash === plan.targetHash && same(response.file, file),
    );
  for (const file of plan.files)
    checkFile(
      await objectStore.verifyCandidate(plan.candidateHash, file),
      file,
    );
  const candidateFilesVerifiedAt = new Date().toISOString();
  const filesVerifiedAt = new Map();
  // Finish all full GETs before sampling so slow file reads do not consume the
  // fifteen-minute reader window for the first artifact unnecessarily.
  for (const selectedArtifact of selected) {
    const local = localArtifacts.get(selectedArtifact.artifact.artifactId);
    for (const file of local.files)
      checkFile(await objectStore.verifyQuery(local.artifact, file), file);
    filesVerifiedAt.set(local.artifact.artifactId, new Date().toISOString());
  }
  const { scope, publicationAuthorized, ...binding } = context;
  const header = {
    schemaVersion: "tiangong.final-result-readiness-attempt.v1",
    verificationId,
    ...binding,
    startedAt,
    candidateFilesVerifiedAt,
    candidateFiles: plan.files,
  };
  await persist({ kind: "header", header });
  await exactWrite(() => registry.beginReadiness(header));
  let described = await registry.describeReadiness(verificationId);
  required(
    same(described?.header, header) &&
      described.verificationId === verificationId &&
      described.publicationAuthorized === false &&
      described.registeredArtifactCount === 0 &&
      described.readinessReceipt === null,
    "final_readiness_attempt_reused",
  );
  let probeCount = 0,
    fileCount = plan.files.length;
  for (const item of selected) {
    const local = localArtifacts.get(item.artifact.artifactId),
      probes = [];
    for (const result of item.probes) {
      const authorize = (signal) =>
        actor.probe(
          {
            releaseRunId,
            publishPlanHash,
            runtimeRevision: context.runtimeRevision,
            result,
          },
          { signal },
        );
      const probe = await authority(authorize);
      required(
        same(
          contextOf(probe, [
            "artifact",
            "result",
            "contentHash",
            "lciAvailable",
            "lciaAvailable",
          ]),
          context,
        ) &&
          same(probe.artifact, item.artifact) &&
          same(probe.result, result),
      );
      probes.push(await verifier.verify(probe, { authorize }));
    }
    const proof = {
      artifact: item.artifact,
      selectedResultCount: item.selectedResultCount,
      files: local.files,
      filesVerifiedAt: filesVerifiedAt.get(item.artifact.artifactId),
      probes,
    };
    // Database JSONB uses additional spaces. A single <=64 KiB proof remains
    // comfortably under the 1 MiB batch budget; keep one artifact per mutation.
    required(
      Buffer.byteLength(
        JSON.stringify(proof).replaceAll('\":', '\": ').replaceAll(",", ", "),
      ) <= 65536,
      "final_readiness_proof_budget",
    );
    await persist({ kind: "artifact", verificationId, proof });
    await exactWrite(() => registry.stageReadiness(verificationId, [proof]));
    probeCount += probes.length;
    fileCount += local.files.length;
  }
  const finalPage = await authority((signal) =>
    actor.probePage(
      {
        releaseRunId,
        publishPlanHash,
        runtimeRevision: context.runtimeRevision,
        limit: 1,
      },
      { signal },
    ),
  );
  required(
    same(contextOf(finalPage, ["artifacts", "nextArtifactCursor"]), context),
  );
  await exactWrite(() => registry.sealReadiness(verificationId));
  described = await registry.describeReadiness(verificationId);
  const receipt = described?.readinessReceipt;
  required(
    same(described?.header, header) &&
      described.registeredArtifactCount === selected.length &&
      described.publicationAuthorized === false &&
      same(
        contextOf(receipt, [
          "schemaVersion",
          "verificationId",
          "artifactCount",
          "probeCount",
          "fileCount",
          "coverageHash",
          "expiresAt",
          "sealedAt",
        ]),
        context,
      ) &&
      receipt.schemaVersion === "tiangong.final-result-readiness.v1" &&
      receipt.verificationId === verificationId &&
      receipt.artifactCount === selected.length &&
      receipt.probeCount === probeCount &&
      receipt.fileCount === fileCount &&
      HASH.test(receipt.coverageHash ?? "") &&
      Number.isFinite(Date.parse(receipt.sealedAt)) &&
      Date.parse(receipt.expiresAt) > Date.now() &&
      Date.parse(receipt.expiresAt) <= Date.parse(startedAt) + 3600000,
  );
  await persist({ kind: "sealed", receipt });
  return receipt;
}
