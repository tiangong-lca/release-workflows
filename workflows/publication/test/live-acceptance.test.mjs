import assert from "node:assert/strict";
import test from "node:test";
import { hashJson } from "../lib/common.mjs";
import {
  assertLoopbackEndpoint,
  redact,
  requireLiveEnvironment,
} from "../live/result-only-acceptance.mjs";
import {
  isAmbiguousTransportError,
  invokeResultProcessExecute,
} from "../lib/result-process-transport.mjs";
import { createPublicationApproval } from "../lib/approval.mjs";
import { inspectPublicationTarget } from "../lib/inspection.mjs";
import { loadVerifiedPayload } from "../lib/payload.mjs";
import { prepareResultProcessPublication } from "../lib/result-process.mjs";
import {
  nonCanonicalResultContent,
  writeResultOnlyFixture,
} from "../test-support/publication-fixture.mjs";
import { createPublicationMock } from "../test-support/publication-rpc-mock.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MANAGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FIXTURE = "55555555-5555-4555-8555-555555555555";
// The dedicated task-instance port, not a shared/default one.
const DEDICATED = "http://127.0.0.1:61321";
const BASE_ENV = {
  TIANGONG_RELEASE_LIVE_ACCEPTANCE: "1",
  TIANGONG_LCA_API_BASE_URL: DEDICATED,
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "publishable",
  TIANGONG_LCA_ACCESS_TOKEN: "header.payload.signature",
  TIANGONG_RELEASE_LIVE_FIXTURE_UUID: FIXTURE,
  TIANGONG_RELEASE_LIVE_INSTANCE: "task-instance-a",
  TIANGONG_RELEASE_LIVE_EXPECTED_ENDPOINT: DEDICATED,
};

test("the live runner refuses to start without explicit opt-in", () => {
  const { TIANGONG_RELEASE_LIVE_ACCEPTANCE: _dropped, ...noOptIn } = BASE_ENV;
  assert.throws(
    () => requireLiveEnvironment(noOptIn),
    ({ code }) => code === "live_acceptance_not_opted_in",
  );
  assert.throws(
    () =>
      requireLiveEnvironment({
        ...BASE_ENV,
        TIANGONG_RELEASE_LIVE_ACCEPTANCE: "true",
      }),
    ({ code }) => code === "live_acceptance_not_opted_in",
  );
});

test("the live runner refuses adversarial hostnames, shared ports and malformed URLs", () => {
  // A prefix test would admit these: they are DNS names, not loopback literals.
  for (const url of [
    "http://127.attacker.example:61321",
    "http://127.0.0.1.evil.test:61321",
    "http://localhost.attacker.example:61321",
    "http://127.0.0.1.attacker.example:61321",
  ])
    assert.throws(
      () => assertLoopbackEndpoint(url),
      ({ code }) => code === "live_acceptance_endpoint_not_loopback",
      url,
    );

  for (const url of [
    "https://project.supabase.co",
    "https://api.example.test",
    "http://10.0.0.5:61321",
    "http://192.168.1.20:61321",
    "https://lca.tiangong.earth",
  ])
    assert.throws(
      () => assertLoopbackEndpoint(url),
      ({ code }) => code === "live_acceptance_endpoint_not_loopback",
      url,
    );

  // Shared / default local stack ports are refused even on loopback.
  for (const port of [
    54321, 54322, 55321, 55322, 56321, 56322, 57321, 57322, 58321, 58322,
  ])
    assert.throws(
      () => assertLoopbackEndpoint(`http://127.0.0.1:${port}`),
      ({ code }) => code === "live_acceptance_endpoint_shared_port",
      String(port),
    );
  // A default port with no explicit port is refused too (80 -> shared? no: it is
  // simply not the dedicated instance, so it is accepted only if not shared).
  assert.throws(
    () => assertLoopbackEndpoint("http://127.0.0.1:54321/"),
    ({ code }) => code === "live_acceptance_endpoint_shared_port",
  );

  // Never silently strip a supplied path, query, fragment or userinfo.
  for (const url of [
    "not-a-url",
    "ftp://127.0.0.1:61321",
    "http://127.0.0.1:61321/rest/v1",
    "http://127.0.0.1:61321/?x=1",
    "http://127.0.0.1:61321/#frag",
    "http://user:pass@127.0.0.1:61321",
    "http://user@127.0.0.1:61321",
  ])
    assert.throws(
      () => assertLoopbackEndpoint(url),
      ({ code }) => code === "live_acceptance_endpoint_invalid",
      url,
    );

  // The dedicated task-instance ports are accepted.
  for (const [url, expectedHost, expectedPort] of [
    ["http://127.0.0.1:61321", "127.0.0.1", 61321],
    ["http://localhost:61321", "localhost", 61321],
    ["http://[::1]:63321", "::1", 63321],
    ["http://127.0.0.1:63321", "127.0.0.1", 63321],
  ]) {
    const parsed = assertLoopbackEndpoint(url);
    assert.equal(parsed.host, expectedHost, url);
    assert.equal(parsed.port, expectedPort, url);
  }
});

