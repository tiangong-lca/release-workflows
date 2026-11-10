import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  finalizePortalLciaProjection,
  preparePortalLciaPackagePublicationPlan,
  preparePortalLciaProjectionPlan,
  publishPortalLciaPackage,
  revokePortalLciaProjectionPublication,
  verifyPortalLciaProjectionPublication,
} from "../lib/portal-lcia-projection.mjs";
import { replyTemplateFor } from "../reply-template-registry.mjs";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECTION_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const PACKAGE_ID = "33333333-3333-4333-8333-333333333333";
const PUBLICATION_ID = "44444444-4444-4444-8444-444444444444";
const BINDING_ID = "55555555-5555-4555-8555-555555555555";
const IMPACT_ID = "66666666-6666-4666-8666-666666666666";
const TOKEN = [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({
      sub: ACTOR,
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString("base64url"),
  "signature",
].join(".");
const ENV = {
  TIANGONG_LCA_API_BASE_URL: "https://projection.example.test",
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "publishable",
  TIANGONG_LCA_ACCESS_TOKEN: TOKEN,
};
const CLOCK = () => new Date("2026-08-26T01:00:00.000Z");
const PUBLISHED_AT = "2026-08-26T00:00:00.123456Z";
const FINALIZED_AT = "2026-08-26T00:01:00.234567Z";
const REVOKED_AT = "2026-08-26T00:02:00.345678Z";
const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

test("V3 package publication freezes exact evidence before projection finalize and independent visibility readback", async (t) => {
  const root = await temporaryRoot(t);
  const remote = createProjectionRemote();
  const packagePlan = await preparePackagePlan(root, remote, "package-plan");
  assert.equal(packagePlan.plan.package.id, PACKAGE_ID);
  assert.equal(packagePlan.plan.package.resultHash, "1".repeat(64));
  assert.equal(packagePlan.plan.artifacts.resultArtifactSha256, "a".repeat(64));
  assert.equal(packagePlan.plan.currentPublication, null);
  assert.equal(remote.counts.packagePublish, 0);

  await assert.rejects(
    publishPortalLciaPackage({
      packagePlanDir: packagePlan.path,
      confirmPlanSha256: "0".repeat(64),
      outDir: path.join(root, "wrong-package-confirmation"),
      env: ENV,
      fetchImpl: remote.fetch,
    }),
    ({ code }) =>
      code === "portal_lcia_package_publication_confirmation_mismatch",
  );
  assert.equal(remote.counts.packagePublish, 0);

  const packagePublication = await publishPackage(
    root,
    remote,
    packagePlan,
    "package-publication",
  );
  assert.equal(packagePublication.event.disposition, "published");
  assert.equal(
    packagePublication.event.observation.independentlyReadBack,
    true,
  );
  assert.equal(
    packagePublication.event.observation.reasonPersistence,
    "recorded",
  );
  assert.equal(packagePublication.event.observation.publishedAt, PUBLISHED_AT);
  assert.equal(
    packagePublication.event.observation.databasePublishPlanHash,
    packagePlan.plan.publishPlanHash,
  );

  const projectionPlan = await prepareProjectionPlan(
    root,
    remote,
    packagePublication,
    "projection-plan",
  );
  assert.equal(
    projectionPlan.plan.packagePublishedEventSha256,
    packagePublication.eventSha256,
  );
  const finalized = await finalizeProjection(
    root,
    remote,
    projectionPlan,
    "finalized",
  );
  assert.equal(finalized.event.observation.independentReadbackVerified, false);
  const verified = await verifyPortalLciaProjectionPublication({
    finalizationDir: finalized.path,
    outDir: path.join(root, "verified"),
    env: ENV,
    fetchImpl: remote.fetch,
    now: CLOCK,
  });
  assert.equal(verified.event.observation.status, "verified");
  assert.equal(verified.event.observation.isCurrent, true);
  assert.equal(verified.event.observation.isPubliclyVisible, true);
  assert.equal(verified.event.observation.finalizedAt, FINALIZED_AT);

  assert.doesNotMatch(
    JSON.stringify([
      packagePlan.plan,
      packagePublication.event,
      projectionPlan.plan,
      finalized.event,
      verified.event,
    ]),
    /https?:\/\/|s3:\/\/|bucket|locator/iu,
  );

  const persisted = await readFile(
    path.join(verified.path, "portal-lcia-projection-verified-event.json"),
    "utf8",
  );
  assert.doesNotMatch(persisted, /https?:\/\/|s3:\/\/|bucket|locator/iu);
});

test("Package publication survives process restart and reuses the original DB plan hash", async (t) => {
  const root = await temporaryRoot(t);
  const remote = createProjectionRemote();
  const plan = await preparePackagePlan(root, remote, "plan");
  const first = await publishPackage(root, remote, plan, "first");
  assert.equal(first.disposition, "published");
  assert.equal(first.event.parentArtifactSha256, plan.planSha256);

  const retry = await publishPackage(root, remote, plan, "retry");
  assert.equal(retry.disposition, "reused");
  assert.equal(
    retry.event.observation.reasonPersistence,
    "not_rewritten_on_reuse",
  );
  assert.equal("publishResponseSha256" in retry.event, false);
  assert.equal("freshPrepareEvidenceSha256" in retry.event, false);
  assert.equal(remote.counts.packagePublish, 2);

  remote.packagePrepareData.artifacts.bundleContentHash = "0".repeat(64);
  await assert.rejects(
    publishPackage(root, remote, plan, "tampered-retry"),
    ({ code }) =>
      code === "portal_lcia_package_publication_reuse_evidence_mismatch",
  );
});

test("Package publication reconciles fetch loss and response-body loss through an exact audited retry", async (t) => {
  for (const lossMode of ["fetch", "body"]) {
    const root = await temporaryRoot(t, lossMode);
    const remote = createProjectionRemote();
    const plan = await preparePackagePlan(root, remote, "plan");
    remote.loseNextPackagePublish = lossMode;
    const published = await publishPackage(root, remote, plan, "published");
    assert.equal(published.event.disposition, "reconciled_after_response_loss");
    assert.equal(
      published.event.observation.reasonPersistence,
      "unknown_after_response_loss",
    );
    assert.equal(remote.counts.packagePublish, 2);
  }
});

test("Package publication drift and prior non-current history conflict are terminal", async (t) => {
  const root = await temporaryRoot(t);
  const driftRemote = createProjectionRemote();
  const driftPlan = await preparePackagePlan(root, driftRemote, "drift-plan");
  driftRemote.mutatePackagePrepare({
    publishPlanHash: "0".repeat(64),
    currentProcessSetHash: "f".repeat(64),
  });
  await assert.rejects(
    publishPackage(root, driftRemote, driftPlan, "drift-publish"),
    ({ code, details }) => {
      assert.equal(code, "publish_plan_drift");
      assert.notEqual(details?.safeRetry, true);
      return true;
    },
  );

  const conflictRemote = createProjectionRemote();
  const conflictPlan = await preparePackagePlan(
    root,
    conflictRemote,
    "conflict-plan",
  );
  conflictRemote.packageHistoryConflict = true;
  await assert.rejects(
    publishPackage(root, conflictRemote, conflictPlan, "conflict-publish"),
    ({ code, details }) => {
      assert.equal(code, "package_publication_conflict");
      assert.notEqual(details?.safeRetry, true);
      return true;
    },
  );
});

test("Projection finalize requires exact confirmation, supports retry, and rejects evidence drift or conflict", async (t) => {
  const root = await temporaryRoot(t);
  const remote = createProjectionRemote();
  const { projectionPlan } = await prepareFullPlan(root, remote, "base");
  await assert.rejects(
    finalizePortalLciaProjection({
      planDir: projectionPlan.path,
      outDir: path.join(root, "wrong-confirmation"),
      confirmPlanSha256: "0".repeat(64),
      env: ENV,
      fetchImpl: remote.fetch,
    }),
    ({ code }) => code === "portal_lcia_projection_confirmation_mismatch",
  );
  assert.equal(remote.counts.finalize, 0);
  const first = await finalizeProjection(root, remote, projectionPlan, "first");
  const retry = await finalizeProjection(root, remote, projectionPlan, "retry");
  assert.equal(first.disposition, "created");
  assert.equal(retry.disposition, "reused");

  const driftRemote = createProjectionRemote();
  const { projectionPlan: driftPlan } = await prepareFullPlan(
    root,
    driftRemote,
    "drift",
  );
  driftRemote.prepareData.packageResultHash = "0".repeat(64);
  await assert.rejects(
    finalizeProjection(root, driftRemote, driftPlan, "drift-finalize"),
    ({ code }) => code === "portal_lcia_projection_prepare_drift",
  );
  assert.equal(driftRemote.counts.finalize, 0);

  const conflictRemote = createProjectionRemote();
  const { projectionPlan: conflictPlan } = await prepareFullPlan(
    root,
    conflictRemote,
    "conflict",
  );
  conflictRemote.forceFinalizeConflict = true;
  await assert.rejects(
    finalizeProjection(root, conflictRemote, conflictPlan, "conflict-finalize"),
    ({ code }) => code === "projection_conflict",
  );
});

test("Projection finalize reconciles both fetch loss and response-body loss", async (t) => {
  for (const lossMode of ["fetch", "body"]) {
    const root = await temporaryRoot(t, lossMode);
    const remote = createProjectionRemote();
    const { projectionPlan } = await prepareFullPlan(root, remote, "base");
    remote.loseNextFinalizeResponse = lossMode;
    const finalized = await finalizeProjection(
      root,
      remote,
      projectionPlan,
      "finalized",
    );
    assert.equal(finalized.disposition, "reconciled_after_response_loss");
    assert.equal(finalized.event.eventType, "projection_finalized");
    assert.equal("reconciliationReadbackSha256" in finalized.event, false);
  }
});

test("Superseded, unpublished, or hidden projections cannot produce a verified event", async (t) => {
  for (const lifecycle of ["superseded", "unpublished"]) {
    const root = await temporaryRoot(t, lifecycle);
    const remote = createProjectionRemote();
    const { projectionPlan } = await prepareFullPlan(root, remote, "base");
    const finalized = await finalizeProjection(
      root,
      remote,
      projectionPlan,
      "finalized",
    );
    remote.currentLifecycle = lifecycle;
    await assert.rejects(
      verifyPortalLciaProjectionPublication({
        finalizationDir: finalized.path,
        outDir: path.join(root, "verify-inactive"),
        env: ENV,
        fetchImpl: remote.fetch,
      }),
      ({ code }) => code === "portal_lcia_projection_publication_not_current",
    );
  }

  const root = await temporaryRoot(t, "hidden");
  const remote = createProjectionRemote();
  const { projectionPlan } = await prepareFullPlan(root, remote, "base");
  const finalized = await finalizeProjection(
    root,
    remote,
    projectionPlan,
    "finalized",
  );
  remote.publiclyVisible = false;
  remote.readbackIsCurrentOverride = true;
  await assert.rejects(
    verifyPortalLciaProjectionPublication({
      finalizationDir: finalized.path,
      outDir: path.join(root, "verify-hidden"),
      env: ENV,
      fetchImpl: remote.fetch,
    }),
    ({ code }) => code === "portal_lcia_projection_publication_not_current",
  );
});

test("Projection revoke exact confirmation, changed-reason replay, and response loss remain truthful", async (t) => {
  const root = await temporaryRoot(t);
  const remote = createProjectionRemote();
  const { projectionPlan } = await prepareFullPlan(root, remote, "base");
  const finalized = await finalizeProjection(
    root,
    remote,
    projectionPlan,
    "finalized",
  );
  await assert.rejects(
    revokePortalLciaProjectionPublication({
      finalizationDir: finalized.path,
      outDir: path.join(root, "wrong-revoke"),
      confirmFinalizedEventSha256: "0".repeat(64),
      reason: "withdraw public projection",
      env: ENV,
      fetchImpl: remote.fetch,
    }),
    ({ code }) =>
      code === "portal_lcia_projection_revoke_confirmation_mismatch",
  );
  const revoked = await revokeProjection(
    root,
    remote,
    finalized,
    "revoked",
    "withdraw public projection",
  );
  assert.equal(revoked.event.observation.reasonPersistence, "recorded");
  assert.equal(revoked.event.observation.isPubliclyVisible, false);

  const retried = await revokeProjection(
    root,
    remote,
    finalized,
    "revoked-retry",
    "a different retry reason",
  );
  assert.equal(retried.event.disposition, "reused");
  assert.equal(
    retried.event.observation.requestedReason,
    "a different retry reason",
  );
  assert.equal(
    retried.event.observation.reasonPersistence,
    "not_rewritten_on_reuse",
  );

  const responseLossRoot = await temporaryRoot(t, "revoke-loss");
  const responseLossRemote = createProjectionRemote();
  const { projectionPlan: lossPlan } = await prepareFullPlan(
    responseLossRoot,
    responseLossRemote,
    "base",
  );
  const lossFinalized = await finalizeProjection(
    responseLossRoot,
    responseLossRemote,
    lossPlan,
    "finalized",
  );
  responseLossRemote.loseNextRevokeResponse = "body";
  const reconciled = await revokeProjection(
    responseLossRoot,
    responseLossRemote,
    lossFinalized,
    "revoked",
    "emergency withdrawal",
  );
  assert.equal(
    reconciled.event.observation.reasonPersistence,
    "unknown_after_response_loss",
  );
});

test("Portal LCIA package/projection contracts are strict Draft 2020-12 schemas", async () => {
  const files = [
    "portal-lcia-package-publication-plan.v1.schema.json",
    "portal-lcia-projection-plan.v1.schema.json",
    "portal-lcia-publication-event.v1.schema.json",
  ];
  for (const file of files) {
    const schema = JSON.parse(
      await readFile(new URL(`../contracts/${file}`, import.meta.url), "utf8"),
    );
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      [...schema.required].sort(),
    );
  }
});

test("Projection CLI exposes the opt-in stages and groups reply guidance by semantics", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, "--help"]);
  const commands = [
    "projection package-plan",
    "projection package-publish",
    "projection prepare",
    "projection finalize",
    "projection verify",
    "projection revoke",
  ];
  for (const command of commands)
    assert.match(stdout, new RegExp(command, "u"));

  for (const command of ["projection package-plan", "projection prepare"])
    assert.equal(
      replyTemplateFor(command, { ok: true }).id,
      "portal-lcia-plan-prepared",
    );
  for (const command of [
    "projection package-publish",
    "projection finalize",
    "projection verify",
    "projection revoke",
  ])
    assert.equal(
      replyTemplateFor(command, { ok: true }).id,
      "portal-lcia-publication-event",
    );

  assert.deepEqual(
    (await readdir(new URL("../reply-templates/", import.meta.url)))
      .filter((file) => file.startsWith("portal-lcia-"))
      .sort(),
    [
      "portal-lcia-command-failed.md",
      "portal-lcia-plan-prepared.md",
      "portal-lcia-publication-event.md",
    ],
  );

  await assert.rejects(
    execFileAsync(process.execPath, [
      CLI,
      "projection",
      "package-publish",
      "--json",
    ]),
    (error) => {
      const payload = JSON.parse(error.stderr);
      assert.equal(payload.error.code, "invalid_arguments");
      assert.equal(payload.replyTemplate.id, "portal-lcia-command-failed");
      return true;
    },
  );
});

