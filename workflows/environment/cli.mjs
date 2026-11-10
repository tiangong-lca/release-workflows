#!/usr/bin/env node
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDirectEntry } from "./lib/cli-configuration.mjs";
import { checkEnvironment } from "./lib/check.mjs";
import {
  initializeConfiguration,
  syncDataPlaneEnvironment,
} from "./lib/setup.mjs";
import { PROFILES, RELEASE_ENV_FILE } from "./lib/settings.mjs";

const CLI = fileURLToPath(import.meta.url);
const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const HELP = `Release Environment Workflow

Prepare local configuration and diagnose selected capabilities before business work.

Commands:
  check  Read-only local checks; --remote adds bounded GET/HEAD/database reads
  guide  Explain configuration blockers and tool setup; never writes configuration
  init   Create a blank configuration template; requires --confirm-init
  sync   Copy missing data-plane settings from an explicit file; requires --source and --confirm-sync

Options:
  --for <local|materialization|candidate|calculation|download|storage|readiness> (default: local)
  --config-env <path>  One configuration file; defaults to repository .env if present
  --remote            Check read-only connections; does not create a user session
  --candidate <path>  With --remote and --for storage/readiness: exact Candidate/registry preflight
  --output-dir <path> Check writable ancestor and available space without creating it
  --min-free-gib <n>   Explicit minimum free disk requirement; default reports available resources
  --report <new-file> Write a private diagnostic JSON report, never overwrite
  --source <path>     Explicit source for sync; existing non-empty values are preserved
  --confirm-init / --confirm-sync  Confirm only the corresponding local config write
  --json              One bounded JSON result; blocked checks exit 1, invalid use exits 2
  --help              No configuration access, tools, network or writes

Examples (from any directory):
  node ${quote(CLI)} check --for candidate --config-env /absolute/path/.env --json
  node ${quote(CLI)} guide --for storage --config-env /absolute/path/.env --json
  node ${quote(CLI)} check --for storage --config-env /absolute/path/.env --remote --json

No check uploads objects, registers data, starts calculations or approves/activates publication.
Remote success proves only the named reads; S3 writes/size limits, numeric parity and business authorization remain unverified.
`;
const FLAGS = new Set(["json", "remote", "confirm-init", "confirm-sync"]);
const VALUES = new Set([
  "for",
  "config-env",
  "candidate",
  "output-dir",
  "min-free-gib",
  "report",
  "source",
]);
function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].startsWith("--") ? argv[i].slice(2) : "";
    if ((!FLAGS.has(key) && !VALUES.has(key)) || Object.hasOwn(options, key))
      throw new Error("Unknown or duplicate option; see --help");
    if (FLAGS.has(key)) options[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        throw new Error("Missing option value; see --help");
      options[key] = argv[++i];
    }
  }
  return options;
}
function next(args) {
  const argv = ["node", CLI, ...args];
  return { argv, command: argv.map(quote).join(" ") };
}
function guidance(report) {
  return report.checks
    .filter((c) => c.status === "blocked")
    .map((c) => ({
      check: c.id,
      ...(c.setting ? { setting: c.setting } : {}),
      action:
        c.id === "hdf5"
          ? "Run pnpm run native:build, or set RELEASE_HDF5_BIN to an existing qualified executable"
          : c.id === "tidas"
            ? "Download an official tidas release binary for this platform, verify it against that release's SHA256SUMS, set TIDAS_BIN, then rerun check"
            : c.id === "seven_zip"
              ? "Install qualified 7-Zip 26.05 and set RELEASE_7ZIP_BIN"
              : c.id === "dependencies"
                ? "Run pnpm install --frozen-lockfile"
                : c.setting
                  ? `Set ${c.setting} in the selected configuration; values must stay local`
                  : "Inspect the safe error code and configuration source, correct the condition and rerun check",
    }));
}
export async function runEnvironmentCli(
  argv,
  { stdout = process.stdout, stderr = process.stderr, ...dependencies } = {},
) {
  if (!argv.length || argv.some((v) => ["--help", "-h"].includes(v))) {
    stdout.write(HELP);
    return 0;
  }
  let options,
    phase = "arguments";
  try {
    const [action, ...tokens] = argv;
    if (tokens[0] === "--") tokens.shift();
    options = parse(tokens);
    if (!["check", "guide", "init", "sync"].includes(action))
      throw new Error("Unknown command; see --help");
    if (options.for && !Object.hasOwn(PROFILES, options.for))
      throw new Error("Unsupported capability; see --help");
    if (
      options["min-free-gib"] !== undefined &&
      (!Number.isFinite(Number(options["min-free-gib"])) ||
        Number(options["min-free-gib"]) < 0 ||
        Number(options["min-free-gib"]) > 32768)
    )
      throw new Error("--min-free-gib must be between 0 and 32768");
    const allowed = {
      check: [
        "for",
        "config-env",
        "remote",
        "candidate",
        "output-dir",
        "min-free-gib",
        "report",
        "json",
      ],
      guide: [
        "for",
        "config-env",
        "output-dir",
        "min-free-gib",
        "report",
        "json",
      ],
      init: ["config-env", "confirm-init", "json"],
      sync: ["config-env", "source", "confirm-sync", "json"],
    }[action];
    if (Object.keys(options).some((k) => !allowed.includes(k)))
      throw new Error("Option is not accepted by this action; see --help");
    if (
      ["init", "sync"].includes(action) &&
      (!options[`confirm-${action}`] || (action === "sync" && !options.source))
    )
      throw new Error(
        `Local ${action} requires --confirm-${action}${action === "sync" ? " and --source" : ""}`,
      );
    phase = "action";
    const filename = path.resolve(options["config-env"] ?? RELEASE_ENV_FILE);
    let result;
    if (action === "init" || action === "sync") {
      if (
        !options[`confirm-${action}`] ||
        (action === "sync" && !options.source)
      )
        throw new Error(
          `Local ${action} requires --confirm-${action}${action === "sync" ? " and --source" : ""}`,
        );
      const data =
        action === "init"
          ? await initializeConfiguration(filename)
          : await syncDataPlaneEnvironment({
              source: options.source,
              target: filename,
            });
      result = {
        ok: true,
        command: `environment ${action}`,
        outcome: `configuration_${action === "init" ? "initialized" : "synchronized"}`,
        data,
        nextActions: [next(["guide", "--config-env", filename, "--json"])],
      };
    } else {
      result = await checkEnvironment(options, dependencies);
      result.command = `environment ${action}`;
      result.guidance = guidance(result);
      if (result.profile === "local")
        result.nextDecision = {
          id: "choose_environment_capability",
          choices: Object.keys(PROFILES)
            .filter((name) => name !== "local")
            .map((name) => ({
              profile: name,
              ...next([
                "check",
                "--for",
                name,
                ...(result.configuration?.file
                  ? ["--config-env", result.configuration.file]
                  : []),
                "--json",
              ]),
            })),
        };
      result.nextActions = [
        next([
          "check",
          "--for",
          result.profile,
          ...(result.configuration?.file
            ? ["--config-env", result.configuration.file]
            : []),
          ...(options.remote ? ["--remote"] : []),
          ...(options.candidate
            ? ["--candidate", path.resolve(options.candidate)]
            : []),
          "--json",
        ]),
      ];

      if (result.ok) {
        const own = result.configuration?.file
          ? ["--config-env", result.configuration.file]
          : [];
        if (
          ["calculation", "download", "storage", "readiness"].includes(
            result.profile,
          ) &&
          !options.remote
        )
          result.nextActions = [
            next([
              "check",
              "--for",
              result.profile,
              ...own,
              "--remote",
              "--json",
            ]),
          ];
        else {
          const workflow = {
            materialization: "result-materialization",
            candidate: "release-candidate",
            calculation: "calculation",
            download: "calculation",
            storage: "publication",
            readiness: "publication",
          }[result.profile];
          if (workflow) {
            const argv = [
              "node",
              fileURLToPath(new URL(`../${workflow}/cli.mjs`, import.meta.url)),
              "--help",
              ...own,
            ];
            result.nextActions = [{ argv, command: argv.map(quote).join(" ") }];
          } else result.nextActions = [next(["guide", "--help"])];
        }
      } else if (action === "check")
        result.nextActions = [
          next([
            "guide",
            "--for",
            result.profile,
            ...(result.configuration?.file
              ? ["--config-env", result.configuration.file]
              : []),
            "--json",
          ]),
        ];
      if (options.report) {
        await writeFile(
          path.resolve(options.report),
          JSON.stringify(result) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        result.report = path.resolve(options.report);
      }
    }
    result.replyTemplate = {
      id: "release-environment",
      path: "workflows/environment/reply-templates/environment.md",
      format: "markdown",
      placeholderSyntax: "{{...}}",
      requiredFacts: ["command", "outcome", "nextActions"],
    };
    if (options.json) stdout.write(JSON.stringify(result) + "\n");
    else {
      stdout.write(
        `${result.ok ? "Environment check completed" : "Environment needs attention"}\n\nSummary:\n`,
      );
      if (result.configuration)
        stdout.write(
          `- Configuration: ${result.configuration.file ?? "explicit process settings only"}\n`,
        );
      for (const c of result.checks ?? [])
        stdout.write(`- ${c.status}: ${c.id} — ${c.message}\n`);
      if (result.data)
        stdout.write(`- ${result.outcome}; secret values hidden\n`);
      for (const g of result.guidance ?? [])
        stdout.write(`- Fix ${g.check}: ${g.action}\n`);
      stdout.write(`\nNext:\n- ${result.nextActions[0].command}\n`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    const code = /^final_environment_[a-z_]+$/u.test(error.code ?? "")
      ? error.code
      : phase === "arguments"
        ? "final_environment_arguments_invalid"
        : "final_environment_command_failed";
    const result = {
      ok: false,
      command: "environment",
      outcome: "environment_command_failed",
      error: {
        code,
        message:
          phase === "arguments"
            ? error.message
            : "Environment command did not complete; preserve existing configuration and inspect help",
        ...(typeof error.details?.setting === "string" &&
        [...Object.values(PROFILES).flat(), "config-env"].includes(
          error.details.setting,
        )
          ? { setting: error.details.setting }
          : {}),
      },
      nextActions: [next(["--help"])],
    };
    (options?.json ? stdout : stderr).write(JSON.stringify(result) + "\n");
    return 2;
  }
}
if (isDirectEntry(import.meta.url))
  process.exitCode = await runEnvironmentCli(process.argv.slice(2));
