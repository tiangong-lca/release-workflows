import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashJson, canonicalJson } from "../lib/common.mjs";
import {
  inspectFinalResultInput,
  prepareFinalResultInput,
} from "../lib/final-result-input.mjs";
import { id, version } from "./fixtures/final-result.mjs";
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-result-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/paired-final-results.json", import.meta.url),
    ),
  );
  const canonicalRoot = path.join(root, "canonical");
  await mkdir(canonicalRoot);
  for (const r of fixture.records) {
    const file = path.join(canonicalRoot, r.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, canonicalJson(r.document));
  }
  const datasets = fixture.index.datasets
    .filter((e) => e.role === "result_process")
    .map((e) => ({ ...e, sourceProcess: { id: id(80), version } }));
  const index = {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasets,
  };
  const catalog = {
    schemaVersion: "tiangong.release.result-catalog.v1",
    calculationId: id(50),
    bundleContentHash: "a".repeat(64),
    requiredResults: [{ id: id(80), version }],
    datasets,
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
  return {
    root,
    canonicalRoot,
    index: fixture.index,
    results: fixture.results.map(({ relationKind, sources, ...r }) => r),
    materializationEvidence: { manifest, catalog, index },
    outDir: path.join(root, "frozen"),
  };
}
function registry() {
  const claims = new Map();
  const calls = [];
  let closes = 0;
  return {
    claims,
    calls,
    get closes() {
      return closes;
    },
    createAuthority: () => ({
      versions: async (uuid) => {
        calls.push(["versions", uuid]);
        return {
          resultId: uuid,
          versions: [...claims.values()]
            .filter((r) => r.result.uuid === uuid)
            .map((r) => ({
              version: r.result.version,
              status: "registered",
              hashDomain: r.hashDomain,
              contentHash: r.contentHash,
            })),
          nextBeforeVersion: null,
        };
      },
      register: async (request) => {
        calls.push(["register", request]);
        const key = `${request.result.uuid}@${request.result.version}`;
        if (!claims.has(key))
          claims.set(key, {
            schemaVersion: "tiangong.final-result-identity-receipt.v1",
            registrationId: id(90 + claims.size),
            result: request.result,
            hashDomain: request.hashDomain,
            canonicalContentHash: request.canonicalContentHash,
            contentHash: request.contentHash,
            contentRef: `urn:sha256:${request.canonicalContentHash}`,
            createdAt: "2026-11-01T00:00:00Z",
          });
        return claims.get(key);
      },
      close: async () => {
        closes++;
      },
    }),
  };
}
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
