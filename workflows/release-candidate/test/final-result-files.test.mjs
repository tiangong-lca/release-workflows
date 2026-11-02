import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  access,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { commitFrozenDirectory } from "../lib/final-result-files.mjs";
test("a failed final-directory commit retains moved receipts and never exposes its qualification marker", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = path.join(root, "work"),
    target = path.join(root, "target");
  await mkdir(staging);
  await writeFile(path.join(staging, "a-receipt.json"), "immutable receipt");
  await writeFile(path.join(staging, "b-file.h5"), "successful file");
  await writeFile(path.join(staging, "qualified.json"), "qualification");
  let count = 0;
  await assert.rejects(
    commitFrozenDirectory(staging, target, "qualified.json", {
      move: async (from, to) => {
        if (++count === 2)
          throw Object.assign(new Error("synthetic disk failure"), {
            code: "EIO",
          });
        await rename(from, to);
      },
    }),
    (error) =>
      error.code === "EIO" && error.details.incompleteTarget === target,
  );
  assert.equal(
    await readFile(path.join(target, "a-receipt.json"), "utf8"),
    "immutable receipt",
  );
  assert.equal(
    await readFile(path.join(staging, "b-file.h5"), "utf8"),
    "successful file",
  );
  await assert.rejects(access(path.join(target, "qualified.json")), {
    code: "ENOENT",
  });
  await assert.rejects(
    commitFrozenDirectory(staging, target, "qualified.json"),
    { code: "EEXIST" },
  );
});
