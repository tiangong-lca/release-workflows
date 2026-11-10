import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  resolveActorAccessToken,
  authenticateUserSession,
  userTokenClaims,
} from "../lib/user-session.mjs";
import { checkEnvironment } from "../lib/check.mjs";
import { runEnvironmentCli } from "../cli.mjs";
import {
  configureReleaseCli,
  attachReleaseConfiguration,
} from "../lib/cli-configuration.mjs";
import { fileURLToPath } from "node:url";
const id = "00000000-0000-4000-8000-000000000140";
const token = (extra = {}) =>
  "header." +
  Buffer.from(
    JSON.stringify({
      role: "authenticated",
      sub: id,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...extra,
    }),
  ).toString("base64url") +
  ".signature";
const apiKey = Buffer.from(
  JSON.stringify({
    email: "user@example.test",
    password: "sensitive-password",
  }),
).toString("base64");
const env = {
  TIANGONG_LCA_API_BASE_URL: "https://api.example.test/functions/v1",
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "public-test",
  TIANGONG_LCA_API_KEY: apiKey,
};
const versionTool = async () => ({ code: 0, stdout: "11.24.0", stderr: "" });
const safe = (e) =>
  e.code === "auth_required" &&
  !JSON.stringify(e).includes("sensitive-password");

test("one session implementation is used by Calculation, readiness and Publication with explicit token precedence", async () => {
  const calc = await import("../../calculation/runtime/actor-session.mjs"),
    pub = await import("../../publication/lib/actor-session.mjs");
  assert.equal(calc.resolveActorAccessToken, resolveActorAccessToken);
  assert.equal(pub.resolveActorAccessToken, resolveActorAccessToken);
  const current = token();
  const input = { ...env, TIANGONG_LCA_ACCESS_TOKEN: current };
  Object.defineProperty(input, "TIANGONG_LCA_API_KEY", {
    get() {
      assert.fail("must not read bootstrap when a token exists");
    },
  });
  assert.equal(
    await resolveActorAccessToken({
      env: input,
      fetchImpl() {
        assert.fail("no network");
      },
    }),
    current,
  );
  for (const invalid of [
    token({ exp: 1 }),
    token({ role: "service_role" }),
    "malformed",
  ]) {
    let calls = 0;
    await assert.rejects(
      resolveActorAccessToken({
        env: { ...env, TIANGONG_LCA_ACCESS_TOKEN: invalid },
        fetchImpl() {
          calls++;
        },
      }),
      safe,
    );
    assert.equal(calls, 0);
  }
});

test("explicit acquisition and authentication use bounded fixed routes; input is immutable and no session secret is returned by diagnostics", async () => {
  const calls = [],
    current = token();
  const original = structuredClone(env);
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return Response.json(
      options.method === "POST"
        ? {
            access_token: current,
            refresh_token: "never-retain-refresh",
            user: { id },
          }
        : { id },
    );
  };
  const got = await resolveActorAccessToken({
    env,
    fetchImpl,
    allowBootstrap: true,
  });
  assert.equal(got, current);
  assert.deepEqual(env, original);
  assert.deepEqual(
    await authenticateUserSession({ env, accessToken: got, fetchImpl }),
    { actorId: id, authenticationVerified: true },
  );
  assert.deepEqual(
    calls.map(([url, opt]) => [url, opt.method]),
    [
      ["https://api.example.test/auth/v1/token?grant_type=password", "POST"],
      ["https://api.example.test/auth/v1/user", "GET"],
    ],
  );
  let invoked = 0;
  await assert.rejects(
    resolveActorAccessToken({
      env,
      allowBootstrap: false,
      fetchImpl() {
        invoked++;
      },
    }),
    safe,
  );
  assert.equal(invoked, 0);
});

test("unsafe login targets/public keys and rejected/oversized/stalled responses fail without leaking credentials or following redirects", async () => {
  for (const patch of [
    { TIANGONG_LCA_API_BASE_URL: "https://user:password@api.example.test" },
    { TIANGONG_LCA_API_BASE_URL: "https://api.example.test/other" },
    { TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "sb_secret_private" },
  ]) {
    await assert.rejects(
      resolveActorAccessToken({
        env: { ...env, ...patch },
        fetchImpl() {
          assert.fail("must reject before sending");
        },
      }),
      safe,
    );
  }
  for (const response of [
    () => new Response("sensitive-password", { status: 401 }),
    () => Response.json({ access_token: token({ role: "service_role" }) }),
    () => new Response("x".repeat(65537)),
    () =>
      new Response("redirect", {
        status: 302,
        headers: { Location: "https://other.test" },
      }),
  ])
    await assert.rejects(
      resolveActorAccessToken({ env, fetchImpl: async () => response() }),
      safe,
    );
  await assert.rejects(
    resolveActorAccessToken({
      env,
      timeoutMs: 20,
      fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
    }),
    safe,
  );
});

