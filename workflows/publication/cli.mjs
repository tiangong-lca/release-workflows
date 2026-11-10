#!/usr/bin/env node
import {
  configureReleaseCli,
  attachReleaseConfiguration,
} from "../environment/lib/cli-configuration.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicationApproval } from "./lib/approval.mjs";
import { executePublication } from "./lib/execution.mjs";
import { inspectPublicationTarget } from "./lib/inspection.mjs";
import { materializePublicationPayload } from "./lib/payload.mjs";
import { preparePublicationPlan } from "./lib/plan.mjs";
import {
  finalizePortalLciaProjection,
  preparePortalLciaPackagePublicationPlan,
  preparePortalLciaProjectionPlan,
  publishPortalLciaPackage,
  revokePortalLciaProjectionPublication,
  verifyPortalLciaProjectionPublication,
} from "./lib/portal-lcia-projection.mjs";
import { verifyPublicationReadback } from "./lib/readback.mjs";
import {
  executeResultProcessPublication,
  prepareResultProcessPublication,
  verifyResultProcessReadback,
} from "./lib/result-process.mjs";
import { runFinalResultStorageCommand } from "./lib/final-result-storage-command.mjs";
import { runFinalResultPublicationCommand } from "./lib/final-result-publication-command.mjs";
import { runFinalResultReadinessCommand } from "./lib/final-result-readiness-command.mjs";
import { replyTemplateFor } from "./reply-template-registry.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const COMMAND = `node ${shellQuote(CLI_PATH)}`;
const VALUE_OPTIONS = new Set([
  "config-env",
  "candidate",
  "target-hash",
  "readiness-receipt",
  "intent-dir",
  "approval-id",
  "selection",
  "release-version",
  "rollback-of",
  "final-input",
  "run-id",
  "publish-plan-hash",
  "component",
  "target",
  "include",
  "exclude",
  "plan-dir",
  "payload-dir",
  "inspection-dir",
  "approval-dir",
  "execution-dir",
  "finalization-dir",
  "package-plan-dir",
  "package-publication-dir",
  "result-preparation-dir",
  "package-id",
  "default-impact-category",
  "published-state-code",
  "confirm",
  "approved-by",
  "attested-by-user-id",
  "expires-at",
  "reason",
  "out-dir",
]);
const REPEATABLE_OPTIONS = new Set(["include", "exclude"]);
const BOOLEAN_OPTIONS = new Set(["json", "help", "bootstrap-session"]);

