import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { verifyFinalResultReadiness } from "../lib/final-result-readiness.mjs";
import { inspectFinalResultStorage } from "../lib/final-result-storage.mjs";
import { candidate, worker, probeFor, id } from "./fixtures/final-reader.mjs";
import { fixture as storageFixture } from "./fixtures/final-storage.mjs";
const clone = structuredClone;
const contextOf = ({
  artifact,
  result,
  contentHash,
  lciAvailable,
  lciaAvailable,
  ...context
}) => context;
function registryFixture(context, store, events, { lost = false } = {}) {
  let header = null,
    receipt = null;
  const proofs = new Map(),
    calls = [];
  const faults = new Set();
  const maybeLose = (kind) => {
    if (lost && !faults.has(kind)) {
      faults.add(kind);
      throw Object.assign(new Error("synthetic lost ACK"), {
        code: "final_storage_registry_outcome_unknown",
      });
    }
  };
  const registry = {
    databaseTargetHash: store.databaseTargetHash,
    async beginReadiness(value) {
      assert.deepEqual(events.at(-1), { kind: "header", header: value });
      if (header) assert.deepEqual(header, value);
      else header = clone(value);
      calls.push("begin");
      maybeLose("begin");
      return {};
    },
    async stageReadiness(verificationId, values) {
      assert.equal(verificationId, header.verificationId);
      assert.equal(values.length, 1);
      const proof = values[0];
      assert.deepEqual(events.at(-1), {
        kind: "artifact",
        verificationId,
        proof,
      });
      if (proofs.has(proof.artifact.artifactId))
        assert.deepEqual(proofs.get(proof.artifact.artifactId), proof);
      else proofs.set(proof.artifact.artifactId, clone(proof));
      calls.push("stage");
      maybeLose("stage");
      return {};
    },
    async sealReadiness(verificationId) {
      assert.equal(verificationId, header.verificationId);
      if (!receipt) {
        const values = [...proofs.values()];
        receipt = {
          ...context,
          schemaVersion: "tiangong.final-result-readiness.v1",
          verificationId,
          artifactCount: values.length,
          probeCount: values.reduce((n, p) => n + p.probes.length, 0),
          fileCount: 4 + values.reduce((n, p) => n + p.files.length, 0),
          coverageHash: "f".repeat(64),
          sealedAt: new Date().toISOString(),
          expiresAt: new Date(
            Math.min(
              Date.parse(header.startedAt) + 3600000,
              ...values.flatMap((p) =>
                p.probes.map((r) => Date.parse(r.startedAt) + 900000),
              ),
            ),
          ).toISOString(),
        };
      }
      calls.push("seal");
      maybeLose("seal");
      return clone(receipt);
    },
    async describeReadiness() {
      calls.push("describe");
      return header
        ? {
            verificationId: header.verificationId,
            header: clone(header),
            registeredArtifactCount: proofs.size,
            readinessReceipt: clone(receipt),
            publicationAuthorized: false,
          }
        : null;
    },
  };
  return {
    registry,
    calls,
    proofs,
    get receipt() {
      return receipt;
    },
  };
}

