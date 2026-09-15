import path from "node:path";
import { fail, hashJson } from "./common.mjs";
import { classifyRow } from "./inspection.mjs";
import {
  assertExactObject,
  readJson,
  verifyJsonHash,
  writeCanonical,
  writeImmutableDirectory,
} from "./io.mjs";
import { loadVerifiedPayload } from "./payload.mjs";
import { inspectDataset, resolvePublicationRuntime } from "./remote.mjs";
import {
  isResultProcessRole,
  targetStateCodeForRole,
} from "./publication-state.mjs";
import {
  isAuthorizationError,
  loadResultProcessExecution,
  verifyPreparedResultOperation,
} from "./result-process.mjs";

export async function verifyPublicationReadback({
  executionDir,
  payloadDir,
  outDir,
  resultPreparationDir = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const executionRoot = path.resolve(executionDir);
  const { value: executionReceipt } = await readJson(
    path.join(executionRoot, "publication-execution-receipt.json"),
    "publication_execution_receipt_missing",
  );
  const { value: executablePlan } = await readJson(
    path.join(executionRoot, "publication-executable-plan.json"),
    "publication_executable_plan_missing",
  );
  const { value: approval } = await readJson(
    path.join(executionRoot, "publication-approval.json"),
    "publication_approval_missing",
  );
  if (
    executionReceipt.schemaVersion !==
      "tiangong.release.publication-execution-receipt.v2" ||
    executionReceipt.status !== "published"
  )
    fail(
      "publication_execution_receipt_unsupported",
      "Independent readback requires a completed Publication Execution Receipt v2",
      {
        observedSchemaVersion: executionReceipt.schemaVersion ?? null,
        historicalEvidenceReadable: true,
      },
    );
  assertExactObject(
    executionReceipt,
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
  verifyJsonHash(
    executablePlan,
    executionReceipt.executablePlanSha256,
    "publication_readback_plan_hash_mismatch",
    "Publication executable plan",
  );
  verifyJsonHash(
    approval,
    executionReceipt.approvalSha256,
    "publication_readback_approval_hash_mismatch",
    "Publication approval",
  );
  const payload = await loadVerifiedPayload(
    payloadDir,
    executionReceipt.payloadManifestSha256,
  );
  const operationByKey = new Map(
    executablePlan.operations.map((operation) => [operation.key, operation]),
  );
  for (const dataset of payload.datasets) {
    const operation = operationByKey.get(dataset.key);
    if (!operation)
      fail(
        "publication_readback_operation_missing",
        `Executed dataset has no approved operation: ${dataset.key}`,
      );
    if (operation.targetStateCode !== targetStateCodeForRole(dataset.role))
      fail(
        "publication_operation_target_state_mismatch",
        `Approved operation target state does not follow its dataset role: ${dataset.key}`,
        {
          role: dataset.role,
          expected: targetStateCodeForRole(dataset.role),
          targetStateCode: operation.targetStateCode,
        },
      );
  }
  const resultOperations = executablePlan.operations.filter(
    (operation) =>
      isResultProcessRole(operation.role) && operation.remoteWrites,
  );
  const resultPreparation = resultOperations.length
    ? await loadResultProcessExecution({
        preparationDir:
          resultPreparationDir ??
          fail(
            "result_process_preparation_required",
            "Independent readback of a Result Process write requires the remote-prepared Result Process request",
            {
              requiredOption: "--result-preparation-dir",
              resultProcessKeys: resultOperations.map(({ key }) => key),
            },
          ),
        payloadDir,
        now,
        // Readback re-verifies an already completed publication, whose
        // authorization was valid when it ran. An expired approval must not
        // invalidate that evidence; every RPC on this path re-checks the live
        // manager role instead. The binding to the selected evidence still holds.
        phase: "readback",
        expectedEvidence: {
          approvalSha256: hashJson(approval),
          executablePlanSha256: hashJson(executablePlan),
          payloadManifestSha256: payload.manifestSha256,
        },
      })
    : null;
  const runtime = await resolvePublicationRuntime({ env, fetchImpl });
  const rows = [];
  const failures = [];
  for (const dataset of payload.datasets) {
    const role = operationByKey.get(dataset.key).role;
    if (isResultProcessRole(role)) {
      // Result Process content is only readable through the manager-only exact
      // receipt binding; a generic actor-scoped REST read is blocked at 120 and
      // must never be substituted here.
      try {
        const row = await verifyPreparedResultOperation({
          runtime,
          operation: resultPreparation.operations.get(dataset.key),
          fetchImpl,
        });
        rows.push(row);
      } catch (error) {
        // A revoked role is a property of the call, not of this identity: it must
        // not be reported as a content/state mismatch.
        if (isAuthorizationError(error)) throw error;
        failures.push({
          key: dataset.key,
          role,
          code: error?.code ?? "result_process_readback_failed",
          details: error?.details ?? {},
        });
      }
      continue;
    }
    const targetStateCode = targetStateCodeForRole(dataset.role);
    const remoteRow = await inspectDataset({ runtime, dataset, fetchImpl });
    const observed = classifyRow({
      dataset,
      row: remoteRow,
      actorUserId: runtime.actorUserId,
      publishedStateCode: targetStateCode,
    });
    const verified = observed.classification === "matching_published";
    rows.push({
      key: dataset.key,
      role: dataset.role,
      table: dataset.table,
      uuid: dataset.uuid,
      version: dataset.version,
      expectedCanonicalContentHash: dataset.canonicalContentHash,
      observedCanonicalContentHash: observed.observedContentHash,
      // Ordinary datasets are read through the actor-scoped REST surface, so
      // there is no receipt-bound stored-byte domain or remote receipt here.
      expectedByteHash: null,
      observedByteHash: null,
      byteHashDomain: null,
      expectedStateCode: targetStateCode,
      observedStateCode: observed.stateCode,
      receiptId: null,
      publishedAt: null,
      serverVerified: null,
      verified,
    });
    if (!verified)
      failures.push({
        key: dataset.key,
        role: dataset.role,
        classification: observed.classification,
        blocker: observed.blocker,
      });
  }
  if (failures.length)
    fail(
      "publication_independent_readback_failed",
      "Independent Publication readback found content or state mismatches",
      { failures },
    );
  const receipt = {
    schemaVersion: "tiangong.release.publication-readback-receipt.v2",
    status: "verified",
    independentlyQueried: true,
    executionReceiptSha256: hashJson(executionReceipt),
    executablePlanSha256: hashJson(executablePlan),
    approvalSha256: hashJson(approval),
    payloadManifestSha256: payload.manifestSha256,
    targetId: executionReceipt.targetId,
    stateMapping: executionReceipt.stateMapping,
    verifiedAt: now().toISOString(),
    datasetCount: rows.length,
    resultProcessDatasetCount: rows.filter(
      (row) => row.role === "result_process",
    ).length,
    verifiedSetHash: hashJson(
      rows.map(
        ({
          key,
          role,
          observedCanonicalContentHash,
          observedByteHash,
          observedStateCode,
        }) => ({
          key,
          role,
          observedCanonicalContentHash,
          observedByteHash,
          observedStateCode,
        }),
      ),
    ),
    rows,
  };
  const target = path.resolve(outDir);
  await writeImmutableDirectory(target, async (staging) => {
    await writeCanonical(
      path.join(staging, "publication-execution-receipt.json"),
      executionReceipt,
    );
    await writeCanonical(
      path.join(staging, "publication-readback-receipt.json"),
      receipt,
    );
  });
  return { path: target, receipt, receiptSha256: hashJson(receipt) };
}