const HELP = `release-publication <command> [options]

Candidate-bound dataset Publication plus an opt-in Portal LCIA package/projection workflow. Actor publication recipes use actor-scoped sessions. The separate result-storage recipe uses explicit operator CONN and S3 credentials only for immutable file storage and registration; it cannot publish.

Dataset publication target state follows the dataset role, per operation: Result Process
datasets target state 120 through the manager-attested Database command, and ordinary Unit
Process, LifecycleModel and support datasets keep the existing state 100 platform commands.
A plan is therefore mixed-state, not a single global state.

Common configuration: --config-env <path> (default: repository .env if present).
result-publication/readiness: --bootstrap-session obtains an in-memory user JWT from existing user configuration; never writes a token or grants business confirmation.

Commands:
  result-publication plan     Freeze exact Result selection and current-publication precondition
  result-publication prepare  Confirm and seal that selection using the manager session
  result-publication status   Observe one exact run without changing its authority
  result-publication readback Verify public Edge rows and authorized ZIPs after activation
  result-publication approval-plan    Inspect exact approval intent for confirmation
  result-publication approve          Confirm intent and independently read the approval
  result-publication activation-plan  Inspect exact activation intent for confirmation
  result-publication activate         Confirm intent, activate and independently read authority
  result-readiness inspect Inspect exact configuration/selection and private reader without remote writes
  result-readiness verify  Verify all selected files and reader probes; register readiness only
  result-storage inspect  Locally verify a final Result v3 Candidate and freeze its storage plan
  result-storage preflight  Read-only database/TLS and exact registry checks; no upload/registration
  result-storage execute  Confirm that plan, store/read back files and register immutable evidence
  plan prepare          Resolve dependency-safe scope into an unapproved Draft Plan
  payload materialize  Extract only the resolved TIDAS datasets from the Candidate
  target inspect        Compare exact UUID + Version + content against the platform
  approval create       Approve the exact executable-plan SHA-256
  result-process prepare  Remotely prepare the manager-attested Result Process writes
  result-process execute  Publish the prepared Result Process identities at state 120
  result-process verify   Independently read back each Result Process publication
  publish execute       Recheck the target, create missing rows, and publish exact rows
  readback verify       Independently re-read every approved row and emit a receipt
  projection package-plan     Prepare an exact V3 LCIA package publication plan
  projection package-publish  Publish that package and independently read it back
  projection prepare    Prepare an exact public LCIA projection finalization plan
  projection finalize   Confirm and idempotently bind the projection to a publication
  projection verify     Independently verify the finalized projection is current
  projection revoke     Confirm, revoke, and independently verify the exact binding

Core options:
  --candidate <path>              Candidate v2 directory; result-storage requires v3
  --plan-dir <path>               Publication Draft Plan directory
  --payload-dir <path>            Materialized Publication payload directory
  --inspection-dir <path>         Target inspection directory
  --approval-dir <path>           Publication approval directory
  --execution-dir <path>          Publication execution directory
  --finalization-dir <path>       Portal LCIA projection finalization directory
  --package-plan-dir <path>       Portal LCIA package publication plan directory
  --package-publication-dir <path>  Verified package publication directory
  --result-preparation-dir <path>   Prepared Result Process request directory
  --out-dir <path>                New output directory (execution reuses it for resume)
  --json                          Emit one bounded JSON object

plan prepare:
  --candidate <path> --component <unit-process|result|both> --target <stable-id>
  [--include <datasetType:uuid@version>] [--exclude <identity>] --out-dir <path>

payload materialize:
  --candidate <path> --plan-dir <path> --out-dir <path>

target inspect:
  --plan-dir <path> --payload-dir <path> --out-dir <path>

approval create:
  --inspection-dir <path> --confirm <executable-plan-sha256>
  --approved-by <stable-actor-id> [--attested-by-user-id <manager-uuid>]
  [--expires-at <ISO-8601>] [--reason <text>] --out-dir <path>

result-process prepare:
  --approval-dir <path> --payload-dir <path> --out-dir <path>

result-process execute:
  --result-preparation-dir <path> --payload-dir <path> --out-dir <path>

result-process verify:
  --execution-dir <path> --payload-dir <path> --out-dir <path>

publish execute:
  --approval-dir <path> --payload-dir <path> --out-dir <path>
  [--result-preparation-dir <path>]   required when the plan writes a Result Process

readback verify:
  --execution-dir <path> --payload-dir <path> --out-dir <path>
  [--result-preparation-dir <path>]   required when the plan writes a Result Process

projection package-plan:
  --package-id <uuid> --default-impact-category <id> --reason <text> --out-dir <path>

projection package-publish:
  --package-plan-dir <path> --confirm <package-publication-plan-sha256> --out-dir <path>

projection prepare:
  --package-publication-dir <path> --out-dir <path>

projection finalize:
  --plan-dir <path> --confirm <projection-plan-sha256> --out-dir <path>

projection verify:
  --finalization-dir <path> --out-dir <path>

projection revoke:
  --finalization-dir <path> --confirm <finalized-event-sha256>
  --reason <text> --out-dir <path>

Notes:
  --published-state-code is retained only as a fail-closed guard. Any value other than the
  ordinary state 100 is out of scope, because role-to-state mapping is per operation.
  Result Process writes go to state 120 only through the Database-owned manager-attested
  prepare/publish/readback RPCs; the platform dataset commands are never used for them and
  no intermediate 0 or 100 row is ever created.

result-storage inspect / preflight:
  --candidate <v3-directory> --out-dir <new-directory>

result-storage execute:
  --candidate <v3-directory> --confirm <storage-plan-sha256> --out-dir <new-attempt-directory>
  Requires explicit CONN, S3_ENDPOINT, S3_REGION, S3_BUCKET; optional S3_PREFIX.
  Execute also requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY; optional S3_SESSION_TOKEN.
  Optional --config-env <path> shares the Publication loader with readiness, including CA configuration.
  Inspect makes no remote requests. Preflight only queries the database; neither needs S3 credentials.
  Execute automatically preflights the database before the first upload or registration.
  Configuration files are explicit; there is no implicit .env discovery or storage login.
  Retry the same Candidate/target/confirmation in a NEW output directory; preserve prior attempts.
  Storage success does not authorize publication or make a result visible.

result-publication plan:
  --candidate <v3-directory> --target-hash <registered-storage-target-sha256>
  --reason <text> --out-dir <new-directory>
  Optional --selection <JSON-array-of-uuid/version>, --release-version <YYYY.MM.N>,
  --rollback-of <terminal-publication-uuid>, --run-id <uuid>. Defaults to all Candidate Results.
result-publication prepare:
  --plan-dir <frozen-plan-directory> --confirm <local-plan-content-sha256> --out-dir <new-directory>
result-publication readback:
  --plan-dir <prepared-plan-directory> --final-input <frozen-input-directory> --out-dir <new-directory>
  Uses the current actor, public Edge and short-lived ZIP links. Records immutable observations;
  does not activate, roll back or withdraw. A failed observation leaves publication authority unchanged.
result-publication status:
  --run-id <uuid> --out-dir <new-directory>
  These recipes use only explicit API origin, publishable key and actor JWT below.
  No CONN/S3/Worker secrets, implicit login or .env. Selection preparation is not approval.
  localPlanHash binds the local envelope; publishPlanHash binds exact database plan bytes.

result-publication approval-plan:
  --plan-dir <directory> --readiness-receipt <file> --expires-at <timestamp> --reason <text>
  --out-dir <new-directory>; optional --approval-id <uuid>
result-publication activation-plan:
  --plan-dir <directory> --readiness-receipt <file> --approval-id <uuid> --out-dir <new-directory>
result-publication approve / activate:
  --plan-dir <directory> --intent-dir <directory> --confirm <intent-content-sha256>
  --out-dir <new-directory>
  These are separate confirmed authority operations. Unknown responses are resolved by
  exact identity reads, never blind repeat activation. Old consumed/withdrawn history is not revived.
  Activation observation does not prove public Edge/Platform readback. A new session requires
  a new unexecuted activation intent; existing execution history remains recoverable.

result-readiness inspect / verify:
  --candidate <v3-directory> --final-input <frozen-input-directory>
  --run-id <uuid> --publish-plan-hash <sha256> --out-dir <new-attempt-directory>
  Requires explicit storage CONN/S3 settings above, TIANGONG_LCA_API_BASE_URL,
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY, TIANGONG_LCA_ACCESS_TOKEN (actor JWT),
  RESULT_QUERY_ENDPOINT and RESULT_QUERY_SERVICE_SECRET (or its _FILE / _SSH_HOST source).
  Optional --config-env <path> explicitly loads readiness settings; conflicting process values fail.
  Optional --bootstrap-session explicitly exchanges the configured user API key when no JWT is provided.
  RELEASE_DATABASE_CA_FILE enables verify-full with a trusted CA file (relative to --config-env).
  API base may be a project origin or its exact /functions/v1 base; reader endpoint must be an origin.
  Inspect checks registered Candidate/selection/runtime plus one overview per artifact without
  storage writes or readiness registration; it is not numerical readiness or publication approval.
  Verify requires S3 read credentials and records readiness evidence. Neither command approves/activates.
  Configuration follows Environment's fixed repository .env; no implicit login.
  --bootstrap-session is also supported by all final result-publication commands.
  See workflows/publication/README.md for setup, secret sources, expiry and recovery.
  Full GET and reader checks only: no missing-file repair, approval or activation.
  File evidence is flushed before registration. Failed attempts remain; use a new directory.

Actor remote environment:
  TIANGONG_LCA_API_BASE_URL
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY
  TIANGONG_LCA_ACCESS_TOKEN or TIANGONG_LCA_API_KEY
`;

