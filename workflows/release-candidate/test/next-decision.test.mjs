import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  candidateNextDecision,
  intakeContinuation,
} from "../lib/next-decision.mjs";

test("Candidate next choices reach real read-only help from another cwd", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "release-navigation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const decision = candidateNextDecision();
  assert.equal(decision.required, true);
  for (const choice of decision.choices) {
    assert.equal(choice.availability, "available");
    assert.ok(path.isAbsolute(choice.argv[1]));
    const result = spawnSync(process.execPath, choice.argv.slice(1), {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      choice.workflow === "publication" ? /plan prepare/ : /dsl inspect/,
    );
    assert.deepEqual(await readdir(cwd), []);
  }
  const transformation = decision.choices.find(
    ({ workflow }) => workflow === "dataset-transformation",
  );
  assert.match(transformation.description, /handoff, not a new Candidate/);
  assert.match(
    transformation.description,
    /result intake\/inspect\/freeze\/build.*v2 publication adapter remains required/,
  );
});

test("Release Intake selects paired deliverables explicitly and never silently defaults to ZIP-only", () => {
  const input = {
    releaseIntake: "/tmp/a path/intake",
    outputRoot: "/tmp/release",
  };
  const choice = intakeContinuation(input);
  assert.equal(choice.nextDecision.required, true);
  assert.deepEqual(choice.nextActions, []);
  assert.deepEqual(
    choice.nextDecision.choices.map((c) => c.id),
    ["result-zip-hdf5", "legacy-four-zips"],
  );
  for (const deliveryFormat of ["result-zip-hdf5", "legacy-four-zips"]) {
    const selected = intakeContinuation({ ...input, deliveryFormat });
    assert.equal(selected.nextDecision.required, false);
    assert.equal(selected.nextActions.length, 1);
    const action = selected.nextActions[0];
    assert.ok(path.isAbsolute(action.argv[1]));
    assert.equal(
      action.argv[action.argv.indexOf("--release-intake") + 1],
      input.releaseIntake,
    );
    assert.deepEqual(
      action.argv.slice(2, 4),
      deliveryFormat === "result-zip-hdf5"
        ? ["result", "intake"]
        : ["package", "build"],
    );
    const help = spawnSync(
      process.execPath,
      [...action.argv.slice(1), "--help"],
      { cwd: os.tmpdir(), encoding: "utf8" },
    );
    assert.equal(help.status, 0, help.stderr);
  }
  assert.throws(
    () => intakeContinuation({ ...input, deliveryFormat: "unknown" }),
    { code: "invalid_arguments" },
  );
});

test("deliverable selector rejects invalid or misplaced choices before reading inputs", () => {
  const cli = intakeContinuation({
    releaseIntake: "/missing",
    outputRoot: "/missing",
  }).nextDecision.choices[0].argv[1];
  for (const args of [
    [
      "intake",
      "prepare",
      "--materialization",
      "/missing",
      "--source-intake",
      "/missing",
      "--out-dir",
      "/missing",
      "--delivery-format",
      "invalid",
    ],
    ["package", "build", "--delivery-format", "result-zip-hdf5"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
      cwd: os.tmpdir(),
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stderr).error.code, "invalid_arguments");
    assert.equal(result.stdout, "");
  }
});
