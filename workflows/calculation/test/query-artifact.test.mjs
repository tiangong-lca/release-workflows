import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createQueryArtifactClients,
  inspectQueryArtifact,
  registerQueryArtifact,
  uploadWithWorker,
} from "../adapters/query-artifact-store.mjs";
import { runQueryArtifactCli } from "../query-artifact.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const packageId = "22222222-2222-4222-8222-222222222222";
const releaseRunId = "33333333-3333-4333-8333-333333333333";
const hash = (x) => createHash("sha256").update(x).digest("hex");
async function fixture(t, count = 1) {
  const root = await mkdtemp(path.join(tmpdir(), "query-artifact-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    version: "01.00.000",
    ordinal: i,
  }));
  for (const [name, value] of [
    ["processes.json.gz", rows],
    ["inventory-items.json.gz", []],
    ["lci.h5", null],
  ]) {
    const plain = Buffer.from(JSON.stringify(value));
    const bytes =
      value === null
        ? Buffer.from("synthetic-only-hdf5-delegated-to-worker")
        : gzipSync(plain);
    await writeFile(path.join(root, name), bytes);
    files.push({
      name,
      byteSize: bytes.length,
      sha256: hash(bytes),
      plainByteSize: value === null ? null : plain.length,
    });
  }
  const manifest = {
    schemaVersion: "tiangong.query-artifact.v1",
    artifactId: id,
    source: {
      schemaVersion: "tiangong.calculation-bundle.v2",
      calculationId: id,
      manifestSha256: "a".repeat(64),
      bundleContentHash: "b".repeat(64),
    },
    processCount: count,
    impactCount: 0,
    inventoryCount: 0,
    lciNonzeroCount: 0,
    files,
  };
  const raw = Buffer.from(JSON.stringify(manifest));
  const reference = {
    schemaVersion: manifest.schemaVersion,
    artifactId: id,
    manifestSha256: hash(raw),
    manifestByteSize: raw.length,
  };
  await writeFile(path.join(root, "manifest.json"), raw);
  await writeFile(
    path.join(root, "artifact-ref.json"),
    JSON.stringify(reference),
  );
  return {
    root,
    manifest,
    reference,
    options: {
      directory: root,
      builder: "/reviewed/worker/result_artifact_builder",
      packageId,
      releaseRunId,
      confirmManifest: reference.manifestSha256,
    },
  };
}
function transport(f, overrides = {}) {
  const calls = [];
  let closed = 0;
  let uploaded = 0;
  return {
    calls,
    get closed() {
      return closed;
    },
    get uploaded() {
      return uploaded;
    },
    dependencies: {
      upload: async () => {
        uploaded++;
        return f.reference;
      },
      clients: () => ({
        read: async (key) => {
          calls.push(["read", key]);
          return Readable.from(
            await readFile(path.join(f.root, key.split("/").at(-1))),
          );
        },
        rpc: async (name, args) => {
          calls.push([name, args]);
          return {
            ok: true,
            data: {
              artifactId: id,
              releaseRunId,
              status: "ready",
              registeredProcessCount: f.manifest.processCount,
            },
          };
        },
        close: async () => {
          closed++;
        },
        ...overrides,
      }),
    },
  };
}
test("independent full readback precedes all registration and exact 500-row batches", async (t) => {
  const f = await fixture(t, 501);
  const tx = transport(f);
  const output = await registerQueryArtifact(f.options, tx.dependencies);
  assert.equal(output.status, "registered");
  assert.equal(output.publicationChanged, false);
  assert.equal(tx.uploaded, 1);
  assert.equal(tx.closed, 1);
  assert.deepEqual(
    tx.calls.map((x) => x[0]),
    ["read", "read", "read", "read", "stage", "stage", "seal", "bind"],
  );
  assert.equal(JSON.parse(tx.calls[4][1][3]).length, 500);
  assert.equal(JSON.parse(tx.calls[5][1][3]).length, 1);
  assert.deepEqual(tx.calls.at(-1), ["bind", [releaseRunId, id]]);
  assert.ok(
    tx.calls
      .slice(0, 4)
      .every((x) =>
        x[1].startsWith(`query-artifacts/${id}/${f.reference.manifestSha256}/`),
      ),
  );
  await registerQueryArtifact(f.options, tx.dependencies);
  assert.equal(tx.uploaded, 2); // exact immutable retry repeats verification, never computation
});
test("confirmation mismatch and local corruption fail before upload or registration", async (t) => {
  const f = await fixture(t);
  const tx = transport(f);
  await assert.rejects(
    registerQueryArtifact(
      { ...f.options, confirmManifest: "c".repeat(64) },
      tx.dependencies,
    ),
  );
  await writeFile(path.join(f.root, "lci.h5"), "corrupt");
  await assert.rejects(registerQueryArtifact(f.options, tx.dependencies));
  assert.equal(tx.uploaded, 0);
  assert.equal(tx.calls.length, 0);
});
test("missing file and symlink cannot become verified source evidence", async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.root, "lci.h5"));
  await assert.rejects(inspectQueryArtifact(f.root));
  await symlink(
    path.join(f.root, "manifest.json"),
    path.join(f.root, "lci.h5"),
  );
  await assert.rejects(inspectQueryArtifact(f.root));
});
test("remote byte mismatch closes clients without any database mutation", async (t) => {
  const f = await fixture(t);
  const tx = transport(f, { read: async () => Readable.from("wrong") });
  await assert.rejects(registerQueryArtifact(f.options, tx.dependencies));
  assert.equal(tx.closed, 1);
  assert.equal(tx.calls.length, 0);
});
test("failed or mismatched upload receipt never opens a registration client", async (t) => {
  const f = await fixture(t);
  const tx = transport(f);
  await assert.rejects(
    registerQueryArtifact(f.options, {
      ...tx.dependencies,
      upload: async () => ({ ...f.reference, artifactId: packageId }),
    }),
  );
  assert.equal(tx.calls.length, 0);
});
test("ambiguous stage failure is not retried and cannot seal or bind", async (t) => {
  const f = await fixture(t);
  let mutations = 0;
  const tx = transport(f, {
    rpc: async () => {
      mutations++;
      throw new Error("connection lost after commit");
    },
  });
  await assert.rejects(registerQueryArtifact(f.options, tx.dependencies));
  assert.equal(mutations, 1);
  assert.equal(tx.closed, 1);
});
test("incorrect service response cannot advance registration", async (t) => {
  const f = await fixture(t);
  let count = 0;
  const tx = transport(f, {
    rpc: async () => {
      count++;
      return { ok: true, data: { artifactId: packageId } };
    },
  });
  await assert.rejects(registerQueryArtifact(f.options, tx.dependencies));
  assert.equal(count, 1);
});
test("CLI help is cwd independent and missing intent never performs remote work", async () => {
  const help = await runQueryArtifactCli(["--help"]);
  assert.match(help.usage, /^\//);
  await assert.rejects(
    runQueryArtifactCli(["--artifact-dir", "/tmp/a"], () =>
      assert.fail("called"),
    ),
  );
  await assert.rejects(runQueryArtifactCli(["--unexpected"]));
  const result = await runQueryArtifactCli(
    [
      "--artifact-dir",
      "/tmp/a",
      "--builder",
      "/tmp/worker",
      "--package-id",
      packageId,
      "--release-run-id",
      releaseRunId,
      "--confirm-manifest",
      "a".repeat(64),
    ],
    async (input) => input,
  );
  assert.equal(result.releaseRunId, releaseRunId);
});
test("CLI failure keeps secrets, raw exception details and private locators out of stdout/stderr", () => {
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../query-artifact.mjs", import.meta.url)),
      "--artifact-dir",
      "s3://private-secret",
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 1);
  assert.equal(
    JSON.parse(child.stdout).code,
    "query_artifact_registration_failed",
  );
  assert.doesNotMatch(child.stdout + child.stderr, /private-secret|s3:\/\//);
});
test("public Worker subprocess is argument-bound, bounded and receives no connection string argument", async (t) => {
  const f = await fixture(t);
  const builder = path.join(f.root, "builder");
  await writeFile(
    builder,
    `#!/usr/bin/env node\nif (process.argv[2] !== 'upload' || process.argv[3] !== '--artifact-dir') process.exit(2);\nconsole.log(${JSON.stringify(JSON.stringify(f.reference))});\n`,
    { mode: 0o700 },
  );
  assert.deepEqual(
    await uploadWithWorker({ builder, root: f.root, env: process.env }),
    f.reference,
  );
  await assert.rejects(
    uploadWithWorker({ builder: "relative", root: f.root, env: process.env }),
  );
});

test("controlled clients bind S3 prefix and closed parameterized service-role transactions", async () => {
  const seen = [];
  let released = 0;
  let closed = 0;
  let fail = false;
  const options = {};
  class S3 {
    constructor(value) {
      options.s3 = value;
    }
    async send(command, transport) {
      seen.push(command.input);
      assert.ok(transport.abortSignal);
      return { Body: Readable.from("ok") };
    }
    destroy() {
      closed++;
    }
  }
  class Pool {
    constructor(value) {
      options.pg = value;
    }
    async connect() {
      return {
        query: async (sql, args) => {
          seen.push([sql, args]);
          if (sql.startsWith("select")) {
            if (fail) throw new Error("synthetic");
            return { rows: [{ result: { ok: true } }] };
          }
        },
        release: () => {
          released++;
        },
      };
    }
    async end() {
      closed++;
    }
  }
  const env = {
    S3_PREFIX: "results",
    S3_ENDPOINT: "http://127.0.0.1:9999",
    S3_REGION: "local",
    S3_BUCKET: "synthetic",
    S3_ACCESS_KEY_ID: "synthetic",
    S3_SECRET_ACCESS_KEY: "synthetic",
    CONN: "postgres://synthetic@localhost/test",
  };
  const clients = createQueryArtifactClients(env, { S3, Pool });
  await clients.read("query-artifacts/a/hash/manifest.json");
  assert.deepEqual(seen.shift(), {
    Bucket: "synthetic",
    Key: "results/query-artifacts/a/hash/manifest.json",
  });
  const args = [releaseRunId, id];
  assert.deepEqual(await clients.rpc("bind", args), { ok: true });
  assert.deepEqual(
    seen.map((x) => x[0]),
    [
      "begin",
      "set local role service_role",
      "set local lock_timeout = '5s'",
      "select api.svc_result_query_bind_release($1::uuid,$2::uuid) as result",
      "commit",
    ],
  );
  assert.deepEqual(seen[3][1], args);
  assert.equal(options.pg.statement_timeout, 15000);
  assert.equal(options.pg.max, 1);
  fail = true;
  seen.length = 0;
  await assert.rejects(clients.rpc("seal", [id]));
  assert.equal(seen.at(-1)[0], "rollback");
  assert.equal(released, 2);
  await assert.rejects(clients.rpc("arbitrary", []));
  await clients.close();
  assert.equal(closed, 2);
  assert.throws(() =>
    createQueryArtifactClients({ ...env, S3_PREFIX: "../other" }, { S3, Pool }),
  );
});

test("self-consistent manifest hashes do not authorize unknown formats or escaping paths", async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (m) => {
      m.schemaVersion = "unknown";
    },
    (m) => {
      m.files[0].name = "../outside";
    },
    (m) => {
      m.processCount = 2000001;
    },
    (m) => {
      m.files[0].plainByteSize = 1024 * 1024 * 129;
    },
  ]) {
    const changed = structuredClone(f.manifest);
    mutate(changed);
    const raw = Buffer.from(JSON.stringify(changed));
    await writeFile(path.join(f.root, "manifest.json"), raw);
    await writeFile(
      path.join(f.root, "artifact-ref.json"),
      JSON.stringify({
        ...f.reference,
        manifestSha256: hash(raw),
        manifestByteSize: raw.length,
      }),
    );
    await assert.rejects(inspectQueryArtifact(f.root));
  }
});
