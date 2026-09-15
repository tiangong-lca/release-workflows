import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPublicationApproval } from "../lib/approval.mjs";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { executePublication } from "../lib/execution.mjs";
import { inspectPublicationTarget } from "../lib/inspection.mjs";
import { verifyPublicationReadback } from "../lib/readback.mjs";
import {
  executeResultProcessPublication,
  prepareResultProcessPublication,
  verifyResultProcessReadback,
} from "../lib/result-process.mjs";
import { targetStateCodeForRole } from "../lib/publication-state.mjs";
import { createPublicationMock } from "../test-support/publication-rpc-mock.mjs";
import { payloadDataset } from "../test-support/publication-fixture.mjs";
import {
  assertMatchesSchema,
  validateArtifact,
} from "../test-support/contracts.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "cli.mjs");
const MANAGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION = "01.00.000";
const ENV = {
  TIANGONG_LCA_API_BASE_URL: "https://project.example.test",
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "publishable",
  TIANGONG_LCA_ACCESS_TOKEN: actorToken(MANAGER),
};
const IDS = {
  result: "55555555-5555-4555-8555-555555555555",
  unit: "11111111-1111-4111-8111-111111111111",
  flow: "33333333-3333-4333-8333-333333333333",
  model: "66666666-6666-4666-8666-666666666666",
};

function actorToken(subject) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: subject })).toString("base64url"),
    "signature",
  ].join(".");
}

/**
 * Drives the real Release chain offline: payload -> target inspection ->
 * approval -> remote prepare -> remote execute -> independent readback.
 */
async function prepareApprovedRun(
  fixture,
  {
    expiresAt = "2026-09-17T00:00:00.000Z",
    attestedByUserId = MANAGER,
    reason = "publish attested result process",
  } = {},
) {
  const remote = createPublicationMock({
    actorUserId: MANAGER,
    managerActive: true,
  });
  const inspection = await inspectPublicationTarget({
    planDir: fixture.planDir,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, `inspection-${fixture.suffix()}`),
    env: ENV,
    fetchImpl: remote.fetch,
    now: () => new Date("2026-09-15T00:00:00.000Z"),
  });
  const approval = await createPublicationApproval({
    inspectionDir: inspection.path,
    outDir: path.join(fixture.root, `approval-${fixture.suffix()}`),
    confirmPlanSha256: inspection.executablePlanSha256,
    approvedBy: "release-manager@example.test",
    attestedByUserId,
    reason,
    expiresAt,
    now: () => new Date("2026-09-15T00:01:00.000Z"),
  });
  return { remote, inspection, approval };
}

async function prepareResult(fixture, run, suffix = "p") {
  return prepareResultProcessPublication({
    approvalDir: run.approval.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, `result-preparation-${suffix}`),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:02:00.000Z"),
  });
}

test("Mixed-state planning derives 120 for Result Process and 100 for every dependency role", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const remote = createPublicationMock({
    actorUserId: MANAGER,
    rows: [
      {
        table: "flows",
        id: IDS.flow,
        version: VERSION,
        contentText: canonicalJson(fixture.datasetById(IDS.flow).document),
        stateCode: 100,
        userId: MANAGER,
      },
    ],
  });
  const inspection = await inspectPublicationTarget({
    planDir: fixture.planDir,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "inspection"),
    env: ENV,
    fetchImpl: remote.fetch,
    now: () => new Date("2026-09-15T00:00:00.000Z"),
  });
  const byRole = new Map(
    inspection.executablePlan.operations.map((operation) => [
      operation.role,
      operation,
    ]),
  );
  assert.equal(byRole.get("result_process").targetStateCode, 120);
  assert.equal(byRole.get("result_process").contentType, "result-process");
  // A Result Process is always released through the manager command, never as a
  // generic create/no-op, and always counts as a remote write.
  assert.equal(
    byRole.get("result_process").action,
    "reconcile_via_manager_command",
  );
  assert.equal(byRole.get("result_process").remoteWrites, true);
  // A support dependency reached from the Result closure stays ordinary.
  assert.equal(byRole.get("support").targetStateCode, 100);
  assert.equal(byRole.get("support").contentType, "ordinary-dataset");
  assert.equal(byRole.get("support").action, "already_published_noop");
  assert.equal(byRole.get("unit_process").targetStateCode, 100);
  assert.equal(byRole.get("lifecycle_model").targetStateCode, 100);
  assert.equal(inspection.snapshot.resultProcessDatasetCount, 1);
  assert.equal(inspection.snapshot.ordinaryDatasetCount, 3);
  assert.deepEqual(inspection.snapshot.stateMapping.roleTargets, {
    result_process: 120,
    unit_process: 100,
    lifecycle_model: 100,
    support: 100,
  });
  assert.equal(inspection.snapshot.stateMapping.singleGlobalState, false);
});

test("Role targets are fixed and unknown roles fail closed", () => {
  assert.equal(targetStateCodeForRole("result_process"), 120);
  assert.equal(targetStateCodeForRole("unit_process"), 100);
  assert.equal(targetStateCodeForRole("lifecycle_model"), 100);
  assert.equal(targetStateCodeForRole("support"), 100);
  assert.throws(
    () => targetStateCodeForRole("contact"),
    ({ code }) => code === "publication_dataset_role_unsupported",
  );
});

test("Target inspection refuses a global published-state override", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const remote = createPublicationMock({ actorUserId: MANAGER });
  await assert.rejects(
    inspectPublicationTarget({
      planDir: fixture.planDir,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "inspection"),
      publishedStateCode: 120,
      env: ENV,
      fetchImpl: remote.fetch,
    }),
    ({ code }) => code === "publication_state_mapping_out_of_scope",
  );
  assert.equal(remote.commandCounts.create, 0);
  assert.equal(remote.commandCounts.publish, 0);
});

test("Result Process publishes directly at 120 without any 100 create or draft", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "direct");
  const [operation] = prepared.preparation.operations;
  assert.equal(operation.targetStateCode, 120);
  assert.equal(operation.contentHashDomain, "result-process-content.v1");
  assert.equal(operation.contentSha256, fixture.datasetById(IDS.result).sha256);
  assert.equal(operation.preparationClassification, "absent");
  assert.equal(run.remote.commandCounts.execute, 0);

  const execution = await executeResultProcessPublication({
    preparationDir: prepared.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "result-execution"),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
  assert.equal(execution.receipt.status, "published");
  assert.equal(execution.receipt.independentReadbackVerified, false);
  // The Result identity was created straight at 120: no platform dataset
  // command ran, so there is no intermediate 0 or 100 row.
  assert.equal(run.remote.commandCounts.create, 0);
  assert.equal(run.remote.commandCounts.publish, 0);
  const row = run.remote.getRow(IDS.result, VERSION);
  assert.equal(row.stateCode, 120);

  const readback = await verifyResultProcessReadback({
    executionDir: execution.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "result-readback"),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:04:00.000Z"),
  });
  assert.equal(readback.receipt.status, "verified");
  const [row2] = readback.receipt.rows;
  assert.equal(row2.observedStateCode, 120);
  assert.equal(row2.byteHashDomain, "result-process-content.v1");
  assert.equal(row2.observedByteHash, fixture.datasetById(IDS.result).sha256);
  assert.equal(
    row2.observedCanonicalContentHash,
    fixture.datasetById(IDS.result).canonicalContentHash,
  );
  // The Result readback never touched the generic REST surface.
  assert.equal(run.remote.commandCounts.readback, 1);
});

test("Mixed-state publish routes Result to 120 and ordinary dependencies to the platform commands", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "mixed");
  const execution = await executePublication({
    approvalDir: run.approval.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "mixed-execution"),
    resultPreparationDir: prepared.path,
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
  assert.equal(execution.receipt.resultProcessDatasetCount, 1);
  assert.equal(execution.receipt.datasetCount, 4);
  // Ordinary dependencies still go through the platform dataset commands:
  // two Processes and one Flow through app_dataset_create, the LifeCycleModel
  // through save_lifecycle_model_bundle.
  assert.equal(run.remote.commandCounts.create, 2);
  assert.equal(run.remote.commandCounts.bundle, 1);
  assert.equal(run.remote.commandCounts.publish, 3);
  // The Result identity went exclusively through the manager-attested command.
  assert.equal(run.remote.commandCounts.execute, 1);
  assert.equal(run.remote.getRow(IDS.result, VERSION).stateCode, 120);

  const readback = await verifyPublicationReadback({
    executionDir: execution.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "mixed-readback"),
    resultPreparationDir: prepared.path,
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:04:00.000Z"),
  });
  assert.equal(readback.receipt.status, "verified");
  const byRole = new Map(readback.receipt.rows.map((row) => [row.role, row]));
  assert.equal(byRole.get("result_process").observedStateCode, 120);
  assert.equal(byRole.get("support").observedStateCode, 100);
  assert.equal(byRole.get("unit_process").observedStateCode, 100);
  assert.equal(byRole.get("lifecycle_model").observedStateCode, 100);
});

test("A Result Process plan cannot execute without its remote-prepared request", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  await assert.rejects(
    executePublication({
      approvalDir: run.approval.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "no-preparation"),
      env: ENV,
      fetchImpl: run.remote.fetch,
      now: () => new Date("2026-09-15T00:03:00.000Z"),
    }),
    ({ code, details }) => {
      assert.equal(code, "result_process_preparation_required");
      assert.deepEqual(details.resultProcessKeys, [
        `process:${IDS.result}@${VERSION}`,
      ]);
      return true;
    },
  );
  assert.equal(run.remote.commandCounts.create, 0);
  assert.equal(run.remote.commandCounts.execute, 0);
});

test("A legacy all-100 Result approval fails closed before any write while staying readable", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const legacy = await writeLegacyAllHundredApproval(fixture);
  const planBytes = await readFile(
    path.join(legacy.approvalDir, "publication-executable-plan.json"),
    "utf8",
  );
  const approvalBytes = await readFile(
    path.join(legacy.approvalDir, "publication-approval.json"),
    "utf8",
  );
  const remote = createPublicationMock({ actorUserId: MANAGER });
  await assert.rejects(
    executePublication({
      approvalDir: legacy.approvalDir,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "legacy-execution"),
      env: ENV,
      fetchImpl: remote.fetch,
    }),
    ({ code, details }) => {
      assert.equal(code, "publication_executable_plan_unsupported");
      assert.equal(details.historicalEvidenceReadable, true);
      return true;
    },
  );
  assert.equal(remote.commandCounts.create, 0);
  assert.equal(remote.commandCounts.publish, 0);
  assert.equal(remote.commandCounts.execute, 0);
  // Historical evidence stays readable; reading it grants no new authorization.
  const legacyPlan = JSON.parse(planBytes);
  const legacyApproval = JSON.parse(approvalBytes);
  assert.equal(legacyApproval.executablePlanSha256, hashJson(legacyPlan));
  assert.equal(legacyApproval.publishedState.code, 100);
  assert.equal(
    legacyPlan.schemaVersion,
    "tiangong.release.publication-executable-plan.v1",
  );
});

