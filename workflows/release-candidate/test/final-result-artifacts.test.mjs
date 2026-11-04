import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { buildFinalResultArtifacts } from "../lib/final-result-artifacts.mjs";
import { fixture, id, version } from "./fixtures/final-result.mjs";
const run = promisify(execFile);
const encoder = fileURLToPath(
  new URL(
    `../native/target/debug/release-result-hdf5${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-result-hdf5-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = path.join(root, "canonical");
  await mkdir(canonicalRoot);
  const f = fixture();
  const index = { datasets: [] };
  for (const record of [
    ...f.dependencies,
    {
      datasetType: "process",
      role: "result_process",
      uuid: id(1),
      version,
      document: f.document,
    },
  ]) {
    const bytes = Buffer.from(canonicalJson(record.document));
    const name = `${record.uuid}.json`;
    await writeFile(path.join(canonicalRoot, name), bytes);
    index.datasets.push({
      datasetType: record.datasetType,
      role: record.role ?? "support",
      uuid: record.uuid,
      version,
      path: name,
      byteSize: bytes.length,
      sha256: sha256Bytes(bytes),
      canonicalContentHash: hashJson(record.document),
    });
  }
  return {
    root,
    canonicalRoot,
    index,
    encoder,
    outDir: path.join(root, "result"),
    results: [
      {
        uuid: id(1),
        version,
        layer: f.layer,
        expectedMethods: f.expectedMethods,
        relationKind: "derived",
        sources: [
          { uuid: id(80), version },
          { uuid: id(81), version },
        ],
      },
    ],
  };
}
function numeric({
  rows = 1,
  columns = 2,
  impacts = 1,
  values = [[1, -3]],
  impactValues = [42],
} = {}) {
  const buffer = Buffer.alloc(
    32 + 8 + values.length * 16 + impactValues.length * 8,
  );
  buffer.write("TGQNUM02");
  [rows, columns, impacts].forEach((value, i) =>
    buffer.writeBigUInt64LE(BigInt(value), 8 + i * 8),
  );
  buffer.writeBigUInt64LE(BigInt(values.length), 32);
  values.forEach(([col, value], i) => {
    buffer.writeBigUInt64LE(BigInt(col), 40 + i * 16);
    buffer.writeDoubleLE(value, 48 + i * 16);
  });
  impactValues.forEach((value, i) =>
    buffer.writeDoubleLE(value, 40 + values.length * 16 + i * 8),
  );
  return buffer;
}

test("Release builds actual HDF5, indexes, and isolated derived identity from final content", async (t) => {
  const input = await setup(t);
  const { receipt } = await buildFinalResultArtifacts(input);
  assert.equal(receipt.candidateQualified, false);
  assert.equal(receipt.publicationAuthorized, false);
  assert.equal(receipt.artifacts.length, 1);
  const directory = path.join(input.outDir, receipt.artifacts[0].path);
  const manifestBytes = await readFile(path.join(directory, "manifest.json"));
  assert.equal(sha256Bytes(manifestBytes), receipt.artifacts[0].manifestSha256);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, "tiangong.query-artifact.v2");
  assert.equal(manifest.resultCount, 1);
  for (const file of manifest.files) {
    assert.deepEqual(
      Object.keys(file).sort(),
      (file.name.endsWith(".gz")
        ? ["name", "sha256", "byteSize", "plainByteSize"]
        : ["name", "sha256", "byteSize"]
      ).sort(),
    );
  }
  assert.equal(manifest.lciNonzeroCount, 1);
  const rows = JSON.parse(
    gunzipSync(await readFile(path.join(directory, "results.json.gz"))),
  );
  assert.equal(rows[0].uuid, id(1));
  assert.equal(rows[0].relationKind, "derived");
  assert.equal(rows[0].quantitativeReference.value, -2);
  const inventory = JSON.parse(
    gunzipSync(await readFile(path.join(directory, "inventory-items.json.gz"))),
  );
  assert.equal(inventory.length, 2);
  assert.equal(inventory[0].direction, "Input");
  for (const file of manifest.files)
    assert.equal(
      sha256Bytes(await readFile(path.join(directory, file.name))),
      file.sha256,
    );
  // Independent expected numbers, not reconstructed from the projection or HDF5.
  const expected = path.join(input.root, "expected.bin");
  await writeFile(expected, numeric({ values: [[0, -3]] }));
  await run(encoder, ["verify", expected, directory]);
  await assert.rejects(buildFinalResultArtifacts(input), {
    code: "output_exists",
  });
});

test("native encoder rejects duplicate columns, nonfinite data, trailing bytes and preserves existing output", async (t) => {
  const input = await setup(t);
  const file = path.join(input.root, "input.bin");
  for (const bytes of [
    numeric({
      values: [
        [0, 1],
        [0, 2],
      ],
    }),
    numeric({ values: [[1, NaN]] }),
    Buffer.concat([numeric(), Buffer.from([1])]),
  ]) {
    await writeFile(file, bytes);
    await assert.rejects(run(encoder, ["build", file, input.outDir]));
    await assert.rejects(readFile(path.join(input.outDir, "lci.h5")), {
      code: "ENOENT",
    });
  }
  await writeFile(file, numeric());
  await run(encoder, ["build", file, input.outDir]);
  const before = await readFile(path.join(input.outDir, "lci.h5"));
  await assert.rejects(run(encoder, ["build", file, input.outDir]));
  assert.deepEqual(await readFile(path.join(input.outDir, "lci.h5")), before);
  await writeFile(file, numeric({ values: [[1, 4]] }));
  await assert.rejects(run(encoder, ["verify", file, input.outDir]));
});

test("LCI-only empty CSR is valid and no LCIA file is invented", async (t) => {
  const input = await setup(t);
  const file = path.join(input.root, "input.bin");
  await writeFile(
    file,
    numeric({ columns: 0, impacts: 0, values: [], impactValues: [] }),
  );
  await run(encoder, ["build", file, input.outDir]);
  await run(encoder, ["verify", file, input.outDir]);
  assert.deepEqual((await readdir(input.outDir)).sort(), ["lci.h5"]);
});

test("changed canonical bytes fail before encoder and leave no output", async (t) => {
  const input = await setup(t);
  await writeFile(path.join(input.canonicalRoot, `${id(1)}.json`), "{}");
  await assert.rejects(buildFinalResultArtifacts(input), {
    code: "final_result_file_size",
  });
  await assert.rejects(readdir(input.outDir), { code: "ENOENT" });
});

test("unused Method-closure Flows are verified but not interpreted as numerical dependencies", async (t) => {
  const input = await setup(t);
  const original = fixture().dependencies.find((r) => r.datasetType === "flow");
  const document = structuredClone(original.document);
  document.flowDataSet.flowInformation.dataSetInformation["common:UUID"] =
    id(99);
  // This Flow is present for distribution closure, never referenced by a Result.
  document.flowDataSet.flowProperties.flowProperty[0].meanValue = "2";
  const bytes = Buffer.from(canonicalJson(document));
  const entry = {
    datasetType: "flow",
    role: "support",
    uuid: id(99),
    version,
    path: `${id(99)}.json`,
    byteSize: bytes.length,
    sha256: sha256Bytes(bytes),
    canonicalContentHash: hashJson(document),
  };
  input.index.datasets.push(entry);
  await writeFile(path.join(input.canonicalRoot, entry.path), bytes);
  await buildFinalResultArtifacts(input);
  const changed = Buffer.from(bytes);
  changed[changed.indexOf(Buffer.from('"2"')) + 1] = "3".charCodeAt(0);
  await writeFile(path.join(input.canonicalRoot, entry.path), changed);
  await assert.rejects(
    buildFinalResultArtifacts({
      ...input,
      outDir: path.join(input.root, "drift"),
    }),
    { code: "final_result_file_hash" },
  );
});
