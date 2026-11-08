#!/usr/bin/env node
import {
  configureReleaseCli,
  attachReleaseConfiguration,
} from "../environment/lib/cli-configuration.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTransformation } from "./lib/analysis.mjs";
import { executeTransformation } from "./lib/execute.mjs";
import { freezeTransformation } from "./lib/freeze.mjs";
import { replyTemplateFor } from "./reply-template-registry.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const COMMAND = `node ${shellQuote(CLI_PATH)}`;
const VALUE_OPTIONS = new Set([
  "candidate",
  "dsl",
  "analysis-dir",
  "spec-dir",
  "out-dir",
]);
const BOOLEAN_OPTIONS = new Set(["json", "help"]);

const HELP = `release-transform <command> [options]

Candidate-bound Dataset Transformation weighted aggregation.

Common configuration: --config-env <path> (default: repository .env if present).

Commands:
  dsl inspect        Analyze exact inputs and emit structured decision requests
  dsl freeze         Freeze a fully resolved, hash-bound executable DSL
  transform execute Execute and validate the selected frozen aggregation

Options:
  --candidate <path>       Validated Release Candidate v1 or v2 directory
  --dsl <path>             Draft DSL JSON file
  --analysis-dir <path>    Exact prior inspection directory
  --spec-dir <path>        Frozen DSL directory
  --out-dir <path>         New immutable output directory
  --json                   Emit one bounded JSON object

dsl inspect:
  --candidate <path> --dsl <path> --out-dir <path>

dsl freeze:
  --candidate <path> --dsl <path> --analysis-dir <path> --out-dir <path>

transform execute:
  --candidate <path> --spec-dir <path> --out-dir <path>

Business-field differences never become terminal command failures. They produce
status=needs_decision and a conflict-report artifact. Errors are reserved for
malformed contracts, input drift, runtime faults, or invalid generated output.
`;

let CLI_CONFIGURATION;
async function main() {
  CLI_CONFIGURATION = await configureReleaseCli(
    "dataset-transformation",
    process.argv.slice(2),
  );
  const [command, action, ...tokens] = CLI_CONFIGURATION.argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const commandName = `${command} ${action ?? ""}`.trim();
  const options = parseArgs(tokens);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const handlers = {
    "dsl inspect": inspectDsl,
    "dsl freeze": freezeDsl,
    "transform execute": execute,
  };
  if (!handlers[commandName])
    throw coded("unknown_command", `Unknown command: ${commandName}`);
  const payload = await handlers[commandName](options);
  payload.replyTemplate = replyTemplateFor(commandName, {
    status: payload.status,
    ok: true,
  });
  respond(options, payload);
}

async function inspectDsl(options) {
  requireOptions(options, ["candidate", "dsl", "out-dir"]);
  const result = await analyzeTransformation({
    candidateDir: path.resolve(options.candidate),
    dslFile: path.resolve(options.dsl),
    outDir: path.resolve(options["out-dir"]),
  });
  return success("dsl inspect", "transformation_inspected", {
    status: result.analysis.status,
    completeness:
      result.analysis.status === "ready"
        ? "decision_complete_freeze_pending"
        : "semantic_decisions_pending",
    inputCount: result.analysis.operation.inputCount,
    operationType: result.analysis.operation.type,
    targetSelection: result.analysis.operation.targetSelection ?? null,
    conflictCount: result.analysis.conflicts.length,
    unresolvedCount: result.analysis.unresolvedConflictIds.length,
    unresolvedConflictIds: result.analysis.unresolvedConflictIds,
    artifacts: {
      analysis: path.join(result.path, "transformation-analysis.json"),
      conflictReport: path.join(result.path, "conflict-report.json"),
    },
    nextActions:
      result.analysis.status === "ready"
        ? [
            nextAction("freeze_exact_dsl", [
              "dsl",
              "freeze",
              "--candidate",
              path.resolve(options.candidate),
              "--dsl",
              path.resolve(options.dsl),
              "--analysis-dir",
              result.path,
              "--out-dir",
              `${result.path}-frozen`,
              "--json",
            ]),
          ]
        : [
            {
              id: "resolve_conflicts",
              kind: "agent_user_decision",
              instruction:
                "Review conflict-report.json, update the draft DSL with explicit decisions, then run dsl inspect into a new directory",
            },
          ],
  });
}

