import test from "node:test";
import assert from "node:assert/strict";
import { inspectZipMembers } from "../lib/zip-members.mjs";
import { spawnBounded } from "../lib/package-build.mjs";

const count = 30000;
const runner =
  (first = "safe/first.json", code = 0) =>
  async (_command, _args, options) =>
    spawnBounded(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(first + "\n")}); for(let i=0;i<${count};i++)process.stdout.write('flows/00000000-0000-4000-8000-'+String(i).padStart(12,'0')+'.json\\n');process.exitCode=${code};`,
      ],
      options,
    );

test("complete ZIP listing exceeds diagnostic tail and retains the exact count", async () => {
  const result = await inspectZipMembers("fixture.zip", runner());
  assert.equal(result.valid, true);
  assert.equal(result.memberCount, count + 1);
});
test("unsafe first member is rejected even when absent from the diagnostic tail", async () => {
  for (const first of [
    "../outside",
    "/absolute",
    "\\absolute",
    "C:\\outside",
  ]) {
    const result = await inspectZipMembers("fixture.zip", runner(first));
    assert.equal(result.valid, false, first);
  }
});
test("split lines, CRLF, unterminated last member and failed commands are handled", async () => {
  const result = await inspectZipMembers("x", async (_c, _a, { onStdout }) => {
    for (const chunk of ["safe/na", "me\r", "\n", "last"]) onStdout(chunk);
    return { code: 0, stdout: "tail", stderr: "" };
  });
  assert.deepEqual(result, {
    code: 0,
    stderr: "",
    memberCount: 2,
    valid: true,
  });
  assert.equal((await inspectZipMembers("x", runner("safe", 2))).code, 2);
});
test("empty, truncated and overlong non-streaming catalogs fail closed", async () => {
  for (const output of [
    { stdout: "" },
    { stdout: "safe\n", stdoutTruncated: true },
    { stdout: "a".repeat(65536) },
  ]) {
    assert.equal(
      (
        await inspectZipMembers("x", async () => ({
          code: 0,
          stderr: "",
          ...output,
        }))
      ).valid,
      false,
    );
  }
});
