import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { loadFinalResultCandidate } from "../../release-candidate/lib/final-result-candidate.mjs";
import {
  safeFile,
  verifiedBytes,
} from "../../release-candidate/lib/final-result-files.mjs";
import { fail, hashJson } from "./common.mjs";
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const MAX_METADATA = 128 * 1024 ** 2;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function required(value, code = "final_storage_binding_invalid") {
  if (!value)
    fail(
      code,
      "Final Result storage evidence does not match its immutable input",
    );
}
const same = (a, b) => hashJson(a) === hashJson(b);

export function finalResultRowBindings(rows) {
  required(Array.isArray(rows) && rows.length > 0 && rows.length <= 2000000);
  const blocks = [],
    seen = new Set();
  let block = "";
  for (const [ordinal, row] of rows.entries()) {
    required(
      row &&
        Object.keys(row).length === 7 &&
        row.ordinal === ordinal &&
        UUID.test(row.uuid ?? "") &&
        VERSION.test(row.version ?? "") &&
        HASH.test(row.canonicalContentHash ?? "") &&
        HASH.test(row.contentHash ?? "") &&
        ["direct", "derived"].includes(row.relationKind) &&
        Array.isArray(row.sources) &&
        row.sources.length > 0 &&
        row.sources.length <= 4096 &&
        (row.relationKind !== "direct" || row.sources.length === 1),
    );
    const key = `${row.uuid}@${row.version}`;
    required(!seen.has(key));
    seen.add(key);
    const sources = row.sources
      .map((source) => {
        required(
          source &&
            Object.keys(source).length === 2 &&
            UUID.test(source.uuid ?? "") &&
            VERSION.test(source.version ?? ""),
        );
        return `${source.uuid}@${source.version}`;
      })
      .sort(order);
    required(new Set(sources).size === sources.length);
    const fields = [
      ordinal,
      row.uuid,
      row.version,
      row.canonicalContentHash,
      row.contentHash,
      row.relationKind,
      ...sources,
    ];
    block += sha(`tiangong.final-result-row.v2\n${fields.join("\n")}\n`) + "\n";
    if ((ordinal + 1) % 500 === 0 || ordinal === rows.length - 1) {
      blocks.push(sha(block));
      block = "";
    }
  }
  return sha(`tiangong.final-result-row-bindings.v1\n${blocks.join("\n")}\n`);
}

export function* finalResultRowBatches(rows) {
  let batch = [],
    size = 2;
  for (const row of rows) {
    // These validated wire rows contain only ASCII identity/hash tokens. Count
    // JSONB's extra colon/comma spaces too, not just compact JSON wire bytes.
    const bytes = Buffer.byteLength(
      JSON.stringify(row).replaceAll('":', '": ').replaceAll(",", ", "),
    );
    required(bytes + 2 <= 1024 ** 2, "final_storage_row_budget");
    if (batch.length === 500 || size + bytes + 2 > 1024 ** 2) {
      yield batch;
      batch = [];
      size = 2;
    }
    size += bytes + (batch.length ? 2 : 0);
    batch.push(row);
  }
  if (batch.length) yield batch;
}

