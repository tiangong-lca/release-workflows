// Qualify the actual archive contents and actual encoded matrices. No solver,
// mutable database reads, version allocation or publication side effects.
import { readFile, stat, open, rm } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, hashJson, sha256Bytes, fail } from "./common.mjs";
import {
  frozenDocument,
  runEncoder,
  FINAL_QUERY_FORMAT,
} from "./final-result-artifacts.mjs";
import {
  createFrozenDependencyResolver,
  projectFinalResult,
  inventoryKey,
  FINAL_RESULT_PROJECTION,
} from "./final-result-projection.mjs";

const MAX_INDEX = 128 * 1024 * 1024;
const MAX_NUMERIC = 32 * 1024 * 1024 * 1024;
const MAX_RECORD = 8 * 1024 * 1024;
import {
  safeFile,
  verifiedBytes,
  verifyLargeFile,
  indexFile,
} from "./final-result-files.mjs";
function same(actual, expected, code) {
  if (canonicalJson(actual) !== canonicalJson(expected))
    fail(code, "Final Result archive/query pairing differs from frozen input");
}
// archiveRoot is the isolated, validated TIDAS ZIP extraction, never the input
// canonical directory. Every frozen index member must be present, exact and
// canonical-content-equivalent, including semantic support dependencies.
export async function verifyFinalResultParity({
  archiveRoot,
  index,
  results,
  queryRoot,
  encodingReceipt,
  workspace,
  encoder,
}) {
  const inputHash = hashJson({
    projection: FINAL_RESULT_PROJECTION,
    index,
    results,
  });
  if (
    encodingReceipt.schemaVersion !==
      "tiangong.release.final-result-encoding.v1" ||
    encodingReceipt.inputHash !== inputHash ||
    !Array.isArray(encodingReceipt.artifacts) ||
    !encodingReceipt.artifacts.length
  )
    fail(
      "final_pair_input_mismatch",
      "Encoding receipt does not bind frozen input",
    );
  const entries = new Map();
  const dependencies = [];
  let metadataBytes = 0;
  for (const entry of index.datasets ?? []) {
    const file = await safeFile(archiveRoot, entry.path);
    const size = (await stat(file)).size;
    if (size > MAX_RECORD)
      fail("final_pair_record_budget", "Archive document exceeds budget");
    const bytes = await readFile(file);
    const document = JSON.parse(bytes);
    if (hashJson(document) !== entry.canonicalContentHash)
      fail(
        "final_pair_archive_content",
        "Archive canonical content differs from frozen input",
      );
    const key = `${entry.datasetType}:${entry.uuid}@${entry.version}`;
    if (entries.has(key))
      fail("final_pair_duplicate_identity", "Duplicate frozen identity");
    entries.set(key, { ...entry, byteSize: size, sha256: sha256Bytes(bytes) });
    if (
      ["flow", "flowproperty", "unitgroup", "lciamethod"].includes(
        entry.datasetType,
      )
    ) {
      metadataBytes += bytes.length;
      if (metadataBytes > MAX_INDEX)
        fail("final_pair_metadata_budget", "Pairing metadata exceeds budget");
      dependencies.push({ ...entry, document });
    }
  }
  const resolveDependency = createFrozenDependencyResolver(dependencies);
  const selected = new Map(results.map((r) => [`${r.uuid}@${r.version}`, r]));
  if (selected.size !== results.length || !selected.size)
    fail("final_pair_selection_invalid", "Invalid Result selection");
  const seen = new Set();
  const artifacts = [];
  for (const receipt of encodingReceipt.artifacts) {
    const root = await safeFile(queryRoot, receipt.path);
    const manifest = JSON.parse(
      await verifiedBytes(
        root,
        {
          name: "manifest.json",
          sha256: receipt.manifestSha256,
          byteSize: receipt.manifestByteSize,
        },
        1024 * 1024,
      ),
    );
    if (
      manifest.schemaVersion !== FINAL_QUERY_FORMAT ||
      receipt.schemaVersion !== FINAL_QUERY_FORMAT ||
      manifest.artifactId !== receipt.artifactId ||
      manifest.source?.schemaVersion !== FINAL_RESULT_PROJECTION ||
      manifest.source.inputHash !== inputHash
    )
      fail("final_pair_manifest_binding", "Paired manifest identity mismatch");
    const names = ["inventory-items.json.gz", "lci.h5", "results.json.gz"];
    if (manifest.impactCount > 0) names.push("impacts.json.gz", "lcia.h5");
    same(
      manifest.files.map((f) => f.name).sort(),
      names.sort(),
      "final_pair_file_set",
    );
    const rows = await indexFile(root, manifest, "results.json.gz");
    const inventory = await indexFile(
      root,
      manifest,
      "inventory-items.json.gz",
    );
    const impacts = manifest.impactCount
      ? await indexFile(root, manifest, "impacts.json.gz")
      : [];
    same(
      [rows.length, inventory.length, impacts.length],
      [manifest.resultCount, manifest.inventoryCount, manifest.impactCount],
      "final_pair_axis_count",
    );
    for (const file of manifest.files.filter((f) => f.name.endsWith(".h5")))
      await verifyLargeFile(root, file);
    const columns = new Map();
    let previous = null;
    inventory.forEach((item, ordinal) => {
      const key = inventoryKey(item);
      if (item.ordinal !== ordinal || (previous !== null && previous >= key))
        fail("final_pair_inventory_axis", "Invalid inventory axis");
      columns.set(key, ordinal);
      previous = key;
    });
    const numeric = path.join(workspace, `parity-${artifacts.length}.bin`);
    const handle = await open(numeric, "wx");
    let nonzeros = 0;
    let numericBytes = 32;
    try {
      const header = Buffer.alloc(32);
      header.write("TGQNUM02");
      [rows.length, inventory.length, impacts.length].forEach((v, i) =>
        header.writeBigUInt64LE(BigInt(v), 8 + i * 8),
      );
      await handle.writeFile(header);
      const usedColumns = new Set();
      for (const [ordinal, row] of rows.entries()) {
        const key = `${row.uuid}@${row.version}`;
        const selection = selected.get(key);
        const entry = entries.get(`process:${key}`);
        if (!selection || !entry || seen.has(key))
          fail(
            "final_pair_result_axis",
            "Missing, unexpected or duplicate Result row",
          );
        seen.add(key);
        const document = await frozenDocument(archiveRoot, entry);
        const projection = projectFinalResult({
          document,
          identity: entry,
          layer: selection.layer,
          expectedMethods: selection.expectedMethods,
          resolveDependency,
        });
        same(
          row,
          {
            ordinal,
            ...projection.identity,
            contentHash: projection.contentHash,
            hashDomain: projection.hashDomain,
            canonicalContentHash: projection.canonicalContentHash,
            quantitativeReference: projection.quantitativeReference,
            relationKind: selection.relationKind,
            sources: selection.sources,
          },
          "final_pair_result_metadata",
        );
        same(
          impacts,
          projection.impacts.map(({ value, ...item }, ordinal) => ({
            ordinal,
            ...item,
          })),
          "final_pair_impact_axis",
        );
        const values = [];
        for (const item of projection.inventory) {
          const column = columns.get(inventoryKey(item));
          const { value, amountField, ...metadata } = item;
          if (column === undefined)
            fail("final_pair_missing_column", "Final inventory column absent");
          same(
            inventory[column],
            { ordinal: column, ...metadata },
            "final_pair_inventory_metadata",
          );
          usedColumns.add(column);
          if (value !== 0) values.push([column, value]);
        }
        values.sort(([a], [b]) => a - b);
        nonzeros += values.length;
        const data = Buffer.alloc(8 + values.length * 16 + impacts.length * 8);
        data.writeBigUInt64LE(BigInt(values.length));
        values.forEach(([col, value], i) => {
          data.writeBigUInt64LE(BigInt(col), 8 + i * 16);
          data.writeDoubleLE(value, 16 + i * 16);
        });
        projection.impacts.forEach(({ value }, i) =>
          data.writeDoubleLE(value, 8 + values.length * 16 + i * 8),
        );
        numericBytes += data.length;
        if (numericBytes > MAX_NUMERIC)
          fail(
            "final_pair_numeric_budget",
            "Pairing numeric input exceeds budget",
          );
        await handle.writeFile(data);
      }
      if (
        usedColumns.size !== inventory.length ||
        nonzeros !== manifest.lciNonzeroCount
      )
        fail("final_pair_coverage", "Query axis or nonzero coverage mismatch");
    } finally {
      await handle.close();
    }
    try {
      await runEncoder(encoder, ["verify", numeric, root]);
    } finally {
      await rm(numeric, { force: true });
    }
    artifacts.push({
      artifactId: receipt.artifactId,
      manifestSha256: receipt.manifestSha256,
      resultCount: rows.length,
      lciNonzeroCount: nonzeros,
    });
  }
  if (seen.size !== selected.size)
    fail("final_pair_coverage", "Selected Result missing from query artifacts");
  return {
    schemaVersion: "tiangong.release.final-result-parity.v1",
    inputHash,
    outcome: "passed",
    resultCount: seen.size,
    artifacts,
  };
}