test("Publication check blocks missing session by default, explicit bootstrap verifies current user and manager with no write methods", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session140-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let logins = 0,
    users = 0,
    heads = 0;
  const current = token();
  const deps = {
    env,
    defaultFile: false,
    runTool: versionTool,
    fetchImpl: async (url, options) => {
      if (options.method === "POST") {
        logins++;
        assert.ok(url.endsWith("/auth/v1/token?grant_type=password"));
        return Response.json({ access_token: current });
      }
      users++;
      return Response.json({ id });
    },
    createPublicationActor(config) {
      assert.equal(config.accessToken, current);
      return {
        head: async () => {
          heads++;
          return null;
        },
        prepare() {
          assert.fail("no prepare");
        },
        approve() {
          assert.fail("no approve");
        },
        activate() {
          assert.fail("no activation");
        },
      };
    },
  };
  const missing = await checkEnvironment(
    { for: "publication", "output-dir": root },
    deps,
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.session.available, false);
  assert.equal(missing.operationPrerequisites.ready, false);
  assert.equal(logins + users + heads, 0);
  const remoteMissing = await checkEnvironment(
    { for: "publication", remote: true, "output-dir": root },
    deps,
  );
  assert.equal(remoteMissing.ok, false);
  assert.equal(logins + users + heads, 0);
  const verified = await checkEnvironment(
    {
      for: "publication",
      remote: true,
      "bootstrap-session": true,
      "output-dir": root,
    },
    deps,
  );
  assert.equal(verified.ok, true);
  assert.deepEqual([logins, users, heads], [1, 1, 1]);
  assert.equal(verified.operationPrerequisites.ready, true);
  assert.equal(
    verified.operationPrerequisites.businessExecutionAuthorized,
    false,
  );
  assert.equal(verified.session.authenticationVerified, true);
  for (const secret of [current, apiKey, "sensitive-password"])
    assert.ok(!JSON.stringify(verified).includes(secret));
  const denied = await checkEnvironment(
    {
      for: "publication",
      remote: true,
      "bootstrap-session": true,
      "output-dir": root,
    },
    {
      ...deps,
      createPublicationActor: () => ({
        head: async () => {
          throw Object.assign(new Error("private-denial"), {
            code: "final_actor_request_denied",
          });
        },
      }),
    },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.operationPrerequisites.ready, false);
  const partial = await checkEnvironment(
    { for: "publication", "output-dir": root },
    { ...deps, env: { ...env, TIANGONG_LCA_ACCESS_TOKEN: current } },
  );
  assert.equal(partial.ok, true);
  assert.equal(partial.operationPrerequisites.ready, false);
});

test("doctor requires explicit login opt-in and returns exact non-secret continuation; Publication bootstrap survives generated commands", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session140-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "operator.env");
  await writeFile(
    file,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const original = await readFile(file);
  let output = "";
  const stream = {
    write(s) {
      output += s;
    },
  };
  const exit = await runEnvironmentCli(
    ["check", "--for", "publication", "--config-env", file, "--json"],
    { stdout: stream, stderr: stream, env: {}, runTool: versionTool },
  );
  assert.equal(exit, 1);
  const result = JSON.parse(output);
  assert.ok(result.nextActions[0].argv.includes("--bootstrap-session"));
  assert.ok(!output.includes(apiKey));
  const context = await configureReleaseCli(
    "publication",
    [
      "result-publication",
      "status",
      "--config-env",
      file,
      "--bootstrap-session",
    ],
    { env: {}, defaultFile: false },
  );
  const cli = fileURLToPath(
    new URL("../../publication/cli.mjs", import.meta.url),
  );
  const p = {
    nextActions: [
      {
        argv: ["node", cli, "result-publication", "status"],
        command: "status",
      },
    ],
  };
  attachReleaseConfiguration(p, context);
  assert.ok(p.nextActions[0].argv.includes("--bootstrap-session"));
  assert.ok(!JSON.stringify(p).includes(apiKey));
  assert.deepEqual(await readFile(file), original);
  await assert.rejects(
    checkEnvironment(
      { for: "publication", "bootstrap-session": true },
      { env: {}, runTool: versionTool },
    ),
    { code: "final_environment_arguments_invalid" },
  );
});
