import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fail, hashJson, sha256Bytes } from "./common.mjs";
import {
  assertExactObject,
  containedPath,
  readJson,
  verifyBytes,
  verifyJsonHash,
  writeCanonical,
  writeImmutableDirectory,
} from "./io.mjs";

const execFileAsync = promisify(execFile);
const HASH = /^[0-9a-f]{64}$/u;
const TABLES = Object.freeze({
  contact: "contacts",
  source: "sources",
  unitgroup: "unitgroups",
  flowproperty: "flowproperties",
  flow: "flows",
  process: "processes",
  lifecyclemodel: "lifecyclemodels",
});

export async function materializePublicationPayload({
  candidateDir,
  planDir,
  outDir,
  unzipBin = "unzip",
}) {
  const candidateRoot = path.resolve(candidateDir);
  const planningRoot = path.resolve(planDir);
  const target = path.resolve(outDir);
  const { value: candidate } = await readJson(
    path.join(candidateRoot, "release-candidate.json"),
    "release_candidate_missing",
  );
  const { value: draftPlan } = await readJson(
    path.join(planningRoot, "publication-draft-plan.json"),
    "publication_draft_plan_missing",
  );
  const { value: resolution } = await readJson(
    path.join(planningRoot, "publication-scope-resolution.json"),
    "publication_scope_resolution_missing",
  );
  const catalogPath = path.join(candidateRoot, "publication-catalog.json");
  const catalogBytes = await readFile(catalogPath).catch(() => null);
  if (!catalogBytes)
    fail(
      "candidate_publication_catalog_missing",
      `Unable to read required Publication artifact: ${catalogPath}`,
    );
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  requireDraftBindings({ candidate, draftPlan, resolution, catalogBytes });
  await requireCanonicalIndexBinding({ candidateRoot, candidate, catalog });

  const tidasPackages = (candidate.packages ?? [])
    .filter((artifact) => artifact.path.endsWith(".tidas.zip"))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (tidasPackages.length !== 2)
    fail(
      "candidate_tidas_package_set_invalid",
      `Expected exactly two Candidate TIDAS packages, received ${tidasPackages.length}`,
    );
  const archives = [];
  for (const artifact of tidasPackages) {
    const archive = containedPath(candidateRoot, artifact.path);
    const bytes = await readFile(archive);
    const info = await stat(archive);
    if (info.size !== artifact.byteSize)
      fail(
        "candidate_package_size_mismatch",
        `Candidate package size has drifted: ${artifact.path}`,
      );
    verifyBytes(
      bytes,
      artifact.sha256,
      "candidate_package_hash_mismatch",
      artifact.path,
    );
    archives.push({
      artifact,
      archive,
      members: await listMembers(unzipBin, archive),
    });
  }

  const catalogByKey = new Map(
    (catalog.datasets ?? []).map((dataset) => [dataset.key, dataset]),
  );
  const selected = [];
  for (const resolved of resolution.effectiveDatasets ?? []) {
    const source = catalogByKey.get(resolved.key);
    if (!source)
      fail(
        "publication_payload_catalog_mismatch",
        `Resolved dataset is absent from the Candidate catalog: ${resolved.key}`,
      );
    const containing = archives.filter(({ members }) =>
      members.has(source.path),
    );
    if (containing.length === 0)
      fail(
        "publication_payload_member_missing",
        `Selected dataset is absent from both Candidate TIDAS packages: ${source.path}`,
      );
    const copies = [];
    for (const entry of containing) {
      const bytes = await extractMember(unzipBin, entry.archive, source.path);
      verifyBytes(
        bytes,
        source.sha256,
        "publication_payload_member_hash_mismatch",
        `${entry.artifact.path}:${source.path}`,
      );
      let document;
      try {
        document = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail(
          "publication_payload_member_json_invalid",
          `Selected TIDAS member is not JSON: ${source.path}`,
        );
      }
      if (hashJson(document) !== source.canonicalContentHash)
        fail(
          "publication_payload_content_hash_mismatch",
          `Selected dataset canonical content hash differs from the Candidate catalog: ${source.key}`,
        );
      copies.push({ entry, bytes, document });
    }
    if (new Set(copies.map(({ bytes }) => sha256Bytes(bytes))).size !== 1)
      fail(
        "publication_payload_duplicate_mismatch",
        `Candidate TIDAS packages disagree about selected dataset bytes: ${source.key}`,
      );
    const chosen = copies[0];
    selected.push({
      ...source,
      table: tableFor(source.datasetType),
      payloadPath: `datasets/${source.path}`,
      sourcePackage: {
        path: chosen.entry.artifact.path,
        sha256: chosen.entry.artifact.sha256,
      },
      bytes: chosen.bytes,
    });
  }
  selected.sort((left, right) => left.key.localeCompare(right.key));
  const modelByResultProcess = new Map();
  for (const dataset of selected)
    if (dataset.datasetType === "lifecyclemodel")
      for (const reference of dataset.references ?? []) {
        const targetDataset = selected.find(({ key }) => key === reference);
        if (targetDataset?.role === "result_process") {
          const prior = modelByResultProcess.get(targetDataset.key);
          if (prior && prior !== dataset.uuid)
            fail(
              "publication_payload_process_model_ambiguous",
              `Result Process belongs to multiple selected LifeCycleModels: ${targetDataset.key}`,
            );
          modelByResultProcess.set(targetDataset.key, dataset.uuid);
        }
      }
  const datasets = selected.map(({ bytes, ...dataset }) => ({
    ...dataset,
    modelId: modelByResultProcess.get(dataset.key) ?? null,
  }));
  const manifest = {
    schemaVersion: "tiangong.release.publication-payload-manifest.v1",
    candidate: {
      releaseCandidateSha256: hashJson(candidate),
      packageSetHash: candidate.packageSetHash,
    },
    publicationDraftPlanSha256: hashJson(draftPlan),
    scopeResolutionSha256: hashJson(resolution),
    datasetCount: datasets.length,
    datasetSetHash: hashJson(
      datasets.map(({ key, sha256, canonicalContentHash }) => ({
        key,
        sha256,
        canonicalContentHash,
      })),
    ),
    datasets,
  };

  await writeImmutableDirectory(target, async (staging) => {
    for (const dataset of selected) {
      const output = containedPath(staging, dataset.payloadPath);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, dataset.bytes, { flag: "wx" });
    }
    await writeCanonical(
      path.join(staging, "publication-payload-manifest.json"),
      manifest,
    );
  });
  return {
    path: target,
    manifest,
    manifestSha256: hashJson(manifest),
  };
}

