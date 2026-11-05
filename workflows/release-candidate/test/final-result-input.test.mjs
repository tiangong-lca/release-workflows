import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  inspectFinalResultInput,
  prepareFinalResultInput,
} from "../lib/final-result-input.mjs";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { id, version } from "./fixtures/final-result.mjs";
import { setup } from "./fixtures/final-input.mjs";
test("final input freezes only after exact confirmation and local content verification", async (t) => {
  const input = await setup(t);
  const plan = await inspectFinalResultInput(input);
  await assert.rejects(
    prepareFinalResultInput({
      ...input,
      confirmInputHash: "0".repeat(64),
    }),
    { code: "final_input_confirmation_mismatch" },
  );
  const { input: frozen } = await prepareFinalResultInput({
    ...input,
    confirmInputHash: plan.inputHash,
  });
  assert.equal(frozen.inputHash, plan.inputHash);
  assert.equal(frozen.results.length, 3);
  assert.equal(frozen.candidateQualified, false);
  assert.equal(frozen.publicationAuthorized, false);
  assert.deepEqual(
    frozen.results.map((r) => r.contentHash),
    plan.content.map((r) => r.contentHash),
  );
  assert.ok(
    frozen.results.every((row) => !Object.hasOwn(row, "identityReceipt")),
  );
  await assert.rejects(
    readFile(path.join(input.outDir, "registration-receipts.ndjson")),
    { code: "ENOENT" },
  );
  const persisted = JSON.parse(
    await readFile(path.join(input.outDir, "final-result-input.json")),
  );
  assert.deepEqual(persisted, frozen);
  assert.ok(frozen.selection.every((r) => r.sources[0].uuid === id(80)));
  await assert.rejects(
    prepareFinalResultInput({
      ...input,
      confirmInputHash: plan.inputHash,
    }),
    { code: "output_exists" },
  );
});
test("caller lineage overrides and changed source bytes are rejected locally", async (t) => {
  const input = await setup(t);
  let plan = await inspectFinalResultInput(input);
  await assert.rejects(
    prepareFinalResultInput({
      ...input,
      results: input.results.map((r) => ({
        ...r,
        sources: [{ uuid: id(70), version }],
      })),
      confirmInputHash: plan.inputHash,
    }),
    { code: "final_input_invalid" },
  );
  const entry = input.index.datasets.find((r) => r.role === "result_process");
  await writeFile(path.join(input.canonicalRoot, entry.path), "{}");
  await assert.rejects(
    prepareFinalResultInput({
      ...input,
      confirmInputHash: plan.inputHash,
    }),
  );
});
test("non-unit warnings stay out of the plan hash and frozen input", async (t) => {
  const input = await setup(t);
  const entry = input.index.datasets.find((e) => e.datasetType === "unitgroup");
  const file = path.join(input.canonicalRoot, entry.path);
  const document = JSON.parse(await readFile(file, "utf8"));
  const unitGroup = document.unitGroupDataSet;
  const pivot =
    unitGroup.unitGroupInformation.quantitativeReference
      .referenceToReferenceUnit;
  const units = Array.isArray(unitGroup.units.unit)
    ? unitGroup.units.unit
    : [unitGroup.units.unit];
  const referenceUnit = units.find(
    (unit) => String(unit["@dataSetInternalID"]) === String(pivot),
  );
  referenceUnit.meanValue = "1000";
  const bytes = Buffer.from(canonicalJson(document));
  await writeFile(file, bytes);
  entry.byteSize = bytes.length;
  entry.sha256 = sha256Bytes(bytes);
  entry.canonicalContentHash = hashJson(document);

  const warnings = [];
  const plan = await inspectFinalResultInput({
    ...input,
    warningSink: (record) => warnings.push(record),
  });
  assert.deepEqual(await inspectFinalResultInput(input), plan);
  assert.equal(Object.hasOwn(plan, "warnings"), false);
  assert.ok(warnings.some((w) => w.code === "nonunit_reference_unit"));

  const frozen = await prepareFinalResultInput({
    ...input,
    confirmInputHash: plan.inputHash,
  });
  assert.ok(frozen.warnings.some((w) => w.code === "nonunit_reference_unit"));
  const planFile = JSON.parse(
    await readFile(path.join(input.outDir, "input-plan.json")),
  );
  const inputFile = JSON.parse(
    await readFile(path.join(input.outDir, "final-result-input.json")),
  );
  assert.equal(Object.hasOwn(planFile, "warnings"), false);
  assert.equal(Object.hasOwn(inputFile, "warnings"), false);
  assert.equal(inputFile.inputHash, plan.inputHash);
});