test("Historical v1 evidence stays readable while granting no new authorization", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const legacy = await writeLegacyAllHundredApproval(fixture);
  const files = [
    "publication-draft-plan.json",
    "publication-payload-manifest.json",
    "publication-target-snapshot.json",
    "publication-executable-plan.json",
    "publication-approval.json",
  ];
  const before = new Map();
  for (const name of files)
    before.set(
      name,
      await readFile(path.join(legacy.approvalDir, name), "utf8"),
    );

  // Readable as history: every artifact still parses and re-verifies its own
  // recorded hash bindings, with no loader in the loop.
  const plan = JSON.parse(before.get("publication-executable-plan.json"));
  const approval = JSON.parse(before.get("publication-approval.json"));
  const snapshot = JSON.parse(before.get("publication-target-snapshot.json"));
  const manifest = JSON.parse(before.get("publication-payload-manifest.json"));
  const draft = JSON.parse(before.get("publication-draft-plan.json"));
  assert.equal(approval.executablePlanSha256, hashJson(plan));
  assert.equal(plan.targetSnapshotSha256, hashJson(snapshot));
  assert.equal(plan.payloadManifestSha256, hashJson(manifest));
  assert.equal(plan.publicationDraftPlanSha256, hashJson(draft));
  assert.equal(plan.publishedState.code, 100);
  assert.equal(
    plan.schemaVersion,
    "tiangong.release.publication-executable-plan.v1",
  );

  // Not authorization: the v2 loaders refuse it and say so explicitly.
  const remote = createPublicationMock({ actorUserId: MANAGER });
  await assert.rejects(
    executePublication({
      approvalDir: legacy.approvalDir,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "legacy-execution"),
      env: ENV,
      fetchImpl: remote.fetch,
    }),
    ({ code, details }) => {
      assert.equal(code, "publication_executable_plan_unsupported");
      assert.equal(details.historicalEvidenceReadable, true);
      assert.equal(
        details.requiredSchemaVersion,
        "tiangong.release.publication-executable-plan.v2",
      );
      assert.equal(
        details.observedSchemaVersion,
        "tiangong.release.publication-executable-plan.v1",
      );
      return true;
    },
  );
  // Readback of v1 evidence is refused the same self-describing way.
  await assert.rejects(
    verifyPublicationReadback({
      executionDir: legacy.approvalDir,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "legacy-readback"),
      env: ENV,
      fetchImpl: remote.fetch,
    }),
    ({ code, details }) => {
      assert.equal(code, "publication_execution_receipt_missing");
      assert.equal(
        details.cause,
        "publication_execution_receipt_missing" === details.cause
          ? details.cause
          : details.cause,
      );
      return true;
    },
  );
  // No write happened, and history was not rewritten in place.
  assert.equal(remote.commandCounts.create, 0);
  assert.equal(remote.commandCounts.execute, 0);
  for (const name of files)
    assert.equal(
      await readFile(path.join(legacy.approvalDir, name), "utf8"),
      before.get(name),
      name,
    );
});

test("A mixed-state plan relabelled to a single 100 state is rejected before any write", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const drifted = structuredClone(run.inspection.executablePlan);
  for (const operation of drifted.operations) operation.targetStateCode = 100;
  drifted.operationFingerprint = hashJson(
    drifted.operations.map(
      ({ key, role, targetStateCode, action, observedStateCode }) => ({
        key,
        role,
        targetStateCode,
        action,
        observedStateCode,
      }),
    ),
  );
  const approvalDir = path.join(fixture.root, "drifted-approval");
  await mkdir(approvalDir, { recursive: true });
  const source = run.approval.approval;
  await writeFile(
    path.join(approvalDir, "publication-executable-plan.json"),
    canonicalJson(drifted),
  );
  for (const name of [
    "publication-draft-plan.json",
    "publication-target-snapshot.json",
    "publication-payload-manifest.json",
  ])
    await writeFile(
      path.join(approvalDir, name),
      await readFile(path.join(run.inspection.path, name)),
    );
  await writeFile(
    path.join(approvalDir, "publication-approval.json"),
    canonicalJson({
      ...source,
      executablePlanSha256: hashJson(drifted),
      managerAttestation: null,
    }),
  );
  await assert.rejects(
    executePublication({
      approvalDir,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "drifted-execution"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code, details }) => {
      assert.equal(
        code,
        "result_process_publication_authorization_unsupported",
      );
      assert.equal(
        details.blockers.some(
          ({ code: blockerCode }) =>
            blockerCode === "operation_target_state_mismatch",
        ),
        true,
      );
      return true;
    },
  );
  assert.equal(run.remote.commandCounts.execute, 0);
  assert.equal(run.remote.commandCounts.create, 0);
});

test("Result Process approval records an immutable manager attestation bound to identity, content, target and plan", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const remote = createPublicationMock({ actorUserId: MANAGER });
  const inspection = await inspectPublicationTarget({
    planDir: fixture.planDir,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "inspection"),
    env: ENV,
    fetchImpl: remote.fetch,
  });
  await assert.rejects(
    createPublicationApproval({
      inspectionDir: inspection.path,
      outDir: path.join(fixture.root, "missing-manager"),
      confirmPlanSha256: inspection.executablePlanSha256,
      approvedBy: "release-manager@example.test",
    }),
    ({ code }) => code === "publication_manager_attestation_actor_invalid",
  );
  const approval = await createPublicationApproval({
    inspectionDir: inspection.path,
    outDir: path.join(fixture.root, "approval"),
    confirmPlanSha256: inspection.executablePlanSha256,
    approvedBy: "release-manager@example.test",
    attestedByUserId: MANAGER,
    reason: "publish attested result process",
  });
  const attestation = approval.approval.managerAttestation;
  assert.equal(attestation.assertion, "manager_attested_authorization");
  assert.equal(attestation.lineage, "not_machine_verified");
  assert.equal(attestation.attestedByUserId, MANAGER);
  assert.equal(attestation.executablePlanSha256, approval.executablePlanSha256);
  assert.equal(attestation.resultProcessOperationCount, 1);
  assert.equal(attestation.rowsHash, hashJson(attestation.rows));
  const [row] = attestation.rows;
  assert.equal(row.assertedRole, "result_process");
  assert.equal(row.uuid, IDS.result);
  assert.equal(row.version, VERSION);
  assert.equal(row.targetStateCode, 120);
  assert.equal(
    row.canonicalContentHash,
    fixture.datasetById(IDS.result).canonicalContentHash,
  );
  assert.equal(row.planSha256, approval.executablePlanSha256);
  // Never presented as machine-verified computational lineage.
  assert.equal("verifiedLineage" in attestation, false);
  assert.equal(approval.approval.resultPublicationAuthorized, true);
});

test("Manager attestation binds real source hashes and is fully re-validated", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const [row] = run.approval.approval.managerAttestation.rows;

  // F1: the source hashes are the actual verified payload evidence, never null.
  assert.match(row.candidateSetHash, /^[0-9a-f]{64}$/u);
  assert.match(row.sourceManifestHash, /^[0-9a-f]{64}$/u);
  const manifest = JSON.parse(
    await readFile(
      path.join(fixture.payloadDir, "publication-payload-manifest.json"),
      "utf8",
    ),
  );
  assert.equal(row.candidateSetHash, manifest.datasetSetHash);
  assert.equal(row.sourceManifestHash, manifest.candidate.packageSetHash);
  assert.equal(row.planSha256, run.approval.executablePlanSha256);
  assert.equal(row.assertedRole, "result_process");
  assert.equal(row.targetStateCode, 120);
  assert.equal(
    row.canonicalContentHash,
    fixture.datasetById(IDS.result).canonicalContentHash,
  );

  // F2: a tampered row must fail before any remote call, with plan and payload
  // left intact so only the attestation is wrong.
  const approvalPath = path.join(
    run.approval.path,
    "publication-approval.json",
  );
  const original = await readFile(approvalPath, "utf8");
  const tamper = async (label, change) => {
    const value = JSON.parse(original);
    change(value.managerAttestation);
    await writeFile(approvalPath, canonicalJson(value));
    const remote = createPublicationMock({ actorUserId: MANAGER });
    await assert.rejects(
      prepareResultProcessPublication({
        approvalDir: run.approval.path,
        payloadDir: fixture.payloadDir,
        outDir: path.join(fixture.root, `tamper-${label}`),
        env: ENV,
        fetchImpl: remote.fetch,
      }),
      ({ code }) => {
        // Every tamper fails inside the attestation validators, before any
        // remote call. Which of the two specific codes fires depends on the
        // tamper; both are fail-closed.
        assert.equal(
          [
            "publication_manager_attestation_invalid",
            "publication_approval_attestation_binding_mismatch",
            "publication_approval_attestation_coverage_mismatch",
          ].includes(code),
          true,
          `${label}: ${code}`,
        );
        return true;
      },
    );
    // Nothing reached the remote.
    assert.equal(remote.commandCounts.prepare, 0, label);
    assert.equal(remote.commandCounts.execute, 0, label);
  };

  await tamper("content", (a) => {
    a.rows[0].canonicalContentHash = "b".repeat(64);
    a.rowsHash = hashJson(a.rows);
  });
  await tamper("role", (a) => {
    a.rows[0].assertedRole = "unit_process";
    a.rowsHash = hashJson(a.rows);
  });
  await tamper("target", (a) => {
    a.rows[0].targetStateCode = 100;
    a.rowsHash = hashJson(a.rows);
  });
  await tamper("source", (a) => {
    a.rows[0].sourceManifestHash = "c".repeat(64);
    a.rowsHash = hashJson(a.rows);
  });
  // A resealed rows digest cannot hide a changed row.
  await tamper("rowsHash", (a) => {
    a.rows[0].canonicalContentHash = "d".repeat(64);
  });
  // Structural tampering fails too.
  await tamper("lineage", (a) => {
    a.lineage = "machine_verified";
  });
  await tamper("unknown-field", (a) => {
    a.machineLineageVerified = true;
  });
  await tamper("duplicate-identity", (a) => {
    a.rows = [a.rows[0], { ...a.rows[0] }];
    a.resultProcessOperationCount = 2;
    a.rowsHash = hashJson(a.rows);
  });
  await tamper("count", (a) => {
    a.resultProcessOperationCount = 2;
  });
  await tamper("plan", (a) => {
    a.executablePlanSha256 = "e".repeat(64);
    a.rows[0].planSha256 = "e".repeat(64);
    a.rowsHash = hashJson(a.rows);
  });
  await writeFile(approvalPath, original);

  // The pristine approval still works.
  const prepared = await prepareResult(fixture, run, "attestation-restored");
  assert.equal(prepared.preparation.operations.length, 1);
});

test("Approval artifacts reject unknown fields recursively at any depth", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const approvalPath = path.join(
    run.approval.path,
    "publication-approval.json",
  );
  const original = await readFile(approvalPath, "utf8");
  const mutated = JSON.parse(original);
  mutated.managerAttestation.rows[0].machineLineageVerified = true;
  await writeFile(approvalPath, canonicalJson(mutated));
  await assert.rejects(
    prepareResultProcessPublication({
      approvalDir: run.approval.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "unknown-field"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code, details }) => {
      assert.equal(code, "publication_manager_attestation_invalid");
      assert.deepEqual(details.unknown, ["machineLineageVerified"]);
      return true;
    },
  );
  assert.equal(run.remote.commandCounts.prepare, 0);
});

test("A RPC response carrying unknown or forbidden fields is rejected", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);

  // The reviewed command rejects `role`/`targetState`/`actorUserId`/`stateCode`
  // in requests. Its response side is equally strict for Release: an unexpected
  // field is refused rather than silently ignored.
  for (const unexpected of ["role", "targetState", "stateCode"]) {
    const remote = createPublicationMock({
      actorUserId: MANAGER,
      responseOverrides: { prepare: { [unexpected]: "result_process" } },
    });
    await assert.rejects(
      prepareResultProcessPublication({
        approvalDir: run.approval.path,
        payloadDir: fixture.payloadDir,
        outDir: path.join(fixture.root, `unknown-${unexpected}`),
        env: ENV,
        fetchImpl: remote.fetch,
      }),
      ({ code, details }) => {
        assert.equal(
          code,
          "result_process_prepare_response_invalid",
          unexpected,
        );
        assert.deepEqual(details.unknown, [unexpected]);
        return true;
      },
    );
  }
  // `actorUserId` is a documented field, so a wrong value is a binding mismatch
  // rather than an unknown-field rejection.
  const wrongActor = createPublicationMock({
    actorUserId: MANAGER,
    responseOverrides: { prepare: { actorUserId: IDS.unit } },
  });
  await assert.rejects(
    prepareResultProcessPublication({
      approvalDir: run.approval.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "unknown-actor"),
      env: ENV,
      fetchImpl: wrongActor.fetch,
    }),
    ({ code }) => code === "result_process_prepare_response_binding_mismatch",
  );

  // The request Release sends never carries a server-derived field either.
  const seen = [];
  const observingFetch = observeRpcRequests(run.remote.fetch, seen);
  await prepareResult(
    fixture,
    { ...run, remote: { ...run.remote, fetch: observingFetch } },
    "observed",
  );
  const prepareRequest = seen.find(
    ({ functionName }) =>
      functionName === "qry_result_process_publish_prepare_v1",
  ).request;
  for (const forbidden of ["role", "targetState", "actorUserId", "stateCode"])
    assert.equal(forbidden in prepareRequest, false, forbidden);
  assert.deepEqual(Object.keys(prepareRequest.source).sort(), [
    "candidateSetHash",
    "sourceManifestHash",
  ]);
  assert.deepEqual(Object.keys(prepareRequest.audit), ["reason"]);
});

