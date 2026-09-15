import { createHash } from "node:crypto";

/**
 * An in-process stand-in for the three reviewed Database #646 RPCs
 * (`api.qry_result_process_publish_prepare_v1`, `api.cmd_result_process_publish_v1`,
 * `api.qry_result_process_publication_readback_v1`) plus the four pre-existing
 * platform endpoints the ordinary publication path uses.
 *
 * SCOPE — what this can and cannot establish:
 *
 *   It verifies the *wire shape and adapter branches* of the reviewed contract:
 *   the actor is derived from the presented JWT and never from the request body;
 *   `role`, `targetState`, `stateCode` and `actorUserId` are rejected outright;
 *   unknown fields are rejected at every level, phase-specifically; a row is only
 *   ever created at 120; readback needs an exact receipt binding and returns the
 *   exact stored text.
 *
 *   It does NOT reproduce SQL semantics. Advisory lock ordering and deadlock
 *   freedom, uniqueness-race conversion, transaction rollback of row + receipt +
 *   audit, RLS/ACL behaviour, json-vs-jsonb byte preservation and trigger
 *   interaction are properties of the database and are only asserted here as
 *   adapter-visible outcomes. They require the real local RPC integration run.
 *
 * The real database is the authority. Nothing here is a substitute for it.
 */
