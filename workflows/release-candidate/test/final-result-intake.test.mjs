import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { planFinalResultVersions } from "../lib/final-result-version-plan.mjs";
import { runFinalResultCommand } from "../lib/final-result-command.mjs";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { prepareReleaseIntake } from "../lib/release-intake.mjs";
import {
  prepareFinalResultIntake,
  loadFinalResultIntake,
} from "../lib/final-result-intake.mjs";
import { prepareFinalResultInput } from "../lib/final-result-input.mjs";
import { buildFinalResultCandidate } from "../lib/final-result-candidate.mjs";
import { registry } from "./fixtures/final-input.mjs";
import { id, version } from "./fixtures/final-result.mjs";
import { analyzeTransformation } from "../../dataset-transformation/lib/analysis.mjs";
import { freezeTransformation } from "../../dataset-transformation/lib/freeze.mjs";
import { executeTransformation } from "../../dataset-transformation/lib/execute.mjs";
import { materializeDerivedResult } from "../../result-materialization/lib/derived-result.mjs";
async function setup(t, oversizedFlow = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-intake-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/paired-final-results.json", import.meta.url),
    ),
  );
  if (oversizedFlow) {
    const row = fixture.records.find((r) => r.document.flowDataSet);
    row.document.flowDataSet.flowInformation.dataSetInformation[
      "common:generalComment"
    ] = { "@xml:lang": "en", "#text": "x".repeat(9 * 1024 * 1024) };
    const entry = fixture.index.datasets.find((e) => e.path === row.path);
    entry.canonicalContentHash = hashJson(row.document);
  }
  const materializationDir = path.join(root, "materialized");
  const sourceIntakeDir = path.join(root, "source");
  const docs = new Map(fixture.records.map((r) => [r.path, r.document]));
  const wanted = new Set(
    fixture.results
      .filter((r) => r.layer === "lci-lcia")
      .map((r) => `${r.uuid}@${r.version}`),
  );
  const datasets = [];
  for (const [processIndex, entry] of fixture.index.datasets
    .filter((e) => wanted.has(`${e.uuid}@${e.version}`))
    .entries()) {
    const relative = `canonical-datasets/${entry.path}`;
    await mkdir(path.dirname(path.join(materializationDir, relative)), {
      recursive: true,
    });
    const document = structuredClone(docs.get(entry.path));
    document.processDataSet.processInformation.dataSetInformation[
      "common:generalComment"
    ] = {
      "@xml:lang": "en",
      "#text": `aggregated LCI/LCIA result generated for ${id(80 + processIndex)}@${version} under calculation ${id(50)}.`,
    };
    const bytes = Buffer.from(canonicalJson(document));
    await writeFile(path.join(materializationDir, relative), bytes);
    datasets.push({
      ...entry,
      path: relative,
      sha256: sha256Bytes(bytes),
      byteSize: bytes.length,
      canonicalContentHash: hashJson(document),
      processIndex,
      sourceProcess: { id: id(80 + processIndex), version },
    });
  }
  const support = fixture.index.datasets
    .filter((e) => e.role !== "result_process")
    .map((e) => ({
      ...e,
      document: docs.get(e.path),
      sha256: e.canonicalContentHash,
    }));
  const unused = structuredClone(support.find((r) => r.datasetType === "flow"));
  unused.uuid = id(200);
  unused.path = `flows/${unused.uuid}_${unused.version}.json`;
  unused.document.flowDataSet.flowInformation.dataSetInformation[
    "common:UUID"
  ] = unused.uuid;
  unused.sha256 = hashJson(unused.document);
  support.push(unused);
  const artifacts = [];
  const methods = fixture.results.find(
    (r) => r.layer === "lci-lcia",
  ).expectedMethods;
  for (const [kind, records] of [
    ["source_closure", support],
    [
      "process_axis",
      datasets.map((d) => ({
        processIndex: d.processIndex,
        rootProcess: d.sourceProcess,
      })),
    ],
    [
      "lcia",
      datasets.flatMap((d) =>
        methods.map((m) => ({
          processIndex: d.processIndex,
          method: { id: m.uuid, version: m.version },
          meanAmount: 0,
        })),
      ),
    ],
  ]) {
    const relative = `${kind}.ndjson`;
    const content = records.map((r) => canonicalJson(r)).join("");
    await mkdir(path.join(sourceIntakeDir, "calculation-bundle"), {
      recursive: true,
    });
    await writeFile(
      path.join(sourceIntakeDir, "calculation-bundle", relative),
      content,
    );
    artifacts.push({
      kind,
      path: relative,
      recordCount: records.length,
      sha256: sha256Bytes(Buffer.from(content)),
    });
  }
  const source = {
    schemaVersion: "tiangong.release.materialization-intake.v1",
    source: { calculationId: id(50), bundleContentHash: "a".repeat(64) },
    artifacts,
  };
  await writeFile(
    path.join(sourceIntakeDir, "intake-manifest.json"),
    canonicalJson(source),
  );
  const index = {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasetCount: datasets.length,
    datasets,
  };
  const catalog = {
    schemaVersion: "tiangong.release.result-catalog.v1",
    calculationId: id(50),
    bundleContentHash: "a".repeat(64),
    resultProcessLayer: "lci-lcia",
    requiredResults: datasets.map((d) => d.sourceProcess),
    datasets,
  };
  const manifest = {
    schemaVersion: "tiangong.release.materialization-manifest.v1",
    datasets,
    inputs: {
      calculationId: id(50),
      bundleContentHash: catalog.bundleContentHash,
      intakeManifestSha256: hashJson(source),
      resultCatalogSha256: hashJson(catalog),
      canonicalDatasetIndexSha256: hashJson(index),
    },
    validation: { sourceDocuments: "verified", resultReferences: "verified" },
  };
  for (const [name, value] of Object.entries({
    "materialization-manifest.json": manifest,
    "canonical-dataset-index.json": index,
    "result-catalog.json": catalog,
  }))
    await writeFile(path.join(materializationDir, name), canonicalJson(value));
  const releaseIntakeDir = path.join(root, "release-intake");
  await prepareReleaseIntake({
    materializationDir,
    sourceIntakeDir,
    outDir: releaseIntakeDir,
    cacheLoader: () => {
      throw new Error("exact fixture dependencies are already frozen");
    },
  });
  return {
    root,
    materializationDir,
    sourceIntakeDir,
    releaseIntakeDir,
    unused,
  };
}
test("final intake rejects mixed direct/derived routes before reading inputs", async () => {
  await assert.rejects(
    prepareFinalResultIntake({
      releaseIntakeDir: "missing",
      materializationDir: "also-missing",
      outDir: "unused",
    }),
    { code: "final_intake_route_invalid" },
  );
});
test(
  "direct and Derived Result routes qualify exact closure, identities, paired files and CLI readback",
  { skip: !process.env.RELEASE_PAIR_TIDAS_BIN },
  async (t) => {
    const f = await setup(t);
    const built = await prepareFinalResultIntake({
      releaseIntakeDir: f.releaseIntakeDir,
      outDir: path.join(f.root, "final-intake"),
      tidasBin: process.env.RELEASE_PAIR_TIDAS_BIN,
    });
    assert.equal(built.manifest.identityRegistered, false);
    const loaded = await loadFinalResultIntake(built.path);
    assert.equal(loaded.results.length, 2);
    const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
    const inspected = JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [cli, "result", "inspect", "--result-intake", built.path, "--json"],
          { cwd: os.tmpdir() },
        )
      ).stdout,
    );
    assert.equal(inspected.inputHash, loaded.plan.inputHash);
    assert.equal(inspected.resultCount, 2);
    const advisory = await runFinalResultCommand(
      "versions",
      {
        "result-intake": built.path,
        "out-file": path.join(f.root, "versions.json"),
      },
      { env: {}, createIdentityAuthority: registry().createAuthority },
    );
    assert.equal(advisory.conflictCount, 0);
    assert.equal(advisory.identityRegistered, false);
    assert.equal(advisory.inputHash, inspected.inputHash);
    assert.equal(
      JSON.parse(await readFile(advisory.artifacts.versionPlan)).entries.length,
      2,
    );
    await assert.rejects(
      runFinalResultCommand(
        "versions",
        {
          "result-intake": built.path,
          "out-file": path.join(built.path, "never-write.json"),
        },
        {
          env: {},
          createIdentityAuthority: () =>
            assert.fail("must reject before authority"),
        },
      ),
      { code: "invalid_arguments" },
    );

    assert.equal(inspected.nextActions[0].kind, "freeze_final_input");
    await assert.rejects(
      runFinalResultCommand(
        "freeze",
        {
          "result-intake": built.path,
          "confirm-input-sha256": "0".repeat(64),
          "out-dir": path.join(f.root, "must-not-register"),
        },
        { env: { CONN: "secret-canary-not-a-connection" } },
      ),
      { code: "final_input_confirmation_mismatch" },
    );
    assert.equal(
      loaded.index.datasets.some((e) => e.uuid === f.unused.uuid),
      false,
    );
    assert.equal(loaded.plan.content.length, 2);
    assert.ok(loaded.results.every((r) => r.expectedMethods.length === 1));
    const identity = await runFinalResultCommand(
      "freeze",
      {
        "result-intake": built.path,
        "confirm-input-sha256": loaded.plan.inputHash,
        "out-dir": path.join(f.root, "frozen"),
      },
      {
        env: { CONN: "not-a-database-connection" },
        createIdentityAuthority: () =>
          assert.fail("offline freeze must not create an authority"),
      },
    );
    assert.equal(identity.identityRegistered, false);
    const candidatePath = path.join(f.root, "candidate");
    const builtCli = JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [
            cli,
            "result",
            "build",
            "--final-input",
            identity.finalInput,
            "--confirm-input-sha256",
            identity.inputHash,
            "--out-dir",
            candidatePath,
            "--release-version",
            "2026.11.0",
            "--tidas-bin",
            process.env.RELEASE_PAIR_TIDAS_BIN,
            "--hdf5-bin",
            fileURLToPath(
              new URL(
                "../native/target/debug/release-result-hdf5",
                import.meta.url,
              ),
            ),
            "--json",
          ],
          {
            cwd: os.tmpdir(),
            env: { ...process.env, CONN: "not-a-database-connection" },
          },
        )
      ).stdout,
    );
    assert.equal(builtCli.candidateQualified, true);
    assert.equal(builtCli.publicationAuthorized, false);
    const candidate = { path: builtCli.candidate };
    const inputs = loaded.results.map((r) => `process:${r.uuid}@${r.version}`);
    const output = id(220);
    const draft = {
      schemaVersion: "tiangong.release.dataset-transformation-dsl.v0",
      status: "draft",
      operation: {
        type: "result-process.weighted-aggregate.v0",
        inputs,
        weighting: {
          mode: "explicit",
          values: Object.fromEntries(inputs.map((k) => [k, 0.5])),
        },
      },
      output: {
        identity: {
          uuid: output,
          version: "01.00.000",
          uri: `https://example.test/process?uuid=${output}&version=01.00.000`,
        },
        generatedAt: "2026-11-01T00:00:00.000Z",
      },
      policies: {
        prototypeInput: inputs[0],
        exchangeMetadata: {
          base: "take-from-prototype-then-input-order",
          dataSources: "union-deduplicate",
          comments: "replace-with-lineage",
          uncertainty: "reset",
          allocations: "reset",
        },
      },
      decisions: [
        {
          conflictId: "operation:aggregation-target",
          strategy: "select-operation",
          value: "result-process.weighted-aggregate.v0",
          reason:
            "Synthetic fixture explicitly chooses derived Result semantics",
        },
        {
          conflictId: "field:name",
          strategy: "rewrite",
          value: {
            baseName: {
              "@xml:lang": "en",
              "#text": "Synthetic weighted final Result",
            },
            mixAndLocationTypes: {
              "@xml:lang": "en",
              "#text": "synthetic mix",
            },
            treatmentStandardsRoutes: {
              "@xml:lang": "en",
              "#text": "fixture route",
            },
          },
          reason: "Distinct synthetic result name",
        },
        {
          conflictId: "field:generalComment",
          strategy: "rewrite",
          value: {
            "@xml:lang": "en",
            "#text": "Synthetic combination of two exact final Results",
          },
          reason: "Explicit synthetic derived description",
        },
        {
          conflictId: "field:annualVolume",
          strategy: "drop",
          reason: "No annual volume is claimed in the synthetic fixture",
        },
      ],
    };
    const dslFile = path.join(f.root, "draft.json");
    await writeFile(dslFile, canonicalJson(draft));
    const analysis = await analyzeTransformation({
      candidateDir: candidate.path,
      dslFile,
      outDir: path.join(f.root, "analysis"),
    });
    assert.equal(
      analysis.analysis.status,
      "ready",
      JSON.stringify(analysis.analysis.conflicts),
    );
    const spec = await freezeTransformation({
      candidateDir: candidate.path,
      dslFile,
      analysisDir: analysis.path,
      outDir: path.join(f.root, "spec"),
    });
    const execution = await executeTransformation({
      candidateDir: candidate.path,
      specDir: spec.path,
      outDir: path.join(f.root, "transformed"),
    });
    const materialized = await materializeDerivedResult({
      candidateDir: candidate.path,
      transformationDir: execution.path,
      outDir: path.join(f.root, "derived-materialized"),
    });
    const derivedIntake = await prepareFinalResultIntake({
      materializationDir: materialized.path,
      candidateDir: candidate.path,
      transformationDir: execution.path,
      outDir: path.join(f.root, "derived-intake"),
      tidasBin: process.env.RELEASE_PAIR_TIDAS_BIN,
    });
    const derived = await loadFinalResultIntake(derivedIntake.path);
    assert.equal(derived.results.length, 1);
    assert.equal(derived.plan.lineage.results[0].relationKind, "derived");
    assert.equal(derived.plan.lineage.results[0].sources.length, 2);
    const derivedRegistry = registry();
    const registered = await prepareFinalResultInput({
      ...derived,
      confirmInputHash: derived.plan.inputHash,
      outDir: path.join(f.root, "derived-registered"),
    });
    const newCandidate = await buildFinalResultCandidate({
      finalInputDir: registered.path,
      confirmInputHash: registered.input.inputHash,
      outDir: path.join(f.root, "derived-candidate"),
      releaseVersion: "2026.11.1",
      tidasBin: process.env.RELEASE_PAIR_TIDAS_BIN,
      encoder: fileURLToPath(
        new URL("../native/target/debug/release-result-hdf5", import.meta.url),
      ),
    });
    assert.equal(newCandidate.candidate.candidateQualified, true);
    const verified = JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [cli, "result", "verify", "--candidate", newCandidate.path, "--json"],
          { cwd: os.tmpdir() },
        )
      ).stdout,
    );
    assert.equal(verified.resultCount, 1);
    assert.equal(verified.publicationAuthorized, false);
    assert.equal(
      verified.publicationIntegration,
      "final-result-publication-v2",
    );
    assert.equal(verified.nextActions[0].kind, "inspect_final_result_storage");
    assert.ok(verified.nextActions[0].argv.includes(newCandidate.path));
    const finalDocument = JSON.parse(
      await readFile(
        path.join(materialized.path, materialized.catalog.datasets[0].path),
      ),
    );
    assert.equal(
      Number(finalDocument.processDataSet.LCIAResults.LCIAResult[0].meanAmount),
      21,
    );
    const inventory = finalDocument.processDataSet.exchanges.exchange.find(
      (e) => e["@dataSetInternalID"] !== "0",
    );
    assert.equal(Number(inventory.resultingAmount), 1.25);
    async function regenerate(draftValue, suffix) {
      const dslFile = path.join(f.root, `${suffix}-draft.json`);
      await writeFile(dslFile, canonicalJson(draftValue));
      const analysis = await analyzeTransformation({
        candidateDir: candidate.path,
        dslFile,
        outDir: path.join(f.root, `${suffix}-analysis`),
      });
      assert.equal(analysis.analysis.status, "ready");
      const spec = await freezeTransformation({
        candidateDir: candidate.path,
        dslFile,
        analysisDir: analysis.path,
        outDir: path.join(f.root, `${suffix}-spec`),
      });
      const execution = await executeTransformation({
        candidateDir: candidate.path,
        specDir: spec.path,
        outDir: path.join(f.root, `${suffix}-execution`),
      });
      const materialization = await materializeDerivedResult({
        candidateDir: candidate.path,
        transformationDir: execution.path,
        outDir: path.join(f.root, `${suffix}-materialization`),
      });
      const intake = await prepareFinalResultIntake({
        materializationDir: materialization.path,
        candidateDir: candidate.path,
        transformationDir: execution.path,
        outDir: path.join(f.root, `${suffix}-intake`),
        tidasBin: process.env.RELEASE_PAIR_TIDAS_BIN,
      });
      return {
        materialization,
        intake: await loadFinalResultIntake(intake.path),
      };
    }
    // Changed processed values initially collide with the registered version.
    const changedDraft = structuredClone(draft);
    changedDraft.operation.weighting.values = {
      [inputs[0]]: 0.25,
      [inputs[1]]: 0.75,
    };
    const changed = await regenerate(changedDraft, "changed");
    const historical = derivedRegistry.createAuthority();
    await historical.register(derived.plan.content[0]);
    const allocation = await planFinalResultVersions({
      inputPlan: changed.intake.plan,
      createAuthority: derivedRegistry.createAuthority,
    });
    assert.equal(allocation.entries[0].toVersion, "02.00.000");
    assert.equal(allocation.entries[0].relationKind, "derived");
    changedDraft.output.identity.version = allocation.entries[0].toVersion;
    changedDraft.output.identity.uri = `https://example.test/process?uuid=${output}&version=02.00.000`;
    const regenerated = await regenerate(changedDraft, "reversioned");
    assert.notEqual(
      regenerated.intake.plan.inputHash,
      changed.intake.plan.inputHash,
    );
    assert.equal(regenerated.intake.results[0].version, "02.00.000");
    const newInput = await prepareFinalResultInput({
      ...regenerated.intake,
      confirmInputHash: regenerated.intake.plan.inputHash,
      outDir: path.join(f.root, "reversioned-input"),
    });
    const newPair = await buildFinalResultCandidate({
      finalInputDir: newInput.path,
      confirmInputHash: newInput.input.inputHash,
      outDir: path.join(f.root, "reversioned-candidate"),
      releaseVersion: "2026.11.2",
      tidasBin: process.env.RELEASE_PAIR_TIDAS_BIN,
      encoder: fileURLToPath(
        new URL("../native/target/debug/release-result-hdf5", import.meta.url),
      ),
    });
    assert.equal(newPair.candidate.candidateQualified, true);
    const reversionedDocument = JSON.parse(
      await readFile(
        path.join(
          regenerated.materialization.path,
          regenerated.materialization.catalog.datasets[0].path,
        ),
      ),
    );
    assert.equal(
      Number(
        reversionedDocument.processDataSet.LCIAResults.LCIAResult[0].meanAmount,
      ),
      10.5,
    );
    assert.equal(
      reversionedDocument.processDataSet.administrativeInformation
        .publicationAndOwnership["common:dataSetVersion"],
      "02.00.000",
    );
    assert.equal(derivedRegistry.claims.size, 1);
    // Earlier frozen inputs remain valid and retain their old identity/numbers.
    assert.equal(
      (await loadFinalResultIntake(derivedIntake.path)).results[0].version,
      "01.00.000",
    );
    await writeFile(
      path.join(f.sourceIntakeDir, "calculation-bundle", "lcia.ndjson"),
      "",
    );
    await assert.rejects(loadFinalResultIntake(built.path), {
      code: "final_pair_file_hash",
    });
  },
);
test("missing frozen method axis fails before Toolkit and before a final intake exists", async (t) => {
  const f = await setup(t);
  await writeFile(
    path.join(f.sourceIntakeDir, "calculation-bundle", "lcia.ndjson"),
    "",
  );
  const outDir = path.join(f.root, "absent");
  await assert.rejects(
    prepareFinalResultIntake({
      releaseIntakeDir: f.releaseIntakeDir,
      outDir,
      tidasBin: "never-called",
    }),
    { code: "final_pair_file_hash" },
  );
  await assert.rejects(access(outDir), { code: "ENOENT" });
});

