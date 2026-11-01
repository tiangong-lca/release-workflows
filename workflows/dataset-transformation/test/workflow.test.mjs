import {
  validUnitProcess,
  reference as completeReference,
} from "../../result-materialization/test-support/process-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeTransformation } from "../lib/analysis.mjs";
import { executeTransformation } from "../lib/execute.mjs";
import { verifyDerivedResultHandoff } from "../lib/handoff.mjs";
import { materializeDerivedResult } from "../../result-materialization/lib/derived-result.mjs";
import { freezeTransformation } from "../lib/freeze.mjs";
import {
  canonicalJson,
  hashJson,
  sha256Bytes,
  sha256File,
} from "../lib/common.mjs";
import {
  PENDING_OPERATION,
  RESULT_OPERATION,
  UNIT_OPERATION,
} from "../lib/operations.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "cli.mjs");
const VERSION = "01.00.000";
const INPUTS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const OUTPUT = "44444444-4444-4444-8444-444444444444";
const RESULT_INPUTS = [
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
  "99999999-9999-4999-8999-999999999999",
];
const FLOW_INPUT = "55555555-5555-4555-8555-555555555555";
const FLOW_REFERENCE = "66666666-6666-4666-8666-666666666666";
const LCIA_METHOD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALCULATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key = (uuid) => `process:${uuid}@${VERSION}`;

test("semantic differences produce needs_decision rather than a failed workflow", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const draftFile = path.join(fixture.root, "draft-unresolved.json");
  await writeFile(draftFile, canonicalJson(draft({ decisions: [] })));
  const inspection = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    outDir: path.join(fixture.root, "analysis-unresolved"),
  });
  assert.equal(inspection.analysis.status, "needs_decision");
  assert.ok(
    inspection.analysis.unresolvedConflictIds.includes("field:geography"),
  );
  assert.ok(
    inspection.analysis.unresolvedConflictIds.includes("field:technology"),
  );
  const frozen = await freezeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    analysisDir: inspection.path,
    outDir: path.join(fixture.root, "must-not-freeze"),
  });
  assert.equal(frozen.status, "needs_decision");
  await assert.rejects(access(path.join(fixture.root, "must-not-freeze")));
});

test("resolved DSL normalizes three quantitative references before weighted aggregation", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const readyDraft = draft({
    operationType: UNIT_OPERATION,
    decisions: resolvedDecisions({
      includeTargetDecision: true,
      operationType: UNIT_OPERATION,
    }),
  });
  const draftFile = path.join(fixture.root, "draft-ready.json");
  await writeFile(draftFile, canonicalJson(readyDraft));
  const inspection = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    outDir: path.join(fixture.root, "analysis-ready"),
  });
  assert.equal(inspection.analysis.status, "ready");
  const frozen = await freezeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    analysisDir: inspection.path,
    outDir: path.join(fixture.root, "frozen"),
  });
  assert.equal(frozen.status, "frozen");
  const execution = await executeTransformation({
    candidateDir: fixture.candidate,
    specDir: frozen.path,
    outDir: path.join(fixture.root, "execution"),
  });
  assert.equal(execution.receipt.validation.outcome, "passed");
  const process = JSON.parse(
    await readFile(
      path.join(execution.path, "canonical-datasets", execution.dataset.path),
      "utf8",
    ),
  ).processDataSet;
  const inputExchange = process.exchanges.exchange.find(
    (exchange) =>
      exchange.referenceToFlowDataSet["@refObjectId"] === FLOW_INPUT,
  );
  const referenceExchange = process.exchanges.exchange.find(
    (exchange) =>
      exchange.referenceToFlowDataSet["@refObjectId"] === FLOW_REFERENCE,
  );
  assert.equal(Number(inputExchange.resultingAmount), 2.7);
  assert.equal(Number(referenceExchange.resultingAmount), 1);
  assert.equal(
    process.processInformation.geography.locationOfOperationSupplyOrProduction[
      "@location"
    ],
    "CN",
  );
  assert.equal(
    process.modellingAndValidation.validation.review["@type"],
    "Not reviewed",
  );
  await assert.rejects(
    verifyDerivedResultHandoff({
      candidateDir: fixture.candidate,
      transformationDir: execution.path,
    }),
    { code: "derived_result_required" },
  );
  assert.equal(execution.handoff.nextWorkflow, "calculation");
  assert.equal(execution.handoff.finalTarget, "new-release-candidate");
});