export async function loadVerifiedPayload(
  payloadDir,
  expectedManifestHash = null,
) {
  const root = path.resolve(payloadDir);
  const { value: manifest } = await readJson(
    path.join(root, "publication-payload-manifest.json"),
    "publication_payload_manifest_missing",
  );
  if (
    manifest.schemaVersion !==
    "tiangong.release.publication-payload-manifest.v1"
  )
    fail(
      "publication_payload_manifest_unsupported",
      "Unsupported Publication payload manifest schema",
    );
  assertExactObject(
    manifest,
    [
      "schemaVersion",
      "candidate",
      "publicationDraftPlanSha256",
      "scopeResolutionSha256",
      "datasetCount",
      "datasetSetHash",
      "datasets",
    ],
    "publication_payload_manifest_invalid",
    "Publication payload manifest",
  );
  if (expectedManifestHash)
    verifyJsonHash(
      manifest,
      expectedManifestHash,
      "publication_payload_manifest_hash_mismatch",
      "Publication payload manifest",
    );
  const datasets = [];
  for (const entry of manifest.datasets ?? []) {
    assertExactObject(
      entry,
      [
        "key",
        "datasetType",
        "role",
        "uuid",
        "version",
        "path",
        "sha256",
        "canonicalContentHash",
        "references",
        "components",
        "table",
        "payloadPath",
        "sourcePackage",
        "modelId",
      ],
      "publication_payload_dataset_invalid",
      "Publication payload dataset",
    );
    const file = containedPath(root, entry.payloadPath);
    const bytes = await readFile(file);
    verifyBytes(
      bytes,
      entry.sha256,
      "publication_payload_dataset_hash_mismatch",
      entry.key,
    );
    let document;
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(
        "publication_payload_dataset_json_invalid",
        `Publication payload dataset is not JSON: ${entry.key}`,
      );
    }
    if (hashJson(document) !== entry.canonicalContentHash)
      fail(
        "publication_payload_dataset_content_hash_mismatch",
        `Publication payload canonical content hash differs: ${entry.key}`,
      );
    datasets.push({ ...entry, document });
  }
  if (datasets.length !== manifest.datasetCount)
    fail(
      "publication_payload_dataset_count_mismatch",
      "Publication payload dataset count differs from its manifest",
    );
  return { root, manifest, datasets, manifestSha256: hashJson(manifest) };
}

function requireDraftBindings({
  candidate,
  draftPlan,
  resolution,
  catalogBytes,
}) {
  if (
    draftPlan.schemaVersion !== "tiangong.release.publication-draft-plan.v1" ||
    draftPlan.status !== "prepared_unapproved" ||
    draftPlan.publicationAuthorized !== false
  )
    fail(
      "publication_draft_plan_unsupported",
      "Payload materialization requires an unapproved Publication Draft Plan",
    );
  verifyJsonHash(
    candidate,
    draftPlan.candidate?.releaseCandidateSha256,
    "publication_candidate_binding_mismatch",
    "Release Candidate",
  );
  verifyJsonHash(
    resolution,
    draftPlan.scope?.resolutionSha256,
    "publication_scope_resolution_hash_mismatch",
    "Publication scope resolution",
  );
  verifyBytes(
    catalogBytes,
    draftPlan.candidate?.publicationCatalogSha256,
    "publication_catalog_hash_mismatch",
    "Candidate Publication catalog",
  );
  if (
    !HASH.test(candidate.packageSetHash ?? "") ||
    candidate.packageSetHash !== draftPlan.candidate?.packageSetHash ||
    resolution.effectiveSetHash !== draftPlan.scope?.effectiveSetHash
  )
    fail(
      "publication_draft_binding_mismatch",
      "Publication Draft Plan bindings do not match Candidate scope evidence",
    );
}

