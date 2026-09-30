import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../cli.mjs";
import { DEFAULT_CALCULATION_PROFILE } from "../contracts/default-profile.mjs";

const defaultMethodIdentities = DEFAULT_CALCULATION_PROFILE.lciaMethods.map(
  ({ id, version }) => ({ id, version }),
);

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const jobId = "223e4567-e89b-42d3-a456-426614174000";
const env = {
  TIANGONG_LCA_DATA_PRODUCT_COMMAND_URL: "https://example.invalid/commands",
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  TIANGONG_LCA_ACCESS_TOKEN: "header.payload.signature",
};
function buffer() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += chunk;
      },
    },
    value: () => value,
  };
}

test("worker logs delegates exact job lookup to workspace_ops", async () => {
  const stdout = buffer();
  assert.equal(
    await runCli(
      [
        "worker",
        "logs",
        "--job-id",
        jobId,
        "--environment",
        "production",
        "--format",
        "json",
      ],
      { stdout: stdout.stream },
    ),
    0,
  );
  const result = JSON.parse(stdout.value());
  assert.equal(result.completeness.status, "delegated");
  assert.match(
    result.data.instruction,
    /python -m workspace_ops\.cli worker job/,
  );
  assert.match(result.data.instruction, /^cd '/);
  assert.match(result.data.instruction, new RegExp(jobId));
  assert.match(result.data.instruction, /--all-configs/);
  assert.equal(result.replyTemplate.id, "worker-log-delegated");
});

test("closure submission requires confirmation before configuration or network", async () => {
  const stdout = buffer();
  let calls = 0;
  const code = await runCli(
    [
      "closure",
      "start",
      "--coverage-mode",
      "global_eligible",
      "--method",
      `${uuid}@01.00.000`,
      "--idempotency-token",
      "closure-1",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env: {},
      fetchImpl: async () => {
        calls += 1;
      },
    },
  );
  assert.equal(code, 3);
  assert.equal(calls, 0);
});

test("closure submission prioritizes exact Closure status before Worker diagnostics", async () => {
  const stdout = buffer();
  const code = await runCli(
    [
      "closure",
      "start",
      "--result-set-id",
      uuid,
      "--coverage-mode",
      "global_eligible",
      "--method",
      `${uuid}@01.00.000`,
      "--idempotency-token",
      "closure-1",
      "--confirm-start",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), {
          action: "create_closure_check",
          resultSetId: uuid,
          requestedScope: {
            coverageMode: "global_eligible",
            lciaMethods: [{ id: uuid, version: "01.00.000" }],
          },
          requestIdempotencyToken: "closure-1",
        });
        return Response.json({
          ok: true,
          data: {
            closureCheckId: uuid,
            workerJob: { id: jobId, status: "queued", providerExtra: true },
            schemaVersion: "provider.changed.v9",
          },
        });
      },
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(code, 0);
  assert.deepEqual(result.data, {
    kind: "closure",
    jobId,
    resourceId: uuid,
    identityCompleteness: "complete",
    status: "queued",
    reused: false,
    effectiveInput: {
      coverageMode: "global_eligible",
      lciaMethods: [{ id: uuid, version: "01.00.000" }],
      defaultedInputs: [],
    },
  });
  assert.match(result.nextActions[0], /closure get/);
  assert.match(result.nextActions[0], new RegExp(uuid));
  assert.match(result.nextActions[1], /workspace_ops/);
  assert.equal(result.replyTemplate.id, "closure-submitted");
});

