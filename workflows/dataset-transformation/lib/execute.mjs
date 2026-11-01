import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCandidate, loadProcessInputs } from "./candidate.mjs";
import { fail, hashJson, nearlyEqual } from "./common.mjs";
import { validateContract } from "./contracts.mjs";
import {
  containedPath,
  readJson,
  writeCanonical,
  writeImmutableDirectory,
} from "./io.mjs";
import { aggregateProcesses } from "./process-aggregation.mjs";
import { operationRole } from "./operations.mjs";
import { aggregateResultProcesses } from "./result-aggregation.mjs";

export async function prepareTransformation({ candidateDir, specDir }) {
  const { value: frozenSpec } = await readJson(
    path.join(specDir, "transformation-frozen-spec.json"),
    "transformation_frozen_spec_missing",
  );
  if (
    frozenSpec.schemaVersion !==
      "tiangong.release.dataset-transformation-frozen-spec.v0" ||
    frozenSpec.status !== "frozen"
  )
    fail(
      "transformation_frozen_spec_unsupported",
      "Execution requires a frozen Dataset Transformation DSL v0 spec",
    );
  validateContract("frozenSpec", frozenSpec);
  const frozenSpecSha256 = hashJson(frozenSpec);
  const role = operationRole(frozenSpec.operation.type);
  const candidate = await loadCandidate(candidateDir, { requiredRole: role });
  if (
    candidate.candidateSha256 !==
      frozenSpec.operation.candidate.releaseCandidateSha256 ||
    candidate.indexSha256 !==
      frozenSpec.operation.candidate.canonicalDatasetIndexSha256
  )
    fail(
      "transformation_input_drift",
      "Candidate differs from the hash-bound frozen Transformation spec",
    );
  const inputKeys = frozenSpec.operation.inputs.map(({ key }) => key);
  const inputs = await loadProcessInputs(candidate, inputKeys, { role });
  for (const input of inputs) {
    const bound = frozenSpec.operation.inputs.find(
      ({ key }) => key === input.key,
    );
    if (
      input.entry.sha256 !== bound.sha256 ||
      input.entry.canonicalContentHash !== bound.canonicalContentHash
    )
      fail(
        "transformation_input_drift",
        `Process differs from the frozen Transformation spec: ${input.key}`,
      );
  }
  const aggregate =
    role === "result_process" ? aggregateResultProcesses : aggregateProcesses;
  const result = aggregate({ inputs, frozenSpec, frozenSpecSha256 });
  const validation = validateResult({ result, frozenSpec, inputs, role });
  const relativePath = `canonical-datasets/processes/${frozenSpec.output.identity.uuid}_${frozenSpec.output.identity.version}.json`;
  const dataset = {
    key: `process:${frozenSpec.output.identity.uuid}@${frozenSpec.output.identity.version}`,
    datasetType: "process",
    role,
    uuid: frozenSpec.output.identity.uuid,
    version: frozenSpec.output.identity.version,
    path: relativePath.replace("canonical-datasets/", ""),
    sha256: result.sha256,
    canonicalContentHash: result.canonicalContentHash,
    byteSize: result.bytes.length,
  };
  const receipt = {
    schemaVersion: "tiangong.release.transformation-execution-receipt.v0",
    status: "completed",
    candidate: frozenSpec.operation.candidate,
    transformationFrozenSpecSha256: frozenSpecSha256,
    operation: {
      type: frozenSpec.operation.type,
      inputCount: inputs.length,
      weighting: frozenSpec.operation.weighting,
    },
    output: dataset,
    validation,
    resultEvidence: frozenSpec.resultEvidence,
  };
  const resultRoute = role === "result_process";
  const handoff = {
    schemaVersion: "tiangong.release.transformation-handoff.v0",
    status: resultRoute
      ? "ready_for_result_materialization"
      : "ready_for_calculation",
    parentCandidate: frozenSpec.operation.candidate,
    transformationFrozenSpecSha256: frozenSpecSha256,
    transformationExecutionReceiptSha256: hashJson(receipt),
    transformedDatasets: [dataset],
    inheritedData: {
      mode: "exact-parent-candidate-reference",
      packageSetHash: candidate.candidate.packageSetHash,
    },
    nextWorkflow: resultRoute ? "result-materialization" : "calculation",
    reason: resultRoute
      ? "The weighted Result Process is a Derived Result that requires canonical Result Materialization; no LifecycleModel is synthesized"
      : "The new weighted Unit Process has no valid Result Process or LifecycleModel evidence yet",
    finalTarget: "new-release-candidate",
  };
  validateContract("executionReceipt", receipt);
  validateContract("handoff", handoff);
  return { result, dataset, receipt, handoff, frozenSpec, candidate };
}

