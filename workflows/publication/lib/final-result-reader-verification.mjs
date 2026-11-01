import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadFinalResultCandidate } from "../../release-candidate/lib/final-result-candidate.mjs";
import { loadFinalResultInput } from "../../release-candidate/lib/final-result-input.mjs";
import { frozenDocument } from "../../release-candidate/lib/final-result-artifacts.mjs";
import {
  indexFile,
  verifiedBytes,
} from "../../release-candidate/lib/final-result-files.mjs";
import {
  createFrozenDependencyResolver,
  projectFinalResult,
  inventoryKey,
} from "../../release-candidate/lib/final-result-projection.mjs";
import { fail, hashJson } from "./common.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const key = (row) => `${row.uuid}@${row.version}`;
const same = (a, b) => {
  try {
    return a !== undefined && b !== undefined && hashJson(a) === hashJson(b);
  } catch {
    return false;
  }
};
function required(value, code = "final_probe_binding_invalid") {
  if (!value)
    fail(
      code,
      "Final Result probe differs from its frozen content or live authority",
    );
}
const CONTEXT = [
  "releaseRunId",
  "publishPlanHash",
  "candidateHash",
  "targetHash",
  "selectionHash",
  "selectionCount",
  "runtimeRevision",
  "readerSha256",
  "actorId",
  "permissionHash",
  "scope",
  "publicationAuthorized",
  "artifact",
  "result",
  "contentHash",
  "lciAvailable",
  "lciaAvailable",
];
function validateProbe(probe) {
  required(probe && same(Object.keys(probe).sort(), [...CONTEXT].sort()));
  required(
    ["releaseRunId", "runtimeRevision", "actorId"].every((name) =>
      UUID.test(probe[name] ?? ""),
    ) &&
      [
        "publishPlanHash",
        "candidateHash",
        "targetHash",
        "selectionHash",
        "readerSha256",
        "permissionHash",
        "contentHash",
      ].every((name) => HASH.test(probe[name] ?? "")) &&
      Number.isSafeInteger(probe.selectionCount) &&
      probe.selectionCount >= 1 &&
      probe.selectionCount <= 2000000 &&
      probe.publicationAuthorized === false &&
      probe.lciAvailable === true &&
      typeof probe.lciaAvailable === "boolean" &&
      same(probe.scope, {
        kind: "readiness",
        releaseRunId: probe.releaseRunId,
        selectionHash: probe.selectionHash,
      }),
  );
}

