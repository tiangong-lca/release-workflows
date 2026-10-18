import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail, hashJson, sha256Bytes } from "./common.mjs";
import { loadScopeDecision } from "./exclusion-impact.mjs";
import { readNdjson } from "./records.mjs";
import {
  buildPublicationCatalog,
  writePublicationCatalogFile,
} from "./publication-catalog.mjs";
import { loadReleaseIntake } from "./release-intake.mjs";

export const PACKAGE_PROFILE =
  "standalone-lifecyclemodel-result-full-closure.v1";
export const DEFAULT_TIDAS_MEMORY_BUDGET_MIB = 2048;

const DISTRIBUTION_PACKAGES = [
  ["unit-process-full-closure.v1.tidas.zip", "UnitProcessDatabase", "tidas"],
  ["unit-process-full-closure.v1.ilcd.zip", "UnitProcessDatabase", "ilcd"],
  [
    "standalone-lifecyclemodel-result-full-closure.v1.tidas.zip",
    "ResultDatabase",
    "tidas",
  ],
  [
    "standalone-lifecyclemodel-result-full-closure.v1.ilcd.zip",
    "ResultDatabase",
    "ilcd",
  ],
];

export async function buildPackageCandidate({
  releaseIntakeDir,
  outDir,
  releaseVersion,
  scopeDecisionDir,
  tidasBin = process.env.TIDAS_BIN ?? "tidas",
  tidasMemoryBudgetMiB = process.env.TIDAS_MEMORY_BUDGET_MIB ??
    DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
  runTool = runTidas,
  verifyTool = verifyBuiltPackages,
}) {
  validateReleaseVersion(releaseVersion);
  const memoryBudgetMiB = validateTidasMemoryBudgetMiB(tidasMemoryBudgetMiB);
  const releaseIntake = await loadReleaseIntake(releaseIntakeDir);
  const scopeDecision = scopeDecisionDir
    ? await loadScopeDecision(scopeDecisionDir)
    : null;
  const materializationRoot = path.resolve(
    releaseIntake.locators.materializationDir,
  );
  const intakeRoot = path.resolve(releaseIntake.locators.sourceIntakeDir);
  const target = path.resolve(outDir);
  await mkdir(path.dirname(target), { recursive: true });
  await assertTargetAbsent(target);
  const workspace = await mkdtemp(`${target}.work-`);
  const candidateStaging = await mkdtemp(`${target}.tmp-`);
  const failedBuildTarget = failedBuildPath(target, candidateStaging);
  let packageBuildStarted = false;
  let qualificationStarted = false;
  let cleanupCandidateStaging = true;
  let plan;
  try {
    const manifest = await readJson(
      path.join(materializationRoot, "materialization-manifest.json"),
      "materialization_manifest_missing",
    );
    const materializedIndex = await readJson(
      path.join(materializationRoot, "canonical-dataset-index.json"),
      "canonical_index_missing",
    );
    const intake = await readJson(
      path.join(intakeRoot, "intake-manifest.json"),
      "intake_manifest_missing",
    );
    validateInputs(manifest, materializedIndex, intake);
    validateReleaseIntakeBindings(
      releaseIntake.manifest,
      manifest,
      materializedIndex,
      intake,
    );
    if (scopeDecision)
      validateScopeDecisionBindings({
        scopeDecision,
        releaseIntake: releaseIntake.manifest,
        materializationManifest: manifest,
        materializedIndex,
        sourceIntake: intake,
      });
    const canonicalRoot = path.join(workspace, "canonical");
    await mkdir(canonicalRoot, { recursive: true });
    const entries = await assembleCanonicalCollection({
      materializationRoot,
      materializedIndex,
      intakeRoot,
      intake,
      dependencyArtifacts: [releaseIntake.dependencyArtifact],
      canonicalRoot,
      excludedPaths: scopeDecision?.excludedPaths,
    });
    const assembledIndex = buildIndex(entries);
    if (
      scopeDecision &&
      assembledIndex.datasetCount !==
        scopeDecision.decision.exclusion.resultingDatasetCount
    )
      fail(
        "scope_decision_result_count_mismatch",
        "Scope decision resulting dataset count does not match assembled input",
        {
          expected: scopeDecision.decision.exclusion.resultingDatasetCount,
          observed: assembledIndex.datasetCount,
        },
      );
    const indexPath = path.join(workspace, "canonical-dataset-index.json");
    await writeFile(indexPath, canonicalJson(assembledIndex), { flag: "wx" });
    plan = {
      schemaVersion: "tiangong.release.package-plan.v1",
      releaseVersion,
      profile: PACKAGE_PROFILE,
      materialization: {
        manifestSha256: hashJson(manifest),
        canonicalDatasetIndexSha256: hashJson(materializedIndex),
      },
      intake: {
        releaseIntakeManifestSha256: hashJson(releaseIntake.manifest),
        manifestSha256: hashJson(intake),
        calculationId: intake.source.calculationId,
        bundleContentHash: intake.source.bundleContentHash,
      },
      canonicalInput: {
        datasetCount: assembledIndex.datasetCount,
        byteSize: assembledIndex.byteSize,
        artifactSetHash: assembledIndex.artifactSetHash,
      },
      packager: { adapter: "tidas-tools.release-build-packages.v1" },
      scopeDecision: scopeDecision
        ? {
            decisionSha256: scopeDecision.decisionSha256,
            impactReportSha256: scopeDecision.decision.impactReportSha256,
            excludedSetHash: scopeDecision.decision.exclusion.excludedSetHash,
          }
        : null,
    };
    await writeFile(
      path.join(candidateStaging, "package-plan.json"),
      canonicalJson(plan),
      { flag: "wx" },
    );
    await copyFile(
      indexPath,
      path.join(candidateStaging, "canonical-dataset-index.json"),
    );
    const publicationCatalog = await buildPublicationCatalog({
      canonicalRoot,
      index: assembledIndex,
    });
    const publicationCatalogSha256 = await writePublicationCatalogFile(
      publicationCatalog,
      path.join(candidateStaging, "publication-catalog.json"),
    );
    const packagesDir = path.join(candidateStaging, "packages");
    const verificationWorkspace = path.join(
      candidateStaging,
      "validation-readback",
    );
    const verificationReportPath = path.join(
      candidateStaging,
      "package-verification-report.json",
    );
    packageBuildStarted = true;
    const toolResult = await runTool({
      tidasBin,
      memoryBudgetMiB,
      canonicalRoot,
      indexPath,
      packagesDir,
      issueSpoolPath: path.join(
        candidateStaging,
        "tidas-validation-issues.ndjson",
      ),
    });
    await applyDistributionNames(packagesDir, releaseVersion);
    await writeFile(
      path.join(candidateStaging, "tidas-release-report.json"),
      canonicalJson(toolResult),
      { flag: "wx" },
    );
    qualificationStarted = true;
    const packageVerification = await verifyTool({
      tidasBin,
      memoryBudgetMiB,
      packagesDir,
      workspace: verificationWorkspace,
      releaseVersion,
      reportPath: verificationReportPath,
    });
    await writeFile(
      verificationReportPath,
      canonicalJson(packageVerification),
      { flag: "wx" },
    );
    await rm(verificationWorkspace, { recursive: true, force: true });
    const packages = await packageArtifacts(packagesDir);
    if (
      packages.length !== 4 ||
      packages.some((item) => !item.path.endsWith(".zip"))
    )
      fail(
        "package_artifacts_invalid",
        `Expected exactly four ZIP packages, received ${packages.length}`,
      );
    const candidate = {
      schemaVersion: "tiangong.release.release-candidate.v2",
      status: "local_candidate",
      publicationAuthorized: false,
      releaseVersion,
      profile: PACKAGE_PROFILE,
      packagePlanSha256: hashJson(plan),
      canonicalDatasetIndexSha256: hashJson(assembledIndex),
      publicationCatalog: {
        path: "publication-catalog.json",
        sha256: publicationCatalogSha256,
      },
      packages,
      packageSetHash: hashJson(
        packages.map(({ path: itemPath, sha256, byteSize }) => ({
          path: itemPath,
          sha256,
          byteSize,
        })),
      ),
      validation: {
        delegatedTo: "tidas-tools",
        outcome: "passed",
        reportPath: "tidas-release-report.json",
        archiveReadbackReportPath: "package-verification-report.json",
      },
      scopeDecisionSha256: scopeDecision?.decisionSha256 ?? null,
    };
    await writeFile(
      path.join(candidateStaging, "release-candidate.json"),
      canonicalJson(candidate),
      { flag: "wx" },
    );
    await rename(candidateStaging, target);
    return { path: target, plan, candidate };
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      fail("output_exists", `Refusing to overwrite existing output: ${target}`);
    if (packageBuildStarted && error.code !== "tidas_executable_missing") {
      cleanupCandidateStaging = false;
      const retained = await retainFailedBuild({
        candidateStaging,
        failedBuildTarget,
        target,
        releaseVersion,
        plan,
        qualificationStarted,
        error,
      });
      error.details = {
        ...(error.details ?? {}),
        releaseIntakeDir: path.resolve(releaseIntakeDir),
        requestedCandidatePath: target,
        releaseVersion,
        scopeDecisionDir: scopeDecisionDir
          ? path.resolve(scopeDecisionDir)
          : undefined,
        tidasBin,
        memoryBudgetMiB,
        retainedBuild: retained,
      };
    }
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    if (cleanupCandidateStaging)
      await rm(candidateStaging, { recursive: true, force: true });
  }
}

