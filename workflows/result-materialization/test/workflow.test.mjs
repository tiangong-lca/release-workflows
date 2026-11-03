import {
  validUnitProcess,
  reference,
} from "../test-support/process-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canonicalJson } from "../lib/common.mjs";
import { createIntake } from "../lib/intake.mjs";
import {
  getMaterializationJob,
  readMaterializationJobLogs,
  startMaterializationJob,
} from "../lib/background-job.mjs";
import { resolveReferencePivot, sourceKey } from "../lib/context.mjs";
import { modelIdentity, resultIdentity } from "../lib/identity.mjs";
import { materializeModels } from "../lib/materialize-models.mjs";
import {
  REGISTRY_VERSION_PLAN,
  REGISTRY_VERSION_POLICY,
} from "../lib/registry-version-plan.mjs";
import { materialize } from "../lib/materialize.mjs";
import {
  materializeResults,
  resolveResultVariantVersions,
} from "../lib/materialize-results.mjs";
import { validateGeneratedProcessReferences } from "../lib/result-renderer.mjs";
import {
  hashJson,
  indexPreviousResultVariants,
  resolveVersion,
} from "../lib/versioning.mjs";

const PROCESS_ID = "11111111-1111-4111-8111-111111111111";
const FLOW_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "99999999-9999-4999-8999-999999999999";
const PROVIDER_FLOW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("identity contracts reproduce frozen vectors", () => {
  assert.equal(
    modelIdentity(PROCESS_ID, FLOW_ID).uuid,
    "c58f567c-c631-5a3a-90d9-c0cec7290cf8",
  );
  assert.equal(
    resultIdentity(PROCESS_ID, FLOW_ID).uuid,
    "e69b636c-c09d-5584-a00e-5ae3380594de",
  );
  assert.deepEqual(resultIdentity(PROCESS_ID, FLOW_ID).document, {
    rootProcessUuid: PROCESS_ID,
    referenceFlowUuid: FLOW_ID,
  });
});

test("version policy reuses, bumps minor metadata, and bumps major semantics", () => {
  const previous = {
    uuid: PROCESS_ID,
    version: "01.02.000",
    semanticHash: "a".repeat(64),
    versionSignificantHash: "b".repeat(64),
    canonicalContentHash: "c".repeat(64),
  };
  assert.deepEqual(resolveVersion({ ...previous }, previous), {
    version: "01.02.000",
    change: "reuse",
  });
  assert.deepEqual(
    resolveVersion(
      { ...previous, versionSignificantHash: "d".repeat(64) },
      previous,
    ),
    { version: "01.03.000", change: "minor" },
  );
  assert.deepEqual(
    resolveVersion({ ...previous, semanticHash: "e".repeat(64) }, previous),
    { version: "02.00.000", change: "major" },
  );
});

test("CLI exposes one intent-level materialize command and requires all three choices", () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /materialize\s+/);
  assert.match(help.stdout, /--output-type <type>/);
  assert.match(help.stdout, /--result-process-layer <layer>/);
  assert.match(help.stdout, /materialize start/);
  assert.match(help.stdout, /job get/);
  assert.match(help.stdout, /job logs/);
  assert.match(help.stdout, /job cancel/);
  assert.doesNotMatch(help.stdout, /materialize-results/);
  assert.doesNotMatch(help.stdout, /materialize-models/);
  const invalid = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "materialize",
      "--intake",
      "/tmp/input",
      "--out-dir",
      "/tmp/output",
      "--output-type",
      "result-process",
      "--result-process-layer",
      "lci",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, "selection_required");

  const invalidConcurrency = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "materialize",
      "--intake",
      "/tmp/intake",
      "--out-dir",
      "/tmp/output",
      "--all",
      "--output-type",
      "result-process",
      "--result-process-layer",
      "lci",
      "--first-generation",
      "--concurrency",
      "17",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(invalidConcurrency.status, 1);
  assert.match(JSON.parse(invalidConcurrency.stderr).error.message, /1 to 16/);
});