async function freezeDsl(options) {
  requireOptions(options, ["candidate", "dsl", "analysis-dir", "out-dir"]);
  const result = await freezeTransformation({
    candidateDir: path.resolve(options.candidate),
    dslFile: path.resolve(options.dsl),
    analysisDir: path.resolve(options["analysis-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  if (result.status === "needs_decision")
    return success("dsl freeze", "transformation_needs_decision", {
      status: result.status,
      completeness: "semantic_decisions_pending",
      unresolvedCount: result.unresolvedConflictIds.length,
      unresolvedConflictIds: result.unresolvedConflictIds,
      artifacts: {
        analysis: path.join(
          path.resolve(options["analysis-dir"]),
          "transformation-analysis.json",
        ),
        conflictReport: path.join(
          path.resolve(options["analysis-dir"]),
          "conflict-report.json",
        ),
      },
      nextActions: [
        {
          id: "resolve_conflicts",
          kind: "agent_user_decision",
          instruction:
            "Resolve the listed conflicts in the draft DSL and inspect the revised DSL again",
        },
      ],
    });
  return success("dsl freeze", "transformation_frozen", {
    status: result.status,
    completeness: "frozen_execution_pending",
    frozenSpecSha256: result.frozenSpecSha256,
    artifacts: {
      frozenSpec: path.join(result.path, "transformation-frozen-spec.json"),
      analysis: path.join(result.path, "transformation-analysis.json"),
    },
    nextActions: [
      nextAction("execute_transformation", [
        "transform",
        "execute",
        "--candidate",
        path.resolve(options.candidate),
        "--spec-dir",
        result.path,
        "--out-dir",
        `${result.path}-execution`,
        "--json",
      ]),
    ],
  });
}

async function execute(options) {
  requireOptions(options, ["candidate", "spec-dir", "out-dir"]);
  const result = await executeTransformation({
    candidateDir: path.resolve(options.candidate),
    specDir: path.resolve(options["spec-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  const resultRoute = result.dataset.role === "result_process";
  return success("transform execute", "transformation_executed", {
    status: result.receipt.status,
    completeness: resultRoute
      ? "derived_result_ready_for_result_materialization"
      : "transformed_unit_process_ready_for_calculation",
    output: result.dataset,
    receiptSha256: result.receiptSha256,
    nextWorkflow: result.handoff.nextWorkflow,
    finalTarget: result.handoff.finalTarget,
    artifacts: {
      transformedProcess: path.join(
        result.path,
        "canonical-datasets",
        result.dataset.path,
      ),
      executionReceipt: path.join(
        result.path,
        "transformation-execution-receipt.json",
      ),
      handoff: path.join(result.path, "transformation-handoff.json"),
    },
    nextActions: resultRoute
      ? [
          {
            id: "enter_result_materialization",
            kind: "workflow_handoff",
            instruction:
              "Use transformation-handoff.json and the hash-bound Derived Result as Result Materialization input; materialize only a Result Process unless a separate LifecycleModel operation is designed and confirmed",
          },
        ]
      : [
          {
            id: "enter_calculation",
            kind: "workflow_handoff",
            instruction:
              "Use transformation-handoff.json and the transformed Unit Process as the next Calculation input; after Result Materialization, build a new Release Candidate",
          },
        ],
  });
}

function parseArgs(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--"))
      throw coded("unexpected_argument", `Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(key))
      throw coded("unknown_option", `Unknown option: --${key}`);
    const value = tokens[index + 1];
    if (!value || value.startsWith("--"))
      throw coded("missing_option_value", `Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function requireOptions(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length)
    throw coded(
      "required_option_missing",
      `Missing required options: ${missing.map((name) => `--${name}`).join(", ")}`,
    );
}

function nextAction(id, args) {
  return {
    id,
    kind: "command",
    command: [COMMAND, ...args.map(shellQuote)].join(" "),
  };
}

function success(command, outcome, payload) {
  return {
    ok: true,
    workflow: "dataset-transformation",
    command,
    outcome,
    ...payload,
  };
}

function respond(options, payload) {
  attachReleaseConfiguration(payload, CLI_CONFIGURATION);
  if (options.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function coded(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

main().catch((error) => {
  const payload = {
    ok: false,
    workflow: "dataset-transformation",
    outcome: "transformation_system_error",
    error: {
      code: error.code ?? "unexpected_error",
      message: error.message,
      details: error.details ?? {},
    },
    replyTemplate: replyTemplateFor("error", { ok: false }),
  };
  attachReleaseConfiguration(payload, CLI_CONFIGURATION);
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
