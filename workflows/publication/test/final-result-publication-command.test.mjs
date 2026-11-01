import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { hashJson, canonicalJson, sha256Bytes } from "../lib/common.mjs";
import { finalResultSelection } from "../lib/final-result-publication-plan.mjs";
import { runFinalResultPublicationCommand as run } from "../lib/final-result-publication-command.mjs";
const id = "87970000-0000-4000-8000-000000000001",
  hash = "a".repeat(64);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "publication-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate"),
    planDir = path.join(root, "plan");
  await mkdir(candidate);
  await mkdir(planDir);
  const selection = finalResultSelection([{ uuid: id, version: "01.00.000" }]);
  const plan = {
    schemaVersion: "tiangong.final-result-publish-plan.v2",
    releaseRunId: id,
    releaseVersion: "2026.11.0",
    candidateSha256: hash,
    targetHash: hash,
    selectionHash: selection.selectionHash,
    selectionCount: 1,
    expectedCurrentPublicationId: null,
    rollbackOfPublicationId: null,
    reason: "synthetic",
  };
  const planText = canonicalJson(plan);
  const local = {
    schemaVersion: "tiangong.final-result-publication-local-plan.v1",
    actorId: id,
    apiTargetHash: hash,
    candidateDir: candidate,
    planText,
    publishPlanHash: sha256Bytes(Buffer.from(planText)),
    members: selection.members,
    publicationAuthorized: false,
  };
  await writeFile(
    path.join(planDir, "publication-plan.json"),
    canonicalJson(local),
  );
  const calls = [],
    env = {
      TIANGONG_LCA_API_BASE_URL: "https://example.invalid",
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "synthetic",
      TIANGONG_LCA_ACCESS_TOKEN: "never-print-actor",
    };
  for (const field of [
    "CONN",
    "S3_SECRET_ACCESS_KEY",
    "RESULT_QUERY_SERVICE_SECRET",
    "TIANGONG_LCA_API_KEY",
  ])
    Object.defineProperty(env, field, {
      get() {
        throw new Error("must not read operator or bootstrap credentials");
      },
    });
  const actor = {
    actorId: id,
    apiTargetHash: hash,
    async run() {
      calls.push("run");
      return null;
    },
  };
  const deps = {
    env,
    createActor: () => actor,
    build: async () => ({ local, plan, localPlanHash: hashJson(local) }),
    prepare: async ({ record }) => {
      calls.push("prepare");
      const receipt = {
        releaseRunId: id,
        publishPlanHash: local.publishPlanHash,
        status: "prepared",
        selectionCount: 1,
        publicationAuthorized: false,
      };
      await record({ kind: "prepare-intent" });
      await record({
        kind: "member-batch",
        offset: 0,
        rows: selection.members,
      });
      await record({ kind: "selection-seal-intent" });
      await record({ kind: "selection-receipt", receipt });
      return receipt;
    },
  };
  return {
    root,
    candidate,
    planDir,
    local,
    plan,
    calls,
    actor,
    deps,
    options: {
      "plan-dir": planDir,
      confirm: hashJson(local),
      "out-dir": path.join(root, "prepare"),
    },
  };
}
test("actor-only selection commands never access DB, S3, Worker or bootstrap credentials", async (t) => {
  const f = await fixture(t);
  const planned = await run(
    "plan",
    {
      candidate: f.candidate,
      "target-hash": hash,
      reason: "synthetic",
      "out-dir": path.join(f.root, "new-plan"),
    },
    f.deps,
  );
  assert.equal(planned.localPlanHash, hashJson(f.local));
  assert.equal(planned.publishPlanHash, f.local.publishPlanHash);
  assert.notEqual(planned.localPlanHash, planned.publishPlanHash);
  assert.equal(planned.publicationAuthorized, false);
  assert.ok(planned.nextActions[0].argv.includes(planned.localPlanHash));
  const prepared = await run("prepare", f.options, f.deps);
  assert.equal(prepared.publicationAuthorized, false);
  assert.equal(
    JSON.parse(await readFile(prepared.artifacts.receipt)).releaseRunId,
    id,
  );
  assert.doesNotMatch(JSON.stringify(prepared), /never-print/);
  if (process.platform !== "win32")
    assert.equal((await stat(prepared.artifacts.receipt)).mode & 0o777, 0o600);
  const status = await run(
    "status",
    { "run-id": id, "out-dir": path.join(f.root, "status") },
    f.deps,
  );
  assert.equal(status.outcome, "final_result_release_not_found");
  assert.equal(status.currentPublicationId, null);
});
test("wrong confirmation, actor drift and unknown options cannot reach remote writes", async (t) => {
  for (const mode of ["confirmation", "actor", "unknown"]) {
    const f = await fixture(t);
    if (mode === "confirmation") f.options.confirm = f.local.publishPlanHash;
    if (mode === "actor")
      f.actor.actorId = "87970000-0000-4000-8000-000000000009";
    if (mode === "unknown") f.options["approved-by"] = id;
    await assert.rejects(run("prepare", f.options, f.deps));
    assert.deepEqual(f.calls, []);
    await assert.rejects(stat(f.options["out-dir"]), { code: "ENOENT" });
  }
});
test("prepare evidence cannot mutate frozen plan or Candidate directories", async (t) => {
  const f = await fixture(t);
  for (const dir of [f.candidate, f.planDir])
    await assert.rejects(
      run(
        "prepare",
        { ...f.options, "out-dir": path.join(dir, "evidence") },
        f.deps,
      ),
      { code: "final_storage_output_inside_candidate" },
    );
  assert.deepEqual(f.calls, []);
});
test("uncertain writes retain sanitized failure and exact-run recovery action", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    run("prepare", f.options, {
      ...f.deps,
      prepare: async () => {
        throw Object.assign(new Error("never-print-server-secret"), {
          code: "final_publication_outcome_unknown",
        });
      },
    }),
    (e) => {
      assert.equal(e.code, "final_publication_outcome_unknown");
      assert.ok(e.nextActions[0].argv.includes(id));
      assert.ok(e.nextActions[0].argv.includes("status"));
      assert.doesNotMatch(JSON.stringify(e), /never-print/);
      return true;
    },
  );
  assert.doesNotMatch(
    await readFile(path.join(f.options["out-dir"], "failure.json"), "utf8"),
    /never-print/,
  );
  await assert.rejects(
    stat(path.join(f.options["out-dir"], "selection-receipt.json")),
    { code: "ENOENT" },
  );
});
test("unknown run is explicit and noncurrent history is not represented as current", async (t) => {
  const f = await fixture(t);
  f.actor.run = async () => ({
    releaseRunId: id,
    status: "published",
    selectionSealed: true,
    publication: { publicationId: id, status: "unpublished", isCurrent: false },
  });
  const result = await run(
    "status",
    { "run-id": id, "out-dir": path.join(f.root, "history") },
    f.deps,
  );
  assert.equal(result.currentPublicationId, null);
  const observation = JSON.parse(await readFile(result.artifacts.observation));
  assert.equal(observation.snapshot.publication.status, "unpublished");
  assert.equal(result.publicationAuthorized, false);
});
test("existing attempts and invalid plan bytes are retained without overwrites", async (t) => {
  const f = await fixture(t);
  await mkdir(f.options["out-dir"]);
  await assert.rejects(run("prepare", f.options, f.deps), {
    code: "output_exists",
  });
  f.options["out-dir"] = path.join(f.root, "another");
  await writeFile(path.join(f.planDir, "publication-plan.json"), "invalid");
  await assert.rejects(run("prepare", f.options, f.deps));
  assert.deepEqual(f.calls, []);
});
