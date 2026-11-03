const SPACE_PLACEHOLDER = Object.freeze({
  "@xml:lang": "en",
  "#text": " ",
});

export function normalizeCompatibleProcessDocument(document) {
  const normalized = structuredClone(document);
  const name =
    normalized?.processDataSet?.processInformation?.dataSetInformation?.name;
  for (const field of ["treatmentStandardsRoutes", "mixAndLocationTypes"]) {
    if (name && (!name[field] || name[field].length === 0)) {
      name[field] = [structuredClone(SPACE_PLACEHOLDER)];
    }
  }
  const data = normalized?.processDataSet;
  const information = data?.processInformation?.dataSetInformation;
  for (const [parent, field] of [
    [information, "common:generalComment"],
    [
      data?.processInformation?.technology,
      "technologyDescriptionAndIncludedProcesses",
    ],
    [
      data?.modellingAndValidation?.dataSourcesTreatmentAndRepresentativeness,
      "dataCutOffAndCompletenessPrinciples",
    ],
    [
      data?.administrativeInformation?.["common:commissionerAndGoal"],
      "common:intendedApplications",
    ],
  ]) {
    if (Array.isArray(parent?.[field]) && parent[field].length === 0) {
      parent[field] = [{ "@xml:lang": "en", "#text": "" }];
    }
  }
  const relations = data?.processInformation?.mathematicalRelations;
  const parameter = relations?.variableParameter;
  if (parameter && typeof parameter === "object" && !Array.isArray(parameter)) {
    const keys = Object.keys(parameter);
    if (keys.length === 0) {
      delete relations.variableParameter;
    } else if (
      keys.length === 1 &&
      keys[0] === "comment" &&
      isText(parameter.comment) &&
      isText(information?.["common:generalComment"])
    ) {
      information["common:generalComment"] = appendProcessComments(
        information["common:generalComment"],
        parameter.comment,
      );
      delete relations.variableParameter;
    }
  }
  return normalized;
}

// Preserve the original entries and order; schema validation still owns validity.
export function appendProcessComments(existing, added) {
  return structuredClone([
    ...(Array.isArray(existing) ? existing : [existing]),
    ...(Array.isArray(added) ? added : [added]),
  ]);
}

function isText(value) {
  const entries = Array.isArray(value) ? value : [value];
  return (
    entries.length > 0 &&
    entries.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry["@xml:lang"] === "string" &&
        typeof entry["#text"] === "string",
    )
  );
}
