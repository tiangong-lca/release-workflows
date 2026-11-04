import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail, sha256Bytes } from "./common.mjs";
import { mapWithConcurrency } from "./concurrency.mjs";
import { loadMaterializationContext, selectAxes } from "./context.mjs";
import { MODEL_PROFILE } from "./identity.mjs";
import { renderLifecycleModel } from "./model-renderer.mjs";
import {
  assertNoContentCollision,
  hashJson,
  indexPreviousModelVariants,
  resolveExactSourceVariantVersions,
  versionSignificantHash,
} from "./versioning.mjs";

export async function materializeModels({
  intakeDir,
  resultCatalogPath,
  outDir,
  processUuids,
  firstGeneration = false,
  previousManifestPath,
  onProgress,
  context: suppliedContext,
  appendToExisting = false,
  concurrency = 2,
}) {
  if (firstGeneration === Boolean(previousManifestPath)) {
    fail(
      "version_history_choice_required",
      "Choose exactly one of --first-generation or --previous-manifest",
    );
  }
  const previousManifest = previousManifestPath
    ? JSON.parse(await readFile(path.resolve(previousManifestPath), "utf8"))
    : null;
  const previous = indexPreviousModelVariants(previousManifest);
  const context =
    suppliedContext ?? (await loadMaterializationContext(intakeDir));
  const catalogFile = path.resolve(resultCatalogPath);
  const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
  validateCatalog(context, catalog);
  await verifyCatalogDatasets(catalogFile, catalog);
  const allowedRoots = new Set(catalog.selection.map(exactIdentityKey));
  const requested = processUuids?.length
    ? processUuids
    : catalog.selection.map((item) => `${item.id}@${item.version}`);
  const axes = selectAxes(context, requested);
  for (const axis of axes) {
    if (!allowedRoots.has(exactIdentityKey(axis.rootProcess))) {
      fail(
        "model_selection_outside_result_roots",
        `Process is not a selected Model root: ${axis.rootProcess.id}@${axis.rootProcess.version}`,
      );
    }
  }
  await onProgress?.({
    phase: "planning_model_versions",
    completed: 0,
    total: axes.length,
  });
  const drafts = [];
  const reconstructionFindings = [];
  for (const [index, axis] of axes.entries()) {
    try {
      const provisional = renderLifecycleModel(
        context,
        axis,
        catalog,
        "01.00.000",
      );
      if (provisional.reconstruction.warnings.length) {
        reconstructionFindings.push({
          processIndex: axis.processIndex,
          sourceProcess: axis.rootProcess,
          warnings: provisional.reconstruction.warnings,
          blockers: [],
        });
      }
      drafts.push({
        axis,
        provisional: {
          uuid: provisional.uuid,
          sourceProcess: provisional.sourceProcess,
        },
        hashes: modelHashes(provisional),
      });
    } catch (error) {
      if (error.code !== "one_hop_reconstruction_mismatch") throw error;
      reconstructionFindings.push({
        sourceProcess: axis.rootProcess,
        ...error.details,
      });
    }
    await onProgress?.({
      phase: "planning_model_versions",
      completed: index + 1,
      total: axes.length,
      currentProcess: `${axis.rootProcess.id}@${axis.rootProcess.version}`,
    });
  }
  const blockerCount = reconstructionFindings.reduce(
    (sum, item) => sum + item.blockers.length,
    0,
  );
  const warningCount = reconstructionFindings.reduce(
    (sum, item) => sum + item.warnings.length,
    0,
  );
  if (blockerCount) {
    fail(
      "one_hop_reconstruction_mismatch",
      "One-hop inventory reconstruction failed",
      {
        blockerCount,
        warningCount,
        findings: reconstructionFindings,
      },
    );
  }
  const reconstructionOutcome = warningCount
    ? "passed_with_warnings"
    : "passed";
  const resolutions = resolveExactSourceVariantVersions(drafts, previous, {
    datasetType: "lifecyclemodel",
    duplicateCode: "model_source_variant_duplicate",
  });
  const target = path.resolve(outDir);
  const staging = appendToExisting ? target : await mkdtemp(`${target}.tmp-`);
  const datasetDir = path.join(
    staging,
    "canonical-datasets",
    "lifecyclemodels",
  );
  await mkdir(datasetDir, { recursive: true });
  if (!appendToExisting) {
    const resultDir = path.join(staging, "canonical-datasets", "processes");
    await mkdir(resultDir, { recursive: true });
    const catalogRoot = path.dirname(catalogFile);
    for (const dataset of catalog.datasets) {
      const destination = path.resolve(staging, dataset.path);
      if (!destination.startsWith(`${staging}${path.sep}`)) {
        fail(
          "unsafe_catalog_path",
          `Unsafe Result Catalog path: ${dataset.path}`,
        );
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(
        resolveCatalogDatasetPath(catalogRoot, dataset.path),
        destination,
      );
    }
  }
  let completedCount = 0;
  let outputBytes = 0;
  await onProgress?.({
    phase: "composing_models",
    completed: 0,
    total: axes.length,
  });
  const descriptors = await mapWithConcurrency(
    drafts,
    concurrency,
    async ({ axis }) => {
      const { historical, ...resolution } = resolutions.get(axis.processIndex);
      const rendered = renderLifecycleModel(
        context,
        axis,
        catalog,
        resolution.version,
      );
      const finalHashes = modelHashes(rendered);
      const descriptor = {
        schemaVersion: "tiangong.release.dataset-descriptor.v1",
        datasetType: "lifecyclemodel",
        role: "lifecycle_model",
        materializationRole: "primary",
        processIndex: rendered.processIndex,
        uuid: rendered.uuid,
        version: rendered.version,
        profile: MODEL_PROFILE,
        identity: rendered.identity,
        sourceProcess: rendered.sourceProcess,
        resultProcess: rendered.resultProcess,
        providerCount: rendered.providerCount,
        reconstruction: rendered.reconstruction,
        versionChange: resolution.change,
        ...finalHashes,
      };
      assertNoContentCollision(descriptor, historical);
      const fileName = `${descriptor.uuid}_${descriptor.version}.json`;
      const content = canonicalJson(rendered.document);
      await writeFile(path.join(datasetDir, fileName), content, { flag: "wx" });
      outputBytes += Buffer.byteLength(content);
      completedCount += 1;
      await onProgress?.({
        phase: "composing_models",
        completed: completedCount,
        total: axes.length,
        outputBytes,
        currentProcess: `${axis.rootProcess.id}@${axis.rootProcess.version}`,
      });
      return {
        ...descriptor,
        path: `canonical-datasets/lifecyclemodels/${fileName}`,
      };
    },
  );
  descriptors.sort((left, right) => left.processIndex - right.processIndex);
  try {
    const resultDatasets = catalog.datasets;
    const modelDatasets = descriptors;
    const modelCatalog = {
      schemaVersion: "tiangong.release.model-catalog.v1",
      completeness: "complete-for-selected-roots",
      calculationId: context.intake.source.calculationId,
      bundleContentHash: context.intake.source.bundleContentHash,
      resultCatalogSha256: sha256Bytes(await readFile(catalogFile)),
      selection: axes.map((axis) => axis.rootProcess).sort(compareIdentity),
      datasets: modelDatasets,
    };
    await writeFile(
      path.join(staging, "model-catalog.json"),
      canonicalJson(modelCatalog),
      { flag: "wx" },
    );
    const materializationManifest = {
      schemaVersion: "tiangong.release.materialization-manifest.v1",
      completeness: "complete-for-selected-roots",
      inputs: {
        calculationId: context.intake.source.calculationId,
        bundleContentHash: context.intake.source.bundleContentHash,
        intakeManifestSha256: hashJson(context.intake),
        resultCatalogSha256: modelCatalog.resultCatalogSha256,
        previousManifestSha256: previousManifest
          ? hashJson(previousManifest)
          : null,
        firstGeneration,
      },
      profiles: {
        result: catalog.datasets[0]?.profile ?? null,
        model: MODEL_PROFILE,
      },
      datasets: [...resultDatasets, ...modelDatasets],
      validation: {
        tidasSdk: "@tiangong-lca/tidas-sdk@0.6.0",
        sourceDocuments: "verified",
        resultReferences: "verified",
        modelSchemas: "passed",
        oneHopReconstruction: reconstructionOutcome,
      },
    };
    await writeFile(
      path.join(staging, "materialization-manifest.json"),
      canonicalJson(materializationManifest),
      { flag: "wx" },
    );
    await writeFile(
      path.join(staging, "materialization-report.json"),
      canonicalJson({
        schemaVersion: "tiangong.release.model-materialization-report.v1",
        outcome: "materialized",
        completeness: "complete-for-selected-roots",
        modelCount: descriptors.length,
        providerInstanceCount: descriptors.reduce(
          (total, item) => total + item.providerCount,
          0,
        ),
        oneHopReconstruction: {
          outcome: reconstructionOutcome,
          warningCount,
          findings: reconstructionFindings,
        },
        versionChanges: countChanges(descriptors),
      }),
      appendToExisting ? undefined : { flag: "wx" },
    );
    if (!appendToExisting) {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(staging, target);
    }
    return {
      path: target,
      catalog: modelCatalog,
      manifest: materializationManifest,
    };
  } catch (error) {
    if (!appendToExisting) await rm(staging, { recursive: true, force: true });
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
      fail(
        error.syscall === "rename" ? "output_exists" : "duplicate_uuid",
        error.syscall === "rename"
          ? `Refusing to overwrite existing output: ${target}`
          : `Duplicate canonical dataset UUID/version collision: ${error.message}`,
      );
    }
    throw error;
  }
}

