import test from "node:test";
import assert from "node:assert/strict";
import { hashJson } from "../lib/common.mjs";
import {
  createFrozenDependencyResolver,
  createFrozenDependencyStore,
  projectFinalResult,
  normalizeWarnings,
  inventoryKey,
  MAX_PROJECTION_WARNINGS,
} from "../lib/final-result-projection.mjs";

import { fixture, id, ref, version } from "./fixtures/final-result.mjs";
function project(f, warningSink = null) {
  return projectFinalResult({
    ...f,
    identity: {
      uuid: id(1),
      version,
      canonicalContentHash: hashJson(f.document),
    },
    resolveDependency: createFrozenDependencyResolver(
      f.dependencies.map((record) => ({
        ...record,
        canonicalContentHash: hashJson(record.document),
      })),
    ),
    warningSink,
  });
}
function rejects(mutator, code) {
  const f = fixture();
  mutator(f);
  assert.throws(() => project(f), { code: `final_result_${code}` });
}

test("independent oracle: reference product excluded, final zero and signed basis retained, no second normalization", () => {
  const result = project(fixture());
  assert.deepEqual(
    result.inventory.map(({ flowId, direction, value }) => ({
      flowId,
      direction,
      value,
    })),
    [
      { flowId: id(3), direction: "Input", value: -3 },
      { flowId: id(3), direction: "Output", value: 0 },
    ],
  );
  assert.equal(result.quantitativeReference.flowId, id(2));
  assert.equal(result.quantitativeReference.direction, "Input");
  assert.equal(result.quantitativeReference.value, -2);
  assert.equal(result.quantitativeReference.unit.name, "kg");
  assert.equal(result.impacts[0].value, 42);
  assert.equal(result.impacts[0].unit, "kg CO2 equivalents");
  assert.equal(result.semanticDependencies.length, 5);
});

test("reference selected by internal ID, not by Flow UUID", () => {
  const f = fixture();
  f.document.processDataSet.exchanges.exchange[0].referenceToFlowDataSet =
    ref(3);
  assert.equal(project(f).inventory.length, 2);
});

test("final amount is mandatory; malformed values never fall back to meanAmount", () => {
  for (const value of [
    undefined,
    null,
    "",
    " ",
    false,
    "NaN",
    "Infinity",
    "0x10",
    "1e400",
    {},
  ])
    rejects((f) => {
      f.document.processDataSet.exchanges.exchange[1].resultingAmount = value;
    }, "invalid_final_amount");
  rejects((f) => {
    f.document.processDataSet.exchanges.exchange[1].resultingAmount = "1e-400";
  }, "amount_underflow");
});

test("nonfinite LCIA, missing and duplicate methods cannot shrink the method set", () => {
  rejects((f) => {
    f.document.processDataSet.LCIAResults.LCIAResult = [];
  }, "impact_set_mismatch");
  rejects((f) => {
    f.document.processDataSet.LCIAResults.LCIAResult.push(
      f.document.processDataSet.LCIAResults.LCIAResult[0],
    );
  }, "impact_set_mismatch");
  rejects((f) => {
    f.document.processDataSet.LCIAResults.LCIAResult[0].meanAmount = "NaN";
  }, "invalid_final_amount");
});

test("LCI-only requires an explicit absent LCIA layer, complete zero inventory is valid", () => {
  const f = fixture();
  f.layer = "lci";
  f.expectedMethods = [];
  delete f.document.processDataSet.LCIAResults;
  f.document.processDataSet.exchanges.exchange[2].resultingAmount = "0";
  assert.deepEqual(project(f).impacts, []);
  assert.deepEqual(
    project(f).inventory.map((row) => row.value),
    [0, 0],
  );
  f.document.processDataSet.LCIAResults =
    fixture().document.processDataSet.LCIAResults;
  assert.throws(() => project(f), { code: "final_result_impact_set_mismatch" });
});

