import { fail } from "./common.mjs";

export const MAX_METADATA_BYTES = 128 * 1024 * 1024;
// Identity plans repeat per-Result semantic dependency claims; query indexes do not.
export const MAX_INPUT_PLAN_BYTES = 512 * 1024 * 1024;
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_METHOD_BYTES = 64 * 1024 * 1024;

export function documentBudget(entry) {
  return entry.datasetType === "lciamethod"
    ? MAX_METHOD_BYTES
    : MAX_RECORD_BYTES;
}

export function checkBudget(kind, actualBytes, limitBytes, entry = {}, count) {
  if (actualBytes <= limitBytes) return;
  fail(
    `canonical_${kind}_budget`,
    `Canonical ${kind} exceeds its byte budget`,
    {
      budget: {
        kind,
        actualBytes,
        limitBytes,
        ...(entry.path ? { path: entry.path } : {}),
        ...(entry.datasetType ? { datasetType: entry.datasetType } : {}),
        ...(entry.uuid ? { uuid: entry.uuid, version: entry.version } : {}),
        ...(count !== undefined ? { entryCount: count } : {}),
        recovery:
          "Inspect this exact input and the documented resource policy; retry in a new output directory after resolving capacity. Do not exclude data or alter frozen files to bypass the limit.",
      },
    },
  );
}

// Only resource diagnostics produced by this module may cross the CLI boundary.
export function budgetDetails(error) {
  const value = error.details?.budget;
  if (
    ![
      "canonical_document_budget",
      "canonical_metadata_budget",
      "canonical_input_plan_budget",
    ].includes(error.code) ||
    !value ||
    !["document", "metadata", "input_plan"].includes(value.kind) ||
    !Number.isSafeInteger(value.actualBytes) ||
    !Number.isSafeInteger(value.limitBytes)
  )
    return {};
  const budget = {
    kind: value.kind,
    actualBytes: value.actualBytes,
    limitBytes: value.limitBytes,
  };
  for (const field of ["path", "datasetType", "uuid", "version", "recovery"])
    if (typeof value[field] === "string" && value[field].length <= 1024)
      budget[field] = value[field];
  if (Number.isSafeInteger(value.entryCount))
    budget.entryCount = value.entryCount;
  return { budget };
}
