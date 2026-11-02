import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadFinalResultCandidate } from "../../release-candidate/lib/final-result-candidate.mjs";
import { loadFinalResultInput } from "../../release-candidate/lib/final-result-input.mjs";
import { frozenDocument } from "../../release-candidate/lib/final-result-artifacts.mjs";
import {
  createFrozenDependencyResolver,
  projectFinalResult,
  inventoryKey,
} from "../../release-candidate/lib/final-result-projection.mjs";
import { validateFinalResultPublicationPlan } from "./final-result-publication-plan.mjs";
import { canonicalJson, hashJson, sha256Bytes, fail } from "./common.mjs";
const key = (r) => `${r.uuid}@${r.version}`;
const same = (a, b) =>
  a !== undefined && b !== undefined && hashJson(a) === hashJson(b);
function required(v, code = "final_public_readback_mismatch") {
  if (!v)
    fail(
      code,
      "Public Result observation does not match its frozen publication",
    );
}
export async function verifyFinalResultPublicReadback({
  local,
  inputDir,
  actor,
  reader,
  record,
}) {
  const { plan } = validateFinalResultPublicationPlan(local);
  required(
    actor.apiTargetHash === local.apiTargetHash &&
      reader.apiTargetHash === local.apiTargetHash &&
      reader.actorId === actor.actorId,
  );
  const candidate = await loadFinalResultCandidate(local.candidateDir);
  const frozen = await loadFinalResultInput(inputDir);
  required(
    same(candidate.input, frozen.input) && same(candidate.index, frozen.index),
  );
  required(
    sha256Bytes(
      await readFile(path.join(candidate.root, "release-candidate.json")),
    ) === plan.candidateSha256,
  );
  const initial = await actor.run(plan.releaseRunId);
  const pub = initial?.publication;
  required(
    initial &&
      initial.publishPlanHash === local.publishPlanHash &&
      initial.selectionHash === plan.selectionHash &&
      initial.selectionCount === local.members.length &&
      pub?.isCurrent &&
      pub.status === "current" &&
      ["published", "readback_verified"].includes(initial.status),
  );
  // Existing immutable observation can be recovered separately with status.
  required(
    initial.readbackReceipt === null,
    "final_public_readback_already_recorded",
  );
  const startedAt = new Date().toISOString();
  const dependencies = [];
  for (const entry of frozen.index.datasets)
    if (
      ["flow", "flowproperty", "unitgroup", "lciamethod"].includes(
        entry.datasetType,
      )
    )
      dependencies.push({
        ...entry,
        document: await frozenDocument(frozen.canonicalRoot, entry),
      });
  const resolveDependency = createFrozenDependencyResolver(dependencies);
  const entries = new Map(
    frozen.index.datasets
      .filter((e) => e.datasetType === "process")
      .map((e) => [key(e), e]),
  );
  const rows = new Map(candidate.queryCatalog.results.map((r) => [key(r), r]));
  const observations = createHash("sha256").update(
    "tiangong.final-result-public-observations.v1\n",
  );
  let runtimeRevision;
  for (const result of local.members) {
    const row = rows.get(key(result)),
      entry = entries.get(key(result));
    required(row && entry);
    const projection = projectFinalResult({
      document: await frozenDocument(frozen.canonicalRoot, entry),
      identity: entry,
      layer: row.layer,
      expectedMethods: row.expectedMethods,
      resolveDependency,
    });
    required(projection.contentHash === row.contentHash);
    const expectedResult = {
      ...result,
      quantitativeReference: projection.quantitativeReference,
      relationKind: row.relationKind,
    };
    async function query(query) {
      const envelope = await reader.query({
        resultId: result.uuid,
        resultVersion: result.version,
        publicationId: pub.publicationId,
        ...(runtimeRevision ? { runtimeRevision } : {}),
        query,
      });
      required(
        envelope?.schemaVersion === "result.query.response.v2" &&
          envelope.publicationId === pub.publicationId &&
          envelope.releaseVersion === initial.releaseVersion &&
          same(envelope.result, result) &&
          /^[0-9a-f-]{36}$/.test(envelope.runtimeRevision),
      );
      runtimeRevision ??= envelope.runtimeRevision;
      required(envelope.runtimeRevision === runtimeRevision);
      return envelope.data;
    }
    const overview = await query({ kind: "overview" });
    required(
      same(overview, {
        result: expectedResult,
        lciAvailable: true,
        lciaAvailable: row.layer === "lci-lcia",
      }),
    );
    observations.update(hashJson(overview) + "\n");
    // Compare complete rows by the semantic key, independent of HDF5 ordinals.
    const expected = new Map(
      projection.inventory
        .filter((e) => e.value !== 0)
        .map(({ value, amountField, ...item }) => [
          inventoryKey(item),
          {
            key: Object.fromEntries(
              Object.entries(item).filter(
                ([k]) => !["flowName", "flowClassification"].includes(k),
              ),
            ),
            name: item.flowName,
            classification: item.flowClassification,
            amount: value,
          },
        ]),
    );
    let cursor = null,
      count = 0;
    const seen = new Set();
    const cursors = new Set();
    do {
      const data = await query({
        kind: "lci",
        limit: count === 0 ? 1 : 1000,
        cursor,
        filter: null,
      });
      required(
        data &&
          same(data.result, expectedResult) &&
          data.nonzeroCount === expected.size &&
          Array.isArray(data.items) &&
          data.items.length <= (count === 0 ? 1 : 1000),
      );
      for (const item of data.items) {
        const k = inventoryKey(item.key);
        required(!seen.has(k) && same(item, expected.get(k)));
        seen.add(k);
        count++;
      }
      cursor = data.nextCursor;
      required(
        count < expected.size
          ? data.items.length > 0 &&
              typeof cursor === "string" &&
              Buffer.byteLength(cursor) <= 4096 &&
              cursor.length > 0 &&
              !cursors.has(cursor)
          : cursor === null,
      );
      if (cursor !== null) cursors.add(cursor);
      observations.update(hashJson({ ...data, nextCursor: null }) + "\n");
    } while (cursor !== null);
    required(count === expected.size);
    if (row.layer === "lci-lcia") {
      const data = await query({ kind: "lcia" });
      required(
        same(data, {
          result: expectedResult,
          impacts: projection.impacts.map(({ value, ...method }) => ({
            method,
            amount: value,
          })),
        }),
      );
      observations.update(hashJson(data) + "\n");
    }
  }
  const downloads = {};
  for (const format of ["tidas", "ilcd"]) {
    const p = candidate.candidate.packages.find((p) => p.format === format);
    required(p);
    downloads[format] = await reader.download(pub.publicationId, format, {
      name: `result.${format}.zip`,
      sha256: p.sha256,
      byteSize: p.byteSize,
    });
  }
  // Fresh DB descriptor binds the public Edge runtime to its reader binary. A
  // change during the last ZIP fetch or before receipt recording fails closed.
  const descriptor = await actor.descriptor({
    result: local.members[0],
    publicationId: pub.publicationId,
  });
  required(descriptor.runtimeRevision === runtimeRevision);
  const current = await actor.run(plan.releaseRunId);
  required(same(current, initial));
  const observation = {
    schemaVersion: "tiangong.final-result-public-observation.v1",
    releaseRunId: plan.releaseRunId,
    publishPlanHash: local.publishPlanHash,
    publicationId: pub.publicationId,
    candidateHash: initial.candidateHash,
    targetHash: initial.targetHash,
    selectionHash: initial.selectionHash,
    actorId: actor.actorId,
    runtimeRevision,
    readerSha256: descriptor.readerSha256,
    resultCount: local.members.length,
    startedAt,
    verifiedAt: new Date().toISOString(),
    observationsSha256: observations.digest("hex"),
    downloads,
  };
  const observationText = canonicalJson(observation);
  await record({ kind: "public-readback-intent", observationText });
  let receipt;
  try {
    receipt = await actor.recordReadback({
      releaseRunId: plan.releaseRunId,
      publishPlanHash: local.publishPlanHash,
      observationText,
    });
  } catch (e) {
    if (e.code !== "final_publication_outcome_unknown") throw e;
  }
  const recovered = (await actor.run(plan.releaseRunId))?.readbackReceipt;
  required(
    recovered &&
      recovered.observationSha256 ===
        sha256Bytes(Buffer.from(observationText)) &&
      same(recovered.observation, observation) &&
      (!receipt || same(receipt, recovered)),
    "final_public_readback_record_unconfirmed",
  );
  await record({ kind: "public-readback-receipt", receipt: recovered });
  return recovered;
}
