import { applyResultVersionPlan } from "./registry-version-plan.mjs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail } from "./common.mjs";
import { mapWithConcurrency } from "./concurrency.mjs";
import { loadMaterializationContext, selectAxes } from "./context.mjs";
import { RESULT_PROFILES } from "./identity.mjs";
import { renderResultProcess } from "./result-renderer.mjs";
import {
  assertNoContentCollision,
  hashJson,
  indexPreviousResultVariants,
  resolveVersion,
  versionSignificantHash,
} from "./versioning.mjs";

export async function materializeResults({
  intakeDir,
  outDir,
  processUuids,
  includeDirectProviders = false,
  resultProcessLayer = "lci-lcia",
  firstGeneration = false,
  previousManifestPath,
  resultVersionPlan,
  onProgress,
  context: suppliedContext,
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
  const previous = indexPreviousResultVariants(previousManifest);
  const context =
    suppliedContext ?? (await loadMaterializationContext(intakeDir));
  const rootAxes = selectAxes(context, processUuids);
  if (!rootAxes.length)
    fail("empty_selection", "Result materialization selection is empty");
  const profile = RESULT_PROFILES[resultProcessLayer];
  if (!profile)
    fail(
      "unsupported_result_process_layer",
      `Unsupported Result Process layer: ${resultProcessLayer}`,
    );
  const rootIndexes = new Set(rootAxes.map((axis) => axis.processIndex));
  const requiredIndexes = new Set(rootIndexes);
  if (includeDirectProviders) {
    for (const edge of context.technosphereEdges) {
      if (rootIndexes.has(edge.dependentProcessIndex)) {
        requiredIndexes.add(edge.balancingProcessIndex);
      }
    }
  }
  const axes = context.axes.filter((axis) =>
    requiredIndexes.has(axis.processIndex),
  );
  await onProgress?.({
    phase: "planning_result_versions",
    completed: 0,
    total: axes.length,
  });
  const drafts = [];
  for (const [index, axis] of axes.entries()) {
    const provisional = renderResultProcess(
      context,
      axis,
      "01.00.000",
      resultProcessLayer,
    );
    const hashes = resultHashes(provisional);
    drafts.push({
      axis,
      provisional: {
        uuid: provisional.uuid,
        sourceProcess: provisional.sourceProcess,
      },
      hashes,
    });
    await onProgress?.({
      phase: "planning_result_versions",
      completed: index + 1,
      total: axes.length,
      currentProcess: `${axis.rootProcess.id}@${axis.rootProcess.version}`,
    });
  }
  const resolutions = resolveResultVariantVersions(drafts, previous);
  applyResultVersionPlan(
    resultVersionPlan,
    drafts,
    resolutions,
    (draft, version) =>
      hashJson(
        renderResultProcess(context, draft.axis, version, resultProcessLayer)
          .document,
      ),
  );
  const target = path.resolve(outDir);
  const staging = await mkdtemp(`${target}.tmp-`);
  try {
    const datasetDir = path.join(staging, "canonical-datasets", "processes");
    await mkdir(datasetDir, { recursive: true });
    let completed = 0;
    let outputBytes = 0;
    await onProgress?.({
      phase: "materializing_results",
      completed,
      total: drafts.length,
    });
    const descriptors = await mapWithConcurrency(
      drafts,
      concurrency,
      async ({ axis }) => {
        const { historical, ...resolution } = resolutions.get(
          axis.processIndex,
        );
        const rendered = renderResultProcess(
          context,
          axis,
          resolution.version,
          resultProcessLayer,
        );
        const finalHashes = resultHashes(rendered);
        const descriptor = {
          schemaVersion: "tiangong.release.dataset-descriptor.v1",
          datasetType: "process",
          role: "result_process",
          processIndex: axis.processIndex,
          uuid: rendered.uuid,
          version: rendered.version,
          profile,
          materializationRole: rootIndexes.has(axis.processIndex)
            ? includeDirectProviders
              ? "resulting"
              : "primary"
            : "dependency",
          sourceProcess: rendered.sourceProcess,
          referencePivot: rendered.referencePivot,
          identity: rendered.identity,
          versionChange: resolution.change,
          ...finalHashes,
          counts: rendered.counts,
        };
        assertNoContentCollision(descriptor, historical);
        const fileName = `${descriptor.uuid}_${descriptor.version}.json`;
        const content = canonicalJson(rendered.document);
        await writeFile(path.join(datasetDir, fileName), content, {
          flag: "wx",
        });
        outputBytes += Buffer.byteLength(content);
        completed += 1;
        await onProgress?.({
          phase: "materializing_results",
          completed,
          total: drafts.length,
          outputBytes,
          currentProcess: `${axis.rootProcess.id}@${axis.rootProcess.version}`,
        });
        return {
          ...descriptor,
          path: `canonical-datasets/processes/${fileName}`,
        };
      },
    );
    descriptors.sort((left, right) => left.processIndex - right.processIndex);
    await onProgress?.({
      phase: "freezing_result_catalog",
      completed: 0,
      total: 1,
    });
    const catalogDatasets = [];
    for (const descriptor of descriptors) {
      catalogDatasets.push(descriptor);
    }
    const catalog = {
      schemaVersion: "tiangong.release.result-catalog.v1",
      completeness: "complete-for-selection",
      outputType: includeDirectProviders ? "lifecycle_model" : "result_process",
      resultProcessLayer,
      calculationId: context.intake.source.calculationId,
      bundleContentHash: context.intake.source.bundleContentHash,
      selection: rootAxes.map((axis) => axis.rootProcess).sort(compareIdentity),
      requiredResults: axes
        .map((axis) => axis.rootProcess)
        .sort(compareIdentity),
      datasets: catalogDatasets,
    };
    await writeFile(
      path.join(staging, "result-catalog.json"),
      canonicalJson(catalog),
      { flag: "wx" },
    );
    await onProgress?.({
      phase: "freezing_result_catalog",
      completed: 1,
      total: 1,
    });
    await writeFile(
      path.join(staging, "materialization-report.json"),
      canonicalJson({
        schemaVersion: "tiangong.release.result-materialization-report.v2",
        outcome: "materialized",
        completeness: "complete-for-selection",
        datasetCount: descriptors.length,
        versionChanges: countChanges(descriptors),
        validator: "@tiangong-lca/tidas-sdk@0.6.0",
      }),
      { flag: "wx" },
    );
    await mkdir(path.dirname(target), { recursive: true });
    await rename(staging, target);
    return { path: target, catalog };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
      fail(
        error.syscall === "rename" ? "output_exists" : "duplicate_uuid",
        error.syscall === "rename"
          ? `Refusing to overwrite existing output: ${target}`
          : `Duplicate canonical dataset UUID collision: ${error.message}`,
      );
    }
    throw error;
  }
}

