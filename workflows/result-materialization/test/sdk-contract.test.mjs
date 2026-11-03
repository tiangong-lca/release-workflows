import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LifeCycleModelSchema, ProcessSchema } from "@tiangong-lca/tidas-sdk";

const PROCESS_ID = "11111111-1111-4111-8111-111111111111";
const FLOW_ID = "22222222-2222-4222-8222-222222222222";
const MODEL_ID = "33333333-3333-4333-8333-333333333333";
const RESULT_ID = "44444444-4444-4444-8444-444444444444";

const processFixture = validUnitProcess();
const modelFixture = validLifecycleModel(processFixture);
const processBytes = fixtureBytes(processFixture);
const modelBytes = fixtureBytes(modelFixture);
const FIXTURE_EVIDENCE = Object.freeze({
  schema: "tiangong.release.tidas-sdk-fixture-evidence.v1",
  sdk: "@tiangong-lca/tidas-sdk@0.6.0",
  processSha256:
    "0469b5b6fa53e874dce582d592b0b90b53e78e03e68f4aba079a8cff7fc15ed1",
  lifecycleModelSha256:
    "7c21c0abe0d309d091065a7e2aae58fb19f5ae554a3f011470173cb2010ab486",
});

test("Result Materialization pins and reports the released SDK 0.6.0", async () => {
  const workflowManifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const sdkPackage = JSON.parse(
    await readFile(
      new URL(
        "../package.json",
        import.meta.resolve("@tiangong-lca/tidas-sdk"),
      ),
      "utf8",
    ),
  );
  assert.equal(
    workflowManifest.dependencies["@tiangong-lca/tidas-sdk"],
    "0.6.0",
  );
  assert.equal(sdkPackage.version, "0.6.0");

  for (const relativePath of [
    "../lib/materialize-results.mjs",
    "../lib/materialize-models.mjs",
    "../lib/materialize.mjs",
  ]) {
    const runtimeEvidence = await readFile(
      new URL(relativePath, import.meta.url),
      "utf8",
    );
    assert.match(runtimeEvidence, /@tiangong-lca\/tidas-sdk@0\.6\.0/);
    assert.doesNotMatch(runtimeEvidence, /@tiangong-lca\/tidas-sdk@0\.2\.0/);
  }
});

test("released ProcessSchema validates the frozen representative Process bytes", () => {
  assert.equal(sha256(processBytes), FIXTURE_EVIDENCE.processSha256);
  const validation = ProcessSchema.safeParse(JSON.parse(processBytes));
  assert.equal(validation.success, true, formatIssues(validation));
});

test("released LifeCycleModelSchema validates the frozen representative model bytes", () => {
  assert.equal(sha256(modelBytes), FIXTURE_EVIDENCE.lifecycleModelSha256);
  const validation = LifeCycleModelSchema.safeParse(JSON.parse(modelBytes));
  assert.equal(validation.success, true, formatIssues(validation));
});