test("Prepare surfaces a conflicting identity before any write", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  // A pre-existing row with different content blocks the publication.
  run.remote.insertRow({
    table: "processes",
    id: IDS.result,
    version: VERSION,
    contentText: canonicalJson({ processDataSet: { other: true } }),
    stateCode: 120,
    userId: MANAGER,
  });
  await assert.rejects(
    prepareResult(fixture, run, "conflict"),
    ({ code }) => code === "result_process_prepare_conflict",
  );
  assert.equal(run.remote.commandCounts.execute, 0);
});

test("Prepare existingState must agree with the reported classification", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  // conflict with a legacy 100 row: the real state is reported.
  const legacy = await prepareApprovedRun(fixture);
  legacy.remote.insertRow({
    table: "processes",
    id: IDS.result,
    version: VERSION,
    contentText: fixture.resultContentText(),
    stateCode: 100,
    userId: MANAGER,
  });
  await assert.rejects(
    prepareResult(fixture, legacy, "state-100"),
    ({ code, details }) => {
      assert.equal(code, "result_process_prepare_conflict");
      assert.equal(details.existingState, 100);
      return true;
    },
  );

  // conflict with a row that exists but has no state: SQL decides existence with
  // FOUND, so this is a conflict whose existingState is legitimately null.
  const nullState = await prepareApprovedRun(fixture);
  nullState.remote.insertRow({
    table: "processes",
    id: IDS.result,
    version: VERSION,
    contentText: fixture.resultContentText(),
    stateCode: null,
    userId: MANAGER,
  });
  await assert.rejects(
    prepareResult(fixture, nullState, "state-null"),
    ({ code, details }) => {
      assert.equal(code, "result_process_prepare_conflict");
      assert.equal(details.existingState, null);
      return true;
    },
  );

  // conflict with a state outside the well-known lifecycle set is still reported
  // as an integer, not silently coerced or rejected as malformed.
  const unusual = await prepareApprovedRun(fixture);
  unusual.remote.insertRow({
    table: "processes",
    id: IDS.result,
    version: VERSION,
    contentText: fixture.resultContentText(),
    stateCode: 110,
    userId: MANAGER,
  });
  await assert.rejects(
    prepareResult(fixture, unusual, "state-110"),
    ({ code, details }) => {
      assert.equal(code, "result_process_prepare_conflict");
      assert.equal(details.existingState, 110);
      return true;
    },
  );

  // An absent identity must report a null state.
  const absent = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, absent, "state-absent");
  assert.equal(
    prepared.preparation.operations[0].preparationClassification,
    "absent",
  );
  assert.equal(
    prepared.preparation.operations[0].preparationExistingState,
    null,
  );

  // A response claiming an existing state for an absent identity is refused.
  for (const bad of [
    { classification: "absent", existingState: 120 },
    { classification: "absent", existingState: 0 },
    {
      classification: "candidate_content_matches_existing",
      existingState: 100,
    },
    {
      classification: "candidate_content_matches_existing",
      existingState: null,
    },
    {
      classification: "candidate_content_matches_existing",
      existingState: "120",
    },
    { classification: "conflict", existingState: "100" },
    { classification: "conflict", existingState: [100] },
  ]) {
    const run = await prepareApprovedRun(fixture);
    run.remote.setOverride("prepare", bad);
    await assert.rejects(
      prepareResult(fixture, run, `inconsistent-${JSON.stringify(bad)}`),
      ({ code }) => {
        assert.equal(
          code,
          "result_process_prepare_response_binding_mismatch",
          JSON.stringify(bad),
        );
        return true;
      },
    );
  }

  // Content candidacy requires an identical attested content hash.
  const mismatched = await prepareApprovedRun(fixture);
  mismatched.remote.setOverride("prepare", {
    classification: "candidate_content_matches_existing",
    existingState: 120,
    contentSha256: "f".repeat(64),
  });
  await assert.rejects(
    prepareResult(fixture, mismatched, "candidate-hash-mismatch"),
    ({ code }) => code === "result_process_prepare_response_binding_mismatch",
  );
});

test("Receipt scalar fields are type-checked, not coerced", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const cases = [
    ["receiptId", [IDS.result], "a single-element array"],
    ["actorUserId", [MANAGER], "a single-element array"],
    ["id", [IDS.result], "a single-element array"],
    ["version", [VERSION], "a single-element array"],
    ["publishedAt", ["2026-09-15T00:00:00.000Z"], "a single-element array"],
    ["idempotencyKey", ["key"], "a single-element array"],
    ["reason", ["reason"], "a single-element array"],
    ["publishedAt", "not-a-timestamp", "a non-timestamp string"],
    ["receiptId", "not-a-uuid", "a non-uuid string"],
  ];
  for (const [field, bad, label] of cases) {
    const result = await runReadbackWithReceiptOverride(
      fixture,
      field,
      bad,
      label,
    );
    assert.equal(
      result,
      "result_process_independent_readback_failed",
      `${field} ${label}`,
    );
  }
});

test("A legacy 100 row for the Result identity is a conflict, never an upgrade", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  run.remote.insertRow({
    table: "processes",
    id: IDS.result,
    version: VERSION,
    contentText: fixture.resultContentText(),
    stateCode: 100,
    userId: MANAGER,
  });
  await assert.rejects(
    prepareResult(fixture, run, "legacy100"),
    ({ code, details }) => {
      assert.equal(code, "result_process_prepare_conflict");
      assert.equal(details.existingState, 100);
      return true;
    },
  );
  assert.equal(run.remote.getRow(IDS.result, VERSION).stateCode, 100);
  assert.equal(run.remote.commandCounts.execute, 0);
});

test("Content, source, audit, actor, identity and wire drift are all rejected", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "drift");
  const preparationPath = path.join(
    prepared.path,
    "result-process-preparation.json",
  );
  const original = await readFile(preparationPath, "utf8");
  const mutateFile = async (change) => {
    const value = JSON.parse(original);
    change(value);
    await writeFile(preparationPath, canonicalJson(value));
  };
  const attempt = (name, fetchImpl = run.remote.fetch) =>
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, `drift-${name}`),
      env: ENV,
      fetchImpl,
    });

  // actor: a different manager than the one recorded in the attestation.
  await mutateFile((value) => {
    value.actorUserId = IDS.unit;
  });
  // The preparation header must agree with the signed manager attestation.
  await assert.rejects(
    attempt("actor"),
    ({ code }) => code === "result_process_preparation_binding_mismatch",
  );
  await writeFile(preparationPath, original);

  // content: a different frozen byte hash on the prepared operation.
  await mutateFile((value) => {
    value.operations[0].candidateSha256 = "b".repeat(64);
  });
  await assert.rejects(
    attempt("content"),
    ({ code }) => code === "result_process_preparation_binding_mismatch",
  );
  await writeFile(preparationPath, original);

  // source: a different Candidate/source-manifest binding.
  await mutateFile((value) => {
    value.operations[0].sourceManifestHash = "a".repeat(64);
  });
  await assert.rejects(
    attempt("source"),
    ({ code }) => code === "result_process_preparation_binding_mismatch",
  );
  await writeFile(preparationPath, original);

  // identity: the prepared operation no longer matches an approved operation.
  await mutateFile((value) => {
    value.operations[0].uuid = IDS.unit;
  });
  await assert.rejects(
    attempt("identity"),
    ({ code }) => code === "result_process_preparation_binding_mismatch",
  );
  await writeFile(preparationPath, original);

  // content: bytes swapped on the wire no longer match the approved content hash.
  await assert.rejects(
    attempt(
      "bytes",
      mutateRpcRequest(run.remote.fetch, (request) => ({
        ...request,
        contentText: canonicalJson({
          processDataSet: {
            ...JSON.parse(request.contentText).processDataSet,
            swapped: true,
          },
        }),
      })),
    ),
    ({ code }) => code === "result_content_hash_mismatch",
  );

  // audit: a rewritten reason reaches the remote, which rejects it as stale
  // rather than publishing a different attested binding.
  await assert.rejects(
    attempt(
      "audit",
      mutateRpcRequest(run.remote.fetch, (request) => ({
        ...request,
        audit: { reason: "different reason" },
      })),
    ),
    ({ code }) => code === "result_preparation_stale",
  );

  // Every attempt was rejected before any insert: no partial row survives.
  assert.equal(run.remote.commandCounts.execute, 2);
  assert.equal(run.remote.getRow(IDS.result, VERSION), null);
});

test("The dedicated route re-verifies approval expiry and copied artifacts", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  // F3a: expired approval. The preparation was made while it was valid.
  const expiredRun = await prepareApprovedRun(fixture, {
    expiresAt: "2026-09-15T00:02:30.000Z",
  });
  const expiredPrepared = await prepareResult(
    fixture,
    expiredRun,
    "dedicated-expired",
  );
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: expiredPrepared.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "dedicated-expired-execution"),
      env: ENV,
      fetchImpl: expiredRun.remote.fetch,
      now: () => new Date("2026-09-15T00:10:00.000Z"),
    }),
    ({ code }) => code === "publication_approval_expired",
  );
  assert.equal(expiredRun.remote.commandCounts.execute, 0);

  // F3b: a swapped copied approval is rejected, not trusted because it sits next
  // to the preparation.
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "dedicated-copy");
  const approvalPath = path.join(prepared.path, "publication-approval.json");
  const originalApproval = await readFile(approvalPath, "utf8");
  const swapped = JSON.parse(originalApproval);
  swapped.expiresAt = "2027-01-01T00:00:00.000Z";
  await writeFile(approvalPath, canonicalJson(swapped));
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "dedicated-copy-execution"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code }) => code === "result_process_preparation_binding_mismatch",
  );
  await writeFile(approvalPath, originalApproval);

  // F3c: a swapped copied executable plan is rejected.
  const planPath = path.join(prepared.path, "publication-executable-plan.json");
  const originalPlan = await readFile(planPath, "utf8");
  const driftedPlan = JSON.parse(originalPlan);
  driftedPlan.operations[0].observedStateCode = 100;
  await writeFile(planPath, canonicalJson(driftedPlan));
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "dedicated-plan-execution"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code }) => code === "publication_approval_plan_hash_mismatch",
  );
  await writeFile(planPath, originalPlan);

  // F3d: a resealed preparation (operation-set digest matching its own tampered
  // operations) still fails against the approved plan.
  const preparationPath = path.join(
    prepared.path,
    "result-process-preparation.json",
  );
  const originalPreparation = await readFile(preparationPath, "utf8");
  const resealed = JSON.parse(originalPreparation);
  resealed.operations[0].uuid = IDS.unit;
  resealed.operationSetHash = hashJson(resealed.operations);
  await writeFile(preparationPath, canonicalJson(resealed));
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "dedicated-resealed-execution"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code }) => code === "result_process_preparation_binding_mismatch",
  );
  await writeFile(preparationPath, originalPreparation);

  // F3e: duplicated prepared operations fail rather than overwriting silently.
  const duplicated = JSON.parse(originalPreparation);
  duplicated.operations = [
    duplicated.operations[0],
    { ...duplicated.operations[0] },
  ];
  duplicated.operationCount = 2;
  duplicated.operationSetHash = hashJson(duplicated.operations);
  await writeFile(preparationPath, canonicalJson(duplicated));
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "dedicated-duplicate-execution"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code }) =>
      [
        "result_process_preparation_incomplete",
        "result_process_preparation_invalid",
        "result_process_preparation_binding_mismatch",
      ].includes(code),
  );
  await writeFile(preparationPath, originalPreparation);

  // The pristine preparation still executes.
  const execution = await executeResultProcessPublication({
    preparationDir: prepared.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "dedicated-ok-execution"),
    env: ENV,
    fetchImpl: run.remote.fetch,
  });
  assert.equal(execution.receipt.status, "published");
  assert.equal(run.remote.getRow(IDS.result, VERSION).stateCode, 120);
});

