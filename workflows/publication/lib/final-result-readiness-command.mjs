import path from "node:path";
import { prepareFinalResultReadinessEnvironment } from "./final-result-readiness-runtime.mjs";
import { inspectFinalResultReadiness } from "./final-result-readiness-inspection.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalJson, fail } from "./common.mjs";
import { assertAbsent } from "./io.mjs";
import {
  assertFinalResultExternalOutput,
  finalResultStorageEnvironment,
} from "./final-result-storage-command.mjs";
import { verifyFinalResultReadiness } from "./final-result-readiness.mjs";
import {
  createFinalResultRegistry,
  safePublicationDatabaseDetails,
} from "../adapters/final-result-registry.mjs";
import { createFinalResultObjectStore } from "../adapters/final-result-object-store.mjs";
import { createFinalResultActor } from "../adapters/final-result-actor.mjs";
import { createFinalResultReader } from "../adapters/final-result-reader.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const quote = (s) => `'${String(s).replaceAll("'", `'"'"'`)}'`;
function envValue(env, key) {
  if (typeof env[key] !== "string" || !env[key].trim())
    fail(
      "final_readiness_environment_required",
      "Explicit readiness environment is missing",
      { missingEnvironment: key },
    );
  return env[key].trim();
}
const required = (v) => {
  if (!v)
    fail(
      "final_readiness_command_invalid",
      "Exact Candidate, frozen input, run and plan identity are required",
    );
};

// This command records verification evidence only. It has no publication action.
export async function runFinalResultReadinessCommand(
  action,
  options,
  {
    env = process.env,
    verify = verifyFinalResultReadiness,
    inspect = inspectFinalResultReadiness,
    prepareEnvironment = prepareFinalResultReadinessEnvironment,
    createRegistry = createFinalResultRegistry,
    createObjectStore = createFinalResultObjectStore,
    createActor = createFinalResultActor,
    createReader = createFinalResultReader,
  } = {},
) {
  if (!["verify", "inspect"].includes(action))
    fail("unknown_command", "Unknown final Result readiness action");
  const allowed = [
    "config-env",
    "bootstrap-session",
    "candidate",
    "final-input",
    "run-id",
    "publish-plan-hash",
    "out-dir",
    "json",
    "help",
  ];
  for (const name of Object.keys(options))
    if (!allowed.includes(name))
      fail(
        "invalid_arguments",
        `Option --${name} is not accepted by result-readiness ${action}`,
      );
  for (const key of [
    "candidate",
    "final-input",
    "run-id",
    "publish-plan-hash",
    "out-dir",
  ])
    required(typeof options[key] === "string" && options[key].trim());
  required(
    UUID.test(options["run-id"]) && HASH.test(options["publish-plan-hash"]),
  );
  const candidateDir = path.resolve(options.candidate),
    inputDir = path.resolve(options["final-input"]),
    outDir = path.resolve(options["out-dir"]);
  const releaseRunId = options["run-id"],
    publishPlanHash = options["publish-plan-hash"],
    verificationId = randomUUID();
  let registry,
    objectStore,
    created = false,
    sealedReceipt;
  const retryArgs = [
    "node",
    CLI,
    "result-readiness",
    action,
    ...(options["config-env"]
      ? ["--config-env", path.resolve(options["config-env"])]
      : []),
    ...(options["bootstrap-session"] ? ["--bootstrap-session"] : []),
    "--candidate",
    candidateDir,
    "--final-input",
    inputDir,
    "--run-id",
    releaseRunId,
    "--publish-plan-hash",
    publishPlanHash,
    "--out-dir",
    `${outDir}-retry`,
    "--json",
  ];
  const nextActions = [
    {
      kind:
        action === "verify"
          ? "verify_final_result_readiness_again"
          : "inspect_final_result_readiness_again",
      argv: retryArgs,
      command: retryArgs.map(quote).join(" "),
    },
  ];
  const write = (relative, value) =>
    writeFile(path.join(outDir, relative), canonicalJson(value), {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
  try {
    await assertFinalResultExternalOutput(candidateDir, outDir);
    await assertFinalResultExternalOutput(inputDir, outDir);
    await assertAbsent(outDir);
    env = await prepareEnvironment(options, { env });
    const { target, targetHash } = finalResultStorageEnvironment(env);
    const credentials =
      action === "verify"
        ? {
            accessKeyId: envValue(env, "S3_ACCESS_KEY_ID"),
            secretAccessKey: envValue(env, "S3_SECRET_ACCESS_KEY"),
            ...(env.S3_SESSION_TOKEN?.trim()
              ? { sessionToken: env.S3_SESSION_TOKEN.trim() }
              : {}),
          }
        : null;
    const actorConfig = {
      endpoint: envValue(env, "TIANGONG_LCA_API_BASE_URL"),
      publishableKey: envValue(env, "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY"),
      accessToken: envValue(env, "TIANGONG_LCA_ACCESS_TOKEN"),
    };
    const readerConfig = {
      endpoint: envValue(env, "RESULT_QUERY_ENDPOINT"),
      secret: envValue(env, "RESULT_QUERY_SERVICE_SECRET"),
    };
    // Constructors validate explicit settings but do not contact remote services.
    const actor = createActor(actorConfig),
      reader = createReader(readerConfig);
    await mkdir(path.dirname(outDir), { recursive: true });
    await mkdir(outDir, { mode: 0o700 });
    created = true;
    await mkdir(path.join(outDir, "proofs"), { mode: 0o700 });
    await write("command-attempt.json", {
      schemaVersion:
        action === "verify"
          ? "tiangong.final-result-readiness-command.v1"
          : "tiangong.final-result-readiness-inspection-command.v1",
      ...(action === "verify" ? { verificationId } : {}),
      releaseRunId,
      publishPlanHash,
      candidateDir,
      inputDir,
      actorId: actor.actorId,
      startedAt: new Date().toISOString(),
      publicationAuthorized: false,
    });
    registry = createRegistry({ connectionString: envValue(env, "CONN") });
    if (action === "inspect") {
      const observation = await inspect({
        candidateDir,
        releaseRunId,
        publishPlanHash,
        targetHash,
        registry,
        actor,
        reader,
      });
      required(
        observation.releaseRunId === releaseRunId &&
          observation.publishPlanHash === publishPlanHash &&
          observation.targetHash === targetHash &&
          observation.publicationAuthorized === false &&
          observation.readinessVerified === false,
      );
      await write("readiness-inspection.json", observation);
      const argv = [...retryArgs];
      argv[3] = "verify";
      argv[argv.indexOf("--out-dir") + 1] = `${outDir}-verification`;
      return {
        ok: true,
        command: "result-readiness inspect",
        outcome: "final_result_readiness_inspected",
        completeness: "configuration_inspected_verification_pending",
        releaseRunId,
        publishPlanHash,
        candidateHash: observation.candidateHash,
        targetHash,
        selectionCount: observation.selectionCount,
        artifactCount: observation.artifactCount,
        readerProbeCount: observation.readerProbeCount,
        runtimeRevision: observation.runtimeRevision,
        readinessVerified: false,
        publicationAuthorized: false,
        artifacts: {
          inspection: path.join(outDir, "readiness-inspection.json"),
        },
        nextActions: [
          {
            kind: "verify_final_result_readiness",
            argv,
            command: argv.map(quote).join(" "),
          },
        ],
      };
    }
    objectStore = createObjectStore({ target, credentials });
    const receipt = await verify({
      candidateDir,
      inputDir,
      releaseRunId,
      publishPlanHash,
      verificationId,
      objectStore,
      registry,
      actor,
      reader,
      record: async (event) => {
        if (
          event.schemaVersion ===
          "tiangong.final-result-readiness-local-attempt.v1"
        ) {
          required(event.verificationId === verificationId);
          return write("readiness-attempt.json", event);
        }
        if (event.kind === "header") {
          required(event.header?.verificationId === verificationId);
          return write("readiness-header.json", event.header);
        }
        if (event.kind === "artifact") {
          required(
            event.verificationId === verificationId &&
              UUID.test(event.proof?.artifact?.artifactId ?? ""),
          );
          return write(
            `proofs/${event.proof.artifact.artifactId}.json`,
            event.proof,
          );
        }
        if (event.kind === "sealed") {
          required(
            event.receipt?.verificationId === verificationId &&
              event.receipt.releaseRunId === releaseRunId &&
              event.receipt.publishPlanHash === publishPlanHash &&
              event.receipt.publicationAuthorized === false,
          );
          await write("readiness-receipt.json", event.receipt);
          sealedReceipt = canonicalJson(event.receipt);
          return;
        }
        required(false);
      },
    });
    required(
      sealedReceipt === canonicalJson(receipt) &&
        receipt.verificationId === verificationId &&
        receipt.releaseRunId === releaseRunId &&
        receipt.publishPlanHash === publishPlanHash &&
        receipt.publicationAuthorized === false,
    );
    return {
      ok: true,
      command: "result-readiness verify",
      outcome: "final_result_readiness_verified",
      completeness: "readiness_verified_actor_approval_pending",
      verificationId,
      releaseRunId,
      publishPlanHash,
      candidateHash: receipt.candidateHash,
      targetHash: receipt.targetHash,
      artifactCount: receipt.artifactCount,
      probeCount: receipt.probeCount,
      fileCount: receipt.fileCount,
      expiresAt: receipt.expiresAt,
      publicationAuthorized: false,
      artifacts: {
        attempt: path.join(outDir, "command-attempt.json"),
        readinessReceipt: path.join(outDir, "readiness-receipt.json"),
      },
      nextActions: [],
    };
  } catch (error) {
    const code =
      typeof error.code === "string" &&
      /^(?:final_[a-z0-9_]+|output_exists|invalid_arguments)$/u.test(error.code)
        ? error.code
        : "final_readiness_command_failed";
    if (created)
      await write("failure.json", {
        schemaVersion:
          action === "verify"
            ? "tiangong.final-result-readiness-failure.v1"
            : "tiangong.final-result-readiness-inspection-failure.v1",
        ...(action === "verify" ? { verificationId } : {}),
        releaseRunId,
        publishPlanHash,
        code,
        ...safePublicationDatabaseDetails(error),
        failedAt: new Date().toISOString(),
        publicationAuthorized: false,
      }).catch(() => {});
    const safe = new Error(
      code === "final_publication_database_tls_failed"
        ? "Database TLS verification failed; configure RELEASE_DATABASE_CA_FILE or CONN sslrootcert before a new readiness attempt"
        : "Readiness did not complete; preserve the attempt, check the reported setting or condition, then retry in a new directory",
    );
    safe.code = code;
    safe.details = {
      ...(action === "verify" ? { verificationId } : {}),
      attemptCreated: created,
      ...safePublicationDatabaseDetails(error),
      ...(created ? { attemptDirectory: outDir } : {}),
      ...(error.details?.setting ? { setting: error.details.setting } : {}),
      ...(error.details?.missingEnvironment
        ? { missingEnvironment: error.details.missingEnvironment }
        : {}),
    };
    safe.nextActions =
      code.startsWith("final_publication_") ||
      code.startsWith("final_environment_")
        ? []
        : nextActions;
    throw safe;
  } finally {
    try {
      await registry?.close();
    } catch {}
    try {
      await objectStore?.close();
    } catch {}
  }
}