for (const family of ["closure", "calculation"]) {
  for (const status of [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
  ]) {
    test(`${family} submission offers monitoring only while ${status} needs it`, async () => {
      const stdout = buffer();
      let calls = 0;
      const args =
        family === "closure"
          ? ["--result-set-id", uuid, "--idempotency-token", "monitor-closure"]
          : [
              "--name",
              "Monitor calculation",
              "--closure-check-id",
              uuid,
              "--requested-scope-hash",
              "scope-hash",
              "--policy-fingerprint",
              "policy-hash",
              "--idempotency-key",
              "monitor-calculation",
            ];
      const code = await runCli(
        [family, "start", ...args, "--confirm-start", "--format", "json"],
        {
          stdout: stdout.stream,
          env,
          fetchImpl: async () => {
            calls += 1;
            return Response.json({
              ok: true,
              data: {
                ...(family === "closure" ? { closureCheckId: uuid } : {}),
                workerJob: { id: jobId, status },
                reused: !["queued", "running"].includes(status),
              },
            });
          },
        },
      );
      assert.equal(code, 0);
      assert.equal(
        calls,
        1,
        "asking about monitoring must not create a monitor",
      );
      const result = JSON.parse(stdout.value());
      assert.match(result.nextActions[0], new RegExp(`${family} get`));
      assert.match(
        result.nextActions[0],
        new RegExp(family === "closure" ? uuid : jobId),
      );
      assert.match(result.nextActions[1], /workspace_ops/);
      if (["queued", "running"].includes(status)) {
        assert.equal(result.nextDecision.kind, "confirm_task_monitoring");
        assert.equal(result.nextDecision.requiresConfirmation, true);
        assert.equal(result.nextActions[2], result.nextDecision.prompt);
        assert.match(result.nextDecision.prompt, /持续监测的定时任务或进程/);
        assert.match(
          result.nextDecision.prompt,
          /仅在完成、失败、阻塞或需要你处理时通知/,
        );
        assert.match(result.nextDecision.prompt, /终态停止监测/);
        assert.match(
          result.nextDecision.prompt,
          new RegExp(family === "closure" ? uuid : jobId),
        );
      } else {
        assert.equal(result.nextDecision, null);
        assert.equal(result.nextActions.length, 2);
      }
    });
  }

  test(`${family} human submission includes the monitoring question in Next`, async () => {
    const stdout = buffer();
    const args =
      family === "closure"
        ? ["--idempotency-token", "human-monitor-closure"]
        : [
            "--name",
            "Monitor calculation",
            "--closure-check-id",
            uuid,
            "--requested-scope-hash",
            "scope-hash",
            "--policy-fingerprint",
            "policy-hash",
            "--idempotency-key",
            "human-monitor-calculation",
          ];
    assert.equal(
      await runCli([family, "start", ...args, "--confirm-start"], {
        stdout: stdout.stream,
        env,
        fetchImpl: async () =>
          Response.json({
            ok: true,
            data: {
              ...(family === "closure" ? { closureCheckId: uuid } : {}),
              workerJob: { id: jobId, status: "queued" },
            },
          }),
      }),
      0,
    );
    assert.match(stdout.value(), /Next:[\s\S]*是否.*持续监测的定时任务或进程/);
  });
}

test("closure submission uses and discloses the workflow default profile", async () => {
  const stdout = buffer();
  await runCli(
    [
      "closure",
      "start",
      "--result-set-id",
      uuid,
      "--idempotency-token",
      "default-profile-1",
      "--confirm-start",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.requestedScope.coverageMode, "global_eligible");
        assert.deepEqual(
          body.requestedScope.lciaMethods,
          defaultMethodIdentities,
        );
        assert.equal(body.requestedScope.lciaMethods.length, 25);
        assert.deepEqual(body.requestedScope.lciaMethods[13], {
          id: "b2ad66ce-c78d-11e6-9d9d-cec0c932ce01",
          version: "03.00.014",
        });
        return Response.json({
          ok: true,
          data: {
            closureCheckId: uuid,
            workerJob: { id: jobId, status: "queued" },
          },
        });
      },
    },
  );
  assert.deepEqual(
    JSON.parse(stdout.value()).data.effectiveInput.defaultedInputs,
    ["coverageMode", "lciaMethods"],
  );
});