function failedBuildPath(target, candidateStaging) {
  const stagingPrefix = `${target}.tmp-`;
  const suffix = candidateStaging.startsWith(stagingPrefix)
    ? candidateStaging.slice(stagingPrefix.length)
    : path.basename(candidateStaging);
  return `${target}.failed-${suffix}`;
}

function rewriteArtifactPaths(operationReport, fromRoot, toRoot) {
  const artifacts = operationReport?.artifacts;
  if (!Array.isArray(artifacts)) return;
  for (const artifact of artifacts) {
    if (typeof artifact.path !== "string") continue;
    const relative = path.relative(fromRoot, artifact.path);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      continue;
    artifact.path = path.join(toRoot, relative);
  }
}

async function retainFailedBuild({
  candidateStaging,
  failedBuildTarget,
  target,
  releaseVersion,
  plan,
  qualificationStarted,
  error,
}) {
  const packagesDir = path.join(candidateStaging, "packages");
  const packages = await packageArtifactsIfPresent(packagesDir);
  const failure = {
    code: error.code ?? "unexpected_error",
    message: error.message,
    stage: error.details?.stage ?? "package_build_or_validation",
    format: error.details?.format,
    product: error.details?.product,
    fileName: error.details?.fileName,
    diagnostics: {
      stderr: error.details?.stderr,
      operationReport: error.details?.operationReport,
      stdoutTail: error.details?.stdoutTail,
    },
  };
  const artifacts = {
    packagePlan: "package-plan.json",
    canonicalDatasetIndex: "canonical-dataset-index.json",
    packagesDirectory: "packages",
  };
  rewriteArtifactPaths(
    failure.diagnostics.operationReport,
    candidateStaging,
    failedBuildTarget,
  );
  if (
    await pathExists(
      path.join(candidateStaging, "tidas-validation-issues.ndjson"),
    )
  )
    artifacts.validationIssues = "tidas-validation-issues.ndjson";
  if (
    await pathExists(path.join(candidateStaging, "tidas-release-report.json"))
  )
    artifacts.tidasReport = "tidas-release-report.json";
  if (
    await pathExists(
      path.join(candidateStaging, "package-verification-report.json"),
    )
  )
    artifacts.packageVerification = "package-verification-report.json";
  if (await pathExists(path.join(candidateStaging, "validation-readback")))
    artifacts.validationReadbackDirectory = "validation-readback";
  const manifest = {
    schemaVersion: "tiangong.release.failed-package-build.v1",
    status: qualificationStarted
      ? "qualification_failed"
      : "package_build_failed",
    publicationAuthorized: false,
    candidateCreated: false,
    releaseVersion,
    profile: PACKAGE_PROFILE,
    requestedCandidatePath: target,
    packagePlanSha256: plan ? hashJson(plan) : undefined,
    packages,
    failure,
    artifacts,
  };
  try {
    await writeFile(
      path.join(candidateStaging, "failed-package-build.json"),
      canonicalJson(manifest),
      { flag: "wx" },
    );
    await rename(candidateStaging, failedBuildTarget);
    return {
      path: failedBuildTarget,
      manifest: path.join(failedBuildTarget, "failed-package-build.json"),
      packagesDirectory: path.join(failedBuildTarget, "packages"),
      validationReadbackDirectory: artifacts.validationReadbackDirectory
        ? path.join(failedBuildTarget, artifacts.validationReadbackDirectory)
        : undefined,
      packageCount: packages.length,
      status: manifest.status,
      publicationAuthorized: false,
    };
  } catch (preservationError) {
    const stagingManifest = path.join(
      candidateStaging,
      "failed-package-build.json",
    );
    return {
      path: candidateStaging,
      manifest: (await pathExists(stagingManifest))
        ? stagingManifest
        : undefined,
      packagesDirectory: path.join(candidateStaging, "packages"),
      validationReadbackDirectory: artifacts.validationReadbackDirectory
        ? path.join(candidateStaging, artifacts.validationReadbackDirectory)
        : undefined,
      packageCount: packages.length,
      status: "preserved_in_staging",
      publicationAuthorized: false,
      preservationError: preservationError.message,
    };
  }
}

