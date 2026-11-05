import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { setup } from "../../release-candidate/test/fixtures/final-input.mjs";
import {
  inspectFinalResultInput,
  prepareFinalResultInput,
} from "../../release-candidate/lib/final-result-input.mjs";
import { buildFinalResultCandidate } from "../../release-candidate/lib/final-result-candidate.mjs";
import { fixture } from "./fixtures/final-storage.mjs";
import {
  finalResultDatabaseTargetHash,
  createFinalResultRegistry,
} from "../adapters/final-result-registry.mjs";
import {
  finalResultRowBindings,
  finalResultRowBatches,
  inspectFinalResultStorage,
  executeFinalResultStorage,
} from "../lib/final-result-storage.mjs";
const golden = JSON.parse(
  await readFile(
    new URL("./fixtures/final-query-wire-v2.json", import.meta.url),
  ),
);

test("wire root matches the independent Database fixture and normalizes source order", () => {
  assert.equal(finalResultRowBindings(golden.rows), golden.rowBindingsSha256);
  const shuffled = structuredClone(golden.rows);
  shuffled[1].sources.reverse();
  assert.equal(finalResultRowBindings(shuffled), golden.rowBindingsSha256);
  for (const mutate of [
    (r) => r.reverse(),
    (r) => r[0].ordinal++,
    (r) => r[1].sources.push(r[1].sources[0]),
    (r) => r[0].sources.push(r[1].sources[1]),
  ]) {
    const bad = structuredClone(golden.rows);
    mutate(bad);
    assert.throws(() => finalResultRowBindings(bad), {
      code: "final_storage_binding_invalid",
    });
  }
});

test("501-row root agrees with independent Python block-boundary golden", () => {
  const rows = Array.from(
    { length: golden.multiBlock.rowCount },
    (_, ordinal) => ({
      ...golden.rows[0],
      ordinal,
      uuid:
        golden.rows[0].uuid.slice(0, 24) +
        String(golden.multiBlock.resultStart + ordinal).padStart(12, "0"),
    }),
  );
  assert.equal(
    finalResultRowBindings(rows),
    golden.multiBlock.rowBindingsSha256,
  );
});

test("row batches respect both 500 rows and JSONB logical 1 MiB budget", () => {
  const rows = Array.from({ length: 501 }, () =>
    structuredClone(golden.rows[1]),
  );
  assert.deepEqual(
    [...finalResultRowBatches(rows)].map((b) => b.length),
    [500, 1],
  );
  for (const row of rows.slice(0, 6))
    row.sources = Array.from({ length: 4096 }, () => golden.rows[0].sources[0]);
  const batches = [...finalResultRowBatches(rows.slice(0, 6))];
  assert.ok(batches.length > 1);
  for (const batch of batches)
    assert.ok(
      Buffer.byteLength(
        JSON.stringify(batch).replaceAll('":', '": ').replaceAll(",", ", "),
      ) <=
        1024 ** 2,
    );
});

test("database target distinguishes tenants and database while excluding password rotations", () => {
  const first = finalResultDatabaseTargetHash(
    "postgresql://postgres.tenant:secret@db.example:5432/postgres?sslmode=require",
  );
  assert.equal(
    first,
    finalResultDatabaseTargetHash(
      "postgres://postgres.tenant:rotated@db.example/postgres?sslmode=require",
    ),
  );
  assert.notEqual(
    first,
    finalResultDatabaseTargetHash(
      "postgres://postgres.other:secret@db.example/postgres",
    ),
  );
  assert.notEqual(
    first,
    finalResultDatabaseTargetHash(
      "postgres://postgres.tenant:secret@db.example/other",
    ),
  );
  for (const query of [
    "host=other.example",
    "user=other",
    "dbname=other",
    "options=anything",
  ])
    assert.throws(
      () =>
        finalResultDatabaseTargetHash(
          `postgres://postgres:secret@db.example/postgres?${query}`,
        ),
      { code: "final_storage_connection_invalid" },
    );
});

