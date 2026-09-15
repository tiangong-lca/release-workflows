import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fail, hashJson } from "./common.mjs";
import { loadApprovalArtifacts } from "./approval.mjs";
import { classifyRow } from "./inspection.mjs";
import { assertExactObject, readJson, writeCanonical } from "./io.mjs";
import { loadVerifiedPayload } from "./payload.mjs";
import {
  inspectDataset,
  invokeDatasetCreate,
  invokeDatasetPublish,
  invokeLifecycleModelBundleCreate,
  resolvePublicationRuntime,
} from "./remote.mjs";
import {
  executePreparedResultOperation,
  loadResultProcessExecution,
} from "./result-process.mjs";
import {
  assertNotPlatformRoute,
  isResultProcessRole,
  targetStateCodeForRole,
} from "./publication-state.mjs";

const EXECUTION_RECEIPT_SCHEMA =
  "tiangong.release.publication-execution-receipt.v2";

export async function executePublication({
  approvalDir,
  payloadDir,
  outDir,
  resultPreparationDir = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const evidence = await loadApprovalArtifacts(approvalDir);
  const payload = await loadVerifiedPayload(
    payloadDir,
    evidence.approval.payloadManifestSha256,
  );
  // `loadApprovalArtifacts` has already rejected malformed timestamps, so this
  // comparison cannot be defeated by a NaN.
  if (Date.parse(evidence.approval.expiresAt) <= now().getTime())
    fail("publication_approval_expired", "Publication Approval has expired", {
      expiresAt: evidence.approval.expiresAt,
    });
  const executableOperations = evidence.executablePlan.operations;
  for (const operation of executableOperations)
    if (operation.targetStateCode !== targetStateCodeForRole(operation.role))
      fail(
        "publication_operation_target_state_mismatch",
        `Approved operation target state does not follow its dataset role: ${operation.key}`,
        {
          role: operation.role,
          expected: targetStateCodeForRole(operation.role),
          targetStateCode: operation.targetStateCode,
        },
      );
  const runtime = await resolvePublicationRuntime({ env, fetchImpl });
  if (
    runtime.actorUserId !== evidence.snapshot.actorUserId ||
    runtime.targetEndpointFingerprint !==
      evidence.snapshot.targetEndpointFingerprint
  )
    fail(
      "publication_execution_actor_or_target_mismatch",
      "Execution actor and target must match the approved target snapshot",
    );
  // The attesting manager must be the executing actor. This is checked before the
  // Result preparation is required: an actor mismatch is a complete local decision.
  const attestationActor =
    evidence.approval.managerAttestation?.attestedByUserId;
  if (attestationActor && attestationActor !== runtime.actorUserId)
    fail(
      "publication_execution_attestation_actor_mismatch",
      "Executing actor must be the Data Product Manager recorded in the manager attestation",
      { attestedByUserId: attestationActor },
    );
  // Any Result Process write needs its remote-prepared request before the first
  // mutation. The Result route never creates a 0 or 100 row, so a missing
  // preparation fails closed here rather than falling back to the platform
  // dataset commands.
  const resultOperations = executableOperations.filter(
    (operation) =>
      isResultProcessRole(operation.role) && operation.remoteWrites,
  );
  const resultPreparation = resultOperations.length
    ? await loadResultProcessExecution({
        preparationDir:
          resultPreparationDir ??
          fail(
            "result_process_preparation_required",
            "Publishing a Result Process write requires the remote-prepared Result Process request",
            {
              requiredOption: "--result-preparation-dir",
              resultProcessKeys: resultOperations.map(({ key }) => key),
            },
          ),
        payloadDir,
        now,
        // Freshness is checked here, before any remote call. The preparation is
        // deliberately NOT phase-gated, so a failed or historical preparation
        // still produces a truthful diagnostic instead of hiding behind the
        // approval binding.
        phase: "execute",
        expectedEvidence: {
          approvalSha256: evidence.approvalSha256,
          executablePlanSha256: evidence.approval.executablePlanSha256,
          payloadManifestSha256: payload.manifestSha256,
        },
      })
    : null;
  if (
    resultPreparation &&
    (resultPreparation.preparation.actorUserId !== runtime.actorUserId ||
      resultPreparation.preparation.targetEndpointFingerprint !==
        runtime.targetEndpointFingerprint)
  )
    fail(
      "publication_execution_actor_or_target_mismatch",
      "Result Process preparation actor and target must match this execution",
    );

  const target = path.resolve(outDir);
  await ensureExecutionDirectory({ target, evidence });
  const existingReceiptPath = path.join(
    target,
    "publication-execution-receipt.json",
  );
  try {
    await access(existingReceiptPath);
    const { value: existingReceipt } = await readJson(existingReceiptPath);
    assertExactObject(
      existingReceipt,
      [
        "schemaVersion",
        "status",
        "approvalSha256",
        "executablePlanSha256",
        "payloadManifestSha256",
        "targetId",
        "stateMapping",
        "completedAt",
        "datasetCount",
        "resultProcessDatasetCount",
        "completedKeys",
        "eventCount",
        "eventLogHash",
        "independentReadbackVerified",
      ],
      "publication_execution_receipt_invalid",
      "Publication execution receipt",
    );
    if (
      existingReceipt.schemaVersion !==
        "tiangong.release.publication-execution-receipt.v2" ||
      existingReceipt.approvalSha256 !== evidence.approvalSha256 ||
      existingReceipt.payloadManifestSha256 !== payload.manifestSha256
    )
      fail(
        "publication_execution_receipt_invalid",
        "Existing Publication execution receipt does not match this approval and payload",
      );
    return {
      path: target,
      receipt: existingReceipt,
      receiptSha256: hashJson(existingReceipt),
      reused: true,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const history = await loadEventHistory(target);
  const completedKeys = new Set(
    history.events
      .filter(
        (event) =>
          event.outcome === "published" ||
          event.outcome === "already_published",
      )
      .map((event) => event.key),
  );
  await assertLivePreconditions({
    evidence,
    payload,
    runtime,
    completedKeys,
    allowPartialCreate: history.events.length > 0,
    fetchImpl,
  });

  const datasetByKey = new Map(
    payload.datasets.map((dataset) => [dataset.key, dataset]),
  );
  for (const operation of executableOperations) {
    if (completedKeys.has(operation.key)) continue;
    const dataset = datasetByKey.get(operation.key);
    if (!dataset)
      fail(
        "publication_execution_payload_missing",
        `Approved operation has no verified payload dataset: ${operation.key}`,
      );
    await appendEvent(target, history, {
      schemaVersion: "tiangong.release.publication-execution-event.v2",
      recordedAt: now().toISOString(),
      key: dataset.key,
      role: operation.role,
      targetStateCode: operation.targetStateCode,
      action: operation.action,
      outcome: "started",
      disposition: null,
      remoteReceiptId: null,
      stateCode: null,
      canonicalContentHash: null,
      remoteCommands: [],
      error: null,
    });
    try {
      const outcome = isResultProcessRole(operation.role)
        ? await executePreparedResultOperation({
            runtime,
            operation: resultPreparation.operations.get(operation.key),
            fetchImpl,
          })
        : await executeDataset({
            dataset,
            runtime,
            publishedStateCode: operation.targetStateCode,
            fetchImpl,
          });
      await appendEvent(target, history, {
        schemaVersion: "tiangong.release.publication-execution-event.v2",
        recordedAt: now().toISOString(),
        key: dataset.key,
        role: operation.role,
        targetStateCode: operation.targetStateCode,
        action: operation.action,
        outcome: outcome.outcome,
        disposition: outcome.disposition ?? null,
        remoteReceiptId: outcome.receiptId ?? null,
        stateCode: outcome.stateCode,
        canonicalContentHash: outcome.canonicalContentHash,
        remoteCommands: outcome.remoteCommands,
        error: null,
      });
      completedKeys.add(dataset.key);
    } catch (error) {
      await appendEvent(target, history, {
        schemaVersion: "tiangong.release.publication-execution-event.v2",
        recordedAt: now().toISOString(),
        key: dataset.key,
        role: operation.role,
        targetStateCode: operation.targetStateCode,
        action: operation.action,
        outcome: "failed",
        disposition: null,
        remoteReceiptId: null,
        stateCode: null,
        canonicalContentHash: null,
        remoteCommands: [],
        error: {
          code: error?.code ?? "publication_dataset_execution_failed",
          message: error?.message ?? "Publication dataset execution failed",
          details: error?.details ?? {},
        },
      });
      error.details = {
        ...(error.details ?? {}),
        executionDirectory: target,
        completedKeys: [...completedKeys].sort(),
        failedKey: dataset.key,
        resumeSafe: true,
      };
      throw error;
    }
  }
  const eventHashes = history.events.map((event) => hashJson(event));
  const receipt = {
    schemaVersion: "tiangong.release.publication-execution-receipt.v2",
    status: "published",
    approvalSha256: evidence.approvalSha256,
    executablePlanSha256: evidence.approval.executablePlanSha256,
    payloadManifestSha256: payload.manifestSha256,
    targetId: evidence.approval.targetId,
    stateMapping: evidence.approval.stateMapping,
    completedAt: now().toISOString(),
    datasetCount: evidence.executablePlan.operationCount,
    resultProcessDatasetCount:
      evidence.executablePlan.resultProcessOperationCount,
    completedKeys: [...completedKeys].sort(),
    eventCount: history.events.length,
    eventLogHash: hashJson(eventHashes),
    independentReadbackVerified: false,
  };
  await writeCanonical(existingReceiptPath, receipt);
  return {
    path: target,
    receipt,
    receiptSha256: hashJson(receipt),
    reused: false,
  };
}

async function executeDataset({
  dataset,
  runtime,
  publishedStateCode,
  fetchImpl,
}) {
  // The 120 route is the manager-attested Result Process command only. A Result
  // Process dataset must never be created or published through the platform
  // dataset commands, which would leave an intermediate 0 or 100 row.
  assertNotPlatformRoute(dataset.role, dataset.key);
  let row = await inspectDataset({ runtime, dataset, fetchImpl });
  let observed = classifyRow({
    dataset,
    row,
    actorUserId: runtime.actorUserId,
    publishedStateCode,
  });
  if (observed.blocker)
    fail(
      "publication_target_changed",
      `Dataset is no longer safely publishable: ${dataset.key}`,
      { blocker: observed.blocker },
    );
  const remoteCommands = [];
  if (!row) {
    if (dataset.table === "lifecyclemodels") {
      await invokeLifecycleModelBundleCreate({
        runtime,
        model: dataset,
        document: dataset.document,
        fetchImpl,
      });
      remoteCommands.push("save_lifecycle_model_bundle:create");
    } else {
      await invokeDatasetCreate({
        runtime,
        dataset,
        document: dataset.document,
        fetchImpl,
      });
      remoteCommands.push("app_dataset_create");
    }
    row = await inspectDataset({ runtime, dataset, fetchImpl });
    observed = classifyRow({
      dataset,
      row,
      actorUserId: runtime.actorUserId,
      publishedStateCode,
    });
    if (!row || observed.blocker)
      fail(
        "publication_create_readback_failed",
        `Created dataset does not match the approved payload: ${dataset.key}`,
        { blocker: observed.blocker ?? { code: "created_row_not_visible" } },
      );
  }
  if (observed.classification !== "matching_published") {
    await invokeDatasetPublish({ runtime, dataset, fetchImpl });
    remoteCommands.push("app_dataset_publish");
  }
  const finalRow = await inspectDataset({ runtime, dataset, fetchImpl });
  const final = classifyRow({
    dataset,
    row: finalRow,
    actorUserId: runtime.actorUserId,
    publishedStateCode,
  });
  if (final.classification !== "matching_published")
    fail(
      "publication_dataset_readback_failed",
      `Dataset publication did not produce the approved content and state: ${dataset.key}`,
      { classification: final.classification, blocker: final.blocker },
    );
  return {
    outcome: remoteCommands.length ? "published" : "already_published",
    stateCode: final.stateCode,
    canonicalContentHash: final.observedContentHash,
    remoteCommands,
  };
}

async function assertLivePreconditions({
  evidence,
  payload,
  runtime,
  completedKeys,
  allowPartialCreate,
  fetchImpl,
}) {
  const approvedRows = new Map(
    evidence.snapshot.rows.map((row) => [row.key, row]),
  );
  const operationByKey = new Map(
    evidence.executablePlan.operations.map((operation) => [
      operation.key,
      operation,
    ]),
  );
  const blockers = [];
  for (const dataset of payload.datasets) {
    const role = operationByKey.get(dataset.key)?.role;
    // Result Process rows are not readable through the actor-scoped REST
    // surface once they are at 120, so their precondition is enforced by the
    // manager-only RPC path instead of this generic inspection.
    if (isResultProcessRole(role)) continue;
    const row = await inspectDataset({ runtime, dataset, fetchImpl });
    const current = classifyRow({
      dataset,
      row,
      actorUserId: runtime.actorUserId,
      publishedStateCode: targetStateCodeForRole(dataset.role),
    });
    const approved = approvedRows.get(dataset.key);
    if (completedKeys.has(dataset.key)) {
      if (current.classification !== "matching_published")
        blockers.push({ key: dataset.key, code: "completed_dataset_drift" });
      continue;
    }
    if (
      allowPartialCreate &&
      ((approved?.classification === "absent" &&
        current.classification === "matching_unpublished") ||
        current.classification === "matching_published")
    )
      continue;
    if (
      !approved ||
      current.classification !== approved.classification ||
      current.stateCode !== approved.stateCode ||
      current.observedContentHash !== approved.observedContentHash
    )
      blockers.push({
        key: dataset.key,
        role: dataset.role,
        targetStateCode:
          operationByKey.get(dataset.key)?.targetStateCode ?? null,
        code: "target_snapshot_drift",
        approved: approved
          ? {
              classification: approved.classification,
              stateCode: approved.stateCode,
              contentHash: approved.observedContentHash,
            }
          : null,
        current: {
          classification: current.classification,
          stateCode: current.stateCode,
          contentHash: current.observedContentHash,
        },
      });
  }
  if (blockers.length)
    fail(
      "publication_target_snapshot_drift",
      "Target state changed after approval; prepare a new inspection and approval",
      { blockers },
    );
}

async function ensureExecutionDirectory({ target, evidence }) {
  await mkdir(target, { recursive: true });
  await mkdir(path.join(target, "events"), { recursive: true });
  const intent = {
    schemaVersion: "tiangong.release.publication-execution-intent.v2",
    approvalSha256: evidence.approvalSha256,
    executablePlanSha256: evidence.approval.executablePlanSha256,
    payloadManifestSha256: evidence.approval.payloadManifestSha256,
    targetId: evidence.approval.targetId,
    stateMapping: evidence.approval.stateMapping,
    managerAttestationRowsHash:
      evidence.approval.managerAttestation?.rowsHash ?? null,
  };
  const intentPath = path.join(target, "publication-execution-intent.json");
  try {
    await access(intentPath);
    const { value: existing } = await readJson(intentPath);
    if (hashJson(existing) !== hashJson(intent))
      fail(
        "publication_execution_resume_mismatch",
        "Existing execution directory belongs to a different approval or payload",
      );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeCanonical(intentPath, intent);
    await writeCanonical(
      path.join(target, "publication-approval.json"),
      evidence.approval,
    );
    await writeCanonical(
      path.join(target, "publication-executable-plan.json"),
      evidence.executablePlan,
    );
    await writeCanonical(
      path.join(target, "publication-target-snapshot.json"),
      evidence.snapshot,
    );
    await writeCanonical(
      path.join(target, "publication-payload-manifest.json"),
      evidence.payloadManifest,
    );
  }
}

async function loadEventHistory(target) {
  const eventsDir = path.join(target, "events");
  const files = (await readdir(eventsDir))
    .filter((file) => /^\d{6}\.json$/u.test(file))
    .sort();
  const events = [];
  let previous = null;
  for (const [index, file] of files.entries()) {
    const { value: event } = await readJson(path.join(eventsDir, file));
    assertExactObject(
      event,
      [
        "schemaVersion",
        "recordedAt",
        "key",
        "role",
        "targetStateCode",
        "action",
        "outcome",
        "disposition",
        "remoteReceiptId",
        "stateCode",
        "canonicalContentHash",
        "remoteCommands",
        "error",
        "sequence",
        "previousEventSha256",
      ],
      "publication_execution_event_invalid",
      "Publication execution event",
    );
    if (
      event.schemaVersion !==
        "tiangong.release.publication-execution-event.v2" ||
      event.sequence !== index + 1 ||
      event.previousEventSha256 !== previous ||
      file !== `${String(index + 1).padStart(6, "0")}.json`
    )
      fail(
        "publication_execution_event_chain_invalid",
        "Publication execution event chain is incomplete or has drifted",
      );
    events.push(event);
    previous = hashJson(event);
  }
  return { events, previous };
}

async function appendEvent(target, history, body) {
  const event = {
    ...body,
    sequence: history.events.length + 1,
    previousEventSha256: history.previous,
  };
  await writeCanonical(
    path.join(
      target,
      "events",
      `${String(event.sequence).padStart(6, "0")}.json`,
    ),
    event,
  );
  history.events.push(event);
  history.previous = hashJson(event);
}