test("aggregation target remains a normal user decision before input inspection", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const value = draft({
    operationType: PENDING_OPERATION,
    inputs: [],
    decisions: [],
  });
  value.operation.targetRecommendation = {
    recommendedOperation: RESULT_OPERATION,
    reason: "The user asked for a weighted average of existing Results",
    sourceRefs: ["conversation:goal"],
  };
  const draftFile = path.join(fixture.root, "target-pending.json");
  await writeFile(draftFile, canonicalJson(value));
  const inspection = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    outDir: path.join(fixture.root, "target-pending-analysis"),
  });
  assert.equal(inspection.analysis.status, "needs_decision");
  assert.deepEqual(inspection.analysis.unresolvedConflictIds, [
    "operation:aggregation-target",
  ]);
  assert.equal(
    inspection.analysis.operation.targetSelection.recommendation
      .recommendedOperation,
    RESULT_OPERATION,
  );
  assert.equal(
    inspection.analysis.nextAction,
    "agent_recommends_and_user_selects_aggregation_target",
  );
});

test("new Unit Process operation requires an explicit matching target confirmation", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const unconfirmed = draft({
    operationType: UNIT_OPERATION,
    decisions: resolvedDecisions(),
  });
  const draftFile = path.join(fixture.root, "unit-unconfirmed.json");
  await writeFile(draftFile, canonicalJson(unconfirmed));
  const inspection = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    outDir: path.join(fixture.root, "unit-unconfirmed-analysis"),
  });
  assert.ok(
    inspection.analysis.unresolvedConflictIds.includes(
      "operation:aggregation-target",
    ),
  );
});

