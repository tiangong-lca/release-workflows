import { fail, sha256Bytes } from "../lib/common.mjs";
import { createFinalResultActorTransport } from "./final-result-actor-transport.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const uuid = (v) => typeof v === "string" && UUID.test(v),
  hash = (v) => typeof v === "string" && HASH.test(v);
const nullableUuid = (v) => v === null || uuid(v);
function required(v, code = "final_publication_contract_invalid") {
  if (!v) fail(code, "Final Result publication contract did not match");
}
function exact(value, keys) {
  required(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
  );
}
function runArgs(a, extra = []) {
  exact(a, ["releaseRunId", "publishPlanHash", ...extra]);
  required(uuid(a.releaseRunId) && hash(a.publishPlanHash));
  return {
    p_release_run_id: a.releaseRunId,
    p_publish_plan_hash: a.publishPlanHash,
  };
}
const key = (v) =>
  typeof v === "string" && v.length >= 1 && v.length <= 128 && v.trim() === v;
const timestamp = (v) =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const reason = (v) =>
  typeof v === "string" && v.trim().length > 0 && [...v].length <= 2000;
const count = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 2000000;

// Only actor-scoped release authority. No DB connection, S3, reader secret,
// implicit login, retries, or generic RPC escape hatch is exposed.
export function createFinalResultPublication(config) {
  const transport = createFinalResultActorTransport(config);
  async function read(routine, body, check, options) {
    const d = await transport.call(routine, body, options);
    if (d !== null) check(d);
    return d;
  }
  async function write(routine, body, check, options) {
    try {
      const d = await transport.call(routine, body, options);
      required(d !== null);
      check(d);
      return d;
    } catch (e) {
      // A transport/response failure after send is not proof of rollback. The
      // orchestrator must query the exact existing identity before retrying.
      if (
        e.code === "final_actor_session_expired" ||
        e.code === "final_actor_contract_invalid"
      )
        throw e;
      if (e.code === "final_actor_request_denied" && e.details?.semanticCode)
        throw e;
      fail(
        "final_publication_outcome_unknown",
        "Publication command outcome requires exact independent readback",
      );
    }
  }
  return {
    actorId: transport.actorId,
    apiTargetHash: transport.apiTargetHash,
    head(options) {
      return read(
        "qry_final_result_publication_head_v2",
        {},
        (d) => {
          exact(d, [
            "publicationId",
            "releaseRunId",
            "releaseVersion",
            "format",
            "candidateHash",
            "selectionHash",
            "targetHash",
          ]);
          required(
            uuid(d.publicationId) &&
              uuid(d.releaseRunId) &&
              typeof d.releaseVersion === "string" &&
              hash(d.selectionHash),
          );
          required(
            d.format === "final-result-pair.v2"
              ? hash(d.candidateHash) && hash(d.targetHash)
              : d.format === "legacy-four-zip.v1" &&
                  d.candidateHash === null &&
                  d.targetHash === null,
          );
        },
        options,
      );
    },
    run(releaseRunId, options) {
      required(uuid(releaseRunId));
      return read(
        "qry_final_result_release_v2",
        { p_release_run_id: releaseRunId },
        (d) => {
          exact(d, [
            "releaseRunId",
            "releaseVersion",
            "status",
            "publishPlanHash",
            "candidateHash",
            "targetHash",
            "selectionHash",
            "selectionCount",
            "registeredResultCount",
            "selectionSealed",
            "expectedCurrentPublicationId",
            "rollbackOfPublicationId",
            "activeApproval",
            "publication",
            "readbackReceipt",
            "publicationAuthorized",
          ]);
          required(
            d.releaseRunId === releaseRunId &&
              typeof d.releaseVersion === "string" &&
              typeof d.status === "string" &&
              [
                d.publishPlanHash,
                d.candidateHash,
                d.targetHash,
                d.selectionHash,
              ].every(hash) &&
              count(d.selectionCount) &&
              d.selectionCount > 0 &&
              count(d.registeredResultCount) &&
              typeof d.selectionSealed === "boolean" &&
              nullableUuid(d.expectedCurrentPublicationId) &&
              nullableUuid(d.rollbackOfPublicationId) &&
              d.publicationAuthorized === false,
          );
          if (d.activeApproval !== null) {
            exact(d.activeApproval, [
              "approvalId",
              "approvalHash",
              "approvedBy",
              "expiresAt",
              "verificationId",
            ]);
            required(
              uuid(d.activeApproval.approvalId) &&
                hash(d.activeApproval.approvalHash) &&
                uuid(d.activeApproval.approvedBy) &&
                timestamp(d.activeApproval.expiresAt) &&
                uuid(d.activeApproval.verificationId),
            );
          }
          if (d.publication !== null) {
            const p = d.publication;
            exact(p, [
              "publicationId",
              "status",
              "isCurrent",
              "publishedAt",
              "approvalId",
              "approvalHash",
              "approvedBy",
              "executedBy",
              "idempotencyKey",
              "credentialFingerprint",
              "verificationId",
              "previousPublicationId",
              "rollbackOfPublicationId",
            ]);
            required(
              uuid(p.publicationId) &&
                typeof p.status === "string" &&
                typeof p.isCurrent === "boolean" &&
                timestamp(p.publishedAt) &&
                uuid(p.approvalId) &&
                hash(p.approvalHash) &&
                uuid(p.approvedBy) &&
                uuid(p.executedBy) &&
                key(p.idempotencyKey) &&
                hash(p.credentialFingerprint) &&
                uuid(p.verificationId) &&
                nullableUuid(p.previousPublicationId) &&
                nullableUuid(p.rollbackOfPublicationId),
            );
          }
        },
        options,
      );
    },
    approval(a, options) {
      exact(a, ["releaseRunId", "approvalId"]);
      required(uuid(a.releaseRunId) && uuid(a.approvalId));
      return read(
        "qry_final_result_release_approval_v2",
        { p_release_run_id: a.releaseRunId, p_approval_id: a.approvalId },
        (d) => {
          exact(d, [
            "approvalId",
            "releaseRunId",
            "publishPlanHash",
            "approvalHash",
            "approvedBy",
            "approvedAt",
            "expiresAt",
            "status",
            "reason",
            "context",
            "consumedAt",
            "consumedBy",
            "revokedAt",
          ]);
          required(
            d.approvalId === a.approvalId &&
              d.releaseRunId === a.releaseRunId &&
              hash(d.publishPlanHash) &&
              hash(d.approvalHash) &&
              uuid(d.approvedBy) &&
              timestamp(d.approvedAt) &&
              timestamp(d.expiresAt) &&
              typeof d.status === "string" &&
              reason(d.reason) &&
              nullableUuid(d.consumedBy) &&
              (d.consumedAt === null || timestamp(d.consumedAt)) &&
              (d.revokedAt === null || timestamp(d.revokedAt)),
          );
          const c = d.context;
          exact(c, [
            "schemaVersion",
            "verificationId",
            "expectedApprovalId",
            "candidateHash",
            "targetHash",
            "selectionHash",
            "runtimeRevision",
            "readerSha256",
            "permissionHash",
          ]);
          required(
            c.schemaVersion === "tiangong.final-result-approval.v2" &&
              uuid(c.verificationId) &&
              nullableUuid(c.expectedApprovalId) &&
              uuid(c.runtimeRevision) &&
              [
                c.candidateHash,
                c.targetHash,
                c.selectionHash,
                c.readerSha256,
                c.permissionHash,
              ].every(hash),
          );
        },
        options,
      );
    },
    prepare(a, options) {
      exact(a, ["planText", "idempotencyKey"]);
      required(
        typeof a.planText === "string" &&
          Buffer.byteLength(a.planText) <= 16384 &&
          key(a.idempotencyKey),
      );
      let p;
      try {
        p = JSON.parse(a.planText);
      } catch {
        required(false);
      }
      required(uuid(p?.releaseRunId));
      const planHash = sha256Bytes(Buffer.from(a.planText));
      return write(
        "cmd_final_result_release_prepare_v2",
        { p_plan_text: a.planText, p_idempotency_key: a.idempotencyKey },
        (d) => {
          exact(d, [
            "releaseRunId",
            "publishPlanHash",
            "status",
            "publicationAuthorized",
          ]);
          required(
            d.releaseRunId === p.releaseRunId &&
              d.publishPlanHash === planHash &&
              typeof d.status === "string" &&
              d.publicationAuthorized === false,
          );
        },
        options,
      );
    },
    members(a, options) {
      const body = runArgs(a, ["rows"]);
      required(
        Array.isArray(a.rows) && a.rows.length >= 1 && a.rows.length <= 500,
      );
      for (const r of a.rows) {
        exact(r, ["uuid", "version"]);
        required(
          uuid(r.uuid) &&
            typeof r.version === "string" &&
            VERSION.test(r.version),
        );
      }
      return write(
        "cmd_final_result_release_members_v2",
        { ...body, p_rows: a.rows },
        (d) => {
          exact(d, [
            "releaseRunId",
            "registeredResultCount",
            "publicationAuthorized",
          ]);
          required(
            d.releaseRunId === a.releaseRunId &&
              count(d.registeredResultCount) &&
              d.publicationAuthorized === false,
          );
        },
        options,
      );
    },
    seal(a, options) {
      const body = runArgs(a);
      return write(
        "cmd_final_result_release_seal_v2",
        body,
        (d) => {
          exact(d, [
            "releaseRunId",
            "selectionHash",
            "resultCount",
            "sealed",
            "publicationAuthorized",
          ]);
          required(
            d.releaseRunId === a.releaseRunId &&
              hash(d.selectionHash) &&
              count(d.resultCount) &&
              d.resultCount > 0 &&
              d.sealed === true &&
              d.publicationAuthorized === false,
          );
        },
        options,
      );
    },
    approve(a, options) {
      const body = runArgs(a, [
        "verificationId",
        "approvalId",
        "expectedApprovalId",
        "expiresAt",
        "reason",
      ]);
      required(
        uuid(a.verificationId) &&
          uuid(a.approvalId) &&
          nullableUuid(a.expectedApprovalId) &&
          timestamp(a.expiresAt) &&
          reason(a.reason),
      );
      return write(
        "cmd_final_result_release_approve_v2",
        {
          ...body,
          p_verification_id: a.verificationId,
          p_approval_id: a.approvalId,
          p_expected_approval_id: a.expectedApprovalId,
          p_expires_at: a.expiresAt,
          p_reason: a.reason,
        },
        (d) => {
          exact(d, [
            "approvalId",
            "approvalHash",
            "status",
            "approvedBy",
            "expiresAt",
            "reused",
          ]);
          required(
            d.approvalId === a.approvalId &&
              hash(d.approvalHash) &&
              typeof d.status === "string" &&
              d.approvedBy === transport.actorId &&
              Date.parse(d.expiresAt) === Date.parse(a.expiresAt) &&
              typeof d.reused === "boolean",
          );
        },
        options,
      );
    },
    activate(a, options) {
      const body = runArgs(a, [
        "approvalId",
        "approvalHash",
        "verificationId",
        "idempotencyKey",
        "credentialFingerprint",
      ]);
      required(
        uuid(a.approvalId) &&
          hash(a.approvalHash) &&
          uuid(a.verificationId) &&
          key(a.idempotencyKey) &&
          hash(a.credentialFingerprint),
      );
      return write(
        "cmd_final_result_release_activate_v2",
        {
          ...body,
          p_approval_id: a.approvalId,
          p_approval_hash: a.approvalHash,
          p_verification_id: a.verificationId,
          p_idempotency_key: a.idempotencyKey,
          p_credential_fingerprint: a.credentialFingerprint,
        },
        (d) => {
          exact(d, [
            "publicationId",
            "releaseRunId",
            "releaseVersion",
            "status",
            "isCurrent",
            "publishedAt",
            "reused",
          ]);
          required(
            uuid(d.publicationId) &&
              d.releaseRunId === a.releaseRunId &&
              typeof d.releaseVersion === "string" &&
              typeof d.status === "string" &&
              typeof d.isCurrent === "boolean" &&
              timestamp(d.publishedAt) &&
              typeof d.reused === "boolean",
          );
        },
        options,
      );
    },
  };
}