test("registry keeps one-client parameterized transactions and sanitizes uncertain commits", async () => {
  const calls = [];
  let commits = 0;
  class Pool {
    on() {}
    async connect() {
      return {
        query: async (sql, parameters) => {
          calls.push([sql, parameters]);
          if (sql === "commit" && ++commits === 2)
            throw Object.assign(
              new Error("credential-private-provider-error"),
              { code: "08006" },
            );
          return {
            rows: [
              {
                result: {
                  ok: true,
                  data: sql.includes("register_v2") ? {} : null,
                },
              },
            ],
          };
        },
        release: () => calls.push(["release"]),
      };
    }
    async end() {}
  }
  const registry = createFinalResultRegistry({
    connectionString: "postgres://user:password@localhost/db",
    Pool,
  });
  await registry.describeCandidate("a".repeat(64), "b".repeat(64));
  assert.equal(calls[0][0], "begin read only");
  assert.equal(calls[1][0], "set local role service_role");
  assert.deepEqual(calls[3][1], ["a".repeat(64), "b".repeat(64)]);
  await assert.rejects(
    registry.registerCandidate("candidate", "catalog", {}),
    (e) =>
      e.code === "final_storage_registry_outcome_unknown" &&
      !e.message.includes("credential"),
  );
  assert.deepEqual(
    calls.slice(-2).map((c) => c[0]),
    ["rollback", "release"],
  );
  await registry.close();
});

