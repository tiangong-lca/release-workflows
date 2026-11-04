import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  writeFile,
  appendFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, hashJson, sha256Bytes, fail } from "./common.mjs";
import { frozenDocument } from "./final-result-artifacts.mjs";
import {
  createFrozenDependencyStore,
  collectProjectionFlowKeys,
  projectFinalResult,
  FINAL_RESULT_PROJECTION,
} from "./final-result-projection.mjs";
import { resolveFinalResultLineage } from "./final-result-lineage.mjs";
import {
  identityRegistrationRequest,
  verifyIdentityReceipt,
} from "./final-result-identity.mjs";
import { readLocalJson, commitFrozenDirectory } from "./final-result-files.mjs";
import {
  MAX_METADATA_BYTES as MAX_METADATA,
  checkBudget,
} from "./resource-budget.mjs";
function requireValue(value, code = "final_input_invalid") {
  if (!value)
    fail(
      code,
      "Final input must bind exact content, lineage and registry receipts",
    );
}
const key = (e) => `${e.uuid}@${e.version}`;

// Inspection is read-only. Materialization evidence is structured, hash-bound
// producer output; the orchestration layer verifies/replays Derived handoffs.
export async function inspectFinalResultInput({
  canonicalRoot,
  index,
  results,
  materializationEvidence,
}) {
  const lineage = resolveFinalResultLineage(materializationEvidence);
  requireValue(
    Array.isArray(results) &&
      results.length > 0 &&
      results.length <= 2_000_000 &&
      Array.isArray(index.datasets),
  );
  const sources = new Map(lineage.results.map((r) => [key(r), r]));
  const entries = new Map();
  const requiredFlows = await collectProjectionFlowKeys(index, (entry) =>
    frozenDocument(canonicalRoot, entry),
  );
  const dependencies = createFrozenDependencyStore();
  let charged = Buffer.byteLength(canonicalJson({ index, results, lineage }));
  checkBudget("metadata", charged, MAX_METADATA);
  for (const entry of index.datasets) {
    const k = `${entry.datasetType}:${key(entry)}`;
    requireValue(!entries.has(k));
    entries.set(k, entry);
    const document = await frozenDocument(canonicalRoot, entry);
    if (
      ["flow", "flowproperty", "unitgroup", "lciamethod"].includes(
        entry.datasetType,
      ) &&
      (entry.datasetType !== "flow" ||
        requiredFlows.has(`flow:${entry.uuid}@${entry.version}`))
    ) {
      charged += dependencies.add({ ...entry, document });
      checkBudget("metadata", charged, MAX_METADATA, entry);
    }
  }
  const resolveDependency = dependencies.resolve;
  const selection = [];
  const registrations = [];
  const seen = new Set();
  for (const selected of results) {
    const k = key(selected);
    const entry = entries.get(`process:${k}`);
    const source = sources.get(k);
    requireValue(
      !seen.has(k) &&
        entry?.role === "result_process" &&
        source &&
        source.canonicalContentHash === entry.canonicalContentHash,
    );
    seen.add(k);
    // Callers choose layer/method capability; source association always comes from
    // the verified producer evidence, never from a caller-supplied sources list.
    requireValue(
      Object.keys(selected).every((k) =>
        ["uuid", "version", "layer", "expectedMethods"].includes(k),
      ),
    );
    const row = {
      ...selected,
      relationKind: source.relationKind,
      sources: source.sources,
    };
    const projection = projectFinalResult({
      document: await frozenDocument(canonicalRoot, entry),
      identity: entry,
      layer: row.layer,
      expectedMethods: row.expectedMethods,
      resolveDependency,
    });
    const request = identityRegistrationRequest(projection);
    charged += Buffer.byteLength(canonicalJson(request));
    checkBudget(
      "metadata",
      charged,
      MAX_METADATA,
      entry,
      registrations.length + 1,
    );
    selection.push(row);
    registrations.push(request);
  }
  requireValue(
    index.datasets
      .filter((e) => e.role === "result_process")
      .every((e) => seen.has(key(e))),
    "final_input_root_scope",
  );
  const inputHash = hashJson({
    projection: FINAL_RESULT_PROJECTION,
    index,
    results: selection,
  });
  return {
    schemaVersion: "tiangong.release.final-result-input-plan.v1",
    inputHash,
    indexHash: hashJson(index),
    lineageHash: hashJson(lineage),
    selection,
    lineage,
    registrations,
    candidateQualified: false,
    publicationAuthorized: false,
  };
}

