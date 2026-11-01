import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { canonicalJson } from "../lib/common.mjs";
import { buildFinalResultPair } from "../lib/final-result-pair.mjs";
import { runEncoder } from "../lib/final-result-artifacts.mjs";
import {
  RESULT_PACKAGE_PROFILE,
  verifyTidasRuntime,
  runTidas,
} from "../lib/package-build.mjs";
const encoder = fileURLToPath(
  new URL(
    `../native/target/debug/release-result-hdf5${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-result-pair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = JSON.parse(
    await readFile(
      new URL("./fixtures/paired-final-results.json", import.meta.url),
    ),
  );
  const canonicalRoot = path.join(root, "canonical");
  await mkdir(canonicalRoot);
  for (const r of f.records) {
    const file = path.join(canonicalRoot, r.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, canonicalJson(r.document));
  }
  return {
    root,
    canonicalRoot,
    index: f.index,
    results: f.results,
    outDir: path.join(root, "paired"),
    releaseVersion: "2026.11.1",
    encoder,
  };
}
function mockHandshake(profiles, schemas, calls) {
  return async (_cmd, args) => {
    calls.push(args);
    const report = {
      schema_version: "tidas.operation-report.v1",
      status: "succeeded",
      exit_class: "success",
      completeness: "complete",
      summary:
        args[0] === "version"
          ? {
              binary_version: "9.9.9",
              operation_report_schema: "tidas.operation-report.v1",
              release_build_profiles: profiles,
              release_report_schemas: schemas,
            }
          : {
              validation_describe: {
                schema_version: "tidas.validation-describe.v1",
                package: { name: "tidas", version: "9.9.9" },
                protocols: ["document-validation-batch.v1"],
              },
            },
    };
    return {
      code: 0,
      stdout: args.includes("--help")
        ? "--issue-spool"
        : JSON.stringify(report),
      stderr: "",
    };
  };
}
test("Result-only dispatch requires explicit capability and keeps the profile argument", async () => {
  for (const [profiles, schemas] of [
    [[], ["tidas.release-report.v2"]],
    [[RESULT_PACKAGE_PROFILE], []],
  ]) {
    const calls = [];
    await assert.rejects(
      verifyTidasRuntime({
        tidasBin: "fixture",
        profile: RESULT_PACKAGE_PROFILE,
        spawnCommand: mockHandshake(profiles, schemas, calls),
      }),
      { code: "tidas_result_profile_incompatible" },
    );
    assert.equal(calls.length, 1);
  }
  const calls = [];
  await runTidas({
    tidasBin: "fixture",
    canonicalRoot: "/canonical",
    indexPath: "/index",
    packagesDir: path.join(os.tmpdir(), "fixture-pair-out"),
    profile: RESULT_PACKAGE_PROFILE,
    spawnCommand: mockHandshake(
      [RESULT_PACKAGE_PROFILE],
      ["tidas.release-report.v2"],
      calls,
    ),
  });
  const build = calls.at(-1);
  assert.equal(build[build.indexOf("--profile") + 1], RESULT_PACKAGE_PROFILE);
});
test("pair build rejects mismatched roots and existing empty targets before tools", async (t) => {
  const input = await setup(t);
  await assert.rejects(
    buildFinalResultPair({ ...input, results: input.results.slice(1) }),
    { code: "final_pair_root_scope" },
  );
  await mkdir(input.outDir);
  await assert.rejects(buildFinalResultPair(input), { code: "output_exists" });
  assert.deepEqual(await readdir(input.outDir), []);
});
test("pair failure retains generated query files and no qualified Candidate", async (t) => {
  const input = await setup(t);
  let error;
  try {
    await buildFinalResultPair({
      ...input,
      tidasBin: path.join(input.root, "missing-tidas"),
    });
  } catch (e) {
    error = e;
  }
  assert.ok(error);
  const retained = error.details.retainedPairBuild;
  const receipt = JSON.parse(
    await readFile(path.join(retained, "failed-pair.json")),
  );
  assert.equal(receipt.candidateCreated, false);
  assert.equal(receipt.publicationAuthorized, false);
  assert.ok((await readdir(path.join(retained, "query"))).length > 1);
  await assert.rejects(
    readFile(path.join(input.outDir, "paired-result-receipt.json")),
    { code: "ENOENT" },
  );
});
test(
  "real Toolkit ZIPs and HDF5 preserve mixed layers, exact versions, zeros and signed basis",
  { skip: !process.env.RELEASE_PAIR_TIDAS_BIN },
  async (t) => {
    const input = await setup(t);
    const { receipt } = await buildFinalResultPair({
      ...input,
      tidasBin: process.env.RELEASE_PAIR_TIDAS_BIN,
    });
    assert.equal(receipt.pairQualified, true);
    assert.equal(receipt.candidateQualified, false);
    assert.equal(receipt.publicationAuthorized, false);
    assert.equal(receipt.packages.length, 2);
    assert.equal(receipt.artifacts.length, 2);
    const counts = [];
    for (const artifact of receipt.artifacts) {
      const dir = path.join(input.outDir, artifact.path);
      const manifest = JSON.parse(
        await readFile(path.join(dir, "manifest.json")),
      );
      const rows = JSON.parse(
        gunzipSync(await readFile(path.join(dir, "results.json.gz"))),
      );
      counts.push(rows.length);
      assert.equal(manifest.inventoryCount, 1);
      const chunks = [];
      const header = Buffer.alloc(32);
      header.write("TGQNUM02");
      [rows.length, 1, manifest.impactCount].forEach((x, i) =>
        header.writeBigUInt64LE(BigInt(x), 8 + i * 8),
      );
      chunks.push(header);
      for (const row of rows) {
        const lciOnly = row.uuid === "00000000-0000-4000-8000-000000000098";
        const zero = row.version === "00.00.002";
        const n = zero ? 0 : 1;
        assert.equal(row.quantitativeReference.value, lciOnly ? -2 : 1);
        assert.equal(manifest.impactCount, lciOnly ? 0 : 1);
        const data = Buffer.alloc(8 + n * 16 + manifest.impactCount * 8);
        data.writeBigUInt64LE(BigInt(n));
        if (n) {
          data.writeBigUInt64LE(0n, 8);
          data.writeDoubleLE(lciOnly ? -3 : 2.5, 16);
        }
        if (manifest.impactCount) data.writeDoubleLE(zero ? 0 : 42, 8 + n * 16);
        chunks.push(data);
      }
      const expected = path.join(
        input.root,
        `expected-${artifact.artifactId}.bin`,
      );
      await writeFile(expected, Buffer.concat(chunks));
      await runEncoder(encoder, ["verify", expected, dir]);
    }
    assert.deepEqual(counts.sort(), [1, 2]);
    const report = JSON.parse(
      await readFile(path.join(input.outDir, "archive-roundtrip-report.json")),
    );
    assert.equal(report.summary.release.ok, true);
    await assert.rejects(
      buildFinalResultPair({
        ...input,
        tidasBin: process.env.RELEASE_PAIR_TIDAS_BIN,
      }),
      { code: "output_exists" },
    );
  },
);
