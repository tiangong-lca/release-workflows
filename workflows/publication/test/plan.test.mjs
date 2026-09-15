import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { materializePublicationPayload } from "../lib/payload.mjs";
import { preparePublicationPlan } from "../lib/plan.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "cli.mjs");
const VERSION = "01.00.000";
const IDS = {
  unitA: "11111111-1111-4111-8111-111111111111",
  unitB: "22222222-2222-4222-8222-222222222222",
  flowA: "33333333-3333-4333-8333-333333333333",
  flowB: "44444444-4444-4444-8444-444444444444",
  result: "55555555-5555-4555-8555-555555555555",
  model: "66666666-6666-4666-8666-666666666666",
};
const key = (datasetType, uuid) => `${datasetType}:${uuid}@${VERSION}`;
const KEYS = {
  unitA: key("process", IDS.unitA),
  unitB: key("process", IDS.unitB),
  flowA: key("flow", IDS.flowA),
  flowB: key("flow", IDS.flowB),
  result: key("process", IDS.result),
  model: key("lifecyclemodel", IDS.model),
};

test("Publication prepares a deterministic full plan without mutating Candidate", async (t) => {
  const fixture = await createCandidateFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const candidateBefore = await readFile(
    path.join(fixture.candidate, "release-candidate.json"),
  );
  const first = await preparePublicationPlan({
    candidateDir: fixture.candidate,
    outDir: path.join(fixture.root, "plan-a"),
    component: "both",
    targetId: "tiangong-lca-platform",
  });
  const second = await preparePublicationPlan({
    candidateDir: fixture.candidate,
    outDir: path.join(fixture.root, "plan-b"),
    component: "both",
    targetId: "tiangong-lca-platform",
  });
  assert.equal(
    first.publicationDraftPlanSha256,
    second.publicationDraftPlanSha256,
  );
  assert.equal(first.resolution.effectiveDatasetCount, 6);
  assert.equal(first.resolution.referenceComplete, true);
  assert.equal(first.plan.publicationAuthorized, false);
  assert.equal(
    first.plan.execution.status,
    "requires_target_inspection_and_approval",
  );
  assert.deepEqual(
    await readFile(path.join(fixture.candidate, "release-candidate.json")),
    candidateBefore,
  );
});

test("Publication exact include expands forward dependencies", async (t) => {
  const fixture = await createCandidateFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await preparePublicationPlan({
    candidateDir: fixture.candidate,
    outDir: path.join(fixture.root, "selected-result"),
    component: "result",
    targetId: "tiangong-lca-platform",
    include: [KEYS.model],
  });
  assert.deepEqual(
    result.resolution.effectiveDatasets.map(({ key: value }) => value),
    [KEYS.flowA, KEYS.model, KEYS.result, KEYS.unitA].sort(),
  );
  assert.equal(result.resolution.dependencyAdditions.length, 3);
});

test("Publication exclusion recursively prunes reverse dependents and keeps an independent branch", async (t) => {
  const fixture = await createCandidateFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await preparePublicationPlan({
    candidateDir: fixture.candidate,
    outDir: path.join(fixture.root, "pruned"),
    component: "both",
    targetId: "tiangong-lca-platform",
    exclude: [KEYS.flowA],
  });
  assert.deepEqual(
    result.resolution.effectiveDatasets.map(({ key: value }) => value),
    [KEYS.flowB, KEYS.unitB].sort(),
  );
  const reasons = new Map(
    result.resolution.prunedDatasets.map(({ key: value, reason }) => [
      value,
      reason,
    ]),
  );
  assert.equal(reasons.get(KEYS.flowA).code, "explicitly_excluded");
  assert.equal(reasons.get(KEYS.unitA).code, "required_dependency_excluded");
  assert.equal(reasons.get(KEYS.result).causedBy, KEYS.unitA);
  assert.equal(reasons.get(KEYS.model).causedBy, KEYS.result);
});