// Registration claims are irreversible identity occupancy, not publication.
// Confirm the inspected input before creating a registry client. Failures retain
// exact requests and successful receipts, allowing same-input reconciliation.
export async function prepareFinalResultInput({
  canonicalRoot,
  index,
  results,
  materializationEvidence,
  confirmInputHash,
  outDir,
  createAuthority,
}) {
  requireValue(typeof createAuthority === "function");
  const inspected = await inspectFinalResultInput({
    canonicalRoot,
    index,
    results,
    materializationEvidence,
  });
  requireValue(
    confirmInputHash === inspected.inputHash,
    "final_input_confirmation_mismatch",
  );
  const target = path.resolve(outDir);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await lstat(target);
    fail("output_exists", "Frozen final input already exists");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const staging = await mkdtemp(`${target}.work-`);
  const frozenRoot = path.join(staging, "canonical");
  let authority;
  try {
    await mkdir(frozenRoot);
    for (const entry of index.datasets) {
      await frozenDocument(canonicalRoot, entry);
      const bytes = await readFile(path.join(canonicalRoot, entry.path));
      requireValue(
        bytes.length === entry.byteSize && sha256Bytes(bytes) === entry.sha256,
        "final_input_copy_drift",
      );
      const file = path.join(frozenRoot, entry.path);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, { flag: "wx" });
    }
    const plan = await inspectFinalResultInput({
      canonicalRoot: frozenRoot,
      index,
      results,
      materializationEvidence,
    });
    requireValue(
      hashJson(plan) === hashJson(inspected),
      "final_input_copy_drift",
    );
    await writeFile(
      path.join(staging, "input-plan.json"),
      canonicalJson(plan),
      { flag: "wx" },
    );
    await writeFile(
      path.join(staging, "canonical-dataset-index.json"),
      canonicalJson(index),
      { flag: "wx" },
    );
    await writeFile(
      path.join(staging, "source-lineage.json"),
      canonicalJson(plan.lineage),
      { flag: "wx" },
    );
    await writeFile(path.join(staging, "registration-receipts.ndjson"), "", {
      flag: "wx",
    });
    authority = await createAuthority();
    const registered = [];
    for (const [ordinal, request] of plan.registrations.entries()) {
      // Read current occupancy even for first-generation. A bounded page is not an
      // availability promise; registration is the final atomic arbitration.
      const page = await authority.versions(request.result.uuid, {
        limit: 256,
      });
      requireValue(
        page.resultId === request.result.uuid && Array.isArray(page.versions),
        "final_input_authority_mismatch",
      );
      const occupied = page.versions.find(
        (v) => v.version === request.result.version,
      );
      if (occupied)
        requireValue(
          occupied.status === "registered" &&
            occupied.hashDomain === request.hashDomain &&
            occupied.contentHash === request.contentHash,
          "final_input_version_occupied",
        );
      const receipt = verifyIdentityReceipt(request, {
        ok: true,
        data: await authority.register(request),
      });
      await appendFile(
        path.join(staging, "registration-receipts.ndjson"),
        `${canonicalJson({ requestHash: hashJson(request), receipt })}\n`,
      );
      registered.push({
        ...plan.selection[ordinal],
        hashDomain: request.hashDomain,
        canonicalContentHash: request.canonicalContentHash,
        contentHash: request.contentHash,
        identityReceipt: receipt,
      });
    }
    const finalInput = {
      schemaVersion: "tiangong.release.final-result-input.v1",
      inputHash: plan.inputHash,
      indexHash: plan.indexHash,
      lineageHash: plan.lineageHash,
      selection: plan.selection,
      results: registered,
      candidateQualified: false,
      publicationAuthorized: false,
    };
    await writeFile(
      path.join(staging, "final-result-input.json"),
      canonicalJson(finalInput),
      { flag: "wx" },
    );
    await commitFrozenDirectory(staging, target, "final-result-input.json");
    return { path: target, input: finalInput };
  } catch (error) {
    await writeFile(
      path.join(staging, "failed-input.json"),
      canonicalJson({
        schemaVersion: "tiangong.release.final-result-input-failure.v1",
        inputHash: inspected.inputHash,
        candidateCreated: false,
        publicationAuthorized: false,
        code: error.code ?? "final_input_failed",
        recovery:
          "Reconcile exact recorded registrations; never reuse an occupied version for changed content",
      }),
      { flag: "wx" },
    );
    error.details = { ...error.details, retainedInput: staging };
    throw error;
  } finally {
    // Pool shutdown cannot change a persisted registration outcome, hide its
    // recovery path, or turn an already frozen input into an apparent failure.
    try {
      await authority?.close();
    } catch {
      // The adapter has no business writes during close.
    }
  }
}