test("A matching-120 generic observation cannot bypass or crash the Result route", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  // A row already exists at 120 with the exact frozen bytes, so the generic
  // actor-scoped observation would classify it as matching_published. The
  // reviewed contract is explicit that content candidacy is never authorization
  // and never a no-op, so the operation must still be a remote write released
  // only by an exact receipt.
  const remote = createPublicationMock({
    actorUserId: MANAGER,
    rows: [
      {
        table: "processes",
        id: IDS.result,
        version: VERSION,
        contentText: fixture.resultContentText(),
        stateCode: 120,
        userId: MANAGER,
      },
    ],
  });
  const inspection = await inspectPublicationTarget({
    planDir: fixture.planDir,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "matching120-inspection"),
    env: ENV,
    fetchImpl: remote.fetch,
    now: () => new Date("2026-09-15T00:00:00.000Z"),
  });
  const [resultOperation] = inspection.executablePlan.operations.filter(
    (operation) => operation.role === "result_process",
  );
  assert.equal(resultOperation.remoteWrites, true);
  assert.equal(resultOperation.action, "reconcile_via_manager_command");
  assert.notEqual(resultOperation.action, "already_published_noop");

  const approval = await createPublicationApproval({
    inspectionDir: inspection.path,
    outDir: path.join(fixture.root, "matching120-approval"),
    confirmPlanSha256: inspection.executablePlanSha256,
    approvedBy: "release-manager@example.test",
    attestedByUserId: MANAGER,
    reason: "publish attested result process",
    expiresAt: "2026-09-17T00:00:00.000Z",
    now: () => new Date("2026-09-15T00:01:00.000Z"),
  });
  const prepared = await prepareResultProcessPublication({
    approvalDir: approval.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "matching120-preparation"),
    env: ENV,
    fetchImpl: remote.fetch,
    now: () => new Date("2026-09-15T00:02:00.000Z"),
  });
  // Prepare reports content candidacy, which is not authorization and not a no-op.
  const [operation] = prepared.preparation.operations;
  assert.equal(
    operation.preparationClassification,
    "candidate_content_matches_existing",
  );
  assert.equal(operation.preparationExistingState, 120);

  // Execute cannot crash on a missing preparation, and cannot silently no-op: the
  // RPC answers that there is no receipt for this binding.
  const executionDir = path.join(fixture.root, "matching120-execution");
  await assert.rejects(
    executePublication({
      approvalDir: approval.path,
      payloadDir: fixture.payloadDir,
      outDir: executionDir,
      resultPreparationDir: prepared.path,
      env: ENV,
      fetchImpl: remote.fetch,
      now: () => new Date("2026-09-15T00:03:00.000Z"),
    }),
    ({ code }) => {
      assert.equal(code, "result_publication_conflict");
      return true;
    },
  );
  // No execution receipt and a typed failure event: never a silent success.
  assert.equal(
    await readFile(
      path.join(executionDir, "publication-execution-receipt.json"),
      "utf8",
    ).catch(() => null),
    null,
  );
  const events = await readEventDirectory(path.join(executionDir, "events"));
  assert.equal(events.at(-1).event.outcome, "failed");

  // Mixed execution without a preparation must fail typed, not crash.
  await assert.rejects(
    executePublication({
      approvalDir: approval.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "matching120-no-preparation"),
      env: ENV,
      fetchImpl: remote.fetch,
      now: () => new Date("2026-09-15T00:03:00.000Z"),
    }),
    ({ code }) => code === "result_process_preparation_required",
  );
});

test("A preparation for another approval of the same payload and actor cannot be mixed in", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  // Two independently valid approvals of the SAME payload and actor, differing
  // only in reason and approval fields, so both plans/hashes are legitimate.
  const runA = await prepareApprovedRun(fixture);
  const runB = await prepareApprovedRun(fixture, {
    reason: "publish under a different authorization",
  });
  assert.notEqual(runA.approval.approvalSha256, runB.approval.approvalSha256);
  assert.equal(
    runA.approval.approval.payloadManifestSha256,
    runB.approval.approval.payloadManifestSha256,
  );

  // A preparation built under approval B.
  const preparedB = await prepareResult(fixture, runB, "approval-b");

  // Executing B's preparation under A must fail before any remote mutation.
  const beforeExecute = runA.remote.commandCounts.execute;
  await assert.rejects(
    executePublication({
      approvalDir: runA.approval.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "mixed-b-under-a"),
      resultPreparationDir: preparedB.path,
      env: ENV,
      fetchImpl: runA.remote.fetch,
      now: () => new Date("2026-09-15T00:03:00.000Z"),
    }),
    ({ code, details }) => {
      assert.equal(code, "result_process_evidence_binding_mismatch");
      assert.equal(
        details.mismatches.some(({ field }) => field === "approvalSha256"),
        true,
      );
      return true;
    },
  );
  // No ordinary write and no Result RPC happened under approval A.
  assert.equal(runA.remote.commandCounts.execute, beforeExecute);
  assert.equal(runA.remote.commandCounts.create, 0);
  assert.equal(runA.remote.commandCounts.publish, 0);
  assert.equal(runA.remote.getRow(IDS.result, VERSION), null);

  // A complete publication under A, then A's execution read back with B's
  // preparation, must fail before any readback is treated as evidence.
  const preparedA = await prepareResult(fixture, runA, "approval-a");
  const execution = await executePublication({
    approvalDir: runA.approval.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "mixed-a-execution"),
    resultPreparationDir: preparedA.path,
    env: ENV,
    fetchImpl: runA.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
  assert.equal(execution.receipt.status, "published");
  await assert.rejects(
    verifyPublicationReadback({
      executionDir: execution.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "mixed-a-readback-with-b"),
      resultPreparationDir: preparedB.path,
      env: ENV,
      fetchImpl: runA.remote.fetch,
    }),
    ({ code, details }) => {
      assert.equal(code, "result_process_evidence_binding_mismatch");
      assert.equal(
        details.mismatches.some(({ field }) => field === "approvalSha256"),
        true,
      );
      return true;
    },
  );

  // The matching preparation still reads back successfully.
  const readback = await verifyPublicationReadback({
    executionDir: execution.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "mixed-a-readback"),
    resultPreparationDir: preparedA.path,
    env: ENV,
    fetchImpl: runA.remote.fetch,
  });
  assert.equal(readback.receipt.status, "verified");
});

test("Preparation headers must align with the verified copied evidence", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "headers");
  const preparationPath = path.join(
    prepared.path,
    "result-process-preparation.json",
  );
  const original = await readFile(preparationPath, "utf8");

  for (const [field, bad] of [
    ["targetId", "different-target"],
    ["contractVersion", 3],
    ["sourceKind", "machine_verified"],
    ["targetEndpointFingerprint", "a".repeat(64)],
    ["actorUserId", IDS.unit],
  ]) {
    const value = JSON.parse(original);
    value[field] = bad;
    await writeFile(preparationPath, canonicalJson(value));
    await assert.rejects(
      executeResultProcessPublication({
        preparationDir: prepared.path,
        payloadDir: fixture.payloadDir,
        outDir: path.join(fixture.root, `header-${field}`),
        env: ENV,
        fetchImpl: run.remote.fetch,
      }),
      ({ code, details }) => {
        assert.equal(
          code,
          "result_process_preparation_binding_mismatch",
          field,
        );
        assert.equal(
          details.mismatches.some((entry) => entry.field === field),
          true,
          field,
        );
        return true;
      },
    );
    await writeFile(preparationPath, original);
  }
  assert.equal(run.remote.commandCounts.execute, 0);
});

test("Expiry gates execution but not readback of a completed publication", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  // An approval that is valid now, used to complete a publication.
  const run = await prepareApprovedRun(fixture, {
    expiresAt: "2026-09-15T01:00:00.000Z",
  });
  const prepared = await prepareResult(fixture, run, "freshness");
  const execution = await executePublication({
    approvalDir: run.approval.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "freshness-execution"),
    resultPreparationDir: prepared.path,
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
  assert.equal(execution.receipt.status, "published");

  // Later, the approval has expired. Execution is refused...
  const afterExpiry = () => new Date("2026-09-15T02:00:00.000Z");
  const laterRun = await prepareApprovedRun(fixture, {
    expiresAt: "2026-09-15T01:00:00.000Z",
  });
  const laterPrepared = await prepareResult(
    fixture,
    laterRun,
    "freshness-late",
  );
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: laterPrepared.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "freshness-late-execution"),
      env: ENV,
      fetchImpl: laterRun.remote.fetch,
      now: afterExpiry,
    }),
    ({ code }) => code === "publication_approval_expired",
  );
  await assert.rejects(
    executePublication({
      approvalDir: laterRun.approval.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "freshness-late-mixed"),
      resultPreparationDir: laterPrepared.path,
      env: ENV,
      fetchImpl: laterRun.remote.fetch,
      now: afterExpiry,
    }),
    ({ code }) => code === "publication_approval_expired",
  );

  // ...but the already completed publication is still verifiable, because its
  // authorization was valid when it ran and every RPC re-checks the live role.
  const readback = await verifyPublicationReadback({
    executionDir: execution.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "freshness-readback"),
    resultPreparationDir: prepared.path,
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: afterExpiry,
  });
  assert.equal(readback.receipt.status, "verified");
  assert.equal(readback.receipt.rows.length > 0, true);

  // The dedicated readback surface behaves the same way.
  const dedicatedExecution = await executeResultProcessPublication({
    preparationDir: prepared.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "freshness-dedicated-execution"),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:04:00.000Z"),
  });
  const dedicatedReadback = await verifyResultProcessReadback({
    executionDir: dedicatedExecution.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "freshness-dedicated-readback"),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: afterExpiry,
  });
  assert.equal(dedicatedReadback.receipt.status, "verified");

  // Live role checks are not weakened: revoking the manager still blocks readback.
  run.remote.setManagerActive(false);
  await assert.rejects(
    verifyResultProcessReadback({
      executionDir: dedicatedExecution.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "freshness-revoked-readback"),
      env: ENV,
      fetchImpl: run.remote.fetch,
      now: afterExpiry,
    }),
    ({ code }) => code === "not_data_product_manager",
  );
});

test("A malformed approval timestamp cannot bypass the execute freshness gate", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "malformed-expiry");
  for (const approvalDir of [run.approval.path, prepared.path]) {
    const approvalPath = path.join(approvalDir, "publication-approval.json");
    const original = await readFile(approvalPath, "utf8");
    for (const bad of ["not-a-date", null, 12345]) {
      const value = JSON.parse(original);
      value.expiresAt = bad;
      await writeFile(approvalPath, canonicalJson(value));
      await assert.rejects(
        executePublication({
          approvalDir: run.approval.path,
          payloadDir: fixture.payloadDir,
          outDir: path.join(fixture.root, `malformed-${String(bad)}`),
          resultPreparationDir: prepared.path,
          env: ENV,
          fetchImpl: run.remote.fetch,
        }),
        ({ code }) => {
          // Either the approval is rejected as malformed, or the copy beside the
          // preparation no longer binds it. Both fail closed before any write.
          assert.equal(
            [
              "publication_approval_invalid",
              "result_process_preparation_binding_mismatch",
              "result_process_evidence_binding_mismatch",
            ].includes(code),
            true,
            `${approvalDir === prepared.path ? "copy" : "origin"}: ${code}`,
          );
          return true;
        },
      );
    }
    await writeFile(approvalPath, original);
  }
  assert.equal(run.remote.commandCounts.execute, 0);
});

