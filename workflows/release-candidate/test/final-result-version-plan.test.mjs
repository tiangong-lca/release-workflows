import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { planFinalResultVersions } from "../lib/final-result-version-plan.mjs";
import { inspectFinalResultInput } from "../lib/final-result-input.mjs";
import { setup } from "./fixtures/final-input.mjs";
import {
  readResultVersionPlan,
  applyResultVersionPlan,
} from "../../result-materialization/lib/registry-version-plan.mjs";

async function input(t) {
  return inspectFinalResultInput(await setup(t));
}
function authority(rows, failure) {
  const state = { calls: [], closed: false };
  state.createAuthority = () => ({
    async versions(uuid, { limit, beforeVersion }) {
      state.calls.push({ uuid, beforeVersion });
      if (failure) throw failure;
      const page = (rows[uuid] ?? [])
        .filter((r) => beforeVersion === null || r.version < beforeVersion)
        .sort((a, b) => b.version.localeCompare(a.version))
        .slice(0, limit);
      return {
        resultId: uuid,
        versions: page,
        nextBeforeVersion: page.length === limit ? page.at(-1).version : null,
      };
    },
    register() {
      assert.fail("Version planning must never register");
    },
    async close() {
      state.closed = true;
    },
  });
  return state;
}
test("read-only version planning preserves free/same-content identities and allocates above authority", async (t) => {
  const p = await input(t);
  const [a, b, c] = p.content;
  const store = authority({
    [a.result.uuid]: [
      {
        version: a.result.version,
        status: "registered",
        hashDomain: a.hashDomain,
        contentHash: a.contentHash,
      },
    ],
    [b.result.uuid]: [
      { version: "07.03.002", status: "legacy_requires_equivalence" },
      { version: b.result.version, status: "legacy_requires_equivalence" },
    ],
  });
  const plan = await planFinalResultVersions({
    inputPlan: p,
    createAuthority: store.createAuthority,
  });
  const byId = new Map(
    plan.entries.map((e) => [`${e.uuid}@${e.fromVersion}`, e]),
  );
  assert.equal(
    byId.get(`${a.result.uuid}@${a.result.version}`).reason,
    "same_content",
  );
  assert.equal(
    byId.get(`${a.result.uuid}@${a.result.version}`).toVersion,
    a.result.version,
  );
  assert.equal(
    byId.get(`${b.result.uuid}@${b.result.version}`).toVersion,
    "08.00.000",
  );
  assert.equal(
    byId.get(`${c.result.uuid}@${c.result.version}`).reason,
    "unoccupied",
  );
  assert.equal(store.closed, true);
  assert.equal(plan.registrationAuthorized, false);
  const f = await setup(t);
  const file = path.join(f.root, "version-plan.json");
  await writeFile(file, JSON.stringify(plan));
  assert.deepEqual(await readResultVersionPlan(file), plan);
  plan.entries[0].toVersion = "00.00.000";
  await writeFile(file, JSON.stringify(plan));
  await assert.rejects(readResultVersionPlan(file), {
    code: "result_version_plan_invalid",
  });
});
test("old occupied versions beyond the first page are not classified as free", async (t) => {
  const p = await input(t);
  const r = p.content[0];
  const rows = Array.from({ length: 257 }, (_, i) => ({
    version: `02.00.${String(i).padStart(3, "0")}`,
    status: "legacy_requires_equivalence",
  }));
  rows.push({
    version: r.result.version,
    status: "registered",
    hashDomain: r.hashDomain,
    contentHash: "0".repeat(64),
  });
  const store = authority({ [r.result.uuid]: rows });
  const plan = await planFinalResultVersions({
    inputPlan: p,
    createAuthority: store.createAuthority,
  });
  assert.equal(
    plan.entries.find((e) => e.uuid === r.result.uuid).toVersion,
    "03.00.000",
  );
  assert.equal(store.calls.filter((c) => c.uuid === r.result.uuid).length, 2);
});
test("same-lineage conflicts reserve distinct new major versions; unknown outcomes and overflow stop", async (t) => {
  const p = await input(t);
  const first = p.content[0];
  p.content = [
    first,
    { ...first, result: { ...first.result, version: "02.00.000" } },
  ];
  p.lineage.results = [
    p.lineage.results[0],
    { ...p.lineage.results[0], version: "02.00.000" },
  ];
  const rows = {
    [first.result.uuid]: [first.result.version, "02.00.000"].map((version) => ({
      version,
      status: "legacy_requires_equivalence",
    })),
  };
  const plan = await planFinalResultVersions({
    inputPlan: p,
    createAuthority: authority(rows).createAuthority,
  });
  assert.deepEqual(
    plan.entries.map((e) => e.toVersion),
    ["03.00.000", "04.00.000"],
  );
  const drafts = plan.entries.map((e, i) => ({
    axis: { processIndex: i },
    provisional: { uuid: e.uuid },
  }));
  const resolutions = new Map(
    plan.entries.map((e, i) => [i, { version: e.fromVersion }]),
  );
  applyResultVersionPlan(
    plan,
    drafts,
    resolutions,
    () => first.canonicalContentHash,
  );
  assert.deepEqual(
    [...resolutions.values()].map((e) => e.version),
    ["03.00.000", "04.00.000"],
  );
  assert.throws(() => applyResultVersionPlan(plan, [], new Map(), () => ""), {
    code: "result_version_plan_scope_mismatch",
  });
  rows[first.result.uuid].push({
    version: "99.00.000",
    status: "legacy_requires_equivalence",
  });
  await assert.rejects(
    planFinalResultVersions({
      inputPlan: p,
      createAuthority: authority(rows).createAuthority,
    }),
    { code: "dataset_version_overflow" },
  );
  const failed = authority(
    {},
    Object.assign(new Error("unknown"), {
      code: "final_identity_outcome_unknown",
    }),
  );
  await assert.rejects(
    planFinalResultVersions({
      inputPlan: p,
      createAuthority: failed.createAuthority,
    }),
    { code: "final_identity_outcome_unknown" },
  );
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.closed, true);
});
