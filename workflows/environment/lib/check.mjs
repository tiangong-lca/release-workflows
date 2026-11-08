import path from "node:path";
import os from "node:os";
import { access, stat, statfs, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadReleaseEnvironment } from "./configuration.mjs";
import { resolvePnpmInvocation } from "./pnpm-invocation.mjs";
import { PROFILES, RELEASE_ROOT, DATA_PLANE_SETTINGS } from "./settings.mjs";
import { safePublicationDatabaseDetails } from "./database-diagnostics.mjs";

const exec = promisify(execFile);
const has = (env, key) =>
  typeof env[key] === "string" && Boolean(env[key].trim());
const safeCode = (error) =>
  /^final_[a-z0-9_]{1,70}$/u.test(error?.code ?? "")
    ? error.code
    : "final_environment_check_failed";
const row = (id, status, message, extra = {}) => ({
  id,
  status,
  message,
  ...extra,
});
const toolEnv = (env) =>
  Object.fromEntries(
    ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TEMP"]
      .filter((k) => typeof env[k] === "string")
      .map((k) => [k, env[k]]),
  );

export async function probeTool(binary, args, env = process.env) {
  try {
    const result = await exec(binary, args, {
      env: toolEnv(env),
      shell: false,
      timeout: 10000,
      maxBuffer: 65536,
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch {
    throw Object.assign(
      new Error(
        "Tool unavailable, incompatible or timed out; configure its executable and rerun check",
      ),
      { code: "final_environment_tool_unavailable" },
    );
  }
}

export function serviceOrigin(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/functions/v1", "/functions/v1/"].includes(url.pathname) ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Invalid service origin");
  return url.origin;
}

const NETWORK_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];
async function boundedJsonGet(url, headers, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    const networkCode = error.cause?.code ?? error.code;
    throw Object.assign(new Error("Read-only HTTP connection failed"), {
      code: ["TimeoutError", "AbortError"].includes(error.name)
        ? "final_environment_http_timeout"
        : NETWORK_CODES.includes(networkCode) &&
            /CERT|TLS|SIGNATURE/u.test(networkCode)
          ? "final_environment_http_tls_failed"
          : "final_environment_http_unavailable",
      details: NETWORK_CODES.includes(networkCode) ? { networkCode } : {},
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error("Read-only endpoint rejected the request"), {
      code: "final_environment_http_probe_failed",
      details: { httpStatus: response.status },
    });
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new Error("Oversized response");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(
      new Error(
        "Read-only HTTP response was invalid, oversized or interrupted",
      ),
      { code: "final_environment_http_response_invalid" },
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function outputResources(outputDir, minFreeBytes) {
  let ancestor = path.resolve(outputDir);
  while (true) {
    try {
      if (!(await stat(ancestor)).isDirectory())
        throw new Error("Output ancestor is not a directory");
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || path.dirname(ancestor) === ancestor)
        throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  await access(ancestor, constants.W_OK);
  const disk = await statfs(ancestor, { bigint: true });
  const free = Number(disk.bavail * disk.bsize);
  return row(
    "output_resources",
    free < minFreeBytes ? "blocked" : "passed",
    "Nearest existing output directory is writable; disk space observed without creating files",
    {
      freeBytes: free,
      minimumFreeBytes: minFreeBytes,
      availableMemoryBytes: os.freemem(),
      workloadCapacityVerified: minFreeBytes > 0,
    },
  );
}

export async function checkEnvironment(
  options,
  {
    env = process.env,
    defaultFile = true,
    runTool = probeTool,
    fetchImpl = globalThis.fetch,
    createRegistry,
    createObjectStore,
  } = {},
) {
  const profile = options.for ?? "local";
  if (!Object.hasOwn(PROFILES, profile))
    throw Object.assign(
      new Error(
        "--for must be local, materialization, candidate, calculation, download, storage or readiness",
      ),
      { code: "final_environment_profile_invalid" },
    );
  if (options.candidate && !["storage", "readiness"].includes(profile))
    throw Object.assign(
      new Error("--candidate is supported only for storage/readiness checks"),
      { code: "final_environment_arguments_invalid" },
    );
  const checks = [];
  const registryModule = () =>
    import("../../publication/adapters/final-result-registry.mjs");
  const storageModule = () =>
    import("../../publication/lib/final-result-storage-command.mjs");
  const makeRegistry = async (args) =>
    createRegistry
      ? createRegistry(args)
      : (await registryModule()).createFinalResultRegistry(args);
  const makeStore = async (args) =>
    createObjectStore
      ? createObjectStore(args)
      : (
          await import("../../publication/adapters/final-result-object-store.mjs")
        ).createFinalResultObjectStore(args);

  const perform = async (id, action) => {
    try {
      const result = await action();
      checks.push(result ?? row(id, "passed", "Verified"));
    } catch (error) {
      checks.push(
        row(
          id,
          "blocked",
          "Check failed; follow the named setting or safe code and rerun Environment check",
          {
            code: safeCode(error),
            ...safePublicationDatabaseDetails(error),
            ...(NETWORK_CODES.includes(error.details?.networkCode)
              ? { networkCode: error.details.networkCode }
              : {}),
            ...(Number.isInteger(error.details?.httpStatus)
              ? { httpStatus: error.details.httpStatus }
              : {}),
            ...(PROFILES[profile].includes(error.details?.setting) ||
            error.details?.setting === "config-env"
              ? { setting: error.details.setting }
              : {}),
          },
        ),
      );
    }
  };
  let loaded;
  await perform("configuration", async () => {
    loaded = await loadReleaseEnvironment(options, {
      env,
      defaultFile,
      settings: PROFILES[profile],
    });
    return row(
      "configuration",
      "passed",
      "Selected configuration loaded without exposing values",
    );
  });
  const environment = loaded?.environment ?? {};
  const expectedNode = (
    await readFile(path.join(RELEASE_ROOT, ".node-version"), "utf8")
  ).trim();
  checks.push(
    row(
      "node",
      process.versions.node === expectedNode ? "passed" : "warning",
      "Node runtime observation; version differences do not enable engineStrict",
      { actual: process.versions.node, expected: expectedNode },
    ),
  );
  checks.push(
    row(
      "platform",
      [
        ["darwin", "arm64"],
        ["linux", "x64"],
        ["win32", "x64"],
      ].some(
        ([platform, architecture]) =>
          process.platform === platform && process.arch === architecture,
      )
        ? "passed"
        : "blocked",
      "macOS ARM64, Linux x64 and Windows x64 are supported native targets",
      { platform: process.platform, architecture: process.arch },
    ),
  );
  await perform("pnpm", async () => {
    const invocation = resolvePnpmInvocation(env.npm_execpath ?? "pnpm", {
      pathValue: env.PATH ?? process.env.PATH,
      pnpmHome: env.PNPM_HOME,
    });
    const result = await runTool(
      invocation.command,
      [...invocation.prefixArgs, "--version"],
      env,
    );
    const actual = result.stdout.trim();
    const manifest = JSON.parse(
      await readFile(path.join(RELEASE_ROOT, "package.json")),
    );
    return row(
      "pnpm",
      `pnpm@${actual}` === manifest.packageManager ? "passed" : "warning",
      "Package manager available; use the repository-pinned release",
      {
        ...(/^\d+\.\d+\.\d+$/u.test(actual) ? { actual } : {}),
        expected: manifest.packageManager,
      },
    );
  });
  await perform("dependencies", async () => {
    const modules = {
      materialization: ["@tiangong-lca/tidas-sdk"],
      candidate: ["canonicalize", "exceljs"],
      calculation: ["pg", "@aws-sdk/client-s3"],
      download: ["pg", "@aws-sdk/client-s3"],
      storage: ["pg", "@aws-sdk/client-s3"],
      readiness: ["pg", "@aws-sdk/client-s3"],
    };
    const owner = {
      materialization: "result-materialization",
      candidate: "release-candidate",
      calculation: "calculation",
      download: "calculation",
      storage: "publication",
      readiness: "publication",
    }[profile];
    if (!owner)
      return row(
        "dependencies",
        "not_checked",
        "Local diagnostics require no business dependencies; select a workflow to check installed versions",
      );
    if (owner) {
      const ownerRoot = path.join(RELEASE_ROOT, "workflows", owner);
      const ownerManifest = JSON.parse(
        await readFile(path.join(ownerRoot, "package.json")),
      );
      for (const name of modules[profile]) {
        const installed = JSON.parse(
          await readFile(
            path.join(ownerRoot, "node_modules", name, "package.json"),
          ),
        );
        if (
          installed.name !== name ||
          installed.version !== ownerManifest.dependencies[name]
        )
          throw new Error(
            "Installed dependency differs from locked owner requirement",
          );
      }
    }
    return row(
      "dependencies",
      "passed",
      "Selected workflow dependency manifests match installed versions; install with pnpm install --frozen-lockfile if missing",
    );
  });
  await perform("output_resources", () =>
    outputResources(
      options["output-dir"] ?? path.join(RELEASE_ROOT, ".release"),
      Number(options["min-free-gib"] ?? 0) * 1024 ** 3,
    ),
  );
  const required = [];
  if (["calculation", "readiness"].includes(profile))
    required.push(
      "TIANGONG_LCA_API_BASE_URL",
      "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY",
    );
  if (["download", "storage", "readiness"].includes(profile))
    required.push(
      "CONN",
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    );
  if (profile === "readiness") required.push("RESULT_QUERY_ENDPOINT");
  for (const key of required)
    checks.push(
      row(
        `setting:${key}`,
        has(environment, key) ? "passed" : "blocked",
        has(environment, key)
          ? "Configured; value hidden"
          : `Set ${key} in the selected configuration`,
        { setting: key },
      ),
    );
  if (["calculation", "readiness"].includes(profile)) {
    const configured =
      has(environment, "TIANGONG_LCA_ACCESS_TOKEN") ||
      has(environment, "TIANGONG_LCA_API_KEY");
    checks.push(
      row(
        "actor_session",
        configured ? "passed" : "blocked",
        configured
          ? "Credential source configured; authentication has not been proved"
          : "Configure an actor JWT or existing user bootstrap; check never logs in",
        { authenticationVerified: false },
      ),
    );
    if (has(environment, "TIANGONG_LCA_API_BASE_URL"))
      await perform("api_origin", () => {
        serviceOrigin(environment.TIANGONG_LCA_API_BASE_URL);
      });
  }
  if (profile === "readiness") {
    const sources = [
      "RESULT_QUERY_SERVICE_SECRET",
      "RESULT_QUERY_SERVICE_SECRET_FILE",
      "RESULT_QUERY_SERVICE_SECRET_SSH_HOST",
    ].filter((k) => has(environment, k));
    checks.push(
      row(
        "reader_secret_source",
        sources.length === 1 ? "passed" : "blocked",
        "Configure exactly one reader secret source; check never retrieves SSH secrets",
        { sourceCount: sources.length },
      ),
    );
    if (sources[0] === "RESULT_QUERY_SERVICE_SECRET_FILE")
      await perform("reader_secret_file", () =>
        access(environment.RESULT_QUERY_SERVICE_SECRET_FILE, constants.R_OK),
      );
    if (
      sources[0] === "RESULT_QUERY_SERVICE_SECRET_SSH_HOST" &&
      !has(environment, "RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE")
    )
      checks.push(
        row(
          "reader_ssh_file",
          "blocked",
          "Set RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE",
          { setting: "RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE" },
        ),
      );
    if (has(environment, "RESULT_QUERY_ENDPOINT"))
      await perform("reader_origin", () => {
        const origin = serviceOrigin(environment.RESULT_QUERY_ENDPOINT);
        if (origin !== environment.RESULT_QUERY_ENDPOINT.replace(/\/$/u, ""))
          throw new Error("Reader requires an origin");
      });
  }
  let target;
  if (has(environment, "CONN"))
    await perform("database_target", async () => {
      (await registryModule()).finalResultDatabaseTargetHash(environment.CONN);
    });
  if (
    ["download", "storage", "readiness"].includes(profile) &&
    required
      .filter((k) => DATA_PLANE_SETTINGS.includes(k))
      .every((k) => has(environment, k))
  )
    await perform("storage_target", async () => {
      target = (await storageModule()).finalResultStorageEnvironment(
        environment,
      );
    });
  if (profile === "candidate") {
    await perform("tidas", async () => {
      const { verifyTidasRuntime, RESULT_PACKAGE_PROFILE } =
        await import("../../release-candidate/lib/package-build.mjs");
      const result = await verifyTidasRuntime({
        tidasBin: environment.TIDAS_BIN ?? "tidas",
        profile: RESULT_PACKAGE_PROFILE,
        memoryBudgetMiB: environment.TIDAS_MEMORY_BUDGET_MIB ?? 2048,
        spawnCommand: (bin, args) => runTool(bin, args, env),
      });
      return row(
        "tidas",
        "passed",
        "Toolkit advertises Result-only packaging and document-validation capabilities",
        {
          ...(/^\d+\.\d+\.\d+(?:[+.-][A-Za-z0-9.-]+)?$/u.test(
            result.binaryVersion ?? "",
          )
            ? { version: result.binaryVersion }
            : {}),
        },
      );
    });
    await perform("seven_zip", async () => {
      const { SEVEN_ZIP_VERSION } =
        await import("../../release-candidate/lib/seven-zip.mjs");
      const result = await runTool(
        environment.RELEASE_7ZIP_BIN ??
          (process.platform === "win32" ? "7z" : "7zz"),
        ["i"],
        env,
      );
      if (!/^7-Zip(?: \([^\n]*\))? 26\.05(?: |\r?$)/mu.test(result.stdout))
        throw new Error("Unqualified 7-Zip");
      return row(
        "seven_zip",
        "passed",
        "Qualified archive implementation available",
        { version: SEVEN_ZIP_VERSION },
      );
    });
    await perform("hdf5", async () => {
      const bin =
        environment.RELEASE_HDF5_BIN ??
        path.join(
          RELEASE_ROOT,
          "workflows/release-candidate/native/target/debug",
          process.platform === "win32"
            ? "release-result-hdf5.exe"
            : "release-result-hdf5",
        );
      const result = await runTool(bin, ["--help"], env);
      if (
        !result.stdout.includes("TGQNUM02") ||
        !result.stdout.includes("build|verify")
      )
        throw new Error("Wrong encoder");
      return row(
        "hdf5",
        "passed",
        "Release encoder is executable; Rust/CMake are needed only to build a missing encoder",
      );
    });
  }
  const networkReady = loaded && !checks.some((c) => c.status === "blocked");
  const remoteCheck = async (id, needed, action) => {
    if (!needed) return;
    if (!options.remote || !networkReady) {
      checks.push(
        row(
          id,
          "not_checked",
          options.remote
            ? "Fix local blockers before remote checks"
            : "Use --remote for this bounded read-only check",
        ),
      );
      return;
    }
    await perform(id, action);
  };
  await remoteCheck(
    "database_connection",
    ["download", "storage", "readiness"].includes(profile),
    async () => {
      const registry = await makeRegistry({
        connectionString: environment.CONN,
      });
      try {
        await registry.checkConnection();
        return row(
          "database_connection",
          "passed",
          "Read-only database transaction and service role verified",
        );
      } finally {
        await registry.close();
      }
    },
  );
  await remoteCheck(
    "storage_connection",
    ["download", "storage", "readiness"].includes(profile),
    async () => {
      const store = await makeStore({
        target: target.target,
        credentials: {
          accessKeyId: environment.S3_ACCESS_KEY_ID,
          secretAccessKey: environment.S3_SECRET_ACCESS_KEY,
          ...(environment.S3_SESSION_TOKEN
            ? { sessionToken: environment.S3_SESSION_TOKEN }
            : {}),
        },
        timeoutMs: 10000,
      });
      try {
        return row(
          "storage_connection",
          "passed",
          "Bucket HEAD succeeded; upload permission and effective size limit remain unverified",
          await store.checkConnection(),
        );
      } finally {
        await store.close();
      }
    },
  );
  await remoteCheck(
    "actor_authentication",
    ["calculation", "readiness"].includes(profile),
    async () => {
      if (!has(environment, "TIANGONG_LCA_ACCESS_TOKEN"))
        return row(
          "actor_authentication",
          "not_checked",
          "No current JWT; check does not create a session from the configured bootstrap",
        );
      const { createFinalResultActorTransport } =
        await import("../../publication/adapters/final-result-actor-transport.mjs");
      const actorTransport = createFinalResultActorTransport({
        endpoint: serviceOrigin(environment.TIANGONG_LCA_API_BASE_URL),
        publishableKey: environment.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY,
        accessToken: environment.TIANGONG_LCA_ACCESS_TOKEN,
        timeoutMs: 10000,
      });
      const result = await boundedJsonGet(
        `${serviceOrigin(environment.TIANGONG_LCA_API_BASE_URL)}/auth/v1/user`,
        {
          apikey: environment.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${environment.TIANGONG_LCA_ACCESS_TOKEN}`,
        },
        fetchImpl,
      );
      if (result.id !== actorTransport.actorId)
        throw new Error("Invalid user response");
      return row(
        "actor_authentication",
        "passed",
        "Current actor authenticated; command-specific manager authorization is checked at execution",
      );
    },
  );
  await remoteCheck("reader_liveness", profile === "readiness", async () => {
    const result = await boundedJsonGet(
      `${serviceOrigin(environment.RESULT_QUERY_ENDPOINT)}/health`,
      {},
      fetchImpl,
    );
    if (
      result.status !== "ok" ||
      (result.service !== undefined && result.service !== "result-query")
    )
      throw Object.assign(new Error("Unexpected reader health"), {
        code: "final_environment_reader_response_invalid",
      });
    if (result.service === undefined)
      return row(
        "reader_liveness",
        "warning",
        "Configured endpoint health is reachable, but the response does not identify the query service; signed reader verification remains required",
        { endpointReachable: true, queryServiceIdentified: false },
      );
    return row(
      "reader_liveness",
      "passed",
      "Query service is live; signed numeric queries and publication readiness remain unverified",
      { endpointReachable: true, queryServiceIdentified: true },
    );
  });
  await remoteCheck(
    "candidate_storage_binding",
    Boolean(options.candidate),
    async () => {
      const { inspectFinalResultStorage, preflightFinalResultStorage } =
        await import("../../publication/lib/final-result-storage.mjs");
      const { plan, planHash } = await inspectFinalResultStorage({
        candidateDir: path.resolve(options.candidate),
        targetHash: target.targetHash,
      });
      const registry = await makeRegistry({
        connectionString: environment.CONN,
      });
      try {
        await preflightFinalResultStorage({ plan, registry });
        return row(
          "candidate_storage_binding",
          "passed",
          "Exact local Candidate and existing registry bindings verified read-only",
          {
            candidateHash: plan.candidateHash,
            storagePlanHash: planHash,
            targetHash: plan.targetHash,
            resultCount: plan.resultCount,
          },
        );
      } finally {
        await registry.close();
      }
    },
  );
  checks.push(
    row(
      "business_readiness",
      "not_checked",
      "Business input qualification, S3 writes/limits, reader numerical parity and publication approval remain owned by their workflow execution checks",
    ),
  );
  const blocked = checks.filter((c) => c.status === "blocked").length;
  return {
    ok: blocked === 0,
    command: "environment check",
    schemaVersion: "tiangong.release-environment-check.v1",
    profile,
    outcome: blocked ? "environment_blocked" : "environment_checked",
    completeness: options.remote ? "selected_read_only_checks" : "local_only",
    configuration:
      loaded?.configuration ??
      (options["config-env"]
        ? {
            file: path.resolve(options["config-env"]),
            sources: {},
            valuesExposed: false,
          }
        : null),
    checks,
    summary: {
      passed: checks.filter((c) => c.status === "passed").length,
      blocked,
      warnings: checks.filter((c) => c.status === "warning").length,
      notChecked: checks.filter((c) => c.status === "not_checked").length,
    },
    uploadAttempted: false,
    registryWriteAttempted: false,
    publicationAuthorized: false,
  };
}