test("A reused execution directory rejects mismatched copied evidence", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "reused");
  const executionDir = path.join(fixture.root, "reused-execution");

  // A first partial execution leaves the approved artifacts in place.
  run.remote.failNextExecuteFor(IDS.result);
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: executionDir,
      env: ENV,
      fetchImpl: run.remote.fetch,
      now: () => new Date("2026-09-15T00:03:00.000Z"),
    }),
    () => true,
  );

  // Swap a copied artifact to something else, as a tampered or stale directory
  // would. Resuming must refuse rather than silently retain the wrong evidence.
  const copiedPlanPath = path.join(
    executionDir,
    "publication-executable-plan.json",
  );
  const originalPlan = await readFile(copiedPlanPath, "utf8");
  const swapped = JSON.parse(originalPlan);
  swapped.operations[0].observedStateCode = 0;
  await writeFile(copiedPlanPath, canonicalJson(swapped));

  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: executionDir,
      env: ENV,
      fetchImpl: run.remote.fetch,
      now: () => new Date("2026-09-15T00:04:00.000Z"),
    }),
    ({ code }) => {
      assert.equal(
        [
          "result_process_execution_evidence_mismatch",
          "publication_approval_plan_hash_mismatch",
        ].includes(code),
        true,
        code,
      );
      return true;
    },
  );
  await writeFile(copiedPlanPath, originalPlan);

  // With the correct copy restored, the resume proceeds and completes.
  const resumed = await executeResultProcessPublication({
    preparationDir: prepared.path,
    payloadDir: fixture.payloadDir,
    outDir: executionDir,
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:05:00.000Z"),
  });
  assert.equal(resumed.receipt.status, "published");
});

test("Preparation, plan and approval hashes stay distinct and uncircular", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "hashes");
  const [operation] = prepared.preparation.operations;
  assert.notEqual(
    operation.preparationHash,
    prepared.preparation.executablePlanSha256,
  );
  assert.notEqual(
    operation.preparationHash,
    prepared.preparation.approvalSha256,
  );
  assert.notEqual(
    prepared.preparationSha256,
    prepared.preparation.approvalSha256,
  );
  // Prepare carried no plan or approval hash, so it cannot depend on them.
  assert.equal(
    operation.executablePlanHash,
    prepared.preparation.executablePlanSha256,
  );
  assert.equal(operation.approvalHash, prepared.preparation.approvalSha256);
  const execution = await executeResultProcessExecution(fixture, run, prepared);
  const receipt = run.remote.receipts.values().next().value;
  assert.equal(receipt.executablePlanHash, run.approval.executablePlanSha256);
  assert.equal(receipt.approvalHash, run.approval.approvalSha256);
  assert.equal(receipt.preparationHash, operation.preparationHash);
  assert.notEqual(receipt.preparationHash, receipt.executablePlanHash);
  assert.notEqual(receipt.preparationHash, receipt.approvalHash);
  assert.equal(receipt.candidateSetHash, prepared.preparation.candidateSetHash);
  assert.equal(
    receipt.sourceManifestHash,
    prepared.preparation.sourceManifestHash,
  );
  assert.equal(receipt.reason, "publish attested result process");
  assert.equal(execution.receipt.status, "published");
});

test("A wrong-but-valid preparation digest is never accepted as success", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  // Execute: the server echoes a different, syntactically valid digest. It must
  // be bound, not merely format-checked.
  const executeRun = await prepareApprovedRun(fixture);
  executeRun.remote.setOverride("execute", { preparationHash: "e".repeat(64) });
  const executePrepared = await prepareResult(
    fixture,
    executeRun,
    "digest-execute",
  );
  await assert.rejects(
    executeResultProcessExecution(
      fixture,
      executeRun,
      executePrepared,
      "digest-execute",
    ),
    ({ code, details }) => {
      assert.equal(code, "result_process_receipt_binding_mismatch");
      assert.equal(details.mismatches[0].field, "preparationHash");
      assert.equal(
        details.mismatches[0].expected,
        executePrepared.preparation.operations[0].preparationHash,
      );
      assert.equal(details.mismatches[0].observed, "e".repeat(64));
      return true;
    },
  );
  // No execution receipt was written, so nothing claims success.
  assert.equal(
    await readFile(
      path.join(
        fixture.root,
        "digest-execute-execution",
        "result-process-execution-receipt.json",
      ),
      "utf8",
    ).catch(() => null),
    null,
  );

  // Recovery: the lost response is reconciled through a readback whose receipt
  // carries a different digest. That is reported, never downgraded to
  // "not published", so no success is fabricated.
  const recoveryRun = await prepareApprovedRun(fixture);
  recoveryRun.remote.setOverride("readbackReceipt", {
    preparationHash: "f".repeat(64),
  });
  recoveryRun.remote.loseNextExecuteResponseFor(IDS.result);
  const recoveryPrepared = await prepareResult(
    fixture,
    recoveryRun,
    "digest-recovery",
  );
  await assert.rejects(
    executeResultProcessExecution(
      fixture,
      recoveryRun,
      recoveryPrepared,
      "digest-recovery",
    ),
    ({ code, details }) => {
      assert.equal(code, "result_process_receipt_binding_mismatch");
      assert.equal(details.mismatches[0].field, "preparationHash");
      return true;
    },
  );
  const events = await readEventDirectory(
    path.join(fixture.root, "digest-recovery-execution", "events"),
  );
  assert.equal(events.at(-1).event.outcome, "failed");
});

test("Lost-response reconciliation enforces the same server verification flags", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  // The write committed but the response was lost. Reconciliation then reads
  // back a row the server does not fully vouch for. A failed manager verdict
  // must be reported, never downgraded to "not published" and never treated as
  // success, even though the local content recomputation succeeds.
  for (const flag of [
    "rowMatchesReceipt",
    "receiptMatchesRequest",
    "liveManager",
  ]) {
    const run = await prepareApprovedRun(fixture);
    run.remote.setOverride("readbackVerified", { [flag]: false });
    run.remote.loseNextExecuteResponseFor(IDS.result);
    const prepared = await prepareResult(fixture, run, `reconcile-${flag}`);
    const executionDir = path.join(fixture.root, `reconcile-${flag}-execution`);
    await assert.rejects(
      executeResultProcessExecution(
        fixture,
        run,
        prepared,
        `reconcile-${flag}`,
      ),
      ({ code, details }) => {
        assert.equal(
          code,
          "result_process_readback_server_verification_failed",
          flag,
        );
        assert.deepEqual(details.failedFlags, [flag]);
        return true;
      },
    );
    // The attempt is recorded as failed and no execution receipt claims success.
    const events = await readEventDirectory(path.join(executionDir, "events"));
    assert.equal(events.at(-1).event.outcome, "failed");
    assert.equal(
      await readFile(
        path.join(executionDir, "result-process-execution-receipt.json"),
        "utf8",
      ).catch(() => null),
      null,
    );
    // The committed row is still there; the workflow simply refuses to claim it.
    assert.equal(run.remote.getRow(IDS.result, VERSION).stateCode, 120);
  }
});

test("Same-key retry reuses the identical receipt; a different key conflicts", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "retry");
  await executeResultProcessExecution(fixture, run, prepared, "retry-first");
  const firstReceipt = run.remote.receipts.values().next().value;

  // Replaying the exact same request returns the identical stored receipt.
  const replay = await executeResultProcessPublication({
    preparationDir: prepared.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "retry-second"),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:05:00.000Z"),
  });
  assert.equal(run.remote.commandCounts.execute, 2);
  assert.equal(
    firstReceipt.receiptId,
    run.remote.receipts.values().next().value.receiptId,
  );

  // A different idempotency key against the existing identity conflicts.
  const preparationPath = path.join(
    prepared.path,
    "result-process-preparation.json",
  );
  const original = await readFile(preparationPath, "utf8");
  const mutated = JSON.parse(original);
  mutated.operations[0].idempotencyKey = "c".repeat(64);
  mutated.operationSetHash = hashJson(mutated.operations);
  await writeFile(preparationPath, canonicalJson(mutated));
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "retry-other-key"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code }) => code === "result_publication_conflict",
  );
  await writeFile(preparationPath, original);
  assert.equal(replay.receipt.status, "published");
});

test("A lost execute response is recovered only through an exact-binding readback", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "lost");
  run.remote.loseNextExecuteResponseFor(IDS.result);

  const execution = await executeResultProcessPublication({
    preparationDir: prepared.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "lost-execution"),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
  assert.equal(execution.receipt.status, "published");
  assert.equal(run.remote.commandCounts.readback, 1);
  const events = await readEventDirectory(path.join(execution.path, "events"));
  const reconciled = events.find(
    ({ event }) => event.disposition === "reconciled_after_transport_loss",
  );
  assert.ok(reconciled, "expected a reconciled event");
  assert.equal(reconciled.event.outcome, "already_published");
  // The row still exists exactly once, at 120.
  assert.equal(run.remote.getRow(IDS.result, VERSION).stateCode, 120);
});

test("An indeterminate execute failure is not reported as success", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "indeterminate");
  run.remote.failNextExecuteFor(IDS.result);
  const executionDir = path.join(fixture.root, "indeterminate-execution");
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: executionDir,
      env: ENV,
      fetchImpl: run.remote.fetch,
      now: () => new Date("2026-09-15T00:03:00.000Z"),
    }),
    ({ code, details }) => {
      // A definite command error means the whole transaction rolled back, so no
      // success is claimed and no partial row survives.
      assert.equal(code, "injected_execute_failure");
      assert.equal(details.executionDirectory, executionDir);
      return true;
    },
  );
  const events = await readEventDirectory(path.join(executionDir, "events"));
  assert.equal(events.at(-1).event.outcome, "failed");
  assert.equal(run.remote.getRow(IDS.result, VERSION), null);
  assert.equal(
    await readFile(
      path.join(executionDir, "result-process-execution-receipt.json"),
      "utf8",
    ).catch(() => null),
    null,
  );
});

test("Role revocation rejects every prepare, execute and readback call", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "revoked");
  run.remote.setManagerActive(false);
  await assert.rejects(
    prepareResultProcessPublication({
      approvalDir: run.approval.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "revoked-prepare"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code, details }) => {
      assert.equal(code, "not_data_product_manager");
      assert.equal(details.semanticStatus, 403);
      return true;
    },
  );
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "revoked-execute"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code }) => code === "not_data_product_manager",
  );
  await assert.rejects(
    verifyResultProcessReadback({
      executionDir: path.join(fixture.root, "revoked-execute"),
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "revoked-readback"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code }) => code === "result_process_execution_receipt_missing",
  );
  assert.equal(run.remote.getRow(IDS.result, VERSION), null);
});

test("An expired approval cannot authorize a Result Process write", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture, {
    expiresAt: "2026-09-15T00:01:30.000Z",
  });
  const prepared = await prepareResult(fixture, run, "expired");
  await assert.rejects(
    executePublication({
      approvalDir: run.approval.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "expired-execution"),
      resultPreparationDir: prepared.path,
      env: ENV,
      fetchImpl: run.remote.fetch,
      now: () => new Date("2026-09-15T00:10:00.000Z"),
    }),
    ({ code }) => code === "publication_approval_expired",
  );
  assert.equal(run.remote.commandCounts.execute, 0);
  assert.equal(run.remote.commandCounts.create, 0);
});

test("A manager attestation naming a different actor cannot authorize the write", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture, { attestedByUserId: IDS.flow });
  await assert.rejects(
    prepareResult(fixture, run, "actor-mismatch"),
    ({ code, details }) => {
      assert.equal(code, "result_process_attestation_actor_mismatch");
      assert.equal(details.attestedByUserId, IDS.flow);
      return true;
    },
  );
  assert.equal(run.remote.commandCounts.prepare, 0);
});