async function workload(candidateDir, targetHash) {
  required(HASH.test(targetHash ?? ""));
  const loaded = await loadFinalResultCandidate(candidateDir);
  const rawFile = async (relative) => {
    const sourcePath = await safeFile(loaded.root, relative);
    const size = (await stat(sourcePath)).size;
    required(size >= 1 && size <= MAX_METADATA);
    const bytes = await readFile(sourcePath);
    required(bytes.length === size);
    return { sourcePath, bytes };
  };
  const candidate = await rawFile("release-candidate.json");
  required(same(JSON.parse(candidate.bytes), loaded.candidate));
  const candidateHash = sha(candidate.bytes);
  const catalog = await rawFile(loaded.candidate.publicationCatalog.path);
  required(
    sha(catalog.bytes) === loaded.candidate.publicationCatalog.sha256 &&
      same(JSON.parse(catalog.bytes), loaded.catalog),
  );
  const groups = new Map(
    loaded.candidate.queryArtifacts.map((a) => [a.artifactId, []]),
  );
  for (const row of loaded.queryCatalog.results) {
    required(groups.has(row.artifactId));
    groups.get(row.artifactId).push({
      uuid: row.uuid,
      version: row.version,
      ordinal: row.ordinal,
      canonicalContentHash: row.canonicalContentHash,
      contentHash: row.contentHash,
      relationKind: row.relationKind,
      sources: row.sources,
    });
  }
  const artifacts = [];
  for (const a of loaded.candidate.queryArtifacts) {
    const artifact = {
      schemaVersion: a.schemaVersion,
      artifactId: a.artifactId,
      manifestSha256: a.manifestSha256,
      manifestByteSize: a.manifestByteSize,
    };
    const manifestBytes = await verifiedBytes(
      loaded.root,
      {
        name: `${a.path}/manifest.json`,
        sha256: a.manifestSha256,
        byteSize: a.manifestByteSize,
      },
      MAX_METADATA,
    );
    const manifest = JSON.parse(manifestBytes);
    const rows = groups.get(a.artifactId).sort((x, y) => x.ordinal - y.ordinal);
    const rowBindingsSha256 = finalResultRowBindings(rows);
    const files = [
      ...manifest.files.map(({ name, sha256, byteSize }) => ({
        name,
        sha256,
        byteSize,
      })),
      {
        name: "manifest.json",
        sha256: a.manifestSha256,
        byteSize: a.manifestByteSize,
      },
    ].sort((x, y) => order(x.name, y.name));
    artifacts.push({
      artifact,
      manifestText: manifestBytes.toString("utf8"),
      rows,
      rowBindingsSha256,
      files: await Promise.all(
        files.map(async (file) => ({
          file,
          sourcePath: await safeFile(loaded.root, `${a.path}/${file.name}`),
        })),
      ),
    });
  }
  const files = [
    {
      file: {
        name: "release-candidate.json",
        sha256: candidateHash,
        byteSize: candidate.bytes.length,
      },
      sourcePath: candidate.sourcePath,
    },
    {
      file: {
        name: "publication-catalog.json",
        sha256: sha(catalog.bytes),
        byteSize: catalog.bytes.length,
      },
      sourcePath: catalog.sourcePath,
    },
    ...(await Promise.all(
      loaded.candidate.packages.map(async (p) => ({
        file: {
          name: `result.${p.format}.7z`,
          sha256: p.sha256,
          byteSize: p.byteSize,
        },
        sourcePath: await safeFile(loaded.root, p.path),
      })),
    )),
  ].sort((x, y) => order(x.file.name, y.file.name));
  const plan = {
    schemaVersion: "tiangong.final-result-storage-plan.v1",
    candidateHash,
    targetHash,
    inputHash: loaded.candidate.inputHash,
    resultCount: loaded.input.results.length,
    memberCount: loaded.catalog.datasetCount,
    artifacts: artifacts.map((a) => ({
      artifact: a.artifact,
      resultCount: a.rows.length,
      rowBindingsSha256: a.rowBindingsSha256,
      files: a.files.map((f) => f.file),
    })),
    files: files.map((f) => f.file),
    publicationAuthorized: false,
  };
  return {
    plan,
    planHash: hashJson(plan),
    artifacts,
    files,
    candidateText: candidate.bytes.toString("utf8"),
    catalogText: catalog.bytes.toString("utf8"),
  };
}
export async function inspectFinalResultStorage({ candidateDir, targetHash }) {
  const { plan, planHash } = await workload(candidateDir, targetHash);
  return { plan, planHash };
}
function matchingReceipt(receipt, expected) {
  if (
    !receipt ||
    !UUID.test(receipt.readbackId ?? "") ||
    !Number.isFinite(Date.parse(receipt.verifiedAt))
  )
    return false;
  const { readbackId, verifiedAt, ...binding } = receipt;
  return same(binding, expected);
}
async function persistReceipt(write, read, expected) {
  let writeError;
  try {
    await write();
  } catch (error) {
    if (
      ![
        "final_storage_registry_outcome_unknown",
        "final_storage_registry_conflict",
      ].includes(error.code)
    )
      throw error;
    writeError = error;
  }
  const record = await read();
  if (!matchingReceipt(record?.readbackReceipt, expected)) {
    if (writeError) throw writeError;
    fail(
      "final_storage_registry_readback_mismatch",
      "Registry readback did not recover the exact immutable storage binding",
    );
  }
  return record.readbackReceipt;
}