let CLI_CONFIGURATION;
async function main() {
  CLI_CONFIGURATION = await configureReleaseCli(
    "publication",
    process.argv.slice(2),
  );
  const [command, actionName, ...tokens] = CLI_CONFIGURATION.argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const commandName = `${command} ${actionName ?? ""}`.trim();
  const handlers = {
    "result-publication approval-plan": (options) =>
      runFinalResultPublicationCommand("approval-plan", options),
    "result-publication approve": (options) =>
      runFinalResultPublicationCommand("approve", options),
    "result-publication activation-plan": (options) =>
      runFinalResultPublicationCommand("activation-plan", options),
    "result-publication activate": (options) =>
      runFinalResultPublicationCommand("activate", options),
    "result-publication plan": (options) =>
      runFinalResultPublicationCommand("plan", options),
    "result-publication prepare": (options) =>
      runFinalResultPublicationCommand("prepare", options),
    "result-publication readback": (options) =>
      runFinalResultPublicationCommand("readback", options),
    "result-publication status": (options) =>
      runFinalResultPublicationCommand("status", options),
    "result-readiness inspect": (options) =>
      runFinalResultReadinessCommand("inspect", options),
    "result-readiness verify": (options) =>
      runFinalResultReadinessCommand("verify", options),
    "result-storage inspect": (options) =>
      runFinalResultStorageCommand("inspect", options),
    "result-storage preflight": (options) =>
      runFinalResultStorageCommand("preflight", options),
    "result-storage execute": (options) =>
      runFinalResultStorageCommand("execute", options),
    "plan prepare": planPrepare,
    "payload materialize": payloadMaterialize,
    "target inspect": targetInspect,
    "approval create": approvalCreate,
    "result-process prepare": resultProcessPrepare,
    "result-process execute": resultProcessExecute,
    "result-process verify": resultProcessVerify,
    "publish execute": publishExecute,
    "readback verify": readbackVerify,
    "projection package-plan": projectionPackagePlan,
    "projection package-publish": projectionPackagePublish,
    "projection prepare": projectionPrepare,
    "projection finalize": projectionFinalize,
    "projection verify": projectionVerify,
    "projection revoke": projectionRevoke,
  };
  if (!handlers[commandName])
    throw coded("unknown_command", `Unknown command: ${commandName}`);
  const options = parseArgs(tokens);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (
    options["bootstrap-session"] &&
    !commandName.startsWith("result-readiness ") &&
    !commandName.startsWith("result-publication ")
  )
    throw coded(
      "invalid_arguments",
      "--bootstrap-session is supported by result-publication and result-readiness",
    );
  const payload = await handlers[commandName](options);
  payload.replyTemplate = replyTemplateFor(commandName, { ok: true });
  respond(options, payload);
}

