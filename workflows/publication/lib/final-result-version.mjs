import { fail } from "./common.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
export const VERSION_ERRORS = new Set([
  "final_result_release_version_conflict",
  "final_result_draft_replacement_conflict",
  "final_result_draft_not_replaceable",
]);
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
export function validateFinalResultVersionState(value) {
  const r = value?.occupant;
  if (
    !exact(value, ["releaseVersion", "occupant"]) ||
    typeof value.releaseVersion !== "string" ||
    value.releaseVersion.length > 64 ||
    !/^\d{4}\.\d{2}\.\d+$/u.test(value.releaseVersion) ||
    (r !== null &&
      (!exact(r, [
        "releaseRunId",
        "publishPlanHash",
        "format",
        "status",
        "candidateHash",
        "targetHash",
        "replacesReleaseRunId",
        "replaceable",
      ]) ||
        !UUID.test(r.releaseRunId) ||
        !HASH.test(r.publishPlanHash) ||
        !["legacy-four-zip.v1", "final-result-pair.v2"].includes(r.format) ||
        typeof r.status !== "string" ||
        r.status.length > 32 ||
        ![r.candidateHash, r.targetHash].every(
          (v) => v === null || HASH.test(v),
        ) ||
        !(
          r.replacesReleaseRunId === null || UUID.test(r.replacesReleaseRunId)
        ) ||
        typeof r.replaceable !== "boolean" ||
        (r.replaceable &&
          (r.format !== "final-result-pair.v2" ||
            !["prepared", "ready_for_approval", "failed"].includes(r.status)))))
  )
    fail(
      "final_publication_version_response_invalid",
      "Publication version inspection did not match its bounded contract",
    );
  return structuredClone(value);
}
