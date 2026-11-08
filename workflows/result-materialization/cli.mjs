#!/usr/bin/env node
import {
  configureReleaseCli,
  attachReleaseConfiguration,
} from "../environment/lib/cli-configuration.mjs";
import path from "node:path";
import { createIntake } from "./lib/intake.mjs";
import {
  cancelMaterializationJob,
  getMaterializationJob,
  readMaterializationJobLogs,
  startMaterializationJob,
} from "./lib/background-job.mjs";
import { materialize } from "./lib/materialize.mjs";
import { materializeDerivedResult } from "./lib/derived-result.mjs";
import {
  MATERIALIZATION_COMMAND,
  RELEASE_COMMAND,
  shellQuote,
} from "./runtime/cli-command.mjs";

const HELP = `release-result-materialization <command> [options]

Common configuration: --config-env <path> (default: repository .env if present).

Commands:
  intake              Verify a local Calculation Bundle v2 ZIP/directory and freeze an intake
  materialize         Generate the requested Result Process or LifecycleModel delivery
  materialize derived Verify and freeze already-processed Derived Result bytes
  materialize start   Start the same Materialization engine as an observable nohup job
  job get             Read bounded local status for one exact background job
  job logs            Read the last 1-500 lines from one exact background job log
  job cancel          Request SIGTERM cancellation for one exact running job

intake options:
  --bundle <path>      Local calculation-evidence-bundle.zip or extracted directory
  --artifact-root <path>  Artifact workspace root; defaults to repository .release
  --out-dir <path>     Advanced explicit immutable intake path

materialize options:
  --intake <path>      Verified intake directory
  --processes <list>   Comma-separated UUID@version selectors
  --all                Select every eligible Process in the Calculation Bundle
  --output-type <type> result-process or lifecycle-model
  --result-process-layer <layer> Result Process content: lci or lci-lcia
  --artifact-root <path>  Artifact workspace root; defaults to repository .release
  --out-dir <path>     Advanced explicit immutable output path
  --first-generation   Confirm that no previous Release Manifest exists
  --previous-manifest <path>  Previous materialization/release manifest
  --result-version-plan <path> Exact read-only registry plan; regenerate matched Results before freezing
  --concurrency <count>   Bounded render/write workers; defaults to 2, maximum 16

job options:
  --job-id <uuid>      Exact local Materialization job identity
  --tail <count>       Log lines to return; defaults to 100, maximum 500
  --artifact-root <path>  Same optional local workspace root used by start

Common:
  --json               Emit one bounded JSON result on stdout
  --help               Show this help
`;

const ACTION_HELP = {
  intake: `release-result-materialization intake --bundle <path> [--artifact-root <path> | --out-dir <path>] [--json]\n\nVerify a local Calculation Bundle and freeze an immutable, content-addressed intake.\n`,
  materialize: `release-result-materialization materialize --intake <path> (--processes <UUID@version,...> | --all) --output-type <result-process|lifecycle-model> --result-process-layer <lci|lci-lcia> (--first-generation | --previous-manifest <path>) [--artifact-root <path> | --out-dir <path>] [--result-version-plan <path>] [--concurrency <1-16>] [--json]\n\nRun Result Materialization in the foreground. The default output path is content-addressed and safely reusable.\n`,
  "materialize derived": `release-result-materialization materialize derived --candidate <path> --transformation <path> [--spec <path>] [--artifact-root <path> | --out-dir <path>] [--json]\n\nVerify the producer handoff and freeze exact Result bytes, without a solve or synthesized Model. Older handoffs require --spec pointing to their frozen spec.\n`,
  "materialize start": `release-result-materialization materialize start --intake <path> (--processes <UUID@version,...> | --all) --output-type <result-process|lifecycle-model> --result-process-layer <lci|lci-lcia> (--first-generation | --previous-manifest <path>) [--artifact-root <path>] [--out-dir <path>] [--result-version-plan <path>] [--concurrency <1-16>] [--json]\n\nStart the same deterministic engine as an observable local nohup job. With explicit --out-dir, --artifact-root only relocates job records.\n`,
  "job get": `release-result-materialization job get --job-id <uuid> [--artifact-root <path>] [--json]\n\nRead bounded status, progress, resources, throughput, and ETA for one job.\n`,
  "job logs": `release-result-materialization job logs --job-id <uuid> [--tail <1-500>] [--artifact-root <path>] [--json]\n\nRead a bounded tail of one job's structured local log.\n`,
  "job cancel": `release-result-materialization job cancel --job-id <uuid> [--artifact-root <path>] [--json]\n\nRequest cancellation after verifying the exact runner identity.\n`,
};