test("unknown/product inventory, duplicate keys and unresolved references fail", () => {
  rejects((f) => {
    f.document.processDataSet.exchanges.exchange[1].referenceToFlowDataSet =
      ref(2);
  }, "non_elementary_inventory");
  rejects((f) => {
    f.document.processDataSet.exchanges.exchange[2].exchangeDirection =
      "Output";
  }, "duplicate_inventory_key");
  rejects((f) => {
    f.document.processDataSet.processInformation.quantitativeReference.referenceToReferenceFlow =
      "99";
  }, "non_elementary_inventory");
  rejects((f) => {
    f.dependencies = f.dependencies.filter(
      (r) => r.datasetType !== "unitgroup",
    );
  }, "dependency_missing");
  rejects((f) => {
    f.document.processDataSet.exchanges.exchange[0].resultingAmount = "0";
  }, "zero_reference");
});

test("units are resolved from exact frozen dependencies, ambiguous references rejected", () => {
  rejects((f) => {
    const units = f.dependencies[3].document.unitGroupDataSet.units.unit;
    units.push(structuredClone(units[0]));
  }, "duplicate_internal_id");
  rejects((f) => {
    delete f.document.processDataSet.exchanges.exchange[1]
      .referenceToFlowDataSet["@version"];
  }, "invalid_exact_identity");
});

test("semantic dimensions remain distinct and zero/negative/small nonzero values survive", () => {
  const f = fixture();
  const exchanges = f.document.processDataSet.exchanges.exchange;
  exchanges[2].exchangeDirection = "Output";
  exchanges[2].location = "CN";
  exchanges[2].functionType = "General reminder flow";
  exchanges[2].resultingAmount = "1e-250";
  const rows = project(f).inventory;
  assert.equal(new Set(rows.map(inventoryKey)).size, 2);
  assert.ok(rows.some((row) => row.value === 1e-250));
});

test("projection is deterministic and does not mutate input; content or dependency changes invalidate identity binding", () => {
  const f = fixture();
  const before = structuredClone(f);
  const first = project(f);
  assert.deepEqual(project(f), first);
  assert.deepEqual(f, before);
  f.document.processDataSet.exchanges.exchange[2].resultingAmount = "-6";
  assert.notEqual(project(f).contentHash, first.contentHash);
  f.document = before.document;
  f.dependencies[3].document.unitGroupDataSet.units.unit[0].name = "kilogram";
  assert.notEqual(project(f).contentHash, first.contentHash);
});

test("resolver rejects spoofed identities/hashes and isolates callers from later mutation", () => {
  const f = fixture();
  const records = f.dependencies.map((record) => ({
    ...record,
    canonicalContentHash: hashJson(record.document),
  }));
  assert.throws(
    () =>
      createFrozenDependencyResolver([
        { ...records[0], canonicalContentHash: "0".repeat(64) },
      ]),
    { code: "final_result_dependency_hash_mismatch" },
  );
  assert.throws(
    () => createFrozenDependencyResolver([{ ...records[0], uuid: id(99) }]),
    { code: "final_result_dependency_identity_mismatch" },
  );
  const resolve = createFrozenDependencyResolver(records);
  records[0].document.flowDataSet.modellingAndValidation.LCIMethod.typeOfDataSet =
    "changed";
  assert.equal(
    resolve("flow", ref(2)).document.flowDataSet.modellingAndValidation
      .LCIMethod.typeOfDataSet,
    "Product flow",
  );
});

