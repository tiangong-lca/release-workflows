import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import {
  analyzeExclusionImpact,
  recordScopeDecision,
} from "../lib/exclusion-impact.mjs";
import { buildExclusionReviewWorkbookModel } from "../lib/exclusion-review-workbook.mjs";
import {
  inspectFlowCache,
  refreshFlowCache,
  runRemoteFlowCacheExport,
} from "../lib/flow-cache.mjs";
import {
  buildPackageCandidate,
  DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
  EXPECTED_TIDAS_VERSION,
  PACKAGE_PROFILE,
  runTidas,
  verifyTidasRuntime,
  verifyBuiltPackages,
} from "../lib/package-build.mjs";
import { readNdjson } from "../lib/records.mjs";
import { prepareReleaseIntake } from "../lib/release-intake.mjs";
import {
  REPLY_TEMPLATE_COMMANDS,
  replyTemplateFor,
} from "../reply-template-registry.mjs";

const CALCULATION_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "22222222-2222-4222-8222-222222222222";
const RESULT_ID = "33333333-3333-4333-8333-333333333333";
const UNIT_ID = "44444444-4444-4444-8444-444444444444";
const FLOW_ID = "55555555-5555-4555-8555-555555555555";
const METHOD_ID = "66666666-6666-4666-8666-666666666666";
const RETAINED_UNIT_VERSION = "01.00.001";
const VERSION = "01.00.000";
const REPOSITORY_ROOT = new URL("../../../", import.meta.url).pathname;
const RELEASE_VERSION = "2026.08.0";

test("release package adapter requires exact tidas v0.2.0 contract", async () => {
  const calls = [];
  const result = await verifyTidasRuntime({
    tidasBin: "/tools/tidas",
    spawnCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === "version")
        return {
          code: 0,
          stdout: JSON.stringify({
            schema_version: "tidas.operation-report.v1",
            status: "succeeded",
            exit_class: "success",
            completeness: "complete",
            summary: {
              binary_version: EXPECTED_TIDAS_VERSION,
              operation_report_schema: "tidas.operation-report.v1",
            },
          }),
          stderr: "",
        };
      if (args[0] === "release")
        return {
          code: 0,
          stdout:
            "Usage: tidas release build-packages [OPTIONS]\n      --issue-spool <PATH>\n",
          stderr: "",
        };
      return {
        code: 0,
        stdout: JSON.stringify({
          schema_version: "tidas.operation-report.v1",
          status: "succeeded",
          exit_class: "success",
          completeness: "complete",
          summary: {
            validation_describe: {
              schema_version: "tidas.validation-describe.v1",
              package: { name: "tidas", version: EXPECTED_TIDAS_VERSION },
              protocols: ["document-validation-batch.v1"],
              asset_fingerprint: "fixture-fingerprint",
            },
          },
        }),
        stderr: "",
      };
    },
  });
  assert.equal(result.binaryVersion, "0.2.0");
  assert.equal(result.assetFingerprint, "fixture-fingerprint");
  assert.equal(result.issueSpoolSupported, true);
  assert.deepEqual(
    calls.map(({ args }) => args[0]),
    ["version", "validate", "release"],
  );
  assert.ok(
    calls.every(
      ({ options }) =>
        options.env.TIDAS_MEMORY_BUDGET_MIB ===
        String(DEFAULT_TIDAS_MEMORY_BUDGET_MIB),
    ),
  );

  await assert.rejects(
    verifyTidasRuntime({
      tidasBin: "/tools/tidas",
      spawnCommand: async () => ({
        code: 0,
        stdout: JSON.stringify({
          schema_version: "tidas.operation-report.v1",
          status: "succeeded",
          exit_class: "success",
          completeness: "complete",
          summary: {
            binary_version: "0.1.4",
            operation_report_schema: "tidas.operation-report.v1",
          },
        }),
        stderr: "",
      }),
    }),
    (error) => error.code === "tidas_version_incompatible",
  );
});

test("runTidas forwards the issue spool only when the binary advertises it", async () => {
  for (const supported of [true, false]) {
    const calls = [];
    await runTidas({
      tidasBin: "/tools/tidas",
      canonicalRoot: "/canonical",
      indexPath: "/canonical/index.json",
      packagesDir: "/tmp/packages",
      issueSpoolPath: "/tmp/issues.ndjson",
      spawnCommand: async (command, args) => {
        calls.push(args);
        if (args[0] === "version")
          return {
            code: 0,
            stdout: JSON.stringify({
              schema_version: "tidas.operation-report.v1",
              status: "succeeded",
              exit_class: "success",
              completeness: "complete",
              summary: {
                binary_version: EXPECTED_TIDAS_VERSION,
                operation_report_schema: "tidas.operation-report.v1",
              },
            }),
            stderr: "",
          };
        if (args[0] === "validate")
          return {
            code: 0,
            stdout: JSON.stringify({
              schema_version: "tidas.operation-report.v1",
              status: "succeeded",
              exit_class: "success",
              completeness: "complete",
              summary: {
                validation_describe: {
                  schema_version: "tidas.validation-describe.v1",
                  package: { name: "tidas", version: EXPECTED_TIDAS_VERSION },
                  protocols: ["document-validation-batch.v1"],
                  asset_fingerprint: "fixture-fingerprint",
                },
              },
            }),
            stderr: "",
          };
        if (args.includes("--help"))
          return {
            code: 0,
            stdout: supported ? "--issue-spool <PATH>" : "Usage",
            stderr: "",
          };
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    const build = calls.find((args) => args.includes("--tidas-dir"));
    assert.ok(build);
    assert.equal(build.includes("--issue-spool"), supported);
  }
});

test("failed package construction retains the structured tidas operation report", async () => {
  const fixture = await createFixture();
  const operationReport = {
    schema_version: "tidas.operation-report.v1",
    status: "failed",
    exit_class: "validation_failed",
    completeness: "complete",
    summary: { error_count: 2 },
    issues: [
      { code: "allocation_coproduct_reference_missing", count: 1 },
      { code: "variable_parameter_reference_missing", count: 1 },
    ],
  };
  const spawnCommand = async (_command, args) => {
    if (args[0] === "version")
      return {
        code: 0,
        stdout: JSON.stringify({
          schema_version: "tidas.operation-report.v1",
          status: "succeeded",
          exit_class: "success",
          completeness: "complete",
          summary: {
            binary_version: EXPECTED_TIDAS_VERSION,
            operation_report_schema: "tidas.operation-report.v1",
          },
        }),
        stderr: "",
      };
    if (args[0] === "validate")
      return {
        code: 0,
        stdout: JSON.stringify({
          schema_version: "tidas.operation-report.v1",
          status: "succeeded",
          exit_class: "success",
          completeness: "complete",
          summary: {
            validation_describe: {
              schema_version: "tidas.validation-describe.v1",
              package: { name: "tidas", version: EXPECTED_TIDAS_VERSION },
              protocols: ["document-validation-batch.v1"],
              asset_fingerprint: "fixture-fingerprint",
            },
          },
        }),
        stderr: "",
      };
    return {
      code: 2,
      stdout: JSON.stringify(operationReport),
      stderr: "package construction failed",
    };
  };

  let observedError;
  try {
    await buildPackageCandidate({
      releaseIntakeDir: fixture.releaseIntake,
      outDir: fixture.output,
      releaseVersion: RELEASE_VERSION,
      runTool: (request) => runTidas({ ...request, spawnCommand }),
    });
  } catch (error) {
    observedError = error;
  }
  assert.equal(observedError.code, "tidas_package_build_failed");
  assert.deepEqual(observedError.details.operationReport, operationReport);
  const failureManifest = JSON.parse(
    await readFile(observedError.details.retainedBuild.manifest, "utf8"),
  );
  assert.equal(failureManifest.status, "package_build_failed");
  assert.deepEqual(
    failureManifest.failure.diagnostics.operationReport,
    operationReport,
  );
});

test("retained failed builds rewrite the validation spool path", async () => {
  const fixture = await createFixture();
  const spawnCommand = async (_command, args) => {
    if (args[0] === "version")
      return {
        code: 0,
        stdout: JSON.stringify({
          schema_version: "tidas.operation-report.v1",
          status: "succeeded",
          exit_class: "success",
          completeness: "complete",
          summary: {
            binary_version: EXPECTED_TIDAS_VERSION,
            operation_report_schema: "tidas.operation-report.v1",
          },
        }),
        stderr: "",
      };
    if (args[0] === "validate")
      return {
        code: 0,
        stdout: JSON.stringify({
          schema_version: "tidas.operation-report.v1",
          status: "succeeded",
          exit_class: "success",
          completeness: "complete",
          summary: {
            validation_describe: {
              schema_version: "tidas.validation-describe.v1",
              package: { name: "tidas", version: EXPECTED_TIDAS_VERSION },
              protocols: ["document-validation-batch.v1"],
              asset_fingerprint: "fixture-fingerprint",
            },
          },
        }),
        stderr: "",
      };
    if (args.includes("--help"))
      return { code: 0, stdout: "--issue-spool <PATH>", stderr: "" };
    const spoolPath = args[args.indexOf("--issue-spool") + 1];
    await writeFile(
      spoolPath,
      `${JSON.stringify({
        type: "issue",
        issue: {
          issue_code: "ilcd_schema_error",
          severity: "error",
          file_path: "data/processes/bad_01.00.000.xml",
        },
      })}\n`,
    );
    return {
      code: 2,
      stdout: JSON.stringify({
        schema_version: "tidas.operation-report.v1",
        status: "failed",
        exit_class: "data-issues",
        completeness: "complete",
        summary: {},
        diagnostics: [
          {
            schema_version: "tidas.diagnostic.v1",
            code: "release_input_invalid",
            message: "validation failed",
            details: {},
          },
        ],
        artifacts: [
          {
            path: spoolPath,
            media_type: "application/x-ndjson",
            sha256: "0".repeat(64),
            bytes: 1,
          },
        ],
        next_actions: [],
      }),
      stderr: "",
    };
  };

  let observedError;
  try {
    await buildPackageCandidate({
      releaseIntakeDir: fixture.releaseIntake,
      outDir: fixture.output,
      releaseVersion: RELEASE_VERSION,
      runTool: (request) => runTidas({ ...request, spawnCommand }),
    });
  } catch (error) {
    observedError = error;
  }
  assert.equal(observedError.code, "tidas_package_build_failed");
  const retained = JSON.parse(
    await readFile(observedError.details.retainedBuild.manifest, "utf8"),
  );
  assert.equal(
    retained.artifacts.validationIssues,
    "tidas-validation-issues.ndjson",
  );
  const artifact = retained.failure.diagnostics.operationReport.artifacts[0];
  assert.equal(artifact.media_type, "application/x-ndjson");
  assert.ok(artifact.path.startsWith(observedError.details.retainedBuild.path));
  await access(artifact.path);
});

test("shared Elementary Flow cache distinguishes fresh and stale watermarks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-flow-cache-"));
  const artifactText = `${JSON.stringify({ datasetType: "flow", uuid: FLOW_ID, version: VERSION, document: {} })}\n`;
  await writeFile(path.join(root, "elementary-flows.ndjson"), artifactText);
  await writeFile(
    path.join(root, "cache-manifest.json"),
    canonicalJson({
      schemaVersion: "tiangong.release.elementary-flow-cache.v1",
      databaseWatermark: {
        publishedCount: 1,
        maxModifiedAt: "2026-08-19 00:00:00+00",
      },
      artifact: {
        path: "elementary-flows.ndjson",
        sha256: sha256Bytes(Buffer.from(artifactText)),
        recordCount: 1,
      },
      createdAt: "2026-08-19T00:00:00.000Z",
    }),
  );
  const poolFactory = (maxModifiedAt) => () => ({
    async query() {
      return {
        rows: [{ published_count: "1", max_modified_at: maxModifiedAt }],
      };
    },
    async end() {},
  });
  assert.equal(
    (
      await inspectFlowCache({
        cacheDir: root,
        poolFactory: poolFactory("2026-08-19 00:00:00+00"),
      })
    ).status,
    "fresh",
  );
  assert.equal(
    (
      await inspectFlowCache({
        cacheDir: root,
        poolFactory: poolFactory("2026-08-19 00:00:01+00"),
      })
    ).status,
    "stale",
  );
});

