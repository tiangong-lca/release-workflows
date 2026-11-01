import { open } from "node:fs/promises";
import { fail } from "./common.mjs";

export const REGISTRY_VERSION_PLAN = "tiangong.release.result-version-plan.v1";
export const REGISTRY_VERSION_POLICY = "conflict-next-major.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const HASH = /^[0-9a-f]{64}$/u;
export const VERSION_PLAN_LIMIT = 10000;
const MAX_BYTES = 8 * 1024 * 1024;

function requireValue(value, code = "result_version_plan_invalid") {
  if (!value)
    fail(
      code,
      "Result version plan must bind exact pre-regeneration content and a strictly newer major version",
    );
}
export function validateResultVersionPlan(plan) {
  requireValue(
    plan?.schemaVersion === REGISTRY_VERSION_PLAN &&
      plan.policy === REGISTRY_VERSION_POLICY &&
      HASH.test(plan.inputHash ?? "") &&
      plan.registrationAuthorized === false &&
      plan.publicationAuthorized === false &&
      Object.keys(plan).length === 6 &&
      Array.isArray(plan.entries) &&
      plan.entries.length > 0 &&
      plan.entries.length <= VERSION_PLAN_LIMIT,
  );
  const seen = new Set();
  const destinations = new Set();
  for (const e of plan.entries) {
    requireValue(
      e &&
        Object.keys(e).length === 8 &&
        UUID.test(e.uuid ?? "") &&
        VERSION.test(e.fromVersion ?? "") &&
        VERSION.test(e.toVersion ?? "") &&
        HASH.test(e.canonicalContentHash ?? "") &&
        HASH.test(e.contentHash ?? "") &&
        ["direct", "derived"].includes(e.relationKind) &&
        ["unoccupied", "same_content", "conflict"].includes(e.reason) &&
        (e.highestObservedVersion === null ||
          VERSION.test(e.highestObservedVersion)),
    );
    if (e.reason === "conflict")
      requireValue(
        e.toVersion.endsWith(".00.000") &&
          e.toVersion > e.fromVersion &&
          (e.highestObservedVersion === null ||
            e.toVersion > e.highestObservedVersion),
      );
    else requireValue(e.toVersion === e.fromVersion);
    const source = `${e.uuid}@${e.fromVersion}`;
    const target = `${e.uuid}@${e.toVersion}`;
    requireValue(!seen.has(source) && !destinations.has(target));
    seen.add(source);
    destinations.add(target);
  }
  return plan;
}
export async function readResultVersionPlan(file) {
  const handle = await open(file, "r");
  try {
    const metadata = await handle.stat();
    requireValue(metadata.isFile() && metadata.size <= MAX_BYTES);
    const bytes = Buffer.alloc(metadata.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    requireValue(offset === metadata.size);
    return validateResultVersionPlan(
      JSON.parse(bytes.subarray(0, offset).toString("utf8")),
    );
  } finally {
    await handle.close();
  }
}

// Invoked before any output directory is written. Render the old proposed
// version again to ensure the recommendation belongs to this exact producer.
export function applyResultVersionPlan(plan, drafts, resolutions, renderHash) {
  if (!plan) return;
  validateResultVersionPlan(plan);
  const entries = new Map(
    plan.entries.map((e) => [`${e.uuid}@${e.fromVersion}`, e]),
  );
  const consumed = new Set();
  const targets = new Set();
  for (const draft of drafts) {
    const resolution = resolutions.get(draft.axis.processIndex);
    const source = `${draft.provisional.uuid}@${resolution.version}`;
    const entry = entries.get(source);
    if (entry) {
      requireValue(
        entry.relationKind === "direct" &&
          renderHash(draft, resolution.version) === entry.canonicalContentHash,
        "result_version_plan_input_drift",
      );
      consumed.add(source);
      if (entry.reason === "conflict")
        resolutions.set(draft.axis.processIndex, {
          ...resolution,
          version: entry.toVersion,
          change: "major",
        });
    }
    const target = `${draft.provisional.uuid}@${resolutions.get(draft.axis.processIndex).version}`;
    requireValue(!targets.has(target), "result_version_plan_collision");
    targets.add(target);
  }
  requireValue(
    consumed.size === entries.size,
    "result_version_plan_scope_mismatch",
  );
}