// Existing service-only describe RPCs run in read-only transactions. This check
// is shared by the standalone diagnostic and every execute, before the first
// object ensure/upload. It never stages rows, seals evidence or registers data.
export async function preflightFinalResultStorage({ plan, registry }) {
  try {
    const artifacts = [];
    for (const entry of plan.artifacts) {
      const existing = await registry.describeQuery(
        entry.artifact.artifactId,
        plan.targetHash,
      );
      if (existing) {
        required(
          same(existing.artifact, entry.artifact) &&
            existing.inputHash === plan.inputHash &&
            existing.resultCount === entry.resultCount &&
            Number.isSafeInteger(existing.registeredResultCount) &&
            existing.registeredResultCount >= 0 &&
            existing.registeredResultCount <= entry.resultCount &&
            existing.publicationAuthorized === false,
          "final_storage_registry_preflight_conflict",
        );
        if (existing.readbackReceipt != null)
          required(
            matchingReceipt(existing.readbackReceipt, {
              schemaVersion: "tiangong.final-result-query-readback.v1",
              verification: "full-get-sha256-and-axis",
              targetHash: plan.targetHash,
              rowBindingsSha256: entry.rowBindingsSha256,
              artifact: entry.artifact,
              inputHash: plan.inputHash,
              files: entry.files,
            }),
            "final_storage_registry_preflight_conflict",
          );
      }
      artifacts.push({
        artifactId: entry.artifact.artifactId,
        registeredResultCount: existing?.registeredResultCount ?? 0,
        sealed: existing?.readbackReceipt != null,
      });
    }
    const candidate = await registry.describeCandidate(
      plan.candidateHash,
      plan.targetHash,
    );
    if (candidate?.readbackReceipt != null)
      required(
        matchingReceipt(candidate.readbackReceipt, {
          schemaVersion: "tiangong.final-result-candidate-readback.v1",
          candidateSha256: plan.candidateHash,
          targetHash: plan.targetHash,
          verification: "full-get-sha256-and-package-closure",
          files: plan.files,
        }),
        "final_storage_registry_preflight_conflict",
      );
    return {
      schemaVersion: "tiangong.final-result-storage-preflight.v1",
      candidateHash: plan.candidateHash,
      targetHash: plan.targetHash,
      databaseReady: true,
      artifacts,
      candidateRegistered: candidate?.readbackReceipt != null,
      uploadAttempted: false,
      registryWriteAttempted: false,
      publicationAuthorized: false,
    };
  } catch (error) {
    // Only this boundary can assert that failure preceded all object uploads
    // and registry writes in execute. Later failures retain reconciliation.
    error.details = { ...error.details, phase: "database_preflight" };
    throw error;
  }
}

