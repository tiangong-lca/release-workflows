import assert from "node:assert/strict";
import test from "node:test";
import { ProcessSchema } from "@tiangong-lca/tidas-sdk";
import { normalizeCompatibleProcessDocument } from "../lib/process-compat.mjs";
import { buildMaterializationIdentity } from "../lib/artifact-paths.mjs";
import { hashJson } from "../lib/versioning.mjs";
import { validUnitProcess } from "../test-support/process-fixture.mjs";

const fixture = () =>
  validUnitProcess(
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "Historical process",
  );
const notes = [
  { "@xml:lang": "en", "#text": "Original first note." },
  { "@xml:lang": "zh", "#text": "原始中文备注。" },
  { "@xml:lang": "en", "#text": "Original second note." },
];

test("historical empty arrays and empty parameters pass the real SDK without changing source semantics", () => {
  const source = fixture();
  const data = source.processDataSet;
  data.processInformation.dataSetInformation["common:generalComment"] = [];
  data.processInformation.technology = {
    technologyDescriptionAndIncludedProcesses: [],
  };
  data.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness = {
    dataCutOffAndCompletenessPrinciples: [],
    referenceToDataSource: structuredClone(
      data.modellingAndValidation.complianceDeclarations.compliance[
        "common:referenceToComplianceSystem"
      ],
    ),
    annualSupplyOrProductionVolume: { "@xml:lang": "en", "#text": "1 kg" },
  };
  data.administrativeInformation["common:commissionerAndGoal"][
    "common:intendedApplications"
  ] = [];
  data.processInformation.mathematicalRelations = { variableParameter: {} };
  data.modellingAndValidation.validation.review = [{ "@type": "Not reviewed" }];
  const before = structuredClone(source);
  assert.equal(ProcessSchema.safeParse(source).success, false);
  const normalized = normalizeCompatibleProcessDocument(source);
  assert.equal(
    ProcessSchema.safeParse(normalized).success,
    true,
    JSON.stringify(ProcessSchema.safeParse(normalized).error?.issues),
  );
  assert.deepEqual(source, before);
  assert.deepEqual(normalizeCompatibleProcessDocument(normalized), normalized);
  assert.deepEqual(normalized.processDataSet.exchanges, data.exchanges);
  assert.deepEqual(
    normalized.processDataSet.modellingAndValidation.validation,
    data.modellingAndValidation.validation,
  );
  assert.deepEqual(
    normalized.processDataSet.processInformation.quantitativeReference,
    data.processInformation.quantitativeReference,
  );
  assert.deepEqual(
    normalized.processDataSet.processInformation.dataSetInformation[
      "common:generalComment"
    ],
    [{ "@xml:lang": "en", "#text": "" }],
  );
});

test("comment-only parameters retain exact ordered multilingual entries", () => {
  for (const comment of [notes, notes[0]]) {
    const source = fixture();
    source.processDataSet.processInformation.mathematicalRelations = {
      variableParameter: { comment },
    };
    const before = structuredClone(source);
    const normalized = normalizeCompatibleProcessDocument(source);
    assert.equal(
      ProcessSchema.safeParse(normalized).success,
      true,
      JSON.stringify(ProcessSchema.safeParse(normalized).error?.issues),
    );
    assert.deepEqual(
      normalized.processDataSet.processInformation.dataSetInformation[
        "common:generalComment"
      ],
      [
        before.processDataSet.processInformation.dataSetInformation[
          "common:generalComment"
        ],
        ...[comment].flat(),
      ],
    );
    assert.equal(
      normalized.processDataSet.processInformation.mathematicalRelations
        .variableParameter,
      undefined,
    );
    assert.deepEqual(source, before);
    assert.deepEqual(
      normalizeCompatibleProcessDocument(normalized),
      normalized,
    );
  }
});

test("compatibility leaves unrelated and malformed content for SDK rejection", () => {
  for (const variableParameter of [
    null,
    [],
    { meanValue: "1" },
    { comment: [] },
    { comment: null },
    { comment: notes, meanValue: "1" },
    { "@name": "actual_parameter", meanValue: "1" },
  ]) {
    const source = fixture();
    source.processDataSet.processInformation.mathematicalRelations = {
      variableParameter,
    };
    const normalized = normalizeCompatibleProcessDocument(source);
    assert.deepEqual(normalized, source);
  }
  for (const value of [
    undefined,
    null,
    17,
    [{ "@xml:lang": "zh", "#text": "" }],
  ]) {
    const source = fixture();
    source.processDataSet.processInformation.dataSetInformation[
      "common:generalComment"
    ] = value;
    const normalized = normalizeCompatibleProcessDocument(source);
    assert.deepEqual(normalized, source);
    assert.equal(ProcessSchema.safeParse(normalized).success, false);
  }
});

test("historical metadata policy cannot reuse an old materialization key", () => {
  const request = {
    context: {
      intake: {
        source: { calculationId: "fixture", bundleContentHash: "a".repeat(64) },
      },
    },
    selectedAxes: [],
    scopeMode: "all",
    outputType: "lifecycle-model",
    resultProcessLayer: "lci-lcia",
    firstGeneration: true,
  };
  const current = buildMaterializationIdentity(request);
  const old = {
    ...current.key,
    recipeContractVersion: "result-materialization.v1",
    metadataPolicySha256: hashJson({
      schemaVersion: "tiangong.release.result-metadata-policy.v1",
      missingTextCompatibility: "single-space",
      sourceAdministrativeMetadata: "preserve-compatible",
    }),
  };
  assert.notEqual(hashJson(current.key), hashJson(old));
  assert.deepEqual(buildMaterializationIdentity(request), current);
});
