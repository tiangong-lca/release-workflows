import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  setup,
  registry,
} from "../../../release-candidate/test/fixtures/final-input.mjs";
import {
  inspectFinalResultInput,
  prepareFinalResultInput,
} from "../../../release-candidate/lib/final-result-input.mjs";
import {
  buildFinalResultCandidate,
  loadFinalResultCandidate,
} from "../../../release-candidate/lib/final-result-candidate.mjs";
import { canonicalDatasetIndex } from "../../../result-materialization/lib/canonical-index.mjs";
import { canonicalJson, hashJson } from "../../lib/common.mjs";
import { createFinalResultReader } from "../../adapters/final-result-reader.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = (n) => `87940000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const encoder = fileURLToPath(
  new URL(
    "../../../release-candidate/native/target/debug/release-result-hdf5",
    import.meta.url,
  ),
);
async function candidate(
  t,
  { createAuthority = registry().createAuthority } = {},
) {
  const input = await setup(t);
  // Author a second signed inventory exchange BEFORE freezing. This synthetic
  // Result forces real cursor continuation without modifying a frozen artifact.
  const entry = input.index.datasets.find((e) =>
    e.uuid.endsWith("000000000098"),
  );
  const file = path.join(input.canonicalRoot, entry.path);
  const document = JSON.parse(await readFile(file));
  const extra = structuredClone(document.processDataSet.exchanges.exchange[1]);
  extra["@dataSetInternalID"] = "3";
  extra.exchangeDirection = "Input";
  extra.meanAmount = "4.25";
  extra.resultingAmount = "4.25";
  document.processDataSet.exchanges.exchange.push(extra);
  const bytes = Buffer.from(canonicalJson(document));
  await writeFile(file, bytes);
  Object.assign(entry, {
    byteSize: bytes.length,
    sha256: sha(bytes),
    canonicalContentHash: hashJson(document),
  });
  input.index = canonicalDatasetIndex(input.index.datasets);
  const evidence = input.materializationEvidence;
  for (const row of evidence.index.datasets)
    if (row.uuid === entry.uuid) Object.assign(row, entry);
  evidence.manifest.inputs.resultCatalogSha256 = hashJson(evidence.catalog);
  evidence.manifest.inputs.canonicalDatasetIndexSha256 = hashJson(
    evidence.index,
  );
  const inspected = await inspectFinalResultInput(input);
  await prepareFinalResultInput({
    ...input,
    confirmInputHash: inspected.inputHash,
    createAuthority,
  });
  const built = await buildFinalResultCandidate({
    finalInputDir: input.outDir,
    confirmInputHash: inspected.inputHash,
    outDir: path.join(input.root, "candidate"),
    releaseVersion: "2026.11.0",
    encoder,
    tidasBin: process.env.RELEASE_PAIR_TIDAS_BIN,
  });
  return {
    input,
    loaded: await loadFinalResultCandidate(built.path),
    candidateDir: built.path,
  };
}
function probeFor(
  f,
  row,
  readerSha256 = "b".repeat(64),
  targetHash = "d".repeat(64),
) {
  const a = f.loaded.candidate.queryArtifacts.find(
    (a) => a.artifactId === row.artifactId,
  );
  return {
    releaseRunId: id(1),
    publishPlanHash: "a".repeat(64),
    candidateHash: f.candidateHash,
    targetHash,
    selectionHash: "c".repeat(64),
    selectionCount: 3,
    runtimeRevision: id(2),
    readerSha256,
    actorId: id(3),
    permissionHash: "e".repeat(64),
    scope: {
      kind: "readiness",
      releaseRunId: id(1),
      selectionHash: "c".repeat(64),
    },
    publicationAuthorized: false,
    artifact: {
      schemaVersion: a.schemaVersion,
      artifactId: a.artifactId,
      manifestSha256: a.manifestSha256,
      manifestByteSize: a.manifestByteSize,
    },
    result: { uuid: row.uuid, version: row.version },
    contentHash: row.contentHash,
    lciAvailable: true,
    lciaAvailable: row.layer === "lci-lcia",
  };
}

async function worker(t, f, store) {
  const binary = path.resolve(process.env.RELEASE_QUERY_WORKER_BIN);
  const readerSha256 = sha(await readFile(binary));
  const reserve = createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const cache = path.join(f.input.root, "owned-query-cache");
  await mkdir(cache);
  const secret = "synthetic-final-reader-service-secret-32-bytes";
  const child = spawn(binary, [], {
    env: {
      PATH: process.env.PATH,
      RESULT_QUERY_BIND: `127.0.0.1:${port}`,
      RESULT_QUERY_CACHE_DIR: cache,
      RESULT_QUERY_SERVICE_SECRET: secret,
      S3_ENDPOINT: store.endpoint,
      S3_REGION: "us-east-1",
      S3_BUCKET: "synthetic-results",
      S3_PREFIX: "test-owned",
      S3_ACCESS_KEY_ID: "synthetic-access",
      S3_SECRET_ACCESS_KEY: "synthetic-secret",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let error = "",
    ended = false;
  child.stderr.on("data", (bytes) => {
    error = (error + bytes.toString()).slice(-4096);
  });
  child.on("error", (e) => {
    error = e.message;
    ended = true;
  });
  child.on("exit", () => {
    ended = true;
  });
  t.after(async () => {
    if (!ended) {
      const done = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGINT");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await done;
      clearTimeout(timer);
    }
  });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 100; n++) {
    if (ended) assert.fail(`Synthetic Worker exited: ${error}`);
    try {
      if (
        (
          await fetch(`${endpoint}/health`, {
            signal: AbortSignal.timeout(100),
          })
        ).ok
      )
        return {
          endpoint,
          secret,
          readerSha256,
          reader: createFinalResultReader({
            endpoint,
            secret,
            preparingMs: 30000,
          }),
        };
    } catch {}
    await delay(50);
  }
  assert.fail("Synthetic Worker did not start within five seconds");
}

export { candidate, worker, probeFor, id, sha };