test("Portal LCIA commands reject a service-role actor token before RPC access", async (t) => {
  const root = await temporaryRoot(t);
  const remote = createProjectionRemote();
  const serviceToken = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: ACTOR, role: "service_role" })).toString(
      "base64url",
    ),
    "signature",
  ].join(".");
  await assert.rejects(
    preparePortalLciaPackagePublicationPlan({
      packageId: PACKAGE_ID,
      displayDefaultImpactCategory: IMPACT_ID,
      reason: "publish Portal LCIA projection",
      outDir: path.join(root, "plan"),
      env: { ...ENV, TIANGONG_LCA_ACCESS_TOKEN: serviceToken },
      fetchImpl: remote.fetch,
    }),
    ({ code }) => code === "auth_required",
  );
  assert.equal(remote.counts.packagePrepare, 0);
});

async function prepareFullPlan(root, remote, prefix) {
  const packagePlan = await preparePackagePlan(
    root,
    remote,
    `${prefix}-package-plan`,
  );
  const packagePublication = await publishPackage(
    root,
    remote,
    packagePlan,
    `${prefix}-package-publication`,
  );
  const projectionPlan = await prepareProjectionPlan(
    root,
    remote,
    packagePublication,
    `${prefix}-projection-plan`,
  );
  return { packagePlan, packagePublication, projectionPlan };
}

