import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../lib/concurrency.mjs";
import { normalizeCompatibleProcessDocument } from "../lib/process-compat.mjs";
import { validateOneHopReconstruction } from "../lib/reconstruction.mjs";
import {
  indexPreviousModelVariants,
  resolveExactSourceVariantVersions,
} from "../lib/versioning.mjs";

test("process compatibility is explicit and does not mutate source input", () => {
  const source = {
    processDataSet: {
      processInformation: { dataSetInformation: { name: { baseName: [] } } },
    },
  };
  const normalized = normalizeCompatibleProcessDocument(source);
  assert.equal(
    normalized.processDataSet.processInformation.dataSetInformation.name
      .treatmentStandardsRoutes[0]["#text"],
    " ",
  );
  assert.equal(
    normalized.processDataSet.processInformation.dataSetInformation.name
      .mixAndLocationTypes[0]["#text"],
    " ",
  );
  assert.equal(
    source.processDataSet.processInformation.dataSetInformation.name
      .treatmentStandardsRoutes,
    undefined,
  );
});

test("concurrency waits for started workers and preserves the first error", async () => {
  const primary = Object.assign(new Error("primary failure"), {
    code: "primary_failure",
  });
  let siblingFinished = false;
  const started = [];
  await assert.rejects(
    mapWithConcurrency([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 0) {
        await delay(5);
        throw primary;
      }
      await delay(20);
      siblingFinished = true;
    }),
    (error) => error === primary,
  );
  assert.equal(siblingFinished, true);
  assert.deepEqual(started, [0, 1]);
});

test("reconstruction tolerance uses a commensurate inventory scale", () => {
  const large = record("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "kg", 100);
  const cancellation = record(
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "kg",
    1e-7,
  );
  const context = reconstructionContext([large, cancellation], [large]);
  const evidence = validateOneHopReconstruction(context, 0);
  assert.equal(evidence.outcome, "passed");
  assert.equal(evidence.comparisonScale, "direction_and_unit");

  const materialMismatch = reconstructionContext(
    [large, { ...cancellation, meanAmount: 1e-4 }],
    [large],
  );
  assert.throws(
    () => validateOneHopReconstruction(materialMismatch, 0),
    (error) => error.code === "one_hop_reconstruction_mismatch",
  );
});

test("reconstruction absolute floor accepts observed solver residuals", () => {
  const activityRequirement = 29437.900000000005;
  const provider = record(
    "08a91e70-3ddc-11dd-913b-0050c2490048",
    "MJ",
    5.393566845763693e-12,
    "Output",
  );
  const expected = record(
    "08a91e70-3ddc-11dd-913b-0050c2490048",
    "MJ",
    1.5878437669930385e-7,
    "Output",
  );
  const evidence = validateOneHopReconstruction(
    reconstructionContext([provider], [expected], activityRequirement),
    0,
  );
  assert.equal(evidence.absoluteTolerance, 1e-10);
  assert.equal(evidence.relativeTolerance, 1e-8);
  assert.ok(evidence.maxAbsoluteDifference < evidence.maxAllowedDifference);

  const largerObservedResidual = 7.763179844191683e-11;
  const largerResidualEvidence = validateOneHopReconstruction(
    reconstructionContext(
      [record("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "m3", 0.0031355)],
      [
        record(
          "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          "m3",
          0.0031355 + largerObservedResidual,
        ),
      ],
    ),
    0,
  );
  assert.ok(
    largerResidualEvidence.maxAbsoluteDifference <
      largerResidualEvidence.maxAllowedDifference,
  );
});

test("reconstruction tolerance still blocks missing and material inventory", () => {
  const missingFlow = reconstructionContext(
    [],
    [record("ffffffff-ffff-4fff-8fff-ffffffffffff", "kg", 1e-7)],
  );
  assert.throws(
    () => validateOneHopReconstruction(missingFlow, 0),
    (error) => error.code === "one_hop_reconstruction_mismatch",
  );

  const materialDifference = reconstructionContext(
    [record("99999999-9999-4999-8999-999999999999", "kg", 1)],
    [record("99999999-9999-4999-8999-999999999999", "kg", 1.0001)],
  );
  assert.throws(
    () => validateOneHopReconstruction(materialDifference, 0),
    (error) => error.code === "one_hop_reconstruction_mismatch",
  );
});

test("the per-flow warning limit includes its boundary and excludes larger differences", () => {
  const expected = record("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "kg", 100000);
  const compare = (value) =>
    validateOneHopReconstruction(
      reconstructionContext([{ ...expected, meanAmount: value }], [expected]),
      0,
    );
  assert.equal(compare(99999).outcome, "passed_with_warnings");
  assert.throws(() => compare(99998.9), {
    code: "one_hop_reconstruction_mismatch",
  });
  assert.throws(() => compare(Infinity), {
    code: "non_finite_reconstruction_value",
  });
});

test("a near-zero mismatch keeps its own flow scale after exceeding the group tolerance", () => {
  const trace = record("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "kg", 1e-6);
  const large = record("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "kg", 1);
  const context = reconstructionContext(
    [large, trace],
    [large, { ...trace, meanAmount: 1e-15 }],
  );
  assert.throws(
    () => validateOneHopReconstruction(context, 0),
    (error) =>
      error.code === "one_hop_reconstruction_mismatch" &&
      error.details.blockers.length === 1 &&
      error.details.warnings.length === 0,
  );
});

test("model variants keep one lineage and receive exact dataset versions", () => {
  const uuid = "cccccccc-cccc-5ccc-8ccc-cccccccccccc";
  const hash = (value) => value.repeat(64);
  const draft = (processIndex, version, value) => ({
    axis: { processIndex },
    provisional: {
      uuid,
      sourceProcess: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        version,
      },
    },
    hashes: {
      semanticHash: hash(value),
      versionSignificantHash: hash(value),
      canonicalContentHash: hash(value),
    },
  });
  const resolutions = resolveExactSourceVariantVersions(
    [draft(1, "01.01.002", "a"), draft(2, "01.01.003", "b")],
    indexPreviousModelVariants(null),
    {
      datasetType: "lifecyclemodel",
      duplicateCode: "model_source_variant_duplicate",
    },
  );
  assert.equal(resolutions.get(1).version, "01.00.000");
  assert.equal(resolutions.get(2).version, "02.00.000");
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(flowId, unit, meanAmount, direction = "Input") {
  return {
    flow: { id: flowId, version: "01.00.000" },
    direction,
    unit,
    meanAmount,
  };
}

function reconstructionContext(
  providerInventory,
  expectedInventory,
  activityRequirement = 1,
) {
  return {
    biosphere: new Map(),
    technosphereEdges: [
      {
        dependentProcessIndex: 0,
        balancingProcessIndex: 1,
        activityRequirement,
      },
    ],
    lci: new Map([
      [0, expectedInventory],
      [1, providerInventory],
    ]),
  };
}