test("Independent readback fails separately for byte-hash, canonical-identity, binding and preparation drift", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  // 1. Stored bytes no longer hash to the frozen Candidate.
  await assertReadbackFailure(fixture, {
    name: "byte-hash",
    overrides: {
      readbackRow: { contentText: canonicalJson({ tampered: true }) },
    },
    expected: "result_process_readback_byte_hash_mismatch",
  });

  // 2. Bytes hash consistently but the document is not the Candidate content.
  await assertReadbackFailure(fixture, {
    name: "canonical-identity",
    overrides: {
      readbackRow: {
        contentText: canonicalJson({
          processDataSet: { id: "different-document" },
        }),
      },
    },
    expected: "result_process_readback_byte_hash_mismatch",
  });

  // 3. A receipt bound to different source evidence.
  await assertReadbackFailure(fixture, {
    name: "receipt-binding",
    overrides: {
      readbackReceipt: { sourceManifestHash: "d".repeat(64) },
    },
    expected: "result_process_receipt_binding_mismatch",
  });

  // 4. A receipt carrying a different, but syntactically valid, preparation
  //    digest. The shared receipt validator binds it on every path.
  await assertReadbackFailure(fixture, {
    name: "preparation",
    overrides: {
      readbackReceipt: { preparationHash: "e".repeat(64) },
    },
    expected: "result_process_receipt_binding_mismatch",
  });

  // 5. A row that is not at the Result Process target state.
  await assertReadbackFailure(fixture, {
    name: "state",
    overrides: { readbackRow: { stateCode: 100 } },
    expected: "result_process_readback_state_mismatch",
  });

  // 6. Server verification is mandatory and strict: every flag must be a real
  //    boolean and true. Local recomputation proves content binding, NOT that the
  //    reading actor still holds the live manager role, so it cannot substitute.
  for (const flag of [
    "rowMatchesReceipt",
    "receiptMatchesRequest",
    "liveManager",
  ]) {
    for (const bad of [false, null, "true", 1, undefined]) {
      const label = `${flag}=${bad === undefined ? "missing" : JSON.stringify(bad)}`;
      const fixture2 = await createMixedFixture();
      t.after(() => rm(fixture2.root, { recursive: true, force: true }));
      const run = await prepareApprovedRun(fixture2);
      run.remote.setOverride("readbackVerified", { [flag]: bad });
      const prepared = await prepareResult(fixture2, run, `flags-${label}`);
      await executeResultProcessExecution(
        fixture2,
        run,
        prepared,
        `flags-${label}`,
      );
      await assert.rejects(
        verifyResultProcessReadback({
          executionDir: path.join(fixture2.root, `flags-${label}-execution`),
          payloadDir: fixture2.payloadDir,
          outDir: path.join(fixture2.root, `flags-${label}-readback`),
          env: ENV,
          fetchImpl: run.remote.fetch,
        }),
        ({ code, details }) => {
          assert.equal(
            code,
            "result_process_independent_readback_failed",
            label,
          );
          // A missing flag never reaches the flag check: the response envelope
          // itself is already invalid, which is equally fail-closed.
          assert.equal(
            details.failures[0].code,
            bad === false
              ? "result_process_readback_server_verification_failed"
              : bad === undefined
                ? "result_process_readback_response_invalid"
                : "result_process_readback_server_verification_invalid",
            label,
          );
          return true;
        },
      );
    }
  }

  // 7. All three flags true: content is still recomputed locally and both halves
  //    are recorded, so neither check silently replaces the other.
  const fixture2 = await createMixedFixture();
  t.after(() => rm(fixture2.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture2);
  const prepared = await prepareResult(fixture2, run, "flags-ok");
  await executeResultProcessExecution(fixture2, run, prepared, "flags-ok");
  const readback = await verifyResultProcessReadback({
    executionDir: path.join(fixture2.root, "flags-ok-execution"),
    payloadDir: fixture2.payloadDir,
    outDir: path.join(fixture2.root, "flags-ok-readback"),
    env: ENV,
    fetchImpl: run.remote.fetch,
  });
  assert.equal(readback.receipt.status, "verified");
  assert.deepEqual(readback.receipt.rows[0].serverVerified, {
    rowMatchesReceipt: true,
    receiptMatchesRequest: true,
    liveManager: true,
  });
  assert.equal(
    readback.receipt.rows[0].observedByteHash,
    fixture2.datasetById(IDS.result).sha256,
  );
});

test("Mixed-state execution is ordered and explicitly non-atomic across RPCs", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "non-atomic");

  // Operations run in the plan's sorted order, so the ordinary dependencies
  // (flow, then lifecyclemodel) precede the Result Process (process).
  const order = run.inspection.executablePlan.operations.map(({ key }) => key);
  assert.deepEqual(order, [
    `flow:${IDS.flow}@${VERSION}`,
    `lifecyclemodel:${IDS.model}@${VERSION}`,
    `process:${IDS.unit}@${VERSION}`,
    `process:${IDS.result}@${VERSION}`,
  ]);

  // Fail the last ordinary operation after the Result Process already committed
  // at 120. The platform offers no cross-RPC transaction, so the run fails while
  // the committed 120 row remains: that partial state is reported, never hidden.
  const executionDir = path.join(fixture.root, "non-atomic-execution");
  run.remote.failNextExecuteFor(IDS.result);
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: executionDir,
      env: ENV,
      fetchImpl: run.remote.fetch,
      now: () => new Date("2026-09-15T00:03:00.000Z"),
    }),
    ({ code, details }) => {
      assert.equal(code, "injected_execute_failure");
      assert.equal(details.failedKey, `process:${IDS.result}@${VERSION}`);
      // The failed transaction rolled back, so nothing is claimed for it.
      assert.equal(run.remote.getRow(IDS.result, VERSION), null);
      return true;
    },
  );
  const events = await readEventDirectory(path.join(executionDir, "events"));
  assert.equal(events.at(-1).event.outcome, "failed");
  assert.equal(
    await readFile(
      path.join(executionDir, "result-process-execution-receipt.json"),
      "utf8",
    ).catch(() => null),
    null,
  );

  // Now prove the stronger non-atomicity property: the Result Process commits at
  // 120, a later ordinary operation then fails, and the 120 row keeps existing.
  // The plan order runs ordinary operations first, so make the *last* ordinary
  // publish fail by failing the platform publish for the Result's predecessor.
  const secondRun = await prepareApprovedRun(fixture);
  const secondPrepared = await prepareResult(
    fixture,
    secondRun,
    "non-atomic-2",
  );
  const mixedDir = path.join(fixture.root, "non-atomic-mixed");
  const failingFetch = failPlatformPublishFor(
    secondRun.remote.fetch,
    IDS.result === "" ? "" : IDS.unit,
  );
  await assert.rejects(
    executePublication({
      approvalDir: secondRun.approval.path,
      payloadDir: fixture.payloadDir,
      outDir: mixedDir,
      resultPreparationDir: secondPrepared.path,
      env: ENV,
      fetchImpl: failingFetch,
      now: () => new Date("2026-09-15T00:05:00.000Z"),
    }),
    ({ code, details }) => {
      assert.equal(code, "injected_publish_failure");
      assert.equal(details.resumeSafe, true);
      assert.deepEqual(details.completedKeys, [
        `flow:${IDS.flow}@${VERSION}`,
        `lifecyclemodel:${IDS.model}@${VERSION}`,
      ]);
      return true;
    },
  );
  // The two completed ordinary identities survive, the failed one did not
  // publish, and the run has no final receipt. The workflow reports a resumable
  // partial state instead of a false success.
  assert.equal(
    secondRun.remote.getRow(IDS.flow, VERSION, "flows").stateCode,
    100,
  );
  assert.equal(
    secondRun.remote.getRow(IDS.model, VERSION, "lifecyclemodels").stateCode,
    100,
  );
  // The identity whose publish failed stayed unpublished.
  assert.equal(secondRun.remote.getRow(IDS.unit, VERSION).stateCode, 0);
  assert.equal(
    await readFile(
      path.join(mixedDir, "publication-execution-receipt.json"),
      "utf8",
    ).catch(() => null),
    null,
  );
  const mixedEvents = await readEventDirectory(path.join(mixedDir, "events"));
  assert.equal(mixedEvents.at(-1).event.outcome, "failed");
  // No Result write was attempted at all in this run, and no receipt claims one.
  assert.equal(secondRun.remote.commandCounts.execute, 0);
});

/**
 * Fail the platform `app_dataset_publish` for one identity, so a mixed-state run
 * can be stopped after an earlier identity already committed.
 */
function failPlatformPublishFor(fetchImpl, uuid) {
  let remaining = 1;
  return async (url, options = {}) => {
    if (
      remaining > 0 &&
      String(url).endsWith("/app_dataset_publish") &&
      options.body
    ) {
      const body = JSON.parse(options.body);
      if (body.id === uuid) {
        remaining -= 1;
        return new Response(
          JSON.stringify({ ok: false, code: "INJECTED_PUBLISH_FAILURE" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
    }
    return fetchImpl(url, options);
  };
}

test("No Result Process identity is ever routed through the 0/100 platform commands", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "no-100");
  const execution = await executePublication({
    approvalDir: run.approval.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "no-100-execution"),
    resultPreparationDir: prepared.path,
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
  assert.equal(execution.receipt.status, "published");

  // Trace every platform write command. The Model bundle carries no
  // processMutations, so it can never create a Result Process through the old
  // 0/100 route either.
  const resultKey = `process:${IDS.result}@${VERSION}`;
  assert.deepEqual(
    run.remote.platformCommands.filter(({ body }) => body.id === IDS.result),
    [],
  );
  assert.deepEqual(
    run.remote.platformCommands.filter(
      ({ body }) => documentIdentity(body) === IDS.result,
    ),
    [],
  );
  for (const { command, body } of run.remote.platformCommands.filter(
    ({ command: name }) => name === "save_lifecycle_model_bundle",
  )) {
    assert.deepEqual(body.processMutations ?? [], [], command);
    assert.notEqual(body.modelId, IDS.result, command);
  }
  // The Result row exists exactly once, at 120, created by the manager command.
  const resultRow = run.remote.getRow(IDS.result, VERSION);
  assert.equal(resultRow.stateCode, 120);
  assert.equal(resultRow.source, "result_process_command");
  assert.equal(run.remote.getRow(IDS.unit, VERSION).stateCode, 100);
  assert.equal(run.remote.getRow(IDS.flow, VERSION, "flows").stateCode, 100);
  assert.equal(
    run.remote.getRow(IDS.model, VERSION, "lifecyclemodels").stateCode,
    100,
  );
  assert.equal(resultKey, `process:${IDS.result}@${VERSION}`);
});

test("The 0/100 platform command refuses a Result Process dataset outright", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "route-violation");
  const preparationPath = path.join(
    prepared.path,
    "result-process-preparation.json",
  );
  const original = await readFile(preparationPath, "utf8");
  const mutated = JSON.parse(original);
  // Force the plan-side operation to look ordinary, which is exactly the
  // mis-routing this guard exists for.
  mutated.operations[0].role = "unit_process";
  await writeFile(preparationPath, canonicalJson(mutated));
  await assert.rejects(
    executeResultProcessPublication({
      preparationDir: prepared.path,
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, "route-violation-execution"),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code }) => code === "result_process_preparation_binding_mismatch",
  );
  await writeFile(preparationPath, original);
  // Even if that binding had passed, the platform command itself refuses.
  const leaked = run.remote.platformCommands.filter(
    ({ body }) => body.id === IDS.result,
  );
  assert.deepEqual(leaked, []);
});

