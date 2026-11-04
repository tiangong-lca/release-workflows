import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  lstat,
  stat,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalJson, hashJson, sha256Bytes, fail } from "./common.mjs";
import { loadReleaseIntake } from "./release-intake.mjs";
import {
  assembleCanonicalCollection,
  buildIndex,
  validateReleaseIntakeBindings,
  verifyTidasRuntime,
  spawnBounded,
  tidasSpawnOptions,
  RESULT_PACKAGE_PROFILE,
  DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
} from "./package-build.mjs";
import { successful } from "./final-result-pair.mjs";
import { buildPublicationCatalog } from "./publication-catalog.mjs";
import { inspectFinalResultInput } from "./final-result-input.mjs";
import { frozenDocument } from "./final-result-artifacts.mjs";
import {
  readLocalJson,
  safeFile,
  verifyLargeFile,
  commitFrozenDirectory,
} from "./final-result-files.mjs";
import { readNdjson } from "./records.mjs";
import { loadCandidate } from "../../dataset-transformation/lib/candidate.mjs";
import { verifyDerivedResultHandoff } from "../../dataset-transformation/lib/handoff.mjs";
const execFileAsync = promisify(execFile);
import {
  MAX_RECORD_BYTES as MAX_RECORD,
  MAX_METADATA_BYTES as MAX_METADATA,
  documentBudget,
  checkBudget,
  budgetDetails,
} from "./resource-budget.mjs";
const key = (e) => `${e.datasetType}:${e.uuid}@${e.version}`;
function requireValue(value, code = "final_intake_evidence_invalid") {
  if (!value)
    fail(
      code,
      "Final Result intake requires exact producer evidence and a complete Result dependency closure",
    );
}
function same(a, b) {
  requireValue(hashJson(a) === hashJson(b));
}
async function materialization(root) {
  return {
    manifest: await readLocalJson(root, "materialization-manifest.json"),
    catalog: await readLocalJson(root, "result-catalog.json"),
    index: await readLocalJson(root, "canonical-dataset-index.json"),
  };
}
async function* sourceRecords(root, intake, kind) {
  const artifacts = intake.artifacts.filter((a) => a.kind === kind);
  requireValue(artifacts.length > 0, "final_intake_source_axis_missing");
  for (const artifact of artifacts) {
    const base = path.join(root, "calculation-bundle");
    const file = await safeFile(base, artifact.path);
    await verifyLargeFile(base, {
      name: artifact.path,
      sha256: artifact.sha256,
      byteSize: (await stat(file)).size,
    });
    let count = 0;
    for await (const row of readNdjson(file)) {
      requireValue(
        Buffer.byteLength(canonicalJson(row)) <= MAX_RECORD,
        "final_intake_source_record_budget",
      );
      count++;
      requireValue(count <= artifact.recordCount);
      yield row;
    }
    requireValue(count === artifact.recordCount);
  }
}
async function directEvidence(releaseIntakeDir) {
  const intake = await loadReleaseIntake(releaseIntakeDir);
  const evidence = await materialization(intake.locators.materializationDir);
  requireValue(
    evidence.manifest.schemaVersion ===
      "tiangong.release.materialization-manifest.v1",
  );
  const source = await readLocalJson(
    intake.locators.sourceIntakeDir,
    "intake-manifest.json",
  );
  validateReleaseIntakeBindings(
    intake.manifest,
    evidence.manifest,
    evidence.index,
    source,
  );
  requireValue(
    evidence.manifest.inputs.intakeManifestSha256 === hashJson(source),
  );
  const descriptors = evidence.catalog.datasets;
  requireValue(
    Array.isArray(descriptors) &&
      descriptors.length > 0 &&
      Buffer.byteLength(canonicalJson(evidence)) <= MAX_METADATA,
    "final_intake_metadata_budget",
  );
  const wantedAxes = new Set(descriptors.map((d) => d.processIndex));
  requireValue(
    wantedAxes.size === descriptors.length &&
      [...wantedAxes].every((i) => Number.isSafeInteger(i) && i >= 0),
  );
  const axes = new Map();
  for await (const axis of sourceRecords(
    intake.locators.sourceIntakeDir,
    source,
    "process_axis",
  )) {
    requireValue(
      Number.isSafeInteger(axis.processIndex) && !axes.has(axis.processIndex),
    );
    if (wantedAxes.has(axis.processIndex))
      axes.set(axis.processIndex, axis.rootProcess);
  }
  const methods = new Map(descriptors.map((d) => [d.processIndex, []]));
  let methodBytes = 0;
  if (evidence.catalog.resultProcessLayer === "lci-lcia")
    for await (const row of sourceRecords(
      intake.locators.sourceIntakeDir,
      source,
      "lcia",
    )) {
      const selected = methods.get(row.processIndex);
      if (selected) {
        requireValue(selected.length < 4096, "final_intake_method_budget");
        const method = { uuid: row.method?.id, version: row.method?.version };
        methodBytes += Buffer.byteLength(canonicalJson(method));
        requireValue(
          methodBytes <= MAX_METADATA,
          "final_intake_metadata_budget",
        );
        selected.push(method);
      }
    }
  const results = descriptors.map((d) => {
    same(axes.get(d.processIndex), d.sourceProcess);
    return {
      uuid: d.uuid,
      version: d.version,
      layer: evidence.catalog.resultProcessLayer,
      expectedMethods: methods
        .get(d.processIndex)
        .sort((a, b) =>
          `${a.uuid}@${a.version}` < `${b.uuid}@${b.version}` ? -1 : 1,
        ),
    };
  });
  return { intake, source, evidence, results };
}
async function derivedEvidence(locators) {
  const {
    materializationDir,
    candidateDir,
    transformationDir,
    specDir,
    parentMaterializationDir,
  } = locators;
  const evidence = await materialization(materializationDir);
  requireValue(
    evidence.manifest.schemaVersion ===
      "tiangong.release.materialization-manifest.v2",
  );
  const replay = await verifyDerivedResultHandoff({
    candidateDir,
    transformationDir,
    specDir,
  });
  const transformation = {
    frozenSpec: replay.frozenSpec,
    executionReceipt: replay.receipt,
    handoff: replay.handoff,
  };
  for (const [file, value] of Object.entries({
    "transformation-frozen-spec.json": replay.frozenSpec,
    "transformation-execution-receipt.json": replay.receipt,
    "transformation-handoff.json": replay.handoff,
  }))
    same(await readLocalJson(materializationDir, file), value);
  const parent = await loadCandidate(candidateDir, {
    requiredRole: "result_process",
  });
  const parentEvidence = {
    candidate: parent.candidate,
    candidateIndex: parent.index,
  };
  if (
    parent.candidate.schemaVersion === "tiangong.release.release-candidate.v3"
  )
    parentEvidence.finalInput = await readLocalJson(
      candidateDir,
      parent.candidate.finalInput.path,
    );
  else {
    requireValue(
      parentMaterializationDir,
      "final_intake_parent_materialization_required",
    );
    parentEvidence.packagePlan = await readLocalJson(
      candidateDir,
      "package-plan.json",
    );
    parentEvidence.materialization = await materialization(
      parentMaterializationDir,
    );
  }
  evidence.parent = parentEvidence;
  evidence.transformation = transformation;
  const results = evidence.catalog.datasets.map((d) => ({
    uuid: d.uuid,
    version: d.version,
    layer: d.resultProcessLayer,
    expectedMethods: d.expectedMethods,
  }));
  return { evidence, results, parent, replay };
}
async function copyMaterialized(root, index, destination) {
  const entries = [];
  for (const entry of index.datasets.filter(
    (e) => e.role === "result_process",
  )) {
    await frozenDocument(root, entry);
    const bytes = await readFile(await safeFile(root, entry.path));
    requireValue(
      bytes.length === entry.byteSize && sha256Bytes(bytes) === entry.sha256,
    );
    const relative = entry.path.replace(/^canonical-datasets\//u, "");
    requireValue(
      /^processes\/[0-9a-f-]+_[0-9.]+\.json$/u.test(relative),
      "final_intake_path_invalid",
    );
    await mkdir(path.dirname(path.join(destination, relative)), {
      recursive: true,
    });
    await writeFile(path.join(destination, relative), bytes, { flag: "wx" });
    entries.push({ ...entry, path: relative });
  }
  return entries;
}
async function addParentDependencies(parent, destination, entries) {
  const byKey = new Map(entries.map((e) => [key(e), e]));
  let total = 0;
  for (const entry of parent.index.datasets) {
    if (byKey.has(key(entry))) {
      requireValue(
        byKey.get(key(entry)).canonicalContentHash ===
          entry.canonicalContentHash,
        "final_intake_parent_identity_conflict",
      );
      continue;
    }
    requireValue(
      /^[a-z]+\/[0-9a-f-]+(?:_[0-9.]+)?\.json$/u.test(entry.path) &&
        Number.isSafeInteger(entry.byteSize) &&
        entry.byteSize > 0,
      "final_intake_parent_member_invalid",
    );
    checkBudget("document", entry.byteSize, documentBudget(entry), entry);
    total += entry.byteSize;
    requireValue(
      total <= 32 * 1024 * 1024 * 1024,
      "final_intake_source_budget",
    );
    const { stdout: bytes } = await execFileAsync(
      "unzip",
      ["-p", parent.packagesByRole.result_process.archive, entry.path],
      { encoding: "buffer", maxBuffer: documentBudget(entry), timeout: 60000 },
    );
    requireValue(
      bytes.length === entry.byteSize &&
        sha256Bytes(bytes) === entry.sha256 &&
        hashJson(JSON.parse(bytes)) === entry.canonicalContentHash,
      "final_intake_parent_member_drift",
    );
    const dest = path.join(destination, entry.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes, { flag: "wx" });
    const support = { ...entry, role: "support" };
    byKey.set(key(support), support);
    entries.push(support);
  }
}
export async function prepareFinalResultIntake({
  releaseIntakeDir,
  materializationDir,
  candidateDir,
  transformationDir,
  specDir,
  parentMaterializationDir,
  outDir,
  tidasBin = process.env.TIDAS_BIN ?? "tidas",
  memoryBudgetMiB = DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
}) {
  const direct = Boolean(releaseIntakeDir);
  requireValue(
    direct
      ? ![
          materializationDir,
          candidateDir,
          transformationDir,
          specDir,
          parentMaterializationDir,
        ].some(Boolean)
      : Boolean(materializationDir && candidateDir && transformationDir),
    "final_intake_route_invalid",
  );
  const locators = Object.fromEntries(
    Object.entries({
      releaseIntakeDir,
      materializationDir,
      candidateDir,
      transformationDir,
      specDir,
      parentMaterializationDir,
    })
      .filter(([, v]) => v)
      .map(([k, v]) => [k, path.resolve(v)]),
  );
  const upstream = direct
    ? await directEvidence(locators.releaseIntakeDir)
    : await derivedEvidence(locators);
  const target = path.resolve(outDir);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await lstat(target);
    fail("output_exists", "Final Result intake output already exists");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const staging = await mkdtemp(`${target}.work-`);
  const canonicalRoot = path.join(staging, "canonical");
  try {
    await mkdir(canonicalRoot);
    let entries;
    if (direct)
      entries = await assembleCanonicalCollection({
        materializationRoot: upstream.intake.locators.materializationDir,
        materializedIndex: {
          ...upstream.evidence.index,
          datasets: upstream.evidence.index.datasets.filter(
            (e) => e.role === "result_process",
          ),
        },
        intakeRoot: upstream.intake.locators.sourceIntakeDir,
        intake: upstream.source,
        dependencyArtifacts: [upstream.intake.dependencyArtifact],
        canonicalRoot,
        metadataBudgetBytes: MAX_METADATA,
        recordBudgetBytes: documentBudget,
      });
    else {
      entries = await copyMaterialized(
        materializationDir,
        upstream.evidence.index,
        canonicalRoot,
      );
      await addParentDependencies(upstream.parent, canonicalRoot, entries);
    }
    // Reuse the existing publication reference catalog to select the Result
    // component. Toolkit remains the authority for standard closure qualification.
    const assembled = buildIndex(entries);
    const catalog = await buildPublicationCatalog({
      canonicalRoot,
      index: assembled,
    });
    const reachable = new Set(catalog.components.result.datasets);
    const selected = entries.filter((e) => reachable.has(key(e)));
    for (const e of entries)
      if (!reachable.has(key(e)))
        await rm(await safeFile(canonicalRoot, e.path));
    const index = buildIndex(selected);
    const indexPath = path.join(staging, "canonical-dataset-index.json");
    await writeFile(indexPath, canonicalJson(index), { flag: "wx" });
    const plan = await inspectFinalResultInput({
      canonicalRoot,
      index,
      results: upstream.results,
      materializationEvidence: upstream.evidence,
    });
    requireValue(
      Buffer.byteLength(canonicalJson({ plan, evidence: upstream.evidence })) <=
        MAX_METADATA,
      "final_intake_metadata_budget",
    );
    await verifyTidasRuntime({
      tidasBin,
      memoryBudgetMiB,
      profile: RESULT_PACKAGE_PROFILE,
    });
    const reports = {};
    for (const action of ["validate-closure", "validate-tidas"]) {
      const args = [
        "release",
        action,
        "--input-dir",
        canonicalRoot,
        ...(action === "validate-closure"
          ? ["--dataset-index", indexPath, "--profile", RESULT_PACKAGE_PROFILE]
          : []),
        "--format",
        "json",
      ];
      const result = await spawnBounded(
        tidasBin,
        args,
        tidasSpawnOptions(memoryBudgetMiB),
      );
      let report;
      try {
        report = JSON.parse(result.stdout);
      } catch {
        fail(
          "final_intake_tool_invalid",
          "Toolkit did not return a complete validation report",
        );
      }
      await writeFile(
        path.join(staging, `${action}.json`),
        canonicalJson(report),
        { flag: "wx" },
      );
      requireValue(result.code === 0, "final_intake_validation_failed");
      successful(report);
      reports[action] = { path: `${action}.json`, sha256: hashJson(report) };
    }
    for (const [name, value] of Object.entries({
      "materialization-evidence.json": upstream.evidence,
      "results.json": upstream.results,
      "input-inspection.json": plan,
    }))
      await writeFile(path.join(staging, name), canonicalJson(value), {
        flag: "wx",
      });
    await writeFile(
      path.join(staging, "runtime-locators.json"),
      canonicalJson(locators),
      { flag: "wx", mode: 0o600 },
    );
    const manifest = {
      schemaVersion: "tiangong.release.final-result-intake.v1",
      profile: RESULT_PACKAGE_PROFILE,
      inputHash: plan.inputHash,
      indexHash: hashJson(index),
      evidenceHash: hashJson(upstream.evidence),
      selectionHash: hashJson(upstream.results),
      inspectionHash: hashJson(plan),
      validation: reports,
      identityRegistered: false,
      candidateQualified: false,
      publicationAuthorized: false,
    };
    await writeFile(
      path.join(staging, "final-result-intake.json"),
      canonicalJson(manifest),
      { flag: "wx" },
    );
    await commitFrozenDirectory(staging, target, "final-result-intake.json");
    return { path: target, manifest };
  } catch (error) {
    await writeFile(
      path.join(staging, "failed-intake.json"),
      canonicalJson({
        candidateCreated: false,
        publicationAuthorized: false,
        code: error.code ?? "final_intake_failed",
        ...budgetDetails(error),
      }),
      { flag: "wx" },
    );
    error.details = {
      ...error.details,
      retainedIntake: staging,
    };
    throw error;
  }
}
export async function loadFinalResultIntake(intakeDir) {
  const root = path.resolve(intakeDir);
  const manifest = await readLocalJson(root, "final-result-intake.json");
  requireValue(
    manifest.schemaVersion === "tiangong.release.final-result-intake.v1" &&
      manifest.profile === RESULT_PACKAGE_PROFILE &&
      manifest.identityRegistered === false &&
      manifest.candidateQualified === false &&
      manifest.publicationAuthorized === false,
  );
  const locators = await readLocalJson(root, "runtime-locators.json");
  const upstream = locators.releaseIntakeDir
    ? await directEvidence(locators.releaseIntakeDir)
    : await derivedEvidence(locators);
  const evidence = await readLocalJson(root, "materialization-evidence.json");
  same(evidence, upstream.evidence);
  const results = await readLocalJson(root, "results.json");
  same(results, upstream.results);
  const index = await readLocalJson(root, "canonical-dataset-index.json");
  requireValue(
    hashJson(index) === manifest.indexHash &&
      hashJson(evidence) === manifest.evidenceHash &&
      hashJson(results) === manifest.selectionHash,
  );
  const canonicalRoot = path.join(root, "canonical");
  const plan = await inspectFinalResultInput({
    canonicalRoot,
    index,
    results,
    materializationEvidence: evidence,
  });
  requireValue(
    hashJson(plan) === manifest.inspectionHash &&
      plan.inputHash === manifest.inputHash,
  );
  same(await readLocalJson(root, "input-inspection.json"), plan);
  same(Object.keys(manifest.validation ?? {}).sort(), [
    "validate-closure",
    "validate-tidas",
  ]);
  for (const ref of Object.values(manifest.validation)) {
    const report = await readLocalJson(root, ref.path);
    requireValue(hashJson(report) === ref.sha256);
    successful(report);
  }
  return {
    root,
    manifest,
    canonicalRoot,
    index,
    results,
    materializationEvidence: evidence,
    plan,
  };
}
