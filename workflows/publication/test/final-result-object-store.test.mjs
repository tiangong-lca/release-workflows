import test from "node:test";
import assert from "node:assert/strict";
import { finalResultStorageTarget } from "../adapters/final-result-object-store.mjs";
import { fixture, ref, target } from "./fixtures/final-storage.mjs";
test("target identity binds database, storage origin and prefix without credentials", () => {
  const a = finalResultStorageTarget(target);
  assert.notEqual(
    a.targetHash,
    finalResultStorageTarget({ ...target, databaseTargetHash: "e".repeat(64) })
      .targetHash,
  );
  assert.notEqual(
    a.targetHash,
    finalResultStorageTarget({ ...target, prefix: "another" }).targetHash,
  );
  for (const bad of [
    { prefix: "../escape" },
    { endpoint: "http://example.com" },
    { endpoint: "https://user:password@example.com" },
    { endpoint: "https://example.com/path" },
  ])
    assert.throws(() => finalResultStorageTarget({ ...target, ...bad }), {
      code: "final_storage_contract_invalid",
    });
});

test("real SDK conditionally PUTs then full-GET verifies; exact retry is read-only", async (t) => {
  const f = await fixture(t);
  const first = await f.store.ensureQuery(ref, f.descriptor, f.filePath);
  assert.equal(first.reused, false);
  assert.deepEqual(first.file, f.descriptor);
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["GET", "PUT", "GET"],
  );
  assert.equal(
    (await f.store.ensureQuery(ref, f.descriptor, f.filePath)).reused,
    true,
  );
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["GET", "PUT", "GET", "GET"],
  );
  assert.equal(f.objects.get(f.key).toString(), f.bytes.toString());
});

test("existing wrong object is rejected even with an ETag and is never overwritten", async (t) => {
  const f = await fixture(t);
  f.objects.set(f.key, Buffer.alloc(f.bytes.length, 7));
  await assert.rejects(f.store.ensureQuery(ref, f.descriptor, f.filePath), {
    code: "final_storage_content_conflict",
  });
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["GET"],
  );
});

for (const mode of ["race-same", "lost-ack"])
  test(`${mode}: recover exact bytes after an uncertain conditional write`, async (t) => {
    const f = await fixture(t, { mode });
    assert.equal(
      (await f.store.ensureQuery(ref, f.descriptor, f.filePath)).reused,
      true,
    );
    assert.equal(f.requests.filter((r) => r.method === "PUT").length, 1);
    assert.equal(f.requests.at(-1).method, "GET");
  });

test("412 with a different winner fails full readback without retry overwrite", async (t) => {
  const f = await fixture(t, { mode: "race-different" });
  await assert.rejects(f.store.ensureQuery(ref, f.descriptor, f.filePath), {
    code: "final_storage_content_conflict",
  });
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 1);
});

test("multipart uses bounded ordered parts and conditional completion followed by full GET", async (t) => {
  const f = await fixture(t, { bytes: Buffer.alloc(16 * 1024 ** 2 + 7, 42) });
  assert.equal(
    (await f.store.ensureQuery(ref, f.descriptor, f.filePath)).reused,
    false,
  );
  assert.deepEqual(
    f.requests.filter((r) => r.method === "PUT").map((r) => r.bytes),
    [16 * 1024 ** 2, 7],
  );
  assert.equal(
    f.requests.find((r) => r.method === "POST" && r.search.includes("uploadId"))
      .conditional,
    "*",
  );
  assert.equal(f.parts.size, 0);
  assert.deepEqual(f.objects.get(f.key), f.bytes);
});

test("multipart conflict aborts only its own parts and reconciles matching winner", async (t) => {
  const f = await fixture(t, {
    mode: "multipart-race",
    bytes: Buffer.alloc(16 * 1024 ** 2 + 7, 43),
  });
  const result = await f.store.ensureQuery(ref, f.descriptor, f.filePath);
  assert.equal(result.reused, true);
  assert.equal(result.multipartCleanupRequired, false);
  assert.equal(f.parts.size, 0);
  assert.equal(f.requests.filter((r) => r.method === "DELETE").length, 1);
});

