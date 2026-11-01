import path from "node:path";
import { mkdir, writeFile, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalJson, fail } from "./common.mjs";
import { assertAbsent } from "./io.mjs";
import { assertFinalResultExternalOutput } from "./final-result-storage-command.mjs";
import { createFinalResultPublication } from "../adapters/final-result-publication.mjs";
import {
  buildFinalResultPublicationPlan,
  validateFinalResultPublicationPlan,
  prepareFinalResultPublication,
} from "./final-result-publication-plan.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const quote = (v) => `'${String(v).replaceAll("'", `'"'"'`)}'`;
function required(v, code = "final_publication_command_invalid") {
  if (!v)
    fail(code, "Exact final Result publication command arguments are required");
}
const next = (kind, action, args) => {
  const argv = ["node", CLI, "result-publication", action, ...args, "--json"];
  return { kind, argv, command: argv.map(quote).join(" ") };
};
const allowed = {
  plan: [
    "candidate",
    "target-hash",
    "reason",
    "selection",
    "release-version",
    "rollback-of",
    "run-id",
  ],
  prepare: ["plan-dir", "confirm"],
  status: ["run-id"],
};
function value(env, name) {
  required(
    typeof env[name] === "string" && env[name].trim(),
    "final_publication_environment_required",
  );
  return env[name].trim();
}
async function boundedJson(file) {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    required(size >= 1 && size <= 256 * 1024 ** 2);
    // Bound the read itself, including files that grow after stat.
    const data = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        data.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    required(offset === size);
    try {
      return JSON.parse(data.subarray(0, size).toString("utf8"));
    } catch {
      required(false);
    }
  } finally {
    await handle.close();
  }
}
export async function runFinalResultPublicationCommand(
  action,
  options,
  {
    env = process.env,
    createActor = createFinalResultPublication,
    build = buildFinalResultPublicationPlan,
    prepare = prepareFinalResultPublication,
  } = {},
) {
  required(Object.hasOwn(allowed, action));
  for (const k of Object.keys(options))
    required(
      [...allowed[action], "out-dir", "json", "help"].includes(k),
      "invalid_arguments",
    );
  const needed =
    action === "plan"
      ? ["candidate", "target-hash", "reason"]
      : action === "prepare"
        ? ["plan-dir", "confirm"]
        : ["run-id"];
  for (const k of [...needed, "out-dir"])
    required(typeof options[k] === "string" && options[k].trim());
  if (options["run-id"] !== undefined) required(UUID.test(options["run-id"]));
  const outDir = path.resolve(options["out-dir"]);
  let created = false,
    context;
  const write = (relative, v) =>
    writeFile(path.join(outDir, relative), canonicalJson(v), {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
  try {
    const actor = createActor({
      endpoint: value(env, "TIANGONG_LCA_API_BASE_URL"),
      publishableKey: value(env, "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY"),
      accessToken: value(env, "TIANGONG_LCA_ACCESS_TOKEN"),
    });
    await assertAbsent(outDir);
    if (action === "plan")
      await assertFinalResultExternalOutput(
        path.resolve(options.candidate),
        outDir,
      );
    if (action === "prepare") {
      const planDir = path.resolve(options["plan-dir"]);
      await assertFinalResultExternalOutput(planDir, outDir);
      const local = await boundedJson(
        path.join(planDir, "publication-plan.json"),
      );
      const checked = validateFinalResultPublicationPlan(local);
      await assertFinalResultExternalOutput(local.candidateDir, outDir);
      required(
        options.confirm === checked.localPlanHash,
        "final_publication_confirmation_mismatch",
      );
      required(
        actor.actorId === local.actorId &&
          actor.apiTargetHash === local.apiTargetHash,
        "final_publication_actor_target_mismatch",
      );
      context = { local, ...checked };
    }
    await mkdir(path.dirname(outDir), { recursive: true });
    await mkdir(outDir, { mode: 0o700 });
    created = true;
    await write("command-attempt.json", {
      schemaVersion: "tiangong.final-result-publication-command.v1",
      action,
      actorId: actor.actorId,
      apiTargetHash: actor.apiTargetHash,
      startedAt: new Date().toISOString(),
      publicationAuthorized: false,
    });
    if (action === "plan") {
      const result = await build({
        candidateDir: path.resolve(options.candidate),
        targetHash: options["target-hash"],
        actor,
        members: options.selection
          ? await boundedJson(path.resolve(options.selection))
          : null,
        ...(options["run-id"] ? { releaseRunId: options["run-id"] } : {}),
        releaseVersion: options["release-version"],
        rollbackOfPublicationId: options["rollback-of"] ?? null,
        reason: options.reason,
      });
      const checked = validateFinalResultPublicationPlan(result.local);
      required(checked.localPlanHash === result.localPlanHash);
      await write("publication-plan.json", result.local);
      return {
        ok: true,
        command: "result-publication plan",
        outcome: "final_result_publication_planned",
        completeness: "selection_plan_confirmation_pending",
        localPlanHash: result.localPlanHash,
        publishPlanHash: result.local.publishPlanHash,
        releaseRunId: checked.plan.releaseRunId,
        selectionCount: checked.plan.selectionCount,
        expectedCurrentPublicationId: checked.plan.expectedCurrentPublicationId,
        publicationAuthorized: false,
        artifacts: { plan: path.join(outDir, "publication-plan.json") },
        nextActions: [
          next("prepare_final_result_selection", "prepare", [
            "--plan-dir",
            outDir,
            "--confirm",
            result.localPlanHash,
            "--out-dir",
            `${outDir}-prepare`,
          ]),
        ],
      };
    }
    if (action === "prepare") {
      await mkdir(path.join(outDir, "batches"), { mode: 0o700 });
      const receipt = await prepare({
        local: context.local,
        confirmLocalPlanHash: options.confirm,
        actor,
        record: async (e) => {
          if (e.kind === "prepare-intent")
            return write("prepare-intent.json", e);
          if (e.kind === "member-batch") {
            required(Number.isSafeInteger(e.offset) && e.offset >= 0);
            return write(
              `batches/${String(e.offset).padStart(7, "0")}.json`,
              e,
            );
          }
          if (e.kind === "selection-seal-intent")
            return write("selection-seal-intent.json", e);
          if (e.kind === "selection-receipt")
            return write("selection-receipt.json", e.receipt);
          required(false);
        },
      });
      return {
        ok: true,
        command: "result-publication prepare",
        outcome: "final_result_selection_sealed",
        completeness: "selection_sealed",
        localPlanHash: context.localPlanHash,
        releaseRunId: receipt.releaseRunId,
        publishPlanHash: receipt.publishPlanHash,
        selectionCount: receipt.selectionCount,
        status: receipt.status,
        publicationAuthorized: false,
        artifacts: { receipt: path.join(outDir, "selection-receipt.json") },
        nextActions: [
          next("inspect_final_result_release", "status", [
            "--run-id",
            receipt.releaseRunId,
            "--out-dir",
            `${outDir}-status`,
          ]),
        ],
      };
    }
    const snapshot = await actor.run(options["run-id"]);
    await write("release-status.json", {
      schemaVersion: "tiangong.final-result-release-observation.v1",
      actorId: actor.actorId,
      apiTargetHash: actor.apiTargetHash,
      releaseRunId: options["run-id"],
      observedAt: new Date().toISOString(),
      snapshot,
      publicationAuthorized: false,
    });
    return {
      ok: true,
      command: "result-publication status",
      outcome: snapshot
        ? "final_result_release_observed"
        : "final_result_release_not_found",
      completeness: "observation_only",
      releaseRunId: options["run-id"],
      status: snapshot?.status ?? null,
      selectionSealed: snapshot?.selectionSealed ?? false,
      publicationStatus: snapshot?.publication?.status ?? null,
      isCurrent: snapshot?.publication?.isCurrent ?? false,
      currentPublicationId: snapshot?.publication?.isCurrent
        ? snapshot.publication.publicationId
        : null,
      publicationAuthorized: false,
      artifacts: { observation: path.join(outDir, "release-status.json") },
      nextActions: [],
    };
  } catch (error) {
    const code =
      typeof error.code === "string" &&
      /^(?:final_[a-z0-9_]+|output_exists|invalid_arguments)$/u.test(error.code)
        ? error.code
        : "final_publication_command_failed";
    if (created)
      await write("failure.json", {
        schemaVersion: "tiangong.final-result-publication-command-failure.v1",
        action,
        code,
        failedAt: new Date().toISOString(),
        publicationAuthorized: false,
      }).catch(() => {});
    const safe = new Error(
      "Final Result publication command did not complete; preserve evidence and inspect the exact run before another attempt",
    );
    safe.code = code;
    safe.details = {
      attemptCreated: created,
      ...(created ? { attemptDirectory: outDir } : {}),
      ...(context
        ? {
            releaseRunId: context.plan.releaseRunId,
            publishPlanHash: context.local.publishPlanHash,
          }
        : {}),
    };
    const runId = context?.plan.releaseRunId ?? options["run-id"];
    safe.nextActions = runId
      ? [
          next("inspect_final_result_release", "status", [
            "--run-id",
            runId,
            "--out-dir",
            `${outDir}-status`,
          ]),
        ]
      : [];
    throw safe;
  }
}
