#!/usr/bin/env node

import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  createResultSetApi,
  ResultSetApiError,
} from "./adapters/result-set-api.mjs";
import { isUuid, ResultSetContractError } from "./contracts/result-set.mjs";
import {
  createResultSetOperations,
  ResultSetOperationError,
} from "./result-set-operations.mjs";
import { createResultSetContextStore } from "./runtime/result-set-context.mjs";
import { createCalculationTaskApi } from "./adapters/calculation-task-api.mjs";
import {
  DEFAULT_CALCULATION_PROFILE,
  defaultMethodSelections,
} from "./contracts/default-profile.mjs";
import { replyTemplateFor } from "./reply-template-registry.mjs";
import { recommendResultSetName } from "./contracts/result-set-name.mjs";
import {
  CalculationBundleStoreError,
  createCalculationBundleStore,
  downloadCalculationBundle,
} from "./adapters/calculation-bundle-store.mjs";
import {
  EnvironmentBootstrapError,
  syncDataPlaneEnvironment,
} from "./runtime/environment-bootstrap.mjs";
import {
  CALCULATION_CLI_PATH,
  CALCULATION_COMMAND,
  shellQuote,
} from "./runtime/cli-command.mjs";

const CLI_SCHEMA = "tiangong.calculation-cli-result.v1";
const COMMAND = CALCULATION_COMMAND;
const MATERIALIZATION_COMMAND = shellCommand(
  "node",
  fileURLToPath(new URL("../result-materialization/cli.mjs", import.meta.url)),
);
const WORKSPACE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REPOSITORY_ENV = fileURLToPath(new URL("../../.env", import.meta.url));
const WORKSPACE_ENV = fileURLToPath(new URL("../../../.env", import.meta.url));
const REPOSITORY_CONTEXT = fileURLToPath(
  new URL("../../.release", import.meta.url),
);

const HELP = `Calculation Workflow CLI

Manage the ResultSet entry point owned by workflows/calculation. This is not a
repository-wide tiangong-release command.

The displayed command uses the absolute CLI path (${CALCULATION_CLI_PATH}) and is safe to copy from any
working directory. Portable repository-root form: node workflows/calculation/cli.mjs

Usage:
  ${COMMAND} result-set list [--limit 20] [--format human|json]
  ${COMMAND} result-set get --result-set-id <uuid> [--format human|json]
  ${COMMAND} result-set create --name <name> --confirm-create [--format human|json]
  ${COMMAND} closure start --coverage-mode <global_eligible|subset> --method <uuid>@<version> --idempotency-token <token> --confirm-start
  ${COMMAND} closure get --closure-check-id <uuid> [--format human|json]
  ${COMMAND} calculation start --name <name> --closure-check-id <uuid> --requested-scope-hash <hash> --policy-fingerprint <hash> --coverage-mode <mode> --method <uuid>@<version> --idempotency-key <key> --confirm-start
  ${COMMAND} calculation get --job-id <uuid> [--format human|json]
  ${COMMAND} calculation-bundle list [--limit 20] [--format human|json]
  ${COMMAND} calculation-bundle get --package-id <uuid> [--format human|json]
  ${COMMAND} calculation-bundle download --package-id <uuid> [--out-dir <path>] [--concurrency 8] [--include-products] [--format human|json]
  ${COMMAND} environment sync [--workspace-env <path>] --confirm-sync [--format human|json]
  ${COMMAND} worker logs --job-id <uuid> [--environment <name>] [--since <journal-time>]

Behavior:
  list    Returns a bounded recent list; the remote contract has no cursor.
  get     Reads one exact ResultSet by UUID and records a local recovery reference.
  create  Creates a remote ResultSet only with --confirm-create and records its ID.
  closure get  Reads one exact Closure Check and reports whether its evidence can bind a calculation.
  calculation get  Reads database-backed task status first and recommends Worker logs only for diagnosis.
  calculation-bundle list  Lists bounded Bundle metadata through direct read-only SQL; no signed URLs.
  calculation-bundle get  Reads one exact Package/Bundle through parameterized read-only SQL.
  calculation-bundle download  Downloads and verifies one exact Bundle directly from S3.
  environment sync  Copies only missing data-plane keys from the workspace ignored .env.

Examples:
  ${COMMAND} result-set list --limit 20 --format json
  ${COMMAND} result-set get --result-set-id 123e4567-e89b-42d3-a456-426614174000
  ${COMMAND} result-set create --name "Steel baseline" --confirm-create
  ${COMMAND} calculation-bundle list --limit 20 --format json
  ${COMMAND} calculation-bundle get --package-id 28932bc0-dcb0-4819-901a-5eaefcc51433
  ${COMMAND} calculation-bundle download --package-id 28932bc0-dcb0-4819-901a-5eaefcc51433
`;