// Persisted evidence is checked independently of the preparer's return value.
export function verifyFrozenFinalInput({ input, index, plan, lineage }) {
  requireValue(
    input?.schemaVersion === "tiangong.release.final-result-input.v1" &&
      plan?.schemaVersion === "tiangong.release.final-result-input-plan.v1" &&
      lineage?.schemaVersion === "tiangong.release.final-result-lineage.v1" &&
      index?.schemaVersion === "tiangong.release.canonical-dataset-index.v1" &&
      index.datasetCount === index.datasets?.length &&
      input.candidateQualified === false &&
      input.publicationAuthorized === false &&
      input.indexHash === hashJson(index) &&
      plan.indexHash === input.indexHash &&
      input.lineageHash === hashJson(lineage) &&
      plan.lineageHash === input.lineageHash &&
      hashJson(plan.lineage) === input.lineageHash &&
      Array.isArray(input.results) &&
      Array.isArray(input.selection) &&
      Array.isArray(plan.registrations) &&
      input.results.length > 0 &&
      input.results.length === input.selection.length &&
      input.results.length === plan.registrations.length &&
      hashJson(input.selection) === hashJson(plan.selection) &&
      input.inputHash === plan.inputHash &&
      input.inputHash ===
        hashJson({
          projection: FINAL_RESULT_PROJECTION,
          index,
          results: input.selection,
        }),
    "final_input_binding_invalid",
  );
  const roots = new Map(
    index.datasets
      .filter((e) => e.role === "result_process")
      .map((e) => [key(e), e]),
  );
  const sources = new Map(lineage.results.map((r) => [key(r), r]));
  const seen = new Set();
  for (const [i, row] of input.results.entries()) {
    const selected = input.selection[i];
    const request = plan.registrations[i];
    const receipt = verifyIdentityReceipt(request, {
      ok: true,
      data: row.identityReceipt,
    });
    const k = key(row);
    const source = sources.get(k);
    requireValue(
      !seen.has(k) &&
        roots.has(k) &&
        source &&
        source.canonicalContentHash === row.canonicalContentHash &&
        roots.get(k).canonicalContentHash === row.canonicalContentHash &&
        selected.uuid === row.uuid &&
        selected.version === row.version &&
        source.relationKind === selected.relationKind &&
        hashJson(source.sources) === hashJson(selected.sources) &&
        row.uuid === receipt.result.uuid &&
        row.version === receipt.result.version &&
        hashJson(row) ===
          hashJson({
            ...selected,
            hashDomain: request.hashDomain,
            canonicalContentHash: request.canonicalContentHash,
            contentHash: request.contentHash,
            identityReceipt: receipt,
          }),
      "final_input_binding_invalid",
    );
    seen.add(k);
  }
  requireValue(seen.size === roots.size, "final_input_root_scope");
  return input;
}

export async function loadFinalResultInput(inputDir) {
  const root = path.resolve(inputDir);
  const input = await readLocalJson(root, "final-result-input.json");
  const index = await readLocalJson(root, "canonical-dataset-index.json");
  const plan = await readLocalJson(root, "input-plan.json");
  const lineage = await readLocalJson(root, "source-lineage.json");
  verifyFrozenFinalInput({ input, index, plan, lineage });
  const canonicalRoot = path.join(root, "canonical");
  const requiredFlows = await collectProjectionFlowKeys(index, (entry) =>
    frozenDocument(canonicalRoot, entry),
  );
  const dependencies = createFrozenDependencyStore();
  let charged = Buffer.byteLength(
    canonicalJson({ input, index, plan, lineage }),
  );
  checkBudget("metadata", charged, MAX_METADATA);
  const entries = new Map();
  for (const entry of index.datasets) {
    const document = await frozenDocument(canonicalRoot, entry);
    const k = `${entry.datasetType}:${key(entry)}`;
    requireValue(!entries.has(k), "final_input_binding_invalid");
    entries.set(k, entry);
    if (
      ["flow", "flowproperty", "unitgroup", "lciamethod"].includes(
        entry.datasetType,
      ) &&
      (entry.datasetType !== "flow" ||
        requiredFlows.has(`flow:${entry.uuid}@${entry.version}`))
    ) {
      charged += dependencies.add({ ...entry, document });
      checkBudget("metadata", charged, MAX_METADATA, entry);
    }
  }
  const resolveDependency = dependencies.resolve;
  for (const [ordinal, row] of input.selection.entries()) {
    const entry = entries.get(`process:${key(row)}`);
    const request = identityRegistrationRequest(
      projectFinalResult({
        document: await frozenDocument(canonicalRoot, entry),
        identity: entry,
        layer: row.layer,
        expectedMethods: row.expectedMethods,
        resolveDependency,
      }),
    );
    requireValue(
      hashJson(request) === hashJson(plan.registrations[ordinal]),
      "final_input_registration_drift",
    );
  }
  return { root, canonicalRoot, input, index, plan, lineage };
}