async function preparePackagePlan(root, remote, name) {
  return preparePortalLciaPackagePublicationPlan({
    packageId: PACKAGE_ID,
    displayDefaultImpactCategory: IMPACT_ID,
    reason: "publish Portal LCIA projection",
    outDir: path.join(root, name),
    env: ENV,
    fetchImpl: remote.fetch,
    now: CLOCK,
  });
}

async function publishPackage(root, remote, plan, name) {
  return publishPortalLciaPackage({
    packagePlanDir: plan.path,
    confirmPlanSha256: plan.planSha256,
    outDir: path.join(root, name),
    env: ENV,
    fetchImpl: remote.fetch,
    now: CLOCK,
  });
}

async function prepareProjectionPlan(root, remote, publication, name) {
  return preparePortalLciaProjectionPlan({
    packagePublicationDir: publication.path,
    outDir: path.join(root, name),
    env: ENV,
    fetchImpl: remote.fetch,
    now: CLOCK,
  });
}

async function finalizeProjection(root, remote, plan, name) {
  return finalizePortalLciaProjection({
    planDir: plan.path,
    outDir: path.join(root, name),
    confirmPlanSha256: plan.planSha256,
    env: ENV,
    fetchImpl: remote.fetch,
    now: CLOCK,
  });
}

async function revokeProjection(root, remote, finalized, name, reason) {
  return revokePortalLciaProjectionPublication({
    finalizationDir: finalized.path,
    outDir: path.join(root, name),
    confirmFinalizedEventSha256: finalized.eventSha256,
    reason,
    env: ENV,
    fetchImpl: remote.fetch,
    now: CLOCK,
  });
}

