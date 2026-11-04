import { readLocalJson } from "../lib/final-result-files.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  truncate,
  appendFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { assembleCanonicalCollection } from "../lib/package-build.mjs";
import { frozenDocument } from "../lib/final-result-artifacts.mjs";
import { finalResultFailure } from "../lib/final-result-command.mjs";
import {
  documentBudget,
  MAX_METHOD_BYTES,
  MAX_METADATA_BYTES,
  MAX_INPUT_PLAN_BYTES,
  checkBudget,
} from "../lib/resource-budget.mjs";

async function setup(t, datasetType) {
  const root = await mkdtemp(path.join(os.tmpdir(), "canonical-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, "calculation-bundle");
  await mkdir(bundle);
  const document = { payload: "x".repeat(9 * 1024 * 1024) };
  const record = {
    datasetType,
    uuid: "00000000-0000-4000-8000-000000000001",
    version: "01.00.000",
    path: `${datasetType}/large.json`,
    document,
    sha256: hashJson(document),
  };
  const bytes = Buffer.from(canonicalJson(record));
  await writeFile(path.join(bundle, "source.ndjson"), bytes);
  return {
    root,
    record,
    input: {
      materializedIndex: { datasets: [] },
      intakeRoot: root,
      intake: {
        artifacts: [
          {
            kind: "source_closure",
            path: "source.ndjson",
            sha256: sha256Bytes(bytes),
            recordCount: 1,
          },
        ],
      },
      canonicalRoot: path.join(root, "canonical"),
      metadataBudgetBytes: MAX_METADATA_BYTES,
      recordBudgetBytes: documentBudget,
    },
  };
}

test("large Method copy succeeds while other document limits remain effective before copy", async (t) => {
  const method = await setup(t, "lciamethod");
  const entries = await assembleCanonicalCollection(method.input);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    await frozenDocument(method.input.canonicalRoot, entries[0]),
    method.record.document,
  );
  const process = await setup(t, "process");
  await assert.rejects(assembleCanonicalCollection(process.input), (error) => {
    assert.equal(error.code, "canonical_document_budget");
    const { budget } = finalResultFailure(error).details;
    assert.equal(budget.path, process.record.path);
    assert.equal(budget.uuid, process.record.uuid);
    assert.equal(
      budget.actualBytes,
      Buffer.byteLength(canonicalJson(process.record.document)),
    );
    assert.equal(budget.limitBytes, 8 * 1024 * 1024);
    return true;
  });
  await assert.rejects(
    stat(path.join(process.input.canonicalRoot, process.record.path)),
    { code: "ENOENT" },
  );
});

test("metadata overflow is distinct and has measured capacity diagnostics", async (t) => {
  const f = await setup(t, "lciamethod");
  await assert.rejects(
    assembleCanonicalCollection({ ...f.input, metadataBudgetBytes: 1 }),
    (error) => {
      assert.equal(error.code, "canonical_metadata_budget");
      const failure = finalResultFailure(error);
      assert.equal(failure.details.budget.kind, "metadata");
      assert.equal(failure.details.budget.limitBytes, 1);
      assert.equal(failure.details.budget.entryCount, 1);
      assert.match(failure.message, /metadata budget exceeded/);
      assert.match(failure.details.budget.recovery, /new output directory/);
      return true;
    },
  );
  await assert.rejects(
    readFile(path.join(f.input.canonicalRoot, f.record.path)),
    { code: "ENOENT" },
  );
});

test("Method cap still rejects oversized frozen files before parsing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "method-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "method.json");
  await writeFile(file, "");
  await truncate(file, MAX_METHOD_BYTES + 1);
  await assert.rejects(
    frozenDocument(root, {
      datasetType: "lciamethod",
      path: "method.json",
      byteSize: MAX_METHOD_BYTES + 1,
    }),
    (error) => {
      assert.equal(error.code, "canonical_document_budget");
      assert.equal(error.details.budget.limitBytes, MAX_METHOD_BYTES);
      return true;
    },
  );
});

test("identity-plan capacity is independent of query metadata and enforced before large reads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-plan-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "input-plan.json");
  await writeFile(file, "{}");
  // Valid JSON larger than the query-index budget without a giant fixture or
  // millions of opaque identity claims. All plan consumers use this read limit.
  const whitespace = Buffer.alloc(1024 * 1024, 32);
  for (let i = 0; i < 128; i++) await appendFile(file, whitespace);
  await assert.rejects(readLocalJson(root, "input-plan.json"), {
    code: "final_metadata_size",
  });
  assert.deepEqual(
    await readLocalJson(root, "input-plan.json", MAX_INPUT_PLAN_BYTES),
    {},
  );
  await truncate(file, MAX_INPUT_PLAN_BYTES + 1);
  await assert.rejects(
    readLocalJson(root, "input-plan.json", MAX_INPUT_PLAN_BYTES),
    { code: "final_metadata_size" },
  );
  assert.throws(
    () =>
      checkBudget(
        "input_plan",
        MAX_INPUT_PLAN_BYTES + 1,
        MAX_INPUT_PLAN_BYTES,
        { path: "input-plan.json" },
      ),
    (error) => {
      const failure = finalResultFailure(error);
      assert.equal(failure.code, "canonical_input_plan_budget");
      assert.equal(failure.details.budget.limitBytes, 512 * 1024 * 1024);
      assert.equal(failure.details.budget.path, "input-plan.json");
      return true;
    },
  );
});
