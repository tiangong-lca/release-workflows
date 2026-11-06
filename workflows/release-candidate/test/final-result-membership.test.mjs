import { assertMatchesSchema } from "../../publication/test-support/contracts.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  finalResultMembership,
  verifyResultCatalogScope,
} from "../lib/final-result-candidate.mjs";
import { canonicalJson, hashJson } from "../lib/common.mjs";

test("above-128-MiB dependency graph validates locally and produces compact exact membership", () => {
  const count = 6000;
  const key = (r) => `${r.datasetType}:${r.uuid}@${r.version}`;
  const index = {
    datasets: Array.from({ length: count }, (_, i) => ({
      datasetType: "process",
      role: "result_process",
      uuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      version: "01.00.000",
      path: `processes/${i}.json`,
      sha256: "a".repeat(64),
      canonicalContentHash: "b".repeat(64),
    })),
  };
  const keys = index.datasets.map(key).sort();
  const references = keys.slice(0, 500);
  const graph = {
    canonicalDatasetIndexSha256: hashJson(index),
    datasetCount: count,
    components: {
      unitProcess: { available: false, roots: [], datasets: [] },
      result: { available: true, roots: keys, datasets: keys },
    },
    datasets: index.datasets.map((r) => ({
      ...r,
      key: key(r),
      components: ["result"],
      references,
    })),
  };
  // Calculate the serialized graph size one record at a time, without allocating a giant JSON string.
  const graphBytes = graph.datasets.reduce(
    (sum, r) => sum + Buffer.byteLength(canonicalJson(r)),
    0,
  );
  assert.ok(graphBytes > 128 * 1024 * 1024);
  verifyResultCatalogScope(graph, index);
  const compact = finalResultMembership(index);
  assertMatchesSchema(
    compact,
    "../../release-candidate/contracts/candidate-publication-catalog.v2.schema.json",
  );
  assert.equal(compact.datasetCount, count);
  assert.equal(compact.canonicalDatasetIndexSha256, hashJson(index));
  assert.ok(Buffer.byteLength(canonicalJson(compact)) < 2 * 1024 * 1024);
  assert.ok(
    compact.datasets.every(
      (r) => Object.keys(r).length === 5 && !("references" in r),
    ),
  );
  assert.equal(compact.datasets[123].uuid, index.datasets[123].uuid);
  graph.datasets[0].references = ["process:absent@01.00.000"];
  assert.throws(() => verifyResultCatalogScope(graph, index), {
    code: "final_candidate_closure_scope",
  });
});