test(
  "actual Candidate/HDF5/ZIP to SDK loopback storage and isolated PostgreSQL registration",
  {
    skip:
      !process.env.RELEASE_STORAGE_TEST_CONN ||
      !process.env.RELEASE_PAIR_TIDAS_BIN,
  },
  async (t) => {
    const connectionString = process.env.RELEASE_STORAGE_TEST_CONN;
    const url = new URL(connectionString);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "65422");
    assert.equal(url.pathname, "/postgres");
    assert.equal(url.username, "postgres");
    assert.equal(url.search, "");
    const owner = new pg.Client({ connectionString });
    await owner.connect();
    t.after(() => owner.end());
    const before = (
      await owner.query(
        "select count(*)::int n from private.lca_release_publications",
      )
    ).rows[0].n;
    const input = await setup(t),
      inputPlan = await inspectFinalResultInput(input);
    await prepareFinalResultInput({
      ...input,
      confirmInputHash: inputPlan.inputHash,
    });
    const candidate = await buildFinalResultCandidate({
      finalInputDir: input.outDir,
      confirmInputHash: inputPlan.inputHash,
      outDir: path.join(input.root, "candidate"),
      releaseVersion: "2026.11.0",
      tidasBin: process.env.RELEASE_PAIR_TIDAS_BIN,
      encoder: fileURLToPath(
        new URL(
          "../../release-candidate/native/target/debug/release-result-hdf5",
          import.meta.url,
        ),
      ),
    });
    const registry = createFinalResultRegistry({ connectionString });
    t.after(() => registry.close());
    const s3 = await fixture(t, {
      mode: "lost-ack",
      databaseTargetHash: registry.databaseTargetHash,
    });
    const args = {
      candidateDir: candidate.path,
      objectStore: s3.store,
      registry,
    };
    const inspected = await inspectFinalResultStorage({
      candidateDir: candidate.path,
      targetHash: s3.store.targetHash,
    });
    assert.equal(inspected.plan.artifacts.length, 2);
    assert.equal(inspected.plan.resultCount, 3);
    await assert.rejects(
      executeFinalResultStorage({ ...args, confirmPlanHash: "0".repeat(64) }),
      { code: "final_storage_confirmation_mismatch" },
    );
    assert.equal(s3.requests.length, 0);
    // Simulate lost database ACK after actual COMMIT, without changing requests.
    const uncertain = {
      ...registry,
      sealQuery: async (...parameters) => {
        await registry.sealQuery(...parameters);
        throw Object.assign(new Error("synthetic lost ACK"), {
          code: "final_storage_registry_outcome_unknown",
        });
      },
      registerCandidate: async (...parameters) => {
        await registry.registerCandidate(...parameters);
        throw Object.assign(new Error("synthetic lost ACK"), {
          code: "final_storage_registry_outcome_unknown",
        });
      },
    };
    const receipt = await executeFinalResultStorage({
      ...args,
      registry: uncertain,
      confirmPlanHash: inspected.planHash,
    });
    assert.equal(receipt.publicationAuthorized, false);
    assert.equal(receipt.artifactReceipts.length, 2);
    const mutations = s3.requests.filter((r) => r.method !== "GET").length;
    assert.deepEqual(
      await executeFinalResultStorage({
        ...args,
        confirmPlanHash: inspected.planHash,
      }),
      receipt,
    );
    assert.equal(
      s3.requests.filter((r) => r.method !== "GET").length,
      mutations,
      "retry re-reads exact remote bytes without writing objects",
    );
    assert.equal(
      (
        await registry.describeCandidate(
          receipt.candidateHash,
          receipt.targetHash,
        )
      ).resultCount,
      3,
    );
    assert.equal(
      (
        await owner.query(
          "select count(*)::int n from private.lca_release_publications",
        )
      ).rows[0].n,
      before,
    );
    // Exercise the real CLI (no injected transports) against the same exact
    // synthetic endpoint. stdout remains bounded and no secret is persisted.
    const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
    const cliEnv = {
      ...process.env,
      CONN: connectionString,
      S3_ENDPOINT: s3.endpoint,
      S3_REGION: "us-east-1",
      S3_BUCKET: "synthetic-results",
      S3_PREFIX: "test-owned",
      S3_ACCESS_KEY_ID: "synthetic-access",
      S3_SECRET_ACCESS_KEY: "synthetic-secret",
    };
    const inspectRun = await exec(
      process.execPath,
      [
        cli,
        "result-storage",
        "inspect",
        "--candidate",
        candidate.path,
        "--out-dir",
        path.join(input.root, "cli-storage-plan"),
        "--json",
      ],
      { cwd: tmpdir(), env: cliEnv },
    );
    const cliPlan = JSON.parse(inspectRun.stdout);
    assert.equal(cliPlan.storagePlanHash, inspected.planHash);
    const executeRun = await exec(
      process.execPath,
      cliPlan.nextActions[0].argv.slice(1),
      { cwd: tmpdir(), env: cliEnv },
    );
    const cliResult = JSON.parse(executeRun.stdout);
    assert.equal(cliResult.outcome, "final_result_storage_verified");
    assert.equal(cliResult.publicationAuthorized, false);
    assert.deepEqual(
      JSON.parse(await readFile(cliResult.artifacts.storageReceipt, "utf8")),
      receipt,
    );
    assert.equal(
      s3.requests.filter((r) => r.method !== "GET").length,
      mutations,
    );
    assert.doesNotMatch(
      inspectRun.stdout + executeRun.stdout,
      /synthetic-secret|postgresql:|127\.0\.0\.1/,
    );
    assert.equal(cliResult.replyTemplate.id, "final-result-storage");
    // Corrupt one contained file: even a stored DB seal cannot bypass full GET.
    const key = [...s3.objects.keys()].find((k) => k.endsWith("/lci.h5"));
    s3.objects.set(key, Buffer.alloc(s3.objects.get(key).length, 9));
    await assert.rejects(
      executeFinalResultStorage({
        ...args,
        confirmPlanHash: inspected.planHash,
      }),
      { code: "final_storage_content_conflict" },
    );
    try {
      await exec(
        process.execPath,
        [
          cli,
          "result-storage",
          "execute",
          "--candidate",
          candidate.path,
          "--confirm",
          inspected.planHash,
          "--out-dir",
          path.join(input.root, "cli-storage-failed"),
          "--json",
        ],
        { cwd: tmpdir(), env: cliEnv },
      );
      assert.fail("corrupt storage must fail the real CLI");
    } catch (error) {
      const failure = JSON.parse(error.stderr);
      assert.equal(failure.error.code, "final_storage_content_conflict");
      assert.equal(failure.error.details.attemptRetained, true);
      assert.ok(failure.nextActions[0].argv.includes(inspected.planHash));
      assert.ok(
        failure.nextActions[0].argv.includes(
          path.join(input.root, "cli-storage-failed-retry"),
        ),
      );
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(input.root, "cli-storage-failed/storage-failure.json"),
            "utf8",
          ),
        ).publicationAuthorized,
        false,
      );
      assert.doesNotMatch(
        error.stderr,
        /synthetic-secret|postgresql:|127\.0\.0\.1/,
      );
      assert.equal(error.stdout, "");
    }
  },
);