test(
  "aggregate readiness verifies actual paired files and Worker before sealing exact evidence",
  {
    skip:
      !process.env.RELEASE_PAIR_TIDAS_BIN ||
      !process.env.RELEASE_QUERY_WORKER_BIN,
  },
  async (t) => {
    const f = await candidate(t),
      storage = await storageFixture(t);
    const { plan } = await inspectFinalResultStorage({
      candidateDir: f.candidateDir,
      targetHash: storage.store.targetHash,
    });
    f.candidateHash = plan.candidateHash;
    for (const a of plan.artifacts) {
      const local = f.loaded.candidate.queryArtifacts.find(
        (v) => v.artifactId === a.artifact.artifactId,
      );
      for (const file of a.files)
        await storage.store.ensureQuery(
          a.artifact,
          file,
          path.join(f.candidateDir, local.path, file.name),
        );
    }
    for (const file of plan.files) {
      const local =
        file.name === "publication-catalog.json"
          ? f.loaded.candidate.publicationCatalog.path
          : file.name.startsWith("result.")
            ? f.loaded.candidate.packages.find(
                (p) => file.name === `result.${p.format}.7z`,
              ).path
            : file.name;
      await storage.store.ensureCandidate(
        plan.candidateHash,
        file,
        path.join(f.candidateDir, local),
      );
    }
    const runtime = await worker(t, f, storage);
    const probes = f.loaded.queryCatalog.results.map((row) =>
      probeFor(f, row, runtime.readerSha256, storage.store.targetHash),
    );
    const context = contextOf(probes[0]);
    const groups = plan.artifacts
      .map((a) => {
        const rows = probes
          .filter((p) => p.artifact.artifactId === a.artifact.artifactId)
          .sort((a, b) =>
            `${a.result.uuid}@${a.result.version}` <
            `${b.result.uuid}@${b.result.version}`
              ? -1
              : 1,
          );
        return {
          artifact: a.artifact,
          selectedResultCount: rows.length,
          probes: [
            rows[0].result,
            ...(rows.length > 1 ? [rows.at(-1).result] : []),
          ],
        };
      })
      .sort((a, b) => (a.artifact.artifactId < b.artifact.artifactId ? -1 : 1));
    function setup(options = {}) {
      const events = [];
      let pageCalls = 0,
        probeCalls = 0;
      const actor = {
        actorId: context.actorId,
        async probePage({ limit }) {
          pageCalls++;
          const selected = groups.slice(0, limit);
          return {
            ...clone(context),
            artifacts: clone(selected),
            nextArtifactCursor:
              selected.length < groups.length
                ? selected.at(-1).artifact.artifactId
                : null,
          };
        },
        async probe({ result }) {
          probeCalls++;
          return clone(
            probes.find(
              (p) =>
                p.result.uuid === result.uuid &&
                p.result.version === result.version,
            ),
          );
        },
      };
      const db = registryFixture(context, storage.store, events, options);
      const input = {
        candidateDir: f.candidateDir,
        inputDir: f.input.outDir,
        releaseRunId: context.releaseRunId,
        publishPlanHash: context.publishPlanHash,
        verificationId: id(50),
        objectStore: storage.store,
        registry: db.registry,
        actor,
        reader: runtime.reader,
        record: async (event) => events.push(clone(event)),
      };
      return {
        input,
        db,
        events,
        get pageCalls() {
          return pageCalls;
        },
        get probeCalls() {
          return probeCalls;
        },
      };
    }
    await t.test(
      "all file GETs precede numeric samples and evidence is durable before database mutation",
      async () => {
        const x = setup();
        const start = storage.requests.length;
        const result = await verifyFinalResultReadiness(x.input);
        assert.equal(result.artifactCount, groups.length);
        assert.equal(result.probeCount, 3);
        assert.equal(result.publicationAuthorized, false);
        assert.equal(x.pageCalls, 2);
        assert.ok(x.probeCalls > 3);
        assert.equal(
          x.events[0].schemaVersion,
          "tiangong.final-result-readiness-local-attempt.v1",
        );
        assert.equal(x.events.at(-1).kind, "sealed");
        assert.deepEqual(
          [...x.db.proofs.values()]
            .flatMap((p) =>
              p.probes.map((r) => [
                r.lciNonzeroCount,
                r.lciPageCount,
                r.lciaCount,
              ]),
            )
            .sort(),
          [
            [0, 1, 1],
            [1, 1, 1],
            [2, 2, 0],
          ].sort(),
        );
        assert.ok(
          storage.requests.slice(start).every((r) => r.method === "GET"),
          "verification never uploads or repairs",
        );
      },
    );
    await t.test(
      "lost begin, proof and seal acknowledgments recover the identical immutable payload",
      async () => {
        const x = setup({ lost: true });
        const receipt = await verifyFinalResultReadiness(x.input);
        assert.equal(receipt.verificationId, id(50));
        assert.equal(x.db.calls.filter((c) => c === "begin").length, 2);
        assert.equal(x.db.calls.filter((c) => c === "seal").length, 2);
        assert.equal(x.db.proofs.size, groups.length);
      },
    );
    await t.test(
      "scope truncation cannot produce partial readiness",
      async () => {
        const x = setup();
        const original = x.input.actor.probePage;
        x.input.actor.probePage = async (args) => {
          const page = await original(args);
          page.artifacts = page.artifacts.slice(0, 1);
          page.nextArtifactCursor = null;
          return page;
        };
        await assert.rejects(verifyFinalResultReadiness(x.input), {
          code: "final_readiness_binding_invalid",
        });
        assert.equal(x.db.calls.length, 0);
        assert.equal(x.events.length, 0);
      },
    );
    await t.test(
      "duplicate artifact cannot masquerade as coverage",
      async () => {
        const x = setup();
        const original = x.input.actor.probePage;
        x.input.actor.probePage = async (args) => {
          const page = await original(args);
          page.artifacts.push(page.artifacts[0]);
          return page;
        };
        await assert.rejects(verifyFinalResultReadiness(x.input), {
          code: "final_readiness_binding_invalid",
        });
        assert.equal(x.db.calls.length, 0);
      },
    );
    await t.test(
      "wrong storage bytes stop before any verifier registration",
      async () => {
        const x = setup();
        x.input.objectStore = {
          ...storage.store,
          verifyCandidate: async (hash, file) => ({
            targetHash: storage.store.targetHash,
            file: { ...file, sha256: "0".repeat(64) },
          }),
        };
        await assert.rejects(verifyFinalResultReadiness(x.input), {
          code: "final_readiness_binding_invalid",
        });
        assert.equal(x.db.calls.length, 0);
      },
    );
    await t.test("independent numerical mismatch prevents seal", async () => {
      const x = setup();
      x.input.reader = {
        query: async (...args) => {
          const data = await runtime.reader.query(...args);
          if (args[0].query.kind === "lcia") data.impacts[0][1] += 1;
          return data;
        },
      };
      await assert.rejects(verifyFinalResultReadiness(x.input), {
        code: "final_probe_lcia_mismatch",
      });
      assert.equal(x.db.receipt, null);
      assert.ok(!x.db.calls.includes("seal"));
    });
    await t.test(
      "live runtime change after successful probes prevents seal",
      async () => {
        const x = setup();
        let n = 0;
        const original = x.input.actor.probePage;
        x.input.actor.probePage = async (args) => ({
          ...(await original(args)),
          ...(++n === 2 ? { runtimeRevision: id(99) } : {}),
        });
        await assert.rejects(verifyFinalResultReadiness(x.input), {
          code: "final_readiness_binding_invalid",
        });
        assert.ok(!x.db.calls.includes("seal"));
      },
    );
    await t.test(
      "durable evidence failure precedes registry mutation",
      async () => {
        const x = setup();
        x.input.record = async () => {
          throw new Error("synthetic disk failure");
        };
        await assert.rejects(
          verifyFinalResultReadiness(x.input),
          /synthetic disk failure/,
        );
        assert.equal(x.db.calls.length, 0);
      },
    );
    await t.test(
      "wrong aggregate receipt cannot be represented as ready",
      async () => {
        const x = setup();
        const original = x.input.registry.describeReadiness;
        x.input.registry.describeReadiness = async () => {
          const data = await original();
          if (data.readinessReceipt) data.readinessReceipt.fileCount--;
          return data;
        };
        await assert.rejects(verifyFinalResultReadiness(x.input), {
          code: "final_readiness_binding_invalid",
        });
        assert.notEqual(x.events.at(-1).kind, "sealed");
      },
    );
  },
);
