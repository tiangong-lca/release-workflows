import test from "node:test";
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
} from "../../release-candidate/test/fixtures/final-input.mjs";
import {
  inspectFinalResultInput,
  prepareFinalResultInput,
} from "../../release-candidate/lib/final-result-input.mjs";
import {
  buildFinalResultCandidate,
  loadFinalResultCandidate,
} from "../../release-candidate/lib/final-result-candidate.mjs";
import { canonicalDatasetIndex } from "../../result-materialization/lib/canonical-index.mjs";
import { canonicalJson, hashJson } from "../lib/common.mjs";
import { createFinalResultProbeVerifier } from "../lib/final-result-reader-verification.mjs";
import { createFinalResultReader } from "../adapters/final-result-reader.mjs";
import { inspectFinalResultStorage } from "../lib/final-result-storage.mjs";
import { fixture as storageFixture } from "./fixtures/final-storage.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = (n) => `87940000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const encoder = fileURLToPath(
  new URL(
    "../../release-candidate/native/target/debug/release-result-hdf5",
    import.meta.url,
  ),
);
async function candidate(t) {
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
    createAuthority: registry().createAuthority,
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

test(
  "frozen canonical identity is checked before the first reader call",
  { skip: !process.env.RELEASE_PAIR_TIDAS_BIN },
  async (t) => {
    const f = await candidate(t);
    f.candidateHash = sha(
      await readFile(path.join(f.candidateDir, "release-candidate.json")),
    );
    const verifier = await createFinalResultProbeVerifier({
      candidateDir: f.candidateDir,
      inputDir: f.input.outDir,
      reader: {
        query: () => assert.fail("no request for mismatched identity"),
      },
    });
    const probe = probeFor(f, f.loaded.queryCatalog.results[0]);
    for (const patch of [
      { candidateHash: "f".repeat(64) },
      { contentHash: "f".repeat(64) },
      { publicationAuthorized: true },
      { lciaAvailable: !probe.lciaAvailable },
      { result: { ...probe.result, version: "99.99.999" } },
    ])
      await assert.rejects(
        verifier.verify(
          { ...probe, ...patch },
          { authorize: async () => probe },
        ),
        { code: "final_probe_binding_invalid" },
      );
  },
);

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

test(
  "actual Release HDF5/ZIP and Worker prove signed values, zero capability, pagination and drift rejection",
  {
    skip:
      !process.env.RELEASE_PAIR_TIDAS_BIN ||
      !process.env.RELEASE_QUERY_WORKER_BIN,
  },
  async (t) => {
    const f = await candidate(t);
    const store = await storageFixture(t);
    const inspected = await inspectFinalResultStorage({
      candidateDir: f.candidateDir,
      targetHash: store.store.targetHash,
    });
    f.candidateHash = inspected.plan.candidateHash;
    for (const a of inspected.plan.artifacts) {
      const local = f.loaded.candidate.queryArtifacts.find(
        (v) => v.artifactId === a.artifact.artifactId,
      );
      for (const file of a.files) {
        await store.store.ensureQuery(
          a.artifact,
          file,
          path.join(f.candidateDir, local.path, file.name),
        );
        assert.deepEqual(
          (await store.store.verifyQuery(a.artifact, file)).file,
          file,
        );
      }
    }
    // Verify the complete Candidate/ZIP set too, not just metadata or HDF5 cache.
    for (const file of inspected.plan.files) {
      const local =
        file.name === "publication-catalog.json"
          ? f.loaded.candidate.publicationCatalog.path
          : file.name.startsWith("result.")
            ? f.loaded.candidate.packages.find(
                (p) => file.name === `result.${p.format}.zip`,
              ).path
            : file.name;
      await store.store.ensureCandidate(
        f.candidateHash,
        file,
        path.join(f.candidateDir, local),
      );
      assert.deepEqual(
        (await store.store.verifyCandidate(f.candidateHash, file)).file,
        file,
      );
    }
    const runtime = await worker(t, f, store);
    let mutate = (data) => data;
    const observed = [];
    const reader = {
      query: async (...args) => {
        const data = await runtime.reader.query(...args);
        observed.push({
          query: args[0].query.kind,
          data: structuredClone(data),
        });
        return mutate(data, args[0]);
      },
    };
    const verifier = await createFinalResultProbeVerifier({
      candidateDir: f.candidateDir,
      inputDir: f.input.outDir,
      reader,
    });
    const probes = f.loaded.queryCatalog.results.map((row) =>
      probeFor(f, row, runtime.readerSha256, store.store.targetHash),
    );
    const receipts = [];
    for (const probe of probes) {
      let checks = 0;
      const receipt = await verifier.verify(probe, {
        authorize: async () => {
          checks++;
          return structuredClone(probe);
        },
      });
      assert.ok(checks >= receipt.queryCount + 1);
      assert.equal(receipt.publicationAuthorized, false);
      assert.equal(receipt.readerSha256, runtime.readerSha256);
      assert.match(receipt.observationsSha256, /^[0-9a-f]{64}$/);
      receipts.push(receipt);
    }
    assert.deepEqual(
      receipts
        .map((r) => [r.lciNonzeroCount, r.lciPageCount, r.lciaCount])
        .sort(),
      [
        [0, 1, 1],
        [1, 1, 1],
        [2, 2, 0],
      ].sort(),
    );
    assert.deepEqual(
      observed
        .filter((r) => r.query === "lci")
        .flatMap((r) => r.data.items.map((i) => i.amount))
        .sort((a, b) => a - b),
      [-3, 2.5, 4.25],
    );
    assert.deepEqual(
      observed
        .filter((r) => r.query === "lcia")
        .flatMap((r) => r.data.impacts.map((i) => i[1]))
        .sort((a, b) => a - b),
      [0, 42],
    );
    const multiple = probes.find((p) => !p.lciaAvailable);
    for (const [name, change, code] of [
      [
        "wrong value",
        (d, q) => {
          if (q.query.kind === "lci") d.items[0].amount += 1;
          return d;
        },
        "final_probe_lci_mismatch",
      ],
      [
        "wrong unit",
        (d, q) => {
          if (q.query.kind === "lci") d.items[0].item.unit.name = "wrong";
          return d;
        },
        "final_probe_lci_mismatch",
      ],
      [
        "missing continuation",
        (d, q) => {
          if (q.query.kind === "lci") d.nextCursor = null;
          return d;
        },
        "final_probe_cursor_invalid",
      ],
      [
        "hidden metadata leak",
        (d) => {
          d.result.sources = [];
          return d;
        },
        "final_probe_overview_mismatch",
      ],
    ])
      await t.test(name, async () => {
        mutate = change;
        await assert.rejects(
          verifier.verify(multiple, { authorize: async () => multiple }),
          { code },
        );
      });
    mutate = (data) => data;
    await t.test(
      "live actor or runtime drift invalidates an otherwise correct response",
      async () => {
        let calls = 0;
        await assert.rejects(
          verifier.verify(multiple, {
            authorize: async () =>
              ++calls === 1
                ? multiple
                : { ...multiple, runtimeRevision: id(99) },
          }),
          { code: "final_reader_authorization_changed" },
        );
      },
    );
    await t.test(
      "wrong LCIA is rejected independently of correct LCI",
      async () => {
        const probe = probes.find((p) => p.lciaAvailable);
        mutate = (data, request) => {
          if (request.query.kind === "lcia") data.impacts[0][1] += 1;
          return data;
        };
        await assert.rejects(
          verifier.verify(probe, { authorize: async () => probe }),
          { code: "final_probe_lcia_mismatch" },
        );
        mutate = (data) => data;
      },
    );
    await t.test(
      "authority loss during the final response discards otherwise complete evidence",
      async () => {
        let lastResponse = false;
        mutate = (data, request) => {
          if (request.query.kind === "lci" && data.nextCursor === null)
            lastResponse = true;
          return data;
        };
        await assert.rejects(
          verifier.verify(multiple, {
            authorize: async () => {
              if (lastResponse) throw new Error("private token never logged");
              return multiple;
            },
          }),
          (error) =>
            error.code === "final_probe_authorization_changed" &&
            !String(error).includes("private token"),
        );
        mutate = (data) => data;
      },
    );
    await t.test(
      "admitted binary mismatch cannot be disguised as a successful query",
      async () => {
        const wrong = { ...multiple, readerSha256: "f".repeat(64) };
        await assert.rejects(
          verifier.verify(wrong, { authorize: async () => wrong }),
          { code: "final_reader_response_binding" },
        );
      },
    );
  },
);