export async function executeTransformation({ candidateDir, specDir, outDir }) {
  const { result, dataset, receipt, handoff, frozenSpec } =
    await prepareTransformation({ candidateDir, specDir });
  const relativePath = `canonical-datasets/${dataset.path}`;
  const target = await writeImmutableDirectory(outDir, async (staging) => {
    const outputFile = containedPath(staging, relativePath);
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, result.bytes, { flag: "wx" });
    await writeCanonical(
      path.join(staging, "transformation-frozen-spec.json"),
      frozenSpec,
    );
    await writeCanonical(
      path.join(staging, "transformation-execution-receipt.json"),
      receipt,
    );
    await writeCanonical(
      path.join(staging, "transformation-handoff.json"),
      handoff,
    );
  });
  return {
    path: target,
    dataset,
    receipt,
    receiptSha256: hashJson(receipt),
    handoff,
  };
}

function validateResult({ result, frozenSpec, inputs, role }) {
  const process = result.document.processDataSet;
  const referenceId = String(
    process.processInformation.quantitativeReference.referenceToReferenceFlow,
  );
  const reference = process.exchanges.exchange.find(
    (exchange) => String(exchange["@dataSetInternalID"]) === referenceId,
  );
  const referenceAmount = Number(reference?.resultingAmount);
  const weights = frozenSpec.operation.weighting.values;
  const weightsSum = weights.reduce(
    (sum, { normalized }) => sum + normalized,
    0,
  );
  const ids = process.exchanges.exchange.map((exchange) =>
    String(exchange["@dataSetInternalID"]),
  );
  const checks = {
    inputHashesBound: inputs.every((input) =>
      frozenSpec.operation.inputs.some(
        (bound) =>
          bound.key === input.key &&
          bound.sha256 === input.entry.sha256 &&
          bound.canonicalContentHash === input.entry.canonicalContentHash,
      ),
    ),
    weightsComplete: weights.length === inputs.length,
    weightsNormalized: nearlyEqual(weightsSum, 1),
    referenceAmountNormalized: nearlyEqual(referenceAmount, 1),
    exchangeIdsUnique: new Set(ids).size === ids.length,
    outputIdentityApplied:
      process.processInformation.dataSetInformation["common:UUID"] ===
        frozenSpec.output.identity.uuid &&
      process.administrativeInformation.publicationAndOwnership[
        "common:dataSetVersion"
      ] === frozenSpec.output.identity.version,
    reviewReset:
      process.modellingAndValidation.validation?.review?.["@type"] ===
      "Not reviewed",
    numericAmountsFinite: process.exchanges.exchange.every(
      (exchange) =>
        Number.isFinite(Number(exchange.meanAmount)) &&
        Number.isFinite(Number(exchange.resultingAmount)),
    ),
    outputRoleApplied:
      role === "result_process"
        ? process.modellingAndValidation?.LCIMethodAndAllocation
            ?.typeOfDataSet === "LCI result"
        : process.modellingAndValidation?.LCIMethodAndAllocation
            ?.typeOfDataSet !== "LCI result",
    lciaAmountsFinite:
      role !== "result_process" ||
      resultItems(process).every((item) =>
        Number.isFinite(Number(item.meanAmount ?? item.resultingAmount)),
      ),
    lciaMethodsUnique:
      role !== "result_process" ||
      new Set(
        resultItems(process).map(
          (item) =>
            `${item.referenceToLCIAMethodDataSet?.["@refObjectId"]}@${item.referenceToLCIAMethodDataSet?.["@version"]}`,
        ),
      ).size === resultItems(process).length,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedChecks.length)
    fail(
      "transformation_output_needs_repair",
      "Deterministic output validation found an implementation or output defect",
      { failedChecks },
    );
  return {
    outcome: "passed",
    checks,
    inputCount: inputs.length,
    outputExchangeCount: process.exchanges.exchange.length,
    outputLciaMethodCount: resultItems(process).length,
    referenceAmount,
    weightsSum,
  };
}

function resultItems(process) {
  const value = process.LCIAResults?.LCIAResult;
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}