test("Publication fails closed for unknown, mismatched, empty, and drifted scope", async (t) => {
  const fixture = await createCandidateFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    preparePublicationPlan({
      candidateDir: fixture.candidate,
      outDir: path.join(fixture.root, "target-url"),
      component: "both",
      targetId: "https://example.test/secret",
    }),
    ({ code }) => code === "publication_target_invalid",
  );
  await assert.rejects(
    preparePublicationPlan({
      candidateDir: fixture.candidate,
      outDir: path.join(fixture.root, "unknown"),
      component: "both",
      targetId: "target",
      include: [key("process", "77777777-7777-4777-8777-777777777777")],
    }),
    ({ code }) => code === "publication_scope_identity_unknown",
  );
  await assert.rejects(
    preparePublicationPlan({
      candidateDir: fixture.candidate,
      outDir: path.join(fixture.root, "mismatch"),
      component: "unit-process",
      targetId: "target",
      include: [KEYS.model],
    }),
    ({ code }) => code === "publication_scope_component_mismatch",
  );
  await assert.rejects(
    preparePublicationPlan({
      candidateDir: fixture.candidate,
      outDir: path.join(fixture.root, "empty"),
      component: "result",
      targetId: "target",
      include: [KEYS.model],
      exclude: [KEYS.flowA],
    }),
    ({ code }) => code === "publication_scope_empty",
  );
  const candidatePath = path.join(fixture.candidate, "release-candidate.json");
  const originalCandidate = JSON.parse(await readFile(candidatePath, "utf8"));
  const driftedCandidate = {
    ...originalCandidate,
    packageSetHash: "0".repeat(64),
  };
  await writeFile(candidatePath, canonicalJson(driftedCandidate));
  await assert.rejects(
    preparePublicationPlan({
      candidateDir: fixture.candidate,
      outDir: path.join(fixture.root, "package-set-drift"),
      component: "both",
      targetId: "target",
    }),
    ({ code }) => code === "candidate_package_set_hash_mismatch",
  );
  await writeFile(candidatePath, canonicalJson(originalCandidate));

  const catalogPath = path.join(fixture.candidate, "publication-catalog.json");
  const originalCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const driftedCatalog = structuredClone(originalCatalog);
  driftedCatalog.datasets[0].sha256 = "f".repeat(64);
  driftedCatalog.catalogSetHash = hashJson(
    driftedCatalog.datasets.map(({ key: value, sha256, references }) =>
      hashJson({ key: value, sha256, references }),
    ),
  );
  await writeFile(catalogPath, canonicalJson(driftedCatalog));
  await writeFile(
    candidatePath,
    canonicalJson({
      ...originalCandidate,
      publicationCatalog: {
        ...originalCandidate.publicationCatalog,
        sha256: sha256Bytes(Buffer.from(canonicalJson(driftedCatalog))),
      },
    }),
  );
  await assert.rejects(
    preparePublicationPlan({
      candidateDir: fixture.candidate,
      outDir: path.join(fixture.root, "catalog-index-drift"),
      component: "both",
      targetId: "target",
    }),
    ({ code }) => code === "candidate_publication_catalog_index_mismatch",
  );
  await writeFile(catalogPath, canonicalJson(originalCatalog));
  await writeFile(candidatePath, canonicalJson(originalCandidate));

  await writeFile(
    path.join(fixture.candidate, "packages", "unit.tidas.zip"),
    "drift",
  );
  await assert.rejects(
    preparePublicationPlan({
      candidateDir: fixture.candidate,
      outDir: path.join(fixture.root, "drift"),
      component: "both",
      targetId: "target",
    }),
    ({ code }) => code === "candidate_package_hash_mismatch",
  );
});