test("closure get returns exact calculation bindings only when evidence is ready", async () => {
  const stdout = buffer();
  let calls = 0;
  const code = await runCli(
    ["closure", "get", "--closure-check-id", uuid, "--format", "json"],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        calls += 1;
        assert.deepEqual(JSON.parse(options.body), {
          action: "get_closure_check",
          closureCheckId: uuid,
        });
        return Response.json({
          ok: true,
          data: {
            schemaVersion: "provider.changed.v9",
            closureCheckId: uuid,
            runStatus: "passed",
            scanCompleteness: "complete",
            certificateValidity: "valid",
            requestedScopeHash: "scope-hash",
            effectiveScopeHash: "effective-hash",
            policyFingerprint: "policy-hash",
            dataSnapshotToken: "snapshot-token",
            blockerCodes: [],
            workerJob: {
              jobId,
              status: "completed",
              phase: "finalize_evidence",
              progressFraction: 1,
            },
            createdAt: "2026-08-18T00:00:00Z",
            updatedAt: "2026-08-18T00:01:00Z",
            finishedAt: "2026-08-18T00:01:00Z",
            providerExtra: true,
          },
        });
      },
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(code, 0);
  assert.equal(calls, 1);
  assert.equal(result.command, "closure.get");
  assert.equal(result.data.calculationReady, true);
  assert.deepEqual(result.data.binding, {
    requestedScopeHash: "scope-hash",
    policyFingerprint: "policy-hash",
    effectiveScopeHash: "effective-hash",
  });
  assert.equal(result.completeness.status, "calculation_ready");
  assert.equal(result.completeness.bindingComplete, true);
  assert.equal(result.completeness.scopeIdentityReturned, false);
  assert.match(result.nextActions[0], /calculation start/);
  assert.match(result.nextActions[0], /--requested-scope-hash scope-hash/);
  assert.match(result.nextActions[0], /--policy-fingerprint policy-hash/);
  assert.match(
    result.nextActions[0],
    /reuse the exact coverage\/process\/method/,
  );
  assert.doesNotMatch(result.nextActions[0], /REUSE_ORIGINAL_/);
  assert.equal(result.replyTemplate.id, "closure-inspected");
  assert.equal("providerExtra" in result.data, false);
});

