import { fail } from "../lib/common.mjs";
import { createFinalResultActorTransport } from "./final-result-actor-transport.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
function required(value, code = "final_actor_contract_invalid") {
  if (!value) fail(code, "Final Result actor request failed");
}
// Read-only admission remains a separate capability from publication commands.
export function createFinalResultActor(config) {
  const transport = createFinalResultActorTransport(config);
  async function call(routine, body, options) {
    const data = await transport.call(routine, body, options);
    required(
      data &&
        data.actorId === transport.actorId &&
        data.releaseRunId === body.p_release_run_id &&
        data.publishPlanHash === body.p_publish_plan_hash &&
        (body.p_runtime_revision === null ||
          data.runtimeRevision === body.p_runtime_revision),
      "final_actor_binding_invalid",
    );
    return data;
  }
  return {
    actorId: transport.actorId,
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