test("Publication CLI emits bounded JSON and the workflow-local reply template", async (t) => {
  const fixture = await createCandidateFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const output = path.join(fixture.root, "cli-plan");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI,
    "plan",
    "prepare",
    "--candidate",
    fixture.candidate,
    "--component",
    "result",
    "--target",
    "tiangong-lca-platform",
    "--include",
    KEYS.model,
    "--out-dir",
    output,
    "--json",
  ]);
  assert.equal(stderr, "");
  const payload = JSON.parse(stdout);
  assert.equal(payload.outcome, "publication_draft_plan_prepared");
  assert.equal(payload.publicationAuthorized, false);
  assert.equal(payload.replyTemplate.id, "publish-plan-prepared");
  assert.equal(payload.effectiveDatasetCount, 4);
  const template = await readFile(
    path.join(ROOT, "reply-templates", "publish-plan-prepared.md"),
    "utf8",
  );
  assert.match(template, /\{\{artifacts\.scopeResolution\}\}/u);
});

test("Publication materializes only the dependency-safe selected TIDAS payload", async (t) => {
  const fixture = await createCandidateFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const plan = await preparePublicationPlan({
    candidateDir: fixture.candidate,
    outDir: path.join(fixture.root, "payload-plan"),
    component: "result",
    targetId: "tiangong-lca-platform",
    include: [KEYS.model],
  });
  const result = await materializePublicationPayload({
    candidateDir: fixture.candidate,
    planDir: plan.path,
    outDir: path.join(fixture.root, "payload"),
  });
  assert.equal(result.manifest.datasetCount, 4);
  assert.deepEqual(
    result.manifest.datasets.map(({ key: value }) => value),
    [KEYS.flowA, KEYS.model, KEYS.result, KEYS.unitA].sort(),
  );
  assert.equal(
    result.manifest.datasets.find(({ key: value }) => value === KEYS.result)
      .modelId,
    IDS.model,
  );
  await assert.rejects(
    readFile(
      path.join(result.path, "datasets", `flows/${IDS.flowB}_${VERSION}.json`),
    ),
    ({ code }) => code === "ENOENT",
  );
});

test("Publication CLI failures remain local and map to the failure template", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      CLI,
      "plan",
      "prepare",
      "--component",
      "both",
      "--json",
    ]),
    (error) => {
      const payload = JSON.parse(error.stderr);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, "invalid_arguments");
      assert.equal(payload.replyTemplate.id, "publication-command-failed");
      assert.equal(payload.nextActions[0].kind, "inspect_publication_help");
      return true;
    },
  );
});

