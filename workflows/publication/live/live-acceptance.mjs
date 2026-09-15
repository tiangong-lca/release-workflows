/**
 * The live Result-only acceptance chain.
 *
 * Every step calls the real Publication implementation against the operator's
 * endpoint. The entrypoint (`result-only-acceptance.mjs`) passes no `fetchImpl`,
 * so the production `globalThis.fetch` default is what actually runs; the
 * parameter exists only so guard tests can exercise this module offline without
 * any network. A run is only live evidence when it was produced by the CLI
 * entrypoint against a real endpoint.
 */
import path from "node:path";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createPublicationApproval } from "../lib/approval.mjs";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { inspectPublicationTarget } from "../lib/inspection.mjs";
import {
  executeResultProcessPublication,
  prepareResultProcessPublication,
  verifyResultProcessReadback,
} from "../lib/result-process.mjs";
import {
  nonCanonicalResultContent,
  writeResultOnlyFixture,
} from "../test-support/publication-fixture.mjs";

const PREPARE_FUNCTION = "qry_result_process_publish_prepare_v1";
const EXECUTE_FUNCTION = "cmd_result_process_publish_v1";

/**
 * The only server error codes this runner will report.
 *
 * Anything else is collapsed to `unexpected_remote_code`: a response body must
 * never be able to inject arbitrary text into the manifest or the console.
 */
const ALLOWED_REMOTE_CODES = new Set([
  "auth_required",
  "not_data_product_manager",
  "result_publish_request_invalid",
  "result_publish_content_invalid",
  "result_content_hash_mismatch",
  "result_preparation_stale",
  "result_publication_conflict",
  "result_publication_replay_mismatch",
  "result_publication_busy",
  "result_publication_not_found",
]);
const ALLOWED_CLASSIFICATIONS = new Set([
  "absent",
  "candidate_content_matches_existing",
  "conflict",
]);

export async function runLiveAcceptance({
  config,
  outDir,
  manifestPath,
  fetchImpl = globalThis.fetch,
}) {
  const manifest = {
    schemaVersion: "tiangong.release.result-process-live-acceptance.v1",
    outcome: "in_progress",
    startedAt: new Date().toISOString(),
    endedAt: null,
    instance: {
      label: config.instanceLabel,
      declaredEndpoint: config.expectedEndpoint,
      requestedEndpoint: config.baseUrl,
      host: config.host,
      port: config.port,
    },
    fixture: {
      uuid: config.fixtureUuid,
      version: config.version,
      datasetKey: null,
      storedByteHash: null,
      canonicalContentHash: null,
    },
    // Every artifact directory this run created or will create, so an operator can
    // re-run verification later without guessing paths.
    artifacts: { outDir: path.resolve(outDir) },
    steps: [],
    retainedRows: [],
    error: null,
  };
  const persist = async () => {
    const temporary = `${manifestPath}.tmp`;
    await writeFile(temporary, canonicalJson(manifest));
    await rename(temporary, manifestPath);
  };
  const record = async (name, details, at = new Date()) => {
    manifest.steps.push({ name, recordedAt: at.toISOString(), ...details });
    await persist();
  };

  try {
    return await runChain({
      config,
      outDir,
      fetchImpl,
      manifest,
      record,
      persist,
    });
  } catch (error) {
    // A failure after the insert must still leave a truthful manifest beside the
    // immutable rows. Never a silent exit.
    manifest.outcome = "failed";
    manifest.endedAt = new Date().toISOString();
    manifest.error = {
      code:
        typeof error?.code === "string" ? error.code : "live_acceptance_failed",
      message: String(error?.message ?? "live acceptance failed"),
      details: sanitizeDetails(error?.details),
    };
    await persist();
    throw error;
  }
}