test("compatible Result Processes aggregate LCI and LCIA then route to Result Materialization", async (t) => {
  const fixture = await createFixture({ completeResults: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const value = draft({
    operationType: RESULT_OPERATION,
    inputs: RESULT_INPUTS,
    decisions: resolvedDecisions({
      inputs: RESULT_INPUTS,
      includeTargetDecision: true,
      operationType: RESULT_OPERATION,
    }),
  });
  const finalName = value.decisions.find(
    ({ conflictId }) => conflictId === "field:name",
  ).value;
  delete finalName.functionalUnitFlowProperties;
  finalName.mixAndLocationTypes = {
    "@xml:lang": "en",
    "#text": "weighted production mix",
  };
  finalName.treatmentStandardsRoutes = {
    "@xml:lang": "en",
    "#text": "fixture route",
  };
  value.operation.targetRecommendation = {
    recommendedOperation: RESULT_OPERATION,
    reason: "The requested output is a weighted Result rather than a new model",
  };
  const draftFile = path.join(fixture.root, "result-ready.json");
  await writeFile(draftFile, canonicalJson(value));
  const inspection = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    outDir: path.join(fixture.root, "result-analysis"),
  });
  assert.equal(inspection.analysis.status, "ready");
  assert.equal(
    inspection.analysis.operation.compatibility.calculationId,
    CALCULATION_ID,
  );
  assert.equal(inspection.analysis.operation.compatibility.lciaMethodCount, 1);
  const frozen = await freezeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    analysisDir: inspection.path,
    outDir: path.join(fixture.root, "result-frozen"),
  });
  const execution = await executeTransformation({
    candidateDir: fixture.candidate,
    specDir: frozen.path,
    outDir: path.join(fixture.root, "result-execution"),
  });
  const process = JSON.parse(
    await readFile(
      path.join(execution.path, "canonical-datasets", execution.dataset.path),
      "utf8",
    ),
  ).processDataSet;
  const inventory = process.exchanges.exchange.find(
    (item) => item.referenceToFlowDataSet["@refObjectId"] === FLOW_INPUT,
  );
  assert.equal(Number(inventory.resultingAmount), 2.7);
  assert.equal(Number(process.LCIAResults.LCIAResult[0].meanAmount), 19);
  assert.equal(execution.dataset.role, "result_process");
  assert.equal(execution.handoff.status, "ready_for_result_materialization");
  assert.equal(execution.handoff.nextWorkflow, "result-materialization");
  assert.equal(execution.receipt.resultEvidence.disposition, "derived");
  const verified = await verifyDerivedResultHandoff({
    candidateDir: fixture.candidate,
    transformationDir: execution.path,
  });
  assert.equal(
    verified.dataset.canonicalContentHash,
    execution.dataset.canonicalContentHash,
  );
  const materialized = await materializeDerivedResult({
    candidateDir: fixture.candidate,
    transformationDir: execution.path,
    artifactRoot: path.join(fixture.root, "artifacts"),
  });
  assert.equal(materialized.catalog.datasets[0].relationKind, "derived");
  assert.equal(materialized.catalog.datasets[0].parentResults.length, 3);
  assert.equal(materialized.manifest.publicationAuthorized, false);
  assert.deepEqual(
    await readFile(
      path.join(materialized.path, materialized.catalog.datasets[0].path),
    ),
    verified.bytes,
  );
  const reused = await materializeDerivedResult({
    candidateDir: fixture.candidate,
    transformationDir: execution.path,
    artifactRoot: path.join(fixture.root, "artifacts"),
  });
  assert.equal(reused.disposition, "reused_existing");
  const cli = path.resolve(ROOT, "../result-materialization/cli.mjs");
  const cliResult = await execFileAsync(
    globalThis.process.execPath,
    [
      cli,
      "materialize",
      "derived",
      "--candidate",
      fixture.candidate,
      "--transformation",
      execution.path,
      "--artifact-root",
      path.join(fixture.root, "artifacts"),
      "--json",
    ],
    { cwd: os.tmpdir() },
  );
  assert.equal(JSON.parse(cliResult.stdout).outcome, "reused_existing");
  await writeFile(path.join(materialized.path, "result-catalog.json"), "{}");
  await assert.rejects(
    materializeDerivedResult({
      candidateDir: fixture.candidate,
      transformationDir: execution.path,
      artifactRoot: path.join(fixture.root, "artifacts"),
    }),
    { code: "artifact_path_conflict" },
  );
  const changedReceipt = {
    ...execution.receipt,
    validation: { ...execution.receipt.validation, referenceAmount: 99 },
  };
  await writeFile(
    path.join(execution.path, "transformation-execution-receipt.json"),
    canonicalJson(changedReceipt),
  );
  await writeFile(
    path.join(execution.path, "transformation-handoff.json"),
    canonicalJson({
      ...execution.handoff,
      transformationExecutionReceiptSha256: hashJson(changedReceipt),
    }),
  );
  await assert.rejects(
    verifyDerivedResultHandoff({
      candidateDir: fixture.candidate,
      transformationDir: execution.path,
    }),
    { code: "derived_result_evidence_mismatch" },
  );
  await writeFile(
    path.join(execution.path, "transformation-execution-receipt.json"),
    canonicalJson(execution.receipt),
  );
  await writeFile(
    path.join(execution.path, "transformation-handoff.json"),
    canonicalJson(execution.handoff),
  );
  await rm(path.join(execution.path, "transformation-frozen-spec.json"));
  const legacy = await verifyDerivedResultHandoff({
    candidateDir: fixture.candidate,
    transformationDir: execution.path,
    specDir: frozen.path,
  });
  assert.equal(legacy.receiptSha256, verified.receiptSha256);

  await writeFile(
    path.join(execution.path, "canonical-datasets", execution.dataset.path),
    "{}",
  );
  await assert.rejects(
    verifyDerivedResultHandoff({
      candidateDir: fixture.candidate,
      transformationDir: execution.path,
      specDir: frozen.path,
    }),
    { code: "derived_result_bytes_mismatch" },
  );
});

test("incompatible Result method sets remain a route decision instead of execution failure", async (t) => {
  const fixture = await createFixture({ mismatchedResultMethod: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const value = draft({
    operationType: RESULT_OPERATION,
    inputs: RESULT_INPUTS,
    decisions: resolvedDecisions({
      inputs: RESULT_INPUTS,
      includeTargetDecision: true,
      operationType: RESULT_OPERATION,
    }),
  });
  const draftFile = path.join(fixture.root, "result-incompatible.json");
  await writeFile(draftFile, canonicalJson(value));
  const inspection = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    outDir: path.join(fixture.root, "result-incompatible-analysis"),
  });
  assert.equal(inspection.analysis.status, "needs_decision");
  assert.ok(
    inspection.analysis.unresolvedConflictIds.includes(
      "compatibility:lcia-methods",
    ),
  );
});

