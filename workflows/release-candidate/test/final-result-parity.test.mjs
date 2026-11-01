import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { buildFinalResultArtifacts } from "../lib/final-result-artifacts.mjs";
import { verifyFinalResultParity } from "../lib/final-result-parity.mjs";
import { fixture, id, version } from "./fixtures/final-result.mjs";
const encoder = fileURLToPath(
  new URL(
    `../native/target/debug/release-result-hdf5${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "result-pair-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = path.join(root, "canonical");
  await mkdir(canonicalRoot);
  const f = fixture();
  const index = { datasets: [] };
  for (const r of [
    ...f.dependencies,
    { datasetType: "process", uuid: id(1), version, document: f.document },
  ]) {
    const bytes = Buffer.from(canonicalJson(r.document));
    const relative = `${r.uuid}.json`;
    await writeFile(path.join(canonicalRoot, relative), bytes);
    index.datasets.push({
      datasetType: r.datasetType,
      uuid: r.uuid,
      version,
      path: relative,
      role: r.datasetType === "process" ? "result_process" : "support",
      byteSize: bytes.length,
      sha256: sha256Bytes(bytes),
      canonicalContentHash: hashJson(r.document),
    });
  }
  const results = [
    {
      uuid: id(1),
      version,
      layer: f.layer,
      expectedMethods: f.expectedMethods,
      relationKind: "derived",
      sources: [{ uuid: id(80), version }],
    },
  ];
  const built = await buildFinalResultArtifacts({
    canonicalRoot,
    index,
    results,
    encoder,
    outDir: path.join(root, "query"),
  });
  const archiveRoot = path.join(root, "archive");
  await cp(canonicalRoot, archiveRoot, { recursive: true });
  return {
    root,
    canonicalRoot,
    archiveRoot,
    index,
    results,
    queryRoot: built.path,
    encodingReceipt: built.receipt,
    workspace: root,
    encoder,
  };
}
async function rebind(input, name, bytes, plainByteSize) {
  const receipt = input.encodingReceipt.artifacts[0];
  const root = path.join(input.queryRoot, receipt.path);
  await writeFile(path.join(root, name), bytes);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json")));
  const file = manifest.files.find((f) => f.name === name);
  Object.assign(file, {
    byteSize: bytes.length,
    sha256: sha256Bytes(bytes),
    ...(plainByteSize === undefined ? {} : { plainByteSize }),
  });
  const output = Buffer.from(canonicalJson(manifest));
  await writeFile(path.join(root, "manifest.json"), output);
  receipt.manifestSha256 = sha256Bytes(output);
  receipt.manifestByteSize = output.length;
}
test("archive-derived final LCI/LCIA projection agrees with actual HDF5", async (t) => {
  const input = await setup(t);
  const report = await verifyFinalResultParity(input);
  assert.equal(report.outcome, "passed");
  assert.equal(report.resultCount, 1);
  assert.equal(report.artifacts[0].lciNonzeroCount, 1);
  // Original source remains unchanged: the archive's actual bytes decide parity.
  const file = path.join(input.archiveRoot, `${id(1)}.json`);
  const doc = JSON.parse(await readFile(file));
  doc.processDataSet.exchanges.exchange[2].resultingAmount = "-4";
  await writeFile(file, canonicalJson(doc));
  await assert.rejects(verifyFinalResultParity(input), {
    code: "final_pair_archive_content",
  });
});
test("matching file receipts cannot conceal a changed reference quantity or method unit", async (t) => {
  for (const name of ["results.json.gz", "impacts.json.gz"]) {
    const input = await setup(t);
    const root = path.join(
      input.queryRoot,
      input.encodingReceipt.artifacts[0].path,
    );
    const rows = JSON.parse(gunzipSync(await readFile(path.join(root, name))));
    if (name === "results.json.gz") rows[0].quantitativeReference.value = -1;
    else rows[0].unit = "kg";
    const plain = Buffer.from(canonicalJson(rows));
    await rebind(input, name, gzipSync(plain), plain.length);
    await assert.rejects(verifyFinalResultParity(input), {
      code:
        name === "results.json.gz"
          ? "final_pair_result_metadata"
          : "final_pair_impact_axis",
    });
  }
});
test("missing semantic dependency, duplicate artifacts and wrong input binding fail", async (t) => {
  const input = await setup(t);
  const wrong = structuredClone(input.encodingReceipt);
  wrong.inputHash = "0".repeat(64);
  await assert.rejects(
    verifyFinalResultParity({ ...input, encodingReceipt: wrong }),
    { code: "final_pair_input_mismatch" },
  );
  input.encodingReceipt.artifacts.push(input.encodingReceipt.artifacts[0]);
  await assert.rejects(verifyFinalResultParity(input), {
    code: "final_pair_result_axis",
  });
  input.encodingReceipt.artifacts.pop();
  await rm(path.join(input.archiveRoot, `${id(5)}.json`));
  await assert.rejects(verifyFinalResultParity(input), { code: "ENOENT" });
});
test("corrupt HDF5 bytes are rejected before numeric readback", async (t) => {
  const input = await setup(t);
  const file = path.join(
    input.queryRoot,
    input.encodingReceipt.artifacts[0].path,
    "lci.h5",
  );
  const bytes = await readFile(file);
  bytes[0] ^= 1;
  await writeFile(file, bytes);
  await assert.rejects(verifyFinalResultParity(input), {
    code: "final_pair_file_hash",
  });
});