const HASH_HEX = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u;
const PREPARE_SOURCE_KEYS = ["candidateSetHash", "sourceManifestHash"];
const EXECUTE_SOURCE_KEYS = [
  "candidateSetHash",
  "sourceManifestHash",
  "executablePlanHash",
  "approvalHash",
];
const COMMON_KEYS = [
  "table",
  "id",
  "version",
  "contentText",
  "contentSha256",
  "sourceKind",
  "source",
  "audit",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function error(code, status, message, details) {
  return {
    body: {
      ok: false,
      code,
      status,
      message,
      ...(details === undefined ? {} : { details }),
    },
    httpStatus: 200,
  };
}

function ok(body) {
  return { body, httpStatus: 200 };
}

export function createPublicationMock({
  actorUserId,
  managerActive = true,
  rows = [],
  responseOverrides = {},
} = {}) {
  let liveManagerActive = managerActive;
  const processes = new Map();
  const receipts = new Map();
  const commandCounts = {
    prepare: 0,
    execute: 0,
    readback: 0,
    create: 0,
    publish: 0,
    bundle: 0,
    restRead: 0,
  };
  const failures = {
    loseExecuteResponse: new Set(),
    failNextExecuteFor: new Set(),
  };
  // Every write command the platform receives, so tests can prove that no
  // Result Process identity ever reaches the pre-existing 0/100 endpoints.
  const platformCommands = [];
  const overrides = { ...responseOverrides };

  const insertRow = (row) =>
    processes.set(
      `${row.table ?? "processes"}:${row.id}@${btrim(row.version)}`,
      {
        ...row,
      },
    );

  for (const row of rows) insertRow(row);

  function btrim(value) {
    return String(value).trim();
  }

  function classify(id, version, contentSha256) {
    const row = processes.get(`processes:${id}@${btrim(version)}`);
    if (!row)
      return { classification: "absent", stateCode: null, stored: null };
    const storedSha = sha256(row.contentText);
    if (row.stateCode === 120 && storedSha === contentSha256)
      return {
        classification: "candidate_content_matches_existing",
        stateCode: row.stateCode,
        stored: storedSha,
      };
    return {
      classification: "conflict",
      stateCode: row.stateCode ?? null,
      stored: storedSha,
    };
  }

  function preparationHash({
    actor,
    id,
    version,
    contentSha256,
    source,
    reason,
    classification,
    stateCode,
  }) {
    return sha256(
      JSON.stringify({
        domain: "result-process-preparation.v1",
        actorUserId: actor,
        id,
        version,
        contentSha256,
        sourceKind: "manager_attestation",
        candidateSetHash: source.candidateSetHash,
        sourceManifestHash: source.sourceManifestHash,
        reason,
        classification,
        existingState: stateCode,
      }),
    );
  }

  function validate(request, phase) {
    if (!request || typeof request !== "object" || Array.isArray(request))
      return error(
        "result_publish_request_invalid",
        400,
        "Request must be a JSON object",
      );
    const allowed = new Set([
      ...COMMON_KEYS,
      ...(phase === "execute"
        ? ["expectedPreparationHash", "idempotencyKey"]
        : []),
    ]);
    for (const key of Object.keys(request))
      if (!allowed.has(key))
        return error(
          "result_publish_request_invalid",
          400,
          `Field not allowed in ${phase}: ${key}`,
        );
    for (const forbidden of ["role", "targetState", "actorUserId", "stateCode"])
      if (forbidden in request)
        return error(
          "result_publish_request_invalid",
          400,
          "role, targetState, stateCode and actorUserId are server-derived",
        );
    const sourceKeys =
      phase === "prepare" ? PREPARE_SOURCE_KEYS : EXECUTE_SOURCE_KEYS;
    if (
      !request.source ||
      typeof request.source !== "object" ||
      Array.isArray(request.source)
    )
      return error(
        "result_publish_request_invalid",
        400,
        "source is required and must be an object",
      );
    for (const key of Object.keys(request.source))
      if (!sourceKeys.includes(key))
        return error(
          "result_publish_request_invalid",
          400,
          `Source field not allowed in ${phase}: ${key}`,
        );
    for (const key of sourceKeys)
      if (
        typeof request.source[key] !== "string" ||
        !HASH_HEX.test(request.source[key])
      )
        return error(
          "result_publish_request_invalid",
          400,
          `source.${key} must be a lowercase SHA-256 hex string`,
        );
    if (!request.audit || typeof request.audit !== "object")
      return error(
        "result_publish_request_invalid",
        400,
        "audit.reason is required and must be a string",
      );
    for (const key of Object.keys(request.audit))
      if (key !== "reason")
        return error(
          "result_publish_request_invalid",
          400,
          `Unknown audit field: ${key}`,
        );
    const reason = request.audit.reason;
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 1000)
      return error(
        "result_publish_request_invalid",
        400,
        "audit.reason must be 1..1000 printable characters",
      );
    if (request.table !== "processes")
      return error(
        "result_publish_request_invalid",
        400,
        "table must be the string processes",
      );
    if (typeof request.id !== "string" || !UUID.test(request.id))
      return error(
        "result_publish_request_invalid",
        400,
        "id must be a lowercase UUID string",
      );
    if (typeof request.version !== "string" || !VERSION.test(request.version))
      return error(
        "result_publish_request_invalid",
        400,
        "version must be a NN.NN.NNN string",
      );
    if (request.sourceKind !== "manager_attestation")
      return error(
        "result_publish_request_invalid",
        400,
        "sourceKind must be the string manager_attestation",
      );
    if (
      typeof request.contentSha256 !== "string" ||
      !HASH_HEX.test(request.contentSha256)
    )
      return error(
        "result_publish_request_invalid",
        400,
        "contentSha256 must be a lowercase SHA-256 hex string",
      );
    if (typeof request.contentText !== "string")
      return error(
        "result_publish_request_invalid",
        400,
        "contentText must be a string containing the JSON document",
      );
    if (Buffer.byteLength(request.contentText, "utf8") < 2)
      return error(
        "result_publish_request_invalid",
        400,
        "contentText must be between 2 bytes and 1 MiB",
      );
    if (phase === "execute") {
      if (
        typeof request.expectedPreparationHash !== "string" ||
        !HASH_HEX.test(request.expectedPreparationHash)
      )
        return error(
          "result_publish_request_invalid",
          400,
          "expectedPreparationHash must be a lowercase SHA-256 hex string",
        );
      if (typeof request.idempotencyKey !== "string")
        return error(
          "result_publish_request_invalid",
          400,
          "idempotencyKey must be a string",
        );
      if (
        request.idempotencyKey.length < 1 ||
        request.idempotencyKey.length > 200 ||
        request.idempotencyKey !== request.idempotencyKey.trim()
      )
        return error(
          "result_publish_request_invalid",
          400,
          "idempotencyKey must be 1..200 characters with no surrounding whitespace",
        );
    }
    return null;
  }

  function validateContent(request, id, version) {
    let document;
    try {
      document = JSON.parse(request.contentText);
    } catch {
      return error(
        "result_publish_content_invalid",
        400,
        "contentText is not valid JSON",
      );
    }
    if (
      document === null ||
      typeof document !== "object" ||
      Array.isArray(document)
    )
      return error(
        "result_publish_content_invalid",
        400,
        "contentText must be a JSON object with no duplicate keys at any level",
      );
    const data = document.processDataSet;
    if (!data || typeof data !== "object")
      return error(
        "result_publish_content_invalid",
        400,
        "contentText must contain processDataSet",
      );
    const documentId =
      data.processInformation?.dataSetInformation?.["common:UUID"];
    if (typeof documentId !== "string" || documentId.toLowerCase() !== id)
      return error(
        "result_publish_content_invalid",
        400,
        "processDataSet common:UUID must be a string equal to id",
      );
    const documentVersion =
      data.administrativeInformation?.publicationAndOwnership?.[
        "common:dataSetVersion"
      ];
    if (typeof documentVersion !== "string" || documentVersion !== version)
      return error(
        "result_publish_content_invalid",
        400,
        "publicationAndOwnership common:dataSetVersion must be a string equal to version",
      );
    return null;
  }

  function receiptJson(receipt) {
    return {
      schemaVersion: "result-process.publication-receipt.v1",
      receiptId: receipt.receiptId,
      actorUserId: receipt.actorUserId,
      id: receipt.id,
      version: receipt.version,
      stateCode: receipt.stateCode,
      role: receipt.role,
      targetState: receipt.targetState,
      contentSha256: receipt.contentSha256,
      hashDomain: receipt.hashDomain,
      sourceKind: receipt.sourceKind,
      candidateSetHash: receipt.candidateSetHash,
      sourceManifestHash: receipt.sourceManifestHash,
      executablePlanHash: receipt.executablePlanHash,
      approvalHash: receipt.approvalHash,
      preparationHash: receipt.preparationHash,
      idempotencyKey: receipt.idempotencyKey,
      publishedAt: receipt.publishedAt,
      reason: receipt.reason,
    };
  }

  function requestBinding(request, id, version, contentSha256) {
    return {
      id,
      version,
      contentSha256,
      candidateSetHash: request.source.candidateSetHash,
      sourceManifestHash: request.source.sourceManifestHash,
      executablePlanHash: request.source.executablePlanHash,
      approvalHash: request.source.approvalHash,
      reason: request.audit.reason,
      expectedPreparationHash: request.expectedPreparationHash,
    };
  }

  function sameBinding(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  async function callRpc(functionName, request) {
    // The actor is server-derived from the presented JWT, exactly as auth.uid().
    const actor = actorUserId;
    if (!actor) return error("auth_required", 401, "Authentication required");
    if (!liveManagerActive)
      return error(
        "not_data_product_manager",
        403,
        "Data product manager role is required",
      );

    if (functionName === "qry_result_process_publish_prepare_v1") {
      commandCounts.prepare += 1;
      const invalid = validate(request, "prepare");
      if (invalid) return invalid;
      const contentInvalid = validateContent(
        request,
        request.id,
        request.version,
      );
      if (contentInvalid) return contentInvalid;
      const contentSha256 = sha256(request.contentText);
      if (contentSha256 !== request.contentSha256)
        return error(
          "result_content_hash_mismatch",
          400,
          "contentSha256 does not match the submitted content bytes",
        );
      const observed = classify(request.id, request.version, contentSha256);
      const payload = {
        schemaVersion: "result-process.publish-prepare.v1",
        preparationHash: preparationHash({
          actor,
          id: request.id,
          version: request.version,
          contentSha256,
          source: request.source,
          reason: request.audit.reason,
          classification: observed.classification,
          stateCode: observed.stateCode,
        }),
        actorUserId: actor,
        id: request.id,
        version: request.version,
        contentSha256,
        hashDomain: "result-process-content.v1",
        sourceKind: "manager_attestation",
        classification: observed.classification,
        existingState: observed.stateCode,
      };
      return ok({
        ok: true,
        data: { ...payload, ...(overrides.prepare ?? {}) },
      });
    }

    if (functionName === "cmd_result_process_publish_v1") {
      commandCounts.execute += 1;
      const invalid = validate(request, "execute");
      if (invalid) return invalid;
      const contentInvalid = validateContent(
        request,
        request.id,
        request.version,
      );
      if (contentInvalid) return contentInvalid;
      const contentSha256 = sha256(request.contentText);
      if (contentSha256 !== request.contentSha256)
        return error(
          "result_content_hash_mismatch",
          400,
          "contentSha256 does not match the submitted content bytes",
        );
      const key = `${actor}:${request.idempotencyKey}`;
      const existing = receipts.get(key);
      // Step 5a/5b: this actor's key resolves first, before any classification.
      if (existing) {
        if (existing.id !== request.id || existing.version !== request.version)
          return error(
            "result_publication_replay_mismatch",
            409,
            "This idempotency key is already bound to a different Result identity",
          );
        if (
          existing.contentSha256 === contentSha256 &&
          sameBinding(
            existing.requestBinding,
            requestBinding(request, request.id, request.version, contentSha256),
          )
        ) {
          const row = processes.get(
            `processes:${request.id}@${request.version}`,
          );
          if (
            !row ||
            row.stateCode !== 120 ||
            sha256(row.contentText) !== contentSha256
          )
            return error(
              "result_publication_conflict",
              409,
              "The published row no longer matches its attestation",
            );
          return ok({
            ok: true,
            reused: true,
            data: receiptJson(existing),
          });
        }
        return error(
          "result_publication_replay_mismatch",
          409,
          "This idempotency key is already bound to a different publication binding",
        );
      }
      // Step 6: no receipt, so classify before recomputing the preparation.
      const observed = classify(request.id, request.version, contentSha256);
      if (observed.classification !== "absent")
        return error(
          "result_publication_conflict",
          409,
          "A row already exists for this identity",
          { stateCode: observed.stateCode },
        );
      const expected = preparationHash({
        actor,
        id: request.id,
        version: request.version,
        contentSha256,
        source: request.source,
        reason: request.audit.reason,
        classification: observed.classification,
        stateCode: observed.stateCode,
      });
      if (expected !== request.expectedPreparationHash)
        return error(
          "result_preparation_stale",
          409,
          "expectedPreparationHash does not match the current preparation",
        );
      // Absent: insert directly at 120. Never 0, never 100.
      insertRow({
        table: "processes",
        id: request.id,
        version: request.version,
        contentText: request.contentText,
        stateCode: 120,
        userId: actor,
        source: "result_process_command",
      });
      const receipt = {
        receiptId: `00000000-0000-4000-8000-${String(receipts.size + 1).padStart(12, "0")}`,
        actorUserId: actor,
        id: request.id,
        version: request.version,
        stateCode: 120,
        role: "result_process",
        targetState: 120,
        contentSha256,
        hashDomain: "result-process-content.v1",
        sourceKind: "manager_attestation",
        candidateSetHash: request.source.candidateSetHash,
        sourceManifestHash: request.source.sourceManifestHash,
        executablePlanHash: request.source.executablePlanHash,
        approvalHash: request.source.approvalHash,
        preparationHash: expected,
        idempotencyKey: request.idempotencyKey,
        publishedAt: "2026-09-15T00:00:00.000Z",
        reason: request.audit.reason,
        requestBinding: requestBinding(
          request,
          request.id,
          request.version,
          contentSha256,
        ),
      };
      receipts.set(key, receipt);
      if (failures.failNextExecuteFor.has(request.id)) {
        failures.failNextExecuteFor.delete(request.id);
        // A definite failure after the write raises in the real command, so the
        // whole transaction rolls back: row, receipt and audit never persist.
        processes.delete(`processes:${request.id}@${request.version}`);
        receipts.delete(key);
        return error(
          "injected_execute_failure",
          500,
          "Injected execute failure before commit",
        );
      }
      if (failures.loseExecuteResponse.has(request.id)) {
        failures.loseExecuteResponse.delete(request.id);
        // The write committed; only the response was lost.
        return { transportError: "lost_response" };
      }
      return ok({
        ok: true,
        reused: false,
        data: { ...receiptJson(receipt), ...(overrides.execute ?? {}) },
      });
    }

    if (functionName === "qry_result_process_publication_readback_v1") {
      commandCounts.readback += 1;
      if (!request || typeof request !== "object" || Array.isArray(request))
        return error(
          "result_publish_request_invalid",
          400,
          "Request must be a JSON object",
        );
      for (const key of Object.keys(request))
        if (!["id", "version", "idempotencyKey"].includes(key))
          return error(
            "result_publish_request_invalid",
            400,
            `Unknown request field: ${key}`,
          );
      if (typeof request.id !== "string" || !UUID.test(request.id))
        return error(
          "result_publish_request_invalid",
          400,
          "id must be a lowercase UUID string",
        );
      if (typeof request.version !== "string" || !VERSION.test(request.version))
        return error(
          "result_publish_request_invalid",
          400,
          "version must be a NN.NN.NNN string",
        );
      if (
        typeof request.idempotencyKey !== "string" ||
        request.idempotencyKey.length < 1 ||
        request.idempotencyKey.length > 200 ||
        request.idempotencyKey !== request.idempotencyKey.trim()
      )
        return error(
          "result_publish_request_invalid",
          400,
          "idempotencyKey must be 1..200 characters with no surrounding whitespace",
        );
      const receipt = receipts.get(`${actor}:${request.idempotencyKey}`);
      if (
        !receipt ||
        receipt.id !== request.id ||
        receipt.version !== request.version
      )
        return error(
          "result_publication_not_found",
          404,
          "No publication attestation matches this exact binding",
        );
      const row = processes.get(`processes:${request.id}@${request.version}`);
      if (!row)
        return error(
          "result_publication_not_found",
          404,
          "The attested row no longer exists",
        );
      const liveSha = sha256(row.contentText);
      return ok({
        ok: true,
        data: {
          receipt: {
            ...receiptJson(receipt),
            ...(overrides.readbackReceipt ?? {}),
          },
          row: {
            stateCode: row.stateCode,
            contentSha256: liveSha,
            contentText: row.contentText,
            ...(overrides.readbackRow ?? {}),
          },
          verified: {
            rowMatchesReceipt:
              liveSha === receipt.contentSha256 && row.stateCode === 120,
            receiptMatchesRequest:
              receipt.idempotencyKey === request.idempotencyKey,
            liveManager: true,
            ...(overrides.readbackVerified ?? {}),
          },
        },
      });
    }
    return error("unknown_rpc", 404, `Unknown function: ${functionName}`);
  }

  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/rest/v1/rpc/")) {
      const functionName = parsed.pathname.split("/").at(-1);
      const body = JSON.parse(options.body);
      const result = await callRpc(functionName, body.p_request);
      if (result.transportError) throw new Error("socket hang up");
      return jsonResponse(result.body, result.httpStatus);
    }
    if (parsed.pathname.startsWith("/rest/v1/")) {
      commandCounts.restRead += 1;
      const table = parsed.pathname.split("/").at(-1);
      const id = parsed.searchParams.get("id").replace(/^eq\./u, "");
      const version = parsed.searchParams.get("version").replace(/^eq\./u, "");
      const row = processes.get(`${table}:${id}@${btrim(version)}`);
      // Layer 1 of the reviewed read-isolation migration: 120 is never readable
      // through a generic path, even for the actor that published it.
      if (!row || row.stateCode === 120) return jsonResponse([]);
      return jsonResponse([
        {
          id: row.id,
          version: row.version,
          state_code: row.stateCode,
          user_id: row.userId,
          json_ordered: JSON.parse(row.contentText),
        },
      ]);
    }
    const body = JSON.parse(options.body);
    if (parsed.pathname.endsWith("/app_dataset_create")) {
      commandCounts.create += 1;
      platformCommands.push({ command: "app_dataset_create", body });
      insertRow({
        table: body.table,
        id: body.id,
        version: body.version ?? documentVersion(body.jsonOrdered),
        contentText: JSON.stringify(body.jsonOrdered),
        stateCode: 0,
        userId: actorUserId,
        source: "platform_create",
      });
      return jsonResponse({ ok: true, command: "dataset_create" });
    }
    if (parsed.pathname.endsWith("/save_lifecycle_model_bundle")) {
      commandCounts.bundle += 1;
      platformCommands.push({ command: "save_lifecycle_model_bundle", body });
      insertRow({
        table: "lifecyclemodels",
        id: body.modelId,
        version: documentVersion(body.parent.jsonOrdered),
        contentText: JSON.stringify(body.parent.jsonOrdered),
        stateCode: 0,
        userId: actorUserId,
        source: "platform_bundle",
      });
      return jsonResponse({ ok: true });
    }
    if (parsed.pathname.endsWith("/app_dataset_publish")) {
      commandCounts.publish += 1;
      platformCommands.push({ command: "app_dataset_publish", body });
      const row = processes.get(`${body.table}:${body.id}@${body.version}`);
      if (!row)
        return jsonResponse({ ok: false, code: "DATASET_NOT_FOUND" }, 404);
      row.stateCode = 100;
      return jsonResponse({ ok: true, command: "dataset_publish" });
    }
    return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404);
  };

  return {
    fetch,
    /**
     * Serve the same contract over loopback so the CLI can be exercised
     * end-to-end without any remote call.
     */
    async listen() {
      const { createServer } = await import("node:http");
      let origin;
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const response = await fetch(`${origin}${req.url}`, {
          method: req.method,
          headers: req.headers,
          body: body || undefined,
        });
        res.writeHead(response.status, {
          "content-type":
            response.headers.get("content-type") ?? "application/json",
        });
        res.end(await response.text());
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${server.address().port}`;
      return {
        baseUrl: origin,
        close: () => new Promise((resolve) => server.close(resolve)),
      };
    },
    commandCounts,
    platformCommands,
    processes,
    receipts,
    insertRow,
    getRow: (id, version, table = "processes") =>
      processes.get(`${table}:${id}@${btrim(version)}`) ?? null,
    loseNextExecuteResponseFor: (id) => failures.loseExecuteResponse.add(id),
    failNextExecuteFor: (id) => failures.failNextExecuteFor.add(id),
    setManagerActive: (value) => {
      liveManagerActive = value;
    },
    setOverride: (key, value) => {
      overrides[key] = value;
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function documentVersion(document) {
  return (
    document?.processDataSet?.administrativeInformation
      ?.publicationAndOwnership?.["common:dataSetVersion"] ??
    document?.lifeCycleModelDataSet?.administrativeInformation
      ?.publicationAndOwnership?.["common:dataSetVersion"] ??
    "01.00.000"
  );
}
