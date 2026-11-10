import assert from "node:assert/strict";
import test from "node:test";

import {
  createResultSetApi,
  ResultSetApiError,
} from "../adapters/result-set-api.mjs";

const jwt =
  "header." +
  Buffer.from(
    JSON.stringify({
      role: "authenticated",
      sub: "123e4567-e89b-42d3-a456-426614174000",
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString("base64url") +
  ".signature";

const env = {
  TIANGONG_LCA_API_BASE_URL: "https://example.supabase.co",
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  TIANGONG_LCA_ACCESS_TOKEN: jwt,
};

const externalResultSet = {
  schemaVersion: "lcia.result-set.v1",
  resultSetId: "123e4567-e89b-42d3-a456-426614174000",
  name: "Steel baseline",
  createdAt: "2026-08-18T08:00:00.000Z",
};

const resultSetReference = {
  id: externalResultSet.resultSetId,
  name: externalResultSet.name,
  createdAt: externalResultSet.createdAt,
  source: {
    system: "tiangong-lca",
    externalSchemaVersion: externalResultSet.schemaVersion,
  },
};

test("calls the actor-scoped ResultSet endpoint without exposing credentials in output", async () => {
  let captured;
  const api = createResultSetApi({
    env,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return Response.json({
        ok: true,
        command: "provider_result_sets_v99",
        data: { items: [{ ...externalResultSet, futureField: true }] },
      });
    },
  });

  assert.deepEqual(await api.list(20), { items: [resultSetReference] });
  assert.equal(
    captured.url,
    "https://example.supabase.co/functions/v1/app_data_product_commands",
  );
  assert.equal(captured.options.headers.Authorization, `Bearer ${jwt}`);
  assert.equal(captured.options.headers.apikey, "sb_publishable_example");
  assert.deepEqual(JSON.parse(captured.options.body), {
    action: "list_result_sets",
    limit: 20,
  });
  assert.equal(JSON.stringify(await api.list(20)).includes(jwt), false);
});

test("classifies an uncertain create transport failure without retrying", async () => {
  let calls = 0;
  const api = createResultSetApi({
    env,
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError("network failed");
    },
  });

  await assert.rejects(
    api.create("Steel baseline"),
    (error) =>
      error instanceof ResultSetApiError &&
      error.code === "remote_outcome_unknown",
  );
  assert.equal(calls, 1);
});

test("classifies a successful create response with an invalid projection as uncertain", async () => {
  const api = createResultSetApi({
    env,
    fetchImpl: async () =>
      Response.json({
        ok: true,
        command: "lcia_result_set_create",
        data: { resultSetId: externalResultSet.resultSetId },
      }),
  });

  await assert.rejects(
    api.create("Steel baseline"),
    (error) =>
      error instanceof ResultSetApiError &&
      error.code === "remote_outcome_unknown",
  );
});

test("requires an actor-scoped JWT-shaped access token", () => {
  assert.throws(
    () =>
      createResultSetApi({
        env: { ...env, TIANGONG_LCA_ACCESS_TOKEN: "service-secret" },
      }),
    (error) =>
      error instanceof ResultSetApiError && error.code === "auth_required",
  );
});

test("rejects a Supabase secret key at the publishable-key boundary", () => {
  assert.throws(
    () =>
      createResultSetApi({
        env: {
          ...env,
          TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "sb_secret_forbidden",
        },
      }),
    (error) =>
      error instanceof ResultSetApiError &&
      error.code === "capability_unavailable",
  );
});