function validateCatalog(context, catalog) {
  if (catalog.schemaVersion !== "tiangong.release.result-catalog.v1") {
    fail("result_catalog_invalid", "Expected result-catalog.v1");
  }
  if (
    catalog.calculationId !== context.intake.source.calculationId ||
    catalog.bundleContentHash !== context.intake.source.bundleContentHash
  ) {
    fail(
      "result_catalog_input_mismatch",
      "Result Catalog belongs to a different Calculation Bundle",
    );
  }
  if (!Array.isArray(catalog.selection) || !Array.isArray(catalog.datasets)) {
    fail(
      "result_catalog_invalid",
      "Result Catalog must contain selection[] and datasets[]",
    );
  }
}

async function verifyCatalogDatasets(catalogFile, catalog) {
  const root = path.dirname(catalogFile);
  const keys = new Set();
  for (const dataset of catalog.datasets) {
    const resolved = resolveCatalogDatasetPath(root, dataset.path);
    const document = JSON.parse(await readFile(resolved, "utf8"));
    if (hashJson(document) !== dataset.canonicalContentHash) {
      fail(
        "result_catalog_content_mismatch",
        `Result dataset hash mismatch: ${dataset.uuid}`,
      );
    }
    const key = exactDatasetKey(dataset.uuid, dataset.version);
    if (keys.has(key)) {
      fail(
        "result_catalog_dataset_duplicate",
        `Duplicate Result Catalog dataset: ${dataset.uuid}@${dataset.version}`,
      );
    }
    keys.add(key);
  }
}

