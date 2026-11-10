import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  stat,
  mkdir,
  cp,
} from "node:fs/promises";
import { parseEnv } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { loadReleaseEnvironment } from "../lib/configuration.mjs";
import {
  configureReleaseCli,
  attachReleaseConfiguration,
} from "../lib/cli-configuration.mjs";
import { resolvePnpmInvocation } from "../lib/pnpm-invocation.mjs";
import { settingsForCommand, RELEASE_ROOT } from "../lib/settings.mjs";
import { checkEnvironment } from "../lib/check.mjs";
import { runEnvironmentCli } from "../cli.mjs";
import {
  syncDataPlaneEnvironment,
  initializeConfiguration,
} from "../lib/setup.mjs";

const exec = promisify(execFile);
const secret = "secret-canary-never-in-output";
const conn = `postgres://operator:${secret}@127.0.0.1:65422/postgres`;
const storage = {
  CONN: conn,
  S3_ENDPOINT: "http://127.0.0.1:60001",
  S3_REGION: "us-east-1",
  S3_BUCKET: "synthetic-results",
  S3_ACCESS_KEY_ID: secret,
  S3_SECRET_ACCESS_KEY: secret,
};
const versionTool = async () => ({ code: 0, stdout: "11.24.0\n", stderr: "" });
async function dir(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "release-environment-135-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function io() {
  let text = "";
  return {
    stream: {
      write(value) {
        text += value;
      },
    },
    get text() {
      return text;
    },
    get json() {
      return JSON.parse(text);
    },
  };
}

test("fixed default and explicit files share conflict/path rules without mutating input or reading unrelated secrets", async (t) => {
  const root = await dir(t);
  const file = path.join(root, "operator.env");
  await writeFile(
    file,
    `TIDAS_BIN=tools/tidas\nCONN=${conn}\nS3_SECRET_ACCESS_KEY=${secret}\n`,
  );
  const env = {};
  Object.defineProperty(env, "CONN", {
    get() {
      assert.fail("offline commands must not consume CONN");
    },
  });
  const loaded = await loadReleaseEnvironment(
    {},
    { env, settings: ["TIDAS_BIN"], defaultFile: file, cwd: os.tmpdir() },
  );
  assert.deepEqual(loaded.environment, {
    TIDAS_BIN: path.join(root, "tools/tidas"),
  });
  assert.equal(env.TIDAS_BIN, undefined);
  assert.equal(loaded.configuration.file, file);
  assert.doesNotMatch(JSON.stringify(loaded.configuration), new RegExp(secret));
  await assert.rejects(
    loadReleaseEnvironment(
      { "config-env": file },
      { env: { TIDAS_BIN: "other" }, settings: ["TIDAS_BIN"] },
    ),
    (e) =>
      e.code === "final_environment_conflict" &&
      !JSON.stringify(e).includes(secret),
  );
  await assert.rejects(
    loadReleaseEnvironment(
      { "config-env": path.join(root, "missing") },
      { env: {} },
    ),
    { code: "final_environment_config_file_invalid" },
  );
  assert.equal(
    (
      await loadReleaseEnvironment(
        {},
        { env: {}, defaultFile: path.join(root, "missing") },
      )
    ).configuration.file,
    null,
  );
});

test("CLI bootstrap scopes actor/offline credentials, skips config on help and carries alternate files into exact continuations", async (t) => {
  const root = await dir(t);
  const file = path.join(root, "operator.env");
  await writeFile(
    file,
    `CONN=not-a-url\nRELEASE_DATABASE_CA_FILE=missing.pem\nTIANGONG_LCA_ACCESS_TOKEN=${secret}\n`,
  );
  const env = {};
  const context = await configureReleaseCli(
    "publication",
    ["result-publication", "status", "--config-env", file],
    { env, defaultFile: false },
  );
  assert.equal(env.CONN, undefined);
  assert.equal(env.RELEASE_DATABASE_CA_FILE, undefined);
  assert.equal(env.TIANGONG_LCA_ACCESS_TOKEN, secret);
  assert.deepEqual(context.argv, ["result-publication", "status"]);
  assert.deepEqual(
    settingsForCommand("dataset-transformation", ["dsl", "inspect"]),
    [],
  );
  await configureReleaseCli(
    "publication",
    ["result-storage", "execute", "--help", "--config-env", "/missing"],
    { env: {}, defaultFile: false },
  );
  const cli = fileURLToPath(
    new URL("../../publication/cli.mjs", import.meta.url),
  );
  const next = {
    nextActions: [
      { argv: ["node", cli, "result-storage", "execute"], command: "original" },
    ],
  };
  attachReleaseConfiguration(next, context);
  assert.deepEqual(next.nextActions[0].argv.slice(-2), ["--config-env", file]);
  assert.doesNotMatch(JSON.stringify(next), new RegExp(secret));
  await assert.rejects(
    configureReleaseCli(
      "publication",
      ["result-storage", "inspect", "--config-env", "--json"],
      { env: {} },
    ),
    { code: "final_environment_arguments_invalid" },
  );
});

