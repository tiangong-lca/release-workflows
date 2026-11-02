import path from "node:path";
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
import { createFinalResultRegistry } from "../adapters/final-result-registry.mjs";
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
    createRegistry = createFinalResultRegistry,
    createObjectStore = createFinalResultObjectStore,
    createActor = createFinalResultActor,
    createReader = createFinalResultReader,
  } = {},
) {
  if (action !== "verify")
    fail("unknown_command", "Unknown final Result readiness action");
  const allowed = [
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
        `Option --${name} is not accepted by result-readiness verify`,
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
    "verify",
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
      kind: "verify_final_result_readiness_again",
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
    const { target } = finalResultStorageEnvironment(env);
    const credentials = {
      accessKeyId: envValue(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: envValue(env, "S3_SECRET_ACCESS_KEY"),
      ...(env.S3_SESSION_TOKEN?.trim()
        ? { sessionToken: env.S3_SESSION_TOKEN.trim() }
        : {}),
    };
    const actorConfig = {
      endpoint: envValue(env, "TIANGONG_LCA_API_BASE_URL"),
      publishableKey: envValue(env, "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY"),
      accessToken: envValue(env, "TIANGONG_LCA_ACCESS_TOKEN"),
    };
    const readerConfig = {
      endpoint: envValue(env, "RESULT_QUERY_ENDPOINT"),
      secret: envValue(env, "RESULT_QUERY_SERVICE_SECRET"),
    };
    await assertFinalResultExternalOutput(candidateDir, outDir);
    await assertFinalResultExternalOutput(inputDir, outDir);
    await assertAbsent(outDir);
    // Constructors validate explicit settings but do not contact remote services.
    const actor = createActor(actorConfig),
      reader = createReader(readerConfig);
    await mkdir(path.dirname(outDir), { recursive: true });
    await mkdir(outDir, { mode: 0o700 });
    created = true;
    await mkdir(path.join(outDir, "proofs"), { mode: 0o700 });
    await write("command-attempt.json", {
      schemaVersion: "tiangong.final-result-readiness-command.v1",
      verificationId,
      releaseRunId,
      publishPlanHash,
      candidateDir,
      inputDir,
      actorId: actor.actorId,
      startedAt: new Date().toISOString(),
      publicationAuthorized: false,
    });
    objectStore = createObjectStore({ target, credentials });
    registry = createRegistry({ connectionString: envValue(env, "CONN") });
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
        schemaVersion: "tiangong.final-result-readiness-failure.v1",
        verificationId,
        releaseRunId,
        publishPlanHash,
        code,
        failedAt: new Date().toISOString(),
        publicationAuthorized: false,
      }).catch(() => {});
    const safe = new Error(
      "Readiness verification did not complete; preserve the attempt and resolve the reported condition before a fresh verification",
    );
    safe.code = code;
    safe.details = {
      verificationId,
      attemptCreated: created,
      ...(created ? { attemptDirectory: outDir } : {}),
      ...(error.details?.missingEnvironment
        ? { missingEnvironment: error.details.missingEnvironment }
        : {}),
    };
    safe.nextActions = nextActions;
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
