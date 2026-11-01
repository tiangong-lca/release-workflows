import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, access, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finalResultFailure } from "../lib/final-result-command.mjs";
import { replyTemplateFor } from "../reply-template-registry.mjs";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
test("Result command help identifies the sole remote mutation and remains cwd-independent", async () => {
  for (const action of ["intake", "inspect", "register", "build", "verify"]) {
    const result = await exec(
      process.execPath,
      [cli, "result", action, "--help"],
      { cwd: os.tmpdir() },
    );
    assert.match(result.stdout, /protected CONN/);
    assert.match(result.stdout, /no publication/);
    assert.match(result.stdout, /--confirm-input-sha256/);
    const template = replyTemplateFor(`result ${action}`, { ok: true });
    const body = await readFile(
      fileURLToPath(
        new URL("../reply-templates/final-result-workflow.md", import.meta.url),
      ),
      "utf8",
    );
    for (const fact of template.requiredFacts)
      assert.ok(body.includes(`{{${fact}}}`));
  }
});
test("Result build requests an explicit two-package filename version without reading input or creating output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-result-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = path.join(root, "candidate");
  const result = await exec(process.execPath, [
    cli,
    "result",
    "build",
    "--final-input",
    path.join(root, "missing"),
    "--confirm-input-sha256",
    "a".repeat(64),
    "--out-dir",
    out,
    "--json",
  ]);
  const value = JSON.parse(result.stdout);
  assert.equal(value.outcome, "release_version_confirmation_required");
  assert.equal(value.fileNames.length, 2);
  assert.ok(value.fileNames.every((f) => f.includes("ResultDatabase")));
  assert.equal(value.publicationAuthorized, false);
  assert.equal(value.nextActions[0].argv[1], cli);
  await assert.rejects(access(out), { code: "ENOENT" });
});
test("Result CLI rejects unknown, duplicate and unrelated options with one JSON error", async () => {
  for (const args of [
    ["result", "verify", "--candidate", "x", "--wat", "x"],
    ["result", "verify", "--candidate", "x", "--candidate", "x"],
    ["result", "verify", "--candidate", "x", "--execution", "remote"],
  ]) {
    let caught;
    try {
      await exec(process.execPath, [cli, ...args, "--json"]);
    } catch (e) {
      caught = e;
    }
    assert.equal(caught.code, 1);
    assert.equal(caught.stdout, "");
    const result = JSON.parse(caught.stderr);
    assert.equal(result.ok, false);
    assert.equal(result.publicationAuthorized, false);
    assert.ok(result.nextActions[0].command.includes("result verify --help"));
  }
});
test("Result error DTO strips private provider content and preserves exact local recovery paths", () => {
  const r = finalResultFailure(
    Object.assign(new Error("password=secret-canary postgresql://private"), {
      code: "final_identity_outcome_unknown",
      details: {
        connection: "secret-canary",
        retainedInput: "/tmp/exact-input",
        stdout: "secret-canary",
      },
    }),
  );
  assert.equal(r.code, "final_identity_outcome_unknown");
  assert.equal(r.details.retainedInput, "/tmp/exact-input");
  assert.ok(!JSON.stringify(r).includes("secret-canary"));
  assert.match(r.message, /identical content/);
});