test("the live runner refuses a secret key, a malformed fixture and a bad timeout", () => {
  assert.throws(
    () =>
      requireLiveEnvironment({
        ...BASE_ENV,
        TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "sb_secret_forbidden",
      }),
    ({ code }) => code === "publication_secret_key_forbidden",
  );
  for (const uuid of [
    "not-a-uuid",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "",
  ]) {
    const env = { ...BASE_ENV };
    if (uuid === "") delete env.TIANGONG_RELEASE_LIVE_FIXTURE_UUID;
    else env.TIANGONG_RELEASE_LIVE_FIXTURE_UUID = uuid;
    assert.throws(
      () => requireLiveEnvironment(env),
      ({ code }) =>
        [
          "live_acceptance_fixture_invalid",
          "live_acceptance_environment_incomplete",
        ].includes(code),
      uuid,
    );
  }
  assert.throws(
    () =>
      requireLiveEnvironment({
        ...BASE_ENV,
        TIANGONG_RELEASE_LIVE_FIXTURE_VERSION: "1.0.0",
      }),
    ({ code }) => code === "live_acceptance_fixture_invalid",
  );

  // The instance label and the exact expected endpoint are both required.
  for (const missing of [
    "TIANGONG_RELEASE_LIVE_INSTANCE",
    "TIANGONG_RELEASE_LIVE_EXPECTED_ENDPOINT",
  ]) {
    const env = { ...BASE_ENV };
    delete env[missing];
    assert.throws(
      () => requireLiveEnvironment(env),
      ({ code }) => code === "live_acceptance_environment_incomplete",
      missing,
    );
  }
  assert.throws(
    () =>
      requireLiveEnvironment({
        ...BASE_ENV,
        TIANGONG_RELEASE_LIVE_INSTANCE: "https://not-a-label.example",
      }),
    ({ code }) => code === "live_acceptance_instance_label_invalid",
  );
  // The declared endpoint must match the URL that will actually be used.
  assert.throws(
    () =>
      requireLiveEnvironment({
        ...BASE_ENV,
        TIANGONG_RELEASE_LIVE_EXPECTED_ENDPOINT: "http://127.0.0.1:63321",
      }),
    ({ code }) => code === "live_acceptance_expected_endpoint_mismatch",
  );

  // Timeouts are validated, bounded, and never NaN.
  for (const timeout of ["0", "-1", "999", "300001", "abc", "NaN", "1e999"]) {
    assert.throws(
      () =>
        requireLiveEnvironment({
          ...BASE_ENV,
          TIANGONG_RELEASE_LIVE_TIMEOUT_MS: timeout,
        }),
      ({ code }) => code === "live_acceptance_timeout_invalid",
      timeout,
    );
  }
  assert.equal(
    requireLiveEnvironment({
      ...BASE_ENV,
      TIANGONG_RELEASE_LIVE_TIMEOUT_MS: "45000",
    }).timeoutMs,
    45000,
  );

  // A complete, opted-in, dedicated-instance environment resolves.
  const config = requireLiveEnvironment(BASE_ENV);
  assert.equal(config.baseUrl, DEDICATED);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 61321);
  assert.equal(config.instanceLabel, "task-instance-a");
  assert.equal(config.fixtureUuid, FIXTURE);
  assert.equal(config.nonManagerToken, null);
  assert.equal(config.version, "01.00.000");
  assert.equal(config.timeoutMs, 30_000);
});

