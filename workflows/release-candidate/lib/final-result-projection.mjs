import { canonicalJson, fail, hashJson } from "./common.mjs";

export const FINAL_RESULT_PROJECTION = "tiangong.final-result-projection.v1";
export const FINAL_RESULT_HASH_DOMAIN = "tiangong.final-result-content.jcs.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const ROOTS = {
  flow: ["flowDataSet", "flowInformation"],
  flowproperty: ["flowPropertyDataSet", "flowPropertiesInformation"],
  unitgroup: ["unitGroupDataSet", "unitGroupInformation"],
  lciamethod: ["LCIAMethodDataSet", "LCIAMethodInformation"],
};

// No transport or mutable-data lookup is allowed here. Callers supply documents
// whose bytes have already been checked against the frozen canonical index.
const verifiedDependencies = new WeakSet();
function freezeOwned(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

// Verify complete documents once, retaining only Method metadata consumed by
// projection. The full canonical hash still binds all characterisation factors.
export function createFrozenDependencyStore() {
  const entries = new Map();
  const add = (record) => {
    const key = identityKey(record.datasetType, record.uuid, record.version);
    requireValue(!entries.has(key), "duplicate_dependency", key);
    requireValue(ROOTS[record.datasetType], "unsupported_dependency", key);
    const [rootName, infoName] = ROOTS[record.datasetType];
    const root = record.document?.[rootName];
    const info = root?.[infoName] ?? root?.methodInformation;
    requireValue(
      info?.dataSetInformation?.["common:UUID"]?.toLowerCase() ===
        record.uuid.toLowerCase() &&
        root?.administrativeInformation?.publicationAndOwnership?.[
          "common:dataSetVersion"
        ] === record.version,
      "dependency_identity_mismatch",
      key,
    );
    const contentHash = hashJson(record.document);
    requireValue(
      contentHash === record.canonicalContentHash,
      "dependency_hash_mismatch",
      key,
    );
    const document =
      record.datasetType === "lciamethod"
        ? {
            LCIAMethodDataSet: {
              LCIAMethodInformation: {
                dataSetInformation: {
                  "common:UUID": info.dataSetInformation["common:UUID"],
                  "common:name": info.dataSetInformation["common:name"],
                },
                quantitativeReference: info.quantitativeReference,
              },
            },
          }
        : record.document;
    const entry = freezeOwned({
      document: structuredClone(document),
      key,
      contentHash,
    });
    verifiedDependencies.add(entry);
    entries.set(key, entry);
    return Buffer.byteLength(canonicalJson(entry));
  };
  const resolve = (kind, reference) => {
    const key = identityKey(
      kind,
      reference?.["@refObjectId"],
      reference?.["@version"],
    );
    const entry = entries.get(key);
    requireValue(entry, "dependency_missing", key);
    return entry;
  };
  return { add, resolve };
}

export function createFrozenDependencyResolver(records) {
  const store = createFrozenDependencyStore();
  for (const record of records) store.add(record);
  return store.resolve;
}

// Method factor closure can contain many Flows absent from every final Result.
// Validate that closure in callers, but retain only the projection's Flow set.
export async function collectProjectionFlowKeys(index, readDocument) {
  const keys = new Set();
  for (const entry of index.datasets ?? []) {
    if (entry.role !== "result_process") continue;
    const document = await readDocument(entry);
    for (const exchange of array(
      document?.processDataSet?.exchanges?.exchange,
    )) {
      const ref = exchange.referenceToFlowDataSet;
      keys.add(identityKey("flow", ref?.["@refObjectId"], ref?.["@version"]));
    }
  }
  return keys;
}

/** Numeric export of a single final Result; never normalizes or solves values. */
export function projectFinalResult({
  document,
  identity,
  layer,
  expectedMethods,
  resolveDependency,
}) {
  requireValue(["lci", "lci-lcia"].includes(layer), "invalid_layer");
  requireValue(Array.isArray(expectedMethods), "expected_methods_required");
  requireValue(
    typeof resolveDependency === "function",
    "dependency_resolver_required",
  );
  const key = identityKey("process", identity?.uuid, identity?.version);
  const process = document?.processDataSet;
  requireValue(
    process?.processInformation?.dataSetInformation?.[
      "common:UUID"
    ]?.toLowerCase() === identity.uuid.toLowerCase() &&
      process?.administrativeInformation?.publicationAndOwnership?.[
        "common:dataSetVersion"
      ] === identity.version &&
      process?.modellingAndValidation?.LCIMethodAndAllocation?.typeOfDataSet ===
        "LCI result",
    "result_identity_or_type_mismatch",
    key,
  );
  const canonicalContentHash = hashJson(document);
  requireValue(
    canonicalContentHash === identity.canonicalContentHash,
    "result_hash_mismatch",
    key,
  );
  const dependencies = new Map();
  const resolve = (kind, reference) => {
    const entry = resolveDependency(kind, reference);
    const expectedKey = identityKey(
      kind,
      reference?.["@refObjectId"],
      reference?.["@version"],
    );
    requireValue(
      entry?.key === expectedKey &&
        (verifiedDependencies.has(entry) ||
          hashJson(entry.document) === entry.contentHash),
      "dependency_binding_mismatch",
      expectedKey,
    );
    const previous = dependencies.get(expectedKey);
    requireValue(
      !previous || previous === entry.contentHash,
      "dependency_drift",
      expectedKey,
    );
    dependencies.set(expectedKey, entry.contentHash);
    return entry.document;
  };
  const exchanges = array(process?.exchanges?.exchange);
  const referenceId = scalarId(
    process?.processInformation?.quantitativeReference
      ?.referenceToReferenceFlow,
  );
  const ids = new Set();
  const inventoryKeys = new Set();
  const inventory = [];
  let quantitativeReference;
  for (const exchange of exchanges) {
    const internalId = scalarId(exchange?.["@dataSetInternalID"]);
    requireValue(!ids.has(internalId), "duplicate_exchange_id", internalId);
    ids.add(internalId);
    requireValue(
      ["Input", "Output"].includes(exchange.exchangeDirection),
      "invalid_direction",
      internalId,
    );
    requireValue(
      !exchange.referenceToVariable && !exchange.allocations,
      "unresolved_exchange_semantics",
      internalId,
    );
    const value = finite(exchange.resultingAmount, "resultingAmount");
    const flowRef = exchange.referenceToFlowDataSet;
    const flow = resolve("flow", flowRef).flowDataSet;
    const unit = flowUnit(flow, resolve);
    const row = {
      flowName: localizedText(
        flow.flowInformation?.dataSetInformation?.name?.baseName,
      ),
      flowClassification: structuredClone(
        flow.flowInformation?.dataSetInformation?.classificationInformation ??
          null,
      ),
      flowId: flowRef["@refObjectId"].toLowerCase(),
      flowVersion: flowRef["@version"],
      direction: exchange.exchangeDirection,
      location: optionalText(exchange.location),
      functionType: optionalText(exchange.functionType),
      unit,
      value,
      amountField: "resultingAmount",
    };
    if (internalId === referenceId) {
      requireValue(value !== 0, "zero_reference");
      quantitativeReference = row;
    } else {
      requireValue(
        flow.modellingAndValidation?.LCIMethod?.typeOfDataSet ===
          "Elementary flow",
        "non_elementary_inventory",
        internalId,
      );
      const itemKey = inventoryKey(row);
      requireValue(
        !inventoryKeys.has(itemKey),
        "duplicate_inventory_key",
        internalId,
      );
      inventoryKeys.add(itemKey);
      inventory.push(row);
    }
  }
  requireValue(quantitativeReference, "reference_exchange_missing");
  const expected = expectedMethods
    .map((method) => identityKey("lciamethod", method.uuid, method.version))
    .sort();
  requireValue(
    new Set(expected).size === expected.length,
    "duplicate_expected_method",
  );
  requireValue(
    layer === "lci" ? expected.length === 0 : expected.length > 0,
    "layer_method_mismatch",
  );
  const impacts = array(process.LCIAResults?.LCIAResult)
    .map((result) => {
      const ref = result.referenceToLCIAMethodDataSet;
      const methodKey = identityKey(
        "lciamethod",
        ref?.["@refObjectId"],
        ref?.["@version"],
      );
      const method = resolve("lciamethod", ref).LCIAMethodDataSet;
      const info = method.LCIAMethodInformation ?? method.methodInformation;
      const quantity = info?.quantitativeReference?.referenceQuantity;
      requireValue(
        quantity?.["@type"] === "flow property data set",
        "invalid_impact_quantity",
        methodKey,
      );
      // The label is e.g. kg CO2 equivalents, not the generic property's kg.
      const unit = localizedText(quantity["common:shortDescription"]);
      propertyUnit(quantity, resolve);
      return {
        key: methodKey,
        id: ref["@refObjectId"].toLowerCase(),
        version: ref["@version"],
        name: localizedText(info?.dataSetInformation?.["common:name"]),
        unit,
        value: finite(result.meanAmount, "LCIA.meanAmount"),
      };
    })
    .sort((a, b) => compare(a.key, b.key));
  requireValue(
    JSON.stringify(impacts.map((value) => value.key)) ===
      JSON.stringify(expected),
    "impact_set_mismatch",
  );
  inventory.sort((a, b) => compare(inventoryKey(a), inventoryKey(b)));
  const semanticDependencies = [...dependencies]
    .sort(([a], [b]) => compare(a, b))
    .map(([dependencyKey, contentHash]) => ({
      key: dependencyKey,
      contentHash,
    }));
  const result = {
    schemaVersion: FINAL_RESULT_PROJECTION,
    identity: { uuid: identity.uuid.toLowerCase(), version: identity.version },
    canonicalContentHash,
    hashDomain: FINAL_RESULT_HASH_DOMAIN,
    semanticDependencies,
    layer,
    quantitativeReference,
    inventory,
    impacts,
  };
  result.contentHash = hashJson({
    hashDomain: FINAL_RESULT_HASH_DOMAIN,
    canonicalContentHash,
    semanticDependencies,
  });
  return result;
}

export function inventoryKey(row) {
  return JSON.stringify([
    row.flowId,
    row.flowVersion,
    row.direction,
    row.location,
    row.functionType,
    row.unit.flowPropertyId,
    row.unit.flowPropertyVersion,
    row.unit.unitGroupId,
    row.unit.unitGroupVersion,
    row.unit.internalId,
    row.unit.name,
  ]);
}

function flowUnit(flow, resolve) {
  const propertyId = scalarId(
    flow.flowInformation?.quantitativeReference
      ?.referenceToReferenceFlowProperty,
  );
  const property = exactlyOne(
    array(flow.flowProperties?.flowProperty),
    propertyId,
  );
  requireValue(
    finite(property.meanValue, "reference property meanValue") === 1,
    "nonunit_reference_property",
  );
  return propertyUnit(property.referenceToFlowPropertyDataSet, resolve);
}

function propertyUnit(ref, resolve) {
  const document = resolve("flowproperty", ref).flowPropertyDataSet;
  const groupRef =
    document.flowPropertiesInformation?.quantitativeReference
      ?.referenceToReferenceUnitGroup;
  const group = resolve("unitgroup", groupRef).unitGroupDataSet;
  const unitId = scalarId(
    group.unitGroupInformation?.quantitativeReference?.referenceToReferenceUnit,
  );
  const unit = exactlyOne(array(group.units?.unit), unitId);
  requireValue(
    finite(unit.meanValue, "reference unit meanValue") === 1,
    "nonunit_reference_unit",
  );
  return {
    flowPropertyId: ref["@refObjectId"].toLowerCase(),
    flowPropertyVersion: ref["@version"],
    unitGroupId: groupRef["@refObjectId"].toLowerCase(),
    unitGroupVersion: groupRef["@version"],
    internalId: unitId,
    name: localizedText(unit.name),
  };
}

function exactlyOne(items, id) {
  const ids = items.map((item) => scalarId(item?.["@dataSetInternalID"]));
  requireValue(new Set(ids).size === ids.length, "duplicate_internal_id");
  const matches = items.filter((item) => item["@dataSetInternalID"] === id);
  requireValue(matches.length === 1, "reference_target_missing", id);
  return matches[0];
}
function identityKey(kind, uuid, version) {
  requireValue(
    typeof uuid === "string" &&
      UUID.test(uuid) &&
      typeof version === "string" &&
      VERSION.test(version),
    "invalid_exact_identity",
  );
  return `${kind}:${uuid.toLowerCase()}@${version}`;
}
function scalarId(value) {
  requireValue(
    typeof value === "string" && /^\d+$/u.test(value),
    "invalid_internal_id",
  );
  return value;
}
function finite(value, field) {
  requireValue(
    typeof value === "number" ||
      (typeof value === "string" &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)),
    "invalid_final_amount",
    field,
  );
  const number = Number(value);
  requireValue(Number.isFinite(number), "invalid_final_amount", field);
  // Underflow must not silently discard a small nonzero inventory item.
  requireValue(
    number !== 0 || !/[1-9]/u.test(String(value).split(/[eE]/u)[0]),
    "amount_underflow",
    field,
  );
  return Object.is(number, -0) ? 0 : number;
}
function optionalText(value) {
  requireValue(
    value === undefined || typeof value === "string",
    "invalid_semantic_dimension",
  );
  return value ?? null;
}
function localizedText(value) {
  const values = array(value);
  const selected =
    values.find((entry) => entry?.["@xml:lang"] === "en") ?? values[0];
  const text = typeof selected === "string" ? selected : selected?.["#text"];
  requireValue(
    typeof text === "string" && text.trim().length > 0,
    "missing_label",
  );
  return text;
}
function array(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function requireValue(value, code, detail = "") {
  if (!value)
    fail(`final_result_${code}`, `Final Result projection rejected: ${code}`, {
      detail,
    });
}
