import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { resolveFinalResultLineage } from "../lib/final-result-lineage.mjs";
import { id, version } from "./fixtures/final-result.mjs";
const h = (n) => String(n).repeat(64);
function direct() {
  const datasets = [1, 2].map((n) => ({
    datasetType: "process",
    role: "result_process",
    uuid: id(n),
    version,
    canonicalContentHash: h(n),
    sourceProcess: { id: id(80 + n), version },
  }));
  const index = {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasets: datasets.map((d) => ({ ...d, sha256: h(3) })),
  };
  const catalog = {
    schemaVersion: "tiangong.release.result-catalog.v1",
    calculationId: id(50),
    bundleContentHash: h(4),
    datasets,
    requiredResults: datasets.map((d) => d.sourceProcess),
  };
  const manifest = {
    schemaVersion: "tiangong.release.materialization-manifest.v1",
    inputs: {
      calculationId: catalog.calculationId,
      bundleContentHash: catalog.bundleContentHash,
      resultCatalogSha256: hashJson(catalog),
      canonicalDatasetIndexSha256: hashJson(index),
    },
    datasets,
    validation: { sourceDocuments: "verified", resultReferences: "verified" },
  };
  return { manifest, catalog, index };
}
function derived() {
  const materialization = direct();
  const packagePlan = {
    materialization: {
      manifestSha256: hashJson(materialization.manifest),
      canonicalDatasetIndexSha256: hashJson(materialization.index),
    },
  };
  const candidate = {
    schemaVersion: "tiangong.release.release-candidate.v2",
    status: "local_candidate",
    publicationAuthorized: false,
    validation: { outcome: "passed" },
    canonicalDatasetIndexSha256: hashJson(materialization.index),
    packagePlanSha256: hashJson(packagePlan),
  };
  const parent = {
    candidate,
    candidateIndex: materialization.index,
    packagePlan,
    materialization,
  };
  const parentCandidate = {
    releaseCandidateSha256: hashJson(candidate),
    canonicalDatasetIndexSha256: candidate.canonicalDatasetIndexSha256,
  };
  const parents = materialization.index.datasets.map(
    ({ uuid, version, canonicalContentHash, sha256 }) => ({
      uuid,
      version,
      canonicalContentHash,
      sha256,
    }),
  );
  const descriptor = {
    datasetType: "process",
    role: "result_process",
    uuid: id(10),
    version,
    canonicalContentHash: h(5),
    relationKind: "derived",
    parentResults: parents,
    sourceAssociation: { status: "requires_verified_parent_lineage" },
  };
  const output = {
    datasetType: "process",
    role: "result_process",
    uuid: id(10),
    version,
    canonicalContentHash: h(5),
    sha256: h(6),
  };
  const frozenSpec = {
    operation: {
      type: "result-process.weighted-aggregate.v0",
      candidate: parentCandidate,
      inputs: parents,
    },
    output: { identity: { uuid: id(10), version } },
  };
  const executionReceipt = {
    status: "completed",
    transformationFrozenSpecSha256: hashJson(frozenSpec),
    output,
  };
  const handoff = {
    status: "ready_for_result_materialization",
    nextWorkflow: "result-materialization",
    transformationFrozenSpecSha256: hashJson(frozenSpec),
    transformationExecutionReceiptSha256: hashJson(executionReceipt),
    transformedDatasets: [output],
  };
  const source = {
    parentCandidate,
    transformationFrozenSpecSha256: hashJson(frozenSpec),
    transformationExecutionReceiptSha256: hashJson(executionReceipt),
    transformationHandoffSha256: hashJson(handoff),
  };
  const index = {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasets: [output],
  };
  const catalog = {
    schemaVersion: "tiangong.release.result-catalog.v2",
    source,
    datasets: [descriptor],
  };
  const manifest = {
    schemaVersion: "tiangong.release.materialization-manifest.v2",
    inputKind: "verified-derived-result",
    source,
    inputs: { resultCatalogSha256: hashJson(catalog) },
    canonicalDatasetIndexSha256: hashJson(index),
    datasets: [descriptor],
    validation: { producerReplay: "verified", transformedBytes: "verified" },
  };
  return {
    manifest,
    catalog,
    index,
    parent,
    transformation: { frozenSpec, executionReceipt, handoff },
  };
}
test("direct association is the exact producer source, not a parsed comment or Result identity", () => {
  const input = direct();
  const result = resolveFinalResultLineage(input);
  assert.deepEqual(
    result.results.map((r) => r.sources),
    [[{ uuid: id(81), version }], [{ uuid: id(82), version }]],
  );
  assert.ok(result.results.every((r) => r.relationKind === "direct"));
  assert.equal(result.parentCandidateHash, null);
  input.catalog.datasets[0].sourceProcess = { id: id(90), version };
  assert.throws(() => resolveFinalResultLineage(input), {
    code: "final_result_lineage_evidence_invalid",
  });
});
test("derived association unions hash-bound parent sources and retains derived identity", () => {
  const input = derived();
  const output = resolveFinalResultLineage(input);
  assert.equal(output.results[0].uuid, id(10));
  assert.equal(output.results[0].relationKind, "derived");
  assert.deepEqual(output.results[0].sources, [
    { uuid: id(81), version },
    { uuid: id(82), version },
  ]);
  assert.equal(output.parentCandidateHash, hashJson(input.parent.candidate));
});
test("legacy parent requires its original package-bound Materialization witness", () => {
  for (const mutate of [
    (x) => {
      delete x.parent.materialization;
    },
    (x) => {
      x.parent.packagePlan.materialization.manifestSha256 = h(8);
    },
    (x) => {
      x.parent.materialization.catalog.requiredResults = [];
    },
    (x) => {
      x.transformation.frozenSpec.operation.inputs[0].sha256 = h(7);
    },
    (x) => {
      delete x.transformation;
    },
    (x) => {
      x.parent.candidateIndex.datasets[0].version = "01.00.001";
    },
  ]) {
    const input = derived();
    mutate(input);
    assert.throws(() => resolveFinalResultLineage(input));
  }
});
test("a v3 parent must bind its structured final input; sources never become a direct substitute", () => {
  const input = derived();
  const finalInput = {
    schemaVersion: "tiangong.release.final-result-input.v2",
    results: input.parent.candidateIndex.datasets.map((d) => ({
      uuid: d.uuid,
      version: d.version,
      canonicalContentHash: d.canonicalContentHash,
      relationKind: "derived",
      sources: [
        { uuid: id(80), version },
        { uuid: id(81), version },
      ],
    })),
  };
  input.parent.finalInput = finalInput;
  input.parent.candidate.schemaVersion =
    "tiangong.release.release-candidate.v3";
  input.parent.candidate.finalInput = { sha256: hashJson(finalInput) };
  const parentCandidate = {
    releaseCandidateSha256: hashJson(input.parent.candidate),
    canonicalDatasetIndexSha256: hashJson(input.parent.candidateIndex),
  };
  input.transformation.frozenSpec.operation.candidate = parentCandidate;
  const t = input.transformation;
  t.executionReceipt.transformationFrozenSpecSha256 = hashJson(t.frozenSpec);
  t.handoff.transformationFrozenSpecSha256 = hashJson(t.frozenSpec);
  t.handoff.transformationExecutionReceiptSha256 = hashJson(t.executionReceipt);
  Object.assign(input.manifest.source, {
    parentCandidate,
    transformationFrozenSpecSha256: hashJson(t.frozenSpec),
    transformationExecutionReceiptSha256: hashJson(t.executionReceipt),
    transformationHandoffSha256: hashJson(t.handoff),
  });
  input.manifest.inputs.resultCatalogSha256 = hashJson(input.catalog);
  const result = resolveFinalResultLineage(input).results[0];
  assert.equal(result.relationKind, "derived");
  assert.deepEqual(result.sources, [
    { uuid: id(80), version },
    { uuid: id(81), version },
  ]);
  input.parent.finalInput.results[0].sources = [{ uuid: id(90), version }];
  assert.throws(() => resolveFinalResultLineage(input), {
    code: "final_result_lineage_evidence_invalid",
  });
});