function validateReleaseVersion(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(value) ||
    value.includes("..")
  )
    fail(
      "release_version_invalid",
      "--release-version must be 1-64 filename-safe characters and may not contain '..'",
    );
}

function validateTidasMemoryBudgetMiB(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_048_576)
    fail(
      "tidas_memory_budget_invalid",
      "TIDAS memory budget must be a whole number between 1 and 1048576 MiB",
      { value },
    );
  return parsed;
}

function tidasSpawnOptions(memoryBudgetMiB) {
  return {
    env: {
      ...process.env,
      TIDAS_MEMORY_BUDGET_MIB: String(
        validateTidasMemoryBudgetMiB(memoryBudgetMiB),
      ),
    },
  };
}

function isMemoryBudgetExceeded(value) {
  if (value === "memory_budget_exceeded") return true;
  if (Array.isArray(value)) return value.some(isMemoryBudgetExceeded);
  if (value && typeof value === "object")
    return Object.values(value).some(isMemoryBudgetExceeded);
  return false;
}

async function applyDistributionNames(packagesDir, releaseVersion) {
  for (const [source, product, format] of DISTRIBUTION_PACKAGES) {
    await rename(
      path.join(packagesDir, source),
      path.join(
        packagesDir,
        `TiangongLCA-${releaseVersion}-${product}.${format}.zip`,
      ),
    );
  }
}