test("annual-production gaps remain decisions and explicit evidenced overrides resolve them", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const incomplete = draft({
    weighting: { mode: "annual-production" },
    decisions: resolvedDecisions({ annualStrategy: "sum-resolved" }),
  });
  const incompleteFile = path.join(fixture.root, "annual-incomplete.json");
  await writeFile(incompleteFile, canonicalJson(incomplete));
  const first = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: incompleteFile,
    outDir: path.join(fixture.root, "annual-analysis-incomplete"),
  });
  assert.equal(first.analysis.status, "needs_decision");
  assert.ok(
    first.analysis.unresolvedConflictIds.includes(`weight:${key(INPUTS[1])}`),
  );
  assert.ok(
    first.analysis.unresolvedConflictIds.includes(`weight:${key(INPUTS[2])}`),
  );

  const complete = structuredClone(incomplete);
  complete.operation.weighting.overrides = {
    [key(INPUTS[1])]: {
      value: 200,
      unit: "kg/year",
      reason: "Corrected annual production supplied by the user",
      evidence: "fixture:evidence-b",
    },
    [key(INPUTS[2])]: {
      value: 300,
      unit: "kg/year",
      reason: "Sentinel replaced by a user-confirmed annual production",
      evidence: "fixture:evidence-c",
    },
  };
  const completeFile = path.join(fixture.root, "annual-complete.json");
  await writeFile(completeFile, canonicalJson(complete));
  const second = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: completeFile,
    outDir: path.join(fixture.root, "annual-analysis-complete"),
  });
  assert.equal(second.analysis.status, "ready");
  assert.equal(second.analysis.operation.weighting.rawTotal, 600);
  assert.deepEqual(
    second.analysis.operation.weighting.values.map(({ source }) => source),
    ["annual-field", "user-override", "user-override"],
  );
});

test("execution detects Candidate drift after freezing", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const draftFile = path.join(fixture.root, "drift-draft.json");
  await writeFile(
    draftFile,
    canonicalJson(draft({ decisions: resolvedDecisions() })),
  );
  const inspection = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    outDir: path.join(fixture.root, "drift-analysis"),
  });
  const frozen = await freezeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    analysisDir: inspection.path,
    outDir: path.join(fixture.root, "drift-frozen"),
  });
  const candidateFile = path.join(fixture.candidate, "release-candidate.json");
  const candidate = JSON.parse(await readFile(candidateFile, "utf8"));
  candidate.releaseVersion = "changed-after-freeze";
  await writeFile(candidateFile, canonicalJson(candidate));
  await assert.rejects(
    executeTransformation({
      candidateDir: fixture.candidate,
      specDir: frozen.path,
      outDir: path.join(fixture.root, "drift-execution"),
    }),
    ({ code }) => code === "transformation_input_drift",
  );
});

test("CLI emits bounded needs_decision JSON and a semantic reply template", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const draftFile = path.join(fixture.root, "cli-draft.json");
  await writeFile(draftFile, canonicalJson(draft({ decisions: [] })));
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI,
    "dsl",
    "inspect",
    "--candidate",
    fixture.candidate,
    "--dsl",
    draftFile,
    "--out-dir",
    path.join(fixture.root, "cli-analysis"),
    "--json",
  ]);
  assert.equal(stderr, "");
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "needs_decision");
  assert.equal(payload.replyTemplate.id, "transformation-inspected");
  assert.ok(payload.unresolvedCount > 0);
  assert.equal("conflicts" in payload, false);
});

function draft({
  weighting = null,
  decisions = [],
  operationType = "process.weighted-aggregate.v0",
  inputs = INPUTS,
} = {}) {
  return {
    schemaVersion: "tiangong.release.dataset-transformation-dsl.v0",
    status: "draft",
    operation: {
      type: operationType,
      inputs: inputs.map(key),
      weighting: weighting ?? {
        mode: "explicit",
        values: Object.fromEntries(
          inputs.map((uuid, index) => [key(uuid), [0.5, 0.3, 0.2][index]]),
        ),
      },
    },
    output: {
      identity: {
        uuid: OUTPUT,
        version: VERSION,
        uri: `https://example.test/process?uuid=${OUTPUT}&version=${VERSION}`,
      },
      generatedAt: "2026-08-26T00:00:00.000Z",
    },
    policies: {
      ...(inputs.length ? { prototypeInput: key(inputs[0]) } : {}),
      exchangeMetadata: {
        base: "take-from-prototype-then-input-order",
        dataSources: "union-deduplicate",
        comments: "replace-with-lineage",
        uncertainty: "reset",
        allocations: "reset",
      },
    },
    decisions,
  };
}

