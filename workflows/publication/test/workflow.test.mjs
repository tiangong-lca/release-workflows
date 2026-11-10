import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPublicationApproval } from "../lib/approval.mjs";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { executePublication } from "../lib/execution.mjs";
import { inspectPublicationTarget } from "../lib/inspection.mjs";
import { verifyPublicationReadback } from "../lib/readback.mjs";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION = "01.00.000";
const TOKEN = [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({
      sub: ACTOR,
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString("base64url"),
  "signature",
].join(".");
const ENV = {
  TIANGONG_LCA_API_BASE_URL: "https://project.example.test",
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "publishable",
  TIANGONG_LCA_ACCESS_TOKEN: TOKEN,
};

test("Publication inspects, approves, executes missing/existing rows, and independently reads back", async (t) => {
  const fixture = await createWorkflowFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const remote = createRemote([
    {
      table: "flows",
      id: fixture.datasets[0].uuid,
      version: VERSION,
      state_code: 0,
      user_id: ACTOR,
      json_ordered: fixture.datasets[0].document,
    },
  ]);
  const inspection = await inspectPublicationTarget({
    planDir: fixture.planDir,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "inspection"),
    env: ENV,
    fetchImpl: remote.fetch,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });
  assert.deepEqual(
    inspection.snapshot.rows.map(({ classification }) => classification),
    ["matching_unpublished", "absent"],
  );
  const approval = await createPublicationApproval({
    inspectionDir: inspection.path,
    outDir: path.join(fixture.root, "approval"),
    confirmPlanSha256: inspection.executablePlanSha256,
    approvedBy: "release-manager@example.test",
    expiresAt: "2026-08-25T02:00:00.000Z",
    now: () => new Date("2026-08-25T00:05:00.000Z"),
  });
  const execution = await executePublication({
    approvalDir: approval.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "execution"),
    env: ENV,
    fetchImpl: remote.fetch,
    now: sequenceClock("2026-08-25T00:10:00.000Z"),
  });
  assert.equal(execution.receipt.status, "published");
  assert.equal(execution.receipt.completedKeys.length, 2);
  assert.equal(remote.commandCounts.create, 1);
  assert.equal(remote.commandCounts.publish, 2);
  const readback = await verifyPublicationReadback({
    executionDir: execution.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "readback"),
    env: ENV,
    fetchImpl: remote.fetch,
    now: () => new Date("2026-08-25T00:20:00.000Z"),
  });
  assert.equal(readback.receipt.status, "verified");
  assert.equal(
    readback.receipt.rows.every(({ verified }) => verified),
    true,
  );
});

test("Publication approval requires the exact executable plan hash", async (t) => {
  const fixture = await createWorkflowFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const remote = createRemote([]);
  const inspection = await inspectPublicationTarget({
    planDir: fixture.planDir,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "inspection"),
    env: ENV,
    fetchImpl: remote.fetch,
  });
  await assert.rejects(
    createPublicationApproval({
      inspectionDir: inspection.path,
      outDir: path.join(fixture.root, "approval"),
      confirmPlanSha256: "0".repeat(64),
      approvedBy: "manager",
    }),
    ({ code }) => code === "publication_approval_confirmation_mismatch",
  );
});

test("Publication rejects a Supabase secret key before remote inspection", async (t) => {
  const fixture = await createWorkflowFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const remote = createRemote([]);
  await assert.rejects(
    inspectPublicationTarget({
      planDir: fixture.planDir,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "inspection"),
      env: {
        ...ENV,
        TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "sb_secret_forbidden",
      },
      fetchImpl: remote.fetch,
    }),
    ({ code }) => code === "publication_secret_key_forbidden",
  );
});