const EXIT_CODES = {
  invalid_request: 2,
  confirmation_required: 3,
  result_set_name_confirmation_required: 3,
  auth_required: 4,
  result_set_not_found: 5,
  not_data_product_manager: 6,
  remote_outcome_unknown: 7,
  invalid_result_set_reference: 8,
  capability_unavailable: 9,
  local_context_write_failed: 10,
  data_plane_configuration_required: 11,
  database_read_failed: 12,
  package_not_found: 13,
  calculation_bundle_not_available: 14,
  artifact_download_failed: 15,
  artifact_integrity_mismatch: 16,
  bundle_manifest_binding_mismatch: 17,
};

function parseFlags(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      throw new ResultSetOperationError(
        "invalid_request",
        `Unexpected argument: ${token}`,
      );
    }
    const key = token.slice(2);
    if (
      [
        "confirm-create",
        "confirm-start",
        "confirm-sync",
        "include-products",
      ].includes(key)
    ) {
      const property = {
        "confirm-create": "confirmCreate",
        "confirm-start": "confirmStart",
        "confirm-sync": "confirmSync",
        "include-products": "includeProducts",
      }[key];
      values[property] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ResultSetOperationError(
        "invalid_request",
        `--${key} requires a value`,
      );
    }
    index += 1;
    if (key === "format") values.format = value;
    else if (key === "limit") values.limit = Number(value);
    else if (key === "result-set-id") values.resultSetId = value;
    else if (key === "name") values.name = value;
    else if (key === "job-id") values.jobId = value;
    else if (key === "package-id") values.packageId = value;
    else if (key === "out-dir") values.outDir = value;
    else if (key === "workspace-env") values.workspaceEnv = value;
    else if (key === "concurrency") values.concurrency = Number(value);
    else if (key === "closure-check-id") values.closureCheckId = value;
    else if (key === "coverage-mode") values.coverageMode = value;
    else if (key === "idempotency-token") values.idempotencyToken = value;
    else if (key === "idempotency-key") values.idempotencyKey = value;
    else if (key === "requested-scope-hash") values.requestedScopeHash = value;
    else if (key === "policy-fingerprint") values.policyFingerprint = value;
    else if (key === "environment") values.environment = value;
    else if (key === "since") values.since = value;
    else if (key === "method" || key === "process")
      (values[`${key}s`] ??= []).push(value);
    else
      throw new ResultSetOperationError(
        "invalid_request",
        `Unknown option: --${key}`,
      );
  }
  if (values.format && !["human", "json"].includes(values.format)) {
    throw new ResultSetOperationError(
      "invalid_request",
      "--format must be human or json",
    );
  }
  return values;
}

function selection(value, flag) {
  const split = value.lastIndexOf("@");
  const id = value.slice(0, split);
  const version = value.slice(split + 1);
  if (split < 1 || !isUuid(id) || !/^\d{2}\.\d{2}\.\d{3}$/.test(version))
    throw new ResultSetOperationError(
      "invalid_request",
      `${flag} must be <uuid>@<00.00.000>`,
    );
  return { id, version };
}

function workspaceLogsCommand(jobId, { environment, since } = {}) {
  const parts = [
    `cd ${shellQuote(WORKSPACE_ROOT)} && python -m workspace_ops.cli worker job`,
    jobId,
    "--all-configs",
    "--kind all",
  ];
  if (environment) parts.push("--environment", JSON.stringify(environment));
  if (since) parts.push("--since", JSON.stringify(since));
  parts.push("--execute");
  return parts.join(" ");
}

function shellCommand(executable, script) {
  return `${shellQuote(executable)} ${shellQuote(script)}`;
}