async function temporaryRoot(t, suffix = "") {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `portal-lcia-projection-${suffix}`),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function createProjectionRemote() {
  const remote = {
    packagePrepareData: packagePrepareData(),
    prepareData: projectionPrepareData(),
    counts: {
      packagePrepare: 0,
      packagePublish: 0,
      prepare: 0,
      finalize: 0,
      readback: 0,
      revoke: 0,
    },
    packagePublication: null,
    projectionBinding: null,
    currentLifecycle: "current",
    publiclyVisible: true,
    readbackIsCurrentOverride: null,
    packageHistoryConflict: false,
    forceFinalizeConflict: false,
    loseNextPackagePublish: null,
    loseNextFinalizeResponse: null,
    loseNextRevokeResponse: null,
  };
  remote.mutatePackagePrepare = (changes) => {
    Object.assign(remote.packagePrepareData, changes);
  };
  remote.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(options.method, "POST");
    assert.equal(options.headers.apikey, "publishable");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers["Content-Profile"], "api");
    const body = JSON.parse(options.body);
    const name = parsed.pathname.split("/").at(-1);
    if (name === "qry_portal_lcia_result_package_publish_prepare_v1") {
      remote.counts.packagePrepare += 1;
      assert.equal(body.p_package_id, PACKAGE_ID);
      assert.equal(body.p_display_default_impact_category, IMPACT_ID);
      return jsonResponse({
        ok: true,
        data: structuredClone(remote.packagePrepareData),
      });
    }
    if (name === "cmd_portal_lcia_result_package_publish_v1") {
      remote.counts.packagePublish += 1;
      assert.equal(body.p_package_id, PACKAGE_ID);
      assert.equal(body.p_display_default_impact_category, IMPACT_ID);
      if (remote.packageHistoryConflict)
        return jsonResponse({
          ok: false,
          code: "package_publication_conflict",
          status: 409,
          message: "Package has non-current publication history",
        });
      if (remote.packagePublication) {
        if (
          body.p_expected_publish_plan_hash !==
          remote.packagePublication.publishPlanHash
        )
          return jsonResponse({
            ok: false,
            code: "publish_plan_drift",
            status: 409,
            message: "Publish plan drift",
          });
        return jsonResponse({
          ok: true,
          reused: true,
          data: packagePublishData(remote.packagePublication),
        });
      }
      if (
        body.p_expected_publish_plan_hash !==
        remote.packagePrepareData.publishPlanHash
      )
        return jsonResponse({
          ok: false,
          code: "publish_plan_drift",
          status: 409,
          message: "Publish plan drift",
        });
      remote.packagePublication = {
        publicationId: PUBLICATION_ID,
        packageId: PACKAGE_ID,
        previousPublicationId:
          remote.packagePrepareData.currentPublication?.publicationId ?? null,
        isCurrent: true,
        packageVersion: remote.packagePrepareData.package.version,
        projectionId: PROJECTION_ID,
        projectionContentHash: remote.packagePrepareData.projection.contentHash,
        publishedAt: PUBLISHED_AT,
        publishPlanHash: body.p_expected_publish_plan_hash,
      };
      remote.prepareData.lciaResultPublicationId = PUBLICATION_ID;
      remote.prepareData.publishedAt = PUBLISHED_AT;
      remote.packagePrepareData = {
        ...remote.packagePrepareData,
        publishPlanHash: "f".repeat(64),
        currentPublication: {
          publicationId: PUBLICATION_ID,
          packageId: PACKAGE_ID,
          packageVersion: remote.packagePrepareData.package.version,
          publishedAt: PUBLISHED_AT,
        },
      };
      const success = {
        ok: true,
        reused: false,
        data: packagePublishData(remote.packagePublication),
      };
      const loss = remote.loseNextPackagePublish;
      remote.loseNextPackagePublish = null;
      if (loss === "fetch") throw new TypeError("response lost after commit");
      if (loss === "body") return bodyLossResponse();
      return jsonResponse(success);
    }
    if (name === "qry_portal_lcia_projection_prepare_v1") {
      remote.counts.prepare += 1;
      if (!remote.packagePublication || remote.currentLifecycle !== "current")
        return jsonResponse({
          ok: false,
          code: "publication_not_current",
          status: 409,
          message: "Publication is not current",
        });
      assert.deepEqual(body, {
        p_package_id: PACKAGE_ID,
        p_lcia_result_publication_id: PUBLICATION_ID,
      });
      return jsonResponse({
        ok: true,
        data: structuredClone(remote.prepareData),
      });
    }
    if (name === "cmd_portal_lcia_projection_finalize_publication_v1") {
      remote.counts.finalize += 1;
      if (remote.forceFinalizeConflict)
        return jsonResponse({
          ok: false,
          code: "projection_conflict",
          status: 409,
          message: "Conflicting binding",
        });
      if (remote.projectionBinding) {
        const reused =
          remote.projectionBinding.projectionId === body.p_projection_id &&
          remote.projectionBinding.contentHash ===
            body.p_projection_content_hash &&
          remote.projectionBinding.idempotencyKey === body.p_idempotency_key &&
          remote.projectionBinding.status === "finalized";
        if (!reused)
          return jsonResponse({
            ok: false,
            code: "projection_conflict",
            status: 409,
            message: "Conflicting binding",
          });
        return jsonResponse({
          ok: true,
          reused: true,
          data: finalizeData(remote.projectionBinding),
        });
      }
      remote.projectionBinding = {
        projectionPublicationId: BINDING_ID,
        projectionId: PROJECTION_ID,
        lciaResultPublicationId: PUBLICATION_ID,
        packageId: PACKAGE_ID,
        packageVersion: remote.prepareData.packageVersion,
        contentHash: remote.prepareData.contentHash,
        evidenceHash: "9".repeat(64),
        finalizedAt: FINALIZED_AT,
        revokedAt: null,
        status: "finalized",
        idempotencyKey: body.p_idempotency_key,
      };
      const success = {
        ok: true,
        reused: false,
        data: finalizeData(remote.projectionBinding),
      };
      const loss = remote.loseNextFinalizeResponse;
      remote.loseNextFinalizeResponse = null;
      if (loss === "fetch") throw new TypeError("response lost after commit");
      if (loss === "body") return bodyLossResponse();
      return jsonResponse(success);
    }
    if (name === "qry_portal_lcia_projection_publication_readback_v1") {
      remote.counts.readback += 1;
      if (!remote.projectionBinding)
        return jsonResponse({
          ok: false,
          code: "projection_publication_not_found",
          status: 404,
          message: "Binding not found",
        });
      return jsonResponse({
        ok: true,
        data: {
          projectionPublicationId:
            remote.projectionBinding.projectionPublicationId,
          projectionId: remote.projectionBinding.projectionId,
          lciaResultPublicationId:
            remote.projectionBinding.lciaResultPublicationId,
          packageId: remote.projectionBinding.packageId,
          packageVersion: remote.projectionBinding.packageVersion,
          status: remote.projectionBinding.status,
          isCurrent:
            remote.readbackIsCurrentOverride ??
            (remote.projectionBinding.status === "finalized" &&
              remote.currentLifecycle === "current" &&
              remote.publiclyVisible),
          isPubliclyVisible:
            remote.projectionBinding.status === "finalized" &&
            remote.currentLifecycle === "current" &&
            remote.publiclyVisible,
          contentHash: remote.projectionBinding.contentHash,
          evidenceHash: remote.projectionBinding.evidenceHash,
          processCount: remote.prepareData.processCount,
          impactCount: remote.prepareData.impactCount,
          valueCount: remote.prepareData.valueCount,
          finalizedAt: remote.projectionBinding.finalizedAt,
          revokedAt: remote.projectionBinding.revokedAt,
        },
      });
    }
    if (name === "cmd_portal_lcia_projection_revoke_publication_v1") {
      remote.counts.revoke += 1;
      const reused = remote.projectionBinding.status === "revoked";
      if (!reused) {
        remote.projectionBinding.status = "revoked";
        remote.projectionBinding.revokedAt = REVOKED_AT;
      }
      const success = {
        ok: true,
        reused,
        data: {
          projectionPublicationId:
            remote.projectionBinding.projectionPublicationId,
          lciaResultPublicationId:
            remote.projectionBinding.lciaResultPublicationId,
          status: remote.projectionBinding.status,
          revokedAt: remote.projectionBinding.revokedAt,
        },
      };
      const loss = remote.loseNextRevokeResponse;
      remote.loseNextRevokeResponse = null;
      if (loss === "fetch") throw new TypeError("response lost after revoke");
      if (loss === "body") return bodyLossResponse();
      return jsonResponse(success);
    }
    return jsonResponse(
      { ok: false, code: "not_found", message: "Unknown RPC" },
      404,
    );
  };
  return remote;
}