// The frozen input remains available to reconstruct expected values independently
// of HDF5. A probe receipt proves only this exact sampled Result, not full release
// readiness, actor approval, publication or coverage of other selected artifacts.
export async function createFinalResultProbeVerifier({
  candidateDir,
  inputDir,
  reader,
}) {
  required(typeof reader?.query === "function");
  const candidate = await loadFinalResultCandidate(candidateDir);
  const frozen = await loadFinalResultInput(inputDir);
  required(
    same(frozen.input, candidate.input) && same(frozen.index, candidate.index),
  );
  const candidateHash = createHash("sha256")
    .update(await readFile(path.join(candidate.root, "release-candidate.json")))
    .digest("hex");
  const entries = new Map(
    frozen.index.datasets.map((entry) => [
      `${entry.datasetType}:${key(entry)}`,
      entry,
    ]),
  );
  const dependencies = [];
  for (const entry of frozen.index.datasets) {
    if (
      ["flow", "flowproperty", "unitgroup", "lciamethod"].includes(
        entry.datasetType,
      )
    )
      dependencies.push({
        ...entry,
        document: await frozenDocument(frozen.canonicalRoot, entry),
      });
  }
  const resolveDependency = createFrozenDependencyResolver(dependencies);
  const rows = new Map(
    candidate.queryCatalog.results.map((row) => [key(row), row]),
  );
  const artifacts = new Map(
    candidate.candidate.queryArtifacts.map((artifact) => [
      artifact.artifactId,
      artifact,
    ]),
  );
  return {
    async verify(probe, { authorize }) {
      validateProbe(probe);
      probe = structuredClone(probe);
      required(
        typeof authorize === "function" &&
          probe.candidateHash === candidateHash &&
          probe.selectionCount <= rows.size,
      );
      const selection = rows.get(key(probe.result));
      const artifact = artifacts.get(probe.artifact?.artifactId);
      required(
        selection &&
          artifact &&
          selection.artifactId === artifact.artifactId &&
          selection.contentHash === probe.contentHash &&
          same(probe.result, {
            uuid: selection.uuid,
            version: selection.version,
          }) &&
          same(probe.artifact, {
            schemaVersion: artifact.schemaVersion,
            artifactId: artifact.artifactId,
            manifestSha256: artifact.manifestSha256,
            manifestByteSize: artifact.manifestByteSize,
          }),
      );
      const entry = entries.get(`process:${key(probe.result)}`);
      const projection = projectFinalResult({
        document: await frozenDocument(frozen.canonicalRoot, entry),
        identity: entry,
        layer: selection.layer,
        expectedMethods: selection.expectedMethods,
        resolveDependency,
      });
      required(
        projection.contentHash === probe.contentHash &&
          probe.lciaAvailable === (selection.layer === "lci-lcia"),
      );
      const root = path.join(candidate.root, artifact.path);
      const manifest = JSON.parse(
        await verifiedBytes(
          root,
          {
            name: "manifest.json",
            sha256: artifact.manifestSha256,
            byteSize: artifact.manifestByteSize,
          },
          128 * 1024 ** 2,
        ),
      );
      const inventory = await indexFile(
        root,
        manifest,
        "inventory-items.json.gz",
      );
      const columns = new Map();
      let previous = null;
      inventory.forEach((item, ordinal) => {
        const k = inventoryKey(item);
        required(
          item.ordinal === ordinal && (previous === null || previous < k),
        );
        columns.set(k, item);
        previous = k;
      });
      const expected = projection.inventory
        .map(({ value, amountField, ...item }) => {
          const column = columns.get(inventoryKey(item));
          required(
            column && same(column, { ordinal: column.ordinal, ...item }),
          );
          return { item: column, amount: value };
        })
        .filter((item) => item.amount !== 0)
        .sort((a, b) => a.item.ordinal - b.item.ordinal);
      const impacts = projection.impacts.map(({ value, ...item }, ordinal) => [
        { ordinal, ...item },
        value,
      ]);
      const result = {
        ...probe.result,
        quantitativeReference: projection.quantitativeReference,
        relationKind: selection.relationKind,
      };
      const startedAt = new Date().toISOString();
      let queryCount = 0;
      const observations = createHash("sha256").update(
        "tiangong.final-result-probe-observations.v1\n",
      );
      const live = async (signal) => {
        try {
          const fresh = await authorize(signal);
          validateProbe(fresh);
          required(same(fresh, probe));
        } catch {
          required(false, "final_probe_authorization_changed");
        }
      };
      const query = async (query) => {
        const data = await reader.query(
          {
            schemaVersion: "result.query.request.v2",
            scope: probe.scope,
            artifact: probe.artifact,
            result: probe.result,
            query,
          },
          { readerSha256: probe.readerSha256, authorize: live },
        );
        queryCount++;
        return data;
      };
      const overview = await query({ kind: "overview" });
      required(
        same(overview, {
          result,
          lciAvailable: true,
          lciaAvailable: probe.lciaAvailable,
        }),
        "final_probe_overview_mismatch",
      );
      observations.update(hashJson(overview) + "\n");
      let cursor = null,
        offset = 0,
        pages = 0;
      const cursors = new Set();
      do {
        // The first one-item page exercises cursor continuation whenever this
        // sampled Result has more than one nonzero. Remaining pages are bounded.
        const limit = pages === 0 ? 1 : 1000;
        const data = await query({ kind: "lci", limit, cursor, filter: null });
        const items = expected.slice(offset, offset + limit);
        required(
          data &&
            same(Object.keys(data).sort(), [
              "items",
              "nextCursor",
              "nonzeroCount",
              "result",
            ]) &&
            same(data.result, result) &&
            data.nonzeroCount === expected.length &&
            same(data.items, items),
          "final_probe_lci_mismatch",
        );
        offset += items.length;
        pages++;
        cursor = data.nextCursor;
        required(
          offset < expected.length
            ? typeof cursor === "string" &&
                cursor.length > 0 &&
                cursor.length <= 4096 &&
                !cursors.has(cursor)
            : cursor === null,
          "final_probe_cursor_invalid",
        );
        if (cursor !== null) cursors.add(cursor);
        observations.update(
          hashJson({ result, items, nonzeroCount: expected.length, offset }) +
            "\n",
        );
      } while (cursor !== null);
      if (probe.lciaAvailable) {
        const data = await query({ kind: "lcia" });
        required(same(data, { result, impacts }), "final_probe_lcia_mismatch");
        observations.update(hashJson(data) + "\n");
      }
      // An authority/runtime change during the last response invalidates the
      // evidence too. Database must independently enforce freshness at activation.
      const finalController = new AbortController();
      let finalTimer;
      try {
        await Promise.race([
          live(finalController.signal),
          new Promise((resolve, reject) => {
            finalTimer = setTimeout(() => {
              finalController.abort();
              reject(
                Object.assign(
                  new Error("Final Result authority check timed out"),
                  { code: "final_probe_authorization_changed" },
                ),
              );
            }, 30000);
          }),
        ]);
      } finally {
        clearTimeout(finalTimer);
        finalController.abort();
      }
      return {
        schemaVersion: "tiangong.final-result-reader-probe.v1",
        ...probe,
        startedAt,
        verifiedAt: new Date().toISOString(),
        lciNonzeroCount: expected.length,
        lciPageCount: pages,
        lciaCount: impacts.length,
        queryCount,
        observationsSha256: observations.digest("hex"),
      };
    },
  };
}
