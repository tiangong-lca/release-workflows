import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { candidateNextDecision } from "../lib/next-decision.mjs";

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
    /Derived Result consumption.*Result-only Candidate packaging are not implemented/,
  );
});