let CLI_CONFIGURATION;
async function main() {
  CLI_CONFIGURATION = await configureReleaseCli(
    "result-materialization",
    process.argv.slice(2),
  );
  const [command, ...initialTokens] = CLI_CONFIGURATION.argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const tokens = [...initialTokens];
  const subcommand =
    tokens[0] && !tokens[0].startsWith("--") ? tokens.shift() : null;
  if (tokens.includes("--help") || tokens.includes("-h")) {
    const route = subcommand ? `${command} ${subcommand}` : command;
    process.stdout.write(ACTION_HELP[route] ?? HELP);
    return;
  }
  if (command === "materialize" && subcommand === "derived") {
    const allowed = new Set([
      "candidate",
      "transformation",
      "spec",
      "out-dir",
      "artifact-root",
      "json",
    ]);
    const seen = new Set();
    for (const token of tokens.filter((value) => value.startsWith("--"))) {
      const key = token.slice(2);
      if (!allowed.has(key) || seen.has(key))
        throw Object.assign(
          new Error(`Unsupported or duplicate Derived Result option: ${token}`),
          { code: "invalid_arguments" },
        );
      seen.add(key);
    }
  }
  const options = parseArgs(tokens);
  if (command === "intake") {
    requireOptions(options, ["bundle"]);
    requireExclusivePaths(options);
    const result = await createIntake({
      bundle: options.bundle,
      outDir: options["out-dir"],
      artifactRoot: options["artifact-root"],
    });
    respond(options, {
      ok: true,
      command,
      outcome: result.disposition,
      intake: result.path,
      artifactRoot: result.artifactRoot,
      artifactPath: result.artifactPath,
      recommendedCanonicalPath: result.recommendedCanonicalPath,
      pathPolicy: result.pathPolicy,
      artifactIdentity: result.artifactIdentity,
      calculationId: result.intake.source.calculationId,
      bundleContentHash: result.intake.source.bundleContentHash,
      nextAction: {
        kind: "confirm_materialization_recipe",
        requiresConfirmation: true,
        command: `${MATERIALIZATION_COMMAND} materialize start --intake ${shellQuote(result.path)} --processes <UUID@VERSION,...> --output-type <result-process|lifecycle-model> --result-process-layer <lci|lci-lcia> <version-option> --json`,
        description:
          "Choose scope, output type, and Result layer. For an existing Result lineage use --previous-manifest <path> from the prior materialization that owns its latest version. Use --first-generation only for genuinely new lineages. Omit 'start' for a foreground run.",
      },
    });
    return;
  }
  if (command === "materialize" && subcommand === "derived") {
    requireOptions(options, ["candidate", "transformation"]);
    requireExclusivePaths(options);
    const result = await materializeDerivedResult({
      candidateDir: options.candidate,
      transformationDir: options.transformation,
      specDir: options.spec,
      outDir: options["out-dir"],
      artifactRoot: options["artifact-root"],
    });
    respond(options, {
      ok: true,
      command: "materialize derived",
      outcome: result.disposition,
      output: result.path,
      outputType: "result-process",
      resultProcessLayer: result.request.resultProcessLayer,
      completeness: result.manifest.completeness,
      candidateQualified: false,
      publicationAuthorized: false,
      nextAction: {
        kind: "prepare_result_only_release",
        description:
          "Resolve verified parent lineage and frozen dependencies for a Result-only Candidate; this local Materialization is not publication-ready.",
      },
    });
    return;
  }
  if (command === "materialize" && subcommand === "start") {
    requireMaterializationOptions(options, { background: true });
    const result = await startMaterializationJob({
      artifactRoot: options["artifact-root"],
      request: materializationRequestFromOptions(options),
    });
    respond(options, {
      ...result,
      command: "materialize start",
      outcome: "started",
      nextAction: {
        kind: "inspect_materialization_job",
        command: result.nextActions[0],
        alternatives: result.nextActions.slice(1),
        description:
          "Read the bounded local job status first; inspect logs only when diagnostics are needed.",
      },
    });
    return;
  }
  if (command === "materialize" && subcommand === null) {
    requireMaterializationOptions(options);
    const request = materializationRequestFromOptions(options);
    const result = await materialize(request);
    respond(options, {
      ok: true,
      command,
      outcome: result.disposition,
      output: result.path,
      artifactRoot: result.artifactRoot,
      artifactPath: result.artifactPath,
      recommendedCanonicalPath: result.recommendedCanonicalPath,
      pathPolicy: result.pathPolicy,
      artifactIdentity: result.artifactIdentity,
      completeness: result.manifest.completeness,
      outputType: result.request.outputType,
      resultProcessLayer: result.request.resultProcessLayer,
      ...result.summary,
      manifest: `${result.path}/materialization-manifest.json`,
      nextAction: {
        kind: "prepare_release_intake",
        command: releaseIntakeCommand(result, options.intake),
        description:
          "Prepare an immutable Release Intake from this verified materialization and its frozen source intake.",
      },
    });
    return;
  }
  if (command === "job" && subcommand === "get") {
    requireOptions(options, ["job-id"]);
    const result = await getMaterializationJob({
      artifactRoot: options["artifact-root"],
      jobId: options["job-id"],
    });
    respond(options, {
      ...result,
      command: "job get",
      outcome: result.state,
      nextAction: {
        kind:
          result.state === "succeeded"
            ? "prepare_release_intake"
            : result.state === "running" || result.state === "queued"
              ? "inspect_materialization_job"
              : "inspect_materialization_logs",
        command: result.nextActions[0],
        alternatives: result.nextActions.slice(1),
        description:
          result.state === "succeeded"
            ? "Prepare Release Intake from the completed materialization."
            : "Continue from the same exact local job without starting a duplicate run.",
      },
    });
    return;
  }
  if (command === "job" && subcommand === "logs") {
    requireOptions(options, ["job-id"]);
    const result = await readMaterializationJobLogs({
      artifactRoot: options["artifact-root"],
      jobId: options["job-id"],
      tail:
        options.tail === undefined ? 100 : parseInteger(options.tail, "tail"),
    });
    respond(options, {
      ...result,
      command: "job logs",
      outcome: "read",
      nextAction: {
        kind: "inspect_materialization_job",
        command: `${MATERIALIZATION_COMMAND} job get --job-id ${result.jobId} --artifact-root ${shellQuote(result.artifactRoot)} --json`,
        description: "Return to the bounded status projection for this job.",
      },
    });
    return;
  }
  if (command === "job" && subcommand === "cancel") {
    requireOptions(options, ["job-id"]);
    const result = await cancelMaterializationJob({
      artifactRoot: options["artifact-root"],
      jobId: options["job-id"],
    });
    respond(options, {
      ...result,
      command: "job cancel",
      outcome: result.state,
      nextAction: {
        kind: "inspect_materialization_job",
        command: `${MATERIALIZATION_COMMAND} job get --job-id ${result.jobId} --artifact-root ${shellQuote(result.artifactRoot)} --json`,
        description: "Read the resulting state for this exact job.",
      },
    });
    return;
  }
  if (command === "materialize" || command === "job") {
    throw Object.assign(
      new Error(`Unknown ${command} action: ${subcommand ?? "<none>"}`),
      { code: "unknown_command" },
    );
  }
  throw Object.assign(new Error(`Unknown command: ${command}`), {
    code: "unknown_command",
  });
}

