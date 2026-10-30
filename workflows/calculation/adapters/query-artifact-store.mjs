import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const exec = promisify(execFile);
const FORMAT = "tiangong.query-artifact.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/;
const MiB = 1024 * 1024;
function requireValue(condition) {
  if (!condition) throw new Error("query_artifact_invalid");
}
function bounded(value, max, min = 0) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
async function localBytes(root, name, limit) {
  const file = path.join(root, name);
  const metadata = await lstat(file);
  requireValue(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= limit,
  );
  return readFile(file);
}
async function digest(stream, expected) {
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      requireValue(size <= expected.byteSize);
      hash.update(chunk);
    }
    requireValue(
      size === expected.byteSize && hash.digest("hex") === expected.sha256,
    );
  } finally {
    stream.destroy?.();
  }
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function inspectQueryArtifact(directory) {
  const root = path.resolve(directory);
  requireValue(
    (await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink(),
  );
  const reference = JSON.parse(
    await localBytes(root, "artifact-ref.json", MiB),
  );
  requireValue(
    reference.schemaVersion === FORMAT &&
      UUID.test(reference.artifactId) &&
      HASH.test(reference.manifestSha256) &&
      bounded(reference.manifestByteSize, MiB, 1),
  );
  const raw = await localBytes(root, "manifest.json", MiB);
  requireValue(
    raw.length === reference.manifestByteSize &&
      hash(raw) === reference.manifestSha256,
  );
  const manifest = JSON.parse(raw);
  requireValue(
    manifest.schemaVersion === FORMAT &&
      manifest.artifactId === reference.artifactId &&
      manifest.source?.schemaVersion === "tiangong.calculation-bundle.v2" &&
      UUID.test(manifest.source.calculationId) &&
      HASH.test(manifest.source.manifestSha256) &&
      HASH.test(manifest.source.bundleContentHash),
  );
  requireValue(
    bounded(manifest.processCount, 2000000, 1) &&
      bounded(manifest.impactCount, 4096) &&
      bounded(manifest.inventoryCount, 2000000) &&
      bounded(manifest.lciNonzeroCount, Number.MAX_SAFE_INTEGER),
  );
  const names = ["processes.json.gz", "inventory-items.json.gz", "lci.h5"];
  if (manifest.impactCount) names.push("impacts.json.gz", "lcia.h5");
  requireValue(
    Array.isArray(manifest.files) &&
      manifest.files.length === names.length &&
      new Set(manifest.files.map((f) => f.name)).size === names.length,
  );
  let total = 0;
  for (const file of manifest.files) {
    requireValue(
      names.includes(file.name) &&
        HASH.test(file.sha256) &&
        bounded(file.byteSize, 32 * 1024 * MiB, 1),
    );
    const index = file.name.endsWith(".gz");
    requireValue(
      index
        ? bounded(file.plainByteSize, 128 * MiB, 1) &&
            file.byteSize <= 128 * MiB
        : file.plainByteSize === null,
    );
    total += file.byteSize;
    requireValue(total <= 32 * 1024 * MiB);
    const stat = await lstat(path.join(root, file.name));
    requireValue(
      stat.isFile() && !stat.isSymbolicLink() && stat.size === file.byteSize,
    );
    await digest(createReadStream(path.join(root, file.name)), file);
  }
  const processFile = manifest.files.find(
    (f) => f.name === "processes.json.gz",
  );
  const plain = gunzipSync(
    await localBytes(root, processFile.name, 128 * MiB),
    { maxOutputLength: processFile.plainByteSize },
  );
  requireValue(plain.length === processFile.plainByteSize);
  const processes = JSON.parse(plain);
  requireValue(
    Array.isArray(processes) && processes.length === manifest.processCount,
  );
  const seen = new Set();
  const rows = processes.map((p, i) => {
    requireValue(
      UUID.test(p.id) &&
        VERSION.test(p.version) &&
        p.ordinal === i &&
        !seen.has(`${p.id}@${p.version}`),
    );
    seen.add(`${p.id}@${p.version}`);
    return { id: p.id, version: p.version, ordinal: p.ordinal };
  });
  return { root, reference, manifest, rows };
}

export async function uploadWithWorker({ builder, root, env }) {
  requireValue(path.isAbsolute(builder));
  // Public CLI validates HDF5 structure and values before uploading; stderr stays private.
  const { stdout } = await exec(builder, ["upload", "--artifact-dir", root], {
    env,
    timeout: 30 * 60 * 1000,
    maxBuffer: MiB,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}
function required(env, name) {
  requireValue(typeof env[name] === "string" && env[name].length > 0);
  return env[name];
}
export function createQueryArtifactClients(
  env,
  { S3 = S3Client, Pool = pg.Pool } = {},
) {
  const prefix = env.S3_PREFIX ?? "";
  requireValue(
    !prefix.startsWith("/") &&
      !prefix.endsWith("/") &&
      !prefix.includes("\\") &&
      !prefix.split("/").some((v) => v === "." || v === ".."),
  );
  const client = new S3({
    endpoint: required(env, "S3_ENDPOINT"),
    region: required(env, "S3_REGION"),
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
      ...(env.S3_SESSION_TOKEN ? { sessionToken: env.S3_SESSION_TOKEN } : {}),
    },
  });
  const bucket = required(env, "S3_BUCKET");
  const pool = new Pool({
    connectionString: required(env, "CONN"),
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    application_name: "release-query-artifact-registration",
  });
  const calls = {
    stage:
      "select api.svc_result_query_stage($1::uuid,$2::jsonb,$3::jsonb,$4::jsonb) as result",
    seal: "select api.svc_result_query_seal($1::uuid) as result",
    bind: "select api.svc_result_query_bind_release($1::uuid,$2::uuid) as result",
  };
  return {
    async read(relative) {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: [prefix, relative].filter(Boolean).join("/"),
        }),
        { abortSignal: AbortSignal.timeout(120000) },
      );
      requireValue(result.Body);
      return result.Body;
    },
    async rpc(name, parameters) {
      requireValue(Object.hasOwn(calls, name));
      const connection = await pool.connect();
      try {
        await connection.query("begin");
        await connection.query("set local role service_role");
        await connection.query("set local lock_timeout = '5s'");
        const result = await connection.query(calls[name], parameters);
        await connection.query("commit");
        return result.rows[0]?.result;
      } catch (error) {
        await connection.query("rollback").catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    },
    async close() {
      client.destroy();
      await pool.end();
    },
  };
}

