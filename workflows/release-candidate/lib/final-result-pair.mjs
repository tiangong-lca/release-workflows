import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, hashJson, sha256Bytes, fail } from "./common.mjs";
import {
  buildFinalResultArtifacts,
  frozenDocument,
} from "./final-result-artifacts.mjs";
import { verifyFinalResultParity } from "./final-result-parity.mjs";
import {
  RESULT_PACKAGE_PROFILE,
  DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
  runTidas,
  applyDistributionNames,
  verifyBuiltPackages,
  spawnBounded,
  tidasSpawnOptions,
} from "./package-build.mjs";

import { compressResultPackage, requireSevenZip } from "./seven-zip.mjs";
import { commitFrozenDirectory } from "./final-result-files.mjs";

export function successful(report, schema) {
  if (
    report?.schema_version !== "tidas.operation-report.v1" ||
    report.status !== "succeeded" ||
    report.completeness !== "complete" ||
    report.exit_class !== "success" ||
    report.summary?.release?.ok !== true ||
    (schema && report.summary.release.schema_version !== schema)
  )
    fail(
      "final_pair_tool_incomplete",
      "Native packager/validator did not return complete successful evidence",
    );
}

// Local paired-build milestone. Identity registration, verified lineage, Candidate
// freezing and publication readiness are independent callers' obligations.
export async function buildFinalResultPair({
  canonicalRoot,
  index,
  results,
  outDir,
  releaseVersion,
  tidasBin = process.env.TIDAS_BIN ?? "tidas",
  encoder = process.env.RELEASE_HDF5_BIN ?? "release-result-hdf5",
  memoryBudgetMiB = DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
}) {
  if (!/^\d{4}\.\d{2}\.\d+$/u.test(releaseVersion ?? ""))
    fail(
      "release_version_invalid",
      "Explicit YYYY.MM.N release version required",
    );
  if (
    !Array.isArray(index.datasets) ||
    !Array.isArray(results) ||
    !results.length ||
    results.length > 2_000_000
  )
    fail("final_pair_input_invalid", "Invalid final pair input");
  const roots = index.datasets
    .filter((e) => e.role === "result_process")
    .map((e) => `${e.uuid}@${e.version}`)
    .sort();
  const selected = results.map((e) => `${e.uuid}@${e.version}`).sort();
  if (
    canonicalJson(roots) !== canonicalJson(selected) ||
    new Set(selected).size !== selected.length
  )
    fail(
      "final_pair_root_scope",
      "Archive roots and HDF5 Results must be the same exact set",
    );
  await requireSevenZip();
  const target = path.resolve(outDir);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await lstat(target);
    fail("output_exists", "Pair output already exists");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const staging = await mkdtemp(`${target}.work-`);
  const frozen = path.join(staging, "canonical");
  const packages = path.join(staging, "packages");
  const readback = path.join(staging, "validation-readback");
  try {
    await mkdir(frozen);
    for (const entry of index.datasets) {
      await frozenDocument(canonicalRoot, entry);
      const bytes = await readFile(path.join(canonicalRoot, entry.path));
      if (
        sha256Bytes(bytes) !== entry.sha256 ||
        bytes.length !== entry.byteSize
      )
        fail("final_pair_input_drift", "Frozen input changed during copy");
      const dest = path.join(frozen, entry.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, bytes, { flag: "wx" });
    }
    const indexPath = path.join(staging, "canonical-dataset-index.json");
    await writeFile(indexPath, canonicalJson(index), { flag: "wx" });
    const plan = {
      schemaVersion: "tiangong.release.final-result-pair-plan.v1",
      releaseVersion,
      profile: RESULT_PACKAGE_PROFILE,
      indexHash: hashJson(index),
      results,
    };
    await writeFile(path.join(staging, "pair-plan.json"), canonicalJson(plan), {
      flag: "wx",
    });
    const encoded = await buildFinalResultArtifacts({
      canonicalRoot: frozen,
      index,
      results,
      outDir: path.join(staging, "query"),
      encoder,
    });
    const tool = await runTidas({
      tidasBin,
      memoryBudgetMiB,
      canonicalRoot: frozen,
      indexPath,
      packagesDir: packages,
      profile: RESULT_PACKAGE_PROFILE,
      issueSpoolPath: path.join(staging, "tidas-validation-issues.ndjson"),
    });
    successful(tool, "tidas.release-report.v2");
    await writeFile(
      path.join(staging, "tidas-release-report.json"),
      canonicalJson(tool),
      { flag: "wx" },
    );
    await applyDistributionNames(
      packages,
      releaseVersion,
      RESULT_PACKAGE_PROFILE,
    );
    for (const format of ["tidas", "ilcd"]) {
      const base = path.join(
        packages,
        `TiangongLCA-${releaseVersion}-ResultDatabase.${format}`,
      );
      await compressResultPackage(`${base}.zip`, `${base}.7z`);
      await rm(`${base}.zip`);
    }
    const expectedNames = ["tidas", "ilcd"].map(
      (f) => `TiangongLCA-${releaseVersion}-ResultDatabase.${f}.7z`,
    );
    if (
      canonicalJson((await readdir(packages)).sort()) !==
      canonicalJson([...expectedNames].sort())
    )
      fail(
        "final_pair_package_set",
        "Expected exactly the two Result archives",
      );
    const verification = await verifyBuiltPackages({
      tidasBin,
      memoryBudgetMiB,
      packagesDir: packages,
      workspace: readback,
      releaseVersion,
      profile: RESULT_PACKAGE_PROFILE,
      archiveExtension: "7z",
    });
    for (const item of verification.packages) successful(item.validation);
    await writeFile(
      path.join(staging, "package-verification-report.json"),
      canonicalJson(verification),
      { flag: "wx" },
    );
    const archiveRoot = path.join(readback, "readback", expectedNames[0]);
    const roundtrip = await spawnBounded(
      tidasBin,
      [
        "release",
        "semantic-roundtrip",
        "--tidas-dir",
        archiveRoot,
        "--ilcd-dir",
        path.join(readback, "readback", expectedNames[1]),
        "--format",
        "json",
      ],
      tidasSpawnOptions(memoryBudgetMiB),
    );
    if (roundtrip.code !== 0)
      fail(
        "final_pair_archive_roundtrip",
        "Actual 7z contents fail semantic roundtrip",
        { stderr: roundtrip.stderr.slice(-4000) },
      );
    const roundtripReport = JSON.parse(roundtrip.stdout);
    successful(roundtripReport);
    await writeFile(
      path.join(staging, "archive-roundtrip-report.json"),
      canonicalJson(roundtripReport),
      { flag: "wx" },
    );
    const parity = await verifyFinalResultParity({
      archiveRoot,
      index,
      results,
      queryRoot: encoded.path,
      encodingReceipt: encoded.receipt,
      workspace: readback,
      encoder,
    });
    await writeFile(
      path.join(staging, "final-result-parity.json"),
      canonicalJson(parity),
      { flag: "wx" },
    );
    const receipt = {
      schemaVersion: "tiangong.release.final-result-pair.v1",
      pairQualified: true,
      candidateQualified: false,
      publicationAuthorized: false,
      releaseVersion,
      profile: RESULT_PACKAGE_PROFILE,
      inputHash: encoded.receipt.inputHash,
      planHash: hashJson(plan),
      indexHash: hashJson(index),
      encodingReceiptHash: hashJson(encoded.receipt),
      parityHash: hashJson(parity),
      packageVerificationHash: hashJson(verification),
      archiveRoundtripHash: hashJson(roundtripReport),
      packages: verification.packages.map(
        ({ fileName, sha256, byteSize, format, memberCount }) => ({
          path: `packages/${fileName}`,
          sha256,
          byteSize,
          format,
          memberCount,
        }),
      ),
      artifacts: encoded.receipt.artifacts.map((a) => ({
        ...a,
        path: `query/${a.path}`,
      })),
    };
    await writeFile(
      path.join(staging, "paired-result-receipt.json"),
      canonicalJson(receipt),
      { flag: "wx" },
    );
    await rm(frozen, { recursive: true, force: true });
    await rm(readback, { recursive: true, force: true });
    await commitFrozenDirectory(staging, target, "paired-result-receipt.json");
    return { path: target, receipt };
  } catch (error) {
    await writeFile(
      path.join(staging, "failed-pair.json"),
      canonicalJson({
        schemaVersion: "tiangong.release.final-result-pair-failure.v1",
        candidateCreated: false,
        publicationAuthorized: false,
        code: error.code ?? "pair_failed",
        diagnostics: error.details ?? null,
      }),
      { flag: "wx" },
    );
    error.details = { ...error.details, retainedPairBuild: staging };
    throw error;
  }
}
