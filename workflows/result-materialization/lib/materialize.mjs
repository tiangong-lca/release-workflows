import { readResultVersionPlan } from "./registry-version-plan.mjs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail } from "./common.mjs";
import { materializeModels } from "./materialize-models.mjs";
import { materializeResults } from "./materialize-results.mjs";
import { hashJson } from "./versioning.mjs";
import { loadMaterializationContext } from "./context.mjs";
import { selectAxes } from "./context.mjs";
import { writeCanonicalDatasetIndex } from "./canonical-index.mjs";
import {
  artifactPathConflict,
  buildMaterializationIdentity,
  canonicalMaterializationPath,
  resolveArtifactRoot,
  verifyExistingMaterialization,
} from "./artifact-paths.mjs";

export const OUTPUT_TYPES = new Set(["result-process", "lifecycle-model"]);
export const RESULT_PROCESS_LAYERS = new Set(["lci", "lci-lcia"]);

export async function prepareMaterialization({
  intakeDir,
  outDir,
  artifactRoot,
  processUuids,
  outputType,
  resultProcessLayer,
  firstGeneration = false,
  previousManifestPath,
  resultVersionPlanPath,
}) {
  validateChoices(outputType, resultProcessLayer);
  if (outDir && artifactRoot)
    fail(
      "invalid_arguments",
      "Choose either --out-dir or --artifact-root, not both",
    );
  if (firstGeneration === Boolean(previousManifestPath))
    fail(
      "version_history_choice_required",
      "Choose exactly one of --first-generation or --previous-manifest",
    );
  const context = await loadMaterializationContext(intakeDir);
  const selectedAxes = selectAxes(context, processUuids);
  if (!selectedAxes.length)
    fail("empty_selection", "Result materialization selection is empty");
  const previousManifestSha256 = previousManifestPath
    ? hashJson(
        JSON.parse(await readFile(path.resolve(previousManifestPath), "utf8")),
      )
    : null;
  const resultVersionPlan = resultVersionPlanPath
    ? await readResultVersionPlan(resultVersionPlanPath)
    : null;
  const identity = buildMaterializationIdentity({
    context,
    selectedAxes,
    scopeMode: processUuids?.length ? "selected" : "all_eligible",
    outputType,
    resultProcessLayer,
    firstGeneration,
    previousManifestSha256,
    resultVersionPlanSha256: resultVersionPlan
      ? hashJson(resultVersionPlan)
      : null,
  });
  const root = resolveArtifactRoot(artifactRoot);
  const recommendedCanonicalPath = canonicalMaterializationPath(
    root,
    identity.key.source,
    identity.sha256,
  );
  const target = outDir ? path.resolve(outDir) : recommendedCanonicalPath;
  return {
    context,
    selectedAxes,
    resultVersionPlan,
    identity,
    target,
    artifactRoot: root,
    recommendedCanonicalPath,
    pathPolicy: outDir
      ? "explicit-output.v1"
      : "canonical-content-addressed.v1",
  };
}

