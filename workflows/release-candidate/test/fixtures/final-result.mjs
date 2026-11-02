export const version = "01.00.000";
export const id = (n) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ref = (n) => ({ "@refObjectId": id(n), "@version": version });
const admin = { publicationAndOwnership: { "common:dataSetVersion": version } };
export function fixture() {
  const record = (kind, n, root, information, extra) => ({
    datasetType: kind,
    uuid: id(n),
    version,
    document: {
      [root]: {
        [information]: {
          dataSetInformation: { "common:UUID": id(n) },
          ...extra.info,
        },
        administrativeInformation: structuredClone(admin),
        ...extra.body,
      },
    },
  });
  const flow = (n, type) =>
    record("flow", n, "flowDataSet", "flowInformation", {
      info: {
        dataSetInformation: {
          "common:UUID": id(n),
          name: { baseName: `Flow ${n}` },
        },
        quantitativeReference: { referenceToReferenceFlowProperty: "0" },
      },
      body: {
        modellingAndValidation: { LCIMethod: { typeOfDataSet: type } },
        flowProperties: {
          flowProperty: [
            {
              "@dataSetInternalID": "0",
              meanValue: "1",
              referenceToFlowPropertyDataSet: ref(4),
            },
          ],
        },
      },
    });
  const dependencies = [
    flow(2, "Product flow"),
    flow(3, "Elementary flow"),
    record(
      "flowproperty",
      4,
      "flowPropertyDataSet",
      "flowPropertiesInformation",
      {
        info: {
          quantitativeReference: { referenceToReferenceUnitGroup: ref(5) },
        },
        body: {},
      },
    ),
    record("unitgroup", 5, "unitGroupDataSet", "unitGroupInformation", {
      info: { quantitativeReference: { referenceToReferenceUnit: "0" } },
      body: {
        units: {
          unit: [{ "@dataSetInternalID": "0", name: "kg", meanValue: "1" }],
        },
      },
    }),
    record("lciamethod", 6, "LCIAMethodDataSet", "LCIAMethodInformation", {
      info: {
        dataSetInformation: {
          "common:UUID": id(6),
          "common:name": "Climate change",
        },
        quantitativeReference: {
          referenceQuantity: {
            ...ref(4),
            "@type": "flow property data set",
            "common:shortDescription": "kg CO2 equivalents",
          },
        },
      },
      body: {},
    }),
  ];
  const exchange = (internalId, flow, value, direction = "Output") => ({
    "@dataSetInternalID": String(internalId),
    referenceToFlowDataSet: ref(flow),
    exchangeDirection: direction,
    resultingAmount: String(value),
    meanAmount: "999",
  });
  const document = {
    processDataSet: {
      processInformation: {
        dataSetInformation: { "common:UUID": id(1) },
        quantitativeReference: { referenceToReferenceFlow: "7" },
      },
      modellingAndValidation: {
        LCIMethodAndAllocation: { typeOfDataSet: "LCI result" },
      },
      administrativeInformation: structuredClone(admin),
      exchanges: {
        exchange: [
          exchange(7, 2, -2, "Input"),
          exchange(8, 3, 0),
          exchange(9, 3, -3, "Input"),
        ],
      },
      LCIAResults: {
        LCIAResult: [
          { referenceToLCIAMethodDataSet: ref(6), meanAmount: "42" },
        ],
      },
    },
  };
  return {
    document,
    dependencies,
    layer: "lci-lcia",
    expectedMethods: [{ uuid: id(6), version }],
  };
}