function shellCommandFromArgs(args) {
  return [COMMAND, ...args.map((value) => shellQuote(value))].join(" ");
}

function closureStartCommand(resultSetId) {
  return `${COMMAND} closure start --result-set-id ${resultSetId} --idempotency-token "$(uuidgen | tr '[:upper:]' '[:lower:]')" --confirm-start`;
}

function success(command, result) {
  const nextActions = [];
  let nextDecision;
  if (command === "result-set.list") {
    nextActions.push(`${COMMAND} result-set get --result-set-id <uuid>`);
    nextDecision = {
      kind: "select_result_set",
      requiresConfirmation: true,
      prompt: "请选择一个精确 ResultSet ID；不会根据名称自动选择。",
    };
  } else {
    nextActions.push(closureStartCommand(result.data.id));
    nextDecision = {
      kind: "confirm_closure_start",
      requiresConfirmation: true,
      prompt:
        "是否使用 global_eligible 范围和完整的 25 个 reviewed LCIA 方法启动完整性校验？",
      defaults: {
        coverageMode: DEFAULT_CALCULATION_PROFILE.coverageMode,
        lciaMethodCount: DEFAULT_CALCULATION_PROFILE.lciaMethods.length,
      },
    };
  }
  const output = {
    schemaVersion: CLI_SCHEMA,
    ok: true,
    command,
    ...result,
    nextActions,
    nextDecision,
  };
  return { ...output, replyTemplate: replyTemplateFor(command, { ok: true }) };
}

function failure(command, error, argv = []) {
  const code = error?.code ?? "capability_unavailable";
  const nextActions =
    code === "result_set_name_confirmation_required"
      ? [
          `${COMMAND} result-set create --name ${error.details.recommendedName} --confirm-create`,
        ]
      : code === "confirmation_required"
        ? command === "result-set.create"
          ? [shellCommandFromArgs([...argv, "--confirm-create"])]
          : [shellCommandFromArgs([...argv, "--confirm-start"])]
        : code === "remote_outcome_unknown"
          ? [`${COMMAND} result-set list --format json`]
          : code === "data_plane_configuration_required"
            ? [`${COMMAND} environment sync --confirm-sync`]
            : command === "calculation-bundle.list"
              ? [`${COMMAND} calculation-bundle list --limit 20`]
              : error?.details?.packageId
                ? [
                    `${COMMAND} calculation-bundle get --package-id ${error.details.packageId}`,
                  ]
                : [];
  if (
    nextActions.length === 0 &&
    ["invalid_request", "capability_unavailable"].includes(code)
  )
    nextActions.push(`${COMMAND} --help`);
  const output = {
    schemaVersion: CLI_SCHEMA,
    ok: false,
    command,
    error: {
      code,
      message:
        error instanceof Error ? error.message : "Unknown ResultSet failure",
      ...(error?.details === undefined ? {} : { details: error.details }),
    },
    nextActions,
  };
  return {
    ...output,
    replyTemplate: replyTemplateFor(command, { ok: false, errorCode: code }),
  };
}

function humanSuccess(result) {
  const lines = [];
  if (result.command === "result-set.list") {
    lines.push(`ResultSets (${result.data.items.length})`, "", "Summary:");
    for (const item of result.data.items) {
      lines.push(
        `- ${item.name} | ${item.id} | ${item.createdAt ?? "unknown"}`,
      );
    }
    lines.push(
      `- Completeness: bounded to ${result.completeness.limit}; more items ${result.completeness.mayHaveMore ? "may exist" : "are not indicated"}`,
    );
  } else {
    lines.push(
      result.command === "result-set.create"
        ? "ResultSet created"
        : "ResultSet found",
      "",
      "Summary:",
      `- ${result.data.name} | ${result.data.id} | ${result.data.createdAt ?? "unknown"}`,
      `- Recovery reference: ${result.contextPath}`,
    );
  }
  for (const warning of result.warnings ?? [])
    lines.push(`- Warning: ${warning.message}`);
  lines.push("", "Next:");
  for (const action of result.nextActions) lines.push(`- ${action}`);
  lines.push(`- Reply using template: ${result.replyTemplate.path}`);
  return `${lines.join("\n")}\n`;
}