test("local multipart drift aborts parts before completion and never creates final object", async (t) => {
  const f = await fixture(t, { bytes: Buffer.alloc(16 * 1024 ** 2 + 7, 44) });
  await assert.rejects(
    f.store.ensureQuery(
      ref,
      { ...f.descriptor, sha256: "b".repeat(64) },
      f.filePath,
    ),
    { code: "final_storage_local_drift" },
  );
  assert.equal(f.parts.size, 0);
  assert.equal(f.objects.size, 0);
  assert.equal(
    f.requests.filter(
      (r) => r.method === "POST" && r.search.includes("uploadId"),
    ).length,
    0,
  );
});

test("stalled full readback has a bounded deadline", async (t) => {
  const f = await fixture(t, { mode: "stall", timeoutMs: 100 });
  f.objects.set(f.key, f.bytes);
  await assert.rejects(
    f.store.ensureQuery(ref, f.descriptor, f.filePath),
    (e) =>
      [
        "final_storage_readback_failed",
        "final_storage_content_conflict",
      ].includes(e.code),
  );
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["GET"],
  );
});

test("provider failures are sanitized and never turn into upload authorization", async (t) => {
  const f = await fixture(t, { mode: "forbidden" });
  await assert.rejects(
    f.store.ensureQuery(ref, f.descriptor, f.filePath),
    (e) =>
      e.code === "final_storage_readback_failed" &&
      !JSON.stringify(e).includes("provider-secret"),
  );
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["GET"],
  );
});

test("object names and manifest bindings cannot become arbitrary storage paths", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.store.ensureQuery(
      ref,
      { ...f.descriptor, name: "../secret" },
      f.filePath,
    ),
    { code: "final_storage_contract_invalid" },
  );
  await assert.rejects(
    f.store.ensureQuery(
      ref,
      { ...f.descriptor, name: "manifest.json" },
      f.filePath,
    ),
    { code: "final_storage_contract_invalid" },
  );
  await assert.rejects(
    f.store.ensureCandidate(
      "a".repeat(64),
      { ...f.descriptor, name: "release-candidate.json" },
      f.filePath,
    ),
    { code: "final_storage_contract_invalid" },
  );
  assert.equal(f.requests.length, 0);
});

test("lost multipart creation ACK reports unconfirmed cleanup without inventing an upload id", async (t) => {
  const f = await fixture(t, {
    mode: "create-lost-ack",
    bytes: Buffer.alloc(16 * 1024 ** 2 + 7, 45),
  });
  await assert.rejects(
    f.store.ensureQuery(ref, f.descriptor, f.filePath),
    (e) =>
      e.code === "final_storage_upload_unknown" &&
      e.details.multipartCleanupRequired === true,
  );
  assert.equal(f.objects.size, 0);
  assert.equal(f.parts.size, 1);
  assert.equal(f.requests.filter((r) => r.method === "DELETE").length, 0);
});
test("failed abort remains explicit even when local drift was the original failure", async (t) => {
  const f = await fixture(t, {
    mode: "abort-failure",
    bytes: Buffer.alloc(16 * 1024 ** 2 + 7, 46),
  });
  await assert.rejects(
    f.store.ensureQuery(
      ref,
      { ...f.descriptor, sha256: "b".repeat(64) },
      f.filePath,
    ),
    (e) =>
      e.code === "final_storage_local_drift" &&
      e.details.multipartCleanupRequired === true,
  );
  assert.equal(f.objects.size, 0);
  assert.equal(f.parts.size, 1);
});

test("readiness GETs never repair missing files or alter corrupt objects", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.verifyQuery(ref, f.descriptor), {
    code: "final_storage_object_missing",
  });
  f.objects.set(f.key, f.bytes);
  assert.deepEqual(
    (await f.store.verifyQuery(ref, f.descriptor)).file,
    f.descriptor,
  );
  f.objects.set(f.key, Buffer.alloc(f.bytes.length, 7));
  await assert.rejects(f.store.verifyQuery(ref, f.descriptor), {
    code: "final_storage_content_conflict",
  });
  const candidateHash = f.descriptor.sha256;
  const file = { ...f.descriptor, name: "release-candidate.json" };
  await assert.rejects(f.store.verifyCandidate(candidateHash, file), {
    code: "final_storage_object_missing",
  });
  f.objects.set(
    `/synthetic-results/test-owned/release-candidates/${candidateHash}/release-candidate.json`,
    f.bytes,
  );
  assert.deepEqual(
    (await f.store.verifyCandidate(candidateHash, file)).file,
    file,
  );
  assert.ok(f.requests.every((request) => request.method === "GET"));
});
