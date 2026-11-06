import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import canonicalize from "canonicalize";
import { fail, hashJson, sha256Bytes } from "./common.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VERSION = /^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u;

export function publicationCatalogSetHash(datasets) {
  return hashJson(
    datasets.map(({ key, sha256, references }) =>
      hashJson({ key, sha256, references }),
    ),
  );
}

export async function buildPublicationCatalog({
  canonicalRoot,
  index,
  resultOnly = false,
}) {
  const records = new Map();
  const keysByUuid = new Map();
  for (const dataset of index.datasets ?? []) {
    const file = resolveContained(canonicalRoot, dataset.path);
    const bytes = await readFile(file);
    if (sha256Bytes(bytes) !== dataset.sha256)
      fail(
        "publication_catalog_dataset_hash_mismatch",
        `Hash drift while preparing Publication catalog: ${dataset.path}`,
      );
    const document = JSON.parse(bytes.toString("utf8"));
    if (hashJson(document) !== dataset.canonicalContentHash)
      fail(
        "publication_catalog_content_hash_mismatch",
        `Canonical content drift while preparing Publication catalog: ${dataset.path}`,
      );
    const projected = {
      key: identityKey(dataset),
      datasetType: dataset.datasetType,
      role: dataset.role,
      uuid: String(dataset.uuid).toLowerCase(),
      version: dataset.version,
      path: dataset.path,
      sha256: dataset.sha256,
      canonicalContentHash: dataset.canonicalContentHash,
      rawReferences: collectClosureReferences(document, {
        key: identityKey(dataset),
        path: dataset.path,
      }),
    };
    if (records.has(projected.key))
      fail(
        "publication_catalog_identity_duplicate",
        `Duplicate Publication identity: ${projected.key}`,
      );
    records.set(projected.key, projected);
    const uuidKeys = keysByUuid.get(projected.uuid) ?? [];
    uuidKeys.push(projected.key);
    keysByUuid.set(projected.uuid, uuidKeys);
  }

  for (const record of records.values()) {
    record.resolvedTargets = record.rawReferences.map((reference) => {
      const candidates = (keysByUuid.get(reference.uuid) ?? []).filter((key) =>
        reference.version ? key.endsWith(`@${reference.version}`) : true,
      );
      if (candidates.length === 0)
        fail(
          "publication_catalog_reference_missing",
          `Required Publication reference is absent from Candidate: ${record.key} -> ${reference.uuid}@${reference.version ?? "unspecified"}`,
          { from: record.key, reference },
        );
      if (candidates.length > 1)
        fail(
          "publication_catalog_reference_ambiguous",
          `Required Publication reference is ambiguous: ${record.key} -> ${reference.uuid}@${reference.version ?? "unspecified"}`,
          { from: record.key, reference, candidates: candidates.sort() },
        );
      return candidates[0];
    });
    delete record.rawReferences;
  }

  const unitProcessRoots = [...records.values()]
    .filter((record) => !resultOnly && record.role === "unit_process")
    .map(({ key }) => key)
    .sort();
  const resultRoots = [...records.values()]
    .filter((record) =>
      resultOnly
        ? record.datasetType === "process" && record.role === "result_process"
        : ["result_process", "lifecycle_model"].includes(record.role),
    )
    .map(({ key }) => key)
    .sort();
  const unitProcessSet = reachable(records, unitProcessRoots);
  const resultSet = reachable(records, resultRoots);
  const datasets = [...records.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ resolvedTargets, ...record }) => ({
      ...record,
      references: [...new Set(resolvedTargets)].sort(),
      components: [
        ...(unitProcessSet.has(record.key) ? ["unit_process"] : []),
        ...(resultSet.has(record.key) ? ["result"] : []),
      ],
    }));
  const componentSets = {
    unitProcess: [...unitProcessSet].sort(),
    result: [...resultSet].sort(),
  };
  return {
    schemaVersion: "tiangong.release.candidate-publication-catalog.v1",
    canonicalDatasetIndexSha256: hashJson(index),
    datasetCount: datasets.length,
    components: {
      unitProcess: {
        available: unitProcessRoots.length > 0,
        roots: unitProcessRoots,
        datasets: componentSets.unitProcess,
      },
      result: {
        available: resultRoots.length > 0,
        roots: resultRoots,
        datasets: componentSets.result,
      },
    },
    datasets,
    catalogSetHash: publicationCatalogSetHash(datasets),
  };
}