test("failed intake retains actionable document-budget evidence without creating a candidate", async (t) => {
  const f = await setup(t, true);
  const outDir = path.join(f.root, "oversized-intake");
  let retained;
  await assert.rejects(
    prepareFinalResultIntake({
      releaseIntakeDir: f.releaseIntakeDir,
      outDir,
      tidasBin: "not-invoked",
    }),
    (error) => {
      assert.equal(error.code, "canonical_document_budget");
      retained = error.details.retainedIntake;
      return true;
    },
  );
  const report = JSON.parse(
    await readFile(path.join(retained, "failed-intake.json")),
  );
  assert.equal(report.code, "canonical_document_budget");
  assert.equal(report.budget.datasetType, "flow");
  assert.ok(report.budget.actualBytes > report.budget.limitBytes);
  assert.equal(report.budget.limitBytes, 8 * 1024 * 1024);
  assert.equal(report.candidateCreated, false);
  assert.equal(report.publicationAuthorized, false);
  await assert.rejects(access(outDir), { code: "ENOENT" });
});

test("intake prepare CLI carries selected deliverables in JSON and shows both choices in human output", async (t) => {
  const f = await setup(t);
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
  for (const deliveryFormat of [
    undefined,
    "result-zip-hdf5",
    "legacy-four-zips",
  ]) {
    const args = [
      cli,
      "intake",
      "prepare",
      "--materialization",
      f.materializationDir,
      "--source-intake",
      f.sourceIntakeDir,
      "--out-dir",
      path.join(f.root, deliveryFormat ?? "choose"),
    ];
    if (deliveryFormat) args.push("--delivery-format", deliveryFormat);
    const { stdout } = await execFileAsync(
      process.execPath,
      [...args, "--json"],
      { cwd: os.tmpdir() },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.deliveryFormat, deliveryFormat ?? null);
    assert.equal(result.nextDecision.required, deliveryFormat === undefined);
    assert.equal(result.nextActions.length, deliveryFormat ? 1 : 0);
    if (deliveryFormat) assert.equal(result.nextActions[0].id, deliveryFormat);
    assert.equal(result.publicationAuthorized, false);
  }
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cli,
      "intake",
      "prepare",
      "--materialization",
      f.materializationDir,
      "--source-intake",
      f.sourceIntakeDir,
      "--out-dir",
      path.join(f.root, "human"),
    ],
    { cwd: os.tmpdir() },
  );
  assert.match(stdout, /Result ZIP \+ HDF5/);
  assert.match(stdout, /Legacy four ZIPs \(no HDF5\)/);
});
