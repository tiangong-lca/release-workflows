import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJson, fail, hashJson, sha256Bytes } from "./common.mjs";
import {
  createFrozenDependencyStore,
  collectProjectionFlowKeys,
  projectFinalResult,
  inventoryKey,
  FINAL_RESULT_PROJECTION,
} from "./final-result-projection.mjs";

export const FINAL_QUERY_FORMAT = "tiangong.query-artifact.v2";
import {
  MAX_RECORD_BYTES,
  MAX_METADATA_BYTES,
  documentBudget,
  checkBudget,
} from "./resource-budget.mjs";
const MAX_ROWS = 2_000_000;
const MAX_IMPACTS = 4096;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024 * 1024;

// This produces local encoding evidence, not a qualified/registered Candidate.
// Publication must consume the eventual paired Candidate and identity receipts.
export async function buildFinalResultArtifacts({
  canonicalRoot,
  index,
  results,
  outDir,
  encoder = process.env.RELEASE_HDF5_BIN ?? "release-result-hdf5",
}) {
  if (
    !Array.isArray(results) ||
    results.length === 0 ||
    results.length > MAX_ROWS
  )
    fail(
      "final_result_selection_invalid",
      "Expected a bounded nonempty final Result selection",
    );
  const inputHash = hashJson({
    projection: FINAL_RESULT_PROJECTION,
    index,
    results,
  });
  const target = path.resolve(outDir);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await stat(target);
    fail("output_exists", "Final result output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(`${target}.work-`);
  try {
    const entries = new Map();
    const requiredFlows = await collectProjectionFlowKeys(index, (entry) =>
      frozenDocument(canonicalRoot, entry),
    );
    const dependencies = createFrozenDependencyStore();
    let metadataBytes = 0;
    let spoolBytes = 0;
    const charge = (value) => {
      metadataBytes += Buffer.byteLength(canonicalJson(value));
      checkBudget("metadata", metadataBytes, MAX_METADATA_BYTES);
    };
    for (const entry of index.datasets ?? []) {
      const key = `${entry.datasetType}:${entry.uuid}@${entry.version}`;
      if (entries.has(key))
        fail("final_result_duplicate_identity", "Duplicate canonical identity");
      charge(entry);
      entries.set(key, entry);
      const document = await frozenDocument(canonicalRoot, entry);
      if (
        ["flow", "flowproperty", "unitgroup", "lciamethod"].includes(
          entry.datasetType,
        ) &&
        (entry.datasetType !== "flow" ||
          requiredFlows.has(`flow:${entry.uuid}@${entry.version}`))
      ) {
        metadataBytes += dependencies.add({ ...entry, document });
        checkBudget("metadata", metadataBytes, MAX_METADATA_BYTES, entry);
      }
    }
    const resolveDependency = dependencies.resolve;
    const groups = new Map();
    const seen = new Set();
    for (const [ordinal, selection] of results.entries()) {
      const key = `process:${selection.uuid}@${selection.version}`;
      if (seen.has(key))
        fail("final_result_duplicate_selection", "Duplicate Result selection");
      seen.add(key);
      const entry = entries.get(key);
      if (entry?.role !== "result_process")
        fail(
          "final_result_not_result",
          "Selection must identify a final Result Process",
        );
      if (
        !["direct", "derived"].includes(selection.relationKind) ||
        !Array.isArray(selection.sources)
      )
        fail(
          "final_result_lineage_required",
          "Explicit direct/derived lineage is required",
        );
      const sourceKeys = new Set();
      for (const source of selection.sources) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
            source.uuid ?? "",
          ) ||
          !/^\d{2}\.\d{2}\.\d{3}$/u.test(source.version ?? "")
        )
          fail("final_result_lineage_invalid", "Source identity must be exact");
        const sourceKey = `${source.uuid.toLowerCase()}@${source.version}`;
        if (sourceKeys.has(sourceKey))
          fail("final_result_lineage_invalid", "Duplicate source identity");
        sourceKeys.add(sourceKey);
      }
      if (
        sourceKeys.size === 0 ||
        (selection.relationKind === "direct" && sourceKeys.size !== 1)
      )
        fail(
          "final_result_lineage_invalid",
          "Direct results require exactly one source; derived results require explicit lineage",
        );
      const document = await frozenDocument(canonicalRoot, entry);
      const projection = projectFinalResult({
        document,
        identity: entry,
        layer: selection.layer,
        expectedMethods: selection.expectedMethods,
        resolveDependency,
      });
      const impacts = projection.impacts.map(({ value, ...impact }) => impact);
      const groupKey = hashJson({ layer: projection.layer, impacts });
      let group = groups.get(groupKey);
      if (!group) {
        if (impacts.length > MAX_IMPACTS)
          fail("final_result_impact_budget", "Too many impacts");
        group = { key: groupKey, impacts, inventory: new Map(), rows: [] };
        charge(impacts);
        groups.set(groupKey, group);
      }
      const rowFile = `row-${ordinal}.json`;
      const row = {
        ...projection.identity,
        contentHash: projection.contentHash,
        hashDomain: projection.hashDomain,
        canonicalContentHash: projection.canonicalContentHash,
        quantitativeReference: projection.quantitativeReference,
        relationKind: selection.relationKind,
        sources: selection.sources,
      };
      charge(row);
      for (const item of projection.inventory) {
        const key = inventoryKey(item);
        if (!group.inventory.has(key)) {
          const { value, amountField, ...metadata } = item;
          charge(metadata);
          group.inventory.set(key, metadata);
          if (group.inventory.size > MAX_ROWS)
            fail("final_result_inventory_budget", "Too many inventory columns");
        }
      }
      const bytes = canonicalJson(projection);
      spoolBytes += Buffer.byteLength(bytes);
      if (spoolBytes > MAX_OUTPUT_BYTES)
        fail(
          "final_result_spool_budget",
          "Projection spool exceeds total budget",
        );
      if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
        fail("final_result_record_budget", "Projection row exceeds budget");
      await writeFile(path.join(staging, rowFile), bytes, { flag: "wx" });
      group.rows.push({
        file: rowFile,
        sha256: sha256Bytes(Buffer.from(bytes)),
        metadata: row,
      });
    }
    const artifacts = [];
    let totalBytes = 0;
    for (const group of [...groups.values()].sort((a, b) =>
      a.key < b.key ? -1 : 1,
    )) {
      const numeric = path.join(staging, `${group.key}.bin`);
      const handle = await open(numeric, "wx");
      const inventory = [...group.inventory].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const lookup = new Map(inventory.map(([key], ordinal) => [key, ordinal]));
      let nonzeros = 0;
      let numericBytes = 32;
      try {
        const header = Buffer.alloc(32);
        header.write("TGQNUM02");
        header.writeBigUInt64LE(BigInt(group.rows.length), 8);
        header.writeBigUInt64LE(BigInt(inventory.length), 16);
        header.writeBigUInt64LE(BigInt(group.impacts.length), 24);
        await handle.writeFile(header);
        for (const row of group.rows) {
          const bytes = await readFile(path.join(staging, row.file));
          if (sha256Bytes(bytes) !== row.sha256)
            fail("final_result_spool_drift", "Frozen projection changed");
          const projection = JSON.parse(bytes);
          const values = projection.inventory
            .filter((item) => item.value !== 0)
            .map((item) => [lookup.get(inventoryKey(item)), item.value])
            .sort(([a], [b]) => a - b);
          const data = Buffer.alloc(
            8 + values.length * 16 + group.impacts.length * 8,
          );
          data.writeBigUInt64LE(BigInt(values.length));
          values.forEach(([column, value], offset) => {
            data.writeBigUInt64LE(BigInt(column), 8 + offset * 16);
            data.writeDoubleLE(value, 16 + offset * 16);
          });
          projection.impacts.forEach((impact, offset) =>
            data.writeDoubleLE(
              impact.value,
              8 + values.length * 16 + offset * 8,
            ),
          );
          numericBytes += data.length;
          if (numericBytes > MAX_OUTPUT_BYTES)
            fail("final_result_numeric_budget", "Numeric spool exceeds budget");
          await handle.writeFile(data);
          nonzeros += values.length;
        }
      } finally {
        await handle.close();
      }
      const directory = path.join(staging, group.key);
      await runEncoder(encoder, ["build", numeric, directory]);
      const resultAxis = group.rows.map(({ metadata }, ordinal) => ({
        ordinal,
        ...metadata,
      }));
      const inventoryAxis = inventory.map(([, item], ordinal) => ({
        ordinal,
        ...item,
      }));
      const files = [
        await writeIndex(directory, "results.json.gz", resultAxis),
        await writeIndex(directory, "inventory-items.json.gz", inventoryAxis),
      ];
      if (group.impacts.length)
        files.push(
          await writeIndex(
            directory,
            "impacts.json.gz",
            group.impacts.map((impact, ordinal) => ({ ordinal, ...impact })),
          ),
        );
      files.push(await describe(directory, "lci.h5"));
      if (group.impacts.length)
        files.push(await describe(directory, "lcia.h5"));
      totalBytes += files.reduce((sum, file) => sum + file.byteSize, 0);
      if (totalBytes > MAX_OUTPUT_BYTES)
        fail(
          "final_result_output_budget",
          "Query artifacts exceed total output budget",
        );
      const manifest = {
        schemaVersion: FINAL_QUERY_FORMAT,
        artifactId: randomUUID(),
        source: { schemaVersion: FINAL_RESULT_PROJECTION, inputHash },
        resultCount: group.rows.length,
        inventoryCount: inventory.length,
        impactCount: group.impacts.length,
        lciNonzeroCount: nonzeros,
        files: files.sort((a, b) => (a.name < b.name ? -1 : 1)),
      };
      const manifestBytes = Buffer.from(canonicalJson(manifest));
      await writeFile(path.join(directory, "manifest.json"), manifestBytes, {
        flag: "wx",
      });
      artifacts.push({
        path: group.key,
        schemaVersion: FINAL_QUERY_FORMAT,
        artifactId: manifest.artifactId,
        manifestSha256: sha256Bytes(manifestBytes),
        manifestByteSize: manifestBytes.length,
        resultCount: resultAxis.length,
      });
      await rm(numeric);
    }
    for (const group of groups.values())
      for (const row of group.rows) await rm(path.join(staging, row.file));
    const receipt = {
      schemaVersion: "tiangong.release.final-result-encoding.v1",
      inputHash,
      publicationAuthorized: false,
      candidateQualified: false,
      artifacts,
    };
    await writeFile(
      path.join(staging, "encoding-receipt.json"),
      canonicalJson(receipt),
      { flag: "wx" },
    );
    // Reserve the destination without replacing even an empty existing directory.
    await mkdir(target);
    try {
      for (const artifact of artifacts)
        await rename(
          path.join(staging, artifact.path),
          path.join(target, artifact.path),
        );
      await rename(
        path.join(staging, "encoding-receipt.json"),
        path.join(target, "encoding-receipt.json"),
      );
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
    return { path: target, receipt };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
export async function frozenDocument(root, entry) {
  if (
    typeof entry.path !== "string" ||
    path.isAbsolute(entry.path) ||
    entry.path.includes("\\") ||
    entry.path.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("final_result_path_invalid", "Unsafe canonical dataset path");
  const realRoot = await realpath(root);
  const file = await realpath(path.resolve(realRoot, entry.path));
  if (!file.startsWith(`${realRoot}${path.sep}`))
    fail("final_result_path_escape", "Canonical path escapes input root");
  const size = (await stat(file)).size;
  checkBudget("document", size, documentBudget(entry), entry);
  if (size !== entry.byteSize)
    fail(
      "final_result_file_size",
      "Canonical dataset size mismatch or limit exceeded",
    );
  const bytes = await readFile(file);
  if (sha256Bytes(bytes) !== entry.sha256)
    fail("final_result_file_hash", "Canonical dataset bytes changed");
  const document = JSON.parse(bytes);
  if (hashJson(document) !== entry.canonicalContentHash)
    fail("final_result_content_hash", "Canonical content changed");
  return document;
}
async function writeIndex(root, name, value) {
  const bytes = Buffer.from(canonicalJson(value));
  if (bytes.length > MAX_METADATA_BYTES)
    fail("final_result_index_budget", "Index exceeds budget");
  await writeFile(path.join(root, name), gzipSync(bytes), { flag: "wx" });
  return { ...(await describe(root, name)), plainByteSize: bytes.length };
}
async function describe(root, name) {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const bytes of createReadStream(path.join(root, name))) {
    hash.update(bytes);
    byteSize += bytes.length;
  }
  return { name, sha256: hash.digest("hex"), byteSize };
}
export function runEncoder(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30 * 60 * 1000,
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            Object.assign(new Error("Release HDF5 encoding/readback failed"), {
              code: "final_result_encoder_failed",
              details: { exitCode: code, stderr },
            }),
          ),
    );
  });
}
