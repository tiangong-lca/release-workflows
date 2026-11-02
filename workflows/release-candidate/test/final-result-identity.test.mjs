import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hashJson } from "../lib/common.mjs";
import { fixture, id, version } from "./fixtures/final-result.mjs";
import {
  projectFinalResult,
  createFrozenDependencyResolver,
} from "../lib/final-result-projection.mjs";
import {
  identityRegistrationRequest,
  verifyIdentityReceipt,
  createFinalResultIdentityStore,
} from "../lib/final-result-identity.mjs";
function request(uuid = id(1)) {
  const f = fixture();
  f.document.processDataSet.processInformation.dataSetInformation[
    "common:UUID"
  ] = uuid;
  return identityRegistrationRequest(
    projectFinalResult({
      document: f.document,
      identity: { uuid, version, canonicalContentHash: hashJson(f.document) },
      layer: f.layer,
      expectedMethods: f.expectedMethods,
      resolveDependency: createFrozenDependencyResolver(
        f.dependencies.map((r) => ({
          ...r,
          canonicalContentHash: hashJson(r.document),
        })),
      ),
    }),
  );
}
function response(r) {
  return {
    ok: true,
    data: {
      schemaVersion: "tiangong.final-result-identity-receipt.v1",
      registrationId: id(90),
      result: r.result,
      hashDomain: r.hashDomain,
      canonicalContentHash: r.canonicalContentHash,
      contentHash: r.contentHash,
      contentRef: `urn:sha256:${r.canonicalContentHash}`,
      createdAt: "2026-11-01T00:00:00Z",
    },
  };
}
function poolFixture(onQuery) {
  const calls = [];
  let released = 0;
  let ended = 0;
  return {
    calls,
    get released() {
      return released;
    },
    get ended() {
      return ended;
    },
    Pool: class {
      on() {}
      async connect() {
        return {
          query: async (sql, args) => {
            calls.push({ sql, args });
            return onQuery(sql, args);
          },
          release() {
            released++;
          },
        };
      }
      async end() {
        ended++;
      }
    },
  };
}
test("identity requests bind complete content plus semantic dependencies and validate exact receipts", () => {
  const r = request();
  assert.equal(r.producer, "release-workflows");
  assert.equal(r.semanticDependencies.length, 5);
  assert.deepEqual(verifyIdentityReceipt(r, response(r)), response(r).data);
  for (const field of [
    "contentHash",
    "canonicalContentHash",
    "hashDomain",
    "contentRef",
    "registrationId",
  ]) {
    const bad = response(r);
    bad.data[field] = "wrong";
    assert.throws(() => verifyIdentityReceipt(r, bad), {
      code: "final_identity_receipt_mismatch",
    });
  }
  const other = response(r);
  other.data = { ...other.data, result: { ...r.result, version: "01.00.001" } };
  assert.throws(() => verifyIdentityReceipt(r, other), {
    code: "final_identity_receipt_mismatch",
  });
  const bad = structuredClone(r);
  bad.semanticDependencies[0].contentHash = "0".repeat(64);
  assert.throws(() => verifyIdentityReceipt(bad, response(r)), {
    code: "final_identity_content_hash_mismatch",
  });
});
test("registry uses a single checked-out transaction, bound JSON and read-only version lookup", async () => {
  const r = request();
  const f = poolFixture(async (sql, args) => ({
    rows: [
      {
        result: sql.includes("svc_result_identity_register")
          ? response(args[0])
          : {
              ok: true,
              data: {
                resultId: r.result.uuid,
                versions: [],
                nextBeforeVersion: null,
              },
            },
      },
    ],
  }));
  const store = createFinalResultIdentityStore({
    connectionString: "fixture-only",
    Pool: f.Pool,
  });
  assert.deepEqual(await store.register(r), response(r).data);
  assert.deepEqual(
    f.calls.map((c) => c.sql),
    [
      "begin",
      "set local role service_role",
      "set local lock_timeout = '5s'",
      "select api.svc_result_identity_register($1::jsonb) as result",
      "commit",
    ],
  );
  assert.deepEqual(f.calls[3].args, [r]);
  assert.deepEqual((await store.versions(r.result.uuid)).versions, []);
  assert.equal(f.calls[5].sql, "begin read only");
  assert.deepEqual(f.calls[8].args, [r.result.uuid, null, 100]);
  await store.close();
  assert.equal(f.released, 2);
  assert.equal(f.ended, 1);
});
test("conflicts and lost commit acknowledgement never allocate a version or leak raw connection errors", async () => {
  for (const [sqlState, at, expected] of [
    [
      "23505",
      "svc_result_identity_register",
      "final_identity_content_conflict",
    ],
    ["55000", "svc_result_identity_register", "final_identity_legacy_occupied"],
    ["ECONNRESET", "commit", "final_identity_outcome_unknown"],
  ]) {
    const r = request();
    const f = poolFixture(async (sql) => {
      if (sql.includes(at))
        throw Object.assign(new Error("secret-fixture-connection"), {
          code: sqlState,
        });
      return { rows: [{ result: response(r) }] };
    });
    const store = createFinalResultIdentityStore({
      connectionString: "fixture-only",
      Pool: f.Pool,
    });
    let error;
    try {
      await store.register(r);
    } catch (e) {
      error = e;
    }
    assert.equal(error.code, expected);
    assert.ok(!JSON.stringify(error).includes("secret-fixture-connection"));
    assert.ok(!error.message.includes("secret-fixture-connection"));
    assert.equal(f.calls.at(-1).sql, "rollback");
    assert.equal(
      f.calls.filter((c) => c.sql.includes("svc_result_identity_register"))
        .length,
      1,
    );
    assert.equal(f.released, 1);
    await store.close();
  }
});
test("malformed requests do not touch the registry; bad version pages never imply availability", async () => {
  const r = request();
  const f = poolFixture(async () => ({
    rows: [
      {
        result: {
          ok: true,
          data: {
            resultId: r.result.uuid,
            versions: [
              {
                version: "01.00.000",
                status: "registered",
                registrationId: id(90),
                hashDomain: r.hashDomain,
                contentHash: r.contentHash,
              },
            ],
            nextBeforeVersion: null,
          },
        },
      },
    ],
  }));
  const store = createFinalResultIdentityStore({
    connectionString: "fixture-only",
    Pool: f.Pool,
  });
  const bad = { ...r, extra: true };
  await assert.rejects(store.register(bad), {
    code: "final_identity_contract_invalid",
  });
  await assert.rejects(store.versions(r.result.uuid, { limit: 257 }), {
    code: "final_identity_contract_invalid",
  });
  assert.equal(f.calls.length, 0);
  await assert.rejects(store.versions(r.result.uuid, { limit: 1 }), {
    code: "final_identity_versions_mismatch",
  });
  await store.close();
});
test(
  "real task-local Database registration agrees with Release canonical hashes and retries",
  { skip: !process.env.RELEASE_IDENTITY_TEST_CONN },
  async () => {
    const address = new URL(process.env.RELEASE_IDENTITY_TEST_CONN);
    assert.equal(address.hostname, "127.0.0.1");
    assert.equal(address.port, "61432");
    assert.equal(address.pathname, "/postgres");
    const store = createFinalResultIdentityStore({
      connectionString: process.env.RELEASE_IDENTITY_TEST_CONN,
    });
    try {
      const r = request(randomUUID());
      assert.deepEqual((await store.versions(r.result.uuid)).versions, []);
      const first = await store.register(r);
      assert.deepEqual(await store.register(r), first);
      const page = await store.versions(r.result.uuid, { limit: 1 });
      assert.equal(page.versions[0].contentHash, r.contentHash);
      assert.equal(page.nextBeforeVersion, version);
      const changed = structuredClone(r);
      changed.canonicalContentHash = "0".repeat(64);
      changed.contentHash = hashJson({
        hashDomain: changed.hashDomain,
        canonicalContentHash: changed.canonicalContentHash,
        semanticDependencies: changed.semanticDependencies,
      });
      await assert.rejects(store.register(changed), {
        code: "final_identity_content_conflict",
      });
      assert.deepEqual(await store.register(r), first);
    } finally {
      await store.close();
    }
  },
);
