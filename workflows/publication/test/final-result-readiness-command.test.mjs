import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runFinalResultReadinessCommand as run } from "../lib/final-result-readiness-command.mjs";
import { replyTemplateFor } from "../reply-template-registry.mjs";
const id = "00000000-0000-0000-0000-000000000001",
  hash = "a".repeat(64);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const env = {
  CONN: "postgresql://operator:never-print-db-secret@127.0.0.1:61432/postgres",
  S3_ENDPOINT: "http://127.0.0.1:60001",
  S3_REGION: "us-east-1",
  S3_BUCKET: "synthetic-results",
  S3_ACCESS_KEY_ID: "never-print-access",
  S3_SECRET_ACCESS_KEY: "never-print-secret",
  TIANGONG_LCA_API_BASE_URL: "http://127.0.0.1:60002",
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "synthetic-key",
  TIANGONG_LCA_ACCESS_TOKEN: "never-print-actor",
  RESULT_QUERY_ENDPOINT: "http://127.0.0.1:60003",
  RESULT_QUERY_SERVICE_SECRET: "never-print-service-secret",
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "readiness-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "candidate"));
  await mkdir(path.join(root, "input"));
  const options = {
      candidate: path.join(root, "candidate"),
      "final-input": path.join(root, "input"),
      "run-id": id,
      "publish-plan-hash": hash,
      "out-dir": path.join(root, "output"),
    },
    calls = [];
  const deps = {
    env,
    createActor: () => ({ actorId: id }),
    createReader: () => ({}),
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
        async close() {
          calls.push("db-close");
        },
      };
    },
    verify: async ({ verificationId, record }) => {
      const attempt = JSON.parse(
        await readFile(path.join(options["out-dir"], "command-attempt.json")),
      );
      assert.equal(attempt.verificationId, verificationId);
      await record({
        schemaVersion: "tiangong.final-result-readiness-local-attempt.v1",
        verificationId,
      });
      await record({ kind: "header", header: { verificationId } });
      await record({
        kind: "artifact",
        verificationId,
        proof: { artifact: { artifactId: id } },
      });
      const receipt = {
        verificationId,
        releaseRunId: id,
        publishPlanHash: hash,
        candidateHash: hash,
        targetHash: hash,
        artifactCount: 1,
        probeCount: 2,
        fileCount: 9,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        publicationAuthorized: false,
      };
      await record({ kind: "sealed", receipt });
      return receipt;
    },
  };
  return { root, options, deps, calls };
}
test("successful command persists private immutable evidence before returning bounded non-publication summary", async (t) => {
  const f = await fixture(t);
  Object.defineProperty((f.deps.env = { ...env }), "TIANGONG_LCA_API_KEY", {
    get() {
      throw new Error("must not bootstrap");
    },
  });
  const result = await run("verify", f.options, f.deps);
  assert.equal(result.publicationAuthorized, false);
  assert.equal(
    result.completeness,
    "readiness_verified_actor_approval_pending",
  );
  const receipt = JSON.parse(await readFile(result.artifacts.readinessReceipt));
  assert.equal(receipt.verificationId, result.verificationId);
  for (const name of [
    "command-attempt.json",
    "readiness-attempt.json",
    "readiness-header.json",
    `proofs/${id}.json`,
    "readiness-receipt.json",
  ]) {
    const file = path.join(f.options["out-dir"], name);
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /never-print|postgresql:/,
    );
    if (process.platform !== "win32")
      assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  if (process.platform !== "win32")
    assert.equal((await stat(f.options["out-dir"])).mode & 0o777, 0o700);
  assert.deepEqual(f.calls, ["s3", "db", "db-close", "s3-close"]);
  assert.doesNotMatch(JSON.stringify(result), /never-print|127\.0\.0\.1/);
  const template = replyTemplateFor(result.command, { ok: true });
  for (const key of template.requiredFacts)
    assert.ok(Object.hasOwn(result, key));
  await assert.rejects(run("verify", f.options, f.deps), {
    code: "output_exists",
  });
  assert.equal(f.calls.length, 4);
});
test("missing explicit environment and credential options fail without remote clients", async (t) => {
  const f = await fixture(t);
  for (const key of Object.keys(env)) {
    const missing = { ...env };
    delete missing[key];
    await assert.rejects(
      run("verify", f.options, { ...f.deps, env: missing }),
      (e) => e.details.missingEnvironment === key,
    );
  }
  await assert.rejects(
    run("verify", { ...f.options, "access-token": "never-print" }, f.deps),
    { code: "invalid_arguments" },
  );
  assert.deepEqual(f.calls, []);
  await assert.rejects(stat(f.options["out-dir"]), { code: "ENOENT" });
});
test("evidence cannot be placed inside frozen input or Candidate including symlink aliases", async (t) => {
  const f = await fixture(t);
  for (const root of [f.options.candidate, f.options["final-input"]]) {
    await assert.rejects(
      run(
        "verify",
        { ...f.options, "out-dir": path.join(root, "evidence") },
        f.deps,
      ),
      { code: "final_storage_output_inside_candidate" },
    );
  }
  if (process.platform !== "win32") {
    const alias = path.join(f.root, "alias");
    await symlink(f.options["final-input"], alias);
    await assert.rejects(
      run(
        "verify",
        { ...f.options, "out-dir": path.join(alias, "new", "evidence") },
        f.deps,
      ),
      { code: "final_storage_output_inside_candidate" },
    );
  }
  assert.deepEqual(f.calls, []);
});
test("unknown remote failure preserves sanitized attempt and executable fresh-directory recovery", async (t) => {
  const f = await fixture(t);
  let oldId;
  await assert.rejects(
    run("verify", f.options, {
      ...f.deps,
      verify: async ({ verificationId }) => {
        oldId = verificationId;
        throw Object.assign(new Error(env.CONN), {
          code: "final_storage_registry_outcome_unknown",
          details: { raw: env.TIANGONG_LCA_ACCESS_TOKEN },
        });
      },
    }),
    (e) => {
      assert.equal(e.code, "final_storage_registry_outcome_unknown");
      assert.equal(e.details.attemptCreated, true);
      assert.doesNotMatch(JSON.stringify(e), /never-print/);
      assert.ok(
        e.nextActions[0].argv.includes(`${f.options["out-dir"]}-retry`),
      );
      return true;
    },
  );
  assert.doesNotMatch(
    await readFile(path.join(f.options["out-dir"], "failure.json"), "utf8"),
    /never-print|postgresql:/,
  );
  await assert.rejects(
    stat(path.join(f.options["out-dir"], "readiness-receipt.json")),
    { code: "ENOENT" },
  );
  // The mock uses the output path to assert durable attempt order on each invocation.
  f.options["out-dir"] += "-retry";
  const result = await run("verify", f.options, f.deps);
  assert.notEqual(result.verificationId, oldId);
});
test("sealed evidence must bind the run and plan, and the return value must equal the persisted seal", async (t) => {
  for (const mode of ["wrong-run", "missing-seal", "different-return"]) {
    const f = await fixture(t);
    await assert.rejects(
      run("verify", f.options, {
        ...f.deps,
        verify: async (args) => {
          const r = {
            verificationId: args.verificationId,
            releaseRunId: mode === "wrong-run" ? "bad" : id,
            publishPlanHash: hash,
            publicationAuthorized: false,
          };
          if (mode !== "missing-seal")
            await args.record({ kind: "sealed", receipt: r });
          return mode === "different-return" ? { ...r, extra: true } : r;
        },
      }),
      { code: "final_readiness_command_invalid" },
    );
    if (mode !== "different-return")
      await assert.rejects(
        stat(path.join(f.options["out-dir"], "readiness-receipt.json")),
        { code: "ENOENT" },
      );
  }
});
test("duplicate or invalid proof filenames stop instead of replacing evidence", async (t) => {
  for (const artifactId of [id, "../../outside"]) {
    const f = await fixture(t);
    await assert.rejects(
      run("verify", f.options, {
        ...f.deps,
        verify: async ({ verificationId, record }) => {
          const e = {
            kind: "artifact",
            verificationId,
            proof: { artifact: { artifactId } },
          };
          await record(e);
          await record(e);
        },
      }),
    );
    await assert.rejects(
      stat(path.join(f.options["out-dir"], "readiness-receipt.json")),
      { code: "ENOENT" },
    );
  }
});
test("client construction failure retains attempt, cleans owned clients and hides provider error", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    run("verify", f.options, {
      ...f.deps,
      createRegistry: () => {
        throw new Error(env.CONN);
      },
    }),
    (e) =>
      e.code === "final_readiness_command_failed" &&
      !e.message.includes("never-print"),
  );
  assert.deepEqual(f.calls, ["s3", "s3-close"]);
  assert.ok(
    JSON.parse(await readFile(path.join(f.options["out-dir"], "failure.json"))),
  );
});
test("actual CLI help and missing arguments have stable machine-readable responses", async () => {
  const exec = promisify(execFile);
  const help = await exec(process.execPath, [
    cli,
    "result-readiness",
    "verify",
    "--help",
  ]);
  assert.match(help.stdout, /RESULT_QUERY_SERVICE_SECRET/);
  await assert.rejects(
    exec(process.execPath, [cli, "result-readiness", "verify", "--json"], {
      env: { PATH: process.env.PATH },
    }),
    (e) => {
      const reply = JSON.parse(e.stderr);
      assert.equal(reply.ok, false);
      assert.equal(reply.error.code, "final_readiness_command_invalid");
      return true;
    },
  );
});
