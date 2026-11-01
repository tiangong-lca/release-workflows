import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail, sha256Bytes } from "./common.mjs";
import { hashJson } from "./versioning.mjs";

export async function writeCanonicalDatasetIndex(root, datasets) {
  const entries = [];
  const identities = new Set();
  const paths = new Set();
  for (const dataset of datasets) {
    const relativePath = safeRelative(dataset.path);
    const identity = `${dataset.datasetType}:${dataset.uuid.toLowerCase()}:${dataset.version}`;
    if (identities.has(identity))
      fail(
        "canonical_index_duplicate_identity",
        `Duplicate dataset identity: ${identity}`,
      );
    if (paths.has(relativePath))
      fail(
        "canonical_index_duplicate_path",
        `Duplicate dataset path: ${relativePath}`,
      );
    identities.add(identity);
    paths.add(relativePath);
    const file = path.resolve(root, relativePath);
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`))
      fail(
        "canonical_index_unsafe_path",
        `Unsafe dataset path: ${relativePath}`,
      );
    const bytes = await readFile(file);
    const metadata = await stat(file);
    const document = JSON.parse(bytes);
    const canonicalContentHash = hashJson(document);
    if (
      dataset.canonicalContentHash &&
      dataset.canonicalContentHash !== canonicalContentHash
    ) {
      fail(
        "canonical_index_content_mismatch",
        `Dataset content hash mismatch: ${identity}`,
      );
    }
    entries.push({
      datasetType: dataset.datasetType,
      role: dataset.role,
      uuid: dataset.uuid.toLowerCase(),
      version: dataset.version,
      path: relativePath,
      sha256: sha256Bytes(bytes),
      byteSize: metadata.size,
      canonicalContentHash,
    });
  }
  const index = canonicalDatasetIndex(entries);
  await writeFile(
    path.join(root, "canonical-dataset-index.json"),
    canonicalJson(index),
    { flag: "wx" },
  );
  return index;
}

export function canonicalDatasetIndex(entries) {
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasetCount: entries.length,
    byteSize: entries.reduce((total, entry) => total + entry.byteSize, 0),
    artifactSetHash: hashJson(
      entries.map(({ datasetType, uuid, version, path: itemPath, sha256 }) => ({
        datasetType,
        uuid,
        version,
        path: itemPath,
        sha256,
      })),
    ),
    datasets: entries,
  };
}

function safeRelative(value) {
  const text = String(value ?? "");
  if (
    !text ||
    text.includes("\\") ||
    path.isAbsolute(text) ||
    text.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("canonical_index_unsafe_path", `Unsafe dataset path: ${text}`);
  }
  return text;
}