function packagePrepareData() {
  return {
    publishPlanHash: "7".repeat(64),
    package: {
      id: PACKAGE_ID,
      version: "2026.08.26",
      resultHash: "1".repeat(64),
      inputManifestHash: "2".repeat(64),
      closureCertificateHash: "3".repeat(64),
      snapshotHash: "4".repeat(64),
      processCount: 2,
      impactCount: 3,
      valueCount: 6,
    },
    projection: {
      id: PROJECTION_ID,
      contentHash: "6".repeat(64),
      processAxisHash: "5".repeat(64),
      impactAxisHash: "8".repeat(64),
      valueGridHash: "b".repeat(64),
      relationHash: "c".repeat(64),
    },
    artifacts: {
      bundleContentHash: "d".repeat(64),
      bundleManifestSha256: "e".repeat(64),
      lciaChunkSetSha256: "f".repeat(64),
      resultArtifactSha256: "a".repeat(64),
      queryArtifactSha256: "0".repeat(64),
    },
    displayDefaultImpactCategory: IMPACT_ID,
    currentProcessSetHash: "9".repeat(64),
    currentPublication: null,
  };
}

function projectionPrepareData() {
  return {
    projectionId: PROJECTION_ID,
    buildWorkerJobId: JOB_ID,
    packageId: PACKAGE_ID,
    lciaResultPublicationId: PUBLICATION_ID,
    packageVersion: "2026.08.26",
    packageResultHash: "1".repeat(64),
    status: "prepared",
    projectionContractVersion: "portal.lcia-projection.v1",
    hashContractVersion: "portal.lcia-projection.int32be-frame-sha256.v1",
    processCount: 2,
    impactCount: 3,
    valueCount: 6,
    processAxisHash: "5".repeat(64),
    impactAxisHash: "8".repeat(64),
    valueGridHash: "b".repeat(64),
    relationHash: "c".repeat(64),
    contentHash: "6".repeat(64),
    publishedAt: PUBLISHED_AT,
  };
}

function packagePublishData(publication) {
  return {
    publicationId: publication.publicationId,
    packageId: publication.packageId,
    previousPublicationId: publication.previousPublicationId,
    isCurrent: publication.isCurrent,
    packageVersion: publication.packageVersion,
    projectionId: publication.projectionId,
    projectionContentHash: publication.projectionContentHash,
    publishedAt: publication.publishedAt,
    publishPlanHash: publication.publishPlanHash,
  };
}

function finalizeData(binding) {
  return {
    projectionPublicationId: binding.projectionPublicationId,
    projectionId: binding.projectionId,
    lciaResultPublicationId: binding.lciaResultPublicationId,
    packageId: binding.packageId,
    status: binding.status,
    contentHash: binding.contentHash,
    evidenceHash: binding.evidenceHash,
    finalizedAt: binding.finalizedAt,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyLossResponse() {
  return {
    ok: true,
    status: 200,
    text: async () => {
      throw new TypeError("response body lost");
    },
  };
}
