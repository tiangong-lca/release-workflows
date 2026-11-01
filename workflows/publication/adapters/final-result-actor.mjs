import { fail } from "../lib/common.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const MAX_RESPONSE = 2 * 1024 ** 2;
const DENIALS = new Set([
  "auth_required",
  "not_data_product_manager",
  "final_result_release_not_found",
  "final_result_selection_not_ready",
  "final_result_runtime_unavailable",
  "expected_current_conflict",
  "runtime_revision_conflict",
  "final_result_probe_not_available",
]);
function required(value, code = "final_actor_contract_invalid") {
  if (!value) fail(code, "Final Result actor request failed");
}
function claims(token) {
  try {
    required(
      typeof token === "string" &&
        token.length <= 16384 &&
        token.split(".").length === 3,
    );
    return JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
  } catch {
    required(false, "final_actor_session_required");
  }
}

// Actor-only, read-only admission. JWT decoding rejects obvious wrong credential
// classes; it never establishes authority. Every RPC authenticates server-side
// and checks the live manager grant and immutable release context again.
export function createFinalResultActor({
  endpoint,
  publishableKey,
  accessToken,
  timeoutMs = 30000,
}) {
  let origin;
  try {
    origin = new URL(endpoint);
  } catch {
    required(false);
  }
  required(
    !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      origin.pathname === "/" &&
      (origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(origin.hostname))),
  );
  required(
    typeof publishableKey === "string" &&
      publishableKey.length >= 1 &&
      publishableKey.length <= 16384 &&
      !publishableKey.startsWith("sb_secret_") &&
      !/[\r\n]/u.test(publishableKey),
  );
  if (publishableKey.split(".").length === 3)
    required(
      claims(publishableKey)?.role === "anon",
      "final_actor_session_required",
    );
  const actor = claims(accessToken);
  required(
    actor?.role === "authenticated" &&
      UUID.test(actor.sub ?? "") &&
      Number.isFinite(actor.exp),
    "final_actor_session_required",
  );
  required(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000,
  );
  async function call(routine, body, { signal } = {}) {
    required(actor.exp > Date.now() / 1000, "final_actor_session_expired");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const response = await fetch(new URL(`/rest/v1/rpc/${routine}`, origin), {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: {
          apikey: publishableKey,
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Profile": "api",
        },
        body: JSON.stringify(body),
      });
      required(
        response.headers.get("content-type")?.split(";")[0].trim() ===
          "application/json",
        "final_actor_response_invalid",
      );
      const declared = response.headers.get("content-length");
      required(
        declared === null ||
          (/^\d+$/u.test(declared) && Number(declared) <= MAX_RESPONSE),
        "final_actor_response_budget",
      );
      required(response.body, "final_actor_response_invalid");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        required(size <= MAX_RESPONSE, "final_actor_response_budget");
        chunks.push(chunk);
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        required(false, "final_actor_response_invalid");
      }
      if (!response.ok || payload?.ok !== true) {
        fail("final_actor_request_denied", "Actor admission did not succeed", {
          httpStatus: response.status,
          semanticCode: DENIALS.has(payload?.code) ? payload.code : null,
        });
      }
      required(
        payload.data &&
          typeof payload.data === "object" &&
          !Array.isArray(payload.data),
        "final_actor_response_invalid",
      );
      const data = payload.data;
      required(
        data.actorId === actor.sub &&
          data.releaseRunId === body.p_release_run_id &&
          data.publishPlanHash === body.p_publish_plan_hash &&
          (body.p_runtime_revision === null ||
            data.runtimeRevision === body.p_runtime_revision),
        "final_actor_binding_invalid",
      );
      return data;
    } catch (error) {
      if (
        typeof error.code === "string" &&
        error.code.startsWith("final_actor_")
      )
        throw error;
      fail(
        "final_actor_unavailable",
        "Actor admission transport is unavailable",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return {
    actorId: actor.sub,
    probePage(
      {
        releaseRunId,
        publishPlanHash,
        runtimeRevision = null,
        afterArtifactId = null,
        limit = 100,
      },
      options,
    ) {
      required(
        UUID.test(releaseRunId ?? "") &&
          HASH.test(publishPlanHash ?? "") &&
          (runtimeRevision === null || UUID.test(runtimeRevision)) &&
          (afterArtifactId === null ||
            (UUID.test(afterArtifactId) && runtimeRevision !== null)) &&
          Number.isSafeInteger(limit) &&
          limit >= 1 &&
          limit <= 100,
      );
      return call(
        "qry_final_result_release_probe_page_v2",
        {
          p_release_run_id: releaseRunId,
          p_publish_plan_hash: publishPlanHash,
          p_runtime_revision: runtimeRevision,
          p_after_artifact_id: afterArtifactId,
          p_limit: limit,
        },
        options,
      );
    },
    probe({ releaseRunId, publishPlanHash, runtimeRevision, result }, options) {
      required(
        UUID.test(releaseRunId ?? "") &&
          HASH.test(publishPlanHash ?? "") &&
          UUID.test(runtimeRevision ?? "") &&
          result &&
          Object.keys(result).length === 2 &&
          UUID.test(result.uuid ?? "") &&
          VERSION.test(result.version ?? ""),
      );
      return call(
        "qry_final_result_release_probe_v2",
        {
          p_release_run_id: releaseRunId,
          p_publish_plan_hash: publishPlanHash,
          p_runtime_revision: runtimeRevision,
          p_result_id: result.uuid,
          p_result_version: result.version,
        },
        options,
      );
    },
  };
}
