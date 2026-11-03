import { LifeCycleModelSchema, ProcessSchema } from "@tiangong-lca/tidas-sdk";
import { fail } from "./common.mjs";
import { sourceKey } from "./context.mjs";
import { modelIdentity, MODEL_PROFILE } from "./identity.mjs";
import { globalReference, suffixName } from "./references.mjs";
import { validateOneHopReconstruction } from "./reconstruction.mjs";
import {
  appendProcessComments,
  normalizeCompatibleProcessDocument,
} from "./process-compat.mjs";

export function renderLifecycleModel(context, axis, resultCatalog, version) {
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
  const resultByProcessIndex = new Map(
    resultCatalog.datasets.map((dataset) => [dataset.processIndex, dataset]),
  );
  const ownResult = resultByProcessIndex.get(axis.processIndex);
  if (!ownResult)
    fail(
      "result_catalog_incomplete",
      `Missing R(P) for process index ${axis.processIndex}`,
    );
  const identity = modelIdentity(
    axis.rootProcess.id,
    axis.quantitativeReference.flow.id,
  );
  const sourceData = sourceDocument.processDataSet;
  const directEdges = context.technosphereEdges
    .filter((edge) => edge.dependentProcessIndex === axis.processIndex)
    .sort(compareEdges);
  const reconstruction = validateOneHopReconstruction(
    context,
    axis.processIndex,
  );
  const processInstances = [
    {
      "@dataSetInternalID": "0",
      "@multiplicationFactor": finiteString(
        axis.referencePivot.normalizationScale,
        "quantitativeReference.normalizationScale",
      ),
      referenceToProcess: globalReference({
        type: "process data set",
        category: "processes",
        uuid: axis.rootProcess.id,
        version: axis.rootProcess.version,
        description: "Root Unit Process",
      }),
    },
  ];
  directEdges.forEach((edge, index) => {
    const provider = resultByProcessIndex.get(edge.balancingProcessIndex);
    if (!provider) {
      fail(
        "result_catalog_incomplete",
        `Missing provider R(Q) for process index ${edge.balancingProcessIndex}`,
      );
    }
    processInstances.push({
      "@dataSetInternalID": String(index + 1),
      "@multiplicationFactor": finiteString(
        edge.activityRequirement,
        "activityRequirement",
      ),
      referenceToProcess: globalReference({
        type: "process data set",
        category: "processes",
        uuid: provider.uuid,
        version: provider.version,
        description: "Provider aggregated Result Process",
      }),
      connections: {
        outputExchange: {
          "@flowUUID": edge.flow.id,
          "@version": edge.flow.version,
          downstreamProcess: {
            "@id": "0",
            "@flowUUID": edge.flow.id,
            "@version": edge.flow.version,
            ...(edge.location ? { "@location": edge.location } : {}),
          },
        },
      },
    });
  });
  const document = {
    lifeCycleModelDataSet: {
      "@xmlns": "http://eplca.jrc.ec.europa.eu/ILCD/LifeCycleModel/2017",
      "@xmlns:acme": "http://acme.com/custom",
      "@xmlns:common": "http://lca.jrc.it/ILCD/Common",
      "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@locations": "../ILCDLocations.xml",
      "@version": "1.1",
      "@xsi:schemaLocation":
        "http://eplca.jrc.ec.europa.eu/ILCD/LifeCycleModel/2017 ../../schemas/ILCD_LifeCycleModelDataSet.xsd",
      lifeCycleModelInformation: {
        dataSetInformation: {
          "common:UUID": identity.uuid,
          name: suffixName(
            sourceData.processInformation.dataSetInformation.name,
            "generated resolved one-hop lifecycle model",
          ),
          classificationInformation: structuredClone(
            sourceData.processInformation.dataSetInformation
              .classificationInformation,
          ),
          referenceToResultingProcess: globalReference({
            type: "process data set",
            category: "processes",
            uuid: ownResult.uuid,
            version: ownResult.version,
            description: "Generated aggregated Result Process",
          }),
          "common:generalComment": appendProcessComments(
            sourceData.processInformation.dataSetInformation[
              "common:generalComment"
            ],
            {
              "@xml:lang": "en",
              "#text":
                "Deterministically generated resolved one-hop model from a frozen Unit Process, direct provider edges, and Result Catalog.",
            },
          ),
        },
        quantitativeReference: { referenceToReferenceProcess: 0 },
        technology: { processes: { processInstance: processInstances } },
      },
      modellingAndValidation: modelValidation(sourceData),
      administrativeInformation: modelAdministrative(
        sourceData,
        identity.uuid,
        version,
      ),
    },
  };
  const validation = LifeCycleModelSchema.safeParse(document);
  if (!validation.success) {
    fail(
      "tidas_model_validation_failed",
      "Generated LifecycleModel failed tidas-sdk validation",
      {
        issues: validation.error.issues,
      },
    );
  }
  return {
    datasetType: "lifecyclemodel",
    role: "lifecycle_model",
    processIndex: axis.processIndex,
    uuid: identity.uuid,
    version,
    profile: MODEL_PROFILE,
    identity: identity.document,
    sourceProcess: structuredClone(axis.rootProcess),
    resultProcess: { uuid: ownResult.uuid, version: ownResult.version },
    providerCount: directEdges.length,
    reconstruction,
    document,
  };
}

function modelAdministrative(sourceData, uuid, version) {
  const administrative = structuredClone(sourceData.administrativeInformation);
  const publication = administrative.publicationAndOwnership;
  publication["common:dataSetVersion"] = version;
  publication["common:permanentDataSetURI"] =
    `https://lcdn.tiangong.earth/datasetdetail/lifecyclemodel.xhtml?uuid=${uuid}&version=${version}`;
  publication["common:workflowAndPublicationStatus"] = "Working draft";
  return administrative;
}

function modelValidation(sourceData) {
  const compliance = sourceData.modellingAndValidation.complianceDeclarations;
  const reviewer =
    sourceData.administrativeInformation.dataEntryBy[
      "common:referenceToPersonOrEntityEnteringTheData"
    ];
  return {
    validation: {
      review: {
        "@type": "Not reviewed",
        "common:referenceToNameOfReviewerAndInstitution":
          structuredClone(reviewer),
      },
    },
    complianceDeclarations: structuredClone(compliance),
  };
}

function finiteString(value, field) {
  if (!Number.isFinite(Number(value)))
    fail("non_finite_model_value", `Non-finite ${field}`);
  return String(value);
}

function compareEdges(left, right) {
  return (
    String(left.residualExchangeInternalId).localeCompare(
      String(right.residualExchangeInternalId),
    ) ||
    left.balancingProcessIndex - right.balancingProcessIndex ||
    left.flow.id.localeCompare(right.flow.id)
  );
}
