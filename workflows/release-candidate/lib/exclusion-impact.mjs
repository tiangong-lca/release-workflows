import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail, hashJson, sha256Bytes } from "./common.mjs";
import { readNdjson } from "./records.mjs";
import { loadReleaseIntake } from "./release-intake.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION = /^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u;
const ISSUE_PATH =
  /^(?<category>[^/]+)\/(?<uuid>[0-9a-f-]{36})_(?<version>[0-9]{2}\.[0-9]{2}\.[0-9]{3})\.(?:json|xml)$/iu;

export async function analyzeExclusionImpact({
  failedBuildDir,
  releaseIntakeDir,
  outDir,
  issueSpoolPath,
}) {
  const failedRoot = path.resolve(failedBuildDir);
  const target = path.resolve(outDir);
  await assertTargetAbsent(target);
  const failedBuild = await readJson(
    path.join(failedRoot, "failed-package-build.json"),
    "failed_build_manifest_missing",
  );
  if (
    failedBuild.schemaVersion !== "tiangong.release.failed-package-build.v1" ||
    failedBuild.candidateCreated !== false ||
    failedBuild.publicationAuthorized !== false
  )
    fail(
      "failed_build_manifest_invalid",
      "Exclusion analysis requires one preserved, non-candidate failed build",
    );
  const failedIndex = await readJson(
    path.join(failedRoot, failedBuild.artifacts?.canonicalDatasetIndex),
    "failed_build_index_missing",
  );
  const failedPlan = await readJson(
    path.join(failedRoot, failedBuild.artifacts?.packagePlan),
    "failed_build_package_plan_missing",
  );
  const releaseIntake = await loadReleaseIntake(releaseIntakeDir);
  const materializationRoot = path.resolve(
    releaseIntake.locators.materializationDir,
  );
  const sourceIntakeRoot = path.resolve(releaseIntake.locators.sourceIntakeDir);
  const materializationManifest = await readJson(
    path.join(materializationRoot, "materialization-manifest.json"),
    "materialization_manifest_missing",
  );
  const materializedIndex = await readJson(
    path.join(materializationRoot, "canonical-dataset-index.json"),
    "canonical_index_missing",
  );
  const sourceIntake = await readJson(
    path.join(sourceIntakeRoot, "intake-manifest.json"),
    "intake_manifest_missing",
  );
  validateFailedBuildBindings({
    failedBuild,
    failedPlan,
    failedIndex,
    releaseIntake: releaseIntake.manifest,
    materializationManifest,
    materializedIndex,
    sourceIntake,
  });
  const issueSpool = await resolveIssueSpool({
    failedBuild,
    failedRoot,
    issueSpoolPath,
  });
  const issues = await readValidationIssues(issueSpool.path);
  const allInvalidDatasets = groupInvalidDatasets(issues);
  const invalidDatasets = allInvalidDatasets.filter(
    ({ datasetType }) => datasetType === "process",
  );
  const ignoredNonProcessDatasets = allInvalidDatasets.filter(
    ({ datasetType }) => datasetType !== "process",
  );
  if (!invalidDatasets.length)
    fail(
      "exclusion_subject_missing",
      "Validation evidence contains no exact Process identity that can be analyzed",
      { ignoredNonProcessDatasets },
    );
  const failedDatasetByPath = new Map(
    (failedIndex.datasets ?? []).map((dataset) => [
      safeRelative(dataset.path),
      dataset,
    ]),
  );
  const invalidOutsideFailedBuild = invalidDatasets.filter((invalid) => {
    const indexed = failedDatasetByPath.get(safeRelative(invalid.path));
    return !indexed || identityKey(indexed) !== identityKey(invalid);
  });
  if (invalidOutsideFailedBuild.length > 0)
    fail(
      "validation_issue_dataset_mismatch",
      "Validation issues name datasets that are not exact members of the preserved failed build",
      { invalidDatasets: invalidOutsideFailedBuild },
    );

  const calculationGraph = await loadCalculationGraph({
    sourceIntakeRoot,
    sourceIntake,
  });
  const initialProcessIndices = new Set();
  for (const invalid of invalidDatasets) {
    const index = calculationGraph.indexByIdentity.get(identityKey(invalid));
    if (index !== undefined) initialProcessIndices.add(index);
  }
  for (const dataset of materializationManifest.datasets ?? []) {
    if (
      dataset.processIndex !== undefined &&
      invalidDatasets.some(
        (invalid) =>
          identityKey(invalid) === identityKey(dataset.sourceProcess),
      )
    )
      initialProcessIndices.add(dataset.processIndex);
  }
  if (!initialProcessIndices.size)
    fail(
      "exclusion_process_axis_missing",
      "Invalid Process identities cannot be located in frozen calculation/materialization evidence",
    );

  const affectedProcessIndices = reverseProcessClosure(
    initialProcessIndices,
    calculationGraph.edges,
  );
  const affectedProcessRoots = [...affectedProcessIndices]
    .map((index) => calculationGraph.processByIndex.get(index))
    .filter(Boolean)
    .map(({ id, version, processIndex }) => ({ id, version, processIndex }))
    .sort(compareIdentity);
  const affectedMaterializedDatasets = (materializationManifest.datasets ?? [])
    .filter(
      (dataset) =>
        affectedProcessIndices.has(dataset.processIndex) ||
        invalidDatasets.some(
          (invalid) =>
            identityKey(invalid) === identityKey(dataset.sourceProcess),
        ),
    )
    .map(projectDataset)
    .sort(comparePath);

  const canonicalGraph = await loadCanonicalGraph({
    materializationRoot,
    materializedIndex,
    sourceIntakeRoot,
    sourceIntake,
    dependencyArtifact: releaseIntake.dependencyArtifact,
  });
  const initiallyExcludedPaths = new Set([
    ...invalidDatasets
      .map((invalid) => canonicalGraph.pathByIdentity.get(identityKey(invalid)))
      .filter(Boolean),
    ...affectedMaterializedDatasets.map(({ path: itemPath }) => itemPath),
  ]);
  const rootKeysBefore = canonicalRoots(canonicalGraph.records, new Set());
  const reachableBefore = reachableKeys({
    records: canonicalGraph.records,
    keysByUuid: canonicalGraph.keysByUuid,
    rootKeys: rootKeysBefore,
    excludedPaths: new Set(),
  });
  const rootKeysAfter = canonicalRoots(
    canonicalGraph.records,
    initiallyExcludedPaths,
  );
  const reachableAfterInitial = reachableKeys({
    records: canonicalGraph.records,
    keysByUuid: canonicalGraph.keysByUuid,
    rootKeys: rootKeysAfter,
    excludedPaths: initiallyExcludedPaths,
  });
  const newlyUnreachableSupportDatasets = [...reachableBefore]
    .filter((key) => !reachableAfterInitial.has(key))
    .map((key) => canonicalGraph.records.get(key))
    .filter(
      (record) =>
        record &&
        record.role === "support" &&
        !initiallyExcludedPaths.has(record.path),
    )
    .map(projectDataset)
    .sort(comparePath);
  const excludedPaths = new Set([
    ...initiallyExcludedPaths,
    ...newlyUnreachableSupportDatasets.map(({ path: itemPath }) => itemPath),
  ]);
  const remainingReferenceConflicts = referenceConflicts({
    records: canonicalGraph.records,
    keysByUuid: canonicalGraph.keysByUuid,
    reachable: reachableKeys({
      records: canonicalGraph.records,
      keysByUuid: canonicalGraph.keysByUuid,
      rootKeys: canonicalRoots(canonicalGraph.records, excludedPaths),
      excludedPaths,
    }),
    excludedPaths,
  });
  const excludedCanonicalDatasets = [...excludedPaths]
    .map((itemPath) => canonicalGraph.recordsByPath.get(itemPath))
    .filter(Boolean)
    .map(projectDataset)
    .sort(comparePath);
  const failedCanonicalPaths = new Set(failedDatasetByPath.keys());
  const absentFromFailedBuild = excludedCanonicalDatasets
    .map(({ path: itemPath }) => itemPath)
    .filter((itemPath) => !failedCanonicalPaths.has(itemPath));
  if (absentFromFailedBuild.length > 0)
    fail(
      "excluded_dataset_not_in_failed_build",
      "The computed exclusion set contains datasets outside the preserved failed build",
      { paths: absentFromFailedBuild },
    );
  const excludedSetHash = hashJson(
    excludedCanonicalDatasets.map(
      ({ datasetType, uuid, version, path: itemPath }) => ({
        datasetType,
        uuid,
        version,
        path: itemPath,
      }),
    ),
  );
  const selectedRootKeys = new Set(
    (materializationManifest.datasets ?? [])
      .filter((dataset) => dataset.materializationRole === "primary")
      .map(identityKey),
  );
  const invalidWithClassification = invalidDatasets.map((invalid) => {
    const processIndex = calculationGraph.indexByIdentity.get(
      identityKey(invalid),
    );
    const inboundEdgeCount = calculationGraph.edges.filter(
      (edge) => edge.balancingProcessIndex === processIndex,
    ).length;
    const outboundEdgeCount = calculationGraph.edges.filter(
      (edge) => edge.dependentProcessIndex === processIndex,
    ).length;
    const derivedPrimary = (materializationManifest.datasets ?? []).some(
      (dataset) =>
        selectedRootKeys.has(identityKey(dataset)) &&
        identityKey(dataset.sourceProcess) === identityKey(invalid),
    );
    return {
      ...invalid,
      processIndex: processIndex ?? null,
      classification: derivedPrimary
        ? "invalid_selected_root"
        : inboundEdgeCount > 0
          ? "invalid_dependency"
          : "invalid_unselected_dataset",
      orphan: !derivedPrimary && inboundEdgeCount === 0,
      inboundCalculationEdgeCount: inboundEdgeCount,
      outboundCalculationEdgeCount: outboundEdgeCount,
    };
  });
  const safeToExclude =
    affectedProcessRoots.length > 0 && remainingReferenceConflicts.length === 0;
  const report = {
    schemaVersion: "tiangong.release.exclusion-impact-report.v1",
    status: safeToExclude ? "complete" : "blocked",
    publicationAuthorized: false,
    source: {
      failedBuildManifestSha256: hashJson(failedBuild),
      packagePlanSha256: failedBuild.packagePlanSha256,
      failedCanonicalDatasetIndexSha256: hashJson(failedIndex),
      releaseIntakeManifestSha256: hashJson(releaseIntake.manifest),
      materializationManifestSha256: hashJson(materializationManifest),
      materializedDatasetIndexSha256: hashJson(materializedIndex),
      sourceIntakeManifestSha256: hashJson(sourceIntake),
      issueSpool: {
        sha256: issueSpool.sha256,
        byteSize: issueSpool.byteSize,
        eventCount: issues.length,
      },
    },
    validationIssues: {
      errorCount: issues.filter(({ severity }) => severity === "error").length,
      issueCodes: [...new Set(issues.map(({ issueCode }) => issueCode))].sort(),
      invalidDatasets: invalidWithClassification,
      ignoredNonProcessDatasets,
    },
    impact: {
      processGraphAvailable: calculationGraph.edges.length > 0,
      affectedProcessRoots,
      affectedMaterializedDatasets,
      newlyUnreachableSupportDatasets,
      excludedCanonicalDatasets,
      excludedSetHash,
      originalDatasetCount: failedIndex.datasetCount,
      resultingDatasetCount:
        failedIndex.datasetCount - excludedCanonicalDatasets.length,
      remainingReferenceConflicts,
      safeToExclude,
    },
    options: [
      {
        action: "repair",
        recommended: true,
        allowed: true,
        description:
          "Repair or reselect exact upstream versions and rebuild frozen evidence.",
      },
      {
        action: "exclude",
        recommended: false,
        allowed: safeToExclude,
        description:
          "Exclude the complete computed impact set and rebuild a new fully validated candidate.",
      },
      {
        action: "stop",
        recommended: false,
        allowed: true,
        description: "Keep the failed build and stop this release attempt.",
      },
    ],
  };
  await mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp-${process.pid}`;
  await mkdir(staging);
  try {
    await writeFile(
      path.join(staging, "exclusion-impact-report.json"),
      canonicalJson(report),
      { flag: "wx" },
    );
    await writeFile(
      path.join(staging, "runtime-locators.json"),
      canonicalJson({
        failedBuildDir: failedRoot,
        releaseIntakeDir: releaseIntake.root,
      }),
      { flag: "wx", mode: 0o600 },
    );
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { path: target, report, reportSha256: hashJson(report) };
}

function validateFailedBuildBindings({
  failedBuild,
  failedPlan,
  failedIndex,
  releaseIntake,
  materializationManifest,
  materializedIndex,
  sourceIntake,
}) {
  if (
    failedBuild.packagePlanSha256 !== hashJson(failedPlan) ||
    failedPlan.profile !== failedBuild.profile ||
    failedPlan.releaseVersion !== failedBuild.releaseVersion ||
    failedPlan.intake?.releaseIntakeManifestSha256 !==
      hashJson(releaseIntake) ||
    failedPlan.intake?.manifestSha256 !== hashJson(sourceIntake) ||
    failedPlan.materialization?.manifestSha256 !==
      hashJson(materializationManifest) ||
    failedPlan.materialization?.canonicalDatasetIndexSha256 !==
      hashJson(materializedIndex) ||
    failedPlan.canonicalInput?.datasetCount !== failedIndex.datasetCount ||
    failedPlan.canonicalInput?.byteSize !== failedIndex.byteSize ||
    failedPlan.canonicalInput?.artifactSetHash !== failedIndex.artifactSetHash
  )
    fail(
      "failed_build_binding_mismatch",
      "Preserved failed build, Package Plan, index, and frozen Release inputs do not describe the same attempt",
    );
}

export async function recordScopeDecision({
  impactReportPath,
  outDir,
  action,
  reason,
  decidedBy,
  confirmImpactSha256,
}) {
  if (!["repair", "exclude", "stop"].includes(action))
    fail(
      "scope_decision_action_invalid",
      "Action must be repair, exclude, or stop",
    );
  const durableReason = String(reason ?? "").trim();
  const decisionMaker = String(decidedBy ?? "").trim();
  if (!durableReason || !decisionMaker)
    fail(
      "scope_decision_evidence_missing",
      "Scope decisions require non-empty reason and decided-by evidence",
    );
  const reportFile = path.resolve(impactReportPath);
  const report = await readJson(reportFile, "exclusion_impact_report_missing");
  if (report.schemaVersion !== "tiangong.release.exclusion-impact-report.v1")
    fail(
      "exclusion_impact_report_invalid",
      "Expected tiangong.release.exclusion-impact-report.v1",
    );
  const reportSha256 = hashJson(report);
  if (action === "exclude") {
    if (report.impact?.safeToExclude !== true)
      fail(
        "exclusion_not_safe",
        "The impact report does not permit exclusion; repair or stop instead",
      );
    if (confirmImpactSha256 !== reportSha256)
      fail(
        "impact_confirmation_mismatch",
        "Exclusion confirmation must match the exact impact report SHA-256",
        { expected: reportSha256 },
      );
  }
  const target = path.resolve(outDir);
  await assertTargetAbsent(target);
  const decision = {
    schemaVersion: "tiangong.release.scope-decision.v1",
    action,
    publicationAuthorized: false,
    decidedAt: new Date().toISOString(),
    decidedBy: decisionMaker,
    reason: durableReason,
    impactReportSha256: reportSha256,
    source: report.source,
    exclusion:
      action === "exclude"
        ? {
            excludedSetHash: report.impact.excludedSetHash,
            excludedCanonicalDatasets: report.impact.excludedCanonicalDatasets,
            affectedProcessRoots: report.impact.affectedProcessRoots,
            resultingDatasetCount: report.impact.resultingDatasetCount,
          }
        : null,
  };
  await mkdir(target, { recursive: false });
  try {
    await copyFile(
      reportFile,
      path.join(target, "exclusion-impact-report.json"),
    );
    const locatorSource = path.join(
      path.dirname(reportFile),
      "runtime-locators.json",
    );
    const locators = await readJson(
      locatorSource,
      "exclusion_impact_locators_missing",
    );
    await writeFile(
      path.join(target, "runtime-locators.json"),
      canonicalJson(locators),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      path.join(target, "release-scope-decision.json"),
      canonicalJson(decision),
      { flag: "wx" },
    );
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  const locators = await readJson(
    path.join(target, "runtime-locators.json"),
    "exclusion_impact_locators_missing",
  );
  return {
    path: target,
    decision,
    decisionSha256: hashJson(decision),
    locators,
  };
}

export async function loadScopeDecision(decisionDir) {
  const root = path.resolve(decisionDir);
  const report = await readJson(
    path.join(root, "exclusion-impact-report.json"),
    "exclusion_impact_report_missing",
  );
  const decision = await readJson(
    path.join(root, "release-scope-decision.json"),
    "scope_decision_missing",
  );
  const locators = await readJson(
    path.join(root, "runtime-locators.json"),
    "scope_decision_locators_missing",
  );
  if (
    report.schemaVersion !== "tiangong.release.exclusion-impact-report.v1" ||
    decision.schemaVersion !== "tiangong.release.scope-decision.v1" ||
    decision.action !== "exclude" ||
    decision.publicationAuthorized !== false ||
    !String(decision.decidedAt ?? "").trim() ||
    !String(decision.decidedBy ?? "").trim() ||
    !String(decision.reason ?? "").trim() ||
    decision.impactReportSha256 !== hashJson(report) ||
    decision.exclusion?.excludedSetHash !== report.impact?.excludedSetHash ||
    report.impact?.safeToExclude !== true
  )
    fail(
      "scope_decision_invalid",
      "Scope decision is not a verified exclusion bound to its exact impact report",
    );
  return {
    root,
    report,
    decision,
    decisionSha256: hashJson(decision),
    locators,
    excludedPaths: new Set(
      decision.exclusion.excludedCanonicalDatasets.map(({ path: itemPath }) =>
        safeRelative(itemPath),
      ),
    ),
  };
}

async function resolveIssueSpool({ failedBuild, failedRoot, issueSpoolPath }) {
  const declared =
    failedBuild.failure?.diagnostics?.operationReport?.artifacts?.find(
      (artifact) => artifact.media_type === "application/x-ndjson",
    );
  const file = issueSpoolPath
    ? path.resolve(issueSpoolPath)
    : declared?.path
      ? path.resolve(declared.path)
      : null;
  if (!file)
    fail(
      "validation_issue_spool_missing",
      "No validation issue spool is referenced; pass --issue-spool explicitly",
    );
  const bytes = await readFile(file);
  if (declared?.sha256 && sha256Bytes(bytes) !== declared.sha256)
    fail(
      "validation_issue_spool_hash_mismatch",
      "Validation issue spool no longer matches failed-build evidence",
    );
  return {
    path: file,
    sha256: sha256Bytes(bytes),
    byteSize: bytes.length,
    failedRoot,
  };
}

async function readValidationIssues(file) {
  const issues = [];
  for await (const event of readNdjson(file)) {
    const issue = event.issue ?? event;
    if (!issue.file_path || !issue.issue_code) continue;
    issues.push({
      issueCode: issue.issue_code,
      severity: issue.severity ?? "error",
      filePath: normalizeIssueFilePath(issue.file_path),
      location: issue.location ?? null,
      message: issue.message ?? "",
    });
  }
  return issues;
}

function groupInvalidDatasets(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const match = ISSUE_PATH.exec(issue.filePath);
    if (!match) continue;
    const dataset = {
      datasetType: datasetTypeForCategory(match.groups.category),
      uuid: match.groups.uuid.toLowerCase(),
      version: match.groups.version,
      path: issue.filePath,
    };
    const key = identityKey(dataset);
    const group = groups.get(key) ?? {
      ...dataset,
      issueCount: 0,
      issueCodes: [],
    };
    group.issueCount += 1;
    group.issueCodes.push(issue.issueCode);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((item) => ({
      ...item,
      issueCodes: [...new Set(item.issueCodes)].sort(),
    }))
    .sort(comparePath);
}

async function loadCalculationGraph({ sourceIntakeRoot, sourceIntake }) {
  const bundleRoot = path.join(sourceIntakeRoot, "calculation-bundle");
  const processByIndex = new Map();
  const indexByIdentity = new Map();
  for (const artifact of sourceIntake.artifacts ?? []) {
    if (artifact.kind !== "process_axis") continue;
    for await (const record of readNdjson(
      resolveContained(bundleRoot, artifact.path),
    )) {
      const process = {
        processIndex: record.processIndex,
        id: String(record.rootProcess?.id ?? "").toLowerCase(),
        version: record.rootProcess?.version,
      };
      if (!UUID.test(process.id) || !VERSION.test(process.version)) continue;
      processByIndex.set(process.processIndex, process);
      indexByIdentity.set(identityKey(process), process.processIndex);
    }
  }
  const edges = [];
  for (const artifact of sourceIntake.artifacts ?? []) {
    if (artifact.kind !== "technosphere_edges") continue;
    for await (const edge of readNdjson(
      resolveContained(bundleRoot, artifact.path),
    ))
      edges.push({
        dependentProcessIndex: edge.dependentProcessIndex,
        balancingProcessIndex: edge.balancingProcessIndex,
      });
  }
  return { processByIndex, indexByIdentity, edges };
}

function reverseProcessClosure(initial, edges) {
  const affected = new Set(initial);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (
        affected.has(edge.balancingProcessIndex) &&
        !affected.has(edge.dependentProcessIndex)
      ) {
        affected.add(edge.dependentProcessIndex);
        changed = true;
      }
    }
  }
  return affected;
}

async function loadCanonicalGraph({
  materializationRoot,
  materializedIndex,
  sourceIntakeRoot,
  sourceIntake,
  dependencyArtifact,
}) {
  const records = new Map();
  const recordsByPath = new Map();
  const keysByUuid = new Map();
  const add = (dataset, document) => {
    const projected = {
      datasetType: dataset.datasetType,
      role: dataset.role ?? "support",
      materializationRole: dataset.materializationRole,
      uuid: String(dataset.uuid).toLowerCase(),
      version: dataset.version,
      path: safeRelative(stripCanonicalPrefix(dataset.path)),
      references: collectReferences(document),
    };
    const key = identityKey(projected);
    if (records.has(key)) return;
    records.set(key, projected);
    recordsByPath.set(projected.path, projected);
    const uuidKeys = keysByUuid.get(projected.uuid) ?? [];
    uuidKeys.push(key);
    keysByUuid.set(projected.uuid, uuidKeys);
  };
  for (const dataset of materializedIndex.datasets ?? []) {
    const file = resolveContained(materializationRoot, dataset.path);
    add(dataset, JSON.parse(await readFile(file, "utf8")));
  }
  const bundleRoot = path.join(sourceIntakeRoot, "calculation-bundle");
  for (const artifact of sourceIntake.artifacts ?? []) {
    if (artifact.kind !== "source_closure") continue;
    for await (const record of readNdjson(
      resolveContained(bundleRoot, artifact.path),
    ))
      add(record, record.document);
  }
  for await (const record of readNdjson(dependencyArtifact))
    add(record, record.document);
  return {
    records,
    recordsByPath,
    pathByIdentity: new Map(
      [...records].map(([key, value]) => [key, value.path]),
    ),
    keysByUuid,
  };
}

function canonicalRoots(records, excludedPaths) {
  return new Set(
    [...records]
      .filter(
        ([, record]) =>
          !excludedPaths.has(record.path) &&
          ((record.datasetType === "process" &&
            record.role === "unit_process") ||
            record.materializationRole === "primary" ||
            record.role === "lifecycle_model"),
      )
      .map(([key]) => key),
  );
}

function reachableKeys({ records, keysByUuid, rootKeys, excludedPaths }) {
  const reachable = new Set();
  const queue = [...rootKeys];
  while (queue.length) {
    const key = queue.pop();
    if (reachable.has(key)) continue;
    const record = records.get(key);
    if (!record || excludedPaths.has(record.path)) continue;
    reachable.add(key);
    for (const reference of record.references) {
      if (!reference.closureRequired) continue;
      for (const target of resolveReference(reference, records, keysByUuid))
        if (!reachable.has(target)) queue.push(target);
    }
  }
  return reachable;
}

function referenceConflicts({ records, keysByUuid, reachable, excludedPaths }) {
  const conflicts = [];
  for (const key of reachable) {
    const record = records.get(key);
    for (const reference of record.references) {
      if (!reference.closureRequired) continue;
      const targets = resolveReference(reference, records, keysByUuid);
      if (
        targets.length > 0 &&
        targets.every((target) => excludedPaths.has(records.get(target)?.path))
      )
        conflicts.push({ from: record.path, reference });
    }
  }
  return conflicts.sort((left, right) => left.from.localeCompare(right.from));
}

function collectReferences(document) {
  const result = [];
  const visit = (value, location, parentKey) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && typeof value["@refObjectId"] === "string") {
      const uuid = value["@refObjectId"].toLowerCase();
      const version = value["@version"];
      const role = referenceRole(parentKey);
      if (UUID.test(uuid) && (version === undefined || VERSION.test(version)))
        result.push({
          uuid,
          version: version ?? null,
          location,
          role,
          closureRequired: role !== "lineage",
        });
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
  return result;
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

function resolveReference(reference, records, keysByUuid) {
  if (reference.version) {
    const suffix = `:${reference.uuid}@${reference.version}`;
    return (keysByUuid.get(reference.uuid) ?? []).filter((key) =>
      key.endsWith(suffix),
    );
  }
  return keysByUuid.get(reference.uuid) ?? [];
}

function identityKey(value) {
  return `${value?.datasetType ?? "process"}:${String(value?.uuid ?? value?.id ?? "").toLowerCase()}@${value?.version ?? ""}`;
}

function projectDataset(dataset) {
  return {
    datasetType: dataset.datasetType,
    role: dataset.role,
    materializationRole: dataset.materializationRole,
    uuid: String(dataset.uuid).toLowerCase(),
    version: dataset.version,
    path: safeRelative(stripCanonicalPrefix(dataset.path)),
    processIndex: dataset.processIndex,
    sourceProcess: dataset.sourceProcess,
  };
}

function datasetTypeForCategory(category) {
  const singular = {
    processes: "process",
    lifecyclemodels: "lifecyclemodel",
    flows: "flow",
    flowproperties: "flowproperty",
    unitgroups: "unitgroup",
    lciamethods: "lciamethod",
    contacts: "contact",
    sources: "source",
  }[category.toLowerCase()];
  return singular ?? category.replace(/s$/u, "");
}

function stripCanonicalPrefix(value) {
  return String(value).replace(/^canonical-datasets\//u, "");
}

function normalizeIssueFilePath(value) {
  let normalized = safeRelative(String(value).replaceAll("\\", "/"));
  if (normalized.startsWith("data/")) normalized = normalized.slice(5);
  return normalized.replace(/\.xml$/iu, ".json");
}

function safeRelative(value) {
  const normalized = path.posix.normalize(String(value).replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  )
    fail("unsafe_relative_path", `Unsafe artifact path: ${value}`);
  return normalized;
}

function resolveContained(root, relativePath) {
  const target = path.resolve(root, safeRelative(relativePath));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix))
    fail("unsafe_relative_path", `Path escapes artifact root: ${relativePath}`);
  return target;
}

function compareIdentity(left, right) {
  return `${left.id}@${left.version}`.localeCompare(
    `${right.id}@${right.version}`,
  );
}

function comparePath(left, right) {
  return left.path.localeCompare(right.path);
}

async function readJson(file, code) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      fail(code, `Required file does not exist: ${file}`);
    throw error;
  }
}

async function assertTargetAbsent(target) {
  try {
    await stat(target);
    fail("output_exists", `Refusing to overwrite existing output: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