test("local checks do not construct network clients or fetch; selected remote checks use only readonly methods", async (t) => {
  const root = await dir(t);
  let reads = 0;
  let heads = 0;
  let closes = 0;
  const deps = {
    env: storage,
    defaultFile: false,
    runTool: versionTool,
    fetchImpl() {
      assert.fail("no HTTP calls in storage check");
    },
    createRegistry() {
      reads++;
      return {
        checkConnection: async () => ({ connected: true }),
        close: async () => closes++,
        stageQuery() {
          assert.fail("cannot stage");
        },
      };
    },
    createObjectStore() {
      heads++;
      return {
        checkConnection: async () => ({
          reachable: true,
          writePermissionVerified: false,
        }),
        close: async () => closes++,
        ensureCandidate() {
          assert.fail("cannot upload");
        },
      };
    },
  };
  const local = await checkEnvironment(
    { for: "storage", "output-dir": root },
    deps,
  );
  assert.equal(local.ok, true);
  assert.equal(reads + heads, 0);
  assert.equal(local.completeness, "local_only");
  const remote = await checkEnvironment(
    { for: "storage", remote: true, "output-dir": root },
    deps,
  );
  assert.equal(remote.ok, true);
  assert.deepEqual([reads, heads, closes], [1, 1, 2]);
  assert.equal(remote.uploadAttempted, false);
  assert.equal(remote.registryWriteAttempted, false);
  assert.equal(
    remote.checks.find((c) => c.id === "storage_connection")
      .writePermissionVerified,
    false,
  );
  assert.doesNotMatch(JSON.stringify(remote), new RegExp(secret));
  const failed = await checkEnvironment(
    { for: "storage", remote: true, "output-dir": root },
    {
      ...deps,
      createRegistry() {
        throw Object.assign(new Error(secret), {
          code: "SELF_SIGNED_CERT_IN_CHAIN",
        });
      },
    },
  );
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(secret));
});

test("remote readiness uses GET health/current actor only and never retrieves an SSH secret or logs in", async (t) => {
  const root = await dir(t);
  const calls = [];
  const report = await checkEnvironment(
    { for: "readiness", remote: true, "output-dir": root },
    {
      env: {
        ...storage,
        TIANGONG_LCA_API_BASE_URL: "https://api.example.test/functions/v1",
        TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "public-test",
        TIANGONG_LCA_ACCESS_TOKEN:
          "header." +
          Buffer.from(
            JSON.stringify({
              role: "authenticated",
              sub: "00000000-0000-4000-8000-000000000135",
              exp: Math.floor(Date.now() / 1000) + 300,
            }),
          ).toString("base64url") +
          ".signature",
        RESULT_QUERY_ENDPOINT: "https://reader.example.test",
        RESULT_QUERY_SERVICE_SECRET_SSH_HOST: "existing-host",
        RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE: "/etc/reader.env",
      },
      defaultFile: false,
      runTool: versionTool,
      createRegistry: () => ({
        checkConnection: async () => {},
        close: async () => {},
      }),
      createObjectStore: () => ({
        checkConnection: async () => ({}),
        close: async () => {},
      }),
      fetchImpl: async (url, options) => {
        calls.push([url, options.method]);
        assert.equal(options.redirect, "error");
        assert.equal(options.method, "GET");
        return new Response(
          JSON.stringify(
            url.endsWith("/health")
              ? { status: "ok", service: "result-query" }
              : { id: "00000000-0000-4000-8000-000000000135" },
          ),
        );
      },
    },
  );
  assert.equal(report.ok, true);
  assert.deepEqual(calls, [
    ["https://api.example.test/auth/v1/user", "GET"],
    ["https://reader.example.test/health", "GET"],
  ]);
  assert.equal(
    report.checks.find((c) => c.id === "reader_liveness").status,
    "passed",
  );
  assert.equal(
    report.checks.find((c) => c.id === "business_readiness").status,
    "not_checked",
  );
});