test("the live runner reports no secret material", () => {
  const token = "header.payload.signature";
  const key = "publishable-key-material";
  const message = `failed with ${token} and ${key} in a body`;
  const redacted = redact(message, [token, key]);
  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.includes(key), false);
  assert.equal(redacted.includes("<redacted>"), true);
});

test("result_publication_busy surfaces as a typed 409 without retry", async () => {
  const operation = liveOperation();
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return new Response(
      JSON.stringify({
        ok: false,
        code: "result_publication_busy",
        status: 409,
        message: "Concurrent publication for this actor is already in progress",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  await assert.rejects(
    invokeResultProcessExecute({
      runtime: liveRuntime(),
      operation,
      preparationHash: operation.preparationHash,
      fetchImpl,
    }),
    (error) => {
      // The reviewed semantic class is preserved exactly: a typed 409 the caller
      // can act on, never an ambiguous transport failure.
      assert.equal(error.code, "result_publication_busy");
      assert.equal(error.details.semanticStatus, 409);
      assert.equal(isAmbiguousTransportError(error), false);
      return true;
    },
  );
  // No unbounded or automatic retry: exactly one attempt reached the endpoint.
  assert.equal(attempts, 1);
});

test("unusable envelopes stay typed and are never retried automatically", async () => {
  const operation = liveOperation();
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return new Response("not json", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
  await assert.rejects(
    invokeResultProcessExecute({
      runtime: liveRuntime(),
      operation,
      preparationHash: operation.preparationHash,
      fetchImpl,
    }),
    (error) => {
      assert.equal(error.code, "publication_remote_response_invalid");
      assert.equal(isAmbiguousTransportError(error), true);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("concurrent calls in one session do not share mutable transport state", async () => {
  const operation = liveOperation();
  let concurrent = 0;
  let peak = 0;
  const fetchImpl = async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
    return new Response(
      JSON.stringify({
        ok: false,
        code: "result_publication_busy",
        status: 409,
        message: "busy",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const results = await Promise.allSettled(
    [0, 1, 2].map(() =>
      invokeResultProcessExecute({
        runtime: liveRuntime(),
        operation,
        preparationHash: operation.preparationHash,
        fetchImpl,
      }),
    ),
  );
  // Each call reached the endpoint independently and failed on its own typed
  // error; nothing was serialized through shared mutable state.
  assert.equal(peak > 1, true);
  assert.deepEqual(
    results.map(({ status }) => status),
    ["rejected", "rejected", "rejected"],
  );
  for (const result of results)
    assert.equal(result.reason.code, "result_publication_busy");
});

test("the live fixture satisfies the real payload loader and prepare chain", async (t) => {
  // Regression: the fixture previously hand-rolled a payload-manifest entry that
  // omitted `table`/`payloadPath`/`sourcePackage`/`modelId`. Every offline test
  // passed because they built their own manifest; only a real run against the
  // strict loader failed. This drives the real loader and the real prepare path.
  const root = await mkdtemp(path.join(os.tmpdir(), "live-fixture-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uuid = "651ce01d-1023-4f39-b51d-7a87eae90653";
  const version = "01.00.000";
  const { document, contentText } = nonCanonicalResultContent({
    uuid,
    version,
  });
  const fixture = await writeResultOnlyFixture({ uuid, version, contentText });

  // The strict payload loader must accept the fixture's manifest unchanged.
  const loaded = await loadVerifiedPayload(fixture.payloadDir);
  assert.equal(loaded.datasets.length, 1);
  assert.equal(loaded.datasets[0].payloadPath, fixture.dataset.payloadPath);
  assert.equal(loaded.datasets[0].table, "processes");
  assert.equal(loaded.datasets[0].role, "result_process");

  // And the non-canonical bytes keep the two hash domains distinct.
  assert.notEqual(fixture.dataset.sha256, fixture.dataset.canonicalContentHash);

  const remote = createPublicationMock({ actorUserId: MANAGER });
  const env = {
    TIANGONG_LCA_API_BASE_URL: "https://project.example.test",
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "publishable",
    TIANGONG_LCA_ACCESS_TOKEN: [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: MANAGER })).toString("base64url"),
      "signature",
    ].join("."),
  };
  const inspection = await inspectPublicationTarget({
    planDir: fixture.planDir,
    payloadDir: fixture.payloadDir,
    outDir: path.join(root, "inspection"),
    env,
    fetchImpl: remote.fetch,
  });
  const approval = await createPublicationApproval({
    inspectionDir: inspection.path,
    outDir: path.join(root, "approval"),
    confirmPlanSha256: inspection.executablePlanSha256,
    approvedBy: "guard",
    attestedByUserId: MANAGER,
    reason: "fixture guard",
  });
  const preparation = await prepareResultProcessPublication({
    approvalDir: approval.path,
    payloadDir: fixture.payloadDir,
    outDir: path.join(root, "preparation"),
    env,
    fetchImpl: remote.fetch,
  });
  assert.equal(preparation.preparation.operationCount, 1);
  const [operation] = preparation.preparation.operations;
  assert.equal(operation.contentText, contentText);
  assert.equal(operation.contentSha256, fixture.dataset.sha256);
  assert.equal(
    operation.candidateCanonicalContentHash,
    fixture.dataset.canonicalContentHash,
  );
  // The attestation carries real source hashes, not nulls.
  assert.match(operation.candidateSetHash, /^[0-9a-f]{64}$/u);
  assert.match(operation.sourceManifestHash, /^[0-9a-f]{64}$/u);
});

test("the whole live chain completes against the wire-only mock", async (t) => {
  // Drives every live step offline, so a wiring defect in the runner is caught
  // here rather than during a real DB window. This found two real bugs: the
  // fixture manifest omitting required loader fields, and a conflict probe that
  // reused the published idempotency key instead of using a new one.
  const root = await mkdtemp(path.join(os.tmpdir(), "live-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runLiveAcceptance } = await import("../live/live-acceptance.mjs");
  const mock = createPublicationMock({
    actorUserId: MANAGER,
    managerActive: true,
  });
  const config = {
    baseUrl: DEDICATED,
    host: "127.0.0.1",
    port: 61321,
    publishableKey: "publishable",
    accessToken: [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: MANAGER })).toString("base64url"),
      "signature",
    ].join("."),
    fixtureUuid: "651ce01d-1023-4f39-b51d-7a87eae90653",
    version: "01.00.000",
    instanceLabel: "guard-instance",
    expectedEndpoint: DEDICATED,
    nonManagerToken: null,
    timeoutMs: 30_000,
  };
  const result = await runLiveAcceptance({
    config,
    outDir: root,
    manifestPath: path.join(root, "manifest.json"),
    fetchImpl: mock.fetch,
  });
  assert.equal(result.manifest.outcome, "completed");
  assert.deepEqual(
    result.manifest.steps.map(({ name }) => name),
    [
      "fixture",
      "instance_sanity",
      "inspection",
      "approval",
      "prepare",
      "execute",
      "readback",
      "retry",
      "conflict",
      "generic_read_isolated",
      "non_manager_denial",
    ],
  );
  // Retry proof comes from the retry's own event and a post-retry readback.
  const retry = result.manifest.steps.find(({ name }) => name === "retry");
  assert.equal(retry.observedDisposition, "reused_identical_receipt");
  assert.equal(retry.observedRemoteReceiptId, retry.originalReceiptId);
  assert.equal(retry.postRetryReadbackReceiptId, retry.originalReceiptId);
  const conflict = result.manifest.steps.find(
    ({ name }) => name === "conflict",
  );
  assert.equal(conflict.code, "result_publication_conflict");
  assert.equal(conflict.semanticStatus, 409);
  assert.equal(conflict.keyIsNew, true);
  // The Result identity only ever went through the manager command.
  assert.equal(mock.getRow(config.fixtureUuid, "01.00.000").stateCode, 120);
  assert.equal(mock.commandCounts.create, 0);
  assert.equal(mock.commandCounts.publish, 0);
});

test("a failing live run still leaves a truthful manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runLiveAcceptance } = await import("../live/live-acceptance.mjs");
  const manifestPath = path.join(root, "manifest.json");
  const config = {
    baseUrl: DEDICATED,
    host: "127.0.0.1",
    port: 61321,
    publishableKey: "publishable",
    accessToken: "a.b.c",
    fixtureUuid: "651ce01d-1023-4f39-b51d-7a87eae90653",
    version: "01.00.000",
    instanceLabel: "guard-instance",
    expectedEndpoint: DEDICATED,
    nonManagerToken: null,
    timeoutMs: 30_000,
  };
  // An endpoint that refuses every request.
  const fetchImpl = async () => {
    throw new Error("connection refused");
  };
  await assert.rejects(
    runLiveAcceptance({ config, outDir: root, manifestPath, fetchImpl }),
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.outcome, "failed");
  assert.equal(typeof manifest.error.code, "string");
  // The artifact inventory is present even on failure, so an operator can still
  // find the payload and the planned identity.
  assert.equal(typeof manifest.artifacts.fixture.payloadDir, "string");
  assert.equal(
    manifest.artifacts.fixture.payloadMember.endsWith(".json"),
    true,
  );
  assert.equal(manifest.retainedRows[0].id, config.fixtureUuid);
  // No secret material is recorded.
  assert.equal(JSON.stringify(manifest).includes("a.b.c"), false);
});

function liveRuntime() {
  return {
    projectBaseUrl: "http://127.0.0.1:54321",
    publishableKey: "publishable",
    accessToken: "header.payload.signature",
    actorUserId: MANAGER,
    targetEndpointFingerprint: hashJson({
      projectBaseUrl: "http://127.0.0.1:54321",
    }),
  };
}

function liveOperation() {
  return {
    key: `process:${FIXTURE}@01.00.000`,
    role: "result_process",
    contentType: "result-process",
    table: "processes",
    uuid: FIXTURE,
    version: "01.00.000",
    targetStateCode: 120,
    contentText: '{"processDataSet":{}}\n',
    contentSha256: "a".repeat(64),
    contentHashDomain: "result-process-content.v1",
    contentByteSize: 24,
    candidateContentPath: "datasets/processes/x.json",
    candidateSha256: "a".repeat(64),
    candidateCanonicalContentHash: "b".repeat(64),
    expectedCanonicalContentHash: "b".repeat(64),
    candidateSetHash: "c".repeat(64),
    sourceManifestHash: "d".repeat(64),
    executablePlanHash: "e".repeat(64),
    approvalHash: "f".repeat(64),
    idempotencyKey: "0".repeat(64),
    reason: "live acceptance",
    managerAttestation: "1".repeat(64),
    attestationRowHash: "2".repeat(64),
    preparationHash: "3".repeat(64),
  };
}