function resolveCatalogDatasetPath(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    fail("unsafe_catalog_path", `Unsafe Result Catalog path: ${relativePath}`);
  }
  return resolved;
}

function exactIdentityKey(identity) {
  return `${identity.id.toLowerCase()}@${identity.version}`;
}

function exactDatasetKey(uuid, version) {
  return `${uuid.toLowerCase()}@${version}`;
}

function modelHashes(model) {
  const data = model.document.lifeCycleModelDataSet;
  const information = data.lifeCycleModelInformation;
  const semantic = {
    schema: "tiangong.release.lifecycle-model-semantic.v1",
    profile: MODEL_PROFILE,
    uuid: model.uuid,
    sourceProcess: model.sourceProcess,
    resultingProcess: model.resultProcess,
    quantitativeReference: information.quantitativeReference,
    processInstances: information.technology.processes.processInstance.map(
      (instance) => ({
        id: instance["@dataSetInternalID"],
        multiplicationFactor: instance["@multiplicationFactor"],
        process: {
          uuid: instance.referenceToProcess["@refObjectId"].toLowerCase(),
          version: instance.referenceToProcess["@version"],
        },
        connections: instance.connections ?? null,
      }),
    ),
  };
  return {
    versionSignificantHash: versionSignificantHash(model.document),
    semanticHash: hashJson(semantic),
    canonicalContentHash: hashJson(model.document),
  };
}

function countChanges(descriptors) {
  return descriptors.reduce((result, item) => {
    result[item.versionChange] = (result[item.versionChange] ?? 0) + 1;
    return result;
  }, {});
}

function compareIdentity(left, right) {
  return (
    left.id.localeCompare(right.id) || left.version.localeCompare(right.version)
  );
}