test("Publication fails before mutation when approved target state drifts", async (t) => {
  const fixture = await createWorkflowFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const remote = createRemote([]);
  const inspection = await inspectPublicationTarget({
    planDir: fixture.planDir,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "inspection"),
    env: ENV,
    fetchImpl: remote.fetch,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });
  const approval = await createPublicationApproval({
    inspectionDir: inspection.path,
    outDir: path.join(fixture.root, "approval"),
    confirmPlanSha256: inspection.executablePlanSha256,
    approvedBy: "manager",
    expiresAt: "2026-08-25T02:00:00.000Z",
    now: () => new Date("2026-08-25T00:01:00.000Z"),
  });
  remote.insert({
    table: "flows",
    id: fixture.datasets[0].uuid,
    version: VERSION,
    state_code: 0,
    user_id: ACTOR,
    json_ordered: { changed: true },
  });
  await assert.rejects(
    executePublication({
      approvalDir: approval.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "execution"),
      env: ENV,
      fetchImpl: remote.fetch,
      now: () => new Date("2026-08-25T00:02:00.000Z"),
    }),
    ({ code }) => code === "publication_target_snapshot_drift",
  );
  assert.equal(remote.commandCounts.create, 0);
  assert.equal(remote.commandCounts.publish, 0);
});

test("Publication resumes after a partial remote failure without recreating completed rows", async (t) => {
  const fixture = await createWorkflowFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const remote = createRemote([]);
  const inspection = await inspectPublicationTarget({
    planDir: fixture.planDir,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "inspection"),
    env: ENV,
    fetchImpl: remote.fetch,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });
  const approval = await createPublicationApproval({
    inspectionDir: inspection.path,
    outDir: path.join(fixture.root, "approval"),
    confirmPlanSha256: inspection.executablePlanSha256,
    approvedBy: "manager",
    expiresAt: "2026-08-25T02:00:00.000Z",
    now: () => new Date("2026-08-25T00:01:00.000Z"),
  });
  remote.failNextPublishFor(fixture.datasets[1].key);
  const executionDir = path.join(fixture.root, "execution");
  await assert.rejects(
    executePublication({
      approvalDir: approval.path,
      payloadDir: fixture.payloadDir,
      outDir: executionDir,
      env: ENV,
      fetchImpl: remote.fetch,
      now: sequenceClock("2026-08-25T00:02:00.000Z"),
    }),
    ({ code, details }) => {
      assert.equal(code, "injected_publish_failure");
      assert.equal(details.resumeSafe, true);
      assert.deepEqual(details.completedKeys, [fixture.datasets[0].key]);
      return true;
    },
  );
  assert.equal(remote.commandCounts.create, 2);
  const resumed = await executePublication({
    approvalDir: approval.path,
    payloadDir: fixture.payloadDir,
    outDir: executionDir,
    env: ENV,
    fetchImpl: remote.fetch,
    now: sequenceClock("2026-08-25T00:03:00.000Z"),
  });
  assert.equal(resumed.receipt.status, "published");
  assert.equal(remote.commandCounts.create, 2);
  assert.deepEqual(
    resumed.receipt.completedKeys,
    fixture.datasets.map(({ key }) => key),
  );
});

async function createWorkflowFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-workflow-"));
  const planDir = path.join(root, "plan");
  const payloadDir = path.join(root, "payload");
  await mkdir(planDir, { recursive: true });
  await mkdir(path.join(payloadDir, "datasets", "flows"), { recursive: true });
  await mkdir(path.join(payloadDir, "datasets", "sources"), {
    recursive: true,
  });
  const draftPlan = {
    schemaVersion: "tiangong.release.publication-draft-plan.v1",
    status: "prepared_unapproved",
    publicationAuthorized: false,
    target: { id: "tiangong-lca-platform" },
  };
  await writeFile(
    path.join(planDir, "publication-draft-plan.json"),
    canonicalJson(draftPlan),
  );
  const datasets = [
    payloadDataset("flow", "flows", "11111111-1111-4111-8111-111111111111", {
      flowDataSet: { id: "flow" },
    }),
    payloadDataset(
      "source",
      "sources",
      "22222222-2222-4222-8222-222222222222",
      { sourceDataSet: { id: "source" } },
    ),
  ];
  for (const dataset of datasets)
    await writeFile(
      path.join(payloadDir, dataset.payloadPath),
      canonicalJson(dataset.document),
    );
  const entries = datasets.map(({ document: _document, ...entry }) => entry);
  const manifest = {
    schemaVersion: "tiangong.release.publication-payload-manifest.v1",
    candidate: {
      releaseCandidateSha256: "a".repeat(64),
      packageSetHash: "b".repeat(64),
    },
    publicationDraftPlanSha256: hashJson(draftPlan),
    scopeResolutionSha256: "c".repeat(64),
    datasetCount: entries.length,
    datasetSetHash: hashJson(
      entries.map(({ key, sha256, canonicalContentHash }) => ({
        key,
        sha256,
        canonicalContentHash,
      })),
    ),
    datasets: entries,
  };
  await writeFile(
    path.join(payloadDir, "publication-payload-manifest.json"),
    canonicalJson(manifest),
  );
  return { root, planDir, payloadDir, datasets };
}