/** Storage registration is distinct from publication; every retry verifies the same immutable files. */
export async function registerQueryArtifact(
  {
    directory,
    builder,
    packageId,
    releaseRunId,
    confirmManifest,
    env = process.env,
  },
  dependencies = {},
) {
  requireValue(UUID.test(packageId) && UUID.test(releaseRunId));
  const inspected = await inspectQueryArtifact(directory);
  const { root, reference, manifest, rows } = inspected;
  requireValue(confirmManifest === reference.manifestSha256);
  const uploaded = await (dependencies.upload ?? uploadWithWorker)({
    builder,
    root,
    env,
  });
  requireValue(
    uploaded.schemaVersion === reference.schemaVersion &&
      uploaded.artifactId === reference.artifactId &&
      uploaded.manifestSha256 === reference.manifestSha256 &&
      uploaded.manifestByteSize === reference.manifestByteSize,
  );
  const clients = (dependencies.clients ?? createQueryArtifactClients)(env);
  try {
    const prefix = `query-artifacts/${reference.artifactId}/${reference.manifestSha256}`;
    // Download all remote bytes independently. No S3 ETag or transport-success shortcut.
    for (const file of [
      ...manifest.files,
      {
        name: "manifest.json",
        sha256: reference.manifestSha256,
        byteSize: reference.manifestByteSize,
      },
    ]) {
      await digest(await clients.read(`${prefix}/${file.name}`), file);
    }
    for (let offset = 0; offset < rows.length; offset += 500) {
      const response = await clients.rpc("stage", [
        packageId,
        JSON.stringify(reference),
        JSON.stringify(manifest),
        JSON.stringify(rows.slice(offset, offset + 500)),
      ]);
      requireValue(
        response?.ok === true &&
          response.data?.artifactId === reference.artifactId &&
          response.data.registeredProcessCount >=
            Math.min(offset + 500, rows.length),
      );
    }
    const sealed = await clients.rpc("seal", [reference.artifactId]);
    requireValue(
      sealed?.ok === true &&
        sealed.data?.artifactId === reference.artifactId &&
        sealed.data.status === "ready",
    );
    const bound = await clients.rpc("bind", [
      releaseRunId,
      reference.artifactId,
    ]);
    requireValue(
      bound?.ok === true &&
        bound.data?.releaseRunId === releaseRunId &&
        bound.data.artifactId === reference.artifactId,
    );
    return {
      schemaVersion: "result.query.registration.v1",
      status: "registered",
      packageId,
      releaseRunId,
      artifactId: reference.artifactId,
      manifestSha256: reference.manifestSha256,
      processCount: rows.length,
      publicationChanged: false,
    };
  } finally {
    await clients.close();
  }
}
