import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, access, cp, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "./fixtures/final-input.mjs";
import { canonicalJson } from "../lib/common.mjs";
import {
  inspectFinalResultInput,
  prepareFinalResultInput,
  loadFinalResultInput,
} from "../lib/final-result-input.mjs";
import {
  buildFinalResultCandidate,
  loadFinalResultCandidate,
} from "../lib/final-result-candidate.mjs";
import {
  loadCandidate,
  loadProcessInputs,
} from "../../dataset-transformation/lib/candidate.mjs";
const encoder = fileURLToPath(
  new URL("../native/target/debug/release-result-hdf5", import.meta.url),
);
async function frozenInput(t) {
  const input = await setup(t);
  const plan = await inspectFinalResultInput(input);
  await prepareFinalResultInput({
    ...input,
    confirmInputHash: plan.inputHash,
  });
  return {
    input,
    plan,
    args: {
      finalInputDir: input.outDir,
      confirmInputHash: plan.inputHash,
      outDir: path.join(input.root, "candidate"),
      releaseVersion: "2026.11.0",
      encoder,
      tidasBin: process.env.RELEASE_PAIR_TIDAS_BIN,
    },
  };
}
test("frozen input reload verifies registration, selection, lineage and actual canonical bytes", async (t) => {
  const { input } = await frozenInput(t);
  const frozen = await loadFinalResultInput(input.outDir);
  assert.equal(frozen.input.results.length, 3);
  const f = path.join(input.outDir, "final-result-input.json");
  const bad = structuredClone(frozen.input);
  bad.results[0].contentHash = "0".repeat(64);
  await writeFile(f, canonicalJson(bad));
  await assert.rejects(loadFinalResultInput(input.outDir), {
    code: "final_input_binding_invalid",
  });
  await writeFile(f, canonicalJson(frozen.input));
  const entry = frozen.index.datasets.find((e) => e.role === "result_process");
  await writeFile(path.join(frozen.canonicalRoot, entry.path), "{}");
  await assert.rejects(loadFinalResultInput(input.outDir), {
    code: "final_result_file_size",
  });
});
test("Candidate confirmation is checked before invoking packager or creating output", async (t) => {
  const { args } = await frozenInput(t);
  await assert.rejects(
    buildFinalResultCandidate({
      ...args,
      confirmInputHash: "0".repeat(64),
      tidasBin: "missing-fixture-tool",
    }),
    { code: "final_candidate_confirmation_mismatch" },
  );
  await assert.rejects(access(args.outDir), { code: "ENOENT" });
});
test("bounded final metadata cannot escape through a symlink", async (t) => {
  const { input } = await frozenInput(t);
  const root = path.join(input.root, "linked");
  await cp(input.outDir, root, { recursive: true });
  const { rm } = await import("node:fs/promises");
  await rm(path.join(root, "final-result-input.json"));
  await symlink(
    path.join(input.outDir, "final-result-input.json"),
    path.join(root, "final-result-input.json"),
  );
  await assert.rejects(loadFinalResultInput(root), {
    code: "final_pair_path_escape",
  });
});
test(
  "actual paired Candidate binds verified results, both ZIPs and complete query coverage",
  { skip: !process.env.RELEASE_PAIR_TIDAS_BIN },
  async (t) => {
    const { args } = await frozenInput(t);
    const built = await buildFinalResultCandidate(args);
    assert.equal(
      built.candidate.schemaVersion,
      "tiangong.release.release-candidate.v3",
    );
    assert.equal(built.candidate.candidateQualified, true);
    assert.equal(built.candidate.publicationAuthorized, false);
    assert.equal(built.candidate.packages.length, 2);
    assert.equal(built.candidate.queryArtifacts.length, 2);
    const loaded = await loadFinalResultCandidate(built.path);
    assert.equal(loaded.queryCatalog.results.length, 3);
    assert.equal(
      loaded.queryCatalog.results.filter((r) => r.layer === "lci").length,
      1,
    );
    assert.equal(
      new Set(loaded.queryCatalog.results.map((r) => r.artifactId)).size,
      2,
    );
    await assert.rejects(buildFinalResultCandidate(args), {
      code: "output_exists",
    });
    const transformParent = await loadCandidate(built.path, {
      requiredRole: "result_process",
    });
    const rows = loaded.index.datasets
      .filter((r) => r.role === "result_process")
      .slice(0, 2);
    const processInputs = await loadProcessInputs(
      transformParent,
      rows.map((r) => `process:${r.uuid}@${r.version}`),
      { role: "result_process" },
    );
    assert.equal(processInputs.length, 2);
    await assert.rejects(
      loadCandidate(built.path, { requiredRole: "unit_process" }),
      { code: "candidate_process_package_missing" },
    );
    const catalogPath = path.join(
      built.path,
      built.candidate.queryResults.path,
    );
    const catalogBytes = await readFile(catalogPath);
    const changed = JSON.parse(catalogBytes);
    changed.results.pop();
    await writeFile(catalogPath, canonicalJson(changed));
    await assert.rejects(loadFinalResultCandidate(built.path), {
      code: "final_candidate_binding_invalid",
    });
    await writeFile(catalogPath, catalogBytes);
    const packagePath = path.join(built.path, built.candidate.packages[0].path);
    await writeFile(packagePath, "corrupt");
    await assert.rejects(loadFinalResultCandidate(built.path), {
      code: "final_pair_file_hash",
    });
  },
);