test("large Method factors retain full identity binding without repeated document copies", () => {
  const f = fixture();
  const method = f.dependencies.find((d) => d.datasetType === "lciamethod");
  method.document.LCIAMethodDataSet.characterisationFactors = {
    payload: "x".repeat(9 * 1024 * 1024),
  };
  const records = f.dependencies.map((r) => ({
    ...r,
    canonicalContentHash: hashJson(r.document),
  }));
  const store = createFrozenDependencyStore();
  const retained = records.reduce((n, r) => n + store.add(r), 0);
  assert.ok(retained < 16 * 1024);
  const mref = { "@refObjectId": method.uuid, "@version": method.version };
  const entry = store.resolve("lciamethod", mref);
  assert.strictEqual(store.resolve("lciamethod", mref), entry);
  assert.equal(entry.contentHash, hashJson(method.document));
  assert.equal(
    entry.document.LCIAMethodDataSet.characterisationFactors,
    undefined,
  );
  assert.throws(() => {
    entry.document.LCIAMethodDataSet.LCIAMethodInformation.quantitativeReference.referenceQuantity =
      {};
  }, TypeError);
  const input = {
    ...f,
    identity: {
      uuid: id(1),
      version,
      canonicalContentHash: hashJson(f.document),
    },
  };
  const compact = projectFinalResult({
    ...input,
    resolveDependency: store.resolve,
  });
  const full = projectFinalResult({
    ...input,
    resolveDependency: (kind, reference) => {
      const record = records.find(
        (r) =>
          r.datasetType === kind &&
          r.uuid === reference["@refObjectId"] &&
          r.version === reference["@version"],
      );
      return {
        key: `${kind}:${record.uuid}@${record.version}`,
        contentHash: record.canonicalContentHash,
        document: record.document,
      };
    },
  });
  assert.deepEqual(compact, full);
  assert.throws(
    () =>
      projectFinalResult({
        ...input,
        resolveDependency: (kind, ref) =>
          structuredClone(store.resolve(kind, ref)),
      }),
    { code: "final_result_dependency_binding_mismatch" },
  );
  method.document.LCIAMethodDataSet.characterisationFactors.payload = "changed";
  assert.notDeepEqual(
    project(f).semanticDependencies,
    compact.semanticDependencies,
  );
});

test("non-unit reference property and unit are warnings, not projection changes", () => {
  const f = fixture();
  f.dependencies[0].document.flowDataSet.flowProperties.flowProperty[0].meanValue =
    "2";
  f.dependencies[3].document.unitGroupDataSet.units.unit[0].meanValue = "1000";
  const warnings = [];
  const result = project(f, (record) => warnings.push(record));
  const normalized = normalizeWarnings(warnings);
  assert.deepEqual([...new Set(normalized.map((w) => w.code))].sort(), [
    "nonunit_reference_property",
    "nonunit_reference_unit",
  ]);
  assert.ok(
    normalized.some(
      (w) =>
        w.code === "nonunit_reference_property" &&
        /has meanValue 2/u.test(w.message),
    ),
  );
  assert.ok(
    normalized.every((w) => /kept as-is without conversion/u.test(w.message)),
  );
  assert.equal(Object.hasOwn(result, "warnings"), false);
  assert.deepEqual(result, project(f));
});

test("clean fixture emits no warnings", () => {
  const warnings = [];
  project(fixture(), (record) => warnings.push(record));
  assert.deepEqual(normalizeWarnings(warnings), []);
});

test("warnings are deduplicated, sorted and bounded", () => {
  const duplicate = { code: "nonunit_reference_property", message: "same" };
  assert.deepEqual(normalizeWarnings([duplicate, duplicate]), [duplicate]);
  const records = Array.from(
    { length: MAX_PROJECTION_WARNINGS + 5 },
    (_, i) => ({
      code: "nonunit_reference_property",
      message: `warning ${String(i).padStart(2, "0")}`,
    }),
  );
  const normalized = normalizeWarnings(records);
  assert.equal(normalized.length, MAX_PROJECTION_WARNINGS + 1);
  assert.equal(normalized.at(-1).code, "warnings_truncated");
  assert.match(normalized.at(-1).message, /5 additional/u);
  assert.deepEqual(
    normalized.slice(0, 2).map((w) => w.message),
    ["warning 00", "warning 01"],
  );
});

test("malformed reference meanValue remains fatal", () => {
  rejects((f) => {
    f.dependencies[0].document.flowDataSet.flowProperties.flowProperty[0].meanValue =
      "NaN";
  }, "invalid_final_amount");
});