test("closure get keeps incomplete evidence on the same read-only recovery node", async () => {
  const stdout = buffer();
  await runCli(
    ["closure", "get", "--closure-check-id", uuid, "--format", "json"],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async () =>
        Response.json({
          ok: true,
          data: {
            closureCheckId: uuid,
            runStatus: "running",
            scanCompleteness: "pending",
            certificateValidity: "pending",
            workerJob: { jobId, status: "running", progressFraction: 0.5 },
          },
        }),
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(result.data.calculationReady, false);
  assert.equal(result.data.binding.requestedScopeHash, null);
  assert.equal(result.completeness.status, "not_ready");
  assert.match(result.nextActions[0], /closure get/);
  assert.doesNotMatch(result.nextActions[0], /calculation start/);
});

test("closure get rejects a non-exact identity before network access", async () => {
  const stdout = buffer();
  let calls = 0;
  const code = await runCli(
    ["closure", "get", "--closure-check-id", "latest", "--format", "json"],
    {
      stdout: stdout.stream,
      env: {},
      fetchImpl: async () => {
        calls += 1;
      },
    },
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("calculation get uses the database task projection and skips healthy Worker logs", async () => {
  const stdout = buffer();
  const code = await runCli(
    ["calculation", "get", "--job-id", jobId, "--format", "json"],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), {
          action: "list_task_feed",
          category: "data_product",
          jobKinds: ["lcia_result.package_build"],
          limit: 200,
          rootOnly: false,
        });
        return Response.json({
          ok: true,
          data: {
            items: [
              {
                schemaVersion: "task-summary.v2",
                jobId,
                jobKind: "lcia_result.package_build",
                workerStatus: "completed",
                domainStatus: "passed",
                domainValidity: "valid",
                phase: "finalize",
                progressFraction: 1,
                projectionUpdatedAt: "2026-08-18T00:01:00Z",
                resultSetId: uuid,
                closureCheckId: uuid,
                resultPackageId: uuid,
                capabilities: { canPreviewResult: true },
                rawPayload: { mustNotLeak: true },
              },
            ],
            nextCursor: null,
          },
        });
      },
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(code, 0);
  assert.equal(result.data.statusAuthority, "database_task_projection");
  assert.equal(result.data.workerLogsRole, "secondary_diagnostics");
  assert.equal(result.data.diagnosticsRecommended, false);
  assert.equal(result.data.resultPackageId, uuid);
  assert.equal(result.completeness.status, "terminal_observed");
  assert.equal(result.completeness.lookup.complete, true);
  assert.doesNotMatch(result.nextActions.join("\n"), /workspace_ops/);
  assert.match(result.nextActions[0], /calculation-bundle get/);
  assert.match(result.nextActions[0], new RegExp(uuid));
  assert.equal("rawPayload" in result.data, false);
  assert.equal(result.replyTemplate.id, "calculation-inspected");
});

test("calculation get follows bounded feed pages and keeps running tasks on database polling", async () => {
  const stdout = buffer();
  let calls = 0;
  await runCli(["calculation", "get", "--job-id", jobId, "--format", "json"], {
    stdout: stdout.stream,
    env,
    fetchImpl: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      if (calls === 1) {
        assert.equal("cursor" in body, false);
        return Response.json({
          ok: true,
          data: {
            items: [],
            nextCursor: {
              updatedAt: "2026-08-18T00:00:00Z",
              jobId: uuid,
            },
          },
        });
      }
      assert.deepEqual(body.cursor, {
        updatedAt: "2026-08-18T00:00:00Z",
        jobId: uuid,
      });
      return Response.json({
        ok: true,
        data: {
          items: [
            {
              jobId,
              jobKind: "lcia_result.package_build",
              workerStatus: "running",
              phase: "solve",
              progressFraction: 0.5,
              projectionUpdatedAt: "2026-08-18T00:02:00Z",
            },
          ],
          nextCursor: null,
        },
      });
    },
  });
  const result = JSON.parse(stdout.value());
  assert.equal(calls, 2);
  assert.equal(result.data.terminal, false);
  assert.equal(result.data.diagnosticsRecommended, false);
  assert.equal(result.completeness.lookup.pageCount, 2);
  assert.match(result.nextActions[0], /calculation get/);
  assert.doesNotMatch(result.nextActions.join("\n"), /workspace_ops/);
});

test("calculation get recommends Worker logs only for diagnostic states", async () => {
  const stdout = buffer();
  await runCli(["calculation", "get", "--job-id", jobId, "--format", "json"], {
    stdout: stdout.stream,
    env,
    fetchImpl: async () =>
      Response.json({
        ok: true,
        data: {
          items: [
            {
              jobId,
              jobKind: "lcia_result.package_build",
              workerStatus: "failed",
              domainStatus: "failed",
              domainValidity: "invalid",
              projectionUpdatedAt: "2026-08-18T00:03:00Z",
              errorSummary: "bounded summary",
            },
          ],
          nextCursor: null,
        },
      }),
  });
  const result = JSON.parse(stdout.value());
  assert.equal(result.data.diagnosticsRecommended, true);
  assert.match(result.nextActions[0], /workspace_ops\.cli worker job/);
});

const bundleMetadata = {
  packageId: uuid,
  packageVersion: "lcia-result-test",
  packageStatus: "preview_ready",
  snapshotId: uuid,
  resultId: jobId,
  createdAt: "2026-08-18T00:00:00Z",
  bundle: {
    schemaVersion: "tiangong.calculation-bundle.v2",
    bundleContentHash: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    manifestByteSize: 123,
    artifactCount: 140,
  },
  availableImpactCategories: [uuid],
  productDownloads: [],
};

test("calculation-bundle list uses the direct database store and exposes no locators", async () => {
  const stdout = buffer();
  let receivedLimit;
  const code = await runCli(
    ["calculation-bundle", "list", "--limit", "20", "--format", "json"],
    {
      stdout: stdout.stream,
      env: {},
      bundleStoreFactory: () => ({
        async list(limit) {
          receivedLimit = limit;
          return {
            items: [bundleMetadata],
            completeness: {
              status: "complete",
              limit,
              returned: 1,
              mayHaveMore: false,
              source: "direct_read_only_database",
            },
          };
        },
      }),
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(code, 0);
  assert.equal(receivedLimit, 20);
  assert.equal(result.command, "calculation-bundle.list");
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].packageId, uuid);
  assert.equal(result.data.items[0].bundle.artifactCount, 140);
  assert.equal(result.completeness.status, "complete");
  assert.match(result.nextActions[0], /<SELECT_PACKAGE_ID>/);
  assert.doesNotMatch(result.nextActions[0], new RegExp(uuid));
  assert.equal(result.replyTemplate.id, "calculation-bundle-listed");
  assert.doesNotMatch(stdout.value(), /artifactUrl|signedDownloadUrl|CONN/);
});

test("calculation-bundle get uses an exact Package and points to local download", async () => {
  const stdout = buffer();
  let selector;
  const code = await runCli(
    ["calculation-bundle", "get", "--package-id", uuid, "--format", "json"],
    {
      stdout: stdout.stream,
      env: {},
      bundleStoreFactory: () => ({
        async get(packageId, options) {
          selector = { packageId, options };
          return bundleMetadata;
        },
      }),
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(code, 0);
  assert.deepEqual(selector, { packageId: uuid, options: undefined });
  assert.equal(result.command, "calculation-bundle.get");
  assert.equal(result.completeness.selector, "exact_package_id");
  assert.match(result.nextActions[0], /calculation-bundle download/);
  assert.equal(result.replyTemplate.id, "calculation-bundle-inspected");
});

test("calculation-bundle download returns local verified handoff without locators", async () => {
  const stdout = buffer();
  let downloadInput;
  const code = await runCli(
    [
      "calculation-bundle",
      "download",
      "--package-id",
      uuid,
      "--out-dir",
      "/tmp/calculation-bundle-test",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env: { S3_SECRET_ACCESS_KEY: "must-not-leak" },
      bundleStoreFactory: () => ({
        async get() {
          return {
            ...bundleMetadata,
            storage: { manifestUrl: "s3://private/manifest.json" },
          };
        },
      }),
      bundleDownloader: async (input) => {
        downloadInput = input;
        return {
          bundleDirectory: input.outDir,
          receiptPath: `${input.outDir}/download-receipt.json`,
          receipt: {
            verification: {
              manifest: "verified",
              artifacts: "verified",
              products: "not_requested",
            },
            artifactCount: 140,
            productDownloadCount: 0,
          },
        };
      },
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(code, 0);
  assert.equal(downloadInput.concurrency, 8);
  assert.equal(downloadInput.includeProducts, false);
  assert.equal(result.command, "calculation-bundle.download");
  assert.equal(result.data.artifactCount, 140);
  assert.equal(result.replyTemplate.id, "calculation-bundle-downloaded");
  assert.doesNotMatch(stdout.value(), /must-not-leak|s3:\/\/private/);
});

test("calculation-bundle list validates its bound before network access", async () => {
  const stdout = buffer();
  let calls = 0;
  const code = await runCli(
    ["calculation-bundle", "list", "--limit", "201", "--format", "json"],
    {
      stdout: stdout.stream,
      env: {},
      fetchImpl: async () => {
        calls += 1;
      },
    },
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
});

test("calculation submission binds the selected closure evidence", async () => {
  const stdout = buffer();
  const code = await runCli(
    [
      "calculation",
      "start",
      "--name",
      "Steel",
      "--closure-check-id",
      uuid,
      "--requested-scope-hash",
      "scope-hash",
      "--policy-fingerprint",
      "policy-hash",
      "--coverage-mode",
      "global_eligible",
      "--method",
      `${uuid}@01.00.000`,
      "--idempotency-key",
      "build-1",
      "--confirm-start",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.action, "create_build");
        assert.equal(body.closureCheckId, uuid);
        assert.equal(body.defaultImpactCategory, uuid);
        return Response.json({
          ok: true,
          data: { buildId: uuid, workerJob: { jobId, status: "queued" } },
        });
      },
    },
  );
  assert.equal(code, 0);
  const result = JSON.parse(stdout.value());
  assert.equal(result.data.kind, "calculation");
  assert.match(result.nextActions[0], /calculation get/);
  assert.match(result.nextActions[0], new RegExp(jobId));
  assert.match(result.nextActions[1], /workspace_ops/);
});

test("calculation default profile sends all reviewed methods and a separate display default", async () => {
  const stdout = buffer();
  await runCli(
    [
      "calculation",
      "start",
      "--name",
      "Reviewed catalog",
      "--closure-check-id",
      uuid,
      "--requested-scope-hash",
      "scope-hash",
      "--policy-fingerprint",
      "policy-hash",
      "--idempotency-key",
      "build-default-profile",
      "--confirm-start",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.lciaMethodSet.length, 25);
        assert.deepEqual(body.lciaMethodSet, defaultMethodIdentities);
        assert.equal(
          body.defaultImpactCategory,
          DEFAULT_CALCULATION_PROFILE.defaultImpactCategory,
        );
        return Response.json({
          ok: true,
          data: { buildId: uuid, workerJob: { jobId, status: "queued" } },
        });
      },
    },
  );
  const effectiveInput = JSON.parse(stdout.value()).data.effectiveInput;
  assert.equal(effectiveInput.lciaMethods.length, 25);
  assert.equal(
    effectiveInput.defaultImpactCategory,
    DEFAULT_CALCULATION_PROFILE.defaultImpactCategory,
  );
  assert.deepEqual(effectiveInput.defaultedInputs, [
    "coverageMode",
    "lciaMethods",
    "defaultImpactCategory",
  ]);
});

test("reviewed profile records human-readable method names and indicators", () => {
  assert.equal(DEFAULT_CALCULATION_PROFILE.lciaMethods.length, 25);
  assert.deepEqual(
    DEFAULT_CALCULATION_PROFILE.lciaMethods.find(
      ({ id }) => id === DEFAULT_CALCULATION_PROFILE.defaultImpactCategory,
    ),
    {
      id: "6209b35f-9447-40b5-b68c-a1099e3674a0",
      version: "01.00.000",
      name: "Climate change",
      indicator: "Radiative forcing as Global Warming Potential (GWP100)",
    },
  );
  for (const method of DEFAULT_CALCULATION_PROFILE.lciaMethods) {
    assert.ok(method.name);
    assert.ok(method.indicator);
  }
});

test("calculation submission succeeds with job-only identity before package materialization", async () => {
  const stdout = buffer();
  const code = await runCli(
    [
      "calculation",
      "start",
      "--name",
      "Steel",
      "--closure-check-id",
      uuid,
      "--requested-scope-hash",
      "scope-hash",
      "--policy-fingerprint",
      "policy-hash",
      "--idempotency-key",
      "build-job-only",
      "--confirm-start",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async () =>
        Response.json({
          ok: true,
          data: { workerJobId: jobId, status: "queued" },
        }),
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(code, 0);
  assert.equal(result.data.jobId, jobId);
  assert.equal(result.data.resourceId, null);
  assert.equal(result.data.identityCompleteness, "job_only");
  assert.equal(result.completeness.status, "submitted");
  assert.equal(result.replyTemplate.id, "calculation-submitted");
});
