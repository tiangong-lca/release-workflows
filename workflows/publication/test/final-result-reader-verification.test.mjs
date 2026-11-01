import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createFinalResultProbeVerifier } from "../lib/final-result-reader-verification.mjs";
import { inspectFinalResultStorage } from "../lib/final-result-storage.mjs";
import { fixture as storageFixture } from "./fixtures/final-storage.mjs";
import {
  candidate,
  worker,
  probeFor,
  id,
  sha,
} from "./fixtures/final-reader.mjs";

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