test("check/help never initialize files; init/sync require explicit local confirmation, preserve values and encode them losslessly", async (t) => {
  const root = await dir(t);
  const file = path.join(root, "new.env");
  const out = io();
  assert.equal(
    await runEnvironmentCli(["init", "--config-env", file, "--json"], {
      stdout: out.stream,
      stderr: out.stream,
    }),
    2,
  );
  await assert.rejects(stat(file), { code: "ENOENT" });
  await initializeConfiguration(file);
  const template = await readFile(file, "utf8");
  if (process.platform !== "win32")
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(initializeConfiguration(file), {
    code: "final_environment_init_refused",
  });
  assert.equal(await readFile(file, "utf8"), template);
  const source = path.join(root, "source.env"),
    target = path.join(root, "target.env");
  await writeFile(
    source,
    `CONN=${conn}\nS3_BUCKET=source-bucket\nS3_SECRET_ACCESS_KEY='${secret} # literal'\nTIANGONG_LCA_API_KEY=must-not-copy-user-credentials\n`,
  );
  await writeFile(target, "S3_BUCKET=preserved-bucket\n");
  const receipt = await syncDataPlaneEnvironment({ source, target });
  const actual = parseEnv(await readFile(target, "utf8"));
  assert.equal(actual.S3_BUCKET, "preserved-bucket");
  assert.equal(actual.S3_SECRET_ACCESS_KEY, `${secret} # literal`);
  assert.equal(actual.TIANGONG_LCA_API_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret));
  assert.deepEqual(receipt.preservedKeys, ["S3_BUCKET"]);
});

test("project doctor emits bounded clean JSON and exit 1 for blockers, while all workflow help remains configuration-independent", async (t) => {
  const root = await dir(t);
  const out = io();
  const status = await runEnvironmentCli(
    ["check", "--for", "storage", "--output-dir", root, "--json"],
    {
      stdout: out.stream,
      stderr: out.stream,
      env: {},
      defaultFile: false,
      runTool: versionTool,
    },
  );
  assert.equal(status, 1);
  assert.equal(out.json.ok, false);
  assert.ok(out.json.guidance.some((g) => g.setting === "CONN"));
  assert.ok(out.text.length < 32768);
  const guide = io();
  assert.equal(
    await runEnvironmentCli(
      ["guide", "--for", "local", "--output-dir", root, "--json"],
      {
        stdout: guide.stream,
        stderr: guide.stream,
        env: {},
        defaultFile: false,
        runTool: versionTool,
      },
    ),
    0,
  );
  for (const name of [
    "environment",
    "calculation",
    "result-materialization",
    "release-candidate",
    "dataset-transformation",
    "publication",
  ]) {
    const cli = fileURLToPath(
      new URL(`../../${name}/cli.mjs`, import.meta.url),
    );
    const help = await exec(
      process.execPath,
      [cli, "--help", "--config-env", "/missing/file"],
      { cwd: root },
    );
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /config-env/);
  }
});

test("configuration failures in the real CLI are typed JSON without stack traces or secret values", async (t) => {
  const root = await dir(t);
  for (const [name, args] of [
    ["calculation", ["result-set", "list", "--format", "json"]],
    ["result-materialization", ["job", "get", "--json"]],
    ["release-candidate", ["result", "inspect", "--json"]],
    ["dataset-transformation", ["dsl", "inspect", "--json"]],
    ["publication", ["result-storage", "inspect", "--json"]],
  ]) {
    const cli = fileURLToPath(
      new URL(`../../${name}/cli.mjs`, import.meta.url),
    );
    await assert.rejects(
      exec(
        process.execPath,
        [cli, ...args, "--config-env", path.join(root, secret)],
        { cwd: root },
      ),
      (error) => {
        const result = JSON.parse(error.stderr || error.stdout);
        assert.equal(
          result.error.code,
          "final_environment_config_file_invalid",
        );
        assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
        return true;
      },
    );
  }
});

