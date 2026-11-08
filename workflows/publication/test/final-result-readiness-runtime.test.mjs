import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { rootCertificates } from "node:tls";
import path from "node:path";
import { prepareFinalResultReadinessEnvironment as prepare } from "../lib/final-result-readiness-runtime.mjs";
import { finalResultDatabaseTargetHash } from "../adapters/final-result-registry.mjs";

const secret = "private-reader-secret-never-print-32-bytes";
async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "readiness-env-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, env: {} };
}
const safe = (code) => (e) =>
  e.code === code &&
  !JSON.stringify(e).includes(secret) &&
  !e.message.includes(secret);
test("configuration is explicit, scoped and does not read bootstrap credentials by default", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.cwd, ".env"),
    `RESULT_QUERY_SERVICE_SECRET=${secret}\n`,
  );
  Object.defineProperty(f.env, "TIANGONG_LCA_API_KEY", {
    get() {
      throw new Error("implicit bootstrap");
    },
  });
  f.env.UNRELATED = "ignore";
  const result = await prepare({}, f);
  assert.deepEqual(result, {});
  assert.equal(f.env.UNRELATED, "ignore");
});
test("explicit file uses Node dotenv syntax, whitelists keys and rejects conflicting environment without printing values", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.cwd, "config.env"),
    `export RESULT_QUERY_SERVICE_SECRET='${secret}'\nUNRELATED=not-loaded\nNODE_OPTIONS=--not-a-node-option\n`,
  );
  const result = await prepare({ "config-env": "config.env" }, f);
  assert.equal(result.RESULT_QUERY_SERVICE_SECRET, secret);
  assert.equal(result.UNRELATED, undefined);
  assert.equal(result.NODE_OPTIONS, undefined);
  assert.deepEqual(f.env, {});
  await assert.rejects(
    prepare(
      { "config-env": "config.env" },
      { ...f, env: { RESULT_QUERY_SERVICE_SECRET: "other-secret" } },
    ),
    safe("final_environment_conflict"),
  );
  await assert.rejects(
    prepare({ "config-env": "missing" }, f),
    safe("final_environment_config_file_invalid"),
  );
  await writeFile(path.join(f.cwd, "large"), "x".repeat(65537));
  await assert.rejects(
    prepare({ "config-env": "large" }, f),
    safe("final_environment_config_file_invalid"),
  );
});
test("only the exact project API base is normalized; ambiguous paths and embedded credentials are refused", async () => {
  for (const source of [
    "https://project.example",
    "https://project.example/functions/v1",
    "https://project.example/functions/v1/",
  ]) {
    const env = { TIANGONG_LCA_API_BASE_URL: source };
    const result = await prepare({}, { env });
    assert.equal(result.TIANGONG_LCA_API_BASE_URL, "https://project.example");
    assert.equal(env.TIANGONG_LCA_API_BASE_URL, source);
  }
  for (const source of [
    "https://user:private@project.example",
    "https://project.example/x",
    "https://project.example/?token=private",
    "invalid",
  ])
    await assert.rejects(
      prepare({}, { env: { TIANGONG_LCA_API_BASE_URL: source } }),
      safe("final_readiness_api_origin_invalid"),
    );
});
test("configured CA resolves relative to the config file and keeps database target identity unchanged", async (t) => {
  const f = await fixture(t),
    conn =
      "postgresql://user:password@example.test:5432/postgres?sslmode=require";
  await writeFile(path.join(f.cwd, "ca.pem"), rootCertificates[0]);
  await writeFile(
    path.join(f.cwd, "config.env"),
    `CONN=${conn}\nRELEASE_DATABASE_CA_FILE=ca.pem\n`,
  );
  const result = await prepare(
    { "config-env": path.join(f.cwd, "config.env") },
    { env: {}, cwd: tmpdir() },
  );
  const url = new URL(result.CONN);
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.equal(url.searchParams.get("sslrootcert"), path.join(f.cwd, "ca.pem"));
  assert.equal(
    finalResultDatabaseTargetHash(conn),
    finalResultDatabaseTargetHash(result.CONN),
  );
  await writeFile(path.join(f.cwd, "ca.pem"), "invalid certificate");
  await assert.rejects(
    prepare({ "config-env": "config.env" }, f),
    safe("final_environment_database_ca_invalid"),
  );
});
test("secret file is bounded, resolves relative to config, and never expands a shell", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, "secret"), secret + "\n", { mode: 0o600 });
  await writeFile(
    path.join(f.cwd, "config.env"),
    "RESULT_QUERY_SERVICE_SECRET_FILE=secret\n",
  );
  const result = await prepare({ "config-env": "config.env" }, f);
  assert.equal(result.RESULT_QUERY_SERVICE_SECRET, secret);
  await assert.rejects(
    prepare(
      { "config-env": "config.env" },
      { ...f, env: { RESULT_QUERY_SERVICE_SECRET: secret } },
    ),
    safe("final_readiness_secret_source_conflict"),
  );
  await writeFile(path.join(f.cwd, "secret"), "short");
  await assert.rejects(
    prepare({ "config-env": "config.env" }, f),
    safe("final_readiness_secret_invalid"),
  );
});
test("SSH source invokes one fixed bounded read and isolates child environment; provider errors stay private", async () => {
  const env = {
    RESULT_QUERY_SERVICE_SECRET_SSH_HOST: "reader-alias",
    RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE: "/etc/service/reader.env",
    S3_SECRET_ACCESS_KEY: "not-for-ssh",
  };
  let calls = 0;
  const executeFile = async (file, args, options) => {
    calls++;
    assert.equal(file, "ssh");
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes("reader-alias"));
    assert.match(args.at(-1), /^sudo -n python3 -c /);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 20000);
    assert.equal(options.maxBuffer, 8192);
    assert.equal(options.env.S3_SECRET_ACCESS_KEY, undefined);
    return { stdout: secret, stderr: "private diagnostic" };
  };
  const result = await prepare({}, { env, executeFile });
  assert.equal(result.RESULT_QUERY_SERVICE_SECRET, secret);
  assert.equal(calls, 1);
  await assert.rejects(
    prepare(
      {},
      {
        env,
        executeFile: async () => {
          throw new Error(secret);
        },
      },
    ),
    safe("final_readiness_secret_unavailable"),
  );
  for (const bad of [
    { RESULT_QUERY_SERVICE_SECRET_SSH_HOST: "-oProxyCommand=evil" },
    { RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE: "/etc/../secret" },
    { RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE: "/etc/file;echo secret" },
  ])
    await assert.rejects(
      prepare(
        {},
        {
          env: { ...env, ...bad },
          executeFile: async () => assert.fail("must not execute"),
        },
      ),
      safe("final_readiness_secret_source_invalid"),
    );
});
test("session exchange requires the explicit switch; existing JWT is retained and bootstrap credential removed", async () => {
  const env = { TIANGONG_LCA_API_KEY: secret };
  let calls = 0;
  const resolveSession = async ({ env: settings }) => {
    calls++;
    assert.equal(settings.TIANGONG_LCA_API_KEY, secret);
    return "actor.jwt.value";
  };
  assert.equal(
    (await prepare({}, { env, resolveSession })).TIANGONG_LCA_ACCESS_TOKEN,
    undefined,
  );
  const result = await prepare(
    { "bootstrap-session": true },
    { env, resolveSession },
  );
  assert.equal(result.TIANGONG_LCA_ACCESS_TOKEN, "actor.jwt.value");
  assert.equal(result.TIANGONG_LCA_API_KEY, undefined);
  assert.equal(calls, 1);
  await prepare(
    { "bootstrap-session": true },
    {
      env: { ...env, TIANGONG_LCA_ACCESS_TOKEN: "existing.jwt.value" },
      resolveSession: () => assert.fail("must not exchange"),
    },
  );
  await assert.rejects(
    prepare(
      { "bootstrap-session": true },
      {
        env,
        resolveSession: async () => {
          throw new Error(secret);
        },
      },
    ),
    safe("final_readiness_session_unavailable"),
  );
});
