import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../cli.mjs";

const jwt =
  "header." +
  Buffer.from(
    JSON.stringify({
      role: "authenticated",
      sub: "123e4567-e89b-42d3-a456-426614174000",
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString("base64url") +
  ".signature";

const env = {
  TIANGONG_LCA_DATA_PRODUCT_COMMAND_URL:
    "https://example.supabase.co/functions/v1/app_data_product_commands",
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  TIANGONG_LCA_ACCESS_TOKEN: jwt,
};

const externalResultSet = {
  schemaVersion: "lcia.result-set.v1",
  resultSetId: "123e4567-e89b-42d3-a456-426614174000",
  name: "Steel baseline",
  createdAt: "2026-08-18T08:00:00.000Z",
};

function outputBuffer() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += chunk;
      },
    },
    value: () => value,
  };
}

test("help keeps the CLI inside the Calculation workflow", async () => {
  const stdout = outputBuffer();
  const exitCode = await runCli(["--help"], { stdout: stdout.stream });
  assert.equal(exitCode, 0);
  assert.match(
    stdout.value(),
    /Manage the ResultSet entry point owned by workflows\/calculation/,
  );
  assert.doesNotMatch(stdout.value(), /tiangong-release calculation/);
  assert.match(stdout.value(), /safe to copy from any/);
  assert.doesNotMatch(stdout.value(), /npm --prefix workflows\/calculation/);
});

test("public help and returned recovery commands are cwd-independent", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "calculation-cli-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cli = new URL("../cli.mjs", import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname, "--help"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(
    help.stdout,
    new RegExp(cli.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  const recommendation = spawnSync(
    process.execPath,
    [cli.pathname, "result-set", "create", "--format", "json"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(recommendation.status, 3);
  const payload = JSON.parse(recommendation.stdout);
  assert.match(
    payload.nextActions[0],
    new RegExp(cli.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(payload.nextActions[0], /npm --prefix/);
});

test("list emits clean bounded JSON with a usable next action", async () => {
  const stdout = outputBuffer();
  const exitCode = await runCli(
    ["result-set", "list", "--limit", "1", "--format", "json"],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async () =>
        Response.json({
          ok: true,
          command: "lcia_result_sets_list",
          data: {
            items: [
              {
                ...externalResultSet,
                schemaVersion: "provider.result-set.v2",
                additiveField: true,
              },
            ],
          },
        }),
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(exitCode, 0);
  assert.equal(result.schemaVersion, "tiangong.calculation-cli-result.v1");
  assert.equal(result.completeness.status, "bounded");
  assert.equal(result.completeness.mayHaveMore, true);
  assert.deepEqual(result.data.items[0], {
    id: externalResultSet.resultSetId,
    name: externalResultSet.name,
    createdAt: externalResultSet.createdAt,
    source: {
      system: "tiangong-lca",
      externalSchemaVersion: "provider.result-set.v2",
    },
  });
  assert.match(result.nextActions[0], /result-set get/);
  assert.equal(result.replyTemplate.id, "result-set-listed");
  assert.equal(
    result.replyTemplate.path,
    "workflows/calculation/reply-templates/result-set-listed.md",
  );
});

test("create requires confirmation before configuration or network access", async () => {
  const stdout = outputBuffer();
  let calls = 0;
  const exitCode = await runCli(
    ["result-set", "create", "--name", "Steel baseline", "--format", "json"],
    {
      stdout: stdout.stream,
      env: {},
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(exitCode, 3);
  assert.equal(result.error.code, "confirmation_required");
  assert.equal(calls, 0);
});

test("create without a name recommends one before configuration or network access", async () => {
  const stdout = outputBuffer();
  let calls = 0;
  const exitCode = await runCli(["result-set", "create", "--format", "json"], {
    stdout: stdout.stream,
    env: {},
    now: () => new Date("2026-08-18T08:34:00.000Z"),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });
  const result = JSON.parse(stdout.value());
  assert.equal(exitCode, 3);
  assert.equal(result.error.code, "result_set_name_confirmation_required");
  assert.equal(result.error.details.recommendedName, "ResultSet-20260818-1634");
  assert.match(
    result.nextActions[0],
    /--name ResultSet-20260818-1634 --confirm-create/,
  );
  assert.equal(result.replyTemplate.id, "result-set-name-recommended");
  assert.equal(calls, 0);
});

test("create persists the exact remote identity and returns its path", async (t) => {
  const contextRoot = await mkdtemp(
    path.join(os.tmpdir(), "release-result-set-cli-"),
  );
  t.after(() => rm(contextRoot, { recursive: true, force: true }));
  const stdout = outputBuffer();
  const exitCode = await runCli(
    [
      "result-set",
      "create",
      "--name",
      "Steel baseline",
      "--confirm-create",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      contextRoot,
      fetchImpl: async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), {
          action: "create_result_set",
          name: "Steel baseline",
        });
        return Response.json({
          ok: true,
          command: "lcia_result_set_create",
          data: externalResultSet,
        });
      },
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(exitCode, 0);
  assert.equal(result.data.id, externalResultSet.resultSetId);
  assert.equal(result.data.schemaVersion, undefined);
  assert.match(result.contextPath, /\.json$/);
  assert.equal(result.warnings[0].code, "create_not_idempotent");
  assert.equal(result.nextDecision.kind, "confirm_closure_start");
  assert.equal(result.nextDecision.requiresConfirmation, true);
  assert.deepEqual(result.nextDecision.defaults, {
    coverageMode: "global_eligible",
    lciaMethodCount: 25,
  });
  assert.match(result.nextActions[0], /closure start/);
  assert.match(
    result.nextActions[0],
    new RegExp(externalResultSet.resultSetId),
  );
  assert.match(result.nextActions[0], /--confirm-start/);
});

test("confirmation failures recover the command that actually requested confirmation", async () => {
  const stdout = outputBuffer();
  const exitCode = await runCli(
    [
      "closure",
      "start",
      "--result-set-id",
      externalResultSet.resultSetId,
      "--idempotency-token",
      "closure-token",
      "--format",
      "json",
    ],
    { stdout: stdout.stream, env: {} },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(exitCode, 3);
  assert.match(result.nextActions[0], /closure.*start/);
  assert.match(result.nextActions[0], /--confirm-start/);
  assert.doesNotMatch(result.nextActions[0], /--confirm-create/);
});

test("invalid exact-ID input is rejected before configuration or network access", async () => {
  const stdout = outputBuffer();
  const exitCode = await runCli(
    [
      "result-set",
      "get",
      "--result-set-id",
      "Steel baseline",
      "--format",
      "json",
    ],
    { stdout: stdout.stream, env: {} },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(exitCode, 2);
  assert.equal(result.error.code, "invalid_request");
  assert.match(result.error.message, /exact UUID/);
});
