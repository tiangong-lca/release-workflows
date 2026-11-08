import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import {
  preparePublicationEnvironment,
  PUBLICATION_STORAGE_SETTINGS,
} from "../lib/publication-environment.mjs";
import { prepareFinalResultReadinessEnvironment } from "../lib/final-result-readiness-runtime.mjs";
import { finalResultDatabaseTargetHash } from "../adapters/final-result-registry.mjs";

test("storage and readiness prepare the identical trusted connection from one explicit configuration", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "publication-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "config"));
  await writeFile(
    path.join(directory, "config", "ca.pem"),
    rootCertificates[0],
  );
  const conn =
    "postgresql://operator:private-password@example.test/postgres?sslmode=require";
  await writeFile(
    path.join(directory, "config", ".env"),
    `CONN=${conn}\nRELEASE_DATABASE_CA_FILE=ca.pem\nS3_SECRET_ACCESS_KEY=private-storage-key\nRESULT_QUERY_SERVICE_SECRET_FILE=reader-key\n`,
  );
  const options = { "config-env": path.join(directory, "config", ".env") };
  const storage = await preparePublicationEnvironment(options, {
    env: {},
    cwd: tmpdir(),
    settings: PUBLICATION_STORAGE_SETTINGS,
  });
  await writeFile(path.join(directory, "config", "reader-key"), "r".repeat(32));
  const readiness = await prepareFinalResultReadinessEnvironment(options, {
    env: {},
    cwd: tmpdir(),
  });
  assert.equal(storage.environment.CONN, readiness.CONN);
  assert.equal(
    new URL(readiness.CONN).searchParams.get("sslmode"),
    "verify-full",
  );
  assert.equal(
    new URL(readiness.CONN).searchParams.get("sslrootcert"),
    path.join(directory, "config", "ca.pem"),
  );
  assert.equal(
    finalResultDatabaseTargetHash(readiness.CONN),
    finalResultDatabaseTargetHash(conn),
  );
  assert.equal(storage.environment.S3_SECRET_ACCESS_KEY, undefined);
  assert.equal(storage.environment.RESULT_QUERY_SERVICE_SECRET_FILE, undefined);
});

test("inspection config never reads secret getters, discovers files or mutates process values", async () => {
  const env = { CONN: "postgres://user:password@example.test/postgres" };
  for (const key of [
    "S3_SECRET_ACCESS_KEY",
    "RESULT_QUERY_SERVICE_SECRET",
    "TIANGONG_LCA_API_KEY",
  ])
    Object.defineProperty(env, key, {
      get() {
        throw new Error("unexpected secret access");
      },
    });
  const { environment } = await preparePublicationEnvironment(
    {},
    { env, cwd: "/does-not-exist", settings: PUBLICATION_STORAGE_SETTINGS },
  );
  assert.deepEqual(environment, { CONN: env.CONN });
});

test("current pg 8 strict TLS aliases normalize explicitly without changing target or mutating input", async () => {
  for (const mode of ["require", "prefer", "verify-ca"]) {
    const env = {
      CONN: `postgres://user:password@example.test/postgres?sslmode=${mode}`,
    };
    const before = env.CONN;
    const { environment } = await preparePublicationEnvironment({}, { env });
    assert.equal(
      new URL(environment.CONN).searchParams.get("sslmode"),
      "verify-full",
    );
    assert.equal(
      finalResultDatabaseTargetHash(environment.CONN),
      finalResultDatabaseTargetHash(before),
    );
    assert.equal(env.CONN, before);
  }
});

test("connection TLS file paths use the explicit file directory without changing target identity", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "publication-tls-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const conn =
    "postgres://user:password@example.test/postgres?sslmode=verify-full&sslrootcert=ca.pem";
  await writeFile(path.join(directory, "config.env"), `CONN=${conn}\n`);
  const { environment } = await preparePublicationEnvironment(
    { "config-env": path.join(directory, "config.env") },
    { env: {}, cwd: tmpdir() },
  );
  assert.equal(
    new URL(environment.CONN).searchParams.get("sslrootcert"),
    path.join(directory, "ca.pem"),
  );
  assert.equal(
    finalResultDatabaseTargetHash(environment.CONN),
    finalResultDatabaseTargetHash(conn),
  );
});