export async function executeFinalResultStorage({
  candidateDir,
  confirmPlanHash,
  objectStore,
  registry,
}) {
  required(
    objectStore.databaseTargetHash === registry.databaseTargetHash,
    "final_storage_target_mismatch",
  );
  const w = await workload(candidateDir, objectStore.targetHash);
  required(
    confirmPlanHash === w.planHash,
    "final_storage_confirmation_mismatch",
  );
  await preflightFinalResultStorage({ plan: w.plan, registry });
  const artifactReceipts = [];
  let multipartCleanupRequired = false;
  const verifyObject = (response) => {
    required(response.targetHash === w.plan.targetHash);
    multipartCleanupRequired ||= response.multipartCleanupRequired === true;
  };
  for (const a of w.artifacts) {
    // Commit the manifest last; SQL visibility still waits for complete seal.
    for (const entry of [...a.files].sort(
      (x, y) =>
        (x.file.name === "manifest.json") - (y.file.name === "manifest.json"),
    )) {
      const response = await objectStore.ensureQuery(
        a.artifact,
        entry.file,
        entry.sourcePath,
      );
      required(same(response.file, entry.file));
      verifyObject(response);
    }
    for (const batch of finalResultRowBatches(a.rows)) {
      const staged = await registry.stageQuery(
        a.artifact,
        a.manifestText,
        batch,
      );
      required(
        staged.artifactId === a.artifact.artifactId &&
          staged.publicationAuthorized === false &&
          Number.isSafeInteger(staged.registeredResultCount) &&
          staged.registeredResultCount >= batch.length &&
          staged.registeredResultCount <= a.rows.length,
      );
    }
    const expected = {
      schemaVersion: "tiangong.final-result-query-readback.v1",
      verification: "full-get-sha256-and-axis",
      targetHash: w.plan.targetHash,
      rowBindingsSha256: a.rowBindingsSha256,
      artifact: a.artifact,
      inputHash: w.plan.inputHash,
      files: a.files.map((f) => f.file),
    };
    const describe = () =>
      registry.describeQuery(a.artifact.artifactId, w.plan.targetHash);
    const existing = await describe();
    required(
      existing &&
        same(existing.artifact, a.artifact) &&
        existing.inputHash === w.plan.inputHash &&
        existing.resultCount === a.rows.length &&
        existing.registeredResultCount === a.rows.length &&
        existing.publicationAuthorized === false,
    );
    let receipt;
    if (existing.readbackReceipt !== null) {
      required(matchingReceipt(existing.readbackReceipt, expected));
      receipt = existing.readbackReceipt;
    } else {
      const proposed = {
        ...expected,
        readbackId: randomUUID(),
        verifiedAt: new Date().toISOString(),
      };
      receipt = await persistReceipt(
        () => registry.sealQuery(a.artifact.artifactId, proposed),
        describe,
        expected,
      );
    }
    artifactReceipts.push(receipt);
  }
  for (const entry of [...w.files].sort(
    (x, y) =>
      (x.file.name === "release-candidate.json") -
      (y.file.name === "release-candidate.json"),
  )) {
    const response = await objectStore.ensureCandidate(
      w.plan.candidateHash,
      entry.file,
      entry.sourcePath,
    );
    required(same(response.file, entry.file));
    verifyObject(response);
  }
  const expected = {
    schemaVersion: "tiangong.final-result-candidate-readback.v1",
    candidateSha256: w.plan.candidateHash,
    targetHash: w.plan.targetHash,
    verification: "full-get-sha256-and-package-closure",
    files: w.plan.files,
  };
  const describe = () =>
    registry.describeCandidate(w.plan.candidateHash, w.plan.targetHash);
  const existing = await describe();
  let candidateReceipt;
  if (existing?.readbackReceipt) {
    required(matchingReceipt(existing.readbackReceipt, expected));
    candidateReceipt = existing.readbackReceipt;
  } else {
    const proposed = {
      ...expected,
      readbackId: randomUUID(),
      verifiedAt: new Date().toISOString(),
    };
    candidateReceipt = await persistReceipt(
      () =>
        registry.registerCandidate(w.candidateText, w.catalogText, proposed),
      describe,
      expected,
    );
  }
  return {
    schemaVersion: "tiangong.final-result-storage-receipt.v1",
    planHash: w.planHash,
    candidateHash: w.plan.candidateHash,
    targetHash: w.plan.targetHash,
    inputHash: w.plan.inputHash,
    artifactReceipts,
    candidateReceipt,
    multipartCleanupRequired,
    publicationAuthorized: false,
  };
}
