import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";

export const DEFAULT_VERSION = "01.00.000";

/**
 * Build one frozen Candidate dataset row plus its exact bytes.
 *
 * `content` may be supplied as raw text. That matters for the live acceptance
 * run: only bytes that are deliberately NOT the canonical serialization can show
 * that the stored-byte hash and the canonical content hash are different values.
 */
export function payloadDataset({
  datasetType,
  table,
  uuid,
  role,
  document,
  version = DEFAULT_VERSION,
  content = null,
  pretty = false,
}) {
  const bytes = Buffer.from(
    content ??
      (pretty
        ? `${JSON.stringify(document, null, 2)}\n`
        : canonicalJson(document)),
    "utf8",
  );
  return {
    key: `${datasetType}:${uuid}@${version}`,
    datasetType,
    table,
    role,
    uuid: String(uuid).toLowerCase(),
    version,
    path: `${table}/${String(uuid).toLowerCase()}_${version}.json`,
    payloadPath: `datasets/${table}/${String(uuid).toLowerCase()}_${version}.json`,
    sha256: sha256Bytes(bytes),
    canonicalContentHash: hashJson(document),
    references: [],
    components: role === "support" ? ["unit_process", "result"] : ["result"],
    sourcePackage: {
      path: "packages/result.tidas.zip",
      sha256: "d".repeat(64),
    },
    modelId: null,
    document,
    bytes,
  };
}

/**
 * A Result Process document that satisfies the reviewed command's envelope
 * validation: `processDataSet` present, `common:UUID` equal to `id`, and
 * `common:dataSetVersion` equal to `version`.
 *
 * `payload` is merged into `processDataSet` so a caller can inject content with
 * significant whitespace or Unicode.
 */
export function resultProcessDocument({ uuid, version, payload = {} }) {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: { "common:UUID": uuid },
      },
      administrativeInformation: {
        publicationAndOwnership: { "common:dataSetVersion": version },
      },
      ...payload,
    },
  };
}

/**
 * Materialize a Candidate + plan + payload directory set for a Result-Process-only
 * plan, from an exact content string chosen by the caller.
 *
 * Shared by the offline suites and by the opt-in live acceptance runner, so the
 * live run exercises the same artifact shapes the unit tests do.
 */
export async function writeResultOnlyFixture({
  root = null,
  uuid,
  version = DEFAULT_VERSION,
  contentText,
  targetId = "tiangong-lca-platform",
  releaseVersion = "2026.08.0",
}) {
  const fixtureRoot =
    root ?? (await mkdtemp(path.join(os.tmpdir(), "publication-live-")));
  const candidateRoot = path.join(fixtureRoot, "candidate");
  const canonicalDir = path.join(candidateRoot, "canonical");
  const planDir = path.join(fixtureRoot, "plan");
  const payloadDir = path.join(fixtureRoot, "payload");

  const document = JSON.parse(contentText);
  const dataset = payloadDataset({
    datasetType: "process",
    table: "processes",
    uuid,
    role: "result_process",
    document,
    version,
    content: contentText,
  });

  await mkdir(planDir, { recursive: true });
  const draftPlan = {
    schemaVersion: "tiangong.release.publication-draft-plan.v1",
    status: "prepared_unapproved",
    publicationAuthorized: false,
    target: { id: targetId },
  };
  await writeFile(
    path.join(planDir, "publication-draft-plan.json"),
    canonicalJson(draftPlan),
  );

  // Project the same field set the real payload materializer emits. A hand-rolled
  // subset silently omits `table`/`payloadPath`/`sourcePackage`/`modelId`, which
  // the strict payload loader requires — and would only fail against a real run.
  const { bytes: _bytes, document: _document, ...entry } = dataset;
  const entries = [{ ...entry, modelId: null }];
  const manifest = {
    schemaVersion: "tiangong.release.publication-payload-manifest.v1",
    candidate: {
      releaseCandidateSha256: "a".repeat(64),
      packageSetHash: "b".repeat(64),
    },
    publicationDraftPlanSha256: hashJson(draftPlan),
    scopeResolutionSha256: "c".repeat(64),
    datasetCount: entries.length,
    datasetSetHash: hashJson(
      entries.map(({ key, sha256, canonicalContentHash }) => ({
        key,
        sha256,
        canonicalContentHash,
      })),
    ),
    datasets: entries,
  };

  const payloadFile = path.join(payloadDir, dataset.payloadPath);
  await mkdir(path.dirname(payloadFile), { recursive: true });
  await writeFile(payloadFile, dataset.bytes);
  const canonicalFile = path.join(canonicalDir, dataset.path);
  await mkdir(path.dirname(canonicalFile), { recursive: true });
  await writeFile(canonicalFile, dataset.bytes);
  await writeFile(
    path.join(payloadDir, "publication-payload-manifest.json"),
    canonicalJson(manifest),
  );

  return {
    root: fixtureRoot,
    candidateRoot,
    canonicalDir,
    planDir,
    payloadDir,
    releaseVersion,
    dataset,
    manifest,
    contentText,
  };
}

/**
 * Content that is valid JSON for the reviewed envelope but is deliberately NOT
 * the canonical serialization: significant indentation, embedded newlines and
 * tabs, plus non-ASCII characters.
 *
 * The stored-byte hash therefore differs from the canonical content hash, which
 * is what makes a byte/canonical conflation observable through a real PostgREST
 * round trip.
 */
export function nonCanonicalResultContent({ uuid, version }) {
  const document = resultProcessDocument({
    uuid,
    version,
    payload: {
      name: {
        "@xml:lang": "zh-CN",
        "#text": "结果过程 · досягнення — テスト",
      },
      "common:generalComment": {
        "@xml:lang": "en",
        "#text": "line one\n\tline two with  multiple   spaces\n non-breaking",
      },
    },
  });
  // Explicitly pretty-printed with tabs, so it is valid JSON but not RFC 8785.
  return { document, contentText: `${JSON.stringify(document, null, "\t")}\n` };
}
