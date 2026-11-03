import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProcessSchema } from "@tiangong-lca/tidas-sdk";
import { verifyDerivedResultHandoff } from "../../dataset-transformation/lib/handoff.mjs";
import { writeImmutableDirectory } from "../../dataset-transformation/lib/io.mjs";
import { canonicalJson, fail, sha256Bytes } from "./common.mjs";
import { hashJson } from "./versioning.mjs";
import { resolveArtifactRoot } from "./artifact-paths.mjs";
import {
  canonicalDatasetIndex,
  writeCanonicalDatasetIndex,
} from "./canonical-index.mjs";

export async function materializeDerivedResult({
  candidateDir,
  transformationDir,
  specDir,
  outDir,
  artifactRoot,
}) {
  if (outDir && artifactRoot)
    fail(
      "invalid_arguments",
      "Choose either --out-dir or --artifact-root, not both",
    );
  const evidence = await verifyDerivedResultHandoff({
    candidateDir,
    transformationDir,
    specDir,
  });
  const validation = ProcessSchema.safeParse(evidence.document);
  if (!validation.success)
    fail(
      "derived_tidas_validation_failed",
      "Derived Result failed the pinned TIDAS SDK schema",
      { issues: validation.error.issues.slice(0, 20) },
    );
  const process = evidence.document.processDataSet;
  const rawMethods = process.LCIAResults?.LCIAResult;
  const methods = (
    Array.isArray(rawMethods) ? rawMethods : rawMethods ? [rawMethods] : []
  )
    .map(({ referenceToLCIAMethodDataSet: ref }) => ({
      uuid: ref["@refObjectId"],
      version: ref["@version"],
    }))
    .sort((left, right) =>
      `${left.uuid}@${left.version}`.localeCompare(
        `${right.uuid}@${right.version}`,
      ),
    );
  const parents = evidence.frozenSpec.operation.inputs.map(
    ({ uuid, version, sha256, canonicalContentHash }) => ({
      uuid,
      version,
      sha256,
      canonicalContentHash,
    }),
  );
  const dataset = {
    ...evidence.dataset,
    schemaVersion: "tiangong.release.dataset-descriptor.v2",
    path: `canonical-datasets/${evidence.dataset.path}`,
    relationKind: "derived",
    materializationRole: "primary",
    resultProcessLayer: methods.length ? "lci-lcia" : "lci",
    expectedMethods: methods,
    parentResults: parents,
    // A parent's text comment is not structured source-provenance evidence.
    sourceAssociation: { status: "requires_verified_parent_lineage" },
  };
  const source = {
    parentCandidate: evidence.frozenSpec.operation.candidate,
    transformationFrozenSpecSha256: hashJson(evidence.frozenSpec),
    transformationExecutionReceiptSha256: evidence.receiptSha256,
    transformationHandoffSha256: hashJson(evidence.handoff),
  };
  const key = {
    schemaVersion: "tiangong.release.derived-materialization-key.v1",
    source,
  };
  const catalog = {
    schemaVersion: "tiangong.release.result-catalog.v2",
    source,
    datasets: [dataset],
  };
  const request = {
    schemaVersion: "tiangong.release.materialization-request.v2",
    inputKind: "verified-derived-result",
    outputType: "result-process",
    resultProcessLayer: dataset.resultProcessLayer,
    scope: {
      mode: "exact-transformation-output",
      results: [{ uuid: dataset.uuid, version: dataset.version }],
    },
  };
  const receiptHash = hashJson(key);
  const target = path.resolve(
    outDir ??
      path.join(
        resolveArtifactRoot(artifactRoot),
        "result-materialization",
        "derived",
        receiptHash,
      ),
  );
  const files = new Map([
    [dataset.path, evidence.bytes],
    ["materialization-key.json", Buffer.from(canonicalJson(key))],
    ["materialization-request.json", Buffer.from(canonicalJson(request))],
    ["result-catalog.json", Buffer.from(canonicalJson(catalog))],
    [
      "transformation-frozen-spec.json",
      Buffer.from(canonicalJson(evidence.frozenSpec)),
    ],
    [
      "transformation-execution-receipt.json",
      Buffer.from(canonicalJson(evidence.receipt)),
    ],
    [
      "transformation-handoff.json",
      Buffer.from(canonicalJson(evidence.handoff)),
    ],
  ]);
  let manifest;
  let disposition = "created";
  try {
    await writeImmutableDirectory(target, async (staging) => {
      for (const [relative, bytes] of files) {
        const file = path.join(staging, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes, { flag: "wx" });
      }
      const index = await writeCanonicalDatasetIndex(staging, [dataset]);
      manifest = buildManifest(source, catalog, dataset, index);
      await writeFile(
        path.join(staging, "materialization-manifest.json"),
        canonicalJson(manifest),
        { flag: "wx" },
      );
    });
  } catch (error) {
    if (outDir || error.code !== "output_exists") throw error;
    // Default paths reuse only a fully byte-verified artifact, never a partial
    // directory or a catalog whose metadata no longer matches this receipt.
    try {
      for (const [relative, expected] of files) {
        await verifyExistingFile(target, relative, expected);
      }
      const index = canonicalDatasetIndex([
        {
          datasetType: dataset.datasetType,
          role: dataset.role,
          uuid: dataset.uuid.toLowerCase(),
          version: dataset.version,
          path: dataset.path,
          sha256: sha256Bytes(evidence.bytes),
          byteSize: evidence.bytes.length,
          canonicalContentHash: dataset.canonicalContentHash,
        },
      ]);
      await verifyExistingFile(
        target,
        "canonical-dataset-index.json",
        Buffer.from(canonicalJson(index)),
      );
      manifest = buildManifest(source, catalog, dataset, index);
      await verifyExistingFile(
        target,
        "materialization-manifest.json",
        Buffer.from(canonicalJson(manifest)),
      );
    } catch {
      fail(
        "artifact_path_conflict",
        "Existing Derived Result Materialization is incomplete or has drifted",
      );
    }
    disposition = "reused_existing";
  }
  return { path: target, disposition, manifest, catalog, request };
}

function buildManifest(source, catalog, dataset, index) {
  return {
    schemaVersion: "tiangong.release.materialization-manifest.v2",
    completeness: "complete-for-selected-results",
    inputKind: "verified-derived-result",
    source,
    inputs: { resultCatalogSha256: hashJson(catalog) },
    canonicalDatasetIndexSha256: hashJson(index),
    datasets: [dataset],
    validation: {
      tidasSdk: "@tiangong-lca/tidas-sdk@0.6.0",
      transformedBytes: "verified",
      producerReplay: "verified",
      modelSchemas: "not_applicable",
    },
    candidateQualified: false,
    publicationAuthorized: false,
  };
}

async function verifyExistingFile(root, relative, expected) {
  const base = await realpath(root);
  const file = path.join(root, relative);
  const metadata = await lstat(file);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== expected.length ||
    !(await realpath(file)).startsWith(`${base}${path.sep}`)
  )
    throw new Error("file metadata mismatch");
  if (!(await readFile(file)).equals(expected))
    throw new Error("file mismatch");
}
