import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashJson, canonicalJson, sha256Bytes } from "../../lib/common.mjs";
import { buildIndex } from "../../lib/package-build.mjs";
import { id, version } from "./final-result.mjs";
export async function setup(t, { processDependency = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "final-result-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = JSON.parse(
    await readFile(new URL("./paired-final-results.json", import.meta.url)),
  );
  if (processDependency) {
    const result = fixture.records.find((r) => r.document.processDataSet);
    const dependency = structuredClone(result);
    const uuid = id(81);
    dependency.path = `processes/${uuid}.json`;
    const process = dependency.document.processDataSet;
    process.processInformation.dataSetInformation["common:UUID"] = uuid;
    process.modellingAndValidation.LCIMethodAndAllocation.typeOfDataSet =
      "Unit process, single operation";
    delete process.LCIAResults;
    if (processDependency !== "unreferenced") {
      result.document.processDataSet.processInformation.technology ??= {
        technologyDescriptionAndIncludedProcesses: {
          "@xml:lang": "en",
          "#text": "Synthetic process dependency",
        },
      };
      result.document.processDataSet.processInformation.technology.referenceToIncludedProcesses =
        {
          "@type": "process data set",
          "@refObjectId": uuid,
          "@version": version,
          "@uri": `../processes/${uuid}.xml`,
          "common:shortDescription": {
            "@xml:lang": "en",
            "#text": "Synthetic included process",
          },
        };
    }
    fixture.records.push(dependency);
    fixture.index.datasets.push({
      datasetType: "process",
      role: "unit_process",
      uuid,
      version,
      path: dependency.path,
    });
    for (const entry of fixture.index.datasets) {
      const record = fixture.records.find((r) => r.path === entry.path);
      const bytes = Buffer.from(canonicalJson(record.document));
      Object.assign(entry, {
        byteSize: bytes.length,
        sha256: sha256Bytes(bytes),
        canonicalContentHash: hashJson(record.document),
      });
    }
    fixture.index = buildIndex(fixture.index.datasets);
  }
  const canonicalRoot = path.join(root, "canonical");
  await mkdir(canonicalRoot);
  for (const r of fixture.records) {
    const file = path.join(canonicalRoot, r.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, canonicalJson(r.document));
  }
  const datasets = fixture.index.datasets
    .filter((e) => e.role === "result_process")
    .map((e) => ({ ...e, sourceProcess: { id: id(80), version } }));
  const index = {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasets,
  };
  const catalog = {
    schemaVersion: "tiangong.release.result-catalog.v1",
    calculationId: id(50),
    bundleContentHash: "a".repeat(64),
    requiredResults: [{ id: id(80), version }],
    datasets,
  };
  const manifest = {
    schemaVersion: "tiangong.release.materialization-manifest.v1",
    inputs: {
      calculationId: catalog.calculationId,
      bundleContentHash: catalog.bundleContentHash,
      resultCatalogSha256: hashJson(catalog),
      canonicalDatasetIndexSha256: hashJson(index),
    },
    datasets,
    validation: { sourceDocuments: "verified", resultReferences: "verified" },
  };
  return {
    root,
    canonicalRoot,
    index: fixture.index,
    results: fixture.results.map(({ relationKind, sources, ...r }) => r),
    materializationEvidence: { manifest, catalog, index },
    outDir: path.join(root, "frozen"),
  };
}
export function registry() {
  const claims = new Map();
  const calls = [];
  let closes = 0;
  return {
    claims,
    calls,
    get closes() {
      return closes;
    },
    createAuthority: () => ({
      versions: async (uuid) => {
        calls.push(["versions", uuid]);
        return {
          resultId: uuid,
          versions: [...claims.values()]
            .filter((r) => r.result.uuid === uuid)
            .map((r) => ({
              version: r.result.version,
              status: "registered",
              hashDomain: r.hashDomain,
              contentHash: r.contentHash,
            })),
          nextBeforeVersion: null,
        };
      },
      register: async (request) => {
        calls.push(["register", request]);
        const key = `${request.result.uuid}@${request.result.version}`;
        if (!claims.has(key))
          claims.set(key, {
            schemaVersion: "tiangong.final-result-identity-receipt.v1",
            registrationId: id(90 + claims.size),
            result: request.result,
            hashDomain: request.hashDomain,
            canonicalContentHash: request.canonicalContentHash,
            contentHash: request.contentHash,
            contentRef: `urn:sha256:${request.canonicalContentHash}`,
            createdAt: "2026-11-01T00:00:00Z",
          });
        return claims.get(key);
      },
      close: async () => {
        closes++;
      },
    }),
  };
}
