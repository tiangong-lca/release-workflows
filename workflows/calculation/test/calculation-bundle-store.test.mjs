import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createCalculationBundleStore,
  downloadCalculationBundle,
} from "../adapters/calculation-bundle-store.mjs";
import { syncDataPlaneEnvironment } from "../runtime/environment-bootstrap.mjs";

const packageId = "28932bc0-dcb0-4819-901a-5eaefcc51433";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function row() {
  return {
    id: packageId,
    package_version: "lcia-result-test",
    status: "preview_ready",
    snapshot_id: "e0009026-7ed4-4e15-a3a2-eb6eb0abe8f9",
    result_id: "08140875-5831-4b1c-a41d-d06036356f48",
    created_at: new Date("2026-08-18T09:16:39Z"),
    artifact_manifest: {
      calculationBundle: {
        schemaVersion: "tiangong.calculation-bundle.v2",
        bundleContentHash: "a".repeat(64),
        manifestUrl: "s3://lca_results/bundle/calculation-bundle.json",
        manifestSha256: "b".repeat(64),
        manifestByteSize: 74274,
        artifactCount: 140,
        downloads: [
          {
            role: "lcia_results_xlsx",
            fileName: "lcia-results.xlsx",
            artifactUrl: "s3://lca_results/bundle/downloads/lcia-results.xlsx",
            sha256: "c".repeat(64),
            byteSize: 10,
            recordCount: 1,
          },
        ],
      },
    },
    available_impact_categories: ["impact"],
  };
}

test("database list is bounded, parameterized, and strips storage locators", async () => {
  const calls = [];
  let ended = false;
  const store = createCalculationBundleStore({
    env: {},
    poolFactory: () => ({
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        return { rows: [row(), row()] };
      },
      async end() {
        ended = true;
      },
    }),
  });
  const result = await store.list(1);
  assert.deepEqual(calls[0].parameters, [2]);
  assert.match(calls[0].sql, /limit \$1/);
  assert.equal(result.items.length, 1);
  assert.equal(result.completeness.mayHaveMore, true);
  assert.equal("storage" in result.items[0], false);
  assert.equal("productDownloads" in result.items[0], false);
  assert.equal(result.items[0].productDownloadCount, 1);
  assert.equal(ended, true);
});

test("exact database get uses a UUID parameter and exposes locators only internally", async () => {
  let call;
  const store = createCalculationBundleStore({
    env: {},
    poolFactory: () => ({
      async query(sql, parameters) {
        call = { sql, parameters };
        return { rows: [row()] };
      },
      async end() {},
    }),
  });
  const result = await store.get(packageId, { includeLocators: true });
  assert.deepEqual(call.parameters, [packageId]);
  assert.match(call.sql, /\$1::uuid/);
  assert.equal(result.storage.manifestUrl.startsWith("s3://"), true);
  assert.equal(
    result.productDownloads[0].artifactUrl.startsWith("s3://"),
    true,
  );
});

test("environment sync copies only missing allowlisted keys without exposing values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-env-test-"));
  const source = path.join(root, "workspace.env");
  const target = path.join(root, "release.env");
  await writeFile(
    source,
    "CONN=postgres://secret\nS3_BUCKET=lca_results\nUNRELATED_SECRET=do-not-copy\n",
  );
  await writeFile(target, "CONN=postgres://preserved\n");
  const result = await syncDataPlaneEnvironment({ source, target });
  const text = await readFile(target, "utf8");
  assert.deepEqual(result.copiedKeys, ["S3_BUCKET"]);
  assert.deepEqual(result.preservedKeys, ["CONN"]);
  assert.equal(result.valuesExposed, false);
  assert.match(text, /CONN=postgres:\/\/preserved/);
  assert.match(text, /S3_BUCKET="?lca_results"?/);
  assert.doesNotMatch(text, /UNRELATED_SECRET|do-not-copy/);
});

test("direct S3 download verifies manifest and artifacts and writes a receipt", async () => {
  const artifactBytes = Buffer.from('{"value":1}\n');
  const artifact = {
    kind: "lci",
    path: "chunks/lci-00000.jsonl",
    sha256: sha256(artifactBytes),
    byteSize: artifactBytes.length,
  };
  const manifest = {
    schemaVersion: "tiangong.calculation-bundle.v2",
    bundleContentHash: "d".repeat(64),
    artifacts: [artifact],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const objects = new Map([
    ["bundle/calculation-bundle.json", manifestBytes],
    ["bundle/chunks/lci-00000.jsonl", artifactBytes],
  ]);
  const requested = [];
  const s3Client = {
    async send(command) {
      requested.push(command.input.Key);
      const bytes = objects.get(command.input.Key);
      assert.ok(bytes, `unexpected object ${command.input.Key}`);
      return { Body: Readable.from(bytes) };
    },
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "bundle-download-test-"));
  const result = await downloadCalculationBundle({
    metadata: {
      packageId,
      packageVersion: "test",
      bundle: {
        schemaVersion: manifest.schemaVersion,
        bundleContentHash: manifest.bundleContentHash,
        manifestSha256: sha256(manifestBytes),
        manifestByteSize: manifestBytes.length,
        artifactCount: 1,
      },
      storage: {
        manifestUrl: "s3://lca_results/bundle/calculation-bundle.json",
      },
      productDownloads: [],
    },
    outDir: root,
    env: { S3_BUCKET: "lca_results" },
    s3Client,
    concurrency: 2,
  });
  assert.deepEqual(requested, [
    "bundle/calculation-bundle.json",
    "bundle/chunks/lci-00000.jsonl",
  ]);
  assert.equal(result.receipt.verification.artifacts, "verified");
  assert.equal(
    await readFile(path.join(root, artifact.path), "utf8"),
    artifactBytes.toString(),
  );
  assert.equal(
    JSON.parse(await readFile(result.receiptPath, "utf8")).packageId,
    packageId,
  );
});