function resolvedDecisions({
  annualStrategy = "drop",
  inputs = INPUTS,
  includeTargetDecision = false,
  operationType = UNIT_OPERATION,
} = {}) {
  const first = key(inputs[0]);
  return [
    ...(includeTargetDecision
      ? [
          {
            conflictId: "operation:aggregation-target",
            strategy: "select-operation",
            value: operationType,
            reason: "The user explicitly confirmed the aggregation target",
          },
        ]
      : []),
    {
      conflictId: "field:name",
      strategy: "rewrite",
      value: {
        baseName: [{ "@xml:lang": "en", "#text": "Weighted electricity mix" }],
        functionalUnitFlowProperties: [],
        mixAndLocationTypes: [],
        treatmentStandardsRoutes: [],
      },
      reason: "The aggregate needs a distinct name",
    },
    {
      conflictId: "field:generalComment",
      strategy: "rewrite",
      value: [
        {
          "@xml:lang": "en",
          "#text": "Weighted aggregation across the confirmed inputs",
        },
      ],
      reason: "Input-specific lineage comments cannot become the output claim",
    },
    {
      conflictId: "field:geography",
      strategy: "rewrite",
      value: {
        locationOfOperationSupplyOrProduction: { "@location": "CN" },
      },
      reason: "The output combines three regions",
    },
    {
      conflictId: "field:technology",
      strategy: "take-from",
      input: first,
      reason: "Fixture chooses the prototype technology explicitly",
    },
    {
      conflictId: "field:annualVolume",
      strategy: annualStrategy,
      reason: "Fixture makes the annual-volume policy explicit",
    },
  ];
}

