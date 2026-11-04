import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { canonicalJson, fail, sha256Bytes, sha256File } from "./common.mjs";
import { hashJson } from "./versioning.mjs";

export const MATERIALIZATION_KEY_SCHEMA =
  "tiangong.release.materialization-key.v1";
export const RECIPE_CONTRACT_VERSION = "result-materialization.v2";
export const METADATA_POLICY = Object.freeze({
  schemaVersion: "tiangong.release.result-metadata-policy.v2",
  missingTextCompatibility: "single-space",
  historicalEmptyTextArrays: "four-known-fields-en-empty-text",
  emptyVariableParameter: "omit",
  commentOnlyVariableParameter: "append-to-general-comment",
  generatedGeneralComment: "preserve-source-and-append-provenance",
  sourceAdministrativeMetadata: "preserve-compatible",
});

const DEFAULT_ARTIFACT_ROOT = fileURLToPath(
  new URL("../../../.release/", import.meta.url),
);

export function resolveArtifactRoot(value) {
  return path.resolve(value ?? DEFAULT_ARTIFACT_ROOT);
}

export function canonicalIntakePath(root, source) {
  return path.join(
    resolveArtifactRoot(root),
    "result-materialization",
    "intakes",
    source.calculationId,
    source.bundleContentHash,
  );
}

export function buildMaterializationIdentity({
  context,
  selectedAxes,
  scopeMode,
  outputType,
  resultProcessLayer,
  firstGeneration,
  previousManifestSha256,
  resultVersionPlanSha256,
}) {
  const key = {
    schemaVersion: MATERIALIZATION_KEY_SCHEMA,
    source: {
      calculationId: context.intake.source.calculationId,
      bundleContentHash: context.intake.source.bundleContentHash,
    },
    scope: {
      mode: scopeMode,
      resolvedProcesses: selectedAxes
        .map(
          (axis) =>
            `${axis.rootProcess.id.toLowerCase()}@${axis.rootProcess.version}`,
        )
        .sort(),
    },
    outputType,
    resultProcessLayer,
    modelProfile:
      outputType === "lifecycle-model"
        ? "resolved-one-hop-aggregated-background.v1"
        : null,
    generationBase: {
      mode: firstGeneration ? "first-generation" : "previous-manifest",
      previousManifestSha256: previousManifestSha256 ?? null,
    },
    metadataPolicySha256: hashJson(METADATA_POLICY),
    recipeContractVersion:
      outputType === "lifecycle-model"
        ? "result-materialization.v3"
        : RECIPE_CONTRACT_VERSION,
    ...(resultVersionPlanSha256 ? { resultVersionPlanSha256 } : {}),
  };
  return { key, sha256: sha256Bytes(Buffer.from(canonicalJson(key))) };
}

export function canonicalMaterializationPath(root, source, keySha256) {
  return path.join(
    resolveArtifactRoot(root),
    "result-materialization",
    "materializations",
    source.calculationId,
    source.bundleContentHash,
    keySha256,
  );
}

export async function verifyExistingMaterialization(target, expected) {
  let manifest;
  let request;
  let index;
  let key;
  try {
    [manifest, request, index, key] = await Promise.all([
      readJson(path.join(target, "materialization-manifest.json")),
      readJson(path.join(target, "materialization-request.json")),
      readJson(path.join(target, "canonical-dataset-index.json")),
      readJson(path.join(target, "materialization-key.json")),
    ]);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const valid =
    manifest.schemaVersion === "tiangong.release.materialization-manifest.v1" &&
    manifest.completeness === "complete-for-selected-roots" &&
    manifest.inputs?.calculationId === expected.source.calculationId &&
    manifest.inputs?.bundleContentHash === expected.source.bundleContentHash &&
    manifest.inputs?.materializationRequestSha256 === hashJson(request) &&
    manifest.inputs?.canonicalDatasetIndexSha256 === hashJson(index) &&
    canonicalJson(key) === canonicalJson(expected) &&
    index.schemaVersion === "tiangong.release.canonical-dataset-index.v1" &&
    index.datasetCount === index.datasets?.length;
  if (!valid) return false;
  if (expected.resultVersionPlanSha256) {
    try {
      if (
        hashJson(
          await readJson(path.join(target, "result-version-plan.json")),
        ) !== expected.resultVersionPlanSha256 ||
        request.resultVersionPlanSha256 !== expected.resultVersionPlanSha256 ||
        manifest.inputs.resultVersionPlanSha256 !==
          expected.resultVersionPlanSha256
      )
        return false;
    } catch {
      return false;
    }
  }
  for (const dataset of index.datasets) {
    const file = path.resolve(target, String(dataset.path ?? ""));
    if (!file.startsWith(`${path.resolve(target)}${path.sep}`)) return false;
    try {
      const metadata = await stat(file);
      if (
        metadata.size !== dataset.byteSize ||
        (await sha256File(file)) !== dataset.sha256
      )
        return false;
    } catch {
      return false;
    }
  }
  return { manifest, request, index, key };
}

export function artifactPathConflict(target) {
  fail(
    "artifact_path_conflict",
    `Canonical artifact path exists but is incomplete or does not match its identity: ${target}`,
    {
      path: target,
      recovery: "Inspect or remove the conflicting path, then retry.",
    },
  );
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