function payloadDataset(datasetType, table, uuid, document) {
  const bytes = Buffer.from(canonicalJson(document));
  return {
    key: `${datasetType}:${uuid}@${VERSION}`,
    datasetType,
    table,
    role: "support",
    uuid,
    version: VERSION,
    path: `${table}/${uuid}_${VERSION}.json`,
    payloadPath: `datasets/${table}/${uuid}_${VERSION}.json`,
    sha256: sha256Bytes(bytes),
    canonicalContentHash: hashJson(document),
    references: [],
    components: ["unit_process"],
    sourcePackage: { path: "packages/unit.tidas.zip", sha256: "d".repeat(64) },
    modelId: null,
    document,
  };
}

function createRemote(initialRows) {
  const rows = new Map();
  const commandCounts = { create: 0, publish: 0, bundle: 0 };
  const publishFailures = new Set();
  const insert = (row) =>
    rows.set(`${row.table}:${row.id}@${row.version}`, structuredClone(row));
  for (const row of initialRows) insert(row);
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/rest/v1/")) {
      const table = parsed.pathname.split("/").at(-1);
      const id = parsed.searchParams.get("id").replace(/^eq\./u, "");
      const version = parsed.searchParams.get("version").replace(/^eq\./u, "");
      const row = rows.get(`${table}:${id}@${version}`);
      return jsonResponse(row ? [row] : []);
    }
    const body = JSON.parse(options.body);
    if (parsed.pathname.endsWith("/app_dataset_create")) {
      commandCounts.create += 1;
      const version = extractVersion(body.jsonOrdered) ?? VERSION;
      insert({
        table: body.table,
        id: body.id,
        version,
        state_code: 0,
        user_id: ACTOR,
        json_ordered: body.jsonOrdered,
      });
      return jsonResponse({ ok: true, command: "dataset_create" });
    }
    if (parsed.pathname.endsWith("/save_lifecycle_model_bundle")) {
      commandCounts.bundle += 1;
      insert({
        table: "lifecyclemodels",
        id: body.modelId,
        version: extractVersion(body.parent.jsonOrdered) ?? VERSION,
        state_code: 0,
        user_id: ACTOR,
        json_ordered: body.parent.jsonOrdered,
      });
      return jsonResponse({ ok: true });
    }
    if (parsed.pathname.endsWith("/app_dataset_publish")) {
      commandCounts.publish += 1;
      const key = `${body.table}:${body.id}@${body.version}`;
      const matchingFailure = [...publishFailures].find((candidateKey) =>
        candidateKey.endsWith(`:${body.id}@${body.version}`),
      );
      if (matchingFailure) {
        publishFailures.delete(matchingFailure);
        return jsonResponse(
          {
            ok: false,
            code: "INJECTED_PUBLISH_FAILURE",
            message: "Injected publish failure",
          },
          503,
        );
      }
      const row = rows.get(key);
      if (!row)
        return jsonResponse({ ok: false, code: "DATASET_NOT_FOUND" }, 404);
      row.state_code = 100;
      return jsonResponse({ ok: true, command: "dataset_publish" });
    }
    return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404);
  };
  return {
    rows,
    insert,
    fetch,
    commandCounts,
    failNextPublishFor: (key) => publishFailures.add(key),
  };
}

function extractVersion() {
  return VERSION;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sequenceClock(start) {
  let value = new Date(start).getTime();
  return () => {
    const result = new Date(value);
    value += 1000;
    return result;
  };
}