function requireMaterializationOptions(options, { background = false } = {}) {
  requireOptions(options, ["intake", "output-type", "result-process-layer"]);
  if (!background) requireExclusivePaths(options);
  requireSelection(options);
  if (
    Boolean(options["first-generation"]) ===
    Boolean(options["previous-manifest"])
  ) {
    throw Object.assign(
      new Error(
        "Choose exactly one of --first-generation or --previous-manifest <path>",
      ),
      { code: "version_history_choice_required" },
    );
  }
}

function materializationRequestFromOptions(options) {
  return {
    intakeDir: path.resolve(options.intake),
    outDir: options["out-dir"] ? path.resolve(options["out-dir"]) : undefined,
    artifactRoot:
      !options["out-dir"] && options["artifact-root"]
        ? path.resolve(options["artifact-root"])
        : undefined,
    processUuids: options.all ? undefined : splitSelectors(options.processes),
    outputType: options["output-type"],
    resultProcessLayer: options["result-process-layer"],
    firstGeneration: Boolean(options["first-generation"]),
    previousManifestPath: options["previous-manifest"]
      ? path.resolve(options["previous-manifest"])
      : undefined,
    resultVersionPlanPath: options["result-version-plan"]
      ? path.resolve(options["result-version-plan"])
      : undefined,
    concurrency:
      options.concurrency === undefined
        ? 2
        : parseBoundedInteger(options.concurrency, "concurrency", 1, 16),
  };
}