test("cache refresh defaults to remote transfer, verifies it, and deletes it before install", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "release-flow-remote-"));
  const root = path.join(parent, "cache");
  await mkdir(root);
  await writeFile(path.join(root, "previous"), "preserve until replacement");
  const document = {
    flowDataSet: {
      modellingAndValidation: {
        LCIMethod: { typeOfDataSet: "Elementary flow" },
      },
    },
  };
  const artifact = Buffer.from(
    `${JSON.stringify({ datasetType: "flow", uuid: FLOW_ID, version: VERSION, document })}\n`,
  );
  const compressed = gzipSync(artifact);
  const calls = [];
  const result = await refreshFlowCache({
    cacheDir: root,
    env: { RELEASE_FLOW_CACHE_REMOTE_HOST: "worker-cache-host" },
    remoteExporter: async ({ remoteHost }) => {
      calls.push(["export", remoteHost]);
      return {
        schemaVersion: "tiangong.release.elementary-flow-cache-transfer.v1",
        databaseWatermark: {
          publishedCount: 12,
          maxModifiedAt: "2026-08-23 03:21:04+00",
        },
        artifactSha256: sha256Bytes(artifact),
        artifactByteSize: artifact.byteLength,
        recordCount: 1,
        compressedSha256: sha256Bytes(compressed),
        compressedByteSize: compressed.byteLength,
        createdAt: "2026-08-23T09:00:00.000Z",
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        downloadUrl: "https://storage.example/cache?download-secret",
        deleteUrl: "https://storage.example/cache?delete-secret",
      };
    },
    fetchImpl: async (url, options = {}) => {
      calls.push([options.method ?? "GET", url]);
      return options.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(compressed, { status: 200 });
    },
  });
  assert.equal(result.execution, "remote");
  assert.equal(result.remoteHost, "worker-cache-host");
  assert.deepEqual(
    calls.map(([operation]) => operation),
    ["export", "GET", "DELETE"],
  );
  assert.equal(
    await readFile(path.join(root, "elementary-flows.ndjson"), "utf8"),
    artifact.toString(),
  );
  const manifest = JSON.parse(
    await readFile(path.join(root, "cache-manifest.json"), "utf8"),
  );
  assert.equal(manifest.artifact.sha256, sha256Bytes(artifact));
  assert.equal(manifest.artifact.recordCount, 1);
  assert.equal(manifest.databaseWatermark.publishedCount, 12);
  await assert.rejects(access(path.join(root, "previous")));
});

test("remote cache refresh requires an explicitly configured SSH host", async () => {
  await assert.rejects(
    refreshFlowCache({
      cacheDir: path.join(os.tmpdir(), "unused-release-flow-cache"),
      env: {},
      remoteExporter: async () => {
        throw new Error("must not execute");
      },
    }),
    (error) => error.code === "flow_cache_remote_host_missing",
  );
});

test("remote cache mismatch fails closed and preserves the installed cache", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "release-flow-remote-"));
  const root = path.join(parent, "cache");
  await mkdir(root);
  await writeFile(path.join(root, "previous"), "still-current");
  const compressed = gzipSync(Buffer.from("not the declared artifact\n"));
  let deleted = false;
  await assert.rejects(
    refreshFlowCache({
      cacheDir: root,
      env: { RELEASE_FLOW_CACHE_REMOTE_HOST: "worker-cache-host" },
      remoteExporter: async () => ({
        schemaVersion: "tiangong.release.elementary-flow-cache-transfer.v1",
        databaseWatermark: { publishedCount: 1, maxModifiedAt: null },
        artifactSha256: "a".repeat(64),
        artifactByteSize: 999,
        recordCount: 1,
        compressedSha256: sha256Bytes(compressed),
        compressedByteSize: compressed.byteLength,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        downloadUrl: "https://storage.example/cache?download-secret",
        deleteUrl: "https://storage.example/cache?delete-secret",
      }),
      fetchImpl: async (_url, options = {}) => {
        if (options.method === "DELETE") {
          deleted = true;
          return new Response(null, { status: 204 });
        }
        return new Response(compressed, { status: 200 });
      },
    }),
    (error) => error.code === "flow_cache_remote_artifact_invalid",
  );
  assert.equal(deleted, true);
  assert.equal(
    await readFile(path.join(root, "previous"), "utf8"),
    "still-current",
  );
});