async function planPrepare(options) {
  requireOptions(options, ["candidate", "component", "target", "out-dir"]);
  const result = await preparePublicationPlan({
    candidateDir: path.resolve(options.candidate),
    outDir: path.resolve(options["out-dir"]),
    component: options.component,
    targetId: options.target,
    include: options.include ?? [],
    exclude: options.exclude ?? [],
  });
  return success("plan prepare", "publication_draft_plan_prepared", {
    completeness: "scope_resolved_payload_pending",
    candidate: path.resolve(options.candidate),
    component: result.request.component,
    targetId: result.request.targetId,
    requestedRootCount: result.resolution.requestedRootCount,
    dependencyAdditionCount: result.resolution.dependencyAdditions.length,
    prunedDatasetCount: result.resolution.prunedDatasets.length,
    effectiveDatasetCount: result.resolution.effectiveDatasetCount,
    effectiveSetHash: result.resolution.effectiveSetHash,
    publicationDraftPlanSha256: result.publicationDraftPlanSha256,
    publicationAuthorized: false,
    artifacts: {
      scopeRequest: path.join(result.path, "publication-scope-request.json"),
      scopeResolution: path.join(
        result.path,
        "publication-scope-resolution.json",
      ),
      publicationDraftPlan: path.join(
        result.path,
        "publication-draft-plan.json",
      ),
    },
    nextActions: [
      nextAction("materialize_payload", [
        "payload",
        "materialize",
        "--candidate",
        path.resolve(options.candidate),
        "--plan-dir",
        result.path,
        "--out-dir",
        `${result.path}-payload`,
        "--json",
      ]),
    ],
  });
}

