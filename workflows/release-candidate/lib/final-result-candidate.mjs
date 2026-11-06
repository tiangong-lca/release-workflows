import { MAX_INPUT_PLAN_BYTES } from "./resource-budget.mjs";
import { mkdir, lstat, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, hashJson, sha256Bytes, fail } from "./common.mjs";
import {
  loadFinalResultInput,
  verifyFrozenFinalInput,
} from "./final-result-input.mjs";
import { buildFinalResultPair, successful } from "./final-result-pair.mjs";
import { buildPublicationCatalog } from "./publication-catalog.mjs";
import {
  readLocalJson,
  verifiedBytes,
  verifyLargeFile,
  indexFile,
  commitFrozenDirectory,
} from "./final-result-files.mjs";
import { RESULT_PACKAGE_PROFILE } from "./package-build.mjs";
const MAX_METADATA = 128 * 1024 * 1024;
const key = (r) => `${r.uuid}@${r.version}`;
function requireValue(value, code = "final_candidate_binding_invalid") {
  if (!value)
    fail(
      code,
      "Paired Candidate evidence does not bind the exact frozen final Result content",
    );
}
function same(a, b) {
  requireValue(hashJson(a) === hashJson(b));
}
export function verifyResultCatalogScope(catalog, index) {
  const keyOf = (r) =>
    `${r.datasetType}:${String(r.uuid).toLowerCase()}@${r.version}`;
  const keys = index.datasets.map(keyOf).sort();
  const roots = index.datasets
    .filter((r) => r.datasetType === "process" && r.role === "result_process")
    .map(keyOf)
    .sort();
  requireValue(
    catalog.canonicalDatasetIndexSha256 === hashJson(index),
    "final_candidate_closure_scope",
  );
  same(catalog.components.unitProcess, {
    available: false,
    roots: [],
    datasets: [],
  });
  same(catalog.components.result, { available: true, roots, datasets: keys });
  requireValue(
    catalog.datasetCount === keys.length &&
      catalog.datasets.length === keys.length,
    "final_candidate_closure_scope",
  );
  const records = new Map(catalog.datasets.map((r) => [r.key, r]));
  requireValue(records.size === keys.length, "final_candidate_closure_scope");
  for (const entry of index.datasets) {
    const record = records.get(keyOf(entry));
    requireValue(
      record &&
        record.role === entry.role &&
        record.datasetType === entry.datasetType &&
        record.uuid === entry.uuid.toLowerCase() &&
        record.version === entry.version &&
        record.path === entry.path &&
        record.sha256 === entry.sha256 &&
        record.canonicalContentHash === entry.canonicalContentHash,
      "final_candidate_closure_scope",
    );
    same(record.components, ["result"]);
  }
  const seen = new Set(),
    pending = [...roots];
  while (pending.length) {
    const key = pending.pop();
    if (seen.has(key)) continue;
    const record = records.get(key);
    requireValue(
      record && Array.isArray(record.references),
      "final_candidate_closure_scope",
    );
    seen.add(key);
    for (const reference of record.references) pending.push(reference);
  }
  requireValue(seen.size === keys.length, "final_candidate_closure_scope");
}
// The dependency graph is a build-time proof. Publication only needs exact
// package membership for Result coverage and live support-data authorization.
export function finalResultMembership(index) {
  const datasets = index.datasets
    .map(({ datasetType, role, uuid, version, canonicalContentHash }) => ({
      datasetType,
      role,
      uuid: uuid.toLowerCase(),
      version,
      canonicalContentHash,
    }))
    .sort((a, b) => {
      const ka = `${a.datasetType}:${a.uuid}@${a.version}`;
      const kb = `${b.datasetType}:${b.uuid}@${b.version}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return {
    schemaVersion: "tiangong.release.candidate-publication-catalog.v2",
    canonicalDatasetIndexSha256: hashJson(index),
    datasetCount: datasets.length,
    datasets,
  };
}

async function buildMembership(frozen) {
  const graph = await buildPublicationCatalog({
    canonicalRoot: frozen.canonicalRoot,
    index: frozen.index,
    resultOnly: true,
  });
  verifyResultCatalogScope(graph, frozen.index);
  return finalResultMembership(frozen.index);
}

function packageSet(packages) {
  return packages.map(({ path, sha256, byteSize }) => ({
    path,
    sha256,
    byteSize,
  }));
}
const prefixed = (entries) =>
  entries.map((e) => ({ ...e, path: `pair/${e.path}` }));

async function queryRows(root, input, artifacts) {
  requireValue(
    Array.isArray(artifacts) &&
      artifacts.length > 0 &&
      artifacts.length <= input.results.length,
  );
  const expected = new Map(input.results.map((r) => [key(r), r]));
  const seen = new Set();
  const artifactIds = new Set();
  const rows = [];
  let metadata = 0;
  for (const artifact of artifacts) {
    requireValue(!artifactIds.has(artifact.artifactId));
    artifactIds.add(artifact.artifactId);
    const bytes = await verifiedBytes(
      root,
      {
        name: `${artifact.path}/manifest.json`,
        sha256: artifact.manifestSha256,
        byteSize: artifact.manifestByteSize,
      },
      MAX_METADATA,
    );
    metadata += bytes.length;
    const manifest = JSON.parse(bytes);
    requireValue(
      manifest.schemaVersion === "tiangong.query-artifact.v2" &&
        artifact.schemaVersion === manifest.schemaVersion &&
        manifest.artifactId === artifact.artifactId &&
        manifest.source?.inputHash === input.inputHash &&
        manifest.resultCount === artifact.resultCount &&
        Array.isArray(manifest.files),
    );
    const files = new Map(manifest.files.map((f) => [f.name, f]));
    const names = [
      "inventory-items.json.gz",
      "lci.h5",
      "results.json.gz",
      ...(manifest.impactCount > 0 ? ["impacts.json.gz", "lcia.h5"] : []),
    ].sort();
    same([...files.keys()].sort(), names);
    requireValue(files.size === manifest.files.length);
    for (const file of manifest.files) {
      if (file.name.endsWith(".gz")) {
        metadata += file.plainByteSize;
        requireValue(
          Number.isSafeInteger(metadata) && metadata <= MAX_METADATA,
          "final_candidate_metadata_budget",
        );
      }
      await verifyLargeFile(root, {
        ...file,
        name: `${artifact.path}/${file.name}`,
      });
    }
    const axis = await indexFile(
      path.join(root, artifact.path),
      manifest,
      "results.json.gz",
    );
    requireValue(axis.length === manifest.resultCount);
    for (const [ordinal, row] of axis.entries()) {
      const k = key(row);
      const selected = expected.get(k);
      requireValue(
        selected &&
          !seen.has(k) &&
          row.ordinal === ordinal &&
          row.contentHash === selected.contentHash &&
          row.hashDomain === selected.hashDomain &&
          row.canonicalContentHash === selected.canonicalContentHash &&
          row.relationKind === selected.relationKind,
      );
      same(row.sources, selected.sources);
      requireValue(
        manifest.impactCount > 0 === (selected.layer === "lci-lcia"),
      );
      seen.add(k);
      rows.push({
        ...selected,
        artifactId: artifact.artifactId,
        manifestSha256: artifact.manifestSha256,
        ordinal,
      });
    }
  }
  requireValue(seen.size === expected.size, "final_candidate_query_coverage");
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

export async function buildFinalResultCandidate({
  finalInputDir,
  confirmInputHash,
  outDir,
  releaseVersion,
  tidasBin,
  encoder,
  memoryBudgetMiB,
}) {
  const frozen = await loadFinalResultInput(finalInputDir);
  requireValue(
    confirmInputHash === frozen.input.inputHash,
    "final_candidate_confirmation_mismatch",
  );
  requireValue(
    /^\d{4}\.\d{2}\.\d+$/u.test(releaseVersion ?? ""),
    "release_version_invalid",
  );
  const target = path.resolve(outDir);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await lstat(target);
    fail("output_exists", "Candidate output already exists");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const staging = await mkdtemp(`${target}.work-`);
  try {
    for (const [name, value] of Object.entries({
      "final-result-input.json": frozen.input,
      "input-plan.json": frozen.plan,
      "source-lineage.json": frozen.lineage,
      "canonical-dataset-index.json": frozen.index,
    }))
      await writeFile(path.join(staging, name), canonicalJson(value), {
        flag: "wx",
      });
    const catalog = await buildMembership(frozen);
    const catalogBytes = Buffer.from(canonicalJson(catalog));
    requireValue(
      catalogBytes.length <= MAX_METADATA,
      "final_candidate_metadata_budget",
    );
    const catalogSha256 = sha256Bytes(catalogBytes);
    await writeFile(
      path.join(staging, "publication-catalog.json"),
      catalogBytes,
      { flag: "wx" },
    );
    const paired = await buildFinalResultPair({
      canonicalRoot: frozen.canonicalRoot,
      index: frozen.index,
      results: frozen.input.selection,
      outDir: path.join(staging, "pair"),
      releaseVersion,
      tidasBin,
      encoder,
      memoryBudgetMiB,
    });
    requireValue(
      paired.receipt.inputHash === frozen.input.inputHash &&
        paired.receipt.pairQualified === true,
    );
    const artifacts = prefixed(paired.receipt.artifacts);
    const queryCatalog = {
      schemaVersion: "tiangong.release.final-result-query-catalog.v1",
      inputHash: frozen.input.inputHash,
      results: await queryRows(staging, frozen.input, artifacts),
    };
    await writeFile(
      path.join(staging, "query-results.json"),
      canonicalJson(queryCatalog),
      { flag: "wx" },
    );
    const packages = prefixed(paired.receipt.packages);
    const candidate = {
      schemaVersion: "tiangong.release.release-candidate.v3",
      status: "local_candidate",
      candidateQualified: true,
      publicationAuthorized: false,
      releaseVersion,
      profile: RESULT_PACKAGE_PROFILE,
      inputHash: frozen.input.inputHash,
      canonicalDatasetIndexSha256: hashJson(frozen.index),
      finalInput: {
        path: "final-result-input.json",
        sha256: hashJson(frozen.input),
      },
      inputPlan: { path: "input-plan.json", sha256: hashJson(frozen.plan) },
      sourceLineage: {
        path: "source-lineage.json",
        sha256: hashJson(frozen.lineage),
      },
      pair: {
        path: "pair/paired-result-receipt.json",
        sha256: hashJson(paired.receipt),
      },
      queryResults: {
        path: "query-results.json",
        sha256: hashJson(queryCatalog),
      },
      publicationCatalog: {
        path: "publication-catalog.json",
        sha256: catalogSha256,
      },
      packages,
      packageSetHash: hashJson(packageSet(packages)),
      queryArtifacts: artifacts,
      validation: {
        delegatedTo: "tidas-tools",
        outcome: "passed",
        finalResultParity: "passed",
        finalInputBinding: "verified",
        reportPath: "pair/tidas-release-report.json",
        archiveReadbackReportPath: "pair/package-verification-report.json",
      },
    };
    await writeFile(
      path.join(staging, "release-candidate.json"),
      canonicalJson(candidate),
      { flag: "wx" },
    );
    await loadFinalResultCandidate(staging);
    await commitFrozenDirectory(staging, target, "release-candidate.json");
    return { path: target, candidate, warnings: frozen.warnings };
  } catch (error) {
    await rm(path.join(staging, "release-candidate.json"), { force: true });
    await writeFile(
      path.join(staging, "failed-candidate.json"),
      canonicalJson({
        schemaVersion: "tiangong.release.final-result-candidate-failure.v1",
        inputHash: frozen.input.inputHash,
        candidateCreated: false,
        publicationAuthorized: false,
        code: error.code ?? "final_candidate_failed",
      }),
      { flag: "wx" },
    );
    error.details = {
      ...error.details,
      retainedCandidateBuild: staging,
    };
    throw error;
  }
}

// This reads immutable local qualification evidence. It grants no publication or
// actor access; Database must validate artifact membership at publication.
export async function loadFinalResultCandidate(candidateDir) {
  const root = path.resolve(candidateDir);
  const candidate = await readLocalJson(root, "release-candidate.json");
  requireValue(
    candidate.schemaVersion === "tiangong.release.release-candidate.v3" &&
      candidate.status === "local_candidate" &&
      candidate.candidateQualified === true &&
      candidate.publicationAuthorized === false &&
      candidate.profile === RESULT_PACKAGE_PROFILE &&
      candidate.validation?.delegatedTo === "tidas-tools" &&
      candidate.validation.outcome === "passed" &&
      candidate.validation.finalResultParity === "passed" &&
      candidate.validation.finalInputBinding === "verified",
  );
  const bound = async (ref, limit = MAX_METADATA) => {
    requireValue(ref && typeof ref.path === "string");
    const value = await readLocalJson(root, ref.path, limit);
    requireValue(hashJson(value) === ref.sha256);
    return value;
  };
  const input = await bound(candidate.finalInput);
  const plan = await bound(candidate.inputPlan, MAX_INPUT_PLAN_BYTES);
  const lineage = await bound(candidate.sourceLineage);
  const index = await readLocalJson(root, "canonical-dataset-index.json");
  requireValue(
    hashJson(index) === candidate.canonicalDatasetIndexSha256 &&
      candidate.inputHash === input.inputHash,
  );
  verifyFrozenFinalInput({ input, index, plan, lineage });
  const pair = await bound(candidate.pair);
  requireValue(
    pair.schemaVersion === "tiangong.release.final-result-pair.v1" &&
      pair.pairQualified === true &&
      pair.candidateQualified === false &&
      pair.publicationAuthorized === false &&
      pair.inputHash === input.inputHash &&
      pair.releaseVersion === candidate.releaseVersion &&
      pair.profile === candidate.profile &&
      pair.indexHash === hashJson(index),
  );
  same(candidate.packages, prefixed(pair.packages));
  requireValue(candidate.packages.length === 2);
  same(candidate.packages.map((p) => p.format).sort(), ["ilcd", "tidas"]);
  for (const p of candidate.packages) {
    requireValue(
      p.path ===
        `pair/packages/TiangongLCA-${candidate.releaseVersion}-ResultDatabase.${p.format}.zip`,
    );
    await verifyLargeFile(root, {
      name: p.path,
      sha256: p.sha256,
      byteSize: p.byteSize,
    });
  }
  requireValue(
    candidate.packageSetHash === hashJson(packageSet(candidate.packages)),
  );
  same(candidate.queryArtifacts, prefixed(pair.artifacts));
  const queryCatalog = await bound(candidate.queryResults);
  requireValue(
    queryCatalog.schemaVersion ===
      "tiangong.release.final-result-query-catalog.v1" &&
      queryCatalog.inputHash === input.inputHash,
  );
  same(
    queryCatalog.results,
    await queryRows(root, input, candidate.queryArtifacts),
  );
  const proofs = new Map();
  for (const [file, hash] of [
    ["pair-plan.json", pair.planHash],
    ["query/encoding-receipt.json", pair.encodingReceiptHash],
    ["final-result-parity.json", pair.parityHash],
    ["package-verification-report.json", pair.packageVerificationHash],
    ["archive-roundtrip-report.json", pair.archiveRoundtripHash],
  ]) {
    const proof = await readLocalJson(root, `pair/${file}`);
    requireValue(hashJson(proof) === hash);
    proofs.set(file, proof);
  }
  const pairPlan = proofs.get("pair-plan.json");
  requireValue(
    pairPlan.schemaVersion === "tiangong.release.final-result-pair-plan.v1" &&
      pairPlan.indexHash === input.indexHash &&
      pairPlan.releaseVersion === candidate.releaseVersion &&
      pairPlan.profile === candidate.profile,
  );
  same(pairPlan.results, input.selection);
  const encoding = proofs.get("query/encoding-receipt.json");
  requireValue(
    encoding.schemaVersion === "tiangong.release.final-result-encoding.v1" &&
      encoding.inputHash === input.inputHash &&
      encoding.candidateQualified === false &&
      encoding.publicationAuthorized === false,
  );
  same(
    pair.artifacts,
    encoding.artifacts.map((a) => ({ ...a, path: `query/${a.path}` })),
  );
  const parity = proofs.get("final-result-parity.json");
  requireValue(
    parity.schemaVersion === "tiangong.release.final-result-parity.v1" &&
      parity.outcome === "passed" &&
      parity.inputHash === input.inputHash &&
      parity.resultCount === input.results.length,
  );
  same(
    parity.artifacts.map(({ artifactId, manifestSha256, resultCount }) => ({
      artifactId,
      manifestSha256,
      resultCount,
    })),
    pair.artifacts.map(({ artifactId, manifestSha256, resultCount }) => ({
      artifactId,
      manifestSha256,
      resultCount,
    })),
  );
  const verification = proofs.get("package-verification-report.json");
  requireValue(
    verification.schemaVersion === "tiangong.release.package-verification.v2" &&
      verification.outcome === "passed" &&
      verification.profile === candidate.profile &&
      verification.releaseVersion === candidate.releaseVersion,
  );
  same(
    pair.packages,
    verification.packages.map(
      ({ fileName, sha256, byteSize, format, memberCount }) => ({
        path: `packages/${fileName}`,
        sha256,
        byteSize,
        format,
        memberCount,
      }),
    ),
  );
  for (const p of verification.packages) successful(p.validation);
  successful(proofs.get("archive-roundtrip-report.json"));
  const catalog = await readLocalJson(root, candidate.publicationCatalog.path);
  const catalogBytes = Buffer.from(canonicalJson(catalog));
  await verifiedBytes(
    root,
    {
      name: candidate.publicationCatalog.path,
      sha256: candidate.publicationCatalog.sha256,
      byteSize: catalogBytes.length,
    },
    MAX_METADATA,
  );
  same(catalog, finalResultMembership(index));
  return {
    root,
    candidate,
    index,
    input,
    plan,
    lineage,
    queryCatalog,
    catalog,
  };
}
