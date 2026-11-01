import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createFinalResultPublication } from "../adapters/final-result-publication.mjs";
import { createFinalResultActor } from "../adapters/final-result-actor.mjs";
const id = (n) => `87960000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  hash = "a".repeat(64);
const actorId = id(1),
  run = id(2),
  verification = id(3),
  approval = id(4),
  now = new Date().toISOString();
const token = [
  "header",
  Buffer.from(
    JSON.stringify({
      sub: actorId,
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url"),
  "synthetic",
].join(".");
const approvalArgs = {
  releaseRunId: run,
  publishPlanHash: hash,
  verificationId: verification,
  approvalId: approval,
  expectedApprovalId: null,
  expiresAt: now,
  reason: "synthetic",
};
const send = (res, data) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, data }));
};
async function fixture(t, handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers["content-profile"], "api");
    const chunks = [];
    for await (const b of req) chunks.push(b);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push({ url: req.url, body });
    handler(req, res, body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const config = {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    publishableKey: "sb_publishable_synthetic",
    accessToken: token,
  };
  return { calls, config, actor: createFinalResultPublication(config) };
}
test("publication adapter has bounded explicit routes and read-only probe wrapper retains no write capability", async (t) => {
  const f = await fixture(t, (_, res) => send(res, null));
  assert.equal(await f.actor.head(), null);
  assert.equal(await f.actor.run(run), null);
  assert.equal(
    await f.actor.approval({ releaseRunId: run, approvalId: approval }),
    null,
  );
  assert.deepEqual(
    f.calls.map((c) => c.url),
    [
      "/rest/v1/rpc/qry_final_result_publication_head_v2",
      "/rest/v1/rpc/qry_final_result_release_v2",
      "/rest/v1/rpc/qry_final_result_release_approval_v2",
    ],
  );
  assert.equal(f.actor.call, undefined);
  assert.equal(f.actor.probe, undefined);
  const probe = createFinalResultActor(f.config);
  assert.equal(probe.approve, undefined);
  assert.equal(probe.activate, undefined);
  assert.equal(
    f.actor.apiTargetHash,
    createFinalResultPublication({ ...f.config, accessToken: token })
      .apiTargetHash,
  );
  assert.notEqual(
    f.actor.apiTargetHash,
    createFinalResultPublication({
      ...f.config,
      endpoint: "https://example.invalid",
    }).apiTargetHash,
  );
});
test("approve uses exact server identity and returns consumed historical approvals without resurrection", async (t) => {
  const f = await fixture(t, (_, res) =>
    send(res, {
      approvalId: approval,
      approvalHash: hash,
      status: "consumed",
      approvedBy: actorId,
      expiresAt: now,
      reused: true,
    }),
  );
  const result = await f.actor.approve(approvalArgs);
  assert.equal(result.status, "consumed");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, {
    p_release_run_id: run,
    p_publish_plan_hash: hash,
    p_verification_id: verification,
    p_approval_id: approval,
    p_expected_approval_id: null,
    p_expires_at: now,
    p_reason: "synthetic",
  });
});
test("activation preserves noncurrent history instead of asserting it is currently published", async (t) => {
  const f = await fixture(t, (_, res) =>
    send(res, {
      publicationId: id(5),
      releaseRunId: run,
      releaseVersion: "2026.11.0",
      status: "unpublished",
      isCurrent: false,
      publishedAt: now,
      reused: true,
    }),
  );
  const result = await f.actor.activate({
    releaseRunId: run,
    publishPlanHash: hash,
    approvalId: approval,
    approvalHash: hash,
    verificationId: verification,
    idempotencyKey: "exact",
    credentialFingerprint: hash,
  });
  assert.equal(result.isCurrent, false);
  assert.equal(result.status, "unpublished");
  assert.equal(f.calls.length, 1);
});
test("request validation rejects unknown authorization fields and invalid membership before sending", async (t) => {
  const f = await fixture(t, (_, res) => send(res, null));
  for (const patch of [
    { approvedBy: id(9) },
    { expectedApprovalId: "" },
    { reason: "" },
    { expiresAt: "invalid" },
  ])
    assert.throws(() => f.actor.approve({ ...approvalArgs, ...patch }));
  assert.throws(() =>
    f.actor.members({ releaseRunId: run, publishPlanHash: hash, rows: [] }),
  );
  assert.throws(() =>
    f.actor.members({
      releaseRunId: run,
      publishPlanHash: hash,
      rows: [{ uuid: id(9), version: "01.00.000", extra: 1 }],
    }),
  );
  assert.equal(f.calls.length, 0);
});
test("command lost response never retries or exposes remote details and reports unknown outcome", async (t) => {
  const f = await fixture(t, (_, res) => {
    res.destroy();
  });
  await assert.rejects(f.actor.approve(approvalArgs), {
    code: "final_publication_outcome_unknown",
  });
  assert.equal(f.calls.length, 1);
});
test("mismatching command response is an unknown write outcome requiring independent readback", async (t) => {
  const f = await fixture(t, (_, res) =>
    send(res, {
      approvalId: approval,
      approvalHash: hash,
      status: "approved",
      approvedBy: id(99),
      expiresAt: now,
      reused: false,
    }),
  );
  await assert.rejects(f.actor.approve(approvalArgs), {
    code: "final_publication_outcome_unknown",
  });
  assert.equal(f.calls.length, 1);
});
test("known manager denial is preserved without remote message or automatic retry", async (t) => {
  const f = await fixture(t, (_, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        code: "expected_approval_conflict",
        message: "never-print-secret",
      }),
    );
  });
  await assert.rejects(
    f.actor.approve(approvalArgs),
    (e) =>
      e.code === "final_actor_request_denied" &&
      e.details.semanticCode === "expected_approval_conflict" &&
      !JSON.stringify(e).includes("never-print"),
  );
  assert.equal(f.calls.length, 1);
});
test("legacy current format is observed explicitly without inventing v2 hashes", async (t) => {
  const d = {
    publicationId: id(5),
    releaseRunId: run,
    releaseVersion: "26.11.001",
    format: "legacy-four-zip.v1",
    candidateHash: null,
    targetHash: null,
    selectionHash: hash,
  };
  const f = await fixture(t, (_, res) => send(res, d));
  assert.deepEqual(await f.actor.head(), d);
});

test("session audit fingerprints change on token renewal without storing or exposing raw tokens", async (t) => {
  const f = await fixture(t, (_, res) => send(res, null));
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  const renewed = [
    "header",
    Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 60 })).toString(
      "base64url",
    ),
    "synthetic-new",
  ].join(".");
  const other = createFinalResultPublication({
    ...f.config,
    accessToken: renewed,
  });
  assert.equal(other.actorId, f.actor.actorId);
  assert.equal(other.apiTargetHash, f.actor.apiTargetHash);
  assert.match(f.actor.credentialFingerprint, /^[0-9a-f]{64}$/u);
  assert.notEqual(other.credentialFingerprint, f.actor.credentialFingerprint);
  assert.equal(
    createFinalResultActor(f.config).credentialFingerprint,
    undefined,
  );
  assert.ok(!JSON.stringify(f.actor).includes(token));
  assert.ok(!JSON.stringify(other).includes(renewed));
});
