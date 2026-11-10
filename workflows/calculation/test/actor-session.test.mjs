import assert from "node:assert/strict";
import test from "node:test";

import { resolveActorAccessToken } from "../runtime/actor-session.mjs";

const jwt =
  "header." +
  Buffer.from(
    JSON.stringify({
      role: "authenticated",
      sub: "00000000-0000-4000-8000-000000000140",
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString("base64url") +
  ".signature";
const apiKey = Buffer.from(
  JSON.stringify({ email: "actor@example.com", password: "private-password" }),
).toString("base64");

test("prefers an explicit actor token without network access", async () => {
  let calls = 0;
  assert.equal(
    await resolveActorAccessToken({
      env: { TIANGONG_LCA_ACCESS_TOKEN: jwt },
      fetchImpl: async () => {
        calls += 1;
      },
    }),
    jwt,
  );
  assert.equal(calls, 0);
});

test("exchanges the existing user API key without exposing credentials", async () => {
  let request;
  const token = await resolveActorAccessToken({
    env: {
      TIANGONG_LCA_API_BASE_URL: "https://example.supabase.co/functions/v1",
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "public-key",
      TIANGONG_LCA_API_KEY: apiKey,
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ access_token: jwt });
    },
  });
  assert.equal(token, jwt);
  assert.equal(
    request.url,
    "https://example.supabase.co/auth/v1/token?grant_type=password",
  );
  assert.equal(request.options.headers.apikey, "public-key");
  assert.deepEqual(JSON.parse(request.options.body), {
    email: "actor@example.com",
    password: "private-password",
  });
});

test("reports invalid user credentials without returning provider details", async () => {
  await assert.rejects(
    resolveActorAccessToken({
      env: {
        TIANGONG_LCA_API_BASE_URL: "https://example.supabase.co",
        TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "public-key",
        TIANGONG_LCA_API_KEY: apiKey,
      },
      fetchImpl: async () =>
        Response.json(
          { error_description: "sensitive detail" },
          { status: 400 },
        ),
    }),
    (error) =>
      error.code === "auth_required" &&
      !error.message.includes("sensitive detail"),
  );
});