function humanFailure(result) {
  const lines = [
    `ResultSet command failed: ${result.error.code}`,
    "",
    result.error.message,
  ];
  if (result.nextActions.length) {
    lines.push("", "Next:");
    for (const action of result.nextActions) lines.push(`- ${action}`);
  }
  lines.push("", `Reply template: ${result.replyTemplate.path}`);
  return `${lines.join("\n")}\n`;
}

export async function runCli(
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    fetchImpl = globalThis.fetch,
    contextRoot = REPOSITORY_CONTEXT,
    now = () => new Date(),
    bundleStoreFactory = createCalculationBundleStore,
    bundleDownloader = downloadCalculationBundle,
    environmentSynchronizer = syncDataPlaneEnvironment,
  } = {},
) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    stdout.write(HELP);
    return 0;
  }

  let command = "result-set.unknown";
  let format = "human";
  let recoveryPackageId;
  try {
    const [family, action, ...rest] = argv;
    if (family === "environment" && action === "sync") {
      command = "environment.sync";
      const flags = parseFlags(rest);
      format = flags.format ?? "human";
      if (!flags.confirmSync)
        throw new ResultSetOperationError(
          "confirmation_required",
          "Copying data-plane credentials into the Release .env requires --confirm-sync",
        );
      const data = await environmentSynchronizer({
        source: flags.workspaceEnv ?? WORKSPACE_ENV,
        target: REPOSITORY_ENV,
      });
      const result = {
        schemaVersion: CLI_SCHEMA,
        ok: true,
        command,
        data,
        completeness: {
          status: data.missingSourceKeys.length ? "partial" : "complete",
          valuesExposed: false,
        },
        nextActions: data.missingSourceKeys.length
          ? [
              `Add the missing keys to the workspace .env, then rerun: ${COMMAND} environment sync --confirm-sync`,
            ]
          : [`${COMMAND} calculation-bundle list --limit 20`],
      };
      result.replyTemplate = replyTemplateFor(command, { ok: true });
      stdout.write(
        format === "json"
          ? `${JSON.stringify(result)}\n`
          : `Release data-plane environment synchronized\n\nSummary:\n- Copied keys: ${data.copiedKeys.join(", ") || "none"}\n- Preserved keys: ${data.preservedKeys.join(", ") || "none"}\n- Missing source keys: ${data.missingSourceKeys.join(", ") || "none"}\n- Secret values exposed: no\n\nNext:\n- ${result.nextActions[0]}\n- Reply using template: ${result.replyTemplate.path}\n`,
      );
      return 0;
    }
    if (family === "worker" && action === "logs") {
      command = "worker.logs";
      const flags = parseFlags(rest);
      format = flags.format ?? "human";
      if (!isUuid(flags.jobId))
        throw new ResultSetOperationError(
          "invalid_request",
          "--job-id must be an exact UUID",
        );
      const instruction = workspaceLogsCommand(flags.jobId, flags);
      const result = {
        schemaVersion: CLI_SCHEMA,
        ok: true,
        command,
        data: {
          jobId: flags.jobId,
          executionOwner: "lca-workspace/workspace_ops",
          workingDirectory: "lca-workspace root",
          instruction,
        },
        completeness: { status: "delegated", remoteLogsRead: false },
        nextActions: [instruction],
      };
      result.replyTemplate = replyTemplateFor(command, { ok: true });
      stdout.write(
        format === "json"
          ? `${JSON.stringify(result)}\n`
          : `Worker log access\n\nRun from the lca-workspace root:\n${instruction}\n\nReply template: ${result.replyTemplate.path}\n`,
      );
      return 0;
    }
    if (family === "closure" && action === "get") {
      command = "closure.get";
      const flags = parseFlags(rest);
      format = flags.format ?? "human";
      if (!isUuid(flags.closureCheckId))
        throw new ResultSetOperationError(
          "invalid_request",
          "--closure-check-id must be an exact UUID",
        );
      const closure = await createCalculationTaskApi({
        env,
        fetchImpl,
      }).getClosure(flags.closureCheckId);
      const inspectAgain = `${COMMAND} closure get --closure-check-id ${closure.closureCheckId}`;
      const nextActions = closure.calculationReady
        ? [
            `Confirm the calculation name and reuse the exact coverage/process/method selections submitted for Closure ${closure.closureCheckId}; then run ${COMMAND} calculation start with --closure-check-id ${closure.closureCheckId} --requested-scope-hash ${closure.binding.requestedScopeHash} --policy-fingerprint ${closure.binding.policyFingerprint} and a new --idempotency-key. The provider projection cannot safely reconstruct the original scope arguments.`,
          ]
        : [inspectAgain];
      const result = {
        schemaVersion: CLI_SCHEMA,
        ok: true,
        command,
        data: closure,
        completeness: {
          status: closure.calculationReady ? "calculation_ready" : "not_ready",
          bindingComplete:
            closure.binding.requestedScopeHash !== null &&
            closure.binding.policyFingerprint !== null,
          scopeIdentityReturned: false,
        },
        warnings: [
          {
            code: "scope_identity_not_returned",
            message:
              "The provider projection does not return the Closure method/process identities; replace the scope placeholders with the exact values used to create this Closure. Do not assume the current defaults match an older Closure.",
          },
        ],
        nextActions,
      };
      result.replyTemplate = replyTemplateFor(command, { ok: true });
      stdout.write(
        format === "json"
          ? `${JSON.stringify(result)}\n`
          : `Closure Check inspected\n\nSummary:\n- Closure: ${closure.closureCheckId}\n- Run: ${closure.runStatus}\n- Scan: ${closure.scanCompleteness}\n- Certificate: ${closure.certificateValidity}\n- Calculation ready: ${closure.calculationReady ? "yes" : "no"}\n- Requested scope hash: ${closure.binding.requestedScopeHash ?? "pending"}\n- Policy fingerprint: ${closure.binding.policyFingerprint ?? "pending"}\n\nNext:\n- ${nextActions[0]}\n- Reply using template: ${result.replyTemplate.path}\n`,
      );
      return 0;
    }
    if (
      family === "calculation-bundle" &&
      ["list", "get", "download"].includes(action)
    ) {
      command = `calculation-bundle.${action}`;
      const flags = parseFlags(rest);
      format = flags.format ?? "human";
      if (["get", "download"].includes(action) && !isUuid(flags.packageId))
        throw new ResultSetOperationError(
          "invalid_request",
          "--package-id must be an exact UUID",
        );
      recoveryPackageId = flags.packageId;
      const limit = flags.limit ?? 20;
      if (
        action === "list" &&
        (!Number.isInteger(limit) || limit < 1 || limit > 200)
      )
        throw new ResultSetOperationError(
          "invalid_request",
          "--limit must be an integer from 1 to 200",
        );
      if (
        action === "download" &&
        flags.concurrency !== undefined &&
        (!Number.isInteger(flags.concurrency) ||
          flags.concurrency < 1 ||
          flags.concurrency > 32)
      )
        throw new ResultSetOperationError(
          "invalid_request",
          "--concurrency must be an integer from 1 to 32",
        );
      const store = bundleStoreFactory({ env });
      if (action === "download") {
        const metadata = await store.get(flags.packageId, {
          includeLocators: true,
        });
        const outDir =
          flags.outDir ??
          fileURLToPath(
            new URL(
              `../../.release/calculation/bundles/${flags.packageId}/`,
              import.meta.url,
            ),
          );
        const downloaded = await bundleDownloader({
          metadata,
          outDir,
          env,
          concurrency: flags.concurrency ?? 8,
          includeProducts: flags.includeProducts === true,
        });
        const result = {
          schemaVersion: CLI_SCHEMA,
          ok: true,
          command,
          data: {
            packageId: metadata.packageId,
            packageVersion: metadata.packageVersion,
            bundle: metadata.bundle,
            bundleDirectory: downloaded.bundleDirectory,
            receiptPath: downloaded.receiptPath,
            verification: downloaded.receipt.verification,
            artifactCount: downloaded.receipt.artifactCount,
            productDownloadCount: downloaded.receipt.productDownloadCount,
          },
          completeness: {
            status: "complete",
            source: "direct_database_and_s3",
            signedUrlsCreated: false,
          },
          nextActions: [
            `${MATERIALIZATION_COMMAND} intake --bundle ${shellQuote(downloaded.bundleDirectory)} --json`,
          ],
        };
        result.replyTemplate = replyTemplateFor(command, { ok: true });
        stdout.write(
          format === "json"
            ? `${JSON.stringify(result)}\n`
            : `Calculation Bundle downloaded and verified\n\nSummary:\n- Package: ${metadata.packageId}\n- Bundle directory: ${downloaded.bundleDirectory}\n- Artifacts: ${downloaded.receipt.artifactCount}\n- Products: ${downloaded.receipt.productDownloadCount}\n- Receipt: ${downloaded.receiptPath}\n- Signed URLs created: no\n\nNext:\n- ${result.nextActions[0]}\n- Reply using template: ${result.replyTemplate.path}\n`,
        );
        return 0;
      }
      const operation =
        action === "list"
          ? await store.list(limit)
          : { item: await store.get(flags.packageId) };
      const items = action === "list" ? operation.items : [operation.item];
      const result = {
        schemaVersion: CLI_SCHEMA,
        ok: true,
        command,
        data: action === "list" ? { items } : operation.item,
        completeness:
          action === "list"
            ? operation.completeness
            : {
                status: "complete",
                selector: "exact_package_id",
                source: "direct_read_only_database",
              },
        warnings: [],
        nextActions:
          action === "get"
            ? [
                `${COMMAND} calculation-bundle download --package-id ${items[0].packageId}`,
              ]
            : items.length
              ? [
                  `${COMMAND} calculation-bundle get --package-id <SELECT_PACKAGE_ID>`,
                ]
              : [
                  `${COMMAND} calculation get --job-id <RECENT_CALCULATION_JOB_ID>`,
                ],
      };
      result.replyTemplate = replyTemplateFor(command, { ok: true });
      stdout.write(
        format === "json"
          ? `${JSON.stringify(result)}\n`
          : `${action === "list" ? `Calculation Bundles (${items.length})` : "Calculation Bundle found"}\n\nSummary:\n${
              items.length
                ? items
                    .map(
                      (item) =>
                        `- Package ${item.packageId} | ${item.packageStatus} | ${item.bundle.artifactCount} artifacts | ${item.productDownloadCount} products`,
                    )
                    .join("\n")
                : "- No Calculation Bundle metadata found"
            }\n- Source: direct read-only database\n- Signed URLs created: no\n\nNext:\n${result.nextActions.map((entry) => `- ${entry}`).join("\n")}\n- Reply using template: ${result.replyTemplate.path}\n`,
      );
      return 0;
    }
    if (family === "calculation" && action === "get") {
      command = "calculation.get";
      const flags = parseFlags(rest);
      format = flags.format ?? "human";
      if (!isUuid(flags.jobId))
        throw new ResultSetOperationError(
          "invalid_request",
          "--job-id must be an exact UUID",
        );
      const { task, lookup } = await createCalculationTaskApi({
        env,
        fetchImpl,
      }).getCalculation(flags.jobId);
      const inspectAgain = `${COMMAND} calculation get --job-id ${task.jobId}`;
      const logs = workspaceLogsCommand(task.jobId);
      const nextActions = task.diagnosticsRecommended
        ? [logs, inspectAgain]
        : task.terminal
          ? task.resultPackageId
            ? [
                `${COMMAND} calculation-bundle get --package-id ${task.resultPackageId}`,
              ]
            : [inspectAgain]
          : [inspectAgain];
      const result = {
        schemaVersion: CLI_SCHEMA,
        ok: true,
        command,
        data: {
          ...task,
          statusAuthority: "database_task_projection",
          workerLogsRole: "secondary_diagnostics",
        },
        completeness: {
          status: task.terminal ? "terminal_observed" : "in_progress",
          lookup,
        },
        nextActions,
      };
      result.replyTemplate = replyTemplateFor(command, { ok: true });
      stdout.write(
        format === "json"
          ? `${JSON.stringify(result)}\n`
          : `Calculation task inspected\n\nSummary:\n- Job: ${task.jobId}\n- Worker status: ${task.workerStatus}\n- Domain status: ${task.domainStatus ?? "pending"}\n- Domain validity: ${task.domainValidity ?? "pending"}\n- Phase: ${task.phase ?? "unknown"}\n- Progress: ${task.progressFraction ?? "unknown"}\n- Result package: ${task.resultPackageId ?? "pending"}\n- Worker diagnostics recommended: ${task.diagnosticsRecommended ? "yes" : "no"}\n\nNext:\n${nextActions.length ? nextActions.map((entry) => `- ${entry}`).join("\n") : "- No further CLI action required"}\n- Reply using template: ${result.replyTemplate.path}\n`,
      );
      return 0;
    }
    if (["closure", "calculation"].includes(family) && action === "start") {
      command = `${family}.start`;
      const flags = parseFlags(rest);
      format = flags.format ?? "human";
      if (!flags.confirmStart)
        throw new ResultSetOperationError(
          "confirmation_required",
          `Starting ${family} requires --confirm-start`,
        );
      const defaultedInputs = [];
      const coverageMode =
        flags.coverageMode ?? DEFAULT_CALCULATION_PROFILE.coverageMode;
      if (!flags.coverageMode) defaultedInputs.push("coverageMode");
      if (!["global_eligible", "subset"].includes(coverageMode))
        throw new ResultSetOperationError(
          "invalid_request",
          "--coverage-mode must be global_eligible or subset",
        );
      const processes = (flags.processes ?? []).map((value) =>
        selection(value, "--process"),
      );
      const lciaMethods = flags.methods?.length
        ? flags.methods.map((value) => selection(value, "--method"))
        : defaultMethodSelections();
      if (!flags.methods?.length) defaultedInputs.push("lciaMethods");
      if ((coverageMode === "subset") !== processes.length > 0)
        throw new ResultSetOperationError(
          "invalid_request",
          "subset requires --process; global_eligible forbids it",
        );
      const taskApi = createCalculationTaskApi({ env, fetchImpl });
      let task;
      if (family === "closure") {
        if (flags.resultSetId && !isUuid(flags.resultSetId))
          throw new ResultSetOperationError(
            "invalid_request",
            "--result-set-id must be an exact UUID",
          );
        if (!flags.idempotencyToken)
          throw new ResultSetOperationError(
            "invalid_request",
            "--idempotency-token is required",
          );
        task = await taskApi.createClosure({
          resultSetId: flags.resultSetId,
          requestedScope: {
            coverageMode,
            ...(processes.length ? { processes } : {}),
            lciaMethods,
          },
          idempotencyToken: flags.idempotencyToken,
        });
      } else {
        for (const [key, label] of [
          ["name", "--name"],
          ["closureCheckId", "--closure-check-id"],
          ["requestedScopeHash", "--requested-scope-hash"],
          ["policyFingerprint", "--policy-fingerprint"],
          ["idempotencyKey", "--idempotency-key"],
        ])
          if (!flags[key])
            throw new ResultSetOperationError(
              "invalid_request",
              `${label} is required`,
            );
        if (!isUuid(flags.closureCheckId))
          throw new ResultSetOperationError(
            "invalid_request",
            "--closure-check-id must be an exact UUID",
          );
        const defaultImpactCategory = lciaMethods.some(
          ({ id }) => id === DEFAULT_CALCULATION_PROFILE.defaultImpactCategory,
        )
          ? DEFAULT_CALCULATION_PROFILE.defaultImpactCategory
          : lciaMethods[0].id;
        defaultedInputs.push("defaultImpactCategory");
        task = await taskApi.createCalculation({
          ...flags,
          coverageMode,
          processes,
          lciaMethods,
          defaultImpactCategory,
        });
        flags.defaultImpactCategory = defaultImpactCategory;
      }
      const logs = workspaceLogsCommand(task.jobId);
      const nextDecision = ["queued", "running"].includes(task.status)
        ? {
            kind: "confirm_task_monitoring",
            requiresConfirmation: true,
            prompt: `是否为${family === "closure" ? ` Closure Check ${task.resourceId}` : ` Worker Job ${task.jobId}`} 创建持续监测的定时任务或进程？仅在完成、失败、阻塞或需要你处理时通知，并在任务终态停止监测。`,
          }
        : null;
      const result = {
        schemaVersion: CLI_SCHEMA,
        ok: true,
        command,
        data: {
          ...task,
          effectiveInput: {
            coverageMode,
            lciaMethods,
            ...(family === "calculation"
              ? { defaultImpactCategory: flags.defaultImpactCategory }
              : {}),
            defaultedInputs,
          },
        },
        completeness: { status: "submitted", terminalStateObserved: false },
        nextDecision,
        nextActions: [
          family === "closure"
            ? `${COMMAND} closure get --closure-check-id ${task.resourceId}`
            : `${COMMAND} calculation get --job-id ${task.jobId}`,
          logs,
          ...(nextDecision ? [nextDecision.prompt] : []),
        ],
      };
      result.replyTemplate = replyTemplateFor(command, { ok: true });
      stdout.write(
        format === "json"
          ? `${JSON.stringify(result)}\n`
          : `${family === "closure" ? "Closure Check" : "Calculation"} submitted\n\nSummary:\n- Job: ${task.jobId}\n- Resource: ${task.resourceId ?? "pending"}\n- Identity: ${task.identityCompleteness}\n- Status: ${task.status}\n\nNext:\n${result.nextActions.map((entry) => `- ${entry}`).join("\n")}\n- Reply using template: ${result.replyTemplate.path}\n`,
      );
      return 0;
    }
    if (
      family !== "result-set" ||
      !["list", "get", "create"].includes(action)
    ) {
      throw new ResultSetOperationError(
        "invalid_request",
        "Expected result-set list/get/create, closure start/get, calculation start/get, calculation-bundle list/get/download, environment sync, or worker logs; use --help for examples",
      );
    }
    command = `result-set.${action}`;
    const flags = parseFlags(rest);
    format = flags.format ?? "human";

    if (
      action === "list" &&
      flags.limit !== undefined &&
      !Number.isInteger(flags.limit)
    ) {
      throw new ResultSetOperationError(
        "invalid_request",
        "--limit must be an integer from 1 to 200",
      );
    }
    if (action === "get" && !isUuid(flags.resultSetId)) {
      throw new ResultSetOperationError(
        "invalid_request",
        "--result-set-id must be an exact UUID; names are not resolved implicitly",
      );
    }
    if (action === "create" && !flags.name?.trim()) {
      throw new ResultSetOperationError(
        "result_set_name_confirmation_required",
        "No ResultSet name was supplied; review the recommended name before creating it",
        { recommendedName: recommendResultSetName(now()) },
      );
    }
    if (action === "create" && !flags.confirmCreate) {
      throw new ResultSetOperationError(
        "confirmation_required",
        "Creating a remote ResultSet requires --confirm-create after the exact name is reviewed",
        { name: flags.name.trim() },
      );
    }

    const api = createResultSetApi({ env, fetchImpl });
    const operations = createResultSetOperations({
      api,
      contextStore: createResultSetContextStore({ root: contextRoot }),
    });

    const operationResult =
      action === "list"
        ? await operations.list({ limit: flags.limit ?? 20 })
        : action === "get"
          ? await operations.get({ resultSetId: flags.resultSetId })
          : await operations.create({
              name: flags.name,
              confirmed: flags.confirmCreate,
            });
    const result = success(command, operationResult);
    stdout.write(
      format === "json" ? `${JSON.stringify(result)}\n` : humanSuccess(result),
    );
    return 0;
  } catch (error) {
    let normalized = error;
    if (recoveryPackageId && error && typeof error === "object") {
      error.details = {
        ...(error.details ?? {}),
        packageId: recoveryPackageId,
        retrySafe: true,
        calculationRetryRequired: false,
      };
    }
    if (
      !(error instanceof ResultSetOperationError) &&
      !(error instanceof ResultSetApiError) &&
      !(error instanceof ResultSetContractError) &&
      !(error instanceof CalculationBundleStoreError) &&
      !(error instanceof EnvironmentBootstrapError) &&
      error?.name !== "ActorSessionError"
    ) {
      normalized = new ResultSetOperationError(
        "local_context_write_failed",
        "The ResultSet operation completed but its local recovery reference could not be written",
        { cause: error instanceof Error ? error.name : "unknown" },
      );
    }
    const result = failure(command, normalized, argv);
    const rendered =
      format === "json" ? `${JSON.stringify(result)}\n` : humanFailure(result);
    (format === "json" ? stdout : stderr).write(rendered);
    return EXIT_CODES[result.error.code] ?? 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (existsSync(REPOSITORY_ENV)) loadEnvFile(REPOSITORY_ENV);
  process.exitCode = await runCli(process.argv.slice(2));
}
