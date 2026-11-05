import { fail } from "./common.mjs";
import {
  REGISTRY_VERSION_PLAN,
  REGISTRY_VERSION_POLICY,
  VERSION_PLAN_LIMIT,
  validateResultVersionPlan,
} from "../../result-materialization/lib/registry-version-plan.mjs";

// Advisory, read-only occupancy snapshot. Registration is always the atomic
// authority. No retries after unknown outcomes, no edits to frozen artifacts.
export async function planFinalResultVersions({ inputPlan, createAuthority }) {
  if (
    !inputPlan.content?.length ||
    inputPlan.content.length > VERSION_PLAN_LIMIT
  )
    fail(
      "result_version_plan_budget",
      "Plan at most 10000 exact Results per intake",
    );
  const groups = new Map();
  for (const request of inputPlan.content) {
    const group = groups.get(request.result.uuid) ?? [];
    group.push(request);
    groups.set(request.result.uuid, group);
  }
  const lineage = new Map(
    inputPlan.lineage.results.map((r) => [
      `${r.uuid}@${r.version}`,
      r.relationKind,
    ]),
  );
  const entries = [];
  let calls = 0;
  const authority = await createAuthority();
  try {
    for (const [uuid, requests] of [...groups].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      requests.sort((a, b) => a.result.version.localeCompare(b.result.version));
      const oldest = requests[0].result.version;
      const wanted = new Set(requests.map((r) => r.result.version));
      const occupied = new Map();
      let highest = null;
      let beforeVersion = null;
      do {
        if (++calls > 512)
          fail(
            "result_version_plan_budget",
            "Authority lookup exceeded 512 bounded pages; narrow the intake",
          );
        const page = await authority.versions(uuid, {
          limit: 256,
          beforeVersion,
        });
        if (
          page.resultId !== uuid ||
          !Array.isArray(page.versions) ||
          page.versions.length > 256
        )
          fail(
            "final_input_authority_mismatch",
            "Invalid version authority page",
          );
        let previous = beforeVersion;
        for (const row of page.versions) {
          if (
            !/^\d{2}\.\d{2}\.\d{3}$/u.test(row.version) ||
            (previous !== null && row.version >= previous)
          )
            fail(
              "final_input_authority_mismatch",
              "Version pages must be strictly descending",
            );
          highest ??= row.version;
          previous = row.version;
          if (wanted.has(row.version)) occupied.set(row.version, row);
        }
        if (
          !page.nextBeforeVersion ||
          (previous !== null && previous <= oldest)
        )
          break;
        if (page.nextBeforeVersion !== previous || !page.versions.length)
          fail(
            "final_input_authority_mismatch",
            "Invalid version continuation",
          );
        beforeVersion = page.nextBeforeVersion;
      } while (true);
      let major = Math.max(
        Number((highest ?? "00").slice(0, 2)),
        ...requests.map((r) => Number(r.result.version.slice(0, 2))),
      );
      for (const request of requests) {
        const existing = occupied.get(request.result.version);
        const same =
          existing?.status === "registered" &&
          existing.hashDomain === request.hashDomain &&
          existing.contentHash === request.contentHash;
        const reason = !existing
          ? "unoccupied"
          : same
            ? "same_content"
            : "conflict";
        let toVersion = request.result.version;
        if (reason === "conflict") {
          if (++major > 99)
            fail(
              "dataset_version_overflow",
              "No newer major version remains; review identity semantics before regeneration",
            );
          toVersion = `${String(major).padStart(2, "0")}.00.000`;
        }
        entries.push({
          uuid,
          fromVersion: request.result.version,
          toVersion,
          canonicalContentHash: request.canonicalContentHash,
          contentHash: request.contentHash,
          relationKind: lineage.get(`${uuid}@${request.result.version}`),
          reason,
          highestObservedVersion: highest,
        });
      }
    }
  } finally {
    await authority.close();
  }
  return validateResultVersionPlan({
    schemaVersion: REGISTRY_VERSION_PLAN,
    policy: REGISTRY_VERSION_POLICY,
    inputHash: inputPlan.inputHash,
    entries,
    registrationAuthorized: false,
    publicationAuthorized: false,
  });
}