function requireExclusivePaths(options) {
  if (options["out-dir"] && options["artifact-root"]) {
    throw Object.assign(
      new Error("Choose either --out-dir or --artifact-root, not both"),
      { code: "invalid_arguments" },
    );
  }
}

function parseInteger(value, name) {
  if (!/^[0-9]+$/.test(String(value))) {
    throw Object.assign(new Error(`--${name} must be an integer`), {
      code: "invalid_arguments",
    });
  }
  return Number.parseInt(value, 10);
}

function parseBoundedInteger(value, name, minimum, maximum) {
  const parsed = parseInteger(value, name);
  if (parsed < minimum || parsed > maximum) {
    throw Object.assign(
      new Error(`--${name} must be an integer from ${minimum} to ${maximum}`),
      { code: "invalid_arguments" },
    );
  }
  return parsed;
}

function parseArgs(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw Object.assign(new Error(`Unexpected argument: ${token}`), {
        code: "invalid_arguments",
      });
    }
    const key = token.slice(2);
    if (["json", "first-generation", "all", "help"].includes(key))
      result[key] = true;
    else {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) {
        throw Object.assign(new Error(`Missing value for --${key}`), {
          code: "invalid_arguments",
        });
      }
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function requireSelection(options) {
  if (Boolean(options.all) === Boolean(options.processes)) {
    throw Object.assign(
      new Error(
        "Choose exactly one of --all or --processes <UUID@version,...>",
      ),
      { code: "selection_required" },
    );
  }
}

function splitSelectors(value) {
  const result = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!result.length) {
    throw Object.assign(
      new Error("--processes must contain at least one UUID@version selector"),
      { code: "selection_required" },
    );
  }
  return result;
}

function requireOptions(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length) {
    throw Object.assign(
      new Error(
        `Missing required options: ${missing.map((name) => `--${name}`).join(", ")}`,
      ),
      { code: "invalid_arguments" },
    );
  }
}

function respond(options, value) {
  attachReleaseConfiguration(value, CLI_CONFIGURATION);
  if (options.json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else {
    process.stdout.write(`✅ ${value.outcome}\n`);
    if (value.intake) process.stdout.write(`Intake: ${value.intake}\n`);
    if (value.output) process.stdout.write(`Output: ${value.output}\n`);
    if (value.jobId) process.stdout.write(`Job: ${value.jobId}\n`);
    if (value.logPath) process.stdout.write(`Log: ${value.logPath}\n`);
    if (value.lines) process.stdout.write(`${value.lines.join("\n")}\n`);
    process.stdout.write(`Next: ${value.nextAction.description}\n`);
    if (value.nextAction.command)
      process.stdout.write(`${value.nextAction.command}\n`);
  }
}

function releaseIntakeCommand(result, sourceIntake) {
  const releaseIntake = path.join(
    result.artifactRoot,
    "release",
    "intakes",
    result.artifactIdentity.materializationKeySha256,
  );
  return `${RELEASE_COMMAND} intake prepare --materialization ${shellQuote(result.path)} --source-intake ${shellQuote(path.resolve(sourceIntake))} --out-dir ${shellQuote(releaseIntake)} --json`;
}

main().catch((error) => {
  const [command, action] = CLI_CONFIGURATION?.argv ?? process.argv.slice(2);
  const route = [command, action]
    .filter((value) => value && !value.startsWith("--"))
    .join(" ");
  const payload = {
    ok: false,
    command: route || "unknown",
    outcome: "command_failed",
    error: {
      code: error.code ?? "unexpected_error",
      message: error.message,
      details: error.details ?? {},
    },
    nextActions: [
      {
        kind: "inspect_usage",
        command: `${MATERIALIZATION_COMMAND}${route ? ` ${route}` : ""} --help`,
      },
    ],
  };
  process.stderr.write(
    `${JSON.stringify(attachReleaseConfiguration(payload, CLI_CONFIGURATION))}\n`,
  );
  process.exitCode = 1;
});
