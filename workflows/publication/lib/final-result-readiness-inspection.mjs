import { inspectFinalResultStorage } from "./final-result-storage.mjs";
import { finalResultReadinessContext } from "./final-result-readiness.mjs";
import { fail, hashJson } from "./common.mjs";

const required = (v) => {
  if (!v)
    fail(
      "final_readiness_inspection_mismatch",
      "Readiness inspection did not match the exact Candidate, selection, target or runtime",
    );
};
const same = (a, b) =>
  a !== undefined && b !== undefined && hashJson(a) === hashJson(b);
const extraProbe = [
  "artifact",
  "result",
  "contentHash",
  "lciAvailable",
  "lciaAvailable",
];

// Read-only preflight: no object-store writer or registry mutation is available.
// An overview proves connectivity/runtime identity, not full numerical readiness.
export async function inspectFinalResultReadiness(
  {
    candidateDir,
    releaseRunId,
    publishPlanHash,
    targetHash,
    registry,
    actor,
    reader,
  },
  { inspectStorage = inspectFinalResultStorage } = {},
) {
  const { plan } = await inspectStorage({ candidateDir, targetHash });
  const registered = await registry.describeCandidate(
    plan.candidateHash,
    targetHash,
  );
  required(
    registered?.candidateHash === plan.candidateHash &&
      registered.targetHash === targetHash &&
      registered.resultCount === plan.resultCount &&
      registered.readbackReceipt,
  );
  const local = new Map(plan.artifacts.map((a) => [a.artifact.artifactId, a]));
  let context = null,
    cursor = null,
    count = 0,
    artifactCount = 0,
    previous = null;
  do {
    const page = await actor.probePage(
      {
        releaseRunId,
        publishPlanHash,
        runtimeRevision: context?.runtimeRevision ?? null,
        afterArtifactId: cursor,
        limit: 100,
      },
      { signal: AbortSignal.timeout(30000) },
    );
    const observed = finalResultReadinessContext(page, [
      "artifacts",
      "nextArtifactCursor",
    ]);
    required(
      observed.releaseRunId === releaseRunId &&
        observed.publishPlanHash === publishPlanHash &&
        observed.candidateHash === plan.candidateHash &&
        observed.targetHash === targetHash &&
        observed.actorId === actor.actorId &&
        observed.selectionCount <= plan.resultCount,
    );
    if (context) required(same(observed, context));
    else context = observed;
    required(
      Array.isArray(page.artifacts) &&
        page.artifacts.length > 0 &&
        page.artifacts.length <= 100,
    );
    for (const item of page.artifacts) {
      const known = local.get(item.artifact?.artifactId);
      required(
        known &&
          same(known.artifact, item.artifact) &&
          (!previous || item.artifact.artifactId > previous) &&
          Number.isSafeInteger(item.selectedResultCount) &&
          item.selectedResultCount > 0 &&
          item.selectedResultCount <= known.resultCount &&
          Array.isArray(item.probes) &&
          item.probes.length === (item.selectedResultCount === 1 ? 1 : 2),
      );
      previous = item.artifact.artifactId;
      artifactCount++;
      count += item.selectedResultCount;
      required(artifactCount <= local.size && count <= context.selectionCount);
      const result = item.probes[0];
      const authorize = async (signal) => {
        const probe = await actor.probe(
          {
            releaseRunId,
            publishPlanHash,
            runtimeRevision: context.runtimeRevision,
            result,
          },
          { signal },
        );
        required(
          same(finalResultReadinessContext(probe, extraProbe), context) &&
            same(probe.artifact, item.artifact) &&
            same(probe.result, result),
        );
      };
      await reader.query(
        {
          schemaVersion: "result.query.request.v2",
          scope: context.scope,
          artifact: item.artifact,
          result,
          query: { kind: "overview" },
        },
        { readerSha256: context.readerSha256, authorize },
      );
      await authorize(AbortSignal.timeout(30000));
    }
    required(
      page.nextArtifactCursor === null || page.nextArtifactCursor === previous,
    );
    cursor = page.nextArtifactCursor;
  } while (cursor !== null);
  required(count === context.selectionCount);
  const finalPage = await actor.probePage(
    {
      releaseRunId,
      publishPlanHash,
      runtimeRevision: context.runtimeRevision,
      limit: 1,
    },
    { signal: AbortSignal.timeout(30000) },
  );
  required(
    same(
      finalResultReadinessContext(finalPage, [
        "artifacts",
        "nextArtifactCursor",
      ]),
      context,
    ),
  );
  return {
    schemaVersion: "tiangong.final-result-readiness-inspection.v1",
    observedAt: new Date().toISOString(),
    releaseRunId,
    publishPlanHash,
    candidateHash: plan.candidateHash,
    targetHash,
    selectionCount: count,
    artifactCount,
    readerProbeCount: artifactCount,
    runtimeRevision: context.runtimeRevision,
    readerSha256: context.readerSha256,
    readinessVerified: false,
    publicationAuthorized: false,
  };
}
