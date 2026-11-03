import { ProcessSchema } from "@tiangong-lca/tidas-sdk";
import { fail, nearlyEqual } from "./common.mjs";
import { resultIdentity, RESULT_PROFILES } from "./identity.mjs";
import { sourceKey } from "./context.mjs";
import { globalReference, suffixName } from "./references.mjs";
import {
  appendProcessComments,
  normalizeCompatibleProcessDocument,
} from "./process-compat.mjs";

export function renderResultProcess(
  context,
  axis,
  version,
  resultProcessLayer = "lci-lcia",
) {
  const profile = RESULT_PROFILES[resultProcessLayer];
  if (!profile)
    fail(
      "unsupported_result_process_layer",
      `Unsupported Result Process layer: ${resultProcessLayer}`,
    );
  const source = context.sources.get(
    sourceKey("process", axis.rootProcess.id, axis.rootProcess.version),
  );
  if (!source || source.role !== "unit_process") {
    fail(
      "unit_process_missing",
      `Exact source Unit Process is missing: ${axis.rootProcess.id}@${axis.rootProcess.version}`,
    );
  }
  const sourceDocument = normalizeCompatibleProcessDocument(source.document);
  const sourceValidation = ProcessSchema.safeParse(sourceDocument);
  if (!sourceValidation.success) {
    fail(
      "source_tidas_validation_failed",
      "Source Unit Process failed pinned tidas-sdk validation",
      {
        issues: sourceValidation.error.issues,
      },
    );
  }
  const referenceExchange = projectReferenceExchange(sourceDocument, axis);
  const identity = resultIdentity(
    axis.rootProcess.id,
    axis.quantitativeReference.flow.id,
  );
  const result = structuredClone(sourceDocument);
  const data = result.processDataSet;
  data.processInformation.dataSetInformation["common:UUID"] = identity.uuid;
  const resultLabel =
    resultProcessLayer === "lci"
      ? "aggregated LCI result"
      : "aggregated LCI/LCIA result";
  data.processInformation.dataSetInformation.name = suffixName(
    data.processInformation.dataSetInformation.name,
    resultLabel,
  );
  data.processInformation.dataSetInformation["common:generalComment"] =
    appendProcessComments(
      data.processInformation.dataSetInformation["common:generalComment"],
      {
        "@xml:lang": "en",
        "#text": `${resultLabel} generated for ${axis.rootProcess.id}@${axis.rootProcess.version} under calculation ${context.intake.source.calculationId}.`,
      },
    );
  data.modellingAndValidation.LCIMethodAndAllocation.typeOfDataSet =
    "LCI result";
  const publication = data.administrativeInformation.publicationAndOwnership;
  publication["common:dataSetVersion"] = version;
  publication["common:permanentDataSetURI"] =
    `https://lcdn.tiangong.earth/datasetdetail/process.xhtml?uuid=${identity.uuid}&version=${version}`;
  publication["common:workflowAndPublicationStatus"] = "Working draft";

  data.processInformation.quantitativeReference.referenceToReferenceFlow = "0";
  const lci = [...(context.lci.get(axis.processIndex) ?? [])].sort(
    compareInventory,
  );
  const inventory = lci
    .filter(
      (record) =>
        !(
          record.flow.id.toLowerCase() ===
            axis.quantitativeReference.flow.id.toLowerCase() &&
          normalizeDirection(record.direction) ===
            axis.referencePivot.rawDirection
        ),
    )
    .map((record, index) => ({
      "@dataSetInternalID": String(index + 1),
      referenceToFlowDataSet: supportReference(context, "flow", record.flow),
      ...(record.location ? { location: record.location } : {}),
      exchangeDirection: normalizeDirection(record.direction),
      meanAmount: finiteString(record.meanAmount, "lci.meanAmount"),
      resultingAmount: finiteString(record.meanAmount, "lci.meanAmount"),
      dataDerivationTypeStatus: "Calculated",
    }));
  data.exchanges = { exchange: [referenceExchange, ...inventory] };
  const lcia =
    resultProcessLayer === "lci-lcia"
      ? [...(context.lcia.get(axis.processIndex) ?? [])].sort(compareLcia)
      : [];
  if (lcia.length) {
    data.LCIAResults = {
      LCIAResult: lcia.map((record) => ({
        referenceToLCIAMethodDataSet: supportReference(
          context,
          "lciamethod",
          record.method,
        ),
        meanAmount: finiteString(record.meanAmount, "lcia.meanAmount"),
      })),
    };
  } else delete data.LCIAResults;

  validateGeneratedProcessReferences(result);
  const validation = ProcessSchema.safeParse(result);
  if (!validation.success) {
    fail(
      "tidas_schema_validation_failed",
      "Generated Result Process failed tidas-sdk validation",
      {
        issues: validation.error.issues,
      },
    );
  }
  return {
    datasetType: "process",
    role: "result_process",
    processIndex: axis.processIndex,
    uuid: identity.uuid,
    version,
    profile,
    identity: identity.evidence,
    sourceProcess: structuredClone(axis.rootProcess),
    referencePivot: structuredClone(axis.referencePivot),
    document: result,
    counts: { lci: lci.length, lcia: lcia.length },
  };
}