export async function verifyBuiltPackages({
  tidasBin,
  memoryBudgetMiB = DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
  packagesDir,
  workspace,
  releaseVersion,
  reportPath,
  spawnCommand = spawnBounded,
}) {
  const packages = [];
  for (const [, product, format] of DISTRIBUTION_PACKAGES) {
    const fileName = `TiangongLCA-${releaseVersion}-${product}.${format}.zip`;
    const archive = path.join(packagesDir, fileName);
    const listing = await spawnCommand("unzip", ["-Z1", archive]);
    if (listing.code !== 0)
      await failPackageVerification({
        code: "package_archive_invalid",
        message: `Cannot read ZIP member catalog: ${fileName}`,
        stage: "zip_catalog",
        format,
        product,
        fileName,
        stderr: listing.stderr,
        completedPackages: packages,
        releaseVersion,
        reportPath,
      });
    const members = listing.stdout.split(/\r?\n/u).filter(Boolean);
    if (
      members.length === 0 ||
      members.some(
        (member) =>
          member.startsWith("/") || member.split(/[\\/]/u).includes(".."),
      )
    )
      await failPackageVerification({
        code: "package_archive_invalid",
        message: `ZIP contains no members or unsafe paths: ${fileName}`,
        stage: "zip_catalog",
        format,
        product,
        fileName,
        completedPackages: packages,
        releaseVersion,
        reportPath,
      });
    const extracted = path.join(workspace, "readback", fileName);
    await mkdir(extracted, { recursive: true });
    const extraction = await spawnCommand("unzip", [
      "-qq",
      archive,
      "-d",
      extracted,
    ]);
    if (extraction.code !== 0)
      await failPackageVerification({
        code: "package_archive_invalid",
        message: `Cannot extract ZIP: ${fileName}`,
        stage: "zip_readback",
        format,
        product,
        fileName,
        stderr: extraction.stderr,
        completedPackages: packages,
        releaseVersion,
        reportPath,
      });
    const action = format === "tidas" ? "validate-tidas" : "validate-ilcd";
    const validation = await spawnCommand(
      tidasBin,
      ["release", action, "--input-dir", extracted, "--format", "json"],
      tidasSpawnOptions(memoryBudgetMiB),
    );
    if (validation.code !== 0) {
      const diagnostics = parseFailedTidasOutput(validation.stdout);
      const memoryExceeded = isMemoryBudgetExceeded(
        diagnostics.operationReport,
      );
      await failPackageVerification({
        code: memoryExceeded
          ? "tidas_memory_budget_exceeded"
          : `${format}_package_validation_failed`,
        message: `${format.toUpperCase()} validation failed after ZIP readback: ${fileName}`,
        stage: action,
        format,
        product,
        fileName,
        stderr: validation.stderr,
        operationReport: diagnostics.operationReport,
        stdoutTail: diagnostics.stdoutTail,
        completedPackages: packages,
        releaseVersion,
        reportPath,
      });
    }
    let report;
    try {
      report = JSON.parse(validation.stdout);
    } catch {
      await failPackageVerification({
        code: "tidas_output_invalid",
        message: `Validator returned invalid JSON for ${fileName}`,
        stage: `${action}_output`,
        format,
        product,
        fileName,
        stderr: validation.stderr,
        completedPackages: packages,
        releaseVersion,
        reportPath,
      });
    }
    const artifact = await inspectFile(archive);
    packages.push({
      fileName,
      product,
      format,
      memberCount: members.length,
      ...artifact,
      outcome: "passed",
      validation: report,
    });
  }
  return {
    schemaVersion: "tiangong.release.package-verification.v1",
    releaseVersion,
    outcome: "passed",
    packages,
  };
}

