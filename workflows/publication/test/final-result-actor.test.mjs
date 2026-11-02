import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createFinalResultActor } from "../adapters/final-result-actor.mjs";
const id = (n) => `87940000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const jwt = (patch = {}) =>
  [
    "header",
    Buffer.from(
      JSON.stringify({
        sub: id(1),
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...patch,
      }),
    ).toString("base64url"),
    "synthetic-signature",
  ].join(".");
const request = {
  releaseRunId: id(2),
  publishPlanHash: "a".repeat(64),
  runtimeRevision: id(3),
};
const data = () => ({
  actorId: id(1),
  ...request,
  artifacts: [],
  nextArtifactCursor: null,
});
const send = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
async function fixture(t, handle, options = {}) {
  const calls = [];
  const token = jwt();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers.apikey, "sb_publishable_synthetic");
    assert.equal(req.headers["content-profile"], "api");
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push({ url: req.url, body });
    handle(req, res, body);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    publishableKey: "sb_publishable_synthetic",
    accessToken: token,
    ...options,
  };
  return { calls, config, actor: createFinalResultActor(config) };
}
test("actor admission uses only fixed authenticated API routes and exact identities", async (t) => {
  const f = await fixture(t, (req, res) =>
    send(res, { ok: true, data: data() }),
  );
  assert.deepEqual(await f.actor.probePage(request), data());
  assert.deepEqual(f.calls[0], {
    url: "/rest/v1/rpc/qry_final_result_release_probe_page_v2",
    body: {
      p_release_run_id: id(2),
      p_publish_plan_hash: "a".repeat(64),
      p_runtime_revision: id(3),
      p_after_artifact_id: null,
      p_limit: 100,
    },
  });
  await f.actor.probe({
    ...request,
    result: { uuid: id(4), version: "01.00.000" },
  });
  assert.equal(
    f.calls[1].url,
    "/rest/v1/rpc/qry_final_result_release_probe_v2",
  );
  assert.equal(f.calls[1].body.p_result_id, id(4));
  assert.equal(f.actor.approve, undefined);
  assert.equal(f.actor.activate, undefined);
});
test("staging pagination cannot continue without pinned runtime or exact bounds", async (t) => {
  const f = await fixture(t, (req, res) =>
    send(res, { ok: true, data: data() }),
  );
  for (const patch of [
    { runtimeRevision: null, afterArtifactId: id(4) },
    { limit: 0 },
    { limit: 101 },
    { releaseRunId: "../elsewhere" },
    { publishPlanHash: "short" },
  ])
    assert.throws(() => f.actor.probePage({ ...request, ...patch }), {
      code: "final_actor_contract_invalid",
    });
  assert.equal(f.calls.length, 0);
});
for (const [name, patch] of [
  ["actor", { actorId: id(9) }],
  ["plan", { publishPlanHash: "b".repeat(64) }],
  ["run", { releaseRunId: id(9) }],
  ["runtime", { runtimeRevision: id(9) }],
])
  test(`actor admission refuses changed ${name}`, async (t) => {
    const f = await fixture(t, (req, res) =>
      send(res, { ok: true, data: { ...data(), ...patch } }),
    );
    await assert.rejects(f.actor.probePage(request), {
      code: "final_actor_binding_invalid",
    });
  });
test("explicit manager denial is sanitized and never retried", async (t) => {
  const f = await fixture(t, (req, res) =>
    send(
      res,
      {
        ok: false,
        code: "not_data_product_manager",
        message: "remote-secret-never-log",
        details: { token: "remote-secret-never-log" },
      },
      200,
    ),
  );
  await assert.rejects(f.actor.probePage(request), (e) => {
    assert.equal(e.code, "final_actor_request_denied");
    assert.equal(e.details.semanticCode, "not_data_product_manager");
    assert.ok(!JSON.stringify(e).includes("remote-secret"));
    assert.ok(!e.message.includes("remote-secret"));
    return true;
  });
  assert.equal(f.calls.length, 1);
});
test("untrusted error code and body are not copied into diagnostics", async (t) => {
  const f = await fixture(t, (req, res) =>
    send(
      res,
      { code: "remote-secret-never-log", message: "remote-secret-never-log" },
      403,
    ),
  );
  await assert.rejects(
    f.actor.probePage(request),
    (e) =>
      e.code === "final_actor_request_denied" &&
      e.details.semanticCode === null &&
      !JSON.stringify(e).includes("remote-secret"),
  );
});
test("redirect never forwards actor credentials", async (t) => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(302, { location: "/credential-sink" });
    res.end();
  });
  await assert.rejects(f.actor.probePage(request), {
    code: "final_actor_unavailable",
  });
  assert.equal(f.calls.length, 1);
});
test("body bytes remain bounded even without Content-Length", async (t) => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('"');
    res.end("x".repeat(2 * 1024 ** 2));
  });
  await assert.rejects(f.actor.probePage(request), {
    code: "final_actor_response_budget",
  });
});
test("timeout covers a stalled response body", async (t) => {
  const f = await fixture(
    t,
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    },
    { timeoutMs: 100 },
  );
  await assert.rejects(f.actor.probePage(request), {
    code: "final_actor_unavailable",
  });
});
test("caller cancellation aborts in-flight actor admission", async (t) => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  });
  const controller = new AbortController();
  const pending = f.actor.probePage(request, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "final_actor_unavailable" });
});
test("service credentials, wrong actor class and unsafe targets fail before network", async (t) => {
  const f = await fixture(t, () => assert.fail("unexpected network"));
  for (const patch of [
    { accessToken: jwt({ role: "service_role" }) },
    { accessToken: jwt({ role: "anon" }) },
    { accessToken: jwt({ sub: "bad" }) },
    { accessToken: jwt({ exp: null }) },
    { publishableKey: "sb_secret_never_send" },
    { publishableKey: jwt({ role: "service_role" }) },
    { endpoint: "http://example.com" },
    { endpoint: "https://user:secret@example.com" },
    { endpoint: "https://example.com/rest/v1" },
    { endpoint: "https://example.com/?target=other" },
  ])
    assert.throws(() => createFinalResultActor({ ...f.config, ...patch }));
  const expired = createFinalResultActor({
    ...f.config,
    accessToken: jwt({ exp: 0 }),
  });
  await assert.rejects(expired.probePage(request), {
    code: "final_actor_session_expired",
  });
  assert.equal(f.calls.length, 0);
});
