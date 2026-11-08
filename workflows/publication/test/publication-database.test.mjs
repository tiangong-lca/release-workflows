import test from "node:test";
import assert from "node:assert/strict";
import {
  createFinalResultRegistry,
  safePublicationDatabaseDetails,
} from "../adapters/final-result-registry.mjs";
import { preflightFinalResultStorage } from "../lib/final-result-storage.mjs";

const secret = "private-driver-connection-and-password";
const conn = "postgres://operator:password@example.test/postgres";
function poolWithFailure({ connectCode, queryCode, queryAt }) {
  return class {
    on() {}
    async connect() {
      if (connectCode)
        throw Object.assign(new Error(secret), { code: connectCode });
      return {
        async query(sql) {
          if (
            sql === queryAt ||
            (queryAt === "write" && sql.includes("stage_v2"))
          )
            throw Object.assign(new Error(secret), { code: queryCode });
          return {
            rows: [
              {
                result: {
                  ok: true,
                  data: sql.includes("describe") ? null : {},
                },
              },
            ],
          };
        },
        release() {},
      };
    }
    async end() {}
  };
}
const safeError = (code, stage, detail) => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.details.databaseStage, stage);
  assert.equal(error.details.databaseCode ?? error.details.sqlState, detail);
  assert.doesNotMatch(
    error.message + JSON.stringify(error),
    /private-driver|operator:password/,
  );
  return true;
};

test("TLS, DNS and authentication failures cannot be reported as uncertain registry writes", async () => {
  for (const [code, result] of [
    ["SELF_SIGNED_CERT_IN_CHAIN", "final_publication_database_tls_failed"],
    ["ENOTFOUND", "final_publication_database_unavailable"],
    ["28P01", "final_publication_database_auth_failed"],
  ]) {
    const registry = createFinalResultRegistry({
      connectionString: conn,
      Pool: poolWithFailure({ connectCode: code }),
    });
    try {
      await assert.rejects(
        registry.describeCandidate("a".repeat(64), "b".repeat(64)),
        safeError(result, "connect", code),
      );
      await assert.rejects(
        registry.stageQuery({}, "{}", []),
        safeError(result, "connect", code),
      );
    } finally {
      await registry.close();
    }
  }
});

test("read-only timeout/permission failures retain SQLSTATE and have no write-uncertainty claim", async () => {
  for (const [queryCode, code] of [
    ["57014", "final_publication_database_read_timeout"],
    ["42501", "final_publication_database_permission_denied"],
  ]) {
    const registry = createFinalResultRegistry({
      connectionString: conn,
      Pool: poolWithFailure({
        queryCode,
        queryAt:
          "select api.svc_result_candidate_describe_v2($1::text,$2::text) as result",
      }),
    });
    try {
      await assert.rejects(
        registry.describeCandidate("a".repeat(64), "b".repeat(64)),
        safeError(code, "query", queryCode),
      );
    } finally {
      await registry.close();
    }
  }
});

test("dispatched writes and lost commit acknowledgement retain exact-identity reconciliation", async () => {
  for (const queryAt of ["write", "commit"]) {
    const registry = createFinalResultRegistry({
      connectionString: conn,
      Pool: poolWithFailure({ queryCode: "ECONNRESET", queryAt }),
    });
    try {
      await assert.rejects(
        registry.stageQuery({}, "{}", []),
        safeError(
          "final_storage_registry_outcome_unknown",
          queryAt === "commit" ? "commit" : "query",
          "ECONNRESET",
        ),
      );
    } finally {
      await registry.close();
    }
  }
});

test("database diagnostic fields accept only bounded codes and never arbitrary driver details", () => {
  assert.deepEqual(
    safePublicationDatabaseDetails({
      details: {
        sqlState: secret,
        databaseCode: secret,
        databaseStage: secret,
        raw: secret,
        phase: "database_preflight",
      },
    }),
    {
      phase: "database_preflight",
      uploadAttempted: false,
      registryWriteAttempted: false,
    },
  );
});

const plan = {
  candidateHash: "a".repeat(64),
  targetHash: "b".repeat(64),
  inputHash: "c".repeat(64),
  files: [],
  artifacts: [
    {
      artifact: { artifactId: "13300000-0000-4000-8000-000000000001" },
      resultCount: 5741,
    },
  ],
};
test("storage preflight uses only exact read RPCs, accepts absent/partial registry state and refuses drift", async () => {
  const calls = [];
  const registry = {
    async describeQuery(id, target) {
      calls.push(["query", id, target]);
      return null;
    },
    async describeCandidate(id, target) {
      calls.push(["candidate", id, target]);
      return null;
    },
    stageQuery() {
      assert.fail("preflight cannot stage rows");
    },
    sealQuery() {
      assert.fail("preflight cannot seal evidence");
    },
    registerCandidate() {
      assert.fail("preflight cannot register Candidate");
    },
  };
  const result = await preflightFinalResultStorage({ plan, registry });
  assert.deepEqual(calls, [
    ["query", plan.artifacts[0].artifact.artifactId, plan.targetHash],
    ["candidate", plan.candidateHash, plan.targetHash],
  ]);
  assert.equal(result.uploadAttempted, false);
  assert.equal(result.registryWriteAttempted, false);
  registry.describeQuery = async () => ({
    artifact: plan.artifacts[0].artifact,
    inputHash: plan.inputHash,
    resultCount: 5741,
    registeredResultCount: 500,
    readbackReceipt: null,
    publicationAuthorized: false,
  });
  assert.equal(
    (await preflightFinalResultStorage({ plan, registry })).artifacts[0]
      .registeredResultCount,
    500,
  );
  registry.describeQuery = async () => ({
    artifact: { artifactId: "different" },
  });
  await assert.rejects(
    preflightFinalResultStorage({ plan, registry }),
    (error) =>
      error.code === "final_storage_registry_preflight_conflict" &&
      error.details.phase === "database_preflight",
  );
});