test("remote exporter rejects mismatched database and Storage projects without echoing secrets", () => {
  const script = new URL(
    "../scripts/remote-flow-cache-export.py",
    import.meta.url,
  );
  const password = "do-not-echo-this-password";
  const result = spawnSync("python3", [script.pathname], {
    encoding: "utf8",
    input: JSON.stringify({
      schemaVersion: "tiangong.release.elementary-flow-cache-export-request.v1",
      connectionString: `postgresql://postgres.databaseproject:${password}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      s3Endpoint: "https://storageproject.storage.supabase.co/storage/v1/s3",
      s3Region: "us-east-1",
      s3Bucket: "calculation-results",
      s3AccessKeyId: "access-key",
      s3SecretAccessKey: "secret-key",
      objectPrefix: "_temporary/release/elementary-flow-cache",
    }),
  });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, "flow_cache_remote_project_binding_mismatch");
  assert.doesNotMatch(result.stderr, new RegExp(password));
  assert.doesNotMatch(result.stderr, /secret-key/u);
});

test("remote exporter resolves an exact matching Supabase project binding", () => {
  const script = new URL(
    "../scripts/remote-flow-cache-export.py",
    import.meta.url,
  );
  const probe = [
    "import runpy,sys",
    "module=runpy.run_path(sys.argv[1])",
    "config={'connectionString':'postgresql://postgres.projectref:secret@aws-0-us-east-1.pooler.supabase.com/postgres','s3Endpoint':'https://projectref.storage.supabase.co/storage/v1/s3'}",
    "print(module['validate_project_binding'](config))",
  ].join(";");
  const result = spawnSync("python3", ["-c", probe, script.pathname], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "projectref");
  assert.equal(result.stderr, "");
});

test("remote transport keeps credentials on SSH stdin and applies bounded SSH options", async () => {
  const calls = [];
  const secret = "stdin-only-secret";
  const result = await runRemoteFlowCacheExport({
    remoteHost: "worker-cache-host",
    env: {
      CONN: `postgresql://postgres.project:${secret}@pooler.example/postgres`,
      S3_ENDPOINT: "https://project.storage.supabase.co/storage/v1/s3",
      S3_REGION: "us-east-1",
      S3_BUCKET: "cache",
      S3_ACCESS_KEY_ID: "access",
      S3_SECRET_ACCESS_KEY: secret,
    },
    spawnCommand: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (args.some((value) => value.includes("mktemp")))
        return {
          code: 0,
          stdout: "/tmp/tiangong-release-flow-cache.abcdefgh\n",
          stderr: "",
        };
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      if (args.includes("python3"))
        return {
          code: 0,
          stdout: JSON.stringify({ protocol: "fixture" }),
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(result, { protocol: "fixture" });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ args }) => args.includes("BatchMode=yes")));
  assert.ok(calls.every(({ args }) => !args.join(" ").includes(secret)));
  const execution = calls.find(({ args }) => args.includes("python3"));
  assert.match(execution.options.input, new RegExp(secret));
});

test("package build assembles local closure and delegates four-package build", async () => {
  const fixture = await createFixture();
  let observed;
  const result = await buildPackageCandidate({
    releaseIntakeDir: fixture.releaseIntake,
    outDir: fixture.output,
    releaseVersion: RELEASE_VERSION,
    runTool: async (request) => {
      observed = request;
      const index = JSON.parse(await readFile(request.indexPath, "utf8"));
      assert.equal(index.datasetCount, 4);
      assert.deepEqual(index.datasets.map((item) => item.path).sort(), [
        `flows/${FLOW_ID}_${VERSION}.json`,
        `lifecyclemodels/${MODEL_ID}_${VERSION}.json`,
        `processes/${RESULT_ID}_${VERSION}.json`,
        `processes/${UNIT_ID}_${VERSION}.json`,
      ]);
      await mkdir(request.packagesDir, { recursive: true });
      for (const name of [
        "unit-process-full-closure.v1.tidas.zip",
        "unit-process-full-closure.v1.ilcd.zip",
        "standalone-lifecyclemodel-result-full-closure.v1.tidas.zip",
        "standalone-lifecyclemodel-result-full-closure.v1.ilcd.zip",
      ])
        await writeFile(
          path.join(request.packagesDir, name),
          `fixture:${name}`,
        );
      return { ok: true, release: { outcome: "built", packageCount: 4 } };
    },
    verifyTool: async ({ packagesDir, releaseVersion }) => {
      assert.equal(releaseVersion, RELEASE_VERSION);
      assert.deepEqual((await readdir(packagesDir)).sort(), [
        `TiangongLCA-${RELEASE_VERSION}-ResultDatabase.ilcd.zip`,
        `TiangongLCA-${RELEASE_VERSION}-ResultDatabase.tidas.zip`,
        `TiangongLCA-${RELEASE_VERSION}-UnitProcessDatabase.ilcd.zip`,
        `TiangongLCA-${RELEASE_VERSION}-UnitProcessDatabase.tidas.zip`,
      ]);
      return {
        schemaVersion: "tiangong.release.package-verification.v1",
        releaseVersion,
        outcome: "passed",
        packages: [],
      };
    },
  });
  assert.equal(observed.tidasBin, "tidas");
  assert.equal(result.candidate.profile, PACKAGE_PROFILE);
  assert.equal(result.candidate.releaseVersion, RELEASE_VERSION);
  assert.equal(result.candidate.publicationAuthorized, false);
  assert.equal(
    result.candidate.schemaVersion,
    "tiangong.release.release-candidate.v2",
  );
  assert.equal(
    result.candidate.publicationCatalog.path,
    "publication-catalog.json",
  );
  const publicationCatalog = JSON.parse(
    await readFile(
      path.join(fixture.output, "publication-catalog.json"),
      "utf8",
    ),
  );
  assert.equal(
    publicationCatalog.schemaVersion,
    "tiangong.release.candidate-publication-catalog.v1",
  );
  assert.equal(
    publicationCatalog.canonicalDatasetIndexSha256,
    result.candidate.canonicalDatasetIndexSha256,
  );
  assert.equal(
    sha256Bytes(Buffer.from(canonicalJson(publicationCatalog))),
    result.candidate.publicationCatalog.sha256,
  );
  assert.equal(result.candidate.packages.length, 4);
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(fixture.output, "release-candidate.json"),
        "utf8",
      ),
    ).validation.outcome,
    "passed",
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(fixture.output, "package-verification-report.json"),
        "utf8",
      ),
    ).outcome,
    "passed",
  );
});

test("package build fails before tidas-tools when materialized bytes drift", async () => {
  const fixture = await createFixture();
  await writeFile(
    path.join(
      fixture.materialization,
      "canonical-datasets",
      "processes",
      `${RESULT_ID}_${VERSION}.json`,
    ),
    "{}\n",
  );
  let invoked = false;
  await assert.rejects(
    buildPackageCandidate({
      releaseIntakeDir: fixture.releaseIntake,
      outDir: fixture.output,
      releaseVersion: RELEASE_VERSION,
      runTool: async () => {
        invoked = true;
      },
    }),
    (error) => error.code === "materialized_dataset_hash_mismatch",
  );
  assert.equal(invoked, false);
});

test("failed TIDAS and eILCD qualification retain distinct diagnostic builds", async () => {
  const fixture = await createFixture();
  for (const failedFormat of ["tidas", "ilcd"]) {
    let observedError;
    try {
      await buildPackageCandidate({
        releaseIntakeDir: fixture.releaseIntake,
        outDir: fixture.output,
        releaseVersion: RELEASE_VERSION,
        runTool: writeFixturePackages,
        verifyTool: (request) =>
          verifyBuiltPackages({
            ...request,
            spawnCommand: async (command, args) => {
              if (command === "unzip" && args[0] === "-Z1")
                return {
                  code: 0,
                  stdout: "data/example.json\n",
                  stderr: "",
                };
              if (command === "unzip")
                return { code: 0, stdout: "", stderr: "" };
              const format = args[1] === "validate-tidas" ? "tidas" : "ilcd";
              return format === failedFormat
                ? {
                    code: 2,
                    stdout: "",
                    stderr: `${failedFormat} schema mismatch`,
                  }
                : {
                    code: 0,
                    stdout: JSON.stringify({ ok: true }),
                    stderr: "",
                  };
            },
          }),
      });
    } catch (error) {
      observedError = error;
    }
    assert.equal(
      observedError.code,
      `${failedFormat}_package_validation_failed`,
    );
    assert.equal(observedError.details.format, failedFormat);
    assert.equal(observedError.details.retainedBuild.packageCount, 4);
    assert.equal(
      observedError.details.retainedBuild.publicationAuthorized,
      false,
    );
    const retained = observedError.details.retainedBuild.path;
    const failureManifest = JSON.parse(
      await readFile(path.join(retained, "failed-package-build.json"), "utf8"),
    );
    assert.equal(failureManifest.status, "qualification_failed");
    assert.equal(failureManifest.candidateCreated, false);
    assert.equal(failureManifest.failure.format, failedFormat);
    assert.match(
      failureManifest.failure.diagnostics.stderr,
      new RegExp(`${failedFormat} schema mismatch`, "u"),
    );
    assert.equal(failureManifest.packages.length, 4);
    const verification = JSON.parse(
      await readFile(
        path.join(retained, "package-verification-report.json"),
        "utf8",
      ),
    );
    assert.equal(verification.outcome, "failed");
    assert.equal(verification.failure.format, failedFormat);
    await access(path.join(retained, "validation-readback"));
  }
  await assert.rejects(
    access(fixture.output),
    (error) => error.code === "ENOENT",
  );
  const retainedNames = (await readdir(fixture.root)).filter((name) =>
    name.startsWith("candidate.failed-"),
  );
  assert.equal(retainedNames.length, 2);
  assert.equal(new Set(retainedNames).size, 2);
});

