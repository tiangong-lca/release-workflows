import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  compressResultPackage,
  extractSevenZip,
  inspectSevenZip,
  runSevenZip,
  withSevenZipReadback,
} from "../lib/seven-zip.mjs";

test("real solid 256 MiB 7z preserves every member, repeats bytes and cleans readback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "result-7z-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(path.join(source, "flows"), { recursive: true });
  const a = Buffer.from('{"name":"测试","value":-2.5}\n'.repeat(2000));
  const b = Buffer.from('{"name":"测试","value":0}\n'.repeat(2000));
  await writeFile(path.join(source, "flows/a.json"), a);
  await writeFile(path.join(source, "flows/b.json"), b);
  const zip = path.join(root, "input.zip");
  assert.equal(
    (
      await runSevenZip(
        ["a", "-tzip", "-mx=0", zip, "flows/a.json", "flows/b.json"],
        { cwd: source },
      )
    ).code,
    0,
  );
  const first = path.join(root, "first.7z"),
    second = path.join(root, "second.7z");
  await compressResultPackage(zip, first);
  await compressResultPackage(zip, second);
  assert.deepEqual(await readFile(first), await readFile(second));
  assert.deepEqual(
    (await readFile(first)).subarray(0, 6),
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  );
  const listing = await runSevenZip(["l", "-slt", first]);
  // 7-Zip reduces the dictionary to the input size for this tiny fixture.
  assert.match(listing.stdout, /Method = LZMA2:17/u);
  assert.match(listing.stdout, /Solid = \+/u);
  assert.equal((await inspectSevenZip(first)).memberCount, 2);
  let extracted;
  await withSevenZipReadback(first, async (dir) => {
    extracted = dir;
    assert.deepEqual(await readFile(path.join(dir, "flows/a.json")), a);
    assert.deepEqual(await readFile(path.join(dir, "flows/b.json")), b);
  });
  await assert.rejects(readFile(path.join(extracted, "flows/a.json")), {
    code: "ENOENT",
  });
  await assert.rejects(compressResultPackage(zip, first), {
    code: "output_exists",
  });
  await writeFile(path.join(root, "bad.7z"), "not an archive");
  await assert.rejects(
    extractSevenZip(path.join(root, "bad.7z"), path.join(root, "bad-readback")),
  );
});

test(
  "archive catalog rejects link members before extraction",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "result-7z-link-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "target.txt"), "target");
    await symlink("target.txt", path.join(root, "link"));
    const archive = path.join(root, "link.7z");
    assert.equal(
      (await runSevenZip(["a", "-snl", archive, "link"], { cwd: root })).code,
      0,
    );
    await assert.rejects(extractSevenZip(archive, path.join(root, "out")), {
      code: "final_archive_catalog_invalid",
    });
  },
);