async function createFixture({
  mismatchedResultMethod = false,
  completeResults = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "transformation-v0-"));
  const candidate = path.join(root, "candidate");
  const unitPackageRoot = path.join(root, "unit-package-root");
  const resultPackageRoot = path.join(root, "result-package-root");
  await mkdir(path.join(candidate, "packages"), { recursive: true });
  await mkdir(path.join(unitPackageRoot, "processes"), { recursive: true });
  await mkdir(path.join(resultPackageRoot, "processes"), { recursive: true });
  const unitDocuments = [
    processDocument({
      uuid: INPUTS[0],
      location: "CN-HB",
      refAmount: 1,
      inputAmount: 2,
      annual: "100 kg/year",
    }),
    processDocument({
      uuid: INPUTS[1],
      location: "CN-SN",
      refAmount: 2,
      inputAmount: 6,
      annual: null,
    }),
    processDocument({
      uuid: INPUTS[2],
      location: "CN-JS",
      refAmount: 4,
      inputAmount: 16,
      annual: "9999 missing-data-sentinel/year",
    }),
  ];
  const entries = [];
  for (const [index, document] of unitDocuments.entries()) {
    const file = `${INPUTS[index]}_${VERSION}.json`;
    const relative = `processes/${file}`;
    const bytes = Buffer.from(canonicalJson(document));
    await writeFile(path.join(unitPackageRoot, relative), bytes);
    entries.push({
      byteSize: bytes.length,
      canonicalContentHash: hashJson(document),
      datasetType: "process",
      path: relative,
      role: "unit_process",
      sha256: sha256Bytes(bytes),
      uuid: INPUTS[index],
      version: VERSION,
    });
  }
  const resultDocuments = [
    resultProcessDocument({
      uuid: RESULT_INPUTS[0],
      sourceUuid: INPUTS[0],
      location: "CN-HB",
      inputAmount: 2,
      lciaAmount: 10,
      annual: "100 kg/year",
    }),
    resultProcessDocument({
      uuid: RESULT_INPUTS[1],
      sourceUuid: INPUTS[1],
      location: "CN-SN",
      inputAmount: 3,
      lciaAmount: 20,
      annual: null,
      methodUuid: mismatchedResultMethod
        ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        : LCIA_METHOD,
    }),
    resultProcessDocument({
      uuid: RESULT_INPUTS[2],
      sourceUuid: INPUTS[2],
      location: "CN-JS",
      inputAmount: 4,
      lciaAmount: 40,
      annual: "9999 missing-data-sentinel/year",
    }),
  ];
  if (completeResults) resultDocuments.forEach(completeResultFixture);
  for (const [index, document] of resultDocuments.entries()) {
    const file = `${RESULT_INPUTS[index]}_${VERSION}.json`;
    const relative = `processes/${file}`;
    const bytes = Buffer.from(canonicalJson(document));
    await writeFile(path.join(resultPackageRoot, relative), bytes);
    entries.push({
      byteSize: bytes.length,
      canonicalContentHash: hashJson(document),
      datasetType: "process",
      path: relative,
      role: "result_process",
      sha256: sha256Bytes(bytes),
      uuid: RESULT_INPUTS[index],
      version: VERSION,
    });
  }
  const unitArchiveName = "TiangongLCA-test-UnitProcessDatabase.tidas.zip";
  const unitArchive = path.join(candidate, "packages", unitArchiveName);
  await execFileAsync("zip", ["-X", "-q", "-r", unitArchive, "."], {
    cwd: unitPackageRoot,
  });
  const resultArchiveName = "TiangongLCA-test-ResultDatabase.tidas.zip";
  const resultArchive = path.join(candidate, "packages", resultArchiveName);
  await execFileAsync("zip", ["-X", "-q", "-r", resultArchive, "."], {
    cwd: resultPackageRoot,
  });
  const unitArchiveInfo = await readFile(unitArchive);
  const resultArchiveInfo = await readFile(resultArchive);
  const packages = [
    {
      path: `packages/${unitArchiveName}`,
      mediaType: "application/zip",
      byteSize: unitArchiveInfo.length,
      sha256: await sha256File(unitArchive),
    },
    {
      path: `packages/${resultArchiveName}`,
      mediaType: "application/zip",
      byteSize: resultArchiveInfo.length,
      sha256: await sha256File(resultArchive),
    },
    ...["UnitProcessDatabase.ilcd.zip", "ResultDatabase.ilcd.zip"].map(
      (name, index) => ({
        path: `packages/TiangongLCA-test-${name}`,
        mediaType: "application/zip",
        byteSize: index + 1,
        sha256: String(index + 1).repeat(64),
      }),
    ),
  ];
  const index = {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasetCount: entries.length,
    datasets: entries,
  };
  await writeFile(
    path.join(candidate, "canonical-dataset-index.json"),
    canonicalJson(index),
  );
  const releaseCandidate = {
    schemaVersion: "tiangong.release.release-candidate.v1",
    status: "local_candidate",
    publicationAuthorized: false,
    releaseVersion: "fixture",
    profile: "standalone-lifecyclemodel-result-full-closure.v1",
    packagePlanSha256: "a".repeat(64),
    canonicalDatasetIndexSha256: hashJson(index),
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
  await writeFile(
    path.join(candidate, "release-candidate.json"),
    canonicalJson(releaseCandidate),
  );
  return { root, candidate };
}

function processDocument({ uuid, location, refAmount, inputAmount, annual }) {
  return {
    processDataSet: {
      "@version": "1.1",
      processInformation: {
        dataSetInformation: {
          "common:UUID": uuid,
          name: {
            baseName: [
              { "@xml:lang": "en", "#text": `Electricity ${location}` },
            ],
            functionalUnitFlowProperties: [],
            mixAndLocationTypes: [],
            treatmentStandardsRoutes: [],
          },
          "common:generalComment": [],
        },
        quantitativeReference: {
          "@type": "Reference flow(s)",
          referenceToReferenceFlow: "1",
        },
        time: { "common:referenceYear": 2019 },
        geography: {
          locationOfOperationSupplyOrProduction: { "@location": location },
        },
        technology: {
          technologyDescriptionAndIncludedProcesses: [
            { "@xml:lang": "en", "#text": `Technology ${location}` },
          ],
        },
      },
      modellingAndValidation: {
        LCIMethodAndAllocation: {
          typeOfDataSet: "Unit process, single operation",
        },
        dataSourcesTreatmentAndRepresentativeness: {
          annualSupplyOrProductionVolume: annual
            ? [{ "@xml:lang": "en", "#text": annual }]
            : [],
        },
        validation: { review: { "@type": "Not reviewed" } },
      },
      administrativeInformation: {
        dataEntryBy: { "common:timeStamp": "2026-01-01T00:00:00.000Z" },
        publicationAndOwnership: {
          "common:dataSetVersion": VERSION,
          "common:dateOfLastRevision": "2026-01-01T00:00:00.000Z",
          "common:permanentDataSetURI": `https://example.test/${uuid}/${VERSION}`,
        },
      },
      exchanges: {
        exchange: [
          exchange("0", "Input", FLOW_INPUT, inputAmount),
          exchange("1", "Output", FLOW_REFERENCE, refAmount),
        ],
      },
    },
  };
}