/**
 * Bind the Publication catalog to the Candidate's own canonical dataset index.
 *
 * The catalog is owned by Release Candidate and carries the exact
 * `canonicalContentHash` that the 120 write attests. Recomputing those hashes
 * from the canonical dataset files here means the attested content is anchored
 * to the frozen Candidate bytes, not to the catalog's own claim about them.
 */
async function requireCanonicalIndexBinding({
  candidateRoot,
  candidate,
  catalog,
}) {
  const indexPath = path.join(candidateRoot, "canonical-dataset-index.json");
  const index = await readJson(indexPath, "candidate_dataset_index_missing");
  verifyJsonHash(
    index.value,
    candidate.canonicalDatasetIndexSha256,
    "candidate_dataset_index_hash_mismatch",
    "Candidate canonical dataset index",
  );
  // The Candidate freezes the index as canonical JSON, so the binding is over
  // the canonical content hash rather than the on-disk byte layout.
  const indexDocument = index.value;
  if (
    catalog.canonicalDatasetIndexSha256 !==
    candidate.canonicalDatasetIndexSha256
  )
    fail(
      "candidate_publication_catalog_index_mismatch",
      "Publication catalog is not bound to this Candidate canonical dataset index",
    );
  const indexByKey = new Map();
  for (const entry of indexDocument.datasets ?? []) {
    const key = `${entry.datasetType}:${String(entry.uuid).toLowerCase()}@${entry.version}`;
    if (indexByKey.has(key))
      fail(
        "candidate_dataset_index_identity_duplicate",
        `Candidate canonical dataset index repeats an identity: ${key}`,
      );
    indexByKey.set(key, entry);
  }
  if (indexByKey.size !== catalog.datasetCount)
    fail(
      "candidate_publication_catalog_index_mismatch",
      "Publication catalog dataset count differs from the canonical dataset index",
      { catalogCount: catalog.datasetCount, indexCount: indexByKey.size },
    );
  const canonicalRoot = path.join(candidateRoot, "canonical");
  for (const dataset of catalog.datasets ?? []) {
    const entry = indexByKey.get(dataset.key);
    if (
      !entry ||
      entry.role !== dataset.role ||
      entry.path !== dataset.path ||
      entry.sha256 !== dataset.sha256
    )
      fail(
        "candidate_publication_catalog_index_mismatch",
        `Publication catalog entry does not match the canonical dataset index: ${dataset.key}`,
      );
    const file = containedPath(canonicalRoot, entry.path);
    const bytes = await readFile(file).catch(() => null);
    if (!bytes)
      fail(
        "candidate_canonical_dataset_missing",
        `Candidate canonical dataset is missing: ${entry.path}`,
      );
    verifyBytes(
      bytes,
      entry.sha256,
      "candidate_canonical_dataset_hash_mismatch",
      entry.path,
    );
    let document;
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(
        "candidate_canonical_dataset_json_invalid",
        `Candidate canonical dataset is not JSON: ${entry.path}`,
      );
    }
    if (hashJson(document) !== dataset.canonicalContentHash)
      fail(
        "candidate_canonical_content_hash_mismatch",
        `Attested canonical content hash does not match the frozen Candidate bytes: ${dataset.key}`,
        { attested: dataset.canonicalContentHash },
      );
  }
}

function tableFor(datasetType) {
  const table = TABLES[String(datasetType).toLowerCase()];
  if (!table)
    fail(
      "publication_dataset_type_unsupported",
      `Unsupported Publication dataset type: ${datasetType}`,
    );
  return table;
}

async function listMembers(unzipBin, archive) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(unzipBin, ["-Z1", archive], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    }));
  } catch (error) {
    fail(
      "publication_archive_read_failed",
      `Cannot list TIDAS archive: ${archive}`,
      {
        cause: error?.code ?? error?.message ?? "unknown",
      },
    );
  }
  const members = stdout.split(/\r?\n/u).filter(Boolean);
  if (
    members.length === 0 ||
    members.some(
      (member) =>
        member.startsWith("/") ||
        member.split(/[\\/]/u).some((part) => part === ".."),
    )
  )
    fail(
      "publication_archive_members_invalid",
      `TIDAS archive has no safe members: ${archive}`,
    );
  return new Set(members);
}

async function extractMember(unzipBin, archive, member) {
  try {
    const { stdout } = await execFileAsync(unzipBin, ["-p", archive, member], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    fail(
      "publication_archive_member_read_failed",
      `Cannot read selected TIDAS member: ${member}`,
      { archive, cause: error?.code ?? error?.message ?? "unknown" },
    );
  }
}