export async function materialize({
  intakeDir,
  outDir,
  artifactRoot,
  processUuids,
  outputType,
  resultProcessLayer,
  firstGeneration = false,
  previousManifestPath,
  resultVersionPlanPath,
  onProgress,
  concurrency = 2,
  prepared,
}) {
  const plan =
    prepared ??
    (await prepareMaterialization({
      intakeDir,
      outDir,
      artifactRoot,
      processUuids,
      outputType,
      resultProcessLayer,
      firstGeneration,
      previousManifestPath,
      resultVersionPlanPath,
    }));
  const target = plan.target;
  if (!outDir) {
    const existing = await verifyExistingMaterialization(
      target,
      plan.identity.key,
    );
    if (existing === false) artifactPathConflict(target);
    if (existing)
      return materializationResult({
        path: target,
        request: existing.request,
        manifest: existing.manifest,
        disposition: "reused_existing",
        plan,
      });
  }
  await mkdir(path.dirname(target), { recursive: true });
  const workspace = await mkdtemp(`${target}.work-`);
  let primaryError;
  try {
    await onProgress?.({ phase: "preparing", completed: 0, total: null });
    const context = plan.context;
    const results = await materializeResults({
      intakeDir,
      outDir: path.join(workspace, "complete"),
      processUuids,
      includeDirectProviders: outputType === "lifecycle-model",
      resultProcessLayer,
      firstGeneration,
      previousManifestPath,
      resultVersionPlan: plan.resultVersionPlan,
      onProgress,
      context,
      concurrency,
    });
    const request = {
      schemaVersion: "tiangong.release.materialization-request.v1",
      scope: {
        mode: processUuids?.length ? "selected" : "all_eligible",
        requestedSelectors: processUuids ?? [],
        processes: results.catalog.selection,
      },
      outputType,
      resultProcessLayer,
      modelProfile:
        outputType === "lifecycle-model"
          ? "resolved-one-hop-aggregated-background.v1"
          : null,
    };
    let completed;
    if (outputType === "lifecycle-model") {
      completed = await materializeModels({
        intakeDir,
        resultCatalogPath: path.join(results.path, "result-catalog.json"),
        outDir: results.path,
        processUuids,
        firstGeneration,
        previousManifestPath,
        onProgress,
        context,
        appendToExisting: true,
        concurrency,
      });
    } else {
      completed = await finalizeResultOnly({
        results,
        intakeDir,
        previousManifestPath,
        firstGeneration,
      });
    }
    if (plan.resultVersionPlan) {
      request.resultVersionPlanSha256 = hashJson(plan.resultVersionPlan);
      completed.manifest.inputs.resultVersionPlanSha256 =
        request.resultVersionPlanSha256;
      await writeFile(
        path.join(completed.path, "result-version-plan.json"),
        canonicalJson(plan.resultVersionPlan),
        { flag: "wx" },
      );
    }
    completed.manifest.inputs.materializationRequestSha256 = hashJson(request);
    await onProgress?.({ phase: "validating", completed: 0, total: 1 });
    await writeFile(
      path.join(completed.path, "materialization-manifest.json"),
      canonicalJson(completed.manifest),
    );
    await writeFile(
      path.join(completed.path, "materialization-request.json"),
      canonicalJson(request),
      { flag: "wx" },
    );
    await writeFile(
      path.join(completed.path, "materialization-key.json"),
      canonicalJson(plan.identity.key),
      { flag: "wx" },
    );
    const canonicalIndex = await writeCanonicalDatasetIndex(
      completed.path,
      completed.manifest.datasets,
    );
    completed.manifest.inputs.canonicalDatasetIndexSha256 =
      hashJson(canonicalIndex);
    await writeFile(
      path.join(completed.path, "materialization-manifest.json"),
      canonicalJson(completed.manifest),
    );
    await onProgress?.({ phase: "committing", completed: 0, total: 1 });
    await rename(completed.path, target);
    await onProgress?.({ phase: "committing", completed: 1, total: 1 });
    return materializationResult({
      path: target,
      request,
      manifest: completed.manifest,
      disposition: "created",
      plan,
    });
  } catch (error) {
    primaryError = error;
    if (
      (error.code === "EEXIST" || error.code === "ENOTEMPTY") &&
      error.syscall === "rename"
    ) {
      if (!outDir) {
        const existing = await verifyExistingMaterialization(
          target,
          plan.identity.key,
        );
        if (existing)
          return materializationResult({
            path: target,
            request: existing.request,
            manifest: existing.manifest,
            disposition: "reused_existing",
            plan,
          });
        artifactPathConflict(target);
      }
      primaryError = new Error(
        `Refusing to overwrite existing output: ${target}`,
      );
      primaryError.code = "output_exists";
      primaryError.details = { causeCode: error.code };
    }
    throw primaryError;
  } finally {
    try {
      await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      primaryError.details = {
        ...(primaryError.details ?? {}),
        cleanupError: {
          code: cleanupError.code ?? "cleanup_failed",
          message: cleanupError.message,
        },
      };
    }
  }
}

function validateChoices(outputType, resultProcessLayer) {
  if (!OUTPUT_TYPES.has(outputType))
    fail("unsupported_output_type", `Unsupported output type: ${outputType}`);
  if (!RESULT_PROCESS_LAYERS.has(resultProcessLayer))
    fail(
      "unsupported_result_process_layer",
      `Unsupported Result Process layer: ${resultProcessLayer}`,
    );
}

function materializationResult({
  path: outputPath,
  request,
  manifest,
  disposition,
  plan,
}) {
  const datasets = manifest.datasets;
  return {
    path: outputPath,
    artifactRoot: plan.artifactRoot,
    artifactPath: outputPath,
    recommendedCanonicalPath: plan.recommendedCanonicalPath,
    request,
    manifest,
    disposition,
    pathPolicy: plan.pathPolicy,
    artifactIdentity: {
      schemaVersion: plan.identity.key.schemaVersion,
      materializationKeySha256: plan.identity.sha256,
      source: plan.identity.key.source,
    },
    summary: {
      requestedRootCount: request.scope.processes.length,
      primaryDatasetCount: datasets.filter((item) =>
        ["primary", "lifecycle_model"].includes(
          item.materializationRole ?? item.role,
        ),
      ).length,
      dependencyDatasetCount: datasets.filter(
        (item) => item.materializationRole === "dependency",
      ).length,
      resultingDatasetCount: datasets.filter(
        (item) => item.materializationRole === "resulting",
      ).length,
    },
  };
}

async function finalizeResultOnly({
  results,
  intakeDir,
  previousManifestPath,
  firstGeneration,
}) {
  const intake = JSON.parse(
    await readFile(
      path.join(path.resolve(intakeDir), "intake-manifest.json"),
      "utf8",
    ),
  );
  const manifest = {
    schemaVersion: "tiangong.release.materialization-manifest.v1",
    completeness: "complete-for-selected-roots",
    inputs: {
      calculationId: intake.source.calculationId,
      bundleContentHash: intake.source.bundleContentHash,
      intakeManifestSha256: hashJson(intake),
      resultCatalogSha256: hashJson(results.catalog),
      previousManifestSha256: previousManifestPath
        ? hashJson(
            JSON.parse(
              await readFile(path.resolve(previousManifestPath), "utf8"),
            ),
          )
        : null,
      firstGeneration,
    },
    profiles: {
      result: results.catalog.datasets[0]?.profile ?? null,
      model: null,
    },
    datasets: results.catalog.datasets,
    validation: {
      tidasSdk: "@tiangong-lca/tidas-sdk@0.2.0",
      sourceDocuments: "verified",
      resultReferences: "verified",
      modelSchemas: "not_applicable",
      oneHopReconstruction: "not_applicable",
    },
  };
  await writeFile(
    path.join(results.path, "materialization-manifest.json"),
    canonicalJson(manifest),
    { flag: "wx" },
  );
  return { path: results.path, manifest };
}