test("Canonical and stored-byte hash domains stay separate in durable events", async (t) => {
  // Deliberately non-canonical frozen bytes: valid JSON, same document, but not
  // the canonical serialization. The stored-byte hash and the canonical content
  // hash therefore genuinely differ, so any conflation becomes observable.
  const fixture = await createMixedFixture({ prettyResultBytes: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = fixture.datasetById(IDS.result);
  const byteHash = sha256Bytes(result.bytes);
  const canonicalHash = hashJson(result.document);
  assert.notEqual(
    byteHash,
    canonicalHash,
    "fixture must produce different byte and canonical hashes",
  );
  assert.equal(result.sha256, byteHash);
  assert.equal(result.canonicalContentHash, canonicalHash);

  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "domains");
  const [operation] = prepared.preparation.operations;
  assert.equal(operation.contentSha256, byteHash);
  assert.equal(operation.contentHashDomain, "result-process-content.v1");
  assert.equal(operation.candidateCanonicalContentHash, canonicalHash);
  assert.notEqual(
    operation.contentSha256,
    operation.candidateCanonicalContentHash,
  );

  // --- standalone Result execution: the event byte field is a byte hash ---
  const execution = await executeResultProcessPublication({
    preparationDir: prepared.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "domains-execution"),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
  const resultEvents = await readEventDirectory(
    path.join(execution.path, "events"),
  );
  const completed = resultEvents.at(-1).event;
  assert.equal(completed.contentSha256, byteHash);
  assert.notEqual(completed.contentSha256, canonicalHash);
  assert.equal("canonicalContentHash" in completed, false);

  // --- mixed execution: the shared canonical field is a canonical hash ---
  const mixedRun = await prepareApprovedRun(fixture);
  const mixedPrepared = await prepareResult(fixture, mixedRun, "domains-mixed");
  const mixed = await executePublication({
    approvalDir: mixedRun.approval.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "domains-mixed-execution"),
    resultPreparationDir: mixedPrepared.path,
    env: ENV,
    fetchImpl: mixedRun.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
  const mixedEvents = await readEventDirectory(path.join(mixed.path, "events"));
  const resultEvent = mixedEvents
    .map(({ event }) => event)
    .find(
      (event) =>
        event.key === `process:${IDS.result}@${VERSION}` &&
        event.outcome === "published",
    );
  assert.ok(resultEvent, "expected a published Result Process event");
  // The canonical field really is the canonical content identity, not the
  // stored-byte hash.
  assert.equal(resultEvent.canonicalContentHash, canonicalHash);
  assert.notEqual(
    resultEvent.canonicalContentHash,
    byteHash,
    "the byte hash must never be reported as a canonical content hash",
  );

  // Ties back to the reviewed source: the stored bytes really do carry the byte
  // hash, and their canonical serialization carries the canonical hash.
  const storedBytes = Buffer.from(operation.contentText, "utf8");
  assert.equal(sha256Bytes(storedBytes), byteHash);
  assert.equal(hashJson(JSON.parse(operation.contentText)), canonicalHash);
  assert.equal(storedBytes.length, operation.contentByteSize);

  // Independent readback keeps both, under their own names.
  const readback = await verifyPublicationReadback({
    executionDir: mixed.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "domains-readback"),
    resultPreparationDir: mixedPrepared.path,
    env: ENV,
    fetchImpl: mixedRun.remote.fetch,
  });
  const [resultRow] = readback.receipt.rows.filter(
    (row) => row.role === "result_process",
  );
  assert.equal(resultRow.observedByteHash, byteHash);
  assert.equal(resultRow.byteHashDomain, "result-process-content.v1");
  assert.equal(resultRow.observedCanonicalContentHash, canonicalHash);
  assert.notEqual(
    resultRow.observedByteHash,
    resultRow.observedCanonicalContentHash,
  );
});

test("The attested Result content hash is derived from frozen Candidate bytes", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "anchor");
  const [operation] = prepared.preparation.operations;
  // Recompute the shared canonical identity from the frozen canonical dataset
  // file, independently of the catalog's own claim about it.
  const dataset = fixture.datasetById(IDS.result);
  const bytes = await readFile(path.join(fixture.canonicalDir, dataset.path));
  assert.equal(
    hashJson(JSON.parse(bytes.toString("utf8"))),
    dataset.canonicalContentHash,
  );
  assert.equal(
    operation.candidateCanonicalContentHash,
    dataset.canonicalContentHash,
  );
  assert.equal(
    operation.expectedCanonicalContentHash,
    dataset.canonicalContentHash,
  );
  // The attestation and the write request carry the same identity, so the
  // manager asserted exactly the content that was frozen.
  const attestationRow = run.approval.approval.managerAttestation.rows[0];
  assert.equal(
    attestationRow.canonicalContentHash,
    dataset.canonicalContentHash,
  );
  // The attested identity is the canonical content hash; the write request uses
  // the distinct stored-byte domain. They are deliberately not the same value.
  assert.notEqual(attestationRow.canonicalContentHash, operation.contentSha256);
});

test("Every emitted Result Process artifact validates against its published contract", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);

  assertMatchesSchema(
    run.inspection.executablePlan,
    "publication-executable-plan.v2.schema.json",
    "Publication Executable Plan v2",
  );
  assertMatchesSchema(
    run.inspection.snapshot,
    "publication-target-snapshot.v2.schema.json",
    "Publication Target Snapshot v2",
  );
  assertMatchesSchema(
    run.approval.approval,
    "publication-approval.v2.schema.json",
    "Publication Approval v2",
  );

  const prepared = await prepareResult(fixture, run, "contracts");
  assertMatchesSchema(
    prepared.preparation,
    "result-process-preparation.v2.schema.json",
    "Result Process Preparation v2",
  );

  const execution = await executeResultProcessPublication({
    preparationDir: prepared.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "contracts-execution"),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
  assertMatchesSchema(
    execution.receipt,
    "result-process-execution-receipt.v1.schema.json",
    "Result Process Execution Receipt",
  );
  const intent = JSON.parse(
    await readFile(
      path.join(execution.path, "result-process-execution-intent.json"),
      "utf8",
    ),
  );
  assertMatchesSchema(
    intent,
    "result-process-execution-intent.v1.schema.json",
    "Result Process Execution Intent",
  );
  for (const { event } of await readEventDirectory(
    path.join(execution.path, "events"),
  ))
    assertMatchesSchema(
      event,
      "result-process-execution-event.v1.schema.json",
      `Result Process Execution Event ${event.sequence}`,
    );

  const readback = await verifyResultProcessReadback({
    executionDir: execution.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "contracts-readback"),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:04:00.000Z"),
  });
  assertMatchesSchema(
    readback.receipt,
    "result-process-readback-receipt.v1.schema.json",
    "Result Process Readback Receipt",
  );
});

test("The shared ajv validator rejects drift instead of rubber-stamping", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "validator");
  const name = "result-process-preparation.v2.schema.json";
  assert.deepEqual(validateArtifact(name, prepared.preparation), []);
  const drifted = structuredClone(prepared.preparation);
  drifted.operations[0].targetStateCode = 100;
  assert.equal(
    validateArtifact(name, drifted).some((error) =>
      error.instancePath.endsWith("targetStateCode"),
    ),
    true,
  );
  assert.equal(
    validateArtifact(name, { ...prepared.preparation, extra: 1 }).some(
      (error) => error.params?.additionalProperty === "extra",
    ),
    true,
  );
});

test("Mixed-state artifacts validate against their v2 contracts", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const prepared = await prepareResult(fixture, run, "mixed-contracts");
  const execution = await executePublication({
    approvalDir: run.approval.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "mixed-contracts-execution"),
    resultPreparationDir: prepared.path,
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
  assertMatchesSchema(
    execution.receipt,
    "publication-execution-receipt.v2.schema.json",
    "Publication Execution Receipt v2",
  );
  const intent = JSON.parse(
    await readFile(
      path.join(execution.path, "publication-execution-intent.json"),
      "utf8",
    ),
  );
  assertMatchesSchema(
    intent,
    "publication-execution-intent.v2.schema.json",
    "Publication Execution Intent v2",
  );
  for (const { event } of await readEventDirectory(
    path.join(execution.path, "events"),
  ))
    assertMatchesSchema(
      event,
      "publication-execution-event.v2.schema.json",
      `Publication Execution Event ${event.sequence}`,
    );
  const readback = await verifyPublicationReadback({
    executionDir: execution.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, "mixed-contracts-readback"),
    resultPreparationDir: prepared.path,
    env: ENV,
    fetchImpl: run.remote.fetch,
  });
  assertMatchesSchema(
    readback.receipt,
    "publication-readback-receipt.v2.schema.json",
    "Publication Readback Receipt v2",
  );
});

test("Result Process contracts are strict Draft 2020-12 schemas closed at every level", async () => {
  const files = [
    "publication-executable-plan.v2.schema.json",
    "publication-target-snapshot.v2.schema.json",
    "publication-approval.v2.schema.json",
    "publication-execution-intent.v2.schema.json",
    "publication-execution-event.v2.schema.json",
    "publication-execution-receipt.v2.schema.json",
    "publication-readback-receipt.v2.schema.json",
    "result-process-preparation.v2.schema.json",
    "result-process-execution-intent.v1.schema.json",
    "result-process-execution-event.v1.schema.json",
    "result-process-execution-receipt.v1.schema.json",
    "result-process-readback-receipt.v1.schema.json",
  ];
  for (const file of files) {
    const schema = JSON.parse(
      await readFile(new URL(`../contracts/${file}`, import.meta.url), "utf8"),
    );
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
      file,
    );
    assert.equal(schema.additionalProperties, false, file);
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      [...schema.required].sort(),
      file,
    );
    assertClosedObjects(schema, file);
  }
});

test("Result Process CLI exposes prepare, execute and verify with recovery guidance", async (t) => {
  const fixture = await createMixedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await prepareApprovedRun(fixture);
  const server = await run.remote.listen();
  t.after(() => server.close());
  const preparedDir = path.join(fixture.root, "cli-preparation");
  const prepared = await execFileAsync(
    process.execPath,
    [
      CLI,
      "result-process",
      "prepare",
      "--approval-dir",
      run.approval.path,
      "--payload-dir",
      fixture.payloadDir,
      "--out-dir",
      preparedDir,
      "--json",
    ],
    {
      env: {
        ...process.env,
        ...ENV,
        TIANGONG_LCA_API_BASE_URL: server.baseUrl,
      },
    },
  );
  assert.equal(prepared.stderr, "");
  const preparedPayload = JSON.parse(prepared.stdout);
  assert.equal(preparedPayload.outcome, "result_process_write_prepared");
  assert.equal(preparedPayload.targetStateCode, 120);
  assert.equal(
    preparedPayload.completeness,
    "remote_preparation_registered_write_pending",
  );
  assert.match(preparedPayload.preparationHash, /^[0-9a-f]{64}$/u);
  assert.equal(
    preparedPayload.replyTemplate.id,
    "publication-result-process-prepared",
  );
  assert.equal(
    preparedPayload.nextActions[0].kind,
    "publish_prepared_result_process",
  );

  const template = await readFile(
    path.join(
      ROOT,
      "reply-templates",
      "publication-result-process-prepared.md",
    ),
    "utf8",
  );
  assert.match(template, /\{\{preparationClassification\}\}/u);

  const { stdout: help } = await execFileAsync(process.execPath, [
    CLI,
    "--help",
  ]);
  for (const command of [
    "result-process prepare",
    "result-process execute",
    "result-process verify",
  ])
    assert.match(help, new RegExp(command, "u"));
  assert.doesNotMatch(help, /request-transport/u);
});

test("Result Process reply guidance stays distinct from the Portal LCIA semantics", async () => {
  const templates = await readdir(
    new URL("../reply-templates/", import.meta.url),
  );
  for (const file of [
    "publication-result-process-prepared.md",
    "publication-result-process-executed.md",
    "publication-result-process-verified.md",
  ])
    assert.equal(templates.includes(file), true, file);
});

