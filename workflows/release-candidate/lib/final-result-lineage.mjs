import { canonicalJson, hashJson, sha256Bytes, fail } from "./common.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const HASH = /^[0-9a-f]{64}$/u;
function requireValue(value) {
  if (!value)
    fail(
      "final_result_lineage_evidence_invalid",
      "Final Result association requires exact structured producer evidence",
    );
}
function key(value) {
  requireValue(
    UUID.test(value?.uuid ?? "") && VERSION.test(value?.version ?? ""),
  );
  return `${value.uuid}@${value.version}`;
}
function sourceIdentity(value) {
  const result = { uuid: value?.id ?? value?.uuid, version: value?.version };
  key(result);
  return result;
}
function uniqueMap(rows) {
  requireValue(Array.isArray(rows) && rows.length <= 2_000_000);
  const result = new Map();
  for (const r of rows) {
    const k = key(r);
    requireValue(!result.has(k));
    result.set(k, r);
  }
  return result;
}
function checkedMaterialization({ manifest, catalog, index }) {
  const direct =
    manifest?.schemaVersion === "tiangong.release.materialization-manifest.v1";
  requireValue(
    direct ||
      manifest?.schemaVersion ===
        "tiangong.release.materialization-manifest.v2",
  );
  // The established one-hop Model producer binds canonical file bytes (including
  // the trailing newline). Result-only and Derived producers bind JCS content.
  // Select the known producer contract; never accept an arbitrary hash fallback.
  const modelFileBinding =
    direct &&
    manifest.profiles?.model === "resolved-one-hop-aggregated-background.v1";
  if (modelFileBinding)
    requireValue(
      manifest.validation?.modelSchemas === "passed" &&
        manifest.validation?.oneHopReconstruction === "passed" &&
        manifest.datasets?.some(
          (d) =>
            d.role === "lifecycle_model" && d.datasetType === "lifecyclemodel",
        ),
    );
  const catalogHash = modelFileBinding
    ? sha256Bytes(Buffer.from(canonicalJson(catalog)))
    : hashJson(catalog);
  requireValue(
    catalog?.schemaVersion ===
      (direct
        ? "tiangong.release.result-catalog.v1"
        : "tiangong.release.result-catalog.v2") &&
      manifest.inputs?.resultCatalogSha256 === catalogHash,
  );
  requireValue(
    (direct
      ? manifest.inputs?.canonicalDatasetIndexSha256
      : manifest.canonicalDatasetIndexSha256) === hashJson(index) &&
      index.schemaVersion === "tiangong.release.canonical-dataset-index.v1",
  );
  requireValue(
    Array.isArray(manifest.datasets) && Array.isArray(index.datasets),
  );
  const descriptors = uniqueMap(
    manifest.datasets.filter((r) => r.role === "result_process"),
  );
  const declared = uniqueMap(catalog.datasets);
  const entries = uniqueMap(
    index.datasets.filter((r) => r.role === "result_process"),
  );
  requireValue(
    entries.size === descriptors.size &&
      declared.size === descriptors.size &&
      descriptors.size > 0,
  );
  for (const [k, d] of descriptors) {
    const c = declared.get(k);
    const e = entries.get(k);
    requireValue(
      d.datasetType === "process" &&
        c &&
        e &&
        HASH.test(d.canonicalContentHash ?? "") &&
        d.canonicalContentHash === e.canonicalContentHash &&
        hashJson(d) === hashJson(c),
    );
  }
  if (direct)
    requireValue(
      catalog.calculationId === manifest.inputs.calculationId &&
        catalog.bundleContentHash === manifest.inputs.bundleContentHash &&
        manifest.validation?.sourceDocuments === "verified" &&
        manifest.validation?.resultReferences === "verified",
    );
  else
    requireValue(
      manifest.inputKind === "verified-derived-result" &&
        manifest.validation?.producerReplay === "verified" &&
        manifest.validation?.transformedBytes === "verified" &&
        hashJson(catalog.source) === hashJson(manifest.source),
    );
  return { direct, descriptors, entries };
}
function directSources(descriptor, catalog) {
  const source = sourceIdentity(descriptor.sourceProcess);
  requireValue(Array.isArray(catalog.requiredResults));
  requireValue(
    catalog.requiredResults.some((r) => key(sourceIdentity(r)) === key(source)),
  );
  return [source];
}
function parentSources(parent, expectedCandidate) {
  requireValue(
    parent?.candidate &&
      hashJson(parent.candidate) === expectedCandidate.releaseCandidateSha256 &&
      parent.candidate.status === "local_candidate" &&
      parent.candidate.publicationAuthorized === false &&
      parent.candidate.validation?.outcome === "passed" &&
      parent.candidate.canonicalDatasetIndexSha256 ===
        hashJson(parent.candidateIndex) &&
      expectedCandidate.canonicalDatasetIndexSha256 ===
        hashJson(parent.candidateIndex),
  );
  const entries = uniqueMap(
    parent.candidateIndex.datasets.filter((r) => r.role === "result_process"),
  );
  const associations = new Map();
  if (
    parent.candidate.schemaVersion === "tiangong.release.release-candidate.v3"
  ) {
    requireValue(
      parent.finalInput?.schemaVersion ===
        "tiangong.release.final-result-input.v1" &&
        parent.candidate.finalInput?.sha256 === hashJson(parent.finalInput),
    );
    for (const row of parent.finalInput.results) {
      const k = key(row);
      const entry = entries.get(k);
      requireValue(
        entry &&
          row.canonicalContentHash === entry.canonicalContentHash &&
          ["direct", "derived"].includes(row.relationKind) &&
          Array.isArray(row.sources) &&
          row.sources.length > 0 &&
          (row.relationKind !== "direct" || row.sources.length === 1) &&
          !associations.has(k),
      );
      const sources = row.sources.map(sourceIdentity);
      requireValue(new Set(sources.map(key)).size === sources.length);
      associations.set(k, sources);
    }
  } else {
    requireValue(
      [
        "tiangong.release.release-candidate.v1",
        "tiangong.release.release-candidate.v2",
      ].includes(parent.candidate.schemaVersion) &&
        parent.candidate.packagePlanSha256 === hashJson(parent.packagePlan) &&
        parent.packagePlan.materialization?.manifestSha256 ===
          hashJson(parent.materialization?.manifest) &&
        parent.packagePlan.materialization.canonicalDatasetIndexSha256 ===
          hashJson(parent.materialization?.index),
    );
    const witness = checkedMaterialization(parent.materialization);
    requireValue(witness.direct);
    for (const [k, entry] of entries) {
      const descriptor = witness.descriptors.get(k);
      requireValue(
        descriptor &&
          descriptor.canonicalContentHash === entry.canonicalContentHash,
      );
      associations.set(
        k,
        directSources(descriptor, parent.materialization.catalog),
      );
    }
  }
  return { entries, associations };
}
// Only producer catalogs and hash-bound parent evidence establish association.
// Names/comments and the presence of ancestors in a ZIP never imply directness.
export function resolveFinalResultLineage({
  manifest,
  catalog,
  index,
  parent,
  transformation,
}) {
  const source = checkedMaterialization({ manifest, catalog, index });
  if (!source.direct) {
    requireValue(
      transformation?.frozenSpec &&
        transformation.executionReceipt &&
        transformation.handoff,
    );
    const { frozenSpec, executionReceipt, handoff } = transformation;
    requireValue(
      hashJson(frozenSpec) === manifest.source.transformationFrozenSpecSha256 &&
        hashJson(executionReceipt) ===
          manifest.source.transformationExecutionReceiptSha256 &&
        hashJson(handoff) === manifest.source.transformationHandoffSha256,
    );
    requireValue(
      frozenSpec.operation?.type === "result-process.weighted-aggregate.v0" &&
        hashJson(frozenSpec.operation.candidate) ===
          hashJson(manifest.source.parentCandidate) &&
        handoff.transformationFrozenSpecSha256 === hashJson(frozenSpec) &&
        handoff.transformationExecutionReceiptSha256 ===
          hashJson(executionReceipt),
    );
    requireValue(
      Array.isArray(frozenSpec.operation.inputs) &&
        source.descriptors.size === 1,
    );
    const descriptor = [...source.descriptors.values()][0];
    const encoded = source.entries.get(key(descriptor));
    requireValue(
      key(frozenSpec.output?.identity) === key(descriptor) &&
        executionReceipt.status === "completed" &&
        executionReceipt.transformationFrozenSpecSha256 ===
          hashJson(frozenSpec) &&
        key(executionReceipt.output) === key(descriptor) &&
        executionReceipt.output.canonicalContentHash ===
          encoded.canonicalContentHash &&
        executionReceipt.output.sha256 === encoded.sha256 &&
        handoff.status === "ready_for_result_materialization" &&
        handoff.nextWorkflow === "result-materialization" &&
        Array.isArray(handoff.transformedDatasets) &&
        handoff.transformedDatasets.length === 1 &&
        hashJson(handoff.transformedDatasets[0]) ===
          hashJson(executionReceipt.output),
    );
    requireValue(
      hashJson(descriptor.parentResults) ===
        hashJson(
          frozenSpec.operation.inputs.map(
            ({ uuid, version, sha256, canonicalContentHash }) => ({
              uuid,
              version,
              sha256,
              canonicalContentHash,
            }),
          ),
        ),
    );
  }
  const parentEvidence = source.direct
    ? null
    : parentSources(parent, manifest.source.parentCandidate);
  const results = [];
  for (const [k, descriptor] of source.descriptors) {
    let sources;
    if (source.direct) sources = directSources(descriptor, catalog);
    else {
      requireValue(
        descriptor.relationKind === "derived" &&
          descriptor.sourceAssociation?.status ===
            "requires_verified_parent_lineage" &&
          Array.isArray(descriptor.parentResults) &&
          descriptor.parentResults.length > 0,
      );
      const combined = new Map();
      const parents = new Set();
      for (const result of descriptor.parentResults) {
        const p = key(result);
        const entry = parentEvidence.entries.get(p);
        const association = parentEvidence.associations.get(p);
        requireValue(
          !parents.has(p) &&
            entry &&
            association &&
            result.canonicalContentHash === entry.canonicalContentHash &&
            result.sha256 === entry.sha256,
        );
        parents.add(p);
        for (const item of association) combined.set(key(item), item);
      }
      sources = [...combined.values()].sort((a, b) =>
        key(a) < key(b) ? -1 : 1,
      );
    }
    results.push({
      uuid: descriptor.uuid,
      version: descriptor.version,
      canonicalContentHash: descriptor.canonicalContentHash,
      relationKind: source.direct ? "direct" : "derived",
      sources,
    });
  }
  results.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return {
    schemaVersion: "tiangong.release.final-result-lineage.v1",
    materializationManifestHash: hashJson(manifest),
    resultCatalogHash: hashJson(catalog),
    materializedIndexHash: hashJson(index),
    parentCandidateHash: source.direct ? null : hashJson(parent.candidate),
    results,
  };
}
