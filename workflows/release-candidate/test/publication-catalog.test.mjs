import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { assertMatchesSchema } from "../../publication/test-support/contracts.mjs";
import {
  buildPublicationCatalog,
  publicationCatalogSetHash,
  writePublicationCatalogFile,
} from "../lib/publication-catalog.mjs";

const NON_RFC_UUID = "f2a6e8a4-1b22-e2e9-6903-b8ac475b05b3";

function unitProcessDocument(reference) {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: { UUID: "0016d864-1d9b-4f54-83b3-a1c61ba9564d" },
        technology: {
          referenceToTechnologyFlowDiagrammOrPicture: reference,
        },
      },
    },
  };
}

async function writeDataset(root, dataset, document) {
  const bytes = Buffer.from(canonicalJson(document), "utf8");
  await mkdir(path.dirname(path.join(root, dataset.path)), { recursive: true });
  await writeFile(path.join(root, dataset.path), bytes);
  return {
    ...dataset,
    sha256: sha256Bytes(bytes),
    canonicalContentHash: hashJson(document),
  };
}

async function tempIndex(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-catalog-"));
  const datasets = [];
  for (const { dataset, document } of entries)
    datasets.push(await writeDataset(root, dataset, document));
  return { root, index: { datasets } };
}

test("publication catalog accepts non-RFC-versioned platform UUIDs", async () => {
  const { root, index } = await tempIndex([
    {
      dataset: {
        path: "processes/0016d864-1d9b-4f54-83b3-a1c61ba9564d_01.00.000.json",
        datasetType: "process",
        role: "unit_process",
        uuid: "0016d864-1d9b-4f54-83b3-a1c61ba9564d",
        version: "01.00.000",
      },
      document: unitProcessDocument({
        "@refObjectId": NON_RFC_UUID,
        "@version": "01.00.005",
        "@type": "source data set",
        "@uri": `../sources/${NON_RFC_UUID}.xml`,
      }),
    },
    {
      dataset: {
        path: "sources/f2a6e8a4-1b22-e2e9-6903-b8ac475b05b3_01.00.005.json",
        datasetType: "source",
        role: "source",
        uuid: NON_RFC_UUID,
        version: "01.00.005",
      },
      document: {
        sourceDataSet: {
          sourceInformation: {
            dataSetInformation: { "common:UUID": NON_RFC_UUID },
          },
        },
      },
    },
  ]);
  try {
    const catalog = await buildPublicationCatalog({
      canonicalRoot: root,
      index,
    });
    const processRecord = catalog.datasets.find(
      (entry) => entry.uuid === "0016d864-1d9b-4f54-83b3-a1c61ba9564d",
    );
    assert.deepEqual(processRecord.references, [
      `source:${NON_RFC_UUID}@01.00.005`,
    ]);
    const schema =
      "../../release-candidate/contracts/candidate-publication-catalog.v1.schema.json";
    assertMatchesSchema(catalog, schema);
    const wrongShape = structuredClone(catalog);
    wrongShape.datasets.find(
      (entry) => entry.key === processRecord.key,
    ).references = [
      {
        target: processRecord.references[0],
        location: "processInformation/technology",
        role: "closure_dependency",
      },
    ];
    assert.throws(
      () => assertMatchesSchema(wrongShape, schema),
      /must be string/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication catalog reports the offending dataset for malformed references", async () => {
  const { root, index } = await tempIndex([
    {
      dataset: {
        path: "processes/0016d864-1d9b-4f54-83b3-a1c61ba9564d_01.00.000.json",
        datasetType: "process",
        role: "unit_process",
        uuid: "0016d864-1d9b-4f54-83b3-a1c61ba9564d",
        version: "01.00.000",
      },
      document: unitProcessDocument({
        "@refObjectId": "not-a-uuid",
        "@version": "01.00.005",
      }),
    },
  ]);
  try {
    await assert.rejects(
      buildPublicationCatalog({ canonicalRoot: root, index }),
      (error) => {
        assert.equal(error.code, "publication_catalog_reference_invalid");
        assert.equal(
          error.details.dataset,
          "process:0016d864-1d9b-4f54-83b3-a1c61ba9564d@01.00.000",
        );
        assert.equal(
          error.details.datasetPath,
          "processes/0016d864-1d9b-4f54-83b3-a1c61ba9564d_01.00.000.json",
        );
        assert.equal(error.details.reference.uuid, "not-a-uuid");
        assert.match(
          error.details.reference.location,
          /referenceToTechnologyFlowDiagrammOrPicture/,
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication catalog dedupes repeated references and hashes the set incrementally", async () => {
  const repeatedReference = {
    "@refObjectId": NON_RFC_UUID,
    "@version": "01.00.005",
    "@type": "source data set",
  };
  const { root, index } = await tempIndex([
    {
      dataset: {
        path: "processes/0016d864-1d9b-4f54-83b3-a1c61ba9564d_01.00.000.json",
        datasetType: "process",
        role: "unit_process",
        uuid: "0016d864-1d9b-4f54-83b3-a1c61ba9564d",
        version: "01.00.000",
      },
      document: unitProcessDocument([
        repeatedReference,
        { ...repeatedReference },
      ]),
    },
    {
      dataset: {
        path: "sources/f2a6e8a4-1b22-e2e9-6903-b8ac475b05b3_01.00.005.json",
        datasetType: "source",
        role: "source",
        uuid: NON_RFC_UUID,
        version: "01.00.005",
      },
      document: {
        sourceDataSet: {
          sourceInformation: {
            dataSetInformation: { "common:UUID": NON_RFC_UUID },
          },
        },
      },
    },
  ]);
  try {
    const catalog = await buildPublicationCatalog({
      canonicalRoot: root,
      index,
    });
    const processRecord = catalog.datasets.find(
      (entry) => entry.uuid === "0016d864-1d9b-4f54-83b3-a1c61ba9564d",
    );
    assert.deepEqual(processRecord.references, [
      `source:${NON_RFC_UUID}@01.00.005`,
    ]);
    assert.equal(
      catalog.catalogSetHash,
      publicationCatalogSetHash(catalog.datasets),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming catalog file equals canonical serialization and binds its bytes", async () => {
  const { root, index } = await tempIndex([
    {
      dataset: {
        path: "processes/0016d864-1d9b-4f54-83b3-a1c61ba9564d_01.00.000.json",
        datasetType: "process",
        role: "unit_process",
        uuid: "0016d864-1d9b-4f54-83b3-a1c61ba9564d",
        version: "01.00.000",
      },
      document: unitProcessDocument({
        "@refObjectId": NON_RFC_UUID,
        "@version": "01.00.005",
        "@type": "source data set",
      }),
    },
    {
      dataset: {
        path: "sources/f2a6e8a4-1b22-e2e9-6903-b8ac475b05b3_01.00.005.json",
        datasetType: "source",
        role: "source",
        uuid: NON_RFC_UUID,
        version: "01.00.005",
      },
      document: {
        sourceDataSet: {
          sourceInformation: {
            dataSetInformation: { "common:UUID": NON_RFC_UUID },
          },
        },
      },
    },
  ]);
  try {
    const catalog = await buildPublicationCatalog({
      canonicalRoot: root,
      index,
    });
    const file = path.join(root, "publication-catalog.json");
    const streamedSha256 = await writePublicationCatalogFile(catalog, file);
    const bytes = await readFile(file);
    assert.equal(sha256Bytes(bytes), streamedSha256);
    assert.equal(bytes.toString("utf8"), canonicalJson(catalog));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
