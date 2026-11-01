import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fail, hashJson, sha256Bytes } from "./common.mjs";
import { validateContract } from "./contracts.mjs";
import { prepareTransformation } from "./execute.mjs";
import { RESULT_OPERATION } from "./operations.mjs";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

// Verification stays with the Transformation producer. Consumers receive exact
// already-processed bytes; they do not own weighting or solve new LCI/LCIA.
export async function verifyDerivedResultHandoff({
  candidateDir,
  transformationDir,
  specDir = transformationDir,
}) {
  const frozenSpec = await readBoundedJson(
    specDir,
    "transformation-frozen-spec.json",
  );
  validateContract("frozenSpec", frozenSpec);
  if (
    frozenSpec.operation.type !== RESULT_OPERATION ||
    frozenSpec.resultEvidence.disposition !== "derived"
  )
    fail(
      "derived_result_required",
      "Only a frozen Result aggregation can enter Derived Result Materialization",
    );
  const receipt = await readBoundedJson(
    transformationDir,
    "transformation-execution-receipt.json",
  );
  const handoff = await readBoundedJson(
    transformationDir,
    "transformation-handoff.json",
  );
  validateContract("executionReceipt", receipt);
  validateContract("handoff", handoff);
  if (
    handoff.status !== "ready_for_result_materialization" ||
    handoff.nextWorkflow !== "result-materialization" ||
    handoff.transformationFrozenSpecSha256 !== hashJson(frozenSpec) ||
    handoff.transformationExecutionReceiptSha256 !== hashJson(receipt)
  )
    fail(
      "derived_result_handoff_mismatch",
      "Derived Result handoff does not bind its frozen spec and execution receipt",
    );
  const expected = await prepareTransformation({ candidateDir, specDir });
  if (
    hashJson(expected.frozenSpec) !== hashJson(frozenSpec) ||
    hashJson(expected.receipt) !== hashJson(receipt) ||
    hashJson(expected.handoff) !== hashJson(handoff)
  )
    fail(
      "derived_result_evidence_mismatch",
      "Derived Result evidence differs from the producer's verified deterministic output",
    );
  const bytes = await readBoundedArtifact(
    transformationDir,
    `canonical-datasets/${expected.dataset.path}`,
  );
  if (
    bytes.length !== expected.dataset.byteSize ||
    sha256Bytes(bytes) !== expected.dataset.sha256 ||
    !bytes.equals(expected.result.bytes)
  )
    fail(
      "derived_result_bytes_mismatch",
      "Derived Result bytes differ from the hash-bound transformation output",
    );
  return {
    ...expected,
    bytes,
    document: JSON.parse(bytes),
    receiptSha256: hashJson(receipt),
  };
}

async function readBoundedJson(root, relative) {
  return JSON.parse(await readBoundedArtifact(root, relative));
}

async function readBoundedArtifact(root, relative) {
  const base = await realpath(root);
  const requested = path.resolve(base, relative);
  if (!requested.startsWith(`${base}${path.sep}`))
    fail(
      "derived_result_path_escape",
      "Derived Result artifact must stay inside its evidence directory",
    );
  const metadata = await lstat(requested);
  const actual = await realpath(requested);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !actual.startsWith(`${base}${path.sep}`) ||
    metadata.size > MAX_ARTIFACT_BYTES
  )
    fail(
      "derived_result_artifact_invalid",
      "Derived Result evidence must be a bounded regular file inside its directory",
    );
  const bytes = await readFile(actual);
  if (bytes.length > MAX_ARTIFACT_BYTES)
    fail(
      "derived_result_artifact_invalid",
      "Derived Result evidence exceeds the size bound",
    );
  return bytes;
}