export function resultHashes(result) {
  const data = result.document.processDataSet;
  const semantic = {
    schema: "tiangong.release.result-process-semantic.v2",
    profile: result.profile,
    uuid: result.uuid,
    sourceProcess: result.sourceProcess,
    referencePivot: result.referencePivot,
    quantitativeReference: data.processInformation.quantitativeReference,
    typeOfDataSet:
      data.modellingAndValidation.LCIMethodAndAllocation.typeOfDataSet,
    exchanges: data.exchanges.exchange.map((exchange) => ({
      flow: {
        uuid: exchange.referenceToFlowDataSet["@refObjectId"].toLowerCase(),
        version: exchange.referenceToFlowDataSet["@version"],
      },
      direction: exchange.exchangeDirection,
      location: exchange.location ?? null,
      meanAmount: exchange.meanAmount,
    })),
    lciaResults: (data.LCIAResults?.LCIAResult ?? []).map((item) => ({
      method: {
        uuid: item.referenceToLCIAMethodDataSet["@refObjectId"].toLowerCase(),
        version: item.referenceToLCIAMethodDataSet["@version"],
      },
      meanAmount: item.meanAmount,
    })),
  };
  return {
    versionSignificantHash: versionSignificantHash(result.document),
    semanticHash: hashJson(semantic),
    canonicalContentHash: hashJson(result.document),
  };
}

export function resolveResultVariantVersions(drafts, previous) {
  const grouped = new Map();
  for (const draft of drafts) {
    const key = `process:${draft.provisional.uuid}`;
    const variants = grouped.get(key) ?? [];
    variants.push(draft);
    grouped.set(key, variants);
  }
  const result = new Map();
  for (const [lineageKey, variants] of grouped) {
    variants.sort(
      (left, right) =>
        compareIdentity(
          left.provisional.sourceProcess,
          right.provisional.sourceProcess,
        ) || left.axis.processIndex - right.axis.processIndex,
    );
    const occupied = new Map(
      (previous.byLineage.get(lineageKey) ?? []).map((dataset) => [
        dataset.version,
        exactSourceVariantKey(lineageKey, dataset.sourceProcess),
      ]),
    );
    const currentSources = new Set();
    for (const draft of variants) {
      const sourceKey = exactSourceVariantKey(
        lineageKey,
        draft.provisional.sourceProcess,
      );
      if (currentSources.has(sourceKey)) {
        fail(
          "result_source_variant_duplicate",
          `Calculation contains the same exact Result source variant more than once: ${sourceKey}`,
        );
      }
      currentSources.add(sourceKey);
      const historical = previous.bySource.get(sourceKey);
      let resolution = resolveVersion(
        { uuid: draft.provisional.uuid, ...draft.hashes },
        historical,
      );
      const owner = occupied.get(resolution.version);
      if (owner && owner !== sourceKey) {
        resolution = {
          version: nextFreeMajorVersion(occupied, resolution.version),
          change: historical ? "major" : "initial",
        };
      }
      occupied.set(resolution.version, sourceKey);
      result.set(draft.axis.processIndex, { ...resolution, historical });
    }
  }
  return result;
}

function exactSourceVariantKey(lineageKey, sourceProcess) {
  return `${lineageKey}:${sourceProcess.id.toLowerCase()}@${sourceProcess.version}`;
}

function nextFreeMajorVersion(occupied, proposed) {
  let major = Number(String(proposed).slice(0, 2));
  while (major <= 99) {
    const candidate = `${String(major).padStart(2, "0")}.00.000`;
    if (!occupied.has(candidate)) return candidate;
    major += 1;
  }
  fail(
    "dataset_version_overflow",
    `Cannot allocate another exact source variant after ${proposed}`,
  );
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