function resultProcessDocument({
  uuid,
  sourceUuid,
  location,
  inputAmount,
  lciaAmount,
  annual,
  methodUuid = LCIA_METHOD,
}) {
  const document = processDocument({
    uuid,
    location,
    refAmount: 1,
    inputAmount,
    annual,
  });
  const process = document.processDataSet;
  process.modellingAndValidation.LCIMethodAndAllocation.typeOfDataSet =
    "LCI result";
  process.processInformation.dataSetInformation["common:generalComment"] = {
    "@xml:lang": "en",
    "#text": `aggregated LCI/LCIA result generated for ${sourceUuid}@${VERSION} under calculation ${CALCULATION_ID}.`,
  };
  process.LCIAResults = {
    LCIAResult: [
      {
        meanAmount: String(lciaAmount),
        referenceToLCIAMethodDataSet: {
          "@refObjectId": methodUuid,
          "@version": VERSION,
          "@type": "LCIA method data set",
        },
      },
    ],
  };
  return document;
}

function exchange(id, direction, flow, amount) {
  return {
    "@dataSetInternalID": id,
    exchangeDirection: direction,
    meanAmount: String(amount),
    resultingAmount: String(amount),
    referenceToFlowDataSet: {
      "@refObjectId": flow,
      "@version": VERSION,
      "@type": "flow data set",
    },
  };
}

function completeResultFixture(document) {
  const process = document.processDataSet;
  const uuid = process.processInformation.dataSetInformation["common:UUID"];
  const base = validUnitProcess(
    uuid,
    FLOW_REFERENCE,
    "Result fixture",
  ).processDataSet;
  for (const [key, value] of Object.entries(base))
    if (key.startsWith("@")) process[key] = value;
  process.administrativeInformation = {
    ...base.administrativeInformation,
    publicationAndOwnership: {
      ...base.administrativeInformation.publicationAndOwnership,
      ...process.administrativeInformation.publicationAndOwnership,
    },
  };
  const info = process.processInformation.dataSetInformation;
  info.classificationInformation =
    base.processInformation.dataSetInformation.classificationInformation;
  delete info.name.functionalUnitFlowProperties;
  info.name.treatmentStandardsRoutes =
    base.processInformation.dataSetInformation.name.treatmentStandardsRoutes;
  info.name.mixAndLocationTypes =
    base.processInformation.dataSetInformation.name.mixAndLocationTypes;
  process.modellingAndValidation.LCIMethodAndAllocation.LCIMethodPrinciple =
    "Attributional";
  process.modellingAndValidation.complianceDeclarations =
    base.modellingAndValidation.complianceDeclarations;
  process.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.dataCutOffAndCompletenessPrinciples =
    { "@xml:lang": "en", "#text": "Complete fixture" };
  process.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource =
    completeReference(
      "source data set",
      "sources",
      "66666666-6666-4666-8666-666666666666",
      "Fixture source",
    );
  for (const item of process.exchanges.exchange) {
    item.referenceToFlowDataSet = completeReference(
      "flow data set",
      "flows",
      item.referenceToFlowDataSet["@refObjectId"],
      "Fixture flow",
    );
    item.dataDerivationTypeStatus = "Calculated";
  }
  for (const item of process.LCIAResults.LCIAResult)
    item.referenceToLCIAMethodDataSet = completeReference(
      "LCIA method data set",
      "lciamethods",
      item.referenceToLCIAMethodDataSet["@refObjectId"],
      "Fixture method",
    );
}