async function createCandidateFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-plan-"));
  const candidate = path.join(root, "candidate");
  const packagesDir = path.join(candidate, "packages");
  await mkdir(packagesDir, { recursive: true });
  const datasets = [
    dataset(
      KEYS.unitA,
      "process",
      "unit_process",
      IDS.unitA,
      [KEYS.flowA],
      ["unit_process", "result"],
    ),
    dataset(
      KEYS.unitB,
      "process",
      "unit_process",
      IDS.unitB,
      [KEYS.flowB],
      ["unit_process"],
    ),
    dataset(
      KEYS.flowA,
      "flow",
      "support",
      IDS.flowA,
      [],
      ["unit_process", "result"],
    ),
    dataset(KEYS.flowB, "flow", "support", IDS.flowB, [], ["unit_process"]),
    dataset(
      KEYS.result,
      "process",
      "result_process",
      IDS.result,
      [KEYS.unitA],
      ["result"],
    ),
    dataset(
      KEYS.model,
      "lifecyclemodel",
      "lifecycle_model",
      IDS.model,
      [KEYS.result],
      ["result"],
    ),
  ].sort((left, right) => left.key.localeCompare(right.key));
  const index = {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasetCount: datasets.length,
    byteSize: datasets.length,
    artifactSetHash: "a".repeat(64),
    datasets: datasets.map(
      ({
        key: _key,
        references: _references,
        components: _components,
        ...entry
      }) => ({
        ...entry,
        byteSize: 1,
      }),
    ),
  };
  const catalog = {
    schemaVersion: "tiangong.release.candidate-publication-catalog.v1",
    canonicalDatasetIndexSha256: hashJson(index),
    datasetCount: datasets.length,
    components: {
      unitProcess: {
        available: true,
        roots: [KEYS.unitA, KEYS.unitB].sort(),
        datasets: [KEYS.unitA, KEYS.unitB, KEYS.flowA, KEYS.flowB].sort(),
      },
      result: {
        available: true,
        roots: [KEYS.result, KEYS.model].sort(),
        datasets: [KEYS.model, KEYS.result, KEYS.unitA, KEYS.flowA].sort(),
      },
    },
    datasets,
    catalogSetHash: hashJson(
      datasets.map(({ key: value, sha256, references }) =>
        hashJson({ key: value, sha256, references }),
      ),
    ),
  };
  const packagePlan = { schemaVersion: "tiangong.release.package-plan.v1" };
  const packageRoots = {
    "unit.tidas.zip": path.join(root, "unit-package-root"),
    "result.tidas.zip": path.join(root, "result-package-root"),
  };
  for (const [name, packageRoot] of Object.entries(packageRoots)) {
    const component = name.startsWith("unit") ? "unit_process" : "result";
    for (const entry of datasets.filter(({ components }) =>
      components.includes(component),
    )) {
      const file = path.join(packageRoot, entry.path);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, canonicalJson({ content: entry.key }));
    }
    await execFileAsync(
      "zip",
      ["-q", "-r", path.join(packagesDir, name), "."],
      {
        cwd: packageRoot,
      },
    );
  }
  const packages = [];
  for (const name of [
    "unit.tidas.zip",
    "unit.ilcd.zip",
    "result.tidas.zip",
    "result.ilcd.zip",
  ]) {
    const file = path.join(packagesDir, name);
    if (!name.endsWith(".tidas.zip"))
      await writeFile(file, Buffer.from(`fixture:${name}`));
    const bytes = await readFile(file);
    packages.push({
      path: `packages/${name}`,
      mediaType: "application/zip",
      byteSize: bytes.length,
      sha256: sha256Bytes(bytes),
    });
  }
  const releaseCandidate = {
    schemaVersion: "tiangong.release.release-candidate.v2",
    status: "local_candidate",
    publicationAuthorized: false,
    releaseVersion: "2026.08.0",
    profile: "standalone-lifecyclemodel-result-full-closure.v1",
    packagePlanSha256: hashJson(packagePlan),
    canonicalDatasetIndexSha256: hashJson(index),
    publicationCatalog: {
      path: "publication-catalog.json",
      sha256: sha256Bytes(Buffer.from(canonicalJson(catalog))),
    },
    packages,
    packageSetHash: hashJson(
      packages.map(({ path: itemPath, sha256, byteSize }) => ({
        path: itemPath,
        sha256,
        byteSize,
      })),
    ),
    validation: {
      delegatedTo: "tidas-tools",
      outcome: "passed",
      reportPath: "tidas-release-report.json",
      archiveReadbackReportPath: "package-verification-report.json",
    },
    scopeDecisionSha256: null,
  };
  // The canonical dataset collection the Publication catalog binds to. Payload
  // materialization recomputes each canonical content hash from these files, so
  // the attested 120 content is anchored to frozen Candidate bytes.
  for (const entry of datasets) {
    const file = path.join(candidate, "canonical", entry.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, canonicalJson({ content: entry.key }));
  }
  await writeFile(
    path.join(candidate, "package-plan.json"),
    canonicalJson(packagePlan),
  );
  await writeFile(
    path.join(candidate, "canonical-dataset-index.json"),
    canonicalJson(index),
  );
  await writeFile(
    path.join(candidate, "publication-catalog.json"),
    canonicalJson(catalog),
  );
  await writeFile(
    path.join(candidate, "release-candidate.json"),
    canonicalJson(releaseCandidate),
  );
  return { root, candidate };
}

function dataset(keyValue, datasetType, role, uuid, targets, components) {
  const document = { content: keyValue };
  const bytes = Buffer.from(canonicalJson(document));
  return {
    key: keyValue,
    datasetType,
    role,
    uuid,
    version: VERSION,
    path: `${datasetType}s/${uuid}_${VERSION}.json`,
    sha256: sha256Bytes(bytes),
    canonicalContentHash: hashJson(document),
    references: [...new Set(targets)].sort(),
    components,
  };
}
