import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import {
  finalResultSelection,
  validateFinalResultPublicationPlan,
  prepareFinalResultPublication,
} from "../lib/final-result-publication-plan.mjs";
const id = (n) => `87950000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  hash = "a".repeat(64);
function fixture(n = 2) {
  const selected = finalResultSelection(
    Array.from({ length: n }, (_, i) => ({
      uuid: id(i + 100),
      version: "01.00.000",
    })),
  );
  const plan = {
    schemaVersion: "tiangong.final-result-publish-plan.v2",
    releaseRunId: id(2),
    releaseVersion: "2026.11.1",
    candidateSha256: hash,
    targetHash: hash,
    selectionHash: selected.selectionHash,
    selectionCount: n,
    expectedCurrentPublicationId: null,
    rollbackOfPublicationId: null,
    reason: "synthetic",
  };
  const planText = canonicalJson(plan),
    local = {
      schemaVersion: "tiangong.final-result-publication-local-plan.v1",
      actorId: id(1),
      apiTargetHash: hash,
      candidateDir: path.resolve("synthetic-candidate"),
      planText,
      publishPlanHash: sha256Bytes(Buffer.from(planText)),
      members: selected.members,
      publicationAuthorized: false,
    };
  let snapshot = null;
  const seen = new Set(),
    calls = [],
    events = [],
    lost = new Set();
  const actor = {
    actorId: id(1),
    apiTargetHash: hash,
    async run() {
      calls.push("run");
      return structuredClone(snapshot);
    },
    async prepare() {
      calls.push("prepare");
      snapshot = {
        releaseRunId: id(2),
        releaseVersion: plan.releaseVersion,
        publishPlanHash: local.publishPlanHash,
        candidateHash: hash,
        targetHash: hash,
        selectionHash: plan.selectionHash,
        selectionCount: n,
        registeredResultCount: 0,
        selectionSealed: false,
        expectedCurrentPublicationId: null,
        rollbackOfPublicationId: null,
        status: "prepared",
        publicationAuthorized: false,
      };
      uncertain("prepare");
    },
    async members({ rows }) {
      calls.push("members");
      for (const r of rows) seen.add(`${r.uuid}@${r.version}`);
      snapshot.registeredResultCount = seen.size;
      uncertain("members");
    },
    async seal() {
      calls.push("seal");
      snapshot.selectionSealed = true;
      uncertain("seal");
    },
  };
  function uncertain(method) {
    if (lost.delete(method))
      throw Object.assign(new Error("lost"), {
        code: "final_publication_outcome_unknown",
      });
  }
  return {
    local,
    plan,
    actor,
    calls,
    events,
    lost,
    options: {
      local,
      confirmLocalPlanHash: hashJson(local),
      actor,
      record: async (e) => events.push(e),
    },
    snapshot: () => snapshot,
  };
}
test("selection uses ASCII identity ordering and Database 500-row block hash", () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({
    uuid: id(i + 1),
    version: "01.00.000",
  }));
  const selected = finalResultSelection([...rows].reverse());
  assert.deepEqual(selected.members, rows);
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  assert.equal(
    selected.selectionHash,
    sha(
      `tiangong.final-result-selection.v1\n${sha(
        rows
          .slice(0, 500)
          .map((r) => `${r.uuid}@${r.version}\n`)
          .join(""),
      )}\n${sha(`${id(501)}@01.00.000\n`)}\n`,
    ),
  );
  assert.throws(() => finalResultSelection([rows[0], rows[0]]));
  assert.throws(() => finalResultSelection([]));
  assert.throws(() => finalResultSelection([{ ...rows[0], extra: true }]));
});
test("local plan binds canonical raw plan bytes, actor target, exact ordered members and excludes unknown fields", () => {
  const f = fixture();
  assert.equal(
    validateFinalResultPublicationPlan(f.local).localPlanHash,
    hashJson(f.local),
  );
  for (const patch of [
    { extra: true },
    { members: [...f.local.members].reverse() },
    { publishPlanHash: "b".repeat(64) },
    { planText: JSON.stringify(f.plan) },
    { publicationAuthorized: true },
    { members: [{ uuid: id(999), version: "01.00.000" }] },
  ])
    assert.throws(
      () => validateFinalResultPublicationPlan({ ...f.local, ...patch }),
      { code: "final_publication_plan_invalid" },
    );
});
test("plan confirmation and actor/target drift fail before reads or records", async () => {
  for (const mode of ["confirm", "actor", "target"]) {
    const f = fixture();
    if (mode === "confirm") f.options.confirmLocalPlanHash = hash;
    else
      f.actor[mode === "actor" ? "actorId" : "apiTargetHash"] =
        mode === "actor" ? id(9) : "b".repeat(64);
    await assert.rejects(prepareFinalResultPublication(f.options));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.events, []);
  }
});
test("prepare records intent before writes, batches 500 and seals exact selection with independent readback", async () => {
  const f = fixture(501);
  f.options.record = async (e) => {
    f.events.push(e);
    if (e.kind === "prepare-intent") assert.deepEqual(f.calls, []);
    if (e.kind === "member-batch")
      assert.equal(
        f.calls.filter((c) => c === "members").length,
        e.offset === 0 ? 0 : 1,
      );
  };
  const r = await prepareFinalResultPublication(f.options);
  assert.equal(r.selectionCount, 501);
  assert.equal(r.publicationAuthorized, false);
  assert.equal(f.snapshot().status, "prepared");
  assert.deepEqual(f.calls, [
    "run",
    "prepare",
    "run",
    "members",
    "members",
    "seal",
    "run",
  ]);
  assert.equal(f.events.at(-1).kind, "selection-receipt");
});
test("lost responses reconcile committed prepare/seal and retry only the identical membership batch", async () => {
  const f = fixture();
  for (const k of ["prepare", "members", "seal"]) f.lost.add(k);
  await prepareFinalResultPublication(f.options);
  assert.deepEqual(f.calls, [
    "run",
    "prepare",
    "run",
    "members",
    "run",
    "members",
    "seal",
    "run",
  ]);
  f.calls.length = 0;
  f.snapshot().status = "published";
  const r = await prepareFinalResultPublication(f.options);
  assert.equal(r.status, "published");
  assert.equal(r.publicationAuthorized, false);
  assert.deepEqual(f.calls, ["run"]);
});
test("unknown prepare without committed identity stops without blindly retrying", async () => {
  const f = fixture();
  f.actor.prepare = async () => {
    f.calls.push("prepare");
    throw Object.assign(new Error("lost"), {
      code: "final_publication_outcome_unknown",
    });
  };
  await assert.rejects(prepareFinalResultPublication(f.options), {
    code: "final_publication_outcome_unknown",
  });
  assert.deepEqual(f.calls, ["run", "prepare", "run"]);
  assert.ok(!f.events.some((e) => e.kind === "selection-receipt"));
});
test("mismatching remote run or missing seal fails without success evidence", async () => {
  for (const mode of ["hash", "seal"]) {
    const f = fixture();
    if (mode === "hash")
      f.actor.run = async () => ({
        ...f.plan,
        releaseRunId: id(2),
        publishPlanHash: "b".repeat(64),
      });
    else f.actor.seal = async () => {};
    await assert.rejects(prepareFinalResultPublication(f.options));
    assert.ok(!f.events.some((e) => e.kind === "selection-receipt"));
  }
});
test("record failure stops before mutation and callback mutation cannot alter outgoing selection", async () => {
  const f = fixture();
  await assert.rejects(
    prepareFinalResultPublication({
      ...f.options,
      record: async () => {
        throw new Error("disk");
      },
    }),
    /disk/,
  );
  assert.deepEqual(f.calls, []);
  f.options.record = async (e) => {
    if (e.rows) e.rows[0].uuid = id(999);
  };
  await prepareFinalResultPublication(f.options);
  assert.equal(f.snapshot().registeredResultCount, 2);
  assert.equal(f.local.members[0].uuid, id(100));
});
