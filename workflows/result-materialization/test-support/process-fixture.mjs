export function validUnitProcess(processId, flowId, processName) {
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
          "common:UUID": processId,
          name: {
            baseName: { "@xml:lang": "en", "#text": processName },
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
            "#text": "Fixture process.",
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
            "#text": "Workflow test.",
          },
        },
        dataEntryBy: {
          "common:timeStamp": "2026-07-16T00:00:00.000Z",
          "common:referenceToDataSetFormat": source,
          "common:referenceToPersonOrEntityEnteringTheData": contact,
        },
        publicationAndOwnership: {
          "common:dataSetVersion": "01.00.000",
          "common:permanentDataSetURI": `https://example.test/process/${processId}`,
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
              flowId,
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

export function reference(type, category, uuid, description) {
  return {
    "@refObjectId": uuid,
    "@type": type,
    "@uri": `../${category}/${uuid}_01.00.000.json`,
    "@version": "01.00.000",
    "common:shortDescription": { "@xml:lang": "en", "#text": description },
  };
}
