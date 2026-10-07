#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildPackageCandidate,
  DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
  PACKAGE_PROFILE,
} from "./lib/package-build.mjs";
import {
  analyzeExclusionImpact,
  recordScopeDecision,
} from "./lib/exclusion-impact.mjs";
import { buildExclusionImpactReviewWorkbook } from "./lib/exclusion-review-workbook.mjs";
import {
  DEFAULT_FLOW_CACHE,
  DEFAULT_FLOW_CACHE_EXECUTION,
  inspectFlowCache,
  refreshFlowCache,
} from "./lib/flow-cache.mjs";
import { prepareReleaseIntake } from "./lib/release-intake.mjs";
import { replyTemplateFor } from "./reply-template-registry.mjs";
import { candidateNextDecision } from "./lib/next-decision.mjs";

const COMMAND = "package build";
const RELEASE_CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const RELEASE_COMMAND = `node ${shellQuote(RELEASE_CLI_PATH)}`;
const MATERIALIZATION_CLI_PATH = fileURLToPath(
  new URL("../result-materialization/cli.mjs", import.meta.url),
);
const MATERIALIZATION_COMMAND = `node ${shellQuote(MATERIALIZATION_CLI_PATH)}`;
const REPOSITORY_ENV = fileURLToPath(new URL("../../.env", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_FLOW_CACHE_DIR = path.join(REPOSITORY_ROOT, DEFAULT_FLOW_CACHE);
const VALUE_OPTIONS = new Set([
  "materialization",
  "source-intake",
  "release-intake",
  "profile",
  "release-version",
  "out-dir",
  "tidas-bin",
  "tidas-memory-budget-mib",
  "flow-cache",
  "execution",
  "remote-host",
  "failed-build",
  "issue-spool",
  "impact-report",
  "scope-decision",
  "action",
  "reason",
  "decided-by",
  "confirm-impact-sha256",
  "preview-dir",
]);
const BOOLEAN_OPTIONS = new Set(["json", "help"]);

const HELP = `release-package <command> [options]

Release Candidate workflow-local CLI. It prepares and validates immutable local Candidates; it does not publish them.

Commands:
  cache status        Check whether the shared Elementary Flow cache is usable
  cache refresh       Explicitly replace the shared cache; remote Worker EC2 execution is the default
  intake prepare      Expand exact LCIA Method Flow dependencies into an immutable Release Intake
  failure analyze     Compute the complete exclusion impact of exact validation failures
  failure review      Generate the human-review Excel workbook from one impact report
  failure decide      Record repair, hash-confirmed exclusion, or stop against one impact report
  package build       Build one local, unapproved Release Candidate from a frozen Release Intake

intake prepare options:
  --materialization <path>  Completed Result Materialization directory
  --source-intake <path>    Frozen Materialization Intake containing source_closure
  --out-dir <path>          New immutable Release Intake directory
  --flow-cache <path>       Shared Elementary Flow cache; defaults to ${DEFAULT_FLOW_CACHE}

cache options:
  --flow-cache <path>       Shared cache directory; defaults to ${DEFAULT_FLOW_CACHE}
  --execution <mode>        refresh execution: remote (default) or local
  --remote-host <host>      SSH host used by remote refresh; required unless RELEASE_FLOW_CACHE_REMOTE_HOST is set

package build options:
  --release-intake <path>   Prepared immutable Release Intake directory
  --profile <id>            ${PACKAGE_PROFILE}
  --release-version <id>    Formal database release version used in distributed filenames
  --out-dir <path>          New immutable Release Candidate directory
  --tidas-bin <path>        exact tidas v0.2.0 executable; defaults to TIDAS_BIN or PATH lookup
  --tidas-memory-budget-mib <MiB> Release-owned TIDAS budget; defaults to TIDAS_MEMORY_BUDGET_MIB or ${DEFAULT_TIDAS_MEMORY_BUDGET_MIB}
  --scope-decision <path>   Optional verified exclusion decision directory

failure analyze options:
  --failed-build <path>     Preserved failed build directory
  --release-intake <path>   Frozen Release Intake used by the failed build
  --issue-spool <path>      Explicit validation issue NDJSON when not referenced by the failed build
  --out-dir <path>          New immutable impact-analysis directory

failure decide options:
  --impact-report <path>    Exact exclusion-impact-report.json
  --action <action>         repair, exclude, or stop
  --reason <text>           Durable decision reason
  --decided-by <identity>   Human or actor identity making the decision
  --confirm-impact-sha256 <hash> Required for exclude; must match the exact report
  --out-dir <path>          New immutable scope-decision directory

failure review options:
  --impact-report <path>    Exact exclusion-impact-report.json
  --preview-dir <path>      Rendered SVG directory required for visual verification
  --out-dir <path>          New review bundle containing the Excel workbook and receipt

Common:
  --json                    Emit one bounded JSON result on stdout
  --help                    Show this help

cache refresh may upload one temporary transfer object and deletes it before local installation; it does not authorize
package upload or publication. Intake and package commands perform no upload or publication. Package build delegates closure validation,
TIDAS/eILCD validation, semantic round-trip, and deterministic ZIP creation to tidas-tools.

Examples:
  release-package cache status --json
  release-package cache refresh --json
  release-package cache refresh --execution local --json

  release-package intake prepare --materialization .release/materialization/lifecycle-model \\
    --source-intake .release/materialization/intakes/<bundle-hash> \\
    --out-dir .release/release/intakes/<release-intake-name> --json

  release-package package build --release-intake .release/release/intakes/<release-intake-name> \\
    --profile ${PACKAGE_PROFILE} --release-version 2026.08.0 \
    --out-dir .release/candidates/<candidate-name> --json

  release-package failure analyze --failed-build .release/candidates/<failed-build> \\
    --release-intake .release/release/intakes/<release-intake-name> \\
    --out-dir .release/release/impact/<analysis-name> --json

JSON results include outcome, completeness, artifact paths, nextActions, and a workflow-local replyTemplate.
Successful Candidate builds include nextDecision with Publication planning and Dataset Transformation choices.
`;

async function main() {
  const [command, action, ...tokens] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (!(
    (command === "cache" && ["status", "refresh"].includes(action)) ||
    (command === "intake" && action === "prepare") ||
    (command === "failure" &&
      ["analyze", "review", "decide"].includes(action)) ||
    (command === "package" && action === "build")
  )) {
    throw Object.assign(
      new Error(
        `Unknown command: ${[command, action].filter(Boolean).join(" ")}`,
      ),
      {
        code: "unknown_command",
      },
    );
  }
  const options = parseArgs(tokens);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const flowCacheDir = path.resolve(
    options["flow-cache"] ?? DEFAULT_FLOW_CACHE_DIR,
  );
  if (command === "cache") {
    const result =
      action === "refresh"
        ? await refreshFlowCache({
            cacheDir: flowCacheDir,
            execution: options.execution ?? DEFAULT_FLOW_CACHE_EXECUTION,
            remoteHost: options["remote-host"],
          })
        : await inspectFlowCache({ cacheDir: flowCacheDir });
    respondCache(options, action, result, flowCacheDir);
    return;
  }
  if (command === "intake") {
    requireOptions(options, ["materialization", "source-intake", "out-dir"]);
    const result = await prepareReleaseIntake({
      materializationDir: path.resolve(options.materialization),
      sourceIntakeDir: path.resolve(options["source-intake"]),
      outDir: path.resolve(options["out-dir"]),
      flowCacheDir,
    });
    respondIntake(options, result);
    return;
  }
  if (command === "failure" && action === "analyze") {
    requireOptions(options, ["failed-build", "release-intake", "out-dir"]);
    const result = await analyzeExclusionImpact({
      failedBuildDir: path.resolve(options["failed-build"]),
      releaseIntakeDir: path.resolve(options["release-intake"]),
      outDir: path.resolve(options["out-dir"]),
      issueSpoolPath: options["issue-spool"]
        ? path.resolve(options["issue-spool"])
        : undefined,
    });
    respondImpact(options, result);
    return;
  }
  if (command === "failure" && action === "decide") {
    requireOptions(options, [
      "impact-report",
      "action",
      "reason",
      "decided-by",
      "out-dir",
    ]);
    const result = await recordScopeDecision({
      impactReportPath: path.resolve(options["impact-report"]),
      outDir: path.resolve(options["out-dir"]),
      action: options.action,
      reason: options.reason,
      decidedBy: options["decided-by"],
      confirmImpactSha256: options["confirm-impact-sha256"],
    });
    respondDecision(options, result);
    return;
  }
  if (command === "failure" && action === "review") {
    requireOptions(options, ["impact-report", "preview-dir", "out-dir"]);
    const result = await buildExclusionImpactReviewWorkbook({
      impactReportPath: path.resolve(options["impact-report"]),
      outDir: path.resolve(options["out-dir"]),
      previewDir: options["preview-dir"]
        ? path.resolve(options["preview-dir"])
        : undefined,
    });
    respondImpactReview(options, result);
    return;
  }
  requireOptions(options, ["release-intake", "profile", "out-dir"]);
  if (options.profile !== PACKAGE_PROFILE) {
    throw Object.assign(
      new Error(
        `Unsupported profile: ${options.profile}; expected ${PACKAGE_PROFILE}`,
      ),
      { code: "unsupported_package_profile" },
    );
  }
  if (!options["release-version"]) {
    respondVersionConfirmation(options);
    return;
  }
  const result = await buildPackageCandidate({
    releaseIntakeDir: path.resolve(options["release-intake"]),
    outDir: path.resolve(options["out-dir"]),
    tidasBin: options["tidas-bin"],
    tidasMemoryBudgetMiB: options["tidas-memory-budget-mib"],
    releaseVersion: options["release-version"],
    scopeDecisionDir: options["scope-decision"]
      ? path.resolve(options["scope-decision"])
      : undefined,
  });
  const candidateManifest = path.join(result.path, "release-candidate.json");
  respond(options, {
    ok: true,
    command: COMMAND,
    outcome: "candidate_built",
    completeness: "full-closure-and-archives-validated",
    profile: result.candidate.profile,
    releaseVersion: result.candidate.releaseVersion,
    candidate: result.path,
    packageCount: result.candidate.packages.length,
    packageSetHash: result.candidate.packageSetHash,
    tidasMemoryBudgetMiB: Number(
      options["tidas-memory-budget-mib"] ??
        process.env.TIDAS_MEMORY_BUDGET_MIB ??
        DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
    ),
    publicationAuthorized: false,
    artifacts: {
      releaseCandidate: candidateManifest,
      packagePlan: path.join(result.path, "package-plan.json"),
      canonicalDatasetIndex: path.join(
        result.path,
        "canonical-dataset-index.json",
      ),
      publicationCatalog: path.join(result.path, "publication-catalog.json"),
      tidasReport: path.join(result.path, "tidas-release-report.json"),
      packageVerification: path.join(
        result.path,
        "package-verification-report.json",
      ),
      packagesDirectory: path.join(result.path, "packages"),
      scopeDecision: options["scope-decision"]
        ? path.resolve(options["scope-decision"])
        : undefined,
    },
    nextDecision: candidateNextDecision(),
    nextActions: [
      {
        kind: "inspect_candidate",
        description:
          "Review the frozen candidate manifest before any separate approval or publication action.",
        command: `jq . ${shellQuote(candidateManifest)}`,
        argv: ["jq", ".", candidateManifest],
      },
    ],
    replyTemplate: replyTemplateFor(COMMAND, { ok: true }),
  });
}

function respondCache(options, action, result, cacheDir) {
  const status = action === "refresh" ? "fresh" : result.status;
  const needsRefresh = status !== "fresh";
  const payload = {
    ok: true,
    command: `cache ${action}`,
    outcome:
      action === "refresh"
        ? "elementary_flow_cache_refreshed"
        : `elementary_flow_cache_${status}`,
    completeness: needsRefresh ? "refresh_required" : "ready",
    cache: cacheDir,
    status,
    execution: result.execution,
    remoteHost: result.remoteHost,
    recordCount: result.manifest?.artifact?.recordCount ?? 0,
    databaseWatermark: result.database ?? result.manifest?.databaseWatermark,
    nextActions: needsRefresh
      ? [
          {
            kind: "refresh_cache",
            description:
              "Refresh the shared cache explicitly before preparing Release Intake.",
            command: `${RELEASE_COMMAND} cache refresh --flow-cache ${shellQuote(cacheDir)} --json`,
          },
        ]
      : [
          {
            kind: "prepare_release_intake",
            description:
              "Prepare Release Intake using this fresh shared cache.",
            command: `${RELEASE_COMMAND} intake prepare --help`,
          },
        ],
    replyTemplate: replyTemplateFor(`cache ${action}`, { ok: true }),
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else
    process.stdout.write(
      `Elementary Flow cache: ${status}\n- Path: ${cacheDir}\n- Records: ${payload.recordCount}${payload.execution ? `\n- Execution: ${payload.execution}` : ""}${payload.remoteHost ? `\n- Remote host: ${payload.remoteHost}` : ""}\n\nNext:\n- ${payload.nextActions[0].command}\n\nReply using template:\n- ${payload.replyTemplate.path}\n`,
    );
}

function respondVersionConfirmation(options) {
  const recommendedVersion = recommendedReleaseVersion();
  const fileNames = [
    "UnitProcessDatabase.tidas.zip",
    "UnitProcessDatabase.ilcd.zip",
    "ResultDatabase.tidas.zip",
    "ResultDatabase.ilcd.zip",
  ].map((suffix) => `TiangongLCA-${recommendedVersion}-${suffix}`);
  const argv = [
    "node",
    RELEASE_CLI_PATH,
    "package",
    "build",
    "--release-intake",
    path.resolve(options["release-intake"]),
    "--profile",
    options.profile,
    "--release-version",
    recommendedVersion,
    "--out-dir",
    path.resolve(options["out-dir"]),
  ];
  if (options["tidas-bin"])
    argv.push("--tidas-bin", path.resolve(options["tidas-bin"]));
  if (options["tidas-memory-budget-mib"])
    argv.push("--tidas-memory-budget-mib", options["tidas-memory-budget-mib"]);
  if (options["scope-decision"])
    argv.push("--scope-decision", path.resolve(options["scope-decision"]));
  argv.push("--json");
  const payload = {
    ok: true,
    command: COMMAND,
    outcome: "release_version_confirmation_required",
    completeness: "awaiting_user_confirmation",
    recommendedVersion,
    fileNames,
    nextActions: [
      {
        kind: "confirm_release_version",
        description:
          "Ask the user to confirm or replace the recommended release version before building.",
        command: argv.map(shellQuote).join(" "),
        argv,
      },
    ],
    replyTemplate: replyTemplateFor(COMMAND, {
      outcome: "release_version_confirmation_required",
    }),
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else {
    process.stdout.write(`Release version confirmation required\n\nSummary:\n`);
    process.stdout.write(`- Recommended version: ${recommendedVersion}\n`);
    for (const fileName of fileNames) process.stdout.write(`- ${fileName}\n`);
    process.stdout.write(
      `\nNext:\n- Ask the user to confirm or replace this version.\n\n`,
    );
    process.stdout.write(
      `Reply using template:\n- ${payload.replyTemplate.path}\n`,
    );
  }
}

function respondIntake(options, result) {
  const manifest = path.join(result.path, "release-intake-manifest.json");
  const candidateDir = path.join(
    REPOSITORY_ROOT,
    ".release",
    "candidates",
    path.basename(result.path),
  );
  const payload = {
    ok: true,
    command: "intake prepare",
    outcome: "release_intake_prepared",
    completeness: "exact-lcia-method-flow-dependencies-expanded",
    releaseIntake: result.path,
    addedExactFlowCount: result.report.addedExactFlowCount,
    uniqueReferenceCount: result.report.uniqueReferenceCount,
    elementaryFlowCacheRecordCount:
      result.report.elementaryFlowCacheRecordCount,
    artifacts: {
      releaseIntakeManifest: manifest,
      dependencyExpansionReport: path.join(
        result.path,
        "dependency-expansion-report.json",
      ),
    },
    nextActions: [
      {
        kind: "build_candidate",
        description:
          "Use this frozen Release Intake to confirm a version and build the candidate.",
        command: `${RELEASE_COMMAND} package build --release-intake ${shellQuote(result.path)} --profile ${PACKAGE_PROFILE} --out-dir ${shellQuote(candidateDir)} --json`,
      },
    ],
    replyTemplate: replyTemplateFor("intake prepare", { ok: true }),
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else
    process.stdout.write(
      `Release Intake prepared\n\nSummary:\n- Path: ${result.path}\n- Added exact Flows: ${result.report.addedExactFlowCount}\n\nNext:\n- ${payload.nextActions[0].command}\n\nReply using template:\n- ${payload.replyTemplate.path}\n`,
    );
}

function respondImpact(options, result) {
  const reportPath = path.join(result.path, "exclusion-impact-report.json");
  const reviewBase = `${result.path}-review`;
  const payload = {
    ok: true,
    command: "failure analyze",
    outcome: "exclusion_impact_analyzed",
    completeness: "awaiting_human_review_workbook",
    publicationAuthorized: false,
    impactReport: reportPath,
    impactReportSha256: result.reportSha256,
    invalidDatasetCount: result.report.validationIssues.invalidDatasets.length,
    affectedRootCount: result.report.impact.affectedProcessRoots.length,
    excludedDatasetCount: result.report.impact.excludedCanonicalDatasets.length,
    safeToExclude: result.report.impact.safeToExclude,
    reviewWorkbookRequired: true,
    nextActions: [
      {
        kind: "build_human_review_workbook",
        recommended: true,
        description:
          "Use the Release-owned spreadsheet runtime to render and visually verify the complete review workbook before asking for a scope decision.",
        command: `${RELEASE_COMMAND} failure review --impact-report ${shellQuote(reportPath)} --preview-dir ${shellQuote(`${reviewBase}-previews`)} --out-dir ${shellQuote(reviewBase)} --json`,
      },
    ],
    replyTemplate: replyTemplateFor("failure analyze", { ok: true }),
  };
  respondGeneric(options, payload, "Release exclusion impact analyzed");
}

function respondImpactReview(options, result) {
  if (result.receipt.verification.visualPreviewSheetCount !== 7)
    throw Object.assign(
      new Error("All seven review workbook sheets must be rendered"),
      { code: "review_workbook_visual_verification_incomplete" },
    );
  const effectiveReportPath = result.impactReportPath;
  const decisionBase = `${result.path}-decision`;
  const model = result.model;
  const payload = {
    ok: true,
    command: "failure review",
    outcome: model.safeToExclude
      ? "exclusion_review_ready"
      : "exclusion_review_blocked",
    completeness: model.status,
    publicationAuthorized: false,
    impactReport: effectiveReportPath,
    impactReportSha256: result.sourceReportSha256,
    reviewWorkbook: result.workbookPath,
    reviewWorkbookSha256: result.receipt.workbook.sha256,
    reviewReceipt: result.receiptPath,
    reviewPreviews: result.previewDir,
    invalidDatasetCount: model.invalidData.rows.length,
    affectedRootCount: model.affectedRoots.rows.length,
    affectedMaterializedDatasetCount: model.derivedData.rows.length,
    newlyUnreachableSupportDatasetCount: model.unreachableSupport.rows.length,
    excludedDatasetCount: model.completeExclusionSet.rows.length,
    originalDatasetCount: model.originalDatasetCount,
    resultingDatasetCount: model.resultingDatasetCount,
    remainingReferenceConflictCount: model.referenceConflicts.rows.length,
    excludedSetHash: model.excludedSetHash,
    safeToExclude: model.safeToExclude,
    choices: [
      {
        action: "repair",
        recommended: true,
        allowed: true,
        description: "Repair or reselect exact upstream versions.",
      },
      {
        action: "exclude",
        recommended: false,
        allowed: model.safeToExclude,
        description:
          "Confirm the complete exclusion set shown in the workbook and bind the decision to the exact impact-report hash.",
      },
      {
        action: "stop",
        recommended: false,
        allowed: true,
        description: "Keep the failed build and stop this release attempt.",
      },
    ],
    nextActions: [
      {
        kind: "repair_upstream_scope",
        recommended: true,
        command: `${MATERIALIZATION_COMMAND} materialize --help`,
      },
      ...(model.safeToExclude
        ? [
            {
              kind: "confirm_complete_exclusion",
              recommended: false,
              command: `${RELEASE_COMMAND} failure decide --impact-report ${shellQuote(effectiveReportPath)} --action exclude --reason <REASON> --decided-by <IDENTITY> --confirm-impact-sha256 ${result.sourceReportSha256} --out-dir ${shellQuote(`${decisionBase}-exclude`)} --json`,
            },
          ]
        : []),
      {
        kind: "stop_release_attempt",
        recommended: false,
        command: `${RELEASE_COMMAND} failure decide --impact-report ${shellQuote(effectiveReportPath)} --action stop --reason <REASON> --decided-by <IDENTITY> --out-dir ${shellQuote(`${decisionBase}-stop`)} --json`,
      },
    ],
    replyTemplate: replyTemplateFor("failure review", { ok: true }),
  };
  respondGeneric(options, payload, "Release exclusion impact review ready");
}

function respondDecision(options, result) {
  const decisionPath = path.join(result.path, "release-scope-decision.json");
  const candidateDir = path.join(
    REPOSITORY_ROOT,
    ".release",
    "candidates",
    path.basename(result.path),
  );
  const nextActions =
    result.decision.action === "exclude"
      ? [
          {
            kind: "build_scope_filtered_candidate",
            description:
              "Build a new candidate from the confirmed scope and rerun every package validator.",
            command: `${RELEASE_COMMAND} package build --release-intake ${shellQuote(result.locators.releaseIntakeDir)} --profile ${PACKAGE_PROFILE} --scope-decision ${shellQuote(result.path)} --out-dir ${shellQuote(candidateDir)} --json`,
          },
        ]
      : result.decision.action === "repair"
        ? [
            {
              kind: "repair_upstream_scope",
              description:
                "Return to exact upstream scope/version repair before creating a new candidate.",
              command: `${MATERIALIZATION_COMMAND} materialize --help`,
            },
          ]
        : [
            {
              kind: "inspect_failed_build",
              description:
                "Keep the failed build and decision evidence; do not create a Candidate.",
              command: `jq . ${shellQuote(decisionPath)}`,
            },
          ];
  const payload = {
    ok: true,
    command: "failure decide",
    outcome: `release_scope_${result.decision.action}_recorded`,
    completeness:
      result.decision.action === "exclude"
        ? "scope_confirmed_candidate_not_built"
        : "release_attempt_not_resumed",
    publicationAuthorized: false,
    action: result.decision.action,
    decidedAt: result.decision.decidedAt,
    decidedBy: result.decision.decidedBy,
    scopeDecision: result.path,
    scopeDecisionSha256: result.decisionSha256,
    artifacts: {
      releaseScopeDecision: decisionPath,
      exclusionImpactReport: path.join(
        result.path,
        "exclusion-impact-report.json",
      ),
    },
    nextActions,
    replyTemplate: replyTemplateFor("failure decide", { ok: true }),
  };
  respondGeneric(options, payload, "Release scope decision recorded");
}

function respondGeneric(options, payload, title) {
  if (options.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else {
    process.stdout.write(`${title}\n\nSummary:\n`);
    process.stdout.write(`- Outcome: ${payload.outcome}\n`);
    process.stdout.write("- Publication authorized: no\n\nNext:\n");
    for (const action of payload.nextActions)
      process.stdout.write(`- ${action.command}\n`);
    process.stdout.write("\nReply using template:\n");
    process.stdout.write(`- ${payload.replyTemplate.path}\n`);
  }
}

function recommendedReleaseVersion(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${value.year}.${value.month}.0`;
}

function parseArgs(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--"))
      throw Object.assign(new Error(`Unexpected argument: ${token}`), {
        code: "invalid_arguments",
      });
    const key = token.slice(2);
    if (!VALUE_OPTIONS.has(key) && !BOOLEAN_OPTIONS.has(key))
      throw Object.assign(new Error(`Unknown option: --${key}`), {
        code: "unknown_option",
        details: { option: `--${key}` },
      });
    if (Object.hasOwn(result, key))
      throw Object.assign(new Error(`Duplicate option: --${key}`), {
        code: "duplicate_option",
        details: { option: `--${key}` },
      });
    if (BOOLEAN_OPTIONS.has(key)) result[key] = true;
    else {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--"))
        throw Object.assign(new Error(`Missing value for --${key}`), {
          code: "invalid_arguments",
        });
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function requireOptions(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length)
    throw Object.assign(
      new Error(
        `Missing required options: ${missing.map((name) => `--${name}`).join(", ")}`,
      ),
      { code: "invalid_arguments" },
    );
}

function respond(options, value) {
  if (options.json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else {
    process.stdout.write(`Release Candidate built\n\nSummary:\n`);
    process.stdout.write(`- Candidate: ${value.candidate}\n`);
    process.stdout.write(`- Profile: ${value.profile}\n`);
    process.stdout.write(`- Packages: ${value.packageCount}\n`);
    process.stdout.write(`- Package set SHA-256: ${value.packageSetHash}\n`);
    process.stdout.write(`- Publication authorized: no\n\nNext:\n`);
    process.stdout.write(`- ${value.nextActions[0].command}\n\n`);
    process.stdout.write("Choose one Candidate path:\n");
    for (const choice of value.nextDecision.choices)
      process.stdout.write(`- ${choice.label}: ${choice.description}\n`);
    process.stdout.write("\n");
    process.stdout.write(`Reply using template:\n`);
    process.stdout.write(`- ${value.replyTemplate.path}\n`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function failureNextActions(error) {
  if (error.code === "tidas_memory_budget_exceeded") {
    const retained = error.details?.retainedBuild;
    const selectedBudget = Number(
      error.details?.memoryBudgetMiB ?? DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
    );
    const recommendedBudget = Math.max(
      DEFAULT_TIDAS_MEMORY_BUDGET_MIB,
      selectedBudget * 2,
    );
    const retryArgv = [
      "node",
      RELEASE_CLI_PATH,
      "package",
      "build",
      "--release-intake",
      error.details.releaseIntakeDir,
      "--profile",
      PACKAGE_PROFILE,
      "--release-version",
      error.details.releaseVersion,
      "--out-dir",
      error.details.requestedCandidatePath,
      "--tidas-memory-budget-mib",
      String(recommendedBudget),
    ];
    if (error.details.tidasBin && error.details.tidasBin !== "tidas")
      retryArgv.push("--tidas-bin", error.details.tidasBin);
    if (error.details.scopeDecisionDir)
      retryArgv.push("--scope-decision", error.details.scopeDecisionDir);
    retryArgv.push("--json");
    return [
      ...(retained?.manifest
        ? [
            {
              kind: "inspect_failed_build",
              description:
                "Inspect the preserved resource failure before retrying.",
              command: `jq . ${shellQuote(retained.manifest)}`,
              argv: ["jq", ".", retained.manifest],
            },
          ]
        : []),
      {
        kind: "retry_with_larger_tidas_memory_budget",
        recommended: true,
        description: `Retry the same immutable inputs with ${recommendedBudget} MiB; no exclusion analysis is required for this resource failure.`,
        command: retryArgv.map(shellQuote).join(" "),
        argv: retryArgv,
      },
      ...(retained
        ? [
            {
              kind: "inspect_retained_artifacts",
              description:
                "List the exact reports retained from the failed resource-bound run.",
              command: `find ${shellQuote(retained.path)} -maxdepth 3 -type f -print`,
              argv: [
                "find",
                retained.path,
                "-maxdepth",
                "3",
                "-type",
                "f",
                "-print",
              ],
            },
          ]
        : []),
    ];
  }
  if (error.details?.retainedBuild) {
    const retained = error.details.retainedBuild;
    const actions = [];
    if (retained.manifest)
      actions.push({
        kind: "inspect_failed_build",
        description:
          "Inspect the preserved failure manifest before changing source data or retrying the build.",
        command: `jq . ${shellQuote(retained.manifest)}`,
        argv: ["jq", ".", retained.manifest],
      });
    if (error.details?.releaseIntakeDir)
      actions.push({
        kind: "analyze_exclusion_impact",
        description:
          "Analyze the complete affected root and dependency set before considering any exclusion.",
        command: `${RELEASE_COMMAND} failure analyze --failed-build ${shellQuote(retained.path)} --release-intake ${shellQuote(error.details.releaseIntakeDir)} --out-dir ${shellQuote(`${retained.path}.impact`)} --json`,
      });
    actions.push({
      kind: "inspect_retained_artifacts",
      description:
        "List the exact packages, reports, and readback evidence retained from this failed run.",
      command: `find ${shellQuote(retained.path)} -maxdepth 3 -type f -print`,
      argv: ["find", retained.path, "-maxdepth", "3", "-type", "f", "-print"],
    });
    return actions;
  }
  if (String(error.code).startsWith("elementary_flow_cache_"))
    return [
      {
        kind: "refresh_cache",
        description:
          "Inspect and explicitly refresh the shared Elementary Flow cache before retrying.",
        command: `${RELEASE_COMMAND} cache refresh --flow-cache ${shellQuote(error.details?.cacheDir ?? DEFAULT_FLOW_CACHE_DIR)} --json`,
      },
    ];
  if (String(error.code).startsWith("flow_cache_remote_"))
    return [
      {
        kind: "retry_remote_cache_refresh",
        description:
          "Correct the remote host, SSH, dependency, or Storage failure and retry the default refresh path.",
        command: `${RELEASE_COMMAND} cache refresh --flow-cache ${shellQuote(error.details?.cacheDir ?? DEFAULT_FLOW_CACHE_DIR)} --json`,
      },
      {
        kind: "use_local_cache_refresh",
        description:
          "Use the slow direct database route only when the remote path cannot be restored.",
        command: `${RELEASE_COMMAND} cache refresh --execution local --flow-cache ${shellQuote(error.details?.cacheDir ?? DEFAULT_FLOW_CACHE_DIR)} --json`,
      },
    ];
  if (String(error.code).startsWith("release_intake_"))
    return [
      {
        kind: "inspect_release_intake",
        description:
          "Inspect the exact dependency failure and rerun Release Intake preparation.",
        command: `${RELEASE_COMMAND} intake prepare --help`,
      },
    ];
  if (error.code === "tidas_executable_missing")
    return [
      {
        kind: "configure_dependency",
        description: "Configure the tidas executable and rerun the command.",
        command: "export TIDAS_BIN=/absolute/path/to/tidas",
      },
    ];
  if (
    error.code === "materialized_dataset_hash_mismatch" ||
    String(error.code).includes("hash_mismatch")
  )
    return [
      {
        kind: "return_to_materialization",
        description:
          "Inspect the frozen materialization evidence and regenerate it if the source bytes intentionally changed.",
        command: `${MATERIALIZATION_COMMAND} materialize --help`,
      },
    ];
  return [
    {
      kind: "inspect_usage",
      description: "Inspect supported inputs and retry with corrected options.",
      command: `${RELEASE_COMMAND} ${
        error.code === "tidas_package_build_failed"
          ? "package build --help"
          : "--help"
      }`,
    },
  ];
}

if (existsSync(REPOSITORY_ENV)) loadEnvFile(REPOSITORY_ENV);

main().catch((error) => {
  const command = process.argv.slice(2, 4).join(" ") || COMMAND;
  const retainedBuild = error.details?.retainedBuild;
  const payload = {
    ok: false,
    command,
    outcome:
      retainedBuild?.status === "qualification_failed"
        ? "packages_built_qualification_failed"
        : retainedBuild
          ? "package_build_failed_artifacts_retained"
          : "command_failed",
    completeness: retainedBuild
      ? "diagnostic_artifacts_retained"
      : "not_completed",
    publicationAuthorized: false,
    error: {
      code: error.code ?? "unexpected_error",
      message: error.message,
      details: error.details ?? {},
    },
    artifacts: retainedBuild
      ? {
          failedBuild: retainedBuild.path,
          failureManifest: retainedBuild.manifest,
          packagesDirectory: retainedBuild.packagesDirectory,
          validationReadbackDirectory:
            retainedBuild.validationReadbackDirectory,
        }
      : undefined,
    nextActions: failureNextActions(error),
    replyTemplate: replyTemplateFor(command, {
      ok: false,
      errorCode: error.code,
      retainedBuild: Boolean(retainedBuild),
    }),
  };
  if (process.argv.includes("--json"))
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  else {
    process.stderr.write(`Release command failed\n\nSummary:\n`);
    process.stderr.write(`- Command: ${payload.command}\n`);
    process.stderr.write(`- Error: ${payload.error.code}\n`);
    process.stderr.write(`- Reason: ${payload.error.message}\n`);
    if (retainedBuild) {
      process.stderr.write(
        `- Generated packages retained: ${retainedBuild.packageCount}\n`,
      );
      process.stderr.write(`- Failed build: ${retainedBuild.path}\n`);
      process.stderr.write(`- Publication authorized: no\n`);
    }
    process.stderr.write(`\nNext:\n`);
    for (const action of payload.nextActions)
      process.stderr.write(`- ${action.command}\n`);
    process.stderr.write(`\n`);
    process.stderr.write(`Reply using template:\n`);
    process.stderr.write(`- ${payload.replyTemplate.path}\n`);
  }
  process.exitCode = 1;
});
