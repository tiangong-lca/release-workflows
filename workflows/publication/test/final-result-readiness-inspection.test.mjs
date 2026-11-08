import test from "node:test";
import assert from "node:assert/strict";
import { inspectFinalResultReadiness as inspect } from "../lib/final-result-readiness-inspection.mjs";
const id = "00000000-0000-0000-0000-000000000001",
  second = "00000000-0000-0000-0000-000000000002",
  hash = "a".repeat(64);
function fixture() {
  const result = { uuid: id, version: "01.00.000" };
  const artifact = {
    schemaVersion: "tiangong.query-artifact.v2",
    artifactId: id,
    manifestSha256: hash,
    manifestByteSize: 100,
  };
  const context = {
    releaseRunId: id,
    publishPlanHash: hash,
    candidateHash: hash,
    targetHash: hash,
    selectionHash: hash,
    selectionCount: 2,
    runtimeRevision: id,
    readerSha256: hash,
    actorId: id,
    permissionHash: hash,
    scope: { kind: "readiness", releaseRunId: id, selectionHash: hash },
    publicationAuthorized: false,
  };
  const page = {
    ...context,
    artifacts: [
      {
        artifact,
        selectedResultCount: 2,
        probes: [result, { uuid: second, version: "01.00.000" }],
      },
    ],
    nextArtifactCursor: null,
  };
  const calls = [];
  const args = {
    candidateDir: "/synthetic",
    releaseRunId: id,
    publishPlanHash: hash,
    targetHash: hash,
    registry: {
      describeCandidate: async () => ({
        candidateHash: hash,
        targetHash: hash,
        resultCount: 2,
        readbackReceipt: {},
      }),
    },
    actor: {
      actorId: id,
      probePage: async () => structuredClone(page),
      probe: async () => ({
        ...context,
        artifact,
        result,
        contentHash: hash,
        lciAvailable: true,
        lciaAvailable: true,
      }),
    },
    reader: {
      async query(request, { readerSha256, authorize }) {
        calls.push(request);
        assert.equal(readerSha256, hash);
        await authorize(AbortSignal.timeout(30000));
        return {};
      },
    },
  };
  const deps = {
    inspectStorage: async () => ({
      plan: {
        candidateHash: hash,
        resultCount: 2,
        artifacts: [{ artifact, resultCount: 2 }],
      },
    }),
  };
  return { args, deps, page, context, calls };
}
test("inspection uses read-only registry/actor/reader capabilities and does not claim readiness", async () => {
  const f = fixture(),
    result = await inspect(f.args, f.deps);
  assert.equal(result.selectionCount, 2);
  assert.equal(result.artifactCount, 1);
  assert.equal(result.readerProbeCount, 1);
  assert.equal(result.readinessVerified, false);
  assert.equal(result.publicationAuthorized, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].query.kind, "overview");
  assert.equal(result.verificationId, undefined);
});
test("unregistered Candidate, wrong target/runtime/permission and inconsistent selection stop inspection", async () => {
  for (const mode of [
    "candidate",
    "target",
    "selection",
    "permission",
    "duplicate",
  ]) {
    const f = fixture();
    if (mode === "candidate")
      f.args.registry.describeCandidate = async () => null;
    if (mode === "target") f.page.targetHash = "b".repeat(64);
    if (mode === "selection") f.page.artifacts[0].selectedResultCount = 1;
    if (mode === "duplicate") f.page.artifacts.push(f.page.artifacts[0]);
    if (mode === "permission")
      f.args.actor.probe = async () => ({
        ...f.context,
        permissionHash: "b".repeat(64),
        artifact: f.page.artifacts[0].artifact,
        result: f.page.artifacts[0].probes[0],
        contentHash: hash,
        lciAvailable: true,
        lciaAvailable: true,
      });
    await assert.rejects(inspect(f.args, f.deps), (e) =>
      e.code?.startsWith("final_readiness_"),
    );
  }
});
test("runtime change during inspection is caught by the final independent actor observation", async () => {
  const f = fixture();
  let pages = 0;
  f.args.actor.probePage = async () => ({
    ...structuredClone(f.page),
    ...(++pages > 1 ? { runtimeRevision: second } : {}),
  });
  await assert.rejects(inspect(f.args, f.deps), {
    code: "final_readiness_inspection_mismatch",
  });
});