function validUnitProcess() {
  const contact = reference(
    "contact data set",
    "contacts",
    "55555555-5555-4555-8555-555555555555",
    "Fixture contact",
  );
  const source = reference(
    "source data set",
    "sources",
    "66666666-6666-4666-8666-666666666666",
    "Fixture source",
  );
  return {
    processDataSet: {
      "@xmlns": "http://lca.jrc.it/ILCD/Process",
      "@xmlns:common": "http://lca.jrc.it/ILCD/Common",
      "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@version": "1.1",
      "@locations": "../ILCDLocations.xml",
      "@xsi:schemaLocation":
        "http://lca.jrc.it/ILCD/Process ../../schemas/ILCD_ProcessDataSet.xsd",
      processInformation: {
        dataSetInformation: {
          "common:UUID": PROCESS_ID,
          name: {
            baseName: { "@xml:lang": "en", "#text": "SDK fixture process" },
            treatmentStandardsRoutes: {
              "@xml:lang": "en",
              "#text": "fixture route",
            },
            mixAndLocationTypes: {
              "@xml:lang": "en",
              "#text": "production mix, GLO",
            },
          },
          classificationInformation: {
            "common:classification": {
              "common:class": [
                {
                  "@level": "0",
                  "@classId": "A",
                  "#text": "Agriculture, forestry and fishing",
                },
                {
                  "@level": "1",
                  "@classId": "01",
                  "#text":
                    "Crop and animal production, hunting and related service activities",
                },
                {
                  "@level": "2",
                  "@classId": "011",
                  "#text": "Growing of non-perennial crops",
                },
                {
                  "@level": "3",
                  "@classId": "0111",
                  "#text":
                    "Growing of cereals (except rice), leguminous crops and oil seeds",
                },
              ],
            },
          },
          "common:generalComment": {
            "@xml:lang": "en",
            "#text": "Unmocked SDK compatibility fixture.",
          },
        },
        quantitativeReference: {
          "@type": "Reference flow(s)",
          referenceToReferenceFlow: "0",
        },
        time: { "common:referenceYear": 2026 },
        geography: {
          locationOfOperationSupplyOrProduction: { "@location": "GLO" },
        },
      },
      modellingAndValidation: {
        LCIMethodAndAllocation: {
          typeOfDataSet: "Unit process, single operation",
          LCIMethodPrinciple: "Attributional",
        },
        validation: { review: { "@type": "Not reviewed" } },
        complianceDeclarations: {
          compliance: {
            "common:referenceToComplianceSystem": source,
            "common:approvalOfOverallCompliance": "Not defined",
            "common:nomenclatureCompliance": "Not defined",
            "common:methodologicalCompliance": "Not defined",
            "common:reviewCompliance": "Not defined",
            "common:documentationCompliance": "Not defined",
            "common:qualityCompliance": "Not defined",
          },
        },
      },
      administrativeInformation: {
        "common:commissionerAndGoal": {
          "common:referenceToCommissioner": contact,
          "common:intendedApplications": {
            "@xml:lang": "en",
            "#text": "SDK migration test.",
          },
        },
        dataEntryBy: {
          "common:timeStamp": "2026-08-25T00:00:00.000Z",
          "common:referenceToDataSetFormat": source,
          "common:referenceToPersonOrEntityEnteringTheData": contact,
        },
        publicationAndOwnership: {
          "common:dataSetVersion": "01.00.000",
          "common:permanentDataSetURI": `https://example.test/process/${PROCESS_ID}`,
          "common:referenceToOwnershipOfDataSet": contact,
          "common:copyright": "false",
          "common:licenseType": "Free of charge for all users and uses",
        },
      },
      exchanges: {
        exchange: [
          {
            "@dataSetInternalID": "0",
            referenceToFlowDataSet: reference(
              "flow data set",
              "flows",
              FLOW_ID,
              "Reference flow",
            ),
            exchangeDirection: "Output",
            meanAmount: "1",
            resultingAmount: "1",
            dataDerivationTypeStatus: "Measured",
          },
        ],
      },
    },
  };
}

function validLifecycleModel(processDocument) {
  const source = processDocument.processDataSet;
  const administrativeInformation = structuredClone(
    source.administrativeInformation,
  );
  administrativeInformation.publicationAndOwnership["common:dataSetVersion"] =
    "01.00.000";
  administrativeInformation.publicationAndOwnership[
    "common:permanentDataSetURI"
  ] = `https://example.test/lifecyclemodel/${MODEL_ID}`;
  administrativeInformation.publicationAndOwnership[
    "common:workflowAndPublicationStatus"
  ] = "Working draft";
  return {
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
          "common:UUID": MODEL_ID,
          name: structuredClone(
            source.processInformation.dataSetInformation.name,
          ),
          classificationInformation: structuredClone(
            source.processInformation.dataSetInformation
              .classificationInformation,
          ),
          referenceToResultingProcess: reference(
            "process data set",
            "processes",
            RESULT_ID,
            "Fixture Result Process",
          ),
          "common:generalComment": {
            "@xml:lang": "en",
            "#text": "Unmocked SDK compatibility fixture.",
          },
        },
        quantitativeReference: { referenceToReferenceProcess: 0 },
        technology: {
          processes: {
            processInstance: [
              {
                "@dataSetInternalID": "0",
                "@multiplicationFactor": "1",
                referenceToProcess: reference(
                  "process data set",
                  "processes",
                  PROCESS_ID,
                  "Fixture Unit Process",
                ),
              },
            ],
          },
        },
      },
      modellingAndValidation: {
        validation: {
          review: {
            "@type": "Not reviewed",
            "common:referenceToNameOfReviewerAndInstitution": structuredClone(
              source.administrativeInformation.dataEntryBy[
                "common:referenceToPersonOrEntityEnteringTheData"
              ],
            ),
          },
        },
        complianceDeclarations: structuredClone(
          source.modellingAndValidation.complianceDeclarations,
        ),
      },
      administrativeInformation,
    },
  };
}

function reference(type, category, uuid, description) {
  return {
    "@refObjectId": uuid,
    "@type": type,
    "@uri": `../${category}/${uuid}_01.00.000.json`,
    "@version": "01.00.000",
    "common:shortDescription": { "@xml:lang": "en", "#text": description },
  };
}

function fixtureBytes(value) {
  return `${JSON.stringify(value)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function formatIssues(validation) {
  return validation.success ? "" : JSON.stringify(validation.error.issues);
}