test("CLI returns retained packages and failure manifest after package build failure", async () => {
  const fixture = await createFixture();
  const fakeTidas = path.join(fixture.root, "fake-tidas.sh");
  await writeFile(
    fakeTidas,
    `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '%s' '{"schema_version":"tidas.operation-report.v1","status":"succeeded","exit_class":"success","completeness":"complete","summary":{"binary_version":"${EXPECTED_TIDAS_VERSION}","operation_report_schema":"tidas.operation-report.v1"}}'
  exit 0
fi
if [ "$1" = "validate" ] && [ "$2" = "--describe" ]; then
  printf '%s' '{"schema_version":"tidas.operation-report.v1","status":"succeeded","exit_class":"success","completeness":"complete","summary":{"validation_describe":{"schema_version":"tidas.validation-describe.v1","package":{"name":"tidas","version":"${EXPECTED_TIDAS_VERSION}"},"protocols":["document-validation-batch.v1"],"asset_fingerprint":"fixture-fingerprint"}}}'
  exit 0
fi
if [ "$1" = "release" ] && [ "$3" = "--help" ]; then
  printf '%s' 'Usage: tidas release build-packages [OPTIONS]'
  exit 0
fi
output_dir=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-dir" ]; then
    shift
    output_dir="$1"
  fi
  shift
done
mkdir -p "$output_dir"
for name in unit-process-full-closure.v1.tidas.zip unit-process-full-closure.v1.ilcd.zip standalone-lifecyclemodel-result-full-closure.v1.tidas.zip standalone-lifecyclemodel-result-full-closure.v1.ilcd.zip; do
  printf '%s' "$name" > "$output_dir/$name"
done
printf '%s' '{"ok":true,"release":{"outcome":"built","packageCount":4}}'
exit 0
`,
  );
  await chmod(fakeTidas, 0o755);
  const cli = new URL("../cli.mjs", import.meta.url);
  const environment = { ...process.env };
  delete environment.TIDAS_MEMORY_BUDGET_MIB;
  const result = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "package",
      "build",
      "--release-intake",
      fixture.releaseIntake,
      "--profile",
      PACKAGE_PROFILE,
      "--release-version",
      RELEASE_VERSION,
      "--out-dir",
      fixture.output,
      "--tidas-bin",
      fakeTidas,
      "--json",
    ],
    { encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.outcome, "packages_built_qualification_failed");
  assert.equal(payload.completeness, "diagnostic_artifacts_retained");
  assert.equal(payload.publicationAuthorized, false);
  await access(payload.artifacts.failedBuild);
  await access(payload.artifacts.failureManifest);
  assert.equal(payload.nextActions[0].kind, "inspect_failed_build");
  assert.match(payload.nextActions[0].command, /failed-package-build\.json/u);
  assert.equal(payload.nextActions[1].kind, "diagnose_without_issue_spool");
  assert.equal(payload.nextActions[2].kind, "inspect_retained_artifacts");
  assert.equal(payload.replyTemplate.id, "release-package-validation-failed");
  await assert.rejects(
    access(fixture.output),
    (error) => error.code === "ENOENT",
  );
});

test("CLI applies the Release memory default and returns an exact resource retry", async () => {
  const fixture = await createFixture();
  const fakeTidas = path.join(fixture.root, "memory-tidas.sh");
  await writeFile(
    fakeTidas,
    `#!/bin/sh
if [ "$TIDAS_MEMORY_BUDGET_MIB" != "${DEFAULT_TIDAS_MEMORY_BUDGET_MIB}" ]; then
  printf '%s' '{"schema_version":"tidas.operation-report.v1","status":"failed","diagnostics":[{"code":"wrong_test_budget"}]}'
  exit 3
fi
if [ "$1" = "version" ]; then
  printf '%s' '{"schema_version":"tidas.operation-report.v1","status":"succeeded","exit_class":"success","completeness":"complete","summary":{"binary_version":"${EXPECTED_TIDAS_VERSION}","operation_report_schema":"tidas.operation-report.v1"}}'
  exit 0
fi
if [ "$1" = "validate" ] && [ "$2" = "--describe" ]; then
  printf '%s' '{"schema_version":"tidas.operation-report.v1","status":"succeeded","exit_class":"success","completeness":"complete","summary":{"validation_describe":{"schema_version":"tidas.validation-describe.v1","package":{"name":"tidas","version":"${EXPECTED_TIDAS_VERSION}"},"protocols":["document-validation-batch.v1"],"asset_fingerprint":"fixture-fingerprint"}}}'
  exit 0
fi
printf '%s' '{"schema_version":"tidas.operation-report.v1","status":"failed","exit_class":"internal","completeness":"complete","invocation":{"memory_budget_bytes":2147483648},"diagnostics":[{"code":"memory_budget_exceeded"}]}'
exit 2
`,
  );
  await chmod(fakeTidas, 0o755);
  const cli = new URL("../cli.mjs", import.meta.url);
  const environment = { ...process.env };
  delete environment.TIDAS_MEMORY_BUDGET_MIB;
  const result = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "package",
      "build",
      "--release-intake",
      fixture.releaseIntake,
      "--profile",
      PACKAGE_PROFILE,
      "--release-version",
      RELEASE_VERSION,
      "--out-dir",
      fixture.output,
      "--tidas-bin",
      fakeTidas,
      "--json",
    ],
    { encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.error.code, "tidas_memory_budget_exceeded");
  assert.equal(payload.error.details.memoryBudgetMiB, 2048);
  assert.deepEqual(
    payload.nextActions.map(({ kind }) => kind),
    [
      "inspect_failed_build",
      "retry_with_larger_tidas_memory_budget",
      "inspect_retained_artifacts",
    ],
  );
  assert.ok(payload.nextActions[1].argv.includes("--tidas-memory-budget-mib"));
  assert.ok(payload.nextActions[1].argv.includes("4096"));
  assert.ok(!payload.nextActions.some(({ kind }) => kind.includes("analyze")));
});

