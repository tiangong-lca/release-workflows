import {
  resolveActorAccessToken,
  userSessionOrigin,
} from "../../environment/lib/user-session.mjs";
import path from "node:path";
import { mkdir, writeFile, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalJson, fail } from "./common.mjs";
import { assertAbsent } from "./io.mjs";
import { assertFinalResultExternalOutput } from "./final-result-storage-command.mjs";
import { createFinalResultActor } from "../adapters/final-result-actor.mjs";
import {
  buildFinalResultApprovalIntent,
  validateFinalResultApprovalIntent,
  approveFinalResultPublication,
  buildFinalResultActivationIntent,
  validateFinalResultActivationIntent,
  activateFinalResultPublication,
} from "./final-result-publication-authority.mjs";
import { createFinalResultPublication } from "../adapters/final-result-publication.mjs";
import {
  buildFinalResultPublicationPlan,
  validateFinalResultPublicationPlan,
  prepareFinalResultPublication,
} from "./final-result-publication-plan.mjs";
import { createFinalResultPublicReader } from "../adapters/final-result-public-reader.mjs";
import { verifyFinalResultPublicReadback } from "./final-result-public-readback.mjs";
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
  "approval-plan": [
    "plan-dir",
    "readiness-receipt",
    "expires-at",
    "reason",
    "approval-id",
  ],
  approve: ["plan-dir", "intent-dir", "confirm"],
  "activation-plan": ["plan-dir", "readiness-receipt", "approval-id"],
  activate: ["plan-dir", "intent-dir", "confirm"],
  status: ["run-id"],
  readback: ["plan-dir", "final-input"],
};
function value(env, name) {
  required(
    typeof env[name] === "string" && env[name].trim(),
    "final_publication_environment_required",
  );
  return env[name].trim();
}
async function boundedJson(file, maxBytes = 256 * 1024 ** 2) {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    required(size >= 1 && size <= maxBytes);
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
    createProbeActor = createFinalResultActor,
    approvalPlan = buildFinalResultApprovalIntent,
    approve = approveFinalResultPublication,
    activationPlan = buildFinalResultActivationIntent,
    activate = activateFinalResultPublication,
    createPublicReader = createFinalResultPublicReader,
    readback = verifyFinalResultPublicReadback,
    build = buildFinalResultPublicationPlan,
    prepare = prepareFinalResultPublication,
    resolveSession = resolveActorAccessToken,
  } = {},
) {
  required(Object.hasOwn(allowed, action));
  for (const k of Object.keys(options))
    required(
      [
        ...allowed[action],
        "out-dir",
        "json",
        "help",
        "bootstrap-session",
      ].includes(k),
      "invalid_arguments",
    );
  const needed = {
    plan: ["candidate", "target-hash", "reason"],
    prepare: ["plan-dir", "confirm"],
    status: ["run-id"],
    readback: ["plan-dir", "final-input"],
    "approval-plan": ["plan-dir", "readiness-receipt", "expires-at", "reason"],
    approve: ["plan-dir", "intent-dir", "confirm"],
    "activation-plan": ["plan-dir", "readiness-receipt", "approval-id"],
    activate: ["plan-dir", "intent-dir", "confirm"],
  }[action];
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
    const accessToken = options["bootstrap-session"]
      ? await resolveSession({ env, allowBootstrap: true })
      : value(env, "TIANGONG_LCA_ACCESS_TOKEN");
    const actorConfig = {
      endpoint: userSessionOrigin(value(env, "TIANGONG_LCA_API_BASE_URL")),
      publishableKey: value(env, "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY"),
      accessToken,
    };
    const actor = createActor(actorConfig);
    await assertAbsent(outDir);
    if (action === "plan")
      await assertFinalResultExternalOutput(
        path.resolve(options.candidate),
        outDir,
      );
    if (options["final-input"])
      await assertFinalResultExternalOutput(
        path.resolve(options["final-input"]),
        outDir,
      );
    if (options["plan-dir"]) {
      const planDir = path.resolve(options["plan-dir"]);
      await assertFinalResultExternalOutput(planDir, outDir);
      const local = await boundedJson(
        path.join(planDir, "publication-plan.json"),
      );
      const checked = validateFinalResultPublicationPlan(local);
      await assertFinalResultExternalOutput(local.candidateDir, outDir);
      if (action === "prepare") {
        required(
          options.confirm === checked.localPlanHash,
          "final_publication_confirmation_mismatch",
        );
        required(
          actor.actorId === local.actorId &&
            actor.apiTargetHash === local.apiTargetHash,
          "final_publication_actor_target_mismatch",
        );
      } else
        required(
          actor.apiTargetHash === local.apiTargetHash,
          "final_publication_actor_target_mismatch",
        );
      context = { local, ...checked };
    }
    let authorityIntent, readiness;
    if (options["intent-dir"]) {
      const intentDir = path.resolve(options["intent-dir"]);
      await assertFinalResultExternalOutput(intentDir, outDir);
      authorityIntent = await boundedJson(
        path.join(
          intentDir,
          action === "approve"
            ? "approval-intent.json"
            : "activation-intent.json",
        ),
        65536,
      );
      const checked = (
        action === "approve"
          ? validateFinalResultApprovalIntent
          : validateFinalResultActivationIntent
      )(authorityIntent, context.local);
      required(
        checked.intentHash === options.confirm,
        "final_authority_confirmation_mismatch",
      );
      required(
        authorityIntent.actorId === actor.actorId,
        "final_authority_actor_target_mismatch",
      );
    }
    if (options["readiness-receipt"]) {
      const file = path.resolve(options["readiness-receipt"]);
      await assertFinalResultExternalOutput(path.dirname(file), outDir);
      readiness = await boundedJson(file, 32768);
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
    if (action === "readback") {
      const receipt = await readback({
        local: context.local,
        inputDir: path.resolve(options["final-input"]),
        actor,
        reader: createPublicReader(actorConfig),
        record: async (e) => {
          required(
            ["public-readback-intent", "public-readback-receipt"].includes(
              e.kind,
            ),
          );
          await write(`${e.kind}.json`, e.receipt ?? e);
        },
      });
      return {
        ok: true,
        command: "result-publication readback",
        outcome: "final_result_public_readback_verified",
        completeness: "public_readback_verified",
        publicationAuthorized: false,
        releaseRunId: context.plan.releaseRunId,
        publicationId: receipt.observation.publicationId,
        publicReadbackVerified: true,
        artifacts: {
          receipt: path.join(outDir, "public-readback-receipt.json"),
        },
        nextActions: [],
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
    if (
      ["approval-plan", "approve", "activation-plan", "activate"].includes(
        action,
      )
    ) {
      const probeActor = createProbeActor(actorConfig);
      if (action.endsWith("-plan")) {
        const planned =
          action === "approval-plan"
            ? await approvalPlan({
                local: context.local,
                readiness,
                actor,
                probeActor,
                expiresAt: options["expires-at"],
                reason: options.reason,
                ...(options["approval-id"]
                  ? { approvalId: options["approval-id"] }
                  : {}),
              })
            : await activationPlan({
                local: context.local,
                readiness,
                actor,
                probeActor,
                approvalId: options["approval-id"],
              });
        const approvedAction =
          action === "approval-plan" ? "approve" : "activate";
        const file =
          action === "approval-plan"
            ? "approval-intent.json"
            : "activation-intent.json";
        await write(file, planned.intent);
        return {
          ok: true,
          command: `result-publication ${action}`,
          outcome: "final_result_authority_intent_prepared",
          completeness: "exact_authority_confirmation_pending",
          releaseRunId: context.plan.releaseRunId,
          publishPlanHash: context.local.publishPlanHash,
          intentHash: planned.intentHash,
          approvalId: planned.intent.approvalId,
          verificationId: planned.intent.readiness.verificationId,
          publicationAuthorized: false,
          artifacts: { intent: path.join(outDir, file) },
          nextActions: [
            next("confirm_final_result_authority", approvedAction, [
              "--plan-dir",
              path.resolve(options["plan-dir"]),
              "--intent-dir",
              outDir,
              "--confirm",
              planned.intentHash,
              "--out-dir",
              `${outDir}-execute`,
            ]),
          ],
        };
      }
      const observe = action === "approve" ? approve : activate;
      const receipt = await observe({
        local: context.local,
        intent: authorityIntent,
        confirmIntentHash: options.confirm,
        actor,
        probeActor,
        record: async (e) => {
          const kinds =
            action === "approve"
              ? ["approval-execution-intent", "approval-observation"]
              : ["activation-execution-intent", "activation-observation"];
          required(kinds.includes(e.kind));
          await write(`${e.kind}.json`, e.receipt ?? e);
        },
      });
      return {
        ok: true,
        command: `result-publication ${action}`,
        outcome:
          action === "approve"
            ? "final_result_approval_observed"
            : "final_result_activation_observed",
        completeness:
          action === "approve"
            ? "approval_observed_activation_not_executed"
            : "activation_observed_public_readback_pending",
        releaseRunId: context.plan.releaseRunId,
        publishPlanHash: context.local.publishPlanHash,
        approvalId:
          action === "approve"
            ? receipt.approval.approvalId
            : receipt.publication.approvalId,
        status:
          action === "approve"
            ? receipt.approval.status
            : receipt.publication.status,
        ...(action === "approve"
          ? { expiresAt: receipt.approval.expiresAt }
          : {
              publicationId: receipt.publication.publicationId,
              isCurrent: receipt.publication.isCurrent,
              publicReadbackVerified: false,
            }),
        publicationAuthorized: false,
        artifacts: {
          observation: path.join(
            outDir,
            action === "approve"
              ? "approval-observation.json"
              : "activation-observation.json",
          ),
        },
        nextActions: [
          next("inspect_final_result_release", "status", [
            "--run-id",
            context.plan.releaseRunId,
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
    const versionConflict =
      error.code === "final_actor_request_denied" &&
      error.details?.semanticCode === "final_result_dataset_version_conflict";
    const reportedCode = versionConflict
      ? "final_result_dataset_version_conflict"
      : error?.name === "ActorSessionError"
        ? "final_publication_session_unavailable"
        : error.code;
    const code =
      typeof reportedCode === "string" &&
      /^(?:final_[a-z0-9_]+|output_exists|invalid_arguments)$/u.test(
        reportedCode,
      )
        ? reportedCode
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
      code === "final_publication_session_unavailable"
        ? "User session unavailable; use --bootstrap-session with the existing user configuration; no manual JWT copying is required"
        : versionConflict
          ? "A published Result already uses this dataset version for different content. Version the Result upstream and rebuild the paired Candidate."
          : "Final Result publication command did not complete; preserve evidence and inspect the exact run before another attempt",
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