test("one-hop Model producer binds catalog file bytes while Result-only binds content", () => {
  const input = direct();
  const model = {
    datasetType: "lifecyclemodel",
    role: "lifecycle_model",
    uuid: id(90),
    version,
    canonicalContentHash: h(7),
  };
  input.manifest.datasets = [...input.manifest.datasets, model];
  input.index.datasets.push(model);
  input.manifest.inputs.canonicalDatasetIndexSha256 = hashJson(input.index);
  input.manifest.profiles = {
    model: "resolved-one-hop-aggregated-background.v1",
  };
  Object.assign(input.manifest.validation, {
    modelSchemas: "passed",
    oneHopReconstruction: "passed",
  });
  input.manifest.inputs.resultCatalogSha256 = sha256Bytes(
    Buffer.from(canonicalJson(input.catalog)),
  );
  assert.equal(resolveFinalResultLineage(input).results.length, 2);
  for (const mutate of [
    (f) => {
      f.catalog.requiredResults.pop();
    },
    (f) => {
      f.manifest.profiles.model = "unknown";
    },
    (f) => {
      f.manifest.inputs.resultCatalogSha256 = hashJson(f.catalog);
    },
    (f) => {
      f.manifest.validation.oneHopReconstruction = "failed";
    },
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    assert.throws(() => resolveFinalResultLineage(changed), {
      code: "final_result_lineage_evidence_invalid",
    });
  }
  const resultOnly = direct();
  resultOnly.manifest.inputs.resultCatalogSha256 = sha256Bytes(
    Buffer.from(canonicalJson(resultOnly.catalog)),
  );
  assert.throws(() => resolveFinalResultLineage(resultOnly), {
    code: "final_result_lineage_evidence_invalid",
  });
});