async function payloadMaterialize(options) {
  requireOptions(options, ["candidate", "plan-dir", "out-dir"]);
  const result = await materializePublicationPayload({
    candidateDir: path.resolve(options.candidate),
    planDir: path.resolve(options["plan-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  return success("payload materialize", "publication_payload_materialized", {
    completeness: "payload_complete_target_inspection_pending",
    datasetCount: result.manifest.datasetCount,
    datasetSetHash: result.manifest.datasetSetHash,
    payloadManifestSha256: result.manifestSha256,
    artifacts: {
      payloadManifest: path.join(
        result.path,
        "publication-payload-manifest.json",
      ),
      payloadDirectory: path.join(result.path, "datasets"),
    },
    nextActions: [
      nextAction("inspect_target", [
        "target",
        "inspect",
        "--plan-dir",
        path.resolve(options["plan-dir"]),
        "--payload-dir",
        result.path,
        "--out-dir",
        `${result.path}-inspection`,
        "--json",
      ]),
    ],
  });
}

async function targetInspect(options) {
  requireOptions(options, ["plan-dir", "payload-dir", "out-dir"]);
  const result = await inspectPublicationTarget({
    planDir: path.resolve(options["plan-dir"]),
    payloadDir: path.resolve(options["payload-dir"]),
    outDir: path.resolve(options["out-dir"]),
    publishedStateCode: integerOption(options, "published-state-code", 100),
  });
  return success("target inspect", "publication_target_inspected", {
    completeness: "executable_plan_ready_for_approval",
    datasetCount: result.snapshot.datasetCount,
    resultProcessDatasetCount: result.snapshot.resultProcessDatasetCount,
    ordinaryDatasetCount: result.snapshot.ordinaryDatasetCount,
    stateMapping: result.snapshot.stateMapping,
    targetFingerprint: result.snapshot.fingerprint,
    executablePlanSha256: result.executablePlanSha256,
    publicationAuthorized: false,
    resultPublicationAuthorized: false,
    artifacts: {
      targetSnapshot: path.join(
        result.path,
        "publication-target-snapshot.json",
      ),
      executablePlan: path.join(
        result.path,
        "publication-executable-plan.json",
      ),
    },
    nextActions: [
      nextAction("approve_exact_plan", [
        "approval",
        "create",
        "--inspection-dir",
        result.path,
        "--confirm",
        result.executablePlanSha256,
        "--approved-by",
        "<actor-id>",
        ...(result.snapshot.resultProcessDatasetCount
          ? ["--attested-by-user-id", "<data-product-manager-uuid>"]
          : []),
        "--out-dir",
        `${result.path}-approval`,
        "--json",
      ]),
    ],
  });
}

async function approvalCreate(options) {
  requireOptions(options, [
    "inspection-dir",
    "confirm",
    "approved-by",
    "out-dir",
  ]);
  const result = await createPublicationApproval({
    inspectionDir: path.resolve(options["inspection-dir"]),
    outDir: path.resolve(options["out-dir"]),
    confirmPlanSha256: options.confirm,
    approvedBy: options["approved-by"],
    attestedByUserId: options["attested-by-user-id"] ?? null,
    expiresAt: options["expires-at"],
    reason: options.reason ?? null,
  });
  return success("approval create", "publication_approved", {
    completeness: result.approval.resultPublicationAuthorized
      ? "approved_result_process_write_pending"
      : "approved_execution_pending",
    executablePlanSha256: result.executablePlanSha256,
    approvalSha256: result.approvalSha256,
    approvedBy: result.approval.approvedBy,
    attestedByUserId:
      result.approval.managerAttestation?.attestedByUserId ?? null,
    resultPublicationAuthorized: result.approval.resultPublicationAuthorized,
    expiresAt: result.approval.expiresAt,
    publicationAuthorized: true,
    artifacts: {
      approval: path.join(result.path, "publication-approval.json"),
    },
    nextActions: result.approval.resultPublicationAuthorized
      ? [
          nextAction("prepare_result_process_write", [
            "result-process",
            "prepare",
            "--approval-dir",
            result.path,
            "--payload-dir",
            "<payload-dir>",
            "--out-dir",
            `${result.path}-result-preparation`,
            "--json",
          ]),
        ]
      : [
          nextAction("execute_publication", [
            "publish",
            "execute",
            "--approval-dir",
            result.path,
            "--payload-dir",
            "<payload-dir>",
            "--out-dir",
            `${result.path}-execution`,
            "--json",
          ]),
        ],
  });
}

async function resultProcessPrepare(options) {
  requireOptions(options, ["approval-dir", "payload-dir", "out-dir"]);
  const result = await prepareResultProcessPublication({
    approvalDir: path.resolve(options["approval-dir"]),
    payloadDir: path.resolve(options["payload-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  const [first] = result.preparation.operations;
  return success("result-process prepare", "result_process_write_prepared", {
    completeness: "remote_preparation_registered_write_pending",
    operationCount: result.preparation.operationCount,
    targetStateCode: first.targetStateCode,
    sourceKind: result.preparation.sourceKind,
    operationSetHash: result.preparation.operationSetHash,
    preparationSha256: result.preparationSha256,
    preparationHash: first.preparationHash,
    preparationClassification: first.preparationClassification,
    existingState: first.preparationExistingState,
    resultPublicationAuthorized: true,
    artifacts: {
      preparation: path.join(result.path, "result-process-preparation.json"),
    },
    nextActions: [
      nextAction("publish_prepared_result_process", [
        "result-process",
        "execute",
        "--result-preparation-dir",
        result.path,
        "--payload-dir",
        path.resolve(options["payload-dir"]),
        "--out-dir",
        `${result.path}-execution`,
        "--json",
      ]),
    ],
  });
}

async function resultProcessExecute(options) {
  requireOptions(options, ["result-preparation-dir", "payload-dir", "out-dir"]);
  const result = await executeResultProcessPublication({
    preparationDir: path.resolve(options["result-preparation-dir"]),
    payloadDir: path.resolve(options["payload-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  return success("result-process execute", "result_process_write_executed", {
    completeness: "remote_write_complete_independent_readback_pending",
    operationCount: result.receipt.operationCount,
    completedKeys: result.receipt.completedKeys,
    executionReceiptSha256: result.receiptSha256,
    reused: result.reused,
    artifacts: {
      executionReceipt: path.join(
        result.path,
        "result-process-execution-receipt.json",
      ),
      executionEvents: path.join(result.path, "events"),
    },
    nextActions: [
      nextAction("verify_result_process_readback", [
        "result-process",
        "verify",
        "--execution-dir",
        result.path,
        "--payload-dir",
        path.resolve(options["payload-dir"]),
        "--out-dir",
        `${result.path}-readback`,
        "--json",
      ]),
    ],
  });
}

async function resultProcessVerify(options) {
  requireOptions(options, ["execution-dir", "payload-dir", "out-dir"]);
  const result = await verifyResultProcessReadback({
    executionDir: path.resolve(options["execution-dir"]),
    payloadDir: path.resolve(options["payload-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  return success("result-process verify", "result_process_readback_verified", {
    completeness: "result_process_publication_complete",
    operationCount: result.receipt.operationCount,
    targetStateCode: 120,
    verifiedSetHash: result.receipt.verifiedSetHash,
    readbackReceiptSha256: result.receiptSha256,
    artifacts: {
      readbackReceipt: path.join(
        result.path,
        "result-process-readback-receipt.json",
      ),
    },
    nextActions: [],
  });
}

async function publishExecute(options) {
  requireOptions(options, ["approval-dir", "payload-dir", "out-dir"]);
  const result = await executePublication({
    approvalDir: path.resolve(options["approval-dir"]),
    payloadDir: path.resolve(options["payload-dir"]),
    outDir: path.resolve(options["out-dir"]),
    resultPreparationDir: options["result-preparation-dir"]
      ? path.resolve(options["result-preparation-dir"])
      : null,
  });
  return success("publish execute", "publication_executed", {
    completeness: "remote_mutation_complete_independent_readback_pending",
    datasetCount: result.receipt.datasetCount,
    resultProcessDatasetCount: result.receipt.resultProcessDatasetCount,
    completedKeys: result.receipt.completedKeys,
    executionReceiptSha256: result.receiptSha256,
    reused: result.reused,
    artifacts: {
      executionReceipt: path.join(
        result.path,
        "publication-execution-receipt.json",
      ),
      executionEvents: path.join(result.path, "events"),
    },
    nextActions: [
      nextAction("verify_independent_readback", [
        "readback",
        "verify",
        "--execution-dir",
        result.path,
        "--payload-dir",
        path.resolve(options["payload-dir"]),
        "--out-dir",
        `${result.path}-readback`,
        "--json",
      ]),
    ],
  });
}

async function readbackVerify(options) {
  requireOptions(options, ["execution-dir", "payload-dir", "out-dir"]);
  const result = await verifyPublicationReadback({
    executionDir: path.resolve(options["execution-dir"]),
    payloadDir: path.resolve(options["payload-dir"]),
    outDir: path.resolve(options["out-dir"]),
    resultPreparationDir: options["result-preparation-dir"]
      ? path.resolve(options["result-preparation-dir"])
      : null,
  });
  return success("readback verify", "publication_readback_verified", {
    completeness: "publication_complete",
    datasetCount: result.receipt.datasetCount,
    resultProcessDatasetCount: result.receipt.resultProcessDatasetCount,
    stateMapping: result.receipt.stateMapping,
    verifiedSetHash: result.receipt.verifiedSetHash,
    readbackReceiptSha256: result.receiptSha256,
    artifacts: {
      readbackReceipt: path.join(
        result.path,
        "publication-readback-receipt.json",
      ),
    },
    nextActions: [],
  });
}

async function projectionPrepare(options) {
  requireOptions(options, ["package-publication-dir", "out-dir"]);
  const result = await preparePortalLciaProjectionPlan({
    packagePublicationDir: path.resolve(options["package-publication-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  const projection = result.plan.projection;
  return success("projection prepare", "portal_lcia_projection_plan_prepared", {
    completeness: "projection_ready_for_exact_confirmation",
    projectionId: projection.projectionId,
    packageId: projection.packageId,
    lciaResultPublicationId: projection.lciaResultPublicationId,
    packageVersion: projection.packageVersion,
    packageResultHash: projection.packageResultHash,
    projectionContentHash: projection.projectionContentHash,
    processCount: projection.processCount,
    impactCount: projection.impactCount,
    valueCount: projection.valueCount,
    projectionPlanSha256: result.planSha256,
    projectionFinalizationAuthorized: false,
    artifacts: {
      projectionPlan: path.join(
        result.path,
        "portal-lcia-projection-plan.json",
      ),
    },
    nextActions: [
      nextAction("confirm_projection_finalization", [
        "projection",
        "finalize",
        "--plan-dir",
        result.path,
        "--confirm",
        result.planSha256,
        "--out-dir",
        `${result.path}-finalization`,
        "--json",
      ]),
    ],
  });
}

async function projectionPackagePlan(options) {
  requireOptions(options, [
    "package-id",
    "default-impact-category",
    "reason",
    "out-dir",
  ]);
  const result = await preparePortalLciaPackagePublicationPlan({
    packageId: options["package-id"],
    displayDefaultImpactCategory: options["default-impact-category"],
    reason: options.reason,
    outDir: path.resolve(options["out-dir"]),
  });
  return success(
    "projection package-plan",
    "portal_lcia_package_publication_plan_prepared",
    {
      completeness: "package_publication_ready_for_exact_confirmation",
      packageId: result.plan.package.id,
      packageVersion: result.plan.package.version,
      packageResultHash: result.plan.package.resultHash,
      projectionId: result.plan.projection.id,
      projectionContentHash: result.plan.projection.contentHash,
      processCount: result.plan.package.processCount,
      impactCount: result.plan.package.impactCount,
      valueCount: result.plan.package.valueCount,
      databasePublishPlanHash: result.plan.publishPlanHash,
      displayDefaultImpactCategory: result.plan.displayDefaultImpactCategory,
      requestedReason: result.plan.requestedReason,
      currentPublicationPrecondition: result.plan.currentPublication,
      packagePublicationPlanSha256: result.planSha256,
      packagePublicationAuthorized: false,
      artifacts: {
        packagePublicationPlan: path.join(
          result.path,
          "portal-lcia-package-publication-plan.json",
        ),
      },
      nextActions: [
        nextAction("confirm_lcia_package_publication", [
          "projection",
          "package-publish",
          "--package-plan-dir",
          result.path,
          "--confirm",
          result.planSha256,
          "--out-dir",
          `${result.path}-published`,
          "--json",
        ]),
      ],
    },
  );
}

async function projectionPackagePublish(options) {
  requireOptions(options, ["package-plan-dir", "confirm", "out-dir"]);
  const result = await publishPortalLciaPackage({
    packagePlanDir: path.resolve(options["package-plan-dir"]),
    confirmPlanSha256: options.confirm,
    outDir: path.resolve(options["out-dir"]),
  });
  const subject = result.event.subject;
  return success(
    "projection package-publish",
    "portal_lcia_package_published",
    {
      completeness: "package_publication_current_projection_plan_pending",
      publicationId: subject.lciaResultPublicationId,
      packageId: subject.packageId,
      packageVersion: subject.packageVersion,
      packageResultHash: result.plan.package.resultHash,
      projectionId: subject.projectionId,
      projectionContentHash: subject.projectionContentHash,
      processCount: result.plan.package.processCount,
      impactCount: result.plan.package.impactCount,
      valueCount: result.plan.package.valueCount,
      disposition: result.disposition,
      reasonPersistence: result.event.observation.reasonPersistence,
      packagePublishedEventSha256: result.eventSha256,
      independentlyReadBack: true,
      artifacts: {
        packagePublishedEvent: path.join(
          result.path,
          "portal-lcia-package-published-event.json",
        ),
      },
      nextActions: [
        nextAction("prepare_projection_finalization", [
          "projection",
          "prepare",
          "--package-publication-dir",
          result.path,
          "--out-dir",
          `${result.path}-projection-plan`,
          "--json",
        ]),
      ],
    },
  );
}

async function projectionFinalize(options) {
  requireOptions(options, ["plan-dir", "confirm", "out-dir"]);
  const result = await finalizePortalLciaProjection({
    planDir: path.resolve(options["plan-dir"]),
    confirmPlanSha256: options.confirm,
    outDir: path.resolve(options["out-dir"]),
  });
  const subject = result.event.subject;
  return success("projection finalize", "portal_lcia_projection_finalized", {
    completeness: "projection_finalized_independent_readback_pending",
    projectionPublicationId: subject.projectionPublicationId,
    lciaResultPublicationId: subject.lciaResultPublicationId,
    projectionContentHash: subject.projectionContentHash,
    evidenceHash: result.event.observation.evidenceHash,
    disposition: result.disposition,
    finalizedEventSha256: result.eventSha256,
    independentReadbackVerified: false,
    artifacts: {
      finalizedEvent: path.join(
        result.path,
        "portal-lcia-projection-finalized-event.json",
      ),
    },
    nextActions: [
      nextAction("verify_projection_readback", [
        "projection",
        "verify",
        "--finalization-dir",
        result.path,
        "--out-dir",
        `${result.path}-readback`,
        "--json",
      ]),
    ],
  });
}

async function projectionVerify(options) {
  requireOptions(options, ["finalization-dir", "out-dir"]);
  const result = await verifyPortalLciaProjectionPublication({
    finalizationDir: path.resolve(options["finalization-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  const subject = result.event.subject;
  return success(
    "projection verify",
    "portal_lcia_projection_readback_verified",
    {
      completeness: "portal_lcia_projection_publication_complete",
      projectionPublicationId: subject.projectionPublicationId,
      lciaResultPublicationId: subject.lciaResultPublicationId,
      projectionContentHash: subject.projectionContentHash,
      evidenceHash: result.event.observation.evidenceHash,
      processCount: result.plan.projection.processCount,
      impactCount: result.plan.projection.impactCount,
      valueCount: result.plan.projection.valueCount,
      isCurrent: true,
      isPubliclyVisible: true,
      verifiedEventSha256: result.eventSha256,
      artifacts: {
        verifiedEvent: path.join(
          result.path,
          "portal-lcia-projection-verified-event.json",
        ),
      },
      nextActions: [],
    },
  );
}

async function projectionRevoke(options) {
  requireOptions(options, ["finalization-dir", "confirm", "reason", "out-dir"]);
  const result = await revokePortalLciaProjectionPublication({
    finalizationDir: path.resolve(options["finalization-dir"]),
    confirmFinalizedEventSha256: options.confirm,
    reason: options.reason,
    outDir: path.resolve(options["out-dir"]),
  });
  const subject = result.event.subject;
  return success("projection revoke", "portal_lcia_projection_revoked", {
    completeness: "portal_lcia_projection_revoked_and_verified",
    projectionPublicationId: subject.projectionPublicationId,
    lciaResultPublicationId: subject.lciaResultPublicationId,
    projectionContentHash: subject.projectionContentHash,
    disposition: result.event.disposition,
    reasonPersistence: result.event.observation.reasonPersistence,
    isCurrent: false,
    isPubliclyVisible: false,
    revokedEventSha256: result.eventSha256,
    artifacts: {
      revokedEvent: path.join(
        result.path,
        "portal-lcia-projection-revoked-event.json",
      ),
    },
    nextActions: [],
  });
}

function success(command, outcome, body) {
  return { ok: true, command, outcome, ...body };
}

function parseArgs(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--"))
      throw coded(
        "invalid_arguments",
        `Unexpected positional argument: ${token}`,
      );
    const name = token.slice(2);
    if (BOOLEAN_OPTIONS.has(name)) {
      if (result[name] !== undefined)
        throw coded("duplicate_argument", `Duplicate option: --${name}`);
      result[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name))
      throw coded("unknown_argument", `Unknown option: --${name}`);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw coded("invalid_arguments", `Missing value for --${name}`);
    index += 1;
    if (REPEATABLE_OPTIONS.has(name))
      result[name] = [...(result[name] ?? []), value];
    else {
      if (result[name] !== undefined)
        throw coded("duplicate_argument", `Duplicate option: --${name}`);
      result[name] = value;
    }
  }
  return result;
}

function requireOptions(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length)
    throw coded(
      "invalid_arguments",
      `Missing required options: ${missing.map((name) => `--${name}`).join(", ")}`,
    );
}

function integerOption(options, name, fallback) {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value < 0)
    throw coded(
      "invalid_arguments",
      `--${name} must be a non-negative integer`,
    );
  return value;
}

function nextAction(kind, args) {
  const argv = ["node", CLI_PATH, ...args];
  return { kind, command: argv.map(shellQuote).join(" "), argv };
}

function respond(options, payload) {
  attachReleaseConfiguration(payload, CLI_CONFIGURATION);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${payload.outcome}\n`);
  for (const [name, value] of Object.entries(payload))
    if (
      ![
        "ok",
        "command",
        "outcome",
        "artifacts",
        "nextActions",
        "replyTemplate",
      ].includes(name)
    )
      process.stdout.write(`- ${name}: ${JSON.stringify(value)}\n`);
  if (payload.nextActions?.length) {
    process.stdout.write("\nNext:\n");
    for (const next of payload.nextActions)
      process.stdout.write(`- ${next.command}\n`);
  }
  if (payload.replyTemplate)
    process.stdout.write(
      `\nReply using template:\n- ${payload.replyTemplate.path}\n`,
    );
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

main().catch((error) => {
  const commandName = process.argv.slice(2, 4).join(" ") || "publication";
  const payload = {
    ok: false,
    command: commandName,
    outcome: "publication_command_failed",
    completeness: "failed",
    error: {
      code: error.code ?? "publication_command_failed",
      message: error.message,
      details: error.details ?? {},
    },
    nextActions:
      (commandName.startsWith("result-storage ") ||
        commandName.startsWith("result-readiness ") ||
        commandName.startsWith("result-publication ")) &&
      error.nextActions
        ? error.nextActions
        : [
            {
              kind: "inspect_publication_help",
              command: `${COMMAND} --help`,
              argv: ["node", CLI_PATH, "--help"],
            },
          ],
    replyTemplate: replyTemplateFor(commandName, { ok: false }),
  };
  attachReleaseConfiguration(payload, CLI_CONFIGURATION);
  if (process.argv.includes("--json"))
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  else
    process.stderr.write(
      `${payload.error.code}: ${payload.error.message}\n\nNext:\n- ${payload.nextActions[0]?.command ?? `${COMMAND} --help`}\n\nReply using template:\n- ${payload.replyTemplate.path}\n`,
    );
  process.exitCode = 1;
});