test("Release Intake expands exact LCIA Method Flow dependencies without mutating source intake", async () => {
  const fixture = await createFixture();
  const method = sourceRecord("lciamethod", "support", METHOD_ID, {
    LCIAMethodDataSet: {
      characterisationFactors: {
        factor: [
          {
            referenceToFlowDataSet: {
              "@type": "flow data set",
              "@refObjectId": FLOW_ID,
              "@version": VERSION,
            },
          },
        ],
      },
    },
  });
  const sourceRecords = [
    sourceRecord("process", "unit_process", UNIT_ID, {
      processDataSet: { id: UNIT_ID },
    }),
    method,
  ];
  const sourceBytes = gzipSync(
    `${sourceRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const sourcePath = path.join(
    fixture.intake,
    "calculation-bundle",
    "source",
    "closure.ndjson.gz",
  );
  await writeFile(sourcePath, sourceBytes);
  const intakeManifestPath = path.join(fixture.intake, "intake-manifest.json");
  const intakeManifest = JSON.parse(await readFile(intakeManifestPath, "utf8"));
  intakeManifest.artifacts[0].sha256 = sha256Bytes(sourceBytes);
  intakeManifest.artifacts[0].recordCount = sourceRecords.length;
  await writeFile(intakeManifestPath, canonicalJson(intakeManifest));
  const materializationManifestPath = path.join(
    fixture.materialization,
    "materialization-manifest.json",
  );
  const materializationManifest = JSON.parse(
    await readFile(materializationManifestPath, "utf8"),
  );
  materializationManifest.inputs.intakeManifestSha256 =
    hashJson(intakeManifest);
  await writeFile(
    materializationManifestPath,
    canonicalJson(materializationManifest),
  );
  const target = path.join(
    fixture.root,
    "new-release-intakes",
    "release-intake-expanded",
  );
  const cacheArtifact = path.join(fixture.root, "elementary-flows.ndjson");
  await writeFile(
    cacheArtifact,
    `${JSON.stringify(sourceRecord("flow", "support", FLOW_ID, { flowDataSet: { id: FLOW_ID } }))}\n`,
  );
  const result = await prepareReleaseIntake({
    materializationDir: fixture.materialization,
    sourceIntakeDir: fixture.intake,
    outDir: target,
    cacheLoader: async () => ({
      artifact: cacheArtifact,
      manifest: { artifact: { recordCount: 93_996 } },
    }),
  });
  assert.equal(result.report.addedExactFlowCount, 1);
  assert.equal(result.report.uniqueReferenceCount, 1);
  const dependencyText = await readFile(
    path.join(target, "dependencies", "lcia-method-flows.ndjson"),
    "utf8",
  );
  assert.match(dependencyText, new RegExp(FLOW_ID, "u"));
  assert.equal(
    JSON.parse(await readFile(intakeManifestPath, "utf8")).artifacts[0]
      .recordCount,
    2,
  );
});

test("Release Intake fails closed when an exact LCIA Method Flow is unavailable", async () => {
  const fixture = await createFixture();
  await configureMissingMethodFlow(fixture);
  await assert.rejects(
    prepareReleaseIntake({
      materializationDir: fixture.materialization,
      sourceIntakeDir: fixture.intake,
      outDir: path.join(fixture.root, "release-intake-missing-flow"),
      cacheLoader: async () => {
        const artifact = path.join(fixture.root, "empty-cache.ndjson");
        await writeFile(artifact, "");
        return { artifact, manifest: { artifact: { recordCount: 0 } } };
      },
    }),
    (error) =>
      error.code === "release_intake_exact_flow_missing" &&
      error.details.uuid === FLOW_ID &&
      error.details.version === VERSION,
  );
});

test("Release failure analysis binds the complete exclusion set before rebuilding a candidate", async () => {
  const fixture = await createExclusionFixture();
  const impactDir = path.join(fixture.root, "impact");
  const analysis = await analyzeExclusionImpact({
    failedBuildDir: fixture.failedBuild,
    releaseIntakeDir: fixture.releaseIntake,
    outDir: impactDir,
  });
  assert.equal(analysis.report.status, "complete");
  assert.equal(analysis.report.impact.safeToExclude, true);
  assert.equal(
    analysis.report.validationIssues.invalidDatasets[0].classification,
    "invalid_selected_root",
  );
  assert.equal(
    analysis.report.validationIssues.invalidDatasets[0].orphan,
    false,
  );
  assert.equal(analysis.report.impact.affectedProcessRoots.length, 1);
  assert.deepEqual(
    analysis.report.impact.excludedCanonicalDatasets
      .map(({ path: itemPath }) => itemPath)
      .sort(),
    [
      `lifecyclemodels/${MODEL_ID}_${VERSION}.json`,
      `processes/${RESULT_ID}_${VERSION}.json`,
      `processes/${UNIT_ID}_${VERSION}.json`,
    ],
  );
  assert.equal(analysis.report.impact.resultingDatasetCount, 1);
  const reviewModel = buildExclusionReviewWorkbookModel(analysis.report);
  assert.equal(reviewModel.invalidData.rows.length, 1);
  assert.equal(reviewModel.affectedRoots.rows.length, 1);
  assert.equal(reviewModel.derivedData.rows.length, 2);
  assert.equal(reviewModel.unreachableSupport.rows.length, 0);
  assert.equal(reviewModel.completeExclusionSet.rows.length, 3);
  assert.deepEqual(
    reviewModel.completeExclusionSet.rows.map((row) => row.at(-1)).sort(),
    [
      "Affected materialized dataset",
      "Affected materialized dataset",
      "Initial validation error",
    ],
  );

  const cli = new URL("../cli.mjs", import.meta.url);
  const reviewDir = path.join(fixture.root, "review");
  const previewDir = path.join(fixture.root, "review-previews");
  const portableReview = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "failure",
      "review",
      "--impact-report",
      path.join(impactDir, "exclusion-impact-report.json"),
      "--out-dir",
      reviewDir,
      "--preview-dir",
      previewDir,
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(portableReview.status, 0, portableReview.stderr);
  const reviewPayload = JSON.parse(portableReview.stdout);
  assert.equal(reviewPayload.outcome, "exclusion_review_ready");
  assert.equal(reviewPayload.reviewPreviews, previewDir);
  await access(reviewPayload.reviewWorkbook);
  const reviewReceipt = JSON.parse(await readFile(reviewPayload.reviewReceipt));
  assert.equal(reviewReceipt.workbook.sheets.length, 7);
  assert.equal(reviewReceipt.verification.workbookReadbackCompleted, true);
  assert.equal(reviewReceipt.verification.formulaErrorCount, 0);
  assert.equal(reviewReceipt.verification.visualPreviewFormat, "svg");
  assert.deepEqual(
    (await readdir(previewDir)).sort(),
    reviewReceipt.verification.visualPreviewFiles.toSorted(),
  );

  await assert.rejects(
    recordScopeDecision({
      impactReportPath: path.join(impactDir, "exclusion-impact-report.json"),
      outDir: path.join(fixture.root, "bad-decision"),
      action: "exclude",
      reason: "fixture",
      decidedBy: "fixture-user",
      confirmImpactSha256: "0".repeat(64),
    }),
    (error) => error.code === "impact_confirmation_mismatch",
  );

  const decision = await recordScopeDecision({
    impactReportPath: path.join(impactDir, "exclusion-impact-report.json"),
    outDir: path.join(fixture.root, "decision"),
    action: "exclude",
    reason: "Confirmed fixture exclusion set",
    decidedBy: "fixture-user",
    confirmImpactSha256: analysis.reportSha256,
  });
  assert.equal(decision.decision.action, "exclude");
  assert.equal(decision.decision.publicationAuthorized, false);

  const scopedOutput = path.join(fixture.root, "scoped-candidate");
  const result = await buildPackageCandidate({
    releaseIntakeDir: fixture.releaseIntake,
    scopeDecisionDir: decision.path,
    outDir: scopedOutput,
    releaseVersion: RELEASE_VERSION,
    runTool: async (request) => {
      const index = JSON.parse(await readFile(request.indexPath, "utf8"));
      assert.equal(index.datasetCount, 1);
      assert.deepEqual(
        index.datasets.map(({ path: itemPath }) => itemPath),
        [`flows/${FLOW_ID}_${VERSION}.json`],
      );
      return writeFixturePackages(request);
    },
    verifyTool: async ({ releaseVersion }) => ({
      schemaVersion: "tiangong.release.package-verification.v1",
      releaseVersion,
      outcome: "passed",
      packages: [],
    }),
  });
  assert.equal(result.candidate.publicationAuthorized, false);
  assert.equal(result.candidate.scopeDecisionSha256, decision.decisionSha256);
  assert.equal(result.plan.scopeDecision.excludedSetHash.length, 64);
});

test("impact analysis normalizes ILCD spool paths and discloses ignored model issues", async () => {
  const fixture = await createExclusionFixture();
  const manifestPath = path.join(
    fixture.failedBuild,
    "failed-package-build.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const spoolPath =
    manifest.failure.diagnostics.operationReport.artifacts[0].path;
  const events = [
    {
      type: "issue",
      issue: {
        issue_code: "ilcd_schema_error",
        severity: "error",
        category: "processes",
        file_path: `data/processes/${UNIT_ID}_${VERSION}.xml`,
        location: "line 1",
        message: "process issue",
      },
    },
    {
      type: "issue",
      issue: {
        issue_code: "ilcd_schema_error",
        severity: "error",
        category: "lifecyclemodels",
        file_path: `data/lifecyclemodels/${MODEL_ID}_${VERSION}.xml`,
        location: "line 1",
        message: "model issue",
      },
    },
  ];
  const text = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await writeFile(spoolPath, text);
  manifest.failure.diagnostics.operationReport.artifacts[0].sha256 =
    sha256Bytes(Buffer.from(text));
  manifest.failure.diagnostics.operationReport.artifacts[0].bytes =
    Buffer.byteLength(text);
  await writeFile(manifestPath, canonicalJson(manifest));

  const analysis = await analyzeExclusionImpact({
    failedBuildDir: fixture.failedBuild,
    releaseIntakeDir: fixture.releaseIntake,
    outDir: path.join(fixture.root, "impact-normalized"),
  });
  assert.equal(analysis.report.validationIssues.invalidDatasets.length, 1);
  assert.equal(
    analysis.report.validationIssues.invalidDatasets[0].path,
    `processes/${UNIT_ID}_${VERSION}.json`,
  );
  assert.equal(
    analysis.report.validationIssues.ignoredNonProcessDatasets.length,
    1,
  );
  assert.equal(
    analysis.report.validationIssues.ignoredNonProcessDatasets[0].datasetType,
    "lifecyclemodel",
  );
});

test("Release exclusion impact treats preceding-version references as non-closure lineage", async (t) => {
  for (const retainedReference of [
    {
      field: "common:referenceToPrecedingDataSetVersion",
      role: "lineage",
      asArray: false,
    },
    {
      field: "referenceToPrecedingDataSetVersion",
      role: "lineage",
      asArray: true,
    },
  ])
    await t.test(
      `${retainedReference.field} (${retainedReference.asArray ? "array" : "object"})`,
      async () => {
        const fixture = await createExclusionFixture({
          retainedReference,
        });
        const analysis = await analyzeExclusionImpact({
          failedBuildDir: fixture.failedBuild,
          releaseIntakeDir: fixture.releaseIntake,
          outDir: path.join(fixture.root, "impact-lineage-reference"),
        });
        assert.equal(analysis.report.status, "complete");
        assert.equal(analysis.report.impact.safeToExclude, true);
        assert.deepEqual(
          analysis.report.impact.remainingReferenceConflicts,
          [],
        );
        assert.equal(
          analysis.report.impact.excludedCanonicalDatasets.some(
            ({ version }) => version === RETAINED_UNIT_VERSION,
          ),
          false,
        );
      },
    );
});

test("Release exclusion impact still blocks retained functional references to excluded data", async () => {
  const fixture = await createExclusionFixture({
    retainedReference: {
      field: "referenceToIncludedProcesses",
      role: "closure_dependency",
    },
  });
  const analysis = await analyzeExclusionImpact({
    failedBuildDir: fixture.failedBuild,
    releaseIntakeDir: fixture.releaseIntake,
    outDir: path.join(fixture.root, "impact-functional-reference"),
  });
  assert.equal(analysis.report.status, "blocked");
  assert.equal(analysis.report.impact.safeToExclude, false);
  assert.equal(analysis.report.impact.remainingReferenceConflicts.length, 1);
  assert.deepEqual(
    analysis.report.impact.remainingReferenceConflicts[0].reference,
    {
      uuid: UNIT_ID,
      version: VERSION,
      location:
        "processDataSet/processInformation/technology/referenceToIncludedProcesses",
      role: "closure_dependency",
      closureRequired: true,
    },
  );
});

test("release version is filename-safe before any input is read", async () => {
  await assert.rejects(
    buildPackageCandidate({
      releaseIntakeDir: "/missing/release-intake",
      outDir: "/missing/output",
      releaseVersion: "../latest",
    }),
    (error) => error.code === "release_version_invalid",
  );
});

test("final distribution ZIPs are independently extracted and validated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-readback-"));
  const packagesDir = path.join(root, "packages");
  await mkdir(packagesDir);
  const expectedArtifacts = new Map();
  for (const product of ["UnitProcessDatabase", "ResultDatabase"])
    for (const format of ["tidas", "ilcd"]) {
      const fileName = `TiangongLCA-${RELEASE_VERSION}-${product}.${format}.zip`;
      const bytes = Buffer.from(`${product}:${format}\n`.repeat(20_000));
      await writeFile(path.join(packagesDir, fileName), bytes);
      expectedArtifacts.set(fileName, {
        byteSize: bytes.length,
        sha256: sha256Bytes(bytes),
      });
    }
  const calls = [];
  const report = await verifyBuiltPackages({
    tidasBin: "/tools/tidas",
    packagesDir,
    workspace: root,
    releaseVersion: RELEASE_VERSION,
    spawnCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "unzip" && args[0] === "-Z1")
        return { code: 0, stdout: "data/example.json\n", stderr: "" };
      if (command === "unzip") return { code: 0, stdout: "", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, summary: { release: {} } }),
        stderr: "",
      };
    },
  });
  assert.equal(report.outcome, "passed");
  assert.equal(report.packages.length, 4);
  for (const artifact of report.packages)
    assert.deepEqual(
      {
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
      },
      expectedArtifacts.get(artifact.fileName),
    );
  assert.equal(calls.filter(({ command }) => command === "unzip").length, 8);
  assert.deepEqual(
    calls
      .filter(({ command }) => command === "/tools/tidas")
      .map(({ args }) => args[1])
      .sort(),
    ["validate-ilcd", "validate-ilcd", "validate-tidas", "validate-tidas"],
  );
  assert.ok(
    calls
      .filter(({ command }) => command === "/tools/tidas")
      .every(
        ({ options }) =>
          options.env.TIDAS_MEMORY_BUDGET_MIB ===
          String(DEFAULT_TIDAS_MEMORY_BUDGET_MIB),
      ),
  );
});

test("CLI exposes one bounded local package build route", () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /package build/);
  assert.match(help.stdout, /failure review/);
  assert.match(help.stdout, /does not authorize/);
  assert.match(help.stdout, /Examples:/);
  assert.match(help.stdout, /replyTemplate/);
  const unsupported = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "package",
      "build",
      "--release-intake",
      "/tmp/release-intake",
      "--profile",
      "result-process-only.v1",
      "--release-version",
      RELEASE_VERSION,
      "--out-dir",
      "/tmp/candidate",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(unsupported.status, 1);
  const unsupportedPayload = JSON.parse(unsupported.stderr);
  assert.equal(unsupportedPayload.error.code, "unsupported_package_profile");
  assert.equal(unsupportedPayload.command, "package build");
  assert.equal(unsupportedPayload.outcome, "command_failed");
  assert.equal(unsupportedPayload.completeness, "not_completed");
  assert.equal(unsupportedPayload.nextActions[0].kind, "inspect_usage");
  assert.match(
    unsupportedPayload.nextActions[0].command,
    new RegExp(cli.pathname),
  );
  assert.equal(unsupportedPayload.replyTemplate.id, "release-command-failed");

  const confirmation = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "package",
      "build",
      "--release-intake",
      "/tmp/release-intake",
      "--profile",
      PACKAGE_PROFILE,
      "--out-dir",
      "/tmp/candidate",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(confirmation.status, 0);
  const confirmationPayload = JSON.parse(confirmation.stdout);
  assert.equal(
    confirmationPayload.outcome,
    "release_version_confirmation_required",
  );
  assert.equal(confirmationPayload.completeness, "awaiting_user_confirmation");
  assert.match(confirmationPayload.recommendedVersion, /^\d{4}\.\d{2}\.0$/u);
  assert.equal(confirmationPayload.fileNames.length, 4);
  assert.equal(
    confirmationPayload.replyTemplate.id,
    "release-version-confirmation-required",
  );
  assert.ok(
    confirmationPayload.nextActions[0].argv.includes("--release-version"),
  );
  assert.equal(confirmationPayload.nextActions[0].argv[1], cli.pathname);
  assert.doesNotMatch(
    confirmationPayload.nextActions[0].command,
    /node workflows\//,
  );
});

test("CLI rejects unknown and duplicate options with actionable output", () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  for (const [tokens, code] of [
    [["--unknown", "value", "--json"], "unknown_option"],
    [
      ["--profile", PACKAGE_PROFILE, "--profile", PACKAGE_PROFILE, "--json"],
      "duplicate_option",
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      [cli.pathname, "package", "build", ...tokens],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.error.code, code);
    assert.equal(payload.nextActions[0].kind, "inspect_usage");
  }
});

test("CLI renders human failures separately from JSON mode", () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [cli.pathname, "package", "build", "--unknown", "value"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Release command failed/);
  assert.match(result.stderr, /Summary:/);
  assert.match(result.stderr, /Next:/);
  assert.match(result.stderr, /Reply using template:/);
  assert.doesNotMatch(result.stderr, /^\{/);
});

test("every Release CLI outcome maps to an existing bounded reply template", async () => {
  assert.deepEqual(REPLY_TEMPLATE_COMMANDS, [
    "cache status",
    "cache refresh",
    "intake prepare",
    "failure analyze",
    "failure review",
    "failure decide",
    "package build",
  ]);
  for (const template of [
    replyTemplateFor("intake prepare", { ok: true }),
    replyTemplateFor("failure analyze", { ok: true }),
    replyTemplateFor("failure review", { ok: true }),
    replyTemplateFor("package build", { ok: true }),
    replyTemplateFor("package build", {
      ok: false,
      errorCode: "materialized_dataset_hash_mismatch",
    }),
    replyTemplateFor("package build", {
      ok: false,
      errorCode: "unsupported_package_profile",
    }),
    replyTemplateFor("package build", {
      ok: false,
      errorCode: "ilcd_package_validation_failed",
      retainedBuild: true,
    }),
  ]) {
    assert.ok(template.id);
    assert.ok(template.requiredFacts.length > 0);
    await access(path.resolve(REPOSITORY_ROOT, template.path));
  }
});

test("Release cache reply template renders the exact next command field", async () => {
  const template = replyTemplateFor("cache status", { ok: true });
  const body = await readFile(
    path.resolve(REPOSITORY_ROOT, template.path),
    "utf8",
  );
  assert.match(body, /\{\{nextActions\.0\.command\}\}/u);
  assert.doesNotMatch(body, /\{\{nextActions\}\}/u);
});

test("Release Candidate reply template exposes Publication planning and Transformation", async () => {
  const template = replyTemplateFor("package build", { ok: true });
  const body = await readFile(
    path.resolve(REPOSITORY_ROOT, template.path),
    "utf8",
  );
  for (const index of [0, 1])
    assert.match(
      body,
      new RegExp(`\\{\\{nextDecision\\.choices\\.${index}\\.label\\}\\}`, "u"),
    );
  assert.ok(template.requiredFacts.includes("nextDecision"));
});

async function writeFixturePackages({ packagesDir }) {
  await mkdir(packagesDir, { recursive: true });
  for (const name of [
    "unit-process-full-closure.v1.tidas.zip",
    "unit-process-full-closure.v1.ilcd.zip",
    "standalone-lifecyclemodel-result-full-closure.v1.tidas.zip",
    "standalone-lifecyclemodel-result-full-closure.v1.ilcd.zip",
  ])
    await writeFile(path.join(packagesDir, name), `fixture:${name}`);
  return { ok: true, release: { outcome: "built", packageCount: 4 } };
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-package-"));
  const materialization = path.join(root, "materialization");
  const intake = path.join(root, "intake");
  const output = path.join(root, "candidate");
  const releaseIntake = path.join(root, "release-intake");
  await mkdir(path.join(materialization, "canonical-datasets", "processes"), {
    recursive: true,
  });
  await mkdir(
    path.join(materialization, "canonical-datasets", "lifecyclemodels"),
    { recursive: true },
  );
  await mkdir(path.join(intake, "calculation-bundle", "source"), {
    recursive: true,
  });
  const resultDocument = { processDataSet: { id: RESULT_ID } };
  const modelDocument = { lifeCycleModelDataSet: { id: MODEL_ID } };
  const generated = [
    await generatedEntry(
      materialization,
      "process",
      "result_process",
      RESULT_ID,
      `canonical-datasets/processes/${RESULT_ID}_${VERSION}.json`,
      resultDocument,
    ),
    await generatedEntry(
      materialization,
      "lifecyclemodel",
      "lifecycle_model",
      MODEL_ID,
      `canonical-datasets/lifecyclemodels/${MODEL_ID}_${VERSION}.json`,
      modelDocument,
    ),
  ];
  const materializedIndex = buildIndex(generated);
  await writeFile(
    path.join(materialization, "canonical-dataset-index.json"),
    canonicalJson(materializedIndex),
  );
  const sourceRecords = [
    sourceRecord("process", "unit_process", UNIT_ID, {
      processDataSet: { id: UNIT_ID },
    }),
    sourceRecord("flow", "support", FLOW_ID, { flowDataSet: { id: FLOW_ID } }),
  ];
  const sourceBytes = gzipSync(
    sourceRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  await writeFile(
    path.join(intake, "calculation-bundle", "source", "closure.ndjson.gz"),
    sourceBytes,
  );
  const intakeManifest = {
    schemaVersion: "tiangong.release.materialization-intake.v1",
    source: {
      adapter: "worker-calculation-bundle.v2",
      calculationId: CALCULATION_ID,
      bundleContentHash: "a".repeat(64),
      manifestSha256: "b".repeat(64),
    },
    artifacts: [
      {
        kind: "source_closure",
        path: "source/closure.ndjson.gz",
        sha256: sha256Bytes(sourceBytes),
        recordCount: sourceRecords.length,
      },
    ],
    verification: { manifest: "verified", artifacts: "verified" },
  };
  await writeFile(
    path.join(intake, "intake-manifest.json"),
    canonicalJson(intakeManifest),
  );
  const manifest = {
    schemaVersion: "tiangong.release.materialization-manifest.v1",
    completeness: "complete-for-selected-roots",
    inputs: {
      calculationId: CALCULATION_ID,
      bundleContentHash: "a".repeat(64),
      intakeManifestSha256: hashJson(intakeManifest),
      canonicalDatasetIndexSha256: hashJson(materializedIndex),
    },
    profiles: { result: "lci-lcia-result.v2", model: "resolved-one-hop.v1" },
    datasets: generated,
    validation: {},
  };
  await writeFile(
    path.join(materialization, "materialization-manifest.json"),
    canonicalJson(manifest),
  );
  await prepareReleaseIntake({
    materializationDir: materialization,
    sourceIntakeDir: intake,
    outDir: releaseIntake,
  });
  return { root, materialization, intake, releaseIntake, output };
}

async function createExclusionFixture({ retainedReference } = {}) {
  const fixture = await createFixture();
  const processAxisRecord = {
    processIndex: 0,
    rootProcess: { id: UNIT_ID, version: VERSION },
    quantitativeReference: {
      direction: "Output",
      exchangeInternalId: "0",
      flow: { id: FLOW_ID, version: VERSION },
      meanAmount: 1,
      referenceUnit: "kg",
    },
  };
  const processAxisText = `${JSON.stringify(processAxisRecord)}\n`;
  const processAxisPath = path.join(
    fixture.intake,
    "calculation-bundle",
    "axes",
    "processes-000000.ndjson",
  );
  await mkdir(path.dirname(processAxisPath), { recursive: true });
  await writeFile(processAxisPath, processAxisText);

  const intakePath = path.join(fixture.intake, "intake-manifest.json");
  const intake = JSON.parse(await readFile(intakePath, "utf8"));
  if (retainedReference) {
    const sourceArtifact = intake.artifacts.find(
      ({ kind }) => kind === "source_closure",
    );
    const sourcePath = path.join(
      fixture.intake,
      "calculation-bundle",
      sourceArtifact.path,
    );
    const sourceRecords = [];
    for await (const record of readNdjson(sourcePath))
      sourceRecords.push(record);
    const reference = {
      "@type": "process data set",
      "@refObjectId": UNIT_ID,
      "@version": VERSION,
    };
    const document =
      retainedReference.role === "lineage"
        ? {
            processDataSet: {
              administrativeInformation: {
                publicationAndOwnership: {
                  [retainedReference.field]: retainedReference.asArray
                    ? [reference]
                    : reference,
                },
              },
            },
          }
        : {
            processDataSet: {
              processInformation: {
                technology: {
                  [retainedReference.field]: reference,
                },
              },
            },
          };
    sourceRecords.push(
      sourceRecord(
        "process",
        "unit_process",
        UNIT_ID,
        document,
        RETAINED_UNIT_VERSION,
      ),
    );
    const sourceBytes = gzipSync(
      `${sourceRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    await writeFile(sourcePath, sourceBytes);
    sourceArtifact.sha256 = sha256Bytes(sourceBytes);
    sourceArtifact.recordCount = sourceRecords.length;
  }
  intake.artifacts.push({
    kind: "process_axis",
    path: "axes/processes-000000.ndjson",
    sha256: sha256Bytes(Buffer.from(processAxisText)),
    recordCount: 1,
  });
  await writeFile(intakePath, canonicalJson(intake));

  const resultDocument = {
    processDataSet: {
      id: RESULT_ID,
      referenceToSourceProcess: {
        "@refObjectId": UNIT_ID,
        "@version": VERSION,
      },
    },
  };
  const modelDocument = {
    lifeCycleModelDataSet: {
      id: MODEL_ID,
      referenceToReferenceProcess: {
        "@refObjectId": UNIT_ID,
        "@version": VERSION,
      },
      referenceToResultingProcess: {
        "@refObjectId": RESULT_ID,
        "@version": VERSION,
      },
    },
  };
  const materializedIndexPath = path.join(
    fixture.materialization,
    "canonical-dataset-index.json",
  );
  const materializedIndex = JSON.parse(
    await readFile(materializedIndexPath, "utf8"),
  );
  for (const [uuid, document] of [
    [RESULT_ID, resultDocument],
    [MODEL_ID, modelDocument],
  ]) {
    const dataset = materializedIndex.datasets.find(
      (candidate) => candidate.uuid === uuid,
    );
    const content = canonicalJson(document);
    await writeFile(path.join(fixture.materialization, dataset.path), content);
    dataset.sha256 = sha256Bytes(Buffer.from(content));
    dataset.byteSize = Buffer.byteLength(content);
    dataset.canonicalContentHash = hashJson(document);
  }
  const rebuiltIndex = buildIndex(materializedIndex.datasets);
  await writeFile(materializedIndexPath, canonicalJson(rebuiltIndex));

  const manifestPath = path.join(
    fixture.materialization,
    "materialization-manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.inputs.intakeManifestSha256 = hashJson(intake);
  manifest.inputs.canonicalDatasetIndexSha256 = hashJson(rebuiltIndex);
  manifest.datasets = rebuiltIndex.datasets.map((dataset) => ({
    ...dataset,
    processIndex: 0,
    sourceProcess: { id: UNIT_ID, version: VERSION },
    materializationRole:
      dataset.datasetType === "lifecyclemodel" ? "primary" : "resulting",
  }));
  await writeFile(manifestPath, canonicalJson(manifest));

  await rm(fixture.releaseIntake, { recursive: true, force: true });
  await prepareReleaseIntake({
    materializationDir: fixture.materialization,
    sourceIntakeDir: fixture.intake,
    outDir: fixture.releaseIntake,
  });

  const sourceRecords = [];
  const sourceArtifact = intake.artifacts.find(
    ({ kind }) => kind === "source_closure",
  );
  for await (const record of readNdjson(
    path.join(fixture.intake, "calculation-bundle", sourceArtifact.path),
  ))
    sourceRecords.push(record);
  const failedDatasets = [
    ...rebuiltIndex.datasets.map((dataset) => ({
      ...dataset,
      path: dataset.path.replace(/^canonical-datasets\//u, ""),
    })),
    ...sourceRecords.map((record) => ({
      datasetType: record.datasetType,
      role: record.role,
      uuid: record.uuid,
      version: record.version,
      path: record.path,
      sha256: record.sha256,
      byteSize: Buffer.byteLength(canonicalJson(record.document)),
      canonicalContentHash: record.sha256,
    })),
  ];
  const failedIndex = buildIndex(failedDatasets);
  const failedBuild = path.join(fixture.root, "failed-build");
  await mkdir(failedBuild);
  await writeFile(
    path.join(failedBuild, "canonical-dataset-index.json"),
    canonicalJson(failedIndex),
  );
  const releaseIntake = JSON.parse(
    await readFile(
      path.join(fixture.releaseIntake, "release-intake-manifest.json"),
      "utf8",
    ),
  );
  const failedPlan = {
    schemaVersion: "tiangong.release.package-plan.v1",
    releaseVersion: RELEASE_VERSION,
    profile: PACKAGE_PROFILE,
    materialization: {
      manifestSha256: hashJson(manifest),
      canonicalDatasetIndexSha256: hashJson(rebuiltIndex),
    },
    intake: {
      calculationId: CALCULATION_ID,
      bundleContentHash: intake.source.bundleContentHash,
      manifestSha256: hashJson(intake),
      releaseIntakeManifestSha256: hashJson(releaseIntake),
    },
    canonicalInput: {
      datasetCount: failedIndex.datasetCount,
      byteSize: failedIndex.byteSize,
      artifactSetHash: failedIndex.artifactSetHash,
    },
    packager: { adapter: "tidas-tools.release-build-packages.v1" },
  };
  await writeFile(
    path.join(failedBuild, "package-plan.json"),
    canonicalJson(failedPlan),
  );
  const issueSpool = path.join(fixture.root, "issues.ndjson");
  const issueEvent = {
    type: "issue",
    schema_version: "tidas.validation-issue-event.v1",
    issue_ordinal: 0,
    issue: {
      issue_code: "variable_parameter_reference_missing",
      severity: "error",
      category: "processes",
      file_path: `processes/${UNIT_ID}_${VERSION}.json`,
      location: "processDataSet/exchanges/exchange/0/referenceToVariable",
      message: "fixture missing variable",
    },
  };
  const issueText = `${JSON.stringify(issueEvent)}\n`;
  await writeFile(issueSpool, issueText);
  const failedManifest = {
    schemaVersion: "tiangong.release.failed-package-build.v1",
    status: "package_build_failed",
    publicationAuthorized: false,
    candidateCreated: false,
    releaseVersion: RELEASE_VERSION,
    profile: PACKAGE_PROFILE,
    requestedCandidatePath: fixture.output,
    packagePlanSha256: hashJson(failedPlan),
    packages: [],
    failure: {
      code: "tidas_package_build_failed",
      message: "fixture validation failed",
      stage: "package_build_or_validation",
      diagnostics: {
        operationReport: {
          artifacts: [
            {
              path: issueSpool,
              media_type: "application/x-ndjson",
              bytes: Buffer.byteLength(issueText),
              sha256: sha256Bytes(Buffer.from(issueText)),
            },
          ],
        },
      },
    },
    artifacts: {
      canonicalDatasetIndex: "canonical-dataset-index.json",
      packagePlan: "package-plan.json",
      packagesDirectory: "packages",
    },
  };
  await writeFile(
    path.join(failedBuild, "failed-package-build.json"),
    canonicalJson(failedManifest),
  );
  return { ...fixture, failedBuild };
}

async function configureMissingMethodFlow(fixture) {
  const sourceRecords = [
    sourceRecord("process", "unit_process", UNIT_ID, {
      processDataSet: { id: UNIT_ID },
    }),
    sourceRecord("lciamethod", "support", METHOD_ID, {
      LCIAMethodDataSet: {
        characterisationFactors: {
          factor: [
            {
              referenceToFlowDataSet: {
                "@type": "flow data set",
                "@refObjectId": FLOW_ID,
                "@version": VERSION,
              },
            },
          ],
        },
      },
    }),
  ];
  const sourceBytes = gzipSync(
    `${sourceRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  await writeFile(
    path.join(
      fixture.intake,
      "calculation-bundle",
      "source",
      "closure.ndjson.gz",
    ),
    sourceBytes,
  );
  const intakePath = path.join(fixture.intake, "intake-manifest.json");
  const intake = JSON.parse(await readFile(intakePath, "utf8"));
  intake.artifacts[0].sha256 = sha256Bytes(sourceBytes);
  intake.artifacts[0].recordCount = sourceRecords.length;
  await writeFile(intakePath, canonicalJson(intake));
  const manifestPath = path.join(
    fixture.materialization,
    "materialization-manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.inputs.intakeManifestSha256 = hashJson(intake);
  await writeFile(manifestPath, canonicalJson(manifest));
}

async function generatedEntry(
  root,
  datasetType,
  role,
  uuid,
  relativePath,
  document,
) {
  const content = canonicalJson(document);
  await writeFile(path.join(root, relativePath), content);
  return {
    datasetType,
    role,
    uuid,
    version: VERSION,
    path: relativePath,
    sha256: sha256Bytes(Buffer.from(content)),
    byteSize: Buffer.byteLength(content),
    canonicalContentHash: hashJson(document),
  };
}

function sourceRecord(datasetType, role, uuid, document, version = VERSION) {
  return {
    schemaVersion: "tiangong.source-closure.dataset.v1",
    datasetType,
    role,
    uuid,
    version,
    path: `${category(datasetType)}/${uuid}_${version}.json`,
    sha256: hashJson(document),
    document,
  };
}

function category(datasetType) {
  return datasetType === "process" ? "processes" : `${datasetType}s`;
}

function buildIndex(datasets) {
  const ordered = [...datasets].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasetCount: ordered.length,
    byteSize: ordered.reduce((total, entry) => total + entry.byteSize, 0),
    artifactSetHash: hashJson(
      ordered.map(({ datasetType, uuid, version, path: itemPath, sha256 }) => ({
        datasetType,
        uuid,
        version,
        path: itemPath,
        sha256,
      })),
    ),
    datasets: ordered,
  };
}
