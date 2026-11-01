import path from "node:path";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fail, hashJson, canonicalJson } from "./common.mjs";
import {
  assertAbsent,
  writeCanonical,
  writeImmutableDirectory,
} from "./io.mjs";
import {
  inspectFinalResultStorage,
  executeFinalResultStorage,
} from "./final-result-storage.mjs";
import {
  finalResultDatabaseTargetHash,
  createFinalResultRegistry,
} from "../adapters/final-result-registry.mjs";
import {
  finalResultStorageTarget,
  createFinalResultObjectStore,
} from "../adapters/final-result-object-store.mjs";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const HASH = /^[0-9a-f]{64}$/u;
const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
function next(args) {
  const argv = ["node", CLI, "result-storage", ...args];
  return {
    kind: "store_final_result_candidate",
    argv,
    command: argv.map(quote).join(" "),
  };
}
function envValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim())
    fail(
      "final_storage_environment_required",
      `Explicit process environment ${name} is required`,
      { missingEnvironment: name },
    );
  return value.trim();
}
export function finalResultStorageEnvironment(env) {
  // Parse only the declared target. No SDK/client, credential discovery or
  // database connection is opened by inspect or confirmation validation.
  return finalResultStorageTarget({
    databaseTargetHash: finalResultDatabaseTargetHash(envValue(env, "CONN")),
    endpoint: envValue(env, "S3_ENDPOINT"),
    region: envValue(env, "S3_REGION"),
    bucket: envValue(env, "S3_BUCKET"),
    prefix: env.S3_PREFIX?.trim() || "",
  });
}
async function assertExternalOutput(candidateDir, outDir) {
  const candidateRoot = await realpath(candidateDir);
  let ancestor = outDir;
  const suffix = [];
  for (;;) {
    try {
      const resolved = path.resolve(await realpath(ancestor), ...suffix);
      if (
        resolved === candidateRoot ||
        resolved.startsWith(`${candidateRoot}${path.sep}`)
      )
        fail(
          "final_storage_output_inside_candidate",
          "Storage evidence must not be added inside the frozen Candidate",
        );
      return;
    } catch (error) {
      if (error.code !== "ENOENT" || path.dirname(ancestor) === ancestor)
        throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}
export async function runFinalResultStorageCommand(
  action,
  options,
  {
    env = process.env,
    inspect = inspectFinalResultStorage,
    execute = executeFinalResultStorage,
    createObjectStore = createFinalResultObjectStore,
    createRegistry = createFinalResultRegistry,
  } = {},
) {
  const allowed =
    action === "inspect"
      ? ["candidate", "out-dir", "json", "help"]
      : action === "execute"
        ? ["candidate", "out-dir", "confirm", "json", "help"]
        : null;
  if (!allowed) fail("unknown_command", "Unknown final Result storage action");
  for (const key of Object.keys(options))
    if (!allowed.includes(key))
      fail(
        "invalid_arguments",
        `Option --${key} is not accepted by result-storage ${action}`,
      );
  for (const key of [
    "candidate",
    "out-dir",
    ...(action === "execute" ? ["confirm"] : []),
  ])
    if (typeof options[key] !== "string" || !options[key].trim())
      fail("invalid_arguments", `Missing required option --${key}`);
  if (action === "execute" && !HASH.test(options.confirm))
    fail(
      "invalid_arguments",
      "--confirm must be the exact storage plan SHA-256",
    );
  const candidateDir = path.resolve(options.candidate),
    outDir = path.resolve(options["out-dir"]);
  let attemptCreated = false,
    objectStore,
    registry;
  try {
    const { target, targetHash } = finalResultStorageEnvironment(env);
    await assertExternalOutput(candidateDir, outDir);
    const { plan, planHash } = await inspect({ candidateDir, targetHash });
    if (
      hashJson(plan) !== planHash ||
      plan.targetHash !== targetHash ||
      plan.publicationAuthorized !== false
    )
      fail("final_storage_binding_invalid", "Invalid inspected storage plan");
    const common = {
      ok: true,
      command: `result-storage ${action}`,
      storagePlanHash: planHash,
      candidateHash: plan.candidateHash,
      targetHash,
      resultCount: plan.resultCount,
      memberCount: plan.memberCount,
      artifactCount: plan.artifacts.length,
      publicationAuthorized: false,
    };
    if (action === "inspect") {
      await writeImmutableDirectory(outDir, async (dir) => {
        await writeCanonical(path.join(dir, "storage-target.json"), target);
        await writeFile(
          path.join(dir, "storage-plan.json"),
          canonicalJson(plan).slice(0, -1),
          { flag: "wx" },
        );
      });
      return {
        ...common,
        outcome: "final_result_storage_plan_prepared",
        completeness: "local_files_verified_remote_storage_pending",
        artifacts: {
          storagePlan: path.join(outDir, "storage-plan.json"),
          storageTarget: path.join(outDir, "storage-target.json"),
        },
        nextActions: [
          next([
            "execute",
            "--candidate",
            candidateDir,
            "--confirm",
            planHash,
            "--out-dir",
            `${outDir}-execution`,
            "--json",
          ]),
        ],
      };
    }
    if (options.confirm !== planHash)
      fail(
        "final_storage_confirmation_mismatch",
        "Storage confirmation differs from the exact Candidate and target",
      );
    // No implicit .env loading and no AWS default credential-provider chain.
    const credentials = {
      accessKeyId: envValue(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: envValue(env, "S3_SECRET_ACCESS_KEY"),
      ...(env.S3_SESSION_TOKEN?.trim()
        ? { sessionToken: env.S3_SESSION_TOKEN.trim() }
        : {}),
    };
    await assertAbsent(outDir);
    await mkdir(path.dirname(outDir), { recursive: true });
    await mkdir(outDir);
    await writeCanonical(path.join(outDir, "storage-attempt.json"), {
      schemaVersion: "tiangong.final-result-storage-attempt.v1",
      planHash,
      candidateHash: plan.candidateHash,
      targetHash,
      startedAt: new Date().toISOString(),
      publicationAuthorized: false,
    });
    attemptCreated = true;
    objectStore = createObjectStore({ target, credentials });
    registry = createRegistry({ connectionString: env.CONN.trim() });
    const receipt = await execute({
      candidateDir,
      confirmPlanHash: planHash,
      objectStore,
      registry,
    });
    if (
      receipt.planHash !== planHash ||
      receipt.candidateHash !== plan.candidateHash ||
      receipt.targetHash !== targetHash ||
      receipt.publicationAuthorized !== false
    )
      fail(
        "final_storage_binding_invalid",
        "Storage receipt does not match the confirmed plan",
      );
    await writeCanonical(path.join(outDir, "storage-receipt.json"), receipt);
    return {
      ...common,
      outcome: "final_result_storage_verified",
      completeness: "storage_verified_publication_adapter_pending",
      multipartCleanupRequired: receipt.multipartCleanupRequired === true,
      artifacts: {
        storageAttempt: path.join(outDir, "storage-attempt.json"),
        storageReceipt: path.join(outDir, "storage-receipt.json"),
      },
      nextActions: [],
    };
  } catch (error) {
    // Raw filesystem/provider/connection errors may contain secrets. Keep only
    // owner-defined codes and the explicit multipart cleanup fact.
    const code = /^final_[a-z0-9_]{1,70}$/u.test(error?.code ?? "")
      ? error.code
      : error?.code === "output_exists" || error?.code === "EEXIST"
        ? "final_storage_output_exists"
        : "final_storage_command_failed";
    const details = {
      attemptRetained: attemptCreated,
      ...([
        "CONN",
        "S3_ENDPOINT",
        "S3_REGION",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
      ].includes(error?.details?.missingEnvironment)
        ? { missingEnvironment: error.details.missingEnvironment }
        : {}),
      multipartCleanupRequired:
        error?.details?.multipartCleanupRequired === true,
    };
    if (attemptCreated) {
      await writeCanonical(path.join(outDir, "storage-failure.json"), {
        schemaVersion: "tiangong.final-result-storage-failure.v1",
        code,
        failedAt: new Date().toISOString(),
        publicationAuthorized: false,
        remoteOutcome: "reconcile-exact-identity-before-retry",
        ...details,
      }).catch(() => {});
    }
    const safeError = Object.assign(
      new Error(
        "Final Result storage did not complete. Preserve attempt evidence and retry the same confirmed Candidate and target using a new output directory.",
      ),
      { code, details },
    );
    if (attemptCreated)
      safeError.nextActions = [
        next([
          "execute",
          "--candidate",
          candidateDir,
          "--confirm",
          options.confirm,
          "--out-dir",
          `${outDir}-retry`,
          "--json",
        ]),
      ];
    throw safeError;
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => objectStore?.close()),
      Promise.resolve().then(() => registry?.close()),
    ]);
  }
}
