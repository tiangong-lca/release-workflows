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
import { setup, registry } from "./fixtures/final-input.mjs";
test("final input freezes only after exact confirmation, authoritative occupancy and receipt verification", async (t) => {
  const input = await setup(t);
  const authority = registry();
  const plan = await inspectFinalResultInput(input);
  await assert.rejects(
    prepareFinalResultInput({
      ...input,
      confirmInputHash: "0".repeat(64),
      createAuthority: authority.createAuthority,
    }),
    { code: "final_input_confirmation_mismatch" },
  );
  assert.equal(authority.calls.length, 0);
  const { input: frozen } = await prepareFinalResultInput({
    ...input,
    confirmInputHash: plan.inputHash,
    createAuthority: authority.createAuthority,
  });
  assert.equal(frozen.inputHash, plan.inputHash);
  assert.equal(frozen.results.length, 3);
  assert.equal(frozen.candidateQualified, false);
  assert.equal(frozen.publicationAuthorized, false);
  assert.ok(
    frozen.results.every(
      (r) => r.identityReceipt.contentHash === r.contentHash,
    ),
  );
  assert.deepEqual(
    authority.calls.map((c) => c[0]),
    ["versions", "register", "versions", "register", "versions", "register"],
  );
  assert.equal(authority.closes, 1);
  const persisted = JSON.parse(
    await readFile(path.join(input.outDir, "final-result-input.json")),
  );
  assert.deepEqual(persisted, frozen);
  assert.ok(frozen.selection.every((r) => r.sources[0].uuid === id(80)));
  await assert.rejects(
    prepareFinalResultInput({
      ...input,
      confirmInputHash: plan.inputHash,
      createAuthority: authority.createAuthority,
    }),
    { code: "output_exists" },
  );
});
test("caller lineage overrides and changed source bytes never open a registry connection", async (t) => {
  const input = await setup(t);
  const authority = registry();
  let plan = await inspectFinalResultInput(input);
  await assert.rejects(
    prepareFinalResultInput({
      ...input,
      results: input.results.map((r) => ({
        ...r,
        sources: [{ uuid: id(70), version }],
      })),
      confirmInputHash: plan.inputHash,
      createAuthority: authority.createAuthority,
    }),
    { code: "final_input_invalid" },
  );
  const entry = input.index.datasets.find((r) => r.role === "result_process");
  await writeFile(path.join(input.canonicalRoot, entry.path), "{}");
  await assert.rejects(
    prepareFinalResultInput({
      ...input,
      confirmInputHash: plan.inputHash,
      createAuthority: authority.createAuthority,
    }),
  );
  assert.equal(authority.calls.length, 0);
});
test("partial or unknown registration retains exact requests and resumes by identical claims", async (t) => {
  const input = await setup(t);
  const authority = registry();
  const plan = await inspectFinalResultInput(input);
  let error;
  let attempted = 0;
  try {
    await prepareFinalResultInput({
      ...input,
      confirmInputHash: plan.inputHash,
      createAuthority: () => {
        const client = authority.createAuthority();
        const original = client.register;
        client.register = async (r) => {
          const receipt = await original(r);
          if (++attempted === 2)
            throw Object.assign(new Error("lost acknowledgement"), {
              code: "final_identity_outcome_unknown",
            });
          return receipt;
        };
        client.close = async () => {
          throw new Error("private pool shutdown diagnostics");
        };
        return client;
      },
    });
  } catch (e) {
    error = e;
  }
  assert.equal(error.code, "final_identity_outcome_unknown");
  assert.equal(authority.claims.size, 2);
  const planOnDisk = JSON.parse(
    await readFile(path.join(error.details.retainedInput, "input-plan.json")),
  );
  assert.deepEqual(planOnDisk.registrations, plan.registrations);
  const receiptLines = (
    await readFile(
      path.join(error.details.retainedInput, "registration-receipts.ndjson"),
      "utf8",
    )
  )
    .trim()
    .split("\n");
  assert.equal(receiptLines.length, 1);
  await assert.rejects(
    readFile(path.join(input.outDir, "final-result-input.json")),
    { code: "ENOENT" },
  );
  const { input: final } = await prepareFinalResultInput({
    ...input,
    confirmInputHash: plan.inputHash,
    createAuthority: authority.createAuthority,
  });
  assert.equal(final.results.length, 3);
  assert.equal(authority.claims.size, 3);
  assert.equal(
    final.results[0].identityReceipt.registrationId,
    JSON.parse(receiptLines[0]).receipt.registrationId,
  );
});
test("occupied legacy or changed-content version is rejected before registration or final freeze", async (t) => {
  const input = await setup(t);
  const plan = await inspectFinalResultInput(input);
  let registrations = 0;
  for (const status of ["legacy_requires_equivalence", "registered"]) {
    await assert.rejects(
      prepareFinalResultInput({
        ...input,
        confirmInputHash: plan.inputHash,
        createAuthority: () => ({
          versions: async (uuid) => ({
            resultId: uuid,
            versions: [
              {
                version: input.results[0].version,
                status,
                hashDomain: plan.registrations[0].hashDomain,
                contentHash: "0".repeat(64),
              },
            ],
          }),
          register: async () => {
            registrations++;
          },
          close: async () => {},
        }),
      }),
      { code: "final_input_version_occupied" },
    );
  }
  assert.equal(registrations, 0);
  await assert.rejects(
    readFile(path.join(input.outDir, "final-result-input.json")),
    { code: "ENOENT" },
  );
});

test("shutdown errors cannot revoke an already frozen input", async (t) => {
  const input = await setup(t);
  const authority = registry();
  const plan = await inspectFinalResultInput(input);
  const result = await prepareFinalResultInput({
    ...input,
    confirmInputHash: plan.inputHash,
    createAuthority: () => ({
      ...authority.createAuthority(),
      close: async () => {
        throw new Error("private shutdown error");
      },
    }),
  });
  assert.equal(result.input.inputHash, plan.inputHash);
  assert.equal(authority.claims.size, 3);
  assert.equal(
    JSON.parse(
      await readFile(path.join(input.outDir, "final-result-input.json")),
    ).inputHash,
    plan.inputHash,
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

  const authority = registry();
  const frozen = await prepareFinalResultInput({
    ...input,
    confirmInputHash: plan.inputHash,
    createAuthority: authority.createAuthority,
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