async function runChain({
  config,
  outDir,
  fetchImpl,
  manifest,
  record,
  persist,
}) {
  const env = {
    TIANGONG_LCA_API_BASE_URL: config.baseUrl,
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    TIANGONG_LCA_ACCESS_TOKEN: config.accessToken,
  };
  const approverUserId = jwtSubject(config.accessToken);

  // ---- fixture -----------------------------------------------------------
  const { document, contentText } = nonCanonicalResultContent({
    uuid: config.fixtureUuid,
    version: config.version,
  });
  const fixture = await writeResultOnlyFixture({
    uuid: config.fixtureUuid,
    version: config.version,
    contentText,
  });
  const byteHash = sha256Bytes(Buffer.from(contentText, "utf8"));
  const canonicalHash = hashJson(document);
  if (byteHash === canonicalHash)
    throw failure(
      "live_acceptance_fixture_not_discriminating",
      "Fixture content must not be its own canonical serialization",
    );
  manifest.fixture.datasetKey = fixture.dataset.key;
  manifest.fixture.storedByteHash = byteHash;
  manifest.fixture.canonicalContentHash = canonicalHash;
  manifest.artifacts.fixture = {
    root: fixture.root,
    payloadDir: fixture.payloadDir,
    planDir: fixture.planDir,
    // The exact payload member an independent verifier needs.
    payloadMember: path.join(fixture.payloadDir, fixture.dataset.payloadPath),
    payloadManifest: path.join(
      fixture.payloadDir,
      "publication-payload-manifest.json",
    ),
  };
  manifest.artifacts.inspection = path.join(outDir, "inspection");
  manifest.artifacts.approval = path.join(outDir, "approval");
  manifest.artifacts.preparation = path.join(outDir, "result-preparation");
  manifest.artifacts.execution = path.join(outDir, "result-execution");
  manifest.artifacts.executionRetry = path.join(
    outDir,
    "result-execution-retry",
  );
  manifest.artifacts.readback = path.join(outDir, "result-readback");
  manifest.retainedRows = [
    {
      table: "processes",
      id: config.fixtureUuid,
      version: config.version,
      stateCode: null,
      plannedStateCode: 120,
      note: "immutable fixture row; retained for coordinator reset on the dedicated instance",
    },
  ];
  await record("fixture", {
    datasetKey: fixture.dataset.key,
    storedByteHash: byteHash,
    canonicalContentHash: canonicalHash,
    distinctHashDomains: true,
    contentByteSize: Buffer.byteLength(contentText, "utf8"),
    payloadDir: fixture.payloadDir,
  });

  // ---- instance label binding + fresh identity ---------------------------
  // `label` above is operator-declared. This probe is the server-side half of the
  // binding: it proves the endpoint answers with the reviewed envelope and that
  // the fixture identity is untouched there. It cannot prove the label itself.
  const beforePrepare = await invokeRpc({
    config,
    env,
    functionName: PREPARE_FUNCTION,
    body: {
      p_request: {
        table: "processes",
        id: config.fixtureUuid,
        version: config.version,
        contentText,
        contentSha256: byteHash,
        sourceKind: "manager_attestation",
        source: {
          candidateSetHash: fixture.manifest.datasetSetHash,
          sourceManifestHash: fixture.manifest.candidate.packageSetHash,
        },
        audit: { reason: "live acceptance instance sanity probe" },
      },
    },
    fetchImpl,
  });
  if (
    beforePrepare.ok !== true ||
    !ALLOWED_CLASSIFICATIONS.has(beforePrepare.data?.classification)
  )
    throw failure(
      "live_acceptance_fixture_probe_failed",
      "The instance did not answer the reviewed prepare envelope",
      {
        ok: beforePrepare.ok === true,
        code: describeCode(beforePrepare),
        classification: sanitizeClassification(
          beforePrepare.data?.classification,
        ),
      },
    );
  if (beforePrepare.data.classification !== "absent")
    throw failure(
      "live_acceptance_fixture_not_fresh",
      "The fixture identity must be absent on this instance before the run",
      { classification: beforePrepare.data.classification },
    );
  await record("instance_sanity", {
    declaredInstanceLabel: config.instanceLabel,
    declaredEndpoint: config.expectedEndpoint,
    requestedEndpoint: config.baseUrl,
    binding: "operator_declared_label_plus_server_verified_envelope",
    classification: "absent",
  });

  // ---- target inspection -------------------------------------------------
  const inspection = await inspectPublicationTarget({
    planDir: fixture.planDir,
    payloadDir: fixture.payloadDir,
    outDir: manifest.artifacts.inspection,
    env,
    fetchImpl,
  });
  const operation = inspection.executablePlan.operations.find(
    (candidate) => candidate.role === "result_process",
  );
  if (
    inspection.executablePlan.operationCount !== 1 ||
    !operation ||
    operation.action !== "reconcile_via_manager_command" ||
    operation.remoteWrites !== true ||
    operation.classification !== "absent"
  )
    throw failure(
      "live_acceptance_inspection_unexpected",
      "Result-only inspection did not produce one absent, write-required Result operation",
      {
        operationCount: inspection.executablePlan.operationCount,
        action: operation?.action ?? null,
        classification: operation?.classification ?? null,
      },
    );
  await record("inspection", {
    executablePlanSha256: inspection.executablePlanSha256,
    snapshotFingerprint: inspection.snapshot.fingerprint,
    action: operation.action,
    classification: operation.classification,
  });

  // ---- manager approval --------------------------------------------------
  const approval = await createPublicationApproval({
    inspectionDir: inspection.path,
    outDir: manifest.artifacts.approval,
    confirmPlanSha256: inspection.executablePlanSha256,
    approvedBy: "live-acceptance-operator",
    attestedByUserId: approverUserId,
    reason: "live acceptance result-only publication",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  const [attestationRow] = approval.approval.managerAttestation.rows;
  await record("approval", {
    approvalSha256: approval.approvalSha256,
    attestedByUserId: approval.approval.managerAttestation.attestedByUserId,
    attestationRowsHash: approval.approval.managerAttestation.rowsHash,
    attestedCanonicalContentHash: attestationRow.canonicalContentHash,
    attestedCandidateSetHash: attestationRow.candidateSetHash,
    attestedSourceManifestHash: attestationRow.sourceManifestHash,
    expiresAt: approval.approval.expiresAt,
  });

  // ---- RPC prepare (read-only) -------------------------------------------
  const preparation = await prepareResultProcessPublication({
    approvalDir: approval.path,
    payloadDir: fixture.payloadDir,
    outDir: manifest.artifacts.preparation,
    env,
    fetchImpl,
  });
  const [preparedOperation] = preparation.preparation.operations;
  if (
    preparedOperation.preparationClassification !== "absent" ||
    preparedOperation.contentSha256 !== byteHash ||
    preparedOperation.candidateCanonicalContentHash !== canonicalHash
  )
    throw failure(
      "live_acceptance_prepare_unexpected",
      "Prepare did not report the expected classification and content binding",
      {
        classification: preparedOperation.preparationClassification,
        contentSha256: preparedOperation.contentSha256,
      },
    );
  await record("prepare", {
    preparationHash: preparedOperation.preparationHash,
    preparationSha256: preparation.preparationSha256,
    idempotencyKey: preparedOperation.idempotencyKey,
    contentHashDomain: preparedOperation.contentHashDomain,
    classification: preparedOperation.preparationClassification,
  });

  // ---- RPC execute (direct 120) ------------------------------------------
  const execution = await executeResultProcessPublication({
    preparationDir: preparation.path,
    payloadDir: fixture.payloadDir,
    outDir: manifest.artifacts.execution,
    env,
    fetchImpl,
  });
  if (execution.receipt.status !== "published")
    throw failure(
      "live_acceptance_execute_unexpected",
      "Execute did not report a published receipt",
    );
  const firstEvents = await readEventDirectory(
    path.join(manifest.artifacts.execution, "events"),
  );
  const firstPublishedEvent = lastCompletedEvent(firstEvents);
  await record("execute", {
    executionReceiptSha256: execution.receiptSha256,
    completedKeys: execution.receipt.completedKeys,
    preparationSha256: execution.receipt.preparationSha256,
    eventDisposition: firstPublishedEvent?.disposition ?? null,
    eventRemoteReceiptId: firstPublishedEvent?.remoteReceiptId ?? null,
  });

  // ---- independent readback ----------------------------------------------
  const readback = await verifyResultProcessReadback({
    executionDir: execution.path,
    payloadDir: fixture.payloadDir,
    outDir: manifest.artifacts.readback,
    env,
    fetchImpl,
  });
  const [readbackRow] = readback.receipt.rows;
  if (
    readback.receipt.status !== "verified" ||
    readbackRow.observedStateCode !== 120 ||
    readbackRow.observedByteHash !== byteHash ||
    readbackRow.observedCanonicalContentHash !== canonicalHash
  )
    throw failure(
      "live_acceptance_readback_unexpected",
      "Independent readback did not verify the stored bytes and canonical identity",
      {
        status: readback.receipt.status,
        observedStateCode: readbackRow.observedStateCode,
      },
    );
  const originalReceiptId = readbackRow.receiptId;
  manifest.retainedRows[0].stateCode = readbackRow.observedStateCode;
  manifest.retainedRows[0].receiptId = originalReceiptId;
  await record("readback", {
    readbackReceiptSha256: readback.receiptSha256,
    receiptId: originalReceiptId,
    observedStateCode: readbackRow.observedStateCode,
    observedByteHash: readbackRow.observedByteHash,
    observedCanonicalContentHash: readbackRow.observedCanonicalContentHash,
    byteHashDomain: readbackRow.byteHashDomain,
    serverVerified: readbackRow.serverVerified,
  });

  // ---- same-request retry: observe the retry itself ----------------------
  // The retry's own remote receipt and event are read; the first readback's
  // receiptId is not reused as evidence.
  const retry = await executeResultProcessPublication({
    preparationDir: preparation.path,
    payloadDir: fixture.payloadDir,
    outDir: manifest.artifacts.executionRetry,
    env,
    fetchImpl,
  });
  const retryEvents = await readEventDirectory(
    path.join(manifest.artifacts.executionRetry, "events"),
  );
  const retryEvent = lastCompletedEvent(retryEvents);
  if (!retryEvent)
    throw failure(
      "live_acceptance_retry_unobserved",
      "The retry produced no completed execution event",
    );
  // The retry must have been resolved as a server-side reuse, not as a fresh
  // insert, and it must name the same stored receipt.
  if (
    retryEvent.disposition !== "reused_identical_receipt" ||
    retryEvent.remoteReceiptId !== originalReceiptId
  )
    throw failure(
      "live_acceptance_retry_not_identical",
      "The retry did not observe the identical existing receipt",
      {
        disposition: retryEvent.disposition,
        retryReceiptId: retryEvent.remoteReceiptId,
        originalReceiptId,
      },
    );
  // A fresh readback confirms the row still carries exactly that receipt.
  const postRetryReadback = await verifyResultProcessReadback({
    executionDir: retry.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(outDir, "result-readback-retry"),
    env,
    fetchImpl,
  });
  const [postRetryRow] = postRetryReadback.receipt.rows;
  if (postRetryRow.receiptId !== originalReceiptId)
    throw failure(
      "live_acceptance_retry_receipt_changed",
      "The retry changed the stored receipt identity",
      { observed: postRetryRow.receiptId, expected: originalReceiptId },
    );
  await record("retry", {
    observedDisposition: retryEvent.disposition,
    observedRemoteReceiptId: retryEvent.remoteReceiptId,
    originalReceiptId,
    identicalReceipt: true,
    postRetryReadbackReceiptId: postRetryRow.receiptId,
    retryReceiptSha256: retry.receiptSha256,
    evidenceSource: "retry_execution_event_and_post_retry_readback",
  });

  // ---- conflicting identity under a genuinely new idempotency key --------
  // The idempotency key is derived from plan|key|contentSha256, so a second
  // approval over the SAME plan would reuse the original key and would only
  // exercise the replay path. To exercise the reviewed "a 120 row exists with no
  // matching receipt" branch, the probe needs a different plan for the same
  // identity: a distinct target id changes the plan hash and therefore the key.
  const conflictFixture = await writeResultOnlyFixture({
    uuid: config.fixtureUuid,
    version: config.version,
    contentText,
    targetId: `${config.instanceLabel}-conflict-probe`,
  });
  const conflictInspection = await inspectPublicationTarget({
    planDir: conflictFixture.planDir,
    payloadDir: conflictFixture.payloadDir,
    outDir: path.join(outDir, "inspection-conflict"),
    env,
    fetchImpl,
  });
  const conflictApproval = await createPublicationApproval({
    inspectionDir: conflictInspection.path,
    outDir: path.join(outDir, "approval-conflict"),
    confirmPlanSha256: conflictInspection.executablePlanSha256,
    approvedBy: "live-acceptance-operator",
    attestedByUserId: approverUserId,
    reason: "live acceptance conflict probe",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  const conflictPreparation = await prepareResultProcessPublication({
    approvalDir: conflictApproval.path,
    payloadDir: conflictFixture.payloadDir,
    outDir: path.join(outDir, "result-preparation-conflict"),
    env,
    fetchImpl,
  });
  const conflictKey =
    conflictPreparation.preparation.operations[0].idempotencyKey;
  if (conflictKey === preparedOperation.idempotencyKey)
    throw failure(
      "live_acceptance_conflict_key_not_new",
      "The conflict probe must use a different idempotency key than the published one",
    );
  let conflictCode = null;
  let conflictStatus = null;
  try {
    await executeResultProcessPublication({
      preparationDir: conflictPreparation.path,
      payloadDir: conflictFixture.payloadDir,
      outDir: path.join(outDir, "result-execution-conflict"),
      env,
      fetchImpl,
    });
  } catch (error) {
    conflictCode = typedCode(error?.code);
    conflictStatus = typedStatus(error?.details?.semanticStatus);
  }
  if (conflictCode !== "result_publication_conflict" || conflictStatus !== 409)
    throw failure(
      "live_acceptance_conflict_unexpected",
      "A different idempotency key against the existing identity must be a typed 409 conflict",
      { code: conflictCode, semanticStatus: conflictStatus },
    );
  await record("conflict", {
    code: conflictCode,
    semanticStatus: conflictStatus,
    keyIsNew: true,
    existingIdentityRetained: true,
  });

  // ---- generic authenticated read must hide state 120 --------------------
  const generic = await genericProcessRead({ config, fetchImpl });
  if (
    generic.status !== 200 ||
    !Array.isArray(generic.rows) ||
    generic.rows.length !== 0
  )
    throw failure(
      "live_acceptance_generic_read_exposed_120",
      "A generic authenticated /processes query must not expose the state-120 row",
      {
        httpStatus: generic.status,
        rowCount: Array.isArray(generic.rows) ? generic.rows.length : null,
      },
    );
  await record("generic_read_isolated", {
    httpStatus: generic.status,
    rowCount: 0,
  });

  // ---- non-manager denial (only when a second token is supplied) ---------
  if (config.nonManagerToken) {
    const denial = await invokeRpc({
      config,
      env: { ...env, TIANGONG_LCA_ACCESS_TOKEN: config.nonManagerToken },
      functionName: PREPARE_FUNCTION,
      body: {
        p_request: {
          table: "processes",
          id: config.fixtureUuid,
          version: config.version,
          contentText,
          contentSha256: byteHash,
          sourceKind: "manager_attestation",
          source: {
            candidateSetHash: fixture.manifest.datasetSetHash,
            sourceManifestHash: fixture.manifest.candidate.packageSetHash,
          },
          audit: { reason: "live acceptance non-manager probe" },
        },
      },
      fetchImpl,
    });
    const code = describeCode(denial);
    if (
      denial.ok !== false ||
      !["not_data_product_manager", "auth_required"].includes(code)
    )
      throw failure(
        "live_acceptance_non_manager_not_denied",
        "A non-manager actor must be denied by the manager-only RPC",
        { code },
      );
    await record("non_manager_denial", {
      code,
      semanticStatus: typedStatus(denial.status),
    });
  } else {
    await record("non_manager_denial", {
      skipped: true,
      reason:
        "TIANGONG_RELEASE_LIVE_NON_MANAGER_TOKEN was not supplied; no second actor was available",
    });
  }

  manifest.outcome = "completed";
  manifest.endedAt = new Date().toISOString();
  await persist();
  return {
    manifest,
    summary: {
      outcome: "live_acceptance_completed",
      instanceLabel: config.instanceLabel,
      endpoint: config.baseUrl,
      datasetKey: fixture.dataset.key,
      storedByteHash: byteHash,
      canonicalContentHash: canonicalHash,
      executablePlanSha256: inspection.executablePlanSha256,
      approvalSha256: approval.approvalSha256,
      preparationSha256: preparation.preparationSha256,
      executionReceiptSha256: execution.receiptSha256,
      readbackReceiptSha256: readback.receiptSha256,
      receiptId: originalReceiptId,
      stepCount: manifest.steps.length,
      retainedRows: manifest.retainedRows,
      artifacts: manifest.artifacts,
      revocation:
        "Not automated. A revocation readback is a separate operator SQL step; see live/README.md.",
    },
  };
}

async function invokeRpc({ config, env, functionName, body, fetchImpl }) {
  const response = await fetchImpl(
    `${config.baseUrl}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: {
        apikey: env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${env.TIANGONG_LCA_ACCESS_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Profile": "api",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    },
  );
  return readEnvelope(response);
}

async function genericProcessRead({ config, fetchImpl }) {
  const url = new URL(`${config.baseUrl}/rest/v1/processes`);
  url.searchParams.set("id", `eq.${config.fixtureUuid}`);
  url.searchParams.set("version", `eq.${config.version}`);
  url.searchParams.set("select", "id,version,state_code");
  const response = await fetchImpl(url.href, {
    method: "GET",
    headers: {
      apikey: config.publishableKey,
      Authorization: `Bearer ${config.accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const text = await response.text();
  let rows = null;
  try {
    rows = text ? JSON.parse(text) : null;
  } catch {
    rows = null;
  }
  return { status: response.status, rows };
}

/**
 * Reduce a response to the small allowlisted subset this runner may report.
 *
 * The raw body is never returned: a failure envelope can echo request content,
 * and an unexpected field must not be able to inject arbitrary text into the
 * manifest or console.
 */
async function readEnvelope(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw failure(
      "live_acceptance_response_not_json",
      "Endpoint returned a non-JSON response",
      { httpStatus: response.status },
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw failure(
      "live_acceptance_response_invalid",
      "Endpoint returned an unusable envelope",
      { httpStatus: response.status },
    );
  const code = payload.ok === false ? typedCode(payload.code) : null;
  const data =
    payload.ok === true && payload.data && typeof payload.data === "object"
      ? { classification: sanitizeClassification(payload.data.classification) }
      : null;
  return {
    ok: payload.ok === true,
    code,
    status: typedStatus(payload.status),
    data,
  };
}

function typedCode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return ALLOWED_REMOTE_CODES.has(normalized)
    ? normalized
    : "unexpected_remote_code";
}

function typedStatus(value) {
  return Number.isInteger(value) ? value : null;
}

function sanitizeClassification(value) {
  return typeof value === "string" && ALLOWED_CLASSIFICATIONS.has(value)
    ? value
    : null;
}

function sanitizeDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details))
    return {};
  const allowed = [
    "classification",
    "code",
    "semanticStatus",
    "httpStatus",
    "operationCount",
    "action",
    "rowCount",
    "port",
    "host",
    "status",
    "observedStateCode",
    "expected",
    "observed",
    "disposition",
    "retryReceiptId",
    "originalReceiptId",
  ];
  const output = {};
  for (const key of allowed)
    if (
      key in details &&
      (details[key] === null || typeof details[key] !== "object")
    )
      output[key] = details[key];
  return output;
}

async function readEventDirectory(directory) {
  let files;
  try {
    files = (await readdir(directory)).filter((file) =>
      /^\d{6}\.json$/u.test(file),
    );
  } catch {
    return [];
  }
  const events = [];
  for (const file of files.sort())
    events.push(JSON.parse(await readFile(path.join(directory, file), "utf8")));
  return events;
}

function lastCompletedEvent(events) {
  return (
    events
      .filter(
        (event) =>
          event.outcome === "published" ||
          event.outcome === "already_published",
      )
      .at(-1) ?? null
  );
}

function describeCode(envelope) {
  return typeof envelope?.code === "string" ? envelope.code : null;
}

function jwtSubject(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return typeof payload?.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

function failure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}