export async function writePublicationCatalogFile(catalog, filePath) {
  const hash = createHash("sha256");
  const stream = createWriteStream(filePath, { flags: "wx" });
  const write = (chunk) => {
    hash.update(chunk, "utf8");
    stream.write(chunk);
  };
  write(
    `{"canonicalDatasetIndexSha256":${canonicalize(catalog.canonicalDatasetIndexSha256)},`,
  );
  write(`"catalogSetHash":${canonicalize(catalog.catalogSetHash)},`);
  write(`"components":${canonicalize(catalog.components)},`);
  write(`"datasetCount":${canonicalize(catalog.datasetCount)},`);
  write(`"datasets":[`);
  let first = true;
  for (const dataset of catalog.datasets) {
    const chunk = canonicalize(dataset);
    write(first ? chunk : `,${chunk}`);
    first = false;
  }
  write(`],"schemaVersion":${canonicalize(catalog.schemaVersion)}}\n`);
  await new Promise((resolve, reject) =>
    stream.end((error) => (error ? reject(error) : resolve())),
  );
  return hash.digest("hex");
}

function reachable(records, roots) {
  const found = new Set();
  const queue = [...roots];
  while (queue.length) {
    const key = queue.pop();
    if (found.has(key)) continue;
    const record = records.get(key);
    if (!record)
      fail(
        "publication_catalog_root_missing",
        `Publication component names a missing root: ${key}`,
      );
    found.add(key);
    for (const target of record.resolvedTargets)
      if (!found.has(target)) queue.push(target);
  }
  return found;
}

function collectClosureReferences(document, dataset) {
  const result = [];
  const visit = (value, location, parentKey) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && typeof value["@refObjectId"] === "string") {
      const uuid = value["@refObjectId"].toLowerCase();
      const version = value["@version"];
      if (referenceRole(parentKey) === "closure_dependency") {
        if (!UUID.test(uuid) || !VERSION.test(version ?? ""))
          fail(
            "publication_catalog_reference_invalid",
            `Required Publication reference lacks an exact UUID/version at ${location}`,
            {
              dataset: dataset?.key ?? null,
              datasetPath: dataset?.path ?? null,
              reference: { uuid, version: version ?? null, location },
            },
          );
        result.push({ uuid, version, location });
      }
    }
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries())
        visit(child, joinLocation(location, String(index)), parentKey);
      return;
    }
    for (const [key, child] of Object.entries(value))
      visit(child, joinLocation(location, key), key);
  };
  visit(document, "", null);
  return result.sort((left, right) =>
    `${left.uuid}@${left.version ?? ""}:${left.location}`.localeCompare(
      `${right.uuid}@${right.version ?? ""}:${right.location}`,
    ),
  );
}

function referenceRole(parentKey) {
  const localName = String(parentKey ?? "")
    .split(":")
    .at(-1)
    .toLowerCase();
  return localName === "referencetoprecedingdatasetversion"
    ? "lineage"
    : "closure_dependency";
}

function joinLocation(parent, child) {
  return parent ? `${parent}/${child}` : child;
}

function identityKey(value) {
  return `${value.datasetType}:${String(value.uuid).toLowerCase()}@${value.version}`;
}

function resolveContained(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix))
    fail(
      "publication_catalog_path_escape",
      `Candidate dataset path escapes canonical root: ${relativePath}`,
    );
  return target;
}