test("every Result Materialization action exposes local help without executing", () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  const cases = [
    [["intake", "--help"], /--bundle <path>/],
    [
      ["materialize", "--help"],
      /--output-type <result-process\|lifecycle-model>/,
    ],
    [["materialize", "start", "--help"], /observable local nohup job/],
    [["job", "get", "--help"], /progress, resources, throughput, and ETA/],
    [["job", "logs", "--help"], /--tail <1-500>/],
    [["job", "cancel", "--help"], /Request cancellation/],
  ];
  for (const [arguments_, expected] of cases) {
    const result = spawnSync(process.execPath, [cli.pathname, ...arguments_], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${arguments_.join(" ")}: ${result.stderr}`);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, expected);
  }
});

test("Result Materialization recovery commands are cwd-independent and actionable", async () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  const cwd = await mkdtemp(path.join(os.tmpdir(), "materialization-cwd-"));
  const failed = spawnSync(
    process.execPath,
    [cli.pathname, "materialize", "--json"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(failed.status, 1);
  const payload = JSON.parse(failed.stderr);
  assert.equal(payload.outcome, "command_failed");
  assert.match(payload.nextActions[0].command, new RegExp(cli.pathname));
  assert.match(payload.nextActions[0].command, /materialize --help/);
});

test("nohup jobs expose bounded status, logs, and terminal cancellation", async () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  const temp = await mkdtemp(path.join(os.tmpdir(), "release-job-"));
  const artifactRoot = path.join(temp, "artifacts");
  const started = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "materialize",
      "start",
      "--intake",
      path.join(temp, "missing-intake"),
      "--out-dir",
      path.join(temp, "output"),
      "--processes",
      `${PROCESS_ID}@01.00.000`,
      "--output-type",
      "result-process",
      "--result-process-layer",
      "lci",
      "--first-generation",
      "--artifact-root",
      artifactRoot,
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(started.status, 0, started.stderr);
  const startResult = JSON.parse(started.stdout);
  assert.equal(startResult.outcome, "started");
  assert.match(startResult.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(startResult.jobDir.startsWith(artifactRoot), true);
  assert.ok(
    startResult.nextActions.every((item) => item.includes(artifactRoot)),
  );
  assert.equal(startResult.nextAction.command, startResult.nextActions[0]);
  assert.match(startResult.nextAction.command, new RegExp(cli.pathname));
  let observed;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = spawnSync(
      process.execPath,
      [
        cli.pathname,
        "job",
        "get",
        "--job-id",
        startResult.jobId,
        "--artifact-root",
        artifactRoot,
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(status.status, 0, status.stderr);
    observed = JSON.parse(status.stdout);
    if (["failed", "interrupted"].includes(observed.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(observed.state, "failed");
  assert.equal(observed.exitCode, 1);
  const logs = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "job",
      "logs",
      "--job-id",
      startResult.jobId,
      "--artifact-root",
      artifactRoot,
      "--tail",
      "2",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(logs.status, 0, logs.stderr);
  const logResult = JSON.parse(logs.stdout);
  assert.ok(logResult.returnedLineCount >= 1);
  assert.ok(logResult.lines.some((line) => line.includes("job_failed")));
  await appendFile(startResult.logPath, `${"x".repeat(5000)}\n`);
  const boundedLogs = await readMaterializationJobLogs({
    artifactRoot,
    jobId: startResult.jobId,
    tail: 1,
  });
  assert.equal(boundedLogs.lines[0].length, 4001);
  assert.equal(boundedLogs.truncatedLineCount, 1);
  const cancelled = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "job",
      "cancel",
      "--job-id",
      startResult.jobId,
      "--artifact-root",
      artifactRoot,
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).state, "failed");
  const oversizedTail = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "job",
      "logs",
      "--job-id",
      startResult.jobId,
      "--artifact-root",
      artifactRoot,
      "--tail",
      "501",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(oversizedTail.status, 1);
  assert.equal(JSON.parse(oversizedTail.stderr).error.code, "invalid_tail");
});

test("intake, Result Catalog, and resolved one-hop Model complete locally", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "release-materialization-"),
  );
  const bundle = path.join(temp, "bundle");
  for (const directory of ["source", "axes", "results", "graph"]) {
    await mkdir(path.join(bundle, directory), { recursive: true });
  }
  const process = validUnitProcess(PROCESS_ID, FLOW_ID, "Fixture Unit Process");
  const originalComment = structuredClone(
    process.processDataSet.processInformation.dataSetInformation[
      "common:generalComment"
    ],
  );
  const historicalNotes = [
    { "@xml:lang": "en", "#text": "Retained historical note." },
    { "@xml:lang": "zh", "#text": "保留历史备注。" },
  ];
  process.processDataSet.processInformation.mathematicalRelations = {
    variableParameter: { comment: historicalNotes },
  };
  process.processDataSet.administrativeInformation[
    "common:commissionerAndGoal"
  ]["common:intendedApplications"] = [];
  const originalProcess = structuredClone(process);
  const sourceReferenceExchange = process.processDataSet.exchanges.exchange[0];
  sourceReferenceExchange.allocations = {
    allocation: {
      "@allocatedFraction": "100",
      "@internalReferenceToCoProduct": "7",
    },
  };
  sourceReferenceExchange.referenceToVariable = "source-only-variable";
  const provider = validUnitProcess(
    PROVIDER_ID,
    PROVIDER_FLOW_ID,
    "Fixture Provider Process",
  );
  const sourceRecords = [
    {
      schemaVersion: "tiangong.source-closure.dataset.v1",
      datasetType: "process",
      role: "unit_process",
      uuid: PROCESS_ID,
      version: "01.00.000",
      path: `processes/${PROCESS_ID}_01.00.000.json`,
      sha256: sha(Buffer.from(canonicalJson(process).trimEnd())),
      document: process,
    },
    {
      schemaVersion: "tiangong.source-closure.dataset.v1",
      datasetType: "process",
      role: "unit_process",
      uuid: PROVIDER_ID,
      version: "01.00.000",
      path: `processes/${PROVIDER_ID}_01.00.000.json`,
      sha256: sha(Buffer.from(canonicalJson(provider).trimEnd())),
      document: provider,
    },
  ];
  const axisRecords = [
    {
      processIndex: 0,
      rootProcess: { id: PROCESS_ID, version: "01.00.000" },
      quantitativeReference: {
        exchangeInternalId: "0",
        flow: { id: FLOW_ID, version: "01.00.000" },
        direction: "Output",
        referenceUnit: "kg",
        meanAmount: 1,
      },
    },
    {
      processIndex: 1,
      rootProcess: { id: PROVIDER_ID, version: "01.00.000" },
      quantitativeReference: {
        exchangeInternalId: "0",
        flow: { id: PROVIDER_FLOW_ID, version: "01.00.000" },
        direction: "Output",
        referenceUnit: "kg",
        meanAmount: 1,
      },
    },
  ];
  const technosphereRecords = [
    {
      dependentProcessIndex: 0,
      residualExchangeInternalId: "7",
      balancingProcessIndex: 1,
      balancingReferenceExchangeInternalId: "0",
      residualCoefficient: -2,
      referenceCoefficient: 1,
      routingWeight: 1,
      activityRequirement: 2,
      flow: { id: PROVIDER_FLOW_ID, version: "01.00.000" },
      location: "GLO",
    },
  ];
  const artifactSpecs = [
    ["source_closure", "source/source-closure.ndjson.gz", sourceRecords],
    ["process_axis", "axes/processes-000000.ndjson.gz", axisRecords],
    ["lci", "results/lci-000000.ndjson.gz", []],
    ["lcia", "results/lcia-000000.ndjson.gz", []],
    ["biosphere_edges", "graph/biosphere-000000.ndjson.gz", []],
    [
      "technosphere_edges",
      "graph/technosphere-000000.ndjson.gz",
      technosphereRecords,
    ],
  ];
  const artifacts = [];
  for (const [kind, relative, records] of artifactSpecs) {
    const plain = Buffer.from(
      records.map((record) => canonicalJson(record).trimEnd()).join("\n") +
        (records.length ? "\n" : ""),
    );
    const compressed = gzipSync(plain, { level: 6, mtime: 0 });
    await writeFile(path.join(bundle, relative), compressed);
    artifacts.push({
      kind,
      path: relative,
      schemaVersion: `test.${kind}.v1`,
      mediaType: "application/x-ndjson",
      compression: "gzip",
      sha256: sha(compressed),
      uncompressedSha256: sha(plain),
      byteSize: compressed.length,
      uncompressedByteSize: plain.length,
      recordCount: records.length,
    });
  }
  const manifest = calculationManifest(artifacts);
  const hashInput = structuredClone(manifest);
  delete hashInput.bundleContentHash;
  manifest.bundleContentHash = sha(
    Buffer.from(canonicalJson(hashInput).trimEnd()),
  );
  await writeFile(
    path.join(bundle, "calculation-bundle.json"),
    canonicalJson(manifest).trimEnd(),
  );

  const intakePath = path.join(temp, "intake");
  await createIntake({ bundle, outDir: intakePath });
  const resultPath = path.join(temp, "results");
  const results = await materializeResults({
    intakeDir: intakePath,
    outDir: resultPath,
    processUuids: [PROCESS_ID],
    includeDirectProviders: true,
    firstGeneration: true,
  });
  assert.equal(results.catalog.selection.length, 1);
  assert.equal(results.catalog.datasets.length, 2);
  assert.equal(
    results.catalog.datasets[0].uuid,
    "e69b636c-c09d-5584-a00e-5ae3380594de",
  );
  const primaryResult = results.catalog.datasets.find(
    (item) => item.sourceProcess.id === PROCESS_ID,
  );
  const primaryDocument = JSON.parse(
    await readFile(path.join(results.path, primaryResult.path), "utf8"),
  );
  assert.deepEqual(
    primaryDocument.processDataSet.processInformation.dataSetInformation[
      "common:generalComment"
    ].slice(0, -1),
    [originalComment, ...historicalNotes],
  );
  assert.match(
    primaryDocument.processDataSet.processInformation.dataSetInformation[
      "common:generalComment"
    ].at(-1)["#text"],
    /generated for/,
  );
  const generatedReferenceExchange =
    primaryDocument.processDataSet.exchanges.exchange[0];
  assert.equal(generatedReferenceExchange.allocations, undefined);
  assert.equal(generatedReferenceExchange.referenceToVariable, undefined);
  assert.doesNotThrow(() =>
    validateGeneratedProcessReferences(primaryDocument),
  );
  generatedReferenceExchange.allocations = {
    allocation: { "@internalReferenceToCoProduct": "missing" },
  };
  assert.throws(
    () => validateGeneratedProcessReferences(primaryDocument),
    (error) =>
      error.code === "generated_process_internal_reference_invalid" &&
      error.details.kind === "allocation_coproduct",
  );
  delete generatedReferenceExchange.allocations;
  generatedReferenceExchange.referenceToVariable = "missing-variable";
  assert.throws(
    () => validateGeneratedProcessReferences(primaryDocument),
    (error) =>
      error.code === "generated_process_internal_reference_invalid" &&
      error.details.kind === "variable_parameter",
  );
  const models = await materializeModels({
    intakeDir: intakePath,
    resultCatalogPath: path.join(resultPath, "result-catalog.json"),
    outDir: path.join(temp, "models"),
    firstGeneration: true,
  });
  assert.equal(models.catalog.datasets.length, 1);
  assert.equal(
    models.catalog.datasets[0].uuid,
    "c58f567c-c631-5a3a-90d9-c0cec7290cf8",
  );
  assert.equal(models.manifest.validation.modelSchemas, "passed");
  assert.equal(models.catalog.datasets[0].providerCount, 1);
  const modelDocument = JSON.parse(
    await readFile(
      path.join(models.path, models.catalog.datasets[0].path),
      "utf8",
    ),
  );
  assert.deepEqual(
    modelDocument.lifeCycleModelDataSet.lifeCycleModelInformation.dataSetInformation[
      "common:generalComment"
    ].slice(0, -1),
    [originalComment, ...historicalNotes],
  );
  assert.deepEqual(
    process.processDataSet.processInformation,
    originalProcess.processDataSet.processInformation,
  );
  assert.deepEqual(
    process.processDataSet.administrativeInformation,
    originalProcess.processDataSet.administrativeInformation,
  );

  const previousManifestPath = path.join(
    models.path,
    "materialization-manifest.json",
  );
  const replayResults = await materializeResults({
    intakeDir: intakePath,
    outDir: path.join(temp, "results-replay"),
    processUuids: [PROCESS_ID],
    includeDirectProviders: true,
    previousManifestPath,
  });
  assert.ok(
    replayResults.catalog.datasets.every(
      (item) => item.versionChange === "reuse",
    ),
  );
  const replayModels = await materializeModels({
    intakeDir: intakePath,
    resultCatalogPath: path.join(replayResults.path, "result-catalog.json"),
    outDir: path.join(temp, "models-replay"),
    previousManifestPath,
  });
  assert.ok(
    replayModels.catalog.datasets.every(
      (item) => item.versionChange === "reuse",
    ),
  );

  const resultOnly = await materialize({
    intakeDir: intakePath,
    outDir: path.join(temp, "result-only-delivery"),
    processUuids: [`${PROCESS_ID}@01.00.000`],
    outputType: "result-process",
    resultProcessLayer: "lci",
    firstGeneration: true,
  });
  assert.deepEqual(resultOnly.summary, {
    requestedRootCount: 1,
    primaryDatasetCount: 1,
    dependencyDatasetCount: 0,
    resultingDatasetCount: 0,
  });
  assert.equal(resultOnly.manifest.profiles.result, "lci-result.v2");
  assert.equal(resultOnly.manifest.profiles.model, null);

  const modelDelivery = await materialize({
    intakeDir: intakePath,
    outDir: path.join(temp, "model-delivery"),
    processUuids: [`${PROCESS_ID}@01.00.000`],
    outputType: "lifecycle-model",
    resultProcessLayer: "lci-lcia",
    firstGeneration: true,
  });
  assert.deepEqual(modelDelivery.summary, {
    requestedRootCount: 1,
    primaryDatasetCount: 1,
    dependencyDatasetCount: 1,
    resultingDatasetCount: 1,
  });
  assert.equal(modelDelivery.manifest.datasets.length, 3);
  const canonicalIndex = JSON.parse(
    await readFile(
      path.join(modelDelivery.path, "canonical-dataset-index.json"),
      "utf8",
    ),
  );
  assert.equal(
    canonicalIndex.schemaVersion,
    "tiangong.release.canonical-dataset-index.v1",
  );
  assert.equal(canonicalIndex.datasetCount, 3);
  assert.equal(
    modelDelivery.manifest.inputs.canonicalDatasetIndexSha256,
    hashJson(canonicalIndex),
  );

  const canonicalRoot = path.join(temp, "canonical-artifacts");
  const canonicalIntake = await createIntake({
    bundle,
    artifactRoot: canonicalRoot,
  });
  assert.equal(canonicalIntake.disposition, "created");
  assert.equal(
    canonicalIntake.path,
    path.join(
      canonicalRoot,
      "result-materialization",
      "intakes",
      canonicalIntake.intake.source.calculationId,
      canonicalIntake.intake.source.bundleContentHash,
    ),
  );
  const reusedIntake = await createIntake({
    bundle,
    artifactRoot: canonicalRoot,
  });
  assert.equal(reusedIntake.disposition, "reused_existing");
  assert.equal(reusedIntake.path, canonicalIntake.path);

  const canonicalRequest = {
    intakeDir: canonicalIntake.path,
    artifactRoot: canonicalRoot,
    processUuids: [`${PROCESS_ID}@01.00.000`],
    outputType: "result-process",
    resultProcessLayer: "lci-lcia",
    firstGeneration: true,
  };
  const canonicalDelivery = await materialize(canonicalRequest);
  assert.equal(canonicalDelivery.disposition, "created");
  assert.equal(canonicalDelivery.pathPolicy, "canonical-content-addressed.v1");
  assert.match(
    canonicalDelivery.path,
    new RegExp(
      `result-materialization/materializations/${canonicalIntake.intake.source.calculationId}/${canonicalIntake.intake.source.bundleContentHash}/[0-9a-f]{64}$`,
    ),
  );
  const reusedDelivery = await materialize(canonicalRequest);
  assert.equal(reusedDelivery.disposition, "reused_existing");
  assert.equal(reusedDelivery.path, canonicalDelivery.path);
  assert.equal(
    reusedDelivery.artifactIdentity.materializationKeySha256,
    canonicalDelivery.artifactIdentity.materializationKeySha256,
  );

  const originalManifest = JSON.parse(
    await readFile(
      path.join(canonicalDelivery.path, "materialization-manifest.json"),
    ),
  );
  const originalResult = originalManifest.datasets.find(
    (d) => d.role === "result_process",
  );
  const versionPlan = {
    schemaVersion: REGISTRY_VERSION_PLAN,
    policy: REGISTRY_VERSION_POLICY,
    inputHash: "a".repeat(64),
    registrationAuthorized: false,
    publicationAuthorized: false,
    entries: [
      {
        uuid: originalResult.uuid,
        fromVersion: originalResult.version,
        toVersion: "08.00.000",
        canonicalContentHash: originalResult.canonicalContentHash,
        contentHash: "b".repeat(64),
        relationKind: "direct",
        reason: "conflict",
        highestObservedVersion: "07.03.002",
      },
    ],
  };
  const versionPlanPath = path.join(temp, "registry-version-plan.json");
  await writeFile(versionPlanPath, canonicalJson(versionPlan));
  const regenerated = await materialize({
    ...canonicalRequest,
    resultVersionPlanPath: versionPlanPath,
  });
  assert.notEqual(regenerated.path, canonicalDelivery.path);
  const regeneratedManifest = JSON.parse(
    await readFile(
      path.join(regenerated.path, "materialization-manifest.json"),
    ),
  );
  const regeneratedResult = regeneratedManifest.datasets.find(
    (d) => d.role === "result_process",
  );
  assert.equal(regeneratedResult.version, "08.00.000");
  assert.notEqual(
    regeneratedResult.canonicalContentHash,
    originalResult.canonicalContentHash,
  );
  assert.equal(
    regeneratedManifest.inputs.resultVersionPlanSha256,
    hashJson(versionPlan),
  );
  const regeneratedDocument = JSON.parse(
    await readFile(path.join(regenerated.path, regeneratedResult.path)),
  );
  assert.equal(
    regeneratedDocument.processDataSet.administrativeInformation
      .publicationAndOwnership["common:dataSetVersion"],
    "08.00.000",
  );
  assert.match(
    regeneratedDocument.processDataSet.administrativeInformation
      .publicationAndOwnership["common:permanentDataSetURI"],
    /version=08.00.000$/,
  );
  assert.equal(
    (
      await materialize({
        ...canonicalRequest,
        resultVersionPlanPath: versionPlanPath,
      })
    ).disposition,
    "reused_existing",
  );
  const originalBytes = await readFile(
    path.join(canonicalDelivery.path, originalResult.path),
  );
  assert.equal(
    hashJson(JSON.parse(originalBytes)),
    originalResult.canonicalContentHash,
  );
  const regeneratedModel = await materialize({
    ...canonicalRequest,
    outputType: "lifecycle-model",
    resultVersionPlanPath: versionPlanPath,
  });
  const modelManifest = JSON.parse(
    await readFile(
      path.join(regeneratedModel.path, "materialization-manifest.json"),
    ),
  );
  const modelEntry = modelManifest.datasets.find(
    (d) => d.datasetType === "lifecyclemodel",
  );
  const modelBytes = await readFile(
    path.join(regeneratedModel.path, modelEntry.path),
    "utf8",
  );
  assert.match(modelBytes, /08\.00\.000/);
  const driftedPlan = structuredClone(versionPlan);
  driftedPlan.entries[0].canonicalContentHash = "0".repeat(64);
  await writeFile(versionPlanPath, canonicalJson(driftedPlan));
  await assert.rejects(
    materialize({
      ...canonicalRequest,
      resultVersionPlanPath: versionPlanPath,
    }),
    { code: "result_version_plan_input_drift" },
  );
  await writeFile(versionPlanPath, canonicalJson(versionPlan));
  await writeFile(
    path.join(regenerated.path, "result-version-plan.json"),
    "{}",
  );
  await assert.rejects(
    materialize({
      ...canonicalRequest,
      resultVersionPlanPath: versionPlanPath,
    }),
    { code: "artifact_path_conflict" },
  );

  const alternateLayer = await materialize({
    ...canonicalRequest,
    resultProcessLayer: "lci",
  });
  assert.notEqual(alternateLayer.path, canonicalDelivery.path);
  await writeFile(
    path.join(canonicalDelivery.path, "materialization-key.json"),
    canonicalJson({ invalid: true }),
  );
  await assert.rejects(materialize(canonicalRequest), {
    code: "artifact_path_conflict",
  });

  const backgroundRoot = path.join(temp, "background-artifacts");
  const background = await startMaterializationJob({
    artifactRoot: backgroundRoot,
    request: {
      intakeDir: intakePath,
      outDir: path.join(temp, "background-delivery"),
      processUuids: [`${PROCESS_ID}@01.00.000`],
      outputType: "result-process",
      resultProcessLayer: "lci",
      firstGeneration: true,
    },
  });
  let completedJob;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    completedJob = await getMaterializationJob({
      artifactRoot: backgroundRoot,
      jobId: background.jobId,
    });
    if (["succeeded", "failed", "interrupted"].includes(completedJob.state)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(completedJob.state, "succeeded");
  assert.equal(completedJob.exitCode, 0);
  assert.ok(completedJob.resources.rssBytes > 0);
  assert.ok(completedJob.resources.heapLimitBytes > 0);
  assert.ok(completedJob.resources.elapsedSeconds >= 0);
  assert.match(completedJob.nextActions[0], /release-candidate\/cli\.mjs/);
  assert.match(completedJob.nextActions[0], /intake prepare/);
  assert.match(completedJob.nextActions[0], /--materialization/);
  assert.match(completedJob.nextActions[0], /--source-intake/);
  assert.doesNotMatch(completedJob.nextActions[0], /<[^>]+>/);
  const backgroundLogs = await readMaterializationJobLogs({
    artifactRoot: backgroundRoot,
    jobId: background.jobId,
    tail: 100,
  });
  assert.ok(
    backgroundLogs.lines.some((line) => line.includes('"event":"progress"')),
  );
  assert.ok(
    backgroundLogs.lines.some((line) => line.includes('"phase":"committing"')),
  );
  assert.ok(
    backgroundLogs.lines.some((line) => line.includes('"resources":{')),
  );
});

test("multiple exact source revisions share a Result UUID but receive exact versions", () => {
  const resultUuid = resultIdentity(PROCESS_ID, FLOW_ID).uuid;
  const hash = (value) => value.repeat(64);
  const draft = (processIndex, version, value) => ({
    axis: { processIndex },
    provisional: {
      uuid: resultUuid,
      sourceProcess: { id: PROCESS_ID, version },
    },
    hashes: {
      semanticHash: hash(value),
      versionSignificantHash: hash(value),
      canonicalContentHash: hash(value),
    },
  });
  const drafts = [draft(1, "01.01.002", "a"), draft(2, "01.01.005", "b")];
  const first = resolveResultVariantVersions(
    drafts,
    indexPreviousResultVariants(null),
  );
  assert.equal(first.get(1).version, "01.00.000");
  assert.equal(first.get(2).version, "02.00.000");
  const previousManifest = {
    datasets: drafts.map((item) => ({
      datasetType: "process",
      uuid: resultUuid,
      version: first.get(item.axis.processIndex).version,
      sourceProcess: item.provisional.sourceProcess,
      ...item.hashes,
    })),
  };
  const replay = resolveResultVariantVersions(
    drafts,
    indexPreviousResultVariants(previousManifest),
  );
  assert.equal(replay.get(1).change, "reuse");
  assert.equal(replay.get(2).change, "reuse");
});

test("quantitative-reference pivot uses Bundle v2 evidence and bounded legacy fallback", () => {
  const process = validUnitProcess(
    PROCESS_ID,
    FLOW_ID,
    "Input reference fixture",
  );
  const referenceExchange = process.processDataSet.exchanges.exchange[0];
  referenceExchange.exchangeDirection = "Input";
  referenceExchange.meanAmount = "2.5";
  const sources = new Map([
    [
      sourceKey("process", PROCESS_ID, "01.00.000"),
      { role: "unit_process", document: process },
    ],
  ]);
  const axis = {
    processIndex: 0,
    rootProcess: { id: PROCESS_ID, version: "01.00.000" },
    quantitativeReference: {
      exchangeInternalId: "0",
      flow: { id: FLOW_ID, version: "01.00.000" },
      meanAmount: 1,
    },
  };
  const legacy = resolveReferencePivot(axis, sources);
  assert.deepEqual(legacy, {
    rawDirection: "Input",
    rawMeanAmount: 2.5,
    signedRawCoefficient: -2.5,
    normalizationScale: 0.4,
    normalizedCoefficient: -1,
    normalizedMeanAmount: 1,
    evidenceSource: "exact_source_closure_legacy_fallback.v1",
  });
  axis.quantitativeReference.pivot = {
    rawDirection: "Input",
    rawMeanAmount: 2.5,
    signedRawCoefficient: -2.5,
    normalizationScale: 0.4,
    normalizedCoefficient: -1,
  };
  assert.equal(
    resolveReferencePivot(axis, sources).evidenceSource,
    "calculation_bundle_process_axis.v2",
  );
});

function calculationManifest(artifacts) {
  return {
    schemaVersion: "tiangong.calculation-bundle.v2",
    calculationContractVersion: "1.0.0",
    calculationId: "33333333-3333-4333-8333-333333333333",
    bundleContentHash: "0".repeat(64),
    scope: {
      coverageMode: "subset",
      processCount: 2,
      selectionManifestHash: "a".repeat(64),
    },
    snapshot: {
      id: "44444444-4444-4444-8444-444444444444",
      sha256: "b".repeat(64),
      processCount: 2,
      flowCount: 2,
      impactCount: 0,
    },
    solver: {},
    methodSet: {},
    artifacts,
    calculationEvidence: {},
    hashes: { algorithm: "sha256", canonicalJson: "RFC8785/JCS" },
  };
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
