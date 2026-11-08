import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hashJson } from "../lib/common.mjs";
import {
  runFinalResultStorageCommand,
  finalResultStorageEnvironment,
} from "../lib/final-result-storage-command.mjs";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const environment = {
  CONN: "postgresql://operator:never-print-db-secret@127.0.0.1:61432/postgres",
  S3_ENDPOINT: "http://127.0.0.1:60001",
  S3_REGION: "us-east-1",
  S3_BUCKET: "synthetic-results",
  S3_ACCESS_KEY_ID: "never-print-access",
  S3_SECRET_ACCESS_KEY: "never-print-s3-secret",
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "storage-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "candidate"));
  const plan = {
    schemaVersion: "tiangong.final-result-storage-plan.v1",
    targetHash: finalResultStorageEnvironment(environment).targetHash,
    candidateHash: "a".repeat(64),
    inputHash: "b".repeat(64),
    resultCount: 2,
    memberCount: 3,
    artifacts: [],
    files: [],
    publicationAuthorized: false,
  };
  const planHash = hashJson(plan),
    calls = [];
  return {
    root,
    plan,
    planHash,
    calls,
    options: {
      candidate: path.join(root, "candidate"),
      "out-dir": path.join(root, "output"),
    },
    dependencies: {
      env: environment,
      inspect: async () => ({ plan, planHash }),
      createObjectStore: () => {
        calls.push("s3");
        return {
          close() {
            calls.push("s3-close");
          },
        };
      },
      createRegistry: () => {
        calls.push("db");
        return {
          close() {
            calls.push("db-close");
          },
        };
      },
      execute: async () => {
        calls.push("execute");
        return {
          planHash,
          candidateHash: plan.candidateHash,
          targetHash: plan.targetHash,
          publicationAuthorized: false,
          multipartCleanupRequired: false,
        };
      },
    },
  };
}
test("inspection requires no storage credentials or clients and its exact plan bytes are confirmable", async (t) => {
  const f = await fixture(t),
    env = { ...environment };
  Object.defineProperty(env, "S3_SECRET_ACCESS_KEY", {
    get() {
      throw new Error("inspection must not read credential");
    },
  });
  const result = await runFinalResultStorageCommand("inspect", f.options, {
    ...f.dependencies,
    env,
  });
  assert.deepEqual(f.calls, []);
  assert.equal(result.publicationAuthorized, false);
  assert.equal(
    createHash("sha256")
      .update(await readFile(result.artifacts.storagePlan))
      .digest("hex"),
    result.storagePlanHash,
  );
  assert.equal(result.nextActions[0].argv[1], cli);
  assert.equal(
    result.nextActions[0].argv[
      result.nextActions[0].argv.indexOf("--candidate") + 1
    ],
    path.resolve(f.options.candidate),
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /never-print|127\.0\.0\.1|synthetic-results/,
  );
  assert.doesNotMatch(
    await readFile(result.artifacts.storageTarget, "utf8"),
    /never-print|postgresql:/,
  );
});
test("confirmation and output collision fail before any remote client is created", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runFinalResultStorageCommand(
      "execute",
      { ...f.options, confirm: "0".repeat(64) },
      f.dependencies,
    ),
    { code: "final_storage_confirmation_mismatch" },
  );
  await assert.rejects(stat(f.options["out-dir"]), { code: "ENOENT" });
  await runFinalResultStorageCommand("inspect", f.options, f.dependencies);
  await assert.rejects(
    runFinalResultStorageCommand(
      "execute",
      { ...f.options, confirm: f.planHash },
      f.dependencies,
    ),
    { code: "final_storage_output_exists" },
  );
  assert.deepEqual(f.calls, []);
});
test("preflight queries only the exact database identity, without storage credentials or upload clients", async (t) => {
  const f = await fixture(t);
  const env = { ...environment };
  Object.defineProperty(env, "S3_SECRET_ACCESS_KEY", {
    get() {
      throw new Error("no secret needed for preflight");
    },
  });
  const result = await runFinalResultStorageCommand("preflight", f.options, {
    ...f.dependencies,
    env,
    createRegistry: () => ({
      databaseTargetHash:
        finalResultStorageEnvironment(environment).target.databaseTargetHash,
      async describeCandidate(candidate, target) {
        f.calls.push("read");
        assert.equal(candidate, f.plan.candidateHash);
        assert.equal(target, f.plan.targetHash);
        return null;
      },
      async close() {
        f.calls.push("close");
      },
    }),
  });
  assert.deepEqual(f.calls, ["read", "close"]);
  assert.equal(result.uploadAttempted, false);
  assert.equal(result.registryWriteAttempted, false);
  assert.deepEqual(result.nextActions, []);
  const report = JSON.parse(await readFile(result.artifacts.storagePreflight));
  assert.equal(report.candidateRegistered, false);
  assert.doesNotMatch(
    JSON.stringify(result) + JSON.stringify(report),
    /never-print|postgresql:/,
  );
});
test("TLS preflight failure retains safe diagnostics and never suggests an unchanged upload retry", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runFinalResultStorageCommand("preflight", f.options, {
      ...f.dependencies,
      createRegistry: () => ({
        databaseTargetHash:
          finalResultStorageEnvironment(environment).target.databaseTargetHash,
        async describeCandidate() {
          throw Object.assign(new Error(environment.CONN), {
            code: "final_publication_database_tls_failed",
            details: {
              databaseStage: "connect",
              databaseCode: "SELF_SIGNED_CERT_IN_CHAIN",
              sqlState: null,
              raw: environment.CONN,
            },
          });
        },
        async close() {
          f.calls.push("close");
        },
      }),
    }),
    (error) => {
      assert.equal(error.code, "final_publication_database_tls_failed");
      assert.equal(error.details.phase, "database_preflight");
      assert.equal(error.details.databaseCode, "SELF_SIGNED_CERT_IN_CHAIN");
      assert.equal(error.details.uploadAttempted, false);
      assert.deepEqual(error.nextActions, []);
      assert.match(error.message, /RELEASE_DATABASE_CA_FILE/);
      assert.doesNotMatch(JSON.stringify(error), /never-print|postgresql:/);
      return true;
    },
  );
  assert.deepEqual(f.calls, ["close"]);
  const failure = await readFile(
    path.join(f.options["out-dir"], "storage-failure.json"),
    "utf8",
  );
  assert.equal(
    JSON.parse(failure).remoteOutcome,
    "read-only-preflight-no-upload-or-registry-write",
  );
  assert.doesNotMatch(failure, /never-print|postgresql:/);
});
test("remote failure retains sanitized evidence and closes both clients; no success marker exists", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runFinalResultStorageCommand(
      "execute",
      { ...f.options, confirm: f.planHash },
      {
        ...f.dependencies,
        execute: async () => {
          throw Object.assign(new Error("never-print-provider-secret"), {
            code: "final_storage_registry_outcome_unknown",
            details: { multipartCleanupRequired: true, raw: environment.CONN },
          });
        },
      },
    ),
    (error) =>
      error.code === "final_storage_registry_outcome_unknown" &&
      error.details.attemptRetained &&
      error.details.multipartCleanupRequired &&
      !JSON.stringify(error).includes("never-print"),
  );
  const failure = await readFile(
    path.join(f.options["out-dir"], "storage-failure.json"),
    "utf8",
  );
  assert.doesNotMatch(failure, /never-print|postgresql:/);
  assert.equal(JSON.parse(failure).publicationAuthorized, false);
  assert.equal(
    JSON.parse(failure).remoteOutcome,
    "reconcile-exact-identity-before-retry",
  );
  await assert.rejects(
    stat(path.join(f.options["out-dir"], "storage-receipt.json")),
    { code: "ENOENT" },
  );
  assert.deepEqual(f.calls, ["s3", "db", "s3-close", "db-close"]);
});
test("client construction failure closes the already-created client and never leaks provider text", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runFinalResultStorageCommand(
      "execute",
      { ...f.options, confirm: f.planHash },
      {
        ...f.dependencies,
        createRegistry: () => {
          throw new Error(environment.CONN);
        },
      },
    ),
    (error) =>
      error.code === "final_storage_command_failed" &&
      !error.message.includes("never-print"),
  );
  assert.deepEqual(f.calls, ["s3", "s3-close"]);
});
test("storage command rejects actor-recipe options and never treats storage success as publication", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runFinalResultStorageCommand(
      "inspect",
      { ...f.options, "approved-by": "synthetic" },
      f.dependencies,
    ),
    { code: "invalid_arguments" },
  );
  const result = await runFinalResultStorageCommand(
    "execute",
    { ...f.options, confirm: f.planHash },
    f.dependencies,
  );
  assert.equal(result.outcome, "final_result_storage_verified");
  assert.equal(
    result.completeness,
    "storage_verified_publication_adapter_pending",
  );
  assert.equal(result.publicationAuthorized, false);
  assert.deepEqual(result.nextActions, []);
  assert.equal(
    JSON.parse(await readFile(result.artifacts.storageReceipt, "utf8"))
      .planHash,
    f.planHash,
  );
});
test("evidence cannot be written into the frozen Candidate through nested paths or symlink aliases", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "candidate-link");
  await symlink(
    f.options.candidate,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const outDir of [
    path.join(f.options.candidate, "plans/new"),
    path.join(alias, "plans/new"),
  ]) {
    await assert.rejects(
      runFinalResultStorageCommand(
        "execute",
        { ...f.options, "out-dir": outDir, confirm: f.planHash },
        f.dependencies,
      ),
      { code: "final_storage_output_inside_candidate" },
    );
  }
  assert.deepEqual(f.calls, []);
});
test("actual CLI dispatch offers both storage actions and reports missing environment without reading .env", async () => {
  const help = await exec(
    process.execPath,
    [cli, "result-storage", "inspect", "--help"],
    { cwd: tmpdir(), env: {} },
  );
  assert.match(help.stdout, /result-storage execute/);
  try {
    await exec(
      process.execPath,
      [
        cli,
        "result-storage",
        "inspect",
        "--candidate",
        "/synthetic",
        "--out-dir",
        "/synthetic-output",
        "--json",
      ],
      { cwd: tmpdir(), env: {} },
    );
    assert.fail("expected missing environment");
  } catch (error) {
    const result = JSON.parse(error.stderr);
    assert.equal(result.error.code, "final_storage_environment_required");
    assert.equal(result.error.details.missingEnvironment, "CONN");
    assert.equal(result.replyTemplate.id, "publication-command-failed");
    assert.equal(error.stdout, "");
  }
});

test("size rejection preserves safe context without an unchanged retry command", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runFinalResultStorageCommand(
      "execute",
      { ...f.options, confirm: f.planHash },
      {
        ...f.dependencies,
        execute: async () => {
          throw Object.assign(new Error("provider-secret-never-log"), {
            code: "final_storage_object_too_large",
            details: {
              fileName: "result.ilcd.7z",
              byteSize: 999,
              stage: "upload_part",
              httpStatus: 413,
              multipartCleanupRequired: false,
              raw: environment.CONN,
            },
          });
        },
      },
    ),
    (error) => {
      assert.equal(error.code, "final_storage_object_too_large");
      assert.match(error.message, /do not retry unchanged/u);
      assert.deepEqual(error.nextActions, []);
      assert.equal(error.details.fileName, "result.ilcd.7z");
      return true;
    },
  );
  const failure = await readFile(
    path.join(f.options["out-dir"], "storage-failure.json"),
    "utf8",
  );
  assert.doesNotMatch(failure, /provider-secret|postgresql:/u);
  assert.equal(
    JSON.parse(failure).remoteOutcome,
    "object-size-rejected-no-matching-object",
  );
});