function projectReferenceExchange(unitProcess, axis) {
  const data = unitProcess.processDataSet;
  const internalId = String(
    data.processInformation.quantitativeReference.referenceToReferenceFlow,
  );
  const exchanges = data.exchanges.exchange.filter(
    (exchange) => String(exchange["@dataSetInternalID"]) === internalId,
  );
  if (exchanges.length !== 1) {
    fail(
      "invalid_quantitative_reference",
      "Reference exchange must resolve exactly once",
    );
  }
  const exchange = exchanges[0];
  const flow = exchange.referenceToFlowDataSet;
  if (
    !Number.isFinite(Number(exchange.meanAmount)) ||
    Number(exchange.meanAmount) === 0 ||
    normalizeDirection(exchange.exchangeDirection) !==
      axis.referencePivot.rawDirection ||
    !nearlyEqual(
      Number(exchange.meanAmount),
      axis.referencePivot.rawMeanAmount,
    ) ||
    flow?.["@refObjectId"]?.toLowerCase() !==
      axis.quantitativeReference.flow.id.toLowerCase() ||
    flow?.["@version"] !== axis.quantitativeReference.flow.version
  ) {
    fail(
      "invalid_quantitative_reference",
      "Source reference exchange does not match the Calculation Bundle axis",
    );
  }
  const meanAmount = finiteString(
    axis.referencePivot.normalizedMeanAmount,
    "quantitativeReference.normalizedMeanAmount",
  );
  return {
    "@dataSetInternalID": "0",
    referenceToFlowDataSet: structuredClone(flow),
    ...(exchange.location
      ? { location: structuredClone(exchange.location) }
      : {}),
    exchangeDirection: axis.referencePivot.rawDirection,
    meanAmount,
    resultingAmount: meanAmount,
    dataDerivationTypeStatus: "Calculated",
  };
}

export function validateGeneratedProcessReferences(document) {
  const data = document?.processDataSet;
  const exchanges = asArray(data?.exchanges?.exchange);
  const ids = new Set();
  for (const exchange of exchanges) {
    const id = String(exchange?.["@dataSetInternalID"] ?? "");
    if (!id || ids.has(id))
      fail(
        "generated_process_internal_reference_invalid",
        "Generated Result Process exchange IDs must be present and unique",
        { kind: "exchange_id", internalId: id || null },
      );
    ids.add(id);
  }

  const quantitativeReference = String(
    data?.processInformation?.quantitativeReference?.referenceToReferenceFlow ??
      "",
  );
  if (!quantitativeReference || !ids.has(quantitativeReference))
    fail(
      "generated_process_internal_reference_invalid",
      "Generated Result Process quantitative reference does not resolve",
      {
        kind: "quantitative_reference",
        internalReference: quantitativeReference || null,
      },
    );

  const variableNames = new Set(
    asArray(data?.processInformation?.mathematicalRelations?.variableParameter)
      .map((parameter) => parameter?.["@name"])
      .filter((name) => typeof name === "string" && name.length > 0),
  );
  for (const exchange of exchanges) {
    const exchangeId = String(exchange["@dataSetInternalID"]);
    for (const allocation of asArray(exchange.allocations?.allocation)) {
      const coProduct = String(
        allocation?.["@internalReferenceToCoProduct"] ?? "",
      );
      if (!coProduct || !ids.has(coProduct))
        fail(
          "generated_process_internal_reference_invalid",
          "Generated Result Process allocation references a missing co-product exchange",
          {
            kind: "allocation_coproduct",
            exchangeInternalId: exchangeId,
            internalReference: coProduct || null,
          },
        );
    }
    for (const variableReference of asArray(exchange.referenceToVariable)) {
      const variableName = String(variableReference ?? "");
      if (!variableName || !variableNames.has(variableName))
        fail(
          "generated_process_internal_reference_invalid",
          "Generated Result Process exchange references a missing variable parameter",
          {
            kind: "variable_parameter",
            exchangeInternalId: exchangeId,
            variableReference: variableName || null,
          },
        );
    }
  }
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function supportReference(context, datasetType, identity) {
  const source = context.sources.get(
    sourceKey(datasetType, identity.id, identity.version),
  );
  if (!source) {
    fail(
      "support_dataset_missing",
      `Support dataset missing: ${datasetType}:${identity.id}@${identity.version}`,
    );
  }
  const category = datasetType === "flow" ? "flows" : "lciamethods";
  return globalReference({
    type: datasetType === "flow" ? "flow data set" : "LCIA method data set",
    category,
    uuid: identity.id,
    version: identity.version,
    description:
      datasetType === "flow"
        ? "Aggregated inventory flow"
        : "LCIA method result",
  });
}

function finiteString(value, field) {
  if (!Number.isFinite(Number(value)))
    fail("non_finite_result", `Non-finite ${field}`);
  return String(value);
}

function normalizeDirection(direction) {
  const normalized = String(direction).toLowerCase();
  if (normalized === "input") return "Input";
  if (normalized === "output") return "Output";
  fail("invalid_lci_direction", `Unsupported LCI direction: ${direction}`);
}

function compareInventory(left, right) {
  return [
    left.flow.id,
    left.flow.version,
    left.direction,
    left.unit,
    left.location ?? "",
  ]
    .join("|")
    .localeCompare(
      [
        right.flow.id,
        right.flow.version,
        right.direction,
        right.unit,
        right.location ?? "",
      ].join("|"),
    );
}

function compareLcia(left, right) {
  return [left.method.id, left.method.version]
    .join("|")
    .localeCompare([right.method.id, right.method.version].join("|"));
}