async function failPackageVerification({
  code,
  message,
  stage,
  format,
  product,
  fileName,
  stderr = "",
  operationReport,
  stdoutTail,
  completedPackages,
  releaseVersion,
  reportPath,
}) {
  const failure = {
    code,
    message,
    stage,
    format,
    product,
    fileName,
    stderr: String(stderr).slice(-4000),
    operationReport,
    stdoutTail,
  };
  if (reportPath)
    await writeFile(
      reportPath,
      canonicalJson({
        schemaVersion: "tiangong.release.package-verification.v1",
        releaseVersion,
        outcome: "failed",
        packages: completedPackages,
        failure,
      }),
      { flag: "wx" },
    );
  fail(code, message, failure);
}

async function assembleCanonicalCollection({
  materializationRoot,
  materializedIndex,
  intakeRoot,
  intake,
  dependencyArtifacts = [],
  canonicalRoot,
  excludedPaths = new Set(),
}) {
  const entries = [];
  const identities = new Map();
  const paths = new Set();
  for (const dataset of materializedIndex.datasets) {
    const sourcePath = resolveContained(materializationRoot, dataset.path);
    const relativePath = stripCanonicalPrefix(dataset.path);
    if (excludedPaths.has(relativePath)) continue;
    const destination = resolveContained(canonicalRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    const bytes = await readFile(sourcePath);
    if (sha256Bytes(bytes) !== dataset.sha256)
      fail("materialized_dataset_hash_mismatch", `Hash drift: ${dataset.path}`);
    await writeFile(destination, bytes, { flag: "wx" });
    addEntry(entries, identities, paths, {
      ...dataset,
      path: relativePath,
      byteSize: bytes.length,
    });
  }
  const sourceArtifacts = intake.artifacts
    .filter((artifact) => artifact.kind === "source_closure")
    .map((artifact) => ({
      ...artifact,
      resolvedPath: resolveContained(
        path.join(intakeRoot, "calculation-bundle"),
        artifact.path,
      ),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (!sourceArtifacts.length)
    fail(
      "source_closure_missing",
      "Intake contains no source_closure artifact",
    );
  for (const artifact of sourceArtifacts) {
    const artifactBytes = await readFile(artifact.resolvedPath);
    if (sha256Bytes(artifactBytes) !== artifact.sha256)
      fail(
        "source_closure_artifact_hash_mismatch",
        `Hash drift: ${artifact.path}`,
      );
    let recordCount = 0;
    for await (const record of readNdjson(artifact.resolvedPath)) {
      recordCount += 1;
      const relativePath = safeRelative(record.path);
      if (excludedPaths.has(relativePath)) continue;
      const contentHash = hashJson(record.document);
      if (contentHash !== record.sha256)
        fail(
          "source_document_hash_mismatch",
          `Source closure content hash mismatch: ${relativePath}`,
        );
      const content = canonicalJson(record.document);
      const entry = {
        datasetType: record.datasetType,
        role: record.role ?? "support",
        uuid: String(record.uuid).toLowerCase(),
        version: record.version,
        path: relativePath,
        sha256: sha256Bytes(Buffer.from(content)),
        byteSize: Buffer.byteLength(content),
        canonicalContentHash: contentHash,
      };
      const key = identityKey(entry);
      const existing = identities.get(key);
      if (existing) {
        if (existing.canonicalContentHash !== entry.canonicalContentHash)
          fail(
            "canonical_identity_collision",
            `Conflicting dataset identity: ${key}`,
          );
        continue;
      }
      const destination = resolveContained(canonicalRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx" });
      addEntry(entries, identities, paths, entry);
    }
    if (recordCount !== artifact.recordCount)
      fail(
        "source_closure_record_count_mismatch",
        `Record count drift: ${artifact.path}`,
      );
  }
  for (const artifactPath of dependencyArtifacts) {
    for await (const record of readNdjson(artifactPath)) {
      const relativePath = safeRelative(record.path);
      if (excludedPaths.has(relativePath)) continue;
      const contentHash = hashJson(record.document);
      if (contentHash !== record.sha256)
        fail(
          "release_intake_dependency_document_hash_mismatch",
          `Dependency content hash mismatch: ${relativePath}`,
        );
      const content = canonicalJson(record.document);
      const entry = {
        datasetType: record.datasetType,
        role: record.role ?? "support",
        uuid: String(record.uuid).toLowerCase(),
        version: record.version,
        path: relativePath,
        sha256: sha256Bytes(Buffer.from(content)),
        byteSize: Buffer.byteLength(content),
        canonicalContentHash: contentHash,
      };
      const key = identityKey(entry);
      const existing = identities.get(key);
      if (existing) {
        if (existing.canonicalContentHash !== entry.canonicalContentHash)
          fail(
            "canonical_identity_collision",
            `Conflicting dataset identity: ${key}`,
          );
        continue;
      }
      const destination = resolveContained(canonicalRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx" });
      addEntry(entries, identities, paths, entry);
    }
  }
  return entries;
}

function validateScopeDecisionBindings({
  scopeDecision,
  releaseIntake,
  materializationManifest,
  materializedIndex,
  sourceIntake,
}) {
  const source = scopeDecision.decision.source;
  if (
    source.releaseIntakeManifestSha256 !== hashJson(releaseIntake) ||
    source.materializationManifestSha256 !==
      hashJson(materializationManifest) ||
    source.materializedDatasetIndexSha256 !== hashJson(materializedIndex) ||
    source.sourceIntakeManifestSha256 !== hashJson(sourceIntake)
  )
    fail(
      "scope_decision_input_mismatch",
      "Scope decision no longer matches the frozen Release inputs",
    );
}

function validateReleaseIntakeBindings(
  releaseIntake,
  materializationManifest,
  materializedIndex,
  sourceIntake,
) {
  const expected = releaseIntake.source;
  if (
    expected.materializationManifestSha256 !==
      hashJson(materializationManifest) ||
    expected.materializedDatasetIndexSha256 !== hashJson(materializedIndex) ||
    expected.sourceIntakeManifestSha256 !== hashJson(sourceIntake)
  )
    fail(
      "release_intake_upstream_hash_mismatch",
      "Release Intake no longer matches its frozen upstream inputs",
    );
}

function addEntry(entries, identities, paths, entry) {
  const key = identityKey(entry);
  if (identities.has(key))
    fail("canonical_identity_duplicate", `Duplicate dataset identity: ${key}`);
  if (paths.has(entry.path))
    fail("canonical_path_duplicate", `Duplicate canonical path: ${entry.path}`);
  identities.set(key, entry);
  paths.add(entry.path);
  entries.push(entry);
}

function buildIndex(entries) {
  const datasets = [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasetCount: datasets.length,
    byteSize: datasets.reduce((total, entry) => total + entry.byteSize, 0),
    artifactSetHash: hashJson(
      datasets.map(
        ({ datasetType, uuid, version, path: itemPath, sha256 }) => ({
          datasetType,
          uuid,
          version,
          path: itemPath,
          sha256,
        }),
      ),
    ),
    datasets,
  };
}

function validateInputs(manifest, index, intake) {
  if (manifest.schemaVersion !== "tiangong.release.materialization-manifest.v1")
    fail(
      "materialization_manifest_invalid",
      "Expected materialization-manifest.v1",
    );
  if (index.schemaVersion !== "tiangong.release.canonical-dataset-index.v1")
    fail("canonical_index_invalid", "Expected canonical-dataset-index.v1");
  if (intake.schemaVersion !== "tiangong.release.materialization-intake.v1")
    fail("intake_manifest_invalid", "Expected materialization-intake.v1");
  if (manifest.profiles?.model === null)
    fail(
      "package_profile_unsupported",
      "The first Release package route requires LifecycleModel materialization",
    );
  if (
    manifest.inputs.calculationId !== intake.source.calculationId ||
    manifest.inputs.bundleContentHash !== intake.source.bundleContentHash ||
    manifest.inputs.intakeManifestSha256 !== hashJson(intake)
  ) {
    fail(
      "materialization_intake_mismatch",
      "Materialization and intake identities/hashes do not match",
    );
  }
  if (
    manifest.inputs.canonicalDatasetIndexSha256 !== hashJson(index) ||
    index.datasetCount !== index.datasets.length
  ) {
    fail(
      "canonical_index_mismatch",
      "Materialization canonical index is not frozen by its manifest",
    );
  }
}

export async function runTidas({
  tidasBin,
  memoryBudgetMiB = DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
  canonicalRoot,
  indexPath,
  packagesDir,
  issueSpoolPath,
  spawnCommand = spawnBounded,
}) {
  const budget = validateTidasMemoryBudgetMiB(memoryBudgetMiB);
  const runtime = await verifyTidasRuntime({
    tidasBin,
    memoryBudgetMiB: budget,
    spawnCommand,
  });
  await mkdir(path.dirname(packagesDir), { recursive: true });
  const args = [
    "release",
    "build-packages",
    "--tidas-dir",
    canonicalRoot,
    "--dataset-index",
    indexPath,
    "--output-dir",
    packagesDir,
    "--format",
    "json",
  ];
  if (issueSpoolPath && runtime.issueSpoolSupported)
    args.push("--issue-spool", issueSpoolPath);
  const result = await spawnCommand(tidasBin, args, tidasSpawnOptions(budget));
  if (result.code !== 0) {
    const structuredDiagnostics = parseFailedTidasOutput(result.stdout);
    fail(
      isMemoryBudgetExceeded(structuredDiagnostics.operationReport)
        ? "tidas_memory_budget_exceeded"
        : "tidas_package_build_failed",
      `tidas-tools exited with code ${result.code}`,
      {
        stderr: result.stderr.slice(-4000),
        memoryBudgetMiB: budget,
        ...structuredDiagnostics,
      },
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("tidas_output_invalid", "tidas-tools did not return one JSON result");
  }
}

function parseFailedTidasOutput(stdout) {
  try {
    return { operationReport: JSON.parse(stdout) };
  } catch {
    return stdout ? { stdoutTail: stdout.slice(-4000) } : {};
  }
}

export async function verifyTidasRuntime({
  tidasBin,
  memoryBudgetMiB = DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
  spawnCommand = spawnBounded,
}) {
  const version = await runTidasPreflight({
    tidasBin,
    args: ["version", "--format", "json", "--progress", "never"],
    memoryBudgetMiB,
    spawnCommand,
  });
  const observedVersion = version.summary?.binary_version;
  if (
    version.schema_version !== "tidas.operation-report.v1" ||
    version.status !== "succeeded" ||
    version.exit_class !== "success" ||
    version.completeness !== "complete" ||
    version.summary?.operation_report_schema !== "tidas.operation-report.v1"
  )
    fail(
      "tidas_runtime_incompatible",
      "Release package construction requires the tidas operation-report.v1 contract",
      { actualVersion: observedVersion ?? null },
    );

  const validation = await runTidasPreflight({
    tidasBin,
    args: ["validate", "--describe", "--format", "json", "--progress", "never"],
    memoryBudgetMiB,
    spawnCommand,
  });
  const describe = validation.summary?.validation_describe;
  const describeVersion = describe?.package?.version;
  if (
    validation.schema_version !== "tidas.operation-report.v1" ||
    validation.status !== "succeeded" ||
    validation.exit_class !== "success" ||
    validation.completeness !== "complete" ||
    describe?.schema_version !== "tidas.validation-describe.v1" ||
    describe?.package?.name !== "tidas" ||
    typeof describeVersion !== "string" ||
    describeVersion.length === 0 ||
    !describe?.protocols?.includes("document-validation-batch.v1")
  )
    fail(
      "tidas_validation_contract_incompatible",
      "tidas does not advertise the required validation contract",
      { validationDescribe: describe ?? null },
    );

  const help = await spawnCommand(
    tidasBin,
    ["release", "build-packages", "--help"],
    tidasSpawnOptions(memoryBudgetMiB),
  );
  const issueSpoolSupported =
    help.code === 0 && help.stdout.includes("--issue-spool");

  return {
    binaryVersion: describeVersion ?? observedVersion ?? null,
    assetFingerprint: describe.asset_fingerprint,
    issueSpoolSupported,
  };
}

async function runTidasPreflight({
  tidasBin,
  args,
  memoryBudgetMiB,
  spawnCommand,
}) {
  const result = await spawnCommand(
    tidasBin,
    args,
    tidasSpawnOptions(memoryBudgetMiB),
  );
  if (result.code !== 0)
    fail(
      "tidas_preflight_failed",
      `tidas preflight exited with code ${result.code}`,
      {
        argv: args,
        stdout: result.stdout.slice(-4000),
        stderr: result.stderr.slice(-4000),
      },
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(
      "tidas_preflight_output_invalid",
      "tidas preflight did not return one JSON result",
      {
        argv: args,
        stdout: result.stdout.slice(-4000),
        stderr: result.stderr.slice(-4000),
      },
    );
  }
}

function spawnBounded(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk) => (stdout = append(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = append(stderr, chunk)));
    child.once("error", (error) => {
      if (error.code === "ENOENT")
        reject(
          Object.assign(
            new Error(
              command === "unzip"
                ? "Required archive reader not found: unzip"
                : `tidas executable not found: ${command}; install tidas or pass --tidas-bin`,
            ),
            {
              code:
                command === "unzip"
                  ? "archive_reader_missing"
                  : "tidas_executable_missing",
            },
          ),
        );
      else reject(error);
    });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function packageArtifacts(root) {
  const files = await walkFiles(root);
  const result = [];
  for (const file of files) {
    const artifact = await inspectFile(file);
    result.push({
      path: path.relative(path.dirname(root), file).split(path.sep).join("/"),
      mediaType: file.endsWith(".zip")
        ? "application/zip"
        : "application/octet-stream",
      ...artifact,
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function inspectFile(file) {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(file)) {
    byteSize += chunk.length;
    hash.update(chunk);
  }
  return { byteSize, sha256: hash.digest("hex") };
}

async function packageArtifactsIfPresent(root) {
  try {
    return await packageArtifacts(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function walkFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await walkFiles(child)));
    else if (entry.isFile()) result.push(child);
  }
  return result;
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

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function stripCanonicalPrefix(value) {
  const relative = safeRelative(value);
  const prefix = "canonical-datasets/";
  if (!relative.startsWith(prefix))
    fail(
      "canonical_index_path_invalid",
      `Expected ${prefix} path: ${relative}`,
    );
  return safeRelative(relative.slice(prefix.length));
}

function resolveContained(root, relative) {
  const safe = safeRelative(relative);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, safe);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`))
    fail("unsafe_path", `Path escapes root: ${relative}`);
  return resolved;
}

function safeRelative(value) {
  const text = String(value ?? "");
  if (
    !text ||
    text.includes("\\") ||
    path.isAbsolute(text) ||
    text.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("unsafe_path", `Unsafe relative path: ${text}`);
  }
  return text;
}

function identityKey(entry) {
  return `${entry.datasetType}:${entry.uuid.toLowerCase()}:${entry.version}`;
}