test("the real S3 probe sends only signed HEAD and sanitizes rejected provider bodies", async (t) => {
  const { createFinalResultObjectStore } =
    await import("../../publication/adapters/final-result-object-store.mjs");
  const requests = [];
  let status = 200;
  const server = createServer((req, res) => {
    requests.push([req.method, req.url]);
    res.writeHead(status);
    res.end(secret);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = createFinalResultObjectStore({
    target: {
      databaseTargetHash: "a".repeat(64),
      endpoint: `http://127.0.0.1:${server.address().port}/storage/v1/s3`,
      region: "us-east-1",
      bucket: "synthetic_results",
      prefix: "test",
    },
    credentials: { accessKeyId: secret, secretAccessKey: secret },
    timeoutMs: 1000,
  });
  t.after(() => store.close());
  assert.equal((await store.checkConnection()).writePermissionVerified, false);
  status = 403;
  await assert.rejects(
    store.checkConnection(),
    (error) =>
      error.code === "final_environment_storage_probe_failed" &&
      error.details.httpStatus === 403 &&
      !JSON.stringify(error).includes(secret),
  );
  assert.deepEqual(requests, [
    ["HEAD", "/storage/v1/s3/synthetic_results/"],
    ["HEAD", "/storage/v1/s3/synthetic_results/"],
  ]);
});

test("the database connectivity probe uses a readonly transaction and no business RPC", async () => {
  const { createFinalResultRegistry } =
    await import("../../publication/adapters/final-result-registry.mjs");
  const calls = [];
  class Pool {
    on() {}
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          return {
            rows: [{ result: { ok: true, data: { connected: true } } }],
          };
        },
        release() {},
      };
    }
    async end() {}
  }
  const registry = createFinalResultRegistry({ connectionString: conn, Pool });
  try {
    assert.deepEqual(await registry.checkConnection(), { connected: true });
  } finally {
    await registry.close();
  }
  assert.equal(calls[0], "begin read only");
  assert.equal(calls.at(-1), "commit");
  assert.ok(calls.some((sql) => sql.startsWith("select jsonb_build_object")));
  assert.ok(calls.every((sql) => !/(insert|update|delete|svc_)/iu.test(sql)));
});

test("gateway-only health stays a warning, TLS errors keep safe codes and service tokens never reach actor HTTP", async (t) => {
  const root = await dir(t);
  const base = {
    ...storage,
    TIANGONG_LCA_API_BASE_URL: "https://api.example.test",
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "public-test",
    TIANGONG_LCA_ACCESS_TOKEN:
      "header." +
      Buffer.from(
        JSON.stringify({
          role: "authenticated",
          sub: "00000000-0000-4000-8000-000000000135",
          exp: Math.floor(Date.now() / 1000) + 600,
        }),
      ).toString("base64url") +
      ".signature",
    RESULT_QUERY_ENDPOINT: "https://reader.example.test",
    RESULT_QUERY_SERVICE_SECRET_SSH_HOST: "host",
    RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE: "/etc/reader.env",
  };
  const deps = {
    env: base,
    defaultFile: false,
    runTool: versionTool,
    createRegistry: () => ({
      checkConnection: async () => {},
      close: async () => {},
    }),
    createObjectStore: () => ({
      checkConnection: async () => ({}),
      close: async () => {},
    }),
    fetchImpl: async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith("/user")
            ? { id: "00000000-0000-4000-8000-000000000135" }
            : { status: "ok", timestamp: "observation" },
        ),
      ),
  };
  const result = await checkEnvironment(
    { for: "readiness", remote: true, "output-dir": root },
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(
    result.checks.find((c) => c.id === "reader_liveness").status,
    "warning",
  );
  assert.equal(
    result.checks.find((c) => c.id === "reader_liveness")
      .queryServiceIdentified,
    false,
  );
  assert.equal(
    result.checks.find((c) => c.id === "actor_authentication").status,
    "passed",
  );
  const tls = await checkEnvironment(
    { for: "readiness", remote: true, "output-dir": root },
    {
      ...deps,
      fetchImpl: async () => {
        throw Object.assign(new Error(secret), {
          cause: { code: "CERT_HAS_EXPIRED" },
        });
      },
    },
  );
  assert.equal(tls.ok, false);
  assert.equal(
    tls.checks.find((c) => c.id === "reader_liveness").code,
    "final_environment_http_tls_failed",
  );
  assert.doesNotMatch(JSON.stringify(tls), new RegExp(secret));
  const token =
    "header." +
    Buffer.from(
      JSON.stringify({
        role: "service_role",
        sub: "00000000-0000-4000-8000-000000000135",
        exp: 9999999999,
      }),
    ).toString("base64url") +
    ".signature";
  const urls = [];
  const rejected = await checkEnvironment(
    { for: "readiness", remote: true, "output-dir": root },
    {
      ...deps,
      env: { ...base, TIANGONG_LCA_ACCESS_TOKEN: token },
      fetchImpl: async (url) => {
        urls.push(url);
        return new Response(
          JSON.stringify({ status: "ok", service: "result-query" }),
        );
      },
    },
  );
  assert.equal(rejected.ok, false);
  assert.deepEqual(urls, []);
  assert.doesNotMatch(JSON.stringify(rejected), new RegExp(secret));
});