async function runReadbackWithReceiptOverride(fixture, field, bad, label) {
  const run = await prepareApprovedRun(fixture);
  run.remote.setOverride("readbackReceipt", { [field]: bad });
  const prepared = await prepareResult(
    fixture,
    run,
    `scalar-${label}-${field}`,
  );
  await executeResultProcessExecution(
    fixture,
    run,
    prepared,
    `scalar-${label}-${field}`,
  );
  try {
    await verifyResultProcessReadback({
      executionDir: path.join(
        fixture.root,
        `scalar-${label}-${field}-execution`,
      ),
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, `scalar-${label}-${field}-readback`),
      env: ENV,
      fetchImpl: run.remote.fetch,
    });
    return "unexpectedly_verified";
  } catch (error) {
    return error.code;
  }
}

async function executeResultProcessExecution(
  fixture,
  run,
  prepared,
  suffix = "exec",
) {
  return executeResultProcessPublication({
    preparationDir: prepared.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(fixture.root, `${suffix}-execution`),
    env: ENV,
    fetchImpl: run.remote.fetch,
    now: () => new Date("2026-09-15T00:03:00.000Z"),
  });
}

async function assertReadbackFailure(fixture, { name, overrides, expected }) {
  const run = await prepareApprovedRun(fixture);
  run.setOverrides?.();
  for (const [key, value] of Object.entries(overrides))
    run.remote.setOverride(key, value);
  const prepared = await prepareResult(fixture, run, name);
  await executeResultProcessExecution(fixture, run, prepared, name);
  await assert.rejects(
    verifyResultProcessReadback({
      executionDir: path.join(fixture.root, `${name}-execution`),
      payloadDir: fixture.payloadDir,
      outDir: path.join(fixture.root, `${name}-readback`),
      env: ENV,
      fetchImpl: run.remote.fetch,
    }),
    ({ code, details }) => {
      assert.equal(code, "result_process_independent_readback_failed", name);
      assert.equal(details.failures[0].code, expected, name);
      return true;
    },
  );
}

async function readEventDirectory(directory) {
  const files = (await readdir(directory)).sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      event: JSON.parse(await readFile(path.join(directory, file), "utf8")),
    })),
  );
}

function documentIdentity(body) {
  const documents = [
    body?.jsonOrdered,
    body?.parent?.jsonOrdered,
    ...(body?.processMutations ?? []).flatMap((mutation) => [
      mutation?.jsonOrdered,
      mutation?.parent?.jsonOrdered,
    ]),
  ];
  for (const document of documents) {
    const uuid =
      document?.processDataSet?.processInformation?.dataSetInformation?.[
        "common:UUID"
      ];
    if (typeof uuid === "string") return uuid.toLowerCase();
  }
  return null;
}

function observeRpcRequests(fetchImpl, seen) {
  return async (url, options = {}) => {
    if (String(url).includes("/rest/v1/rpc/") && options.body) {
      const body = JSON.parse(options.body);
      seen.push({
        functionName: String(url).split("/").at(-1),
        request: body.p_request,
      });
    }
    return fetchImpl(url, options);
  };
}

/**
 * Rewrite the `p_request` of the manager-only execute command on the way out,
 * so a tampered or drifted write is exercised exactly as the remote would see
 * it. Readback is left untouched: it carries a different, narrower request.
 */
function mutateRpcRequest(fetchImpl, mutate) {
  return async (url, options = {}) => {
    if (
      !String(url).endsWith("/rpc/cmd_result_process_publish_v1") ||
      !options.body
    )
      return fetchImpl(url, options);
    const body = JSON.parse(options.body);
    return fetchImpl(url, {
      ...options,
      body: JSON.stringify({ ...body, p_request: mutate(body.p_request) }),
    });
  };
}

function assertClosedObjects(schema, file, label = "#") {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    for (const [index, item] of schema.entries())
      assertClosedObjects(item, file, `${label}/${index}`);
    return;
  }
  if (schema.type === "object" && label !== "#/$defs/blocker") {
    assert.equal(schema.additionalProperties, false, `${file} ${label}`);
    assert.deepEqual(
      Object.keys(schema.properties ?? {}).sort(),
      [...(schema.required ?? [])].sort(),
      `${file} ${label}`,
    );
  }
  for (const [key, child] of Object.entries(schema))
    if (key === "properties" || key === "$defs" || key === "items")
      assertClosedObjects(child, file, `${label}/${key}`);
}

async function createMixedFixture({ prettyResultBytes = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-result-"));
  const candidateRoot = path.join(root, "candidate");
  const canonicalDir = path.join(candidateRoot, "canonical");
  const planDir = path.join(root, "plan");
  const payloadDir = path.join(root, "payload");
  await mkdir(planDir, { recursive: true });
  const draftPlan = {
    schemaVersion: "tiangong.release.publication-draft-plan.v1",
    status: "prepared_unapproved",
    publicationAuthorized: false,
    target: { id: "tiangong-lca-platform" },
  };
  await writeFile(
    path.join(planDir, "publication-draft-plan.json"),
    canonicalJson(draftPlan),
  );
  const datasets = [
    payloadDataset({
      datasetType: "process",
      table: "processes",
      uuid: IDS.result,
      role: "result_process",
      version: VERSION,
      document: {
        processDataSet: {
          processInformation: {
            dataSetInformation: { "common:UUID": IDS.result },
          },
          administrativeInformation: {
            publicationAndOwnership: { "common:dataSetVersion": VERSION },
          },
        },
      },
      // Pretty-printed bytes are valid JSON and represent the same document, but
      // they are NOT the canonical serialization. The stored-byte hash and the
      // canonical content hash therefore genuinely differ, which is what makes
      // any domain conflation detectable.
      pretty: prettyResultBytes,
    }),
    payloadDataset({
      datasetType: "process",
      table: "processes",
      uuid: IDS.unit,
      role: "unit_process",
      version: VERSION,
      document: { processDataSet: { id: "unit" } },
    }),
    payloadDataset({
      datasetType: "flow",
      table: "flows",
      uuid: IDS.flow,
      role: "support",
      version: VERSION,
      document: { flowDataSet: { id: "flow" } },
    }),
    payloadDataset({
      datasetType: "lifecyclemodel",
      table: "lifecyclemodels",
      uuid: IDS.model,
      role: "lifecycle_model",
      version: VERSION,
      document: { lifeCycleModelDataSet: { id: "model" } },
    }),
  ].sort((left, right) => left.key.localeCompare(right.key));
  for (const dataset of datasets) {
    const file = path.join(payloadDir, dataset.payloadPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, dataset.bytes);
    // The frozen Candidate canonical collection the attested content hash is
    // derived from, kept byte-identical to the payload member.
    const canonical = path.join(canonicalDir, dataset.path);
    await mkdir(path.dirname(canonical), { recursive: true });
    await writeFile(canonical, dataset.bytes);
  }
  const entries = datasets.map(
    ({ document: _document, bytes: _bytes, ...entry }) => entry,
  );
  const manifest = {
    schemaVersion: "tiangong.release.publication-payload-manifest.v1",
    candidate: {
      releaseCandidateSha256: "a".repeat(64),
      packageSetHash: "b".repeat(64),
    },
    publicationDraftPlanSha256: hashJson(draftPlan),
    scopeResolutionSha256: "c".repeat(64),
    datasetCount: entries.length,
    datasetSetHash: hashJson(
      entries.map(({ key, sha256, canonicalContentHash }) => ({
        key,
        sha256,
        canonicalContentHash,
      })),
    ),
    datasets: entries,
  };
  await writeFile(
    path.join(payloadDir, "publication-payload-manifest.json"),
    canonicalJson(manifest),
  );
  let counter = 0;
  return {
    root,
    candidateRoot,
    canonicalDir,
    planDir,
    payloadDir,
    datasets,
    datasetById: (uuid) => datasets.find((dataset) => dataset.uuid === uuid),
    // Exact frozen bytes of the Result dataset. The dataset list is sorted by
    // key, so it must be looked up by identity rather than by position.
    resultContentText: () =>
      datasets
        .find((dataset) => dataset.uuid === IDS.result)
        .bytes.toString("utf8"),
    suffix: () => String((counter += 1)),
  };
}

/**
 * A pre-#74 approval directory: one global published state 100, a v1 executable
 * plan whose operations carry no per-role target, and a result_process write
 * inside it. It must fail closed while remaining readable as history.
 */
async function writeLegacyAllHundredApproval(fixture) {
  const approvalDir = path.join(fixture.root, "legacy-approval");
  await mkdir(approvalDir, { recursive: true });
  const draftPlan = JSON.parse(
    await readFile(
      path.join(fixture.planDir, "publication-draft-plan.json"),
      "utf8",
    ),
  );
  const payloadManifest = JSON.parse(
    await readFile(
      path.join(fixture.payloadDir, "publication-payload-manifest.json"),
      "utf8",
    ),
  );
  const rows = fixture.datasets.map((dataset) => ({
    key: dataset.key,
    table: dataset.table,
    uuid: dataset.uuid,
    version: dataset.version,
    expectedCanonicalContentHash: dataset.canonicalContentHash,
    classification: "absent",
    stateCode: null,
    ownerUserId: null,
    observedContentHash: null,
    blocker: null,
  }));
  const snapshot = {
    schemaVersion: "tiangong.release.publication-target-snapshot.v1",
    targetId: draftPlan.target.id,
    targetEndpointFingerprint: "e".repeat(64),
    actorUserId: MANAGER,
    observedAt: "2026-09-15T00:00:00.000Z",
    publishedState: { semantic: "published", code: 100 },
    datasetCount: rows.length,
    rows,
    fingerprint: hashJson(
      rows.map(({ key, table, uuid, version, classification, stateCode }) => ({
        key,
        table,
        uuid,
        version,
        classification,
        stateCode,
      })),
    ),
  };
  const executablePlan = {
    schemaVersion: "tiangong.release.publication-executable-plan.v1",
    status: "ready_for_approval",
    publicationAuthorized: false,
    targetId: draftPlan.target.id,
    publicationDraftPlanSha256: hashJson(draftPlan),
    payloadManifestSha256: hashJson(payloadManifest),
    targetSnapshotSha256: hashJson(snapshot),
    targetFingerprint: snapshot.fingerprint,
    publishedState: { semantic: "published", code: 100 },
    operationCount: rows.length,
    operations: rows.map((row) => ({
      key: row.key,
      table: row.table,
      uuid: row.uuid,
      version: row.version,
      expectedCanonicalContentHash: row.expectedCanonicalContentHash,
      action: "create_then_publish",
    })),
  };
  const approval = {
    schemaVersion: "tiangong.release.publication-approval.v1",
    status: "approved",
    publicationAuthorized: true,
    targetId: executablePlan.targetId,
    executablePlanSha256: hashJson(executablePlan),
    publicationDraftPlanSha256: executablePlan.publicationDraftPlanSha256,
    payloadManifestSha256: executablePlan.payloadManifestSha256,
    targetSnapshotSha256: executablePlan.targetSnapshotSha256,
    targetFingerprint: executablePlan.targetFingerprint,
    publishedState: { semantic: "published", code: 100 },
    approvedBy: "manager",
    approvedAt: "2026-09-15T00:00:00.000Z",
    expiresAt: "2026-09-16T00:00:00.000Z",
    reason: null,
  };
  await writeFile(
    path.join(approvalDir, "publication-draft-plan.json"),
    canonicalJson(draftPlan),
  );
  await writeFile(
    path.join(approvalDir, "publication-payload-manifest.json"),
    canonicalJson(payloadManifest),
  );
  await writeFile(
    path.join(approvalDir, "publication-target-snapshot.json"),
    canonicalJson(snapshot),
  );
  await writeFile(
    path.join(approvalDir, "publication-executable-plan.json"),
    canonicalJson(executablePlan),
  );
  await writeFile(
    path.join(approvalDir, "publication-approval.json"),
    canonicalJson(approval),
  );
  return { approvalDir, executablePlan, approval };
}