test("Environment help/init/local check work before business dependencies are installed", async (t) => {
  const root = await dir(t),
    workflow = path.join(root, "workflows/environment");
  await cp(fileURLToPath(new URL("../", import.meta.url)), workflow, {
    recursive: true,
    filter: (source) =>
      !source.split(path.sep).includes("test") &&
      !source.split(path.sep).includes("node_modules"),
  });
  await writeFile(path.join(root, ".node-version"), "24.22.0\n");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", packageManager: "pnpm@11.24.0" }),
  );
  await writeFile(path.join(root, ".env.example"), "CONN=\n");
  const cli = path.join(workflow, "cli.mjs");
  const help = await exec(process.execPath, [cli, "--help"], {
    cwd: os.tmpdir(),
  });
  assert.equal(help.stderr, "");
  const checked = await exec(
    process.execPath,
    [cli, "check", "--for", "local", "--output-dir", root, "--json"],
    { cwd: os.tmpdir() },
  );
  assert.equal(JSON.parse(checked.stdout).ok, true);
  const initialized = await exec(
    process.execPath,
    [cli, "init", "--confirm-init", "--json"],
    { cwd: os.tmpdir() },
  );
  assert.equal(JSON.parse(initialized.stdout).ok, true);
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "CONN=\n");
});

test("the Calculation sync alias preserves shared configuration errors without claiming a business operation completed", async () => {
  const { runCli } = await import("../../calculation/cli.mjs");
  const output = io();
  const code = await runCli(
    ["environment", "sync", "--confirm-sync", "--format", "json"],
    {
      stdout: output.stream,
      stderr: output.stream,
      env: {},
      environmentSynchronizer: async () => {
        throw Object.assign(
          new Error(
            "Release configuration is invalid; check the named setting",
          ),
          {
            code: "final_environment_config_file_invalid",
            details: { setting: "config-env" },
          },
        );
      },
    },
  );
  assert.notEqual(code, 0);
  assert.equal(output.json.error.code, "final_environment_config_file_invalid");
  assert.doesNotMatch(output.text, /operation completed/);
});

test("human Calculation continuations retain the explicit configuration without exposing values", async (t) => {
  const root = await dir(t),
    file = path.join(root, "operator.env");
  await writeFile(
    file,
    `TIANGONG_LCA_ACCESS_TOKEN=${secret}\nCONN=unrelated-invalid-connection\n`,
  );
  const cli = fileURLToPath(
    new URL("../../calculation/cli.mjs", import.meta.url),
  );
  await assert.rejects(
    exec(
      process.execPath,
      [cli, "result-set", "create", "--config-env", file],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /--config-env/);
      assert.ok(error.stderr.includes(file));
      assert.doesNotMatch(error.stderr, new RegExp(secret));
      return true;
    },
  );
});

test("the project doctor script bypasses pnpm builtin doctor and forwards scope flags as clean JSON", async () => {
  const invocation = resolvePnpmInvocation(process.env.npm_execpath ?? "pnpm");
  const result = await exec(
    invocation.command,
    [
      ...invocation.prefixArgs,
      "--silent",
      "run",
      "doctor",
      "--for",
      "local",
      "--json",
    ],
    { cwd: RELEASE_ROOT },
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.command, "environment check");
  assert.equal(report.profile, "local");
  assert.equal(report.ok, true);
  assert.equal(result.stderr, "");
});
