import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { loadReleaseEnvironment } from "./configuration.mjs";
import { settingsForCommand } from "./settings.mjs";

const CLI_PATHS = [
  "calculation",
  "result-materialization",
  "release-candidate",
  "dataset-transformation",
  "publication",
  "environment",
].map((name) =>
  fileURLToPath(new URL(`../../${name}/cli.mjs`, import.meta.url)),
);
const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;

export function isDirectEntry(moduleUrl) {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === fileURLToPath(moduleUrl)
    );
  } catch {
    return false;
  }
}

// CLI-only bootstrap: the pure loader never changes its caller. A standalone
// command installs only its own declared settings into its current process so
// existing local tools/background children use those same effective values.
export async function configureReleaseCli(
  workflow,
  argv,
  { env = process.env, defaultFile = true } = {},
) {
  if (argv.some((value) => ["--help", "-h"].includes(value)) || !argv.length)
    return { argv, configuration: null };
  const tokens = [],
    options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--config-env") {
      tokens.push(argv[i]);
      continue;
    }
    if (options["config-env"] || !argv[i + 1] || argv[i + 1].startsWith("--"))
      throw Object.assign(
        new Error("--config-env requires exactly one file path"),
        { code: "final_environment_arguments_invalid" },
      );
    options["config-env"] = argv[++i];
  }
  const loaded = await loadReleaseEnvironment(options, {
    env,
    settings: settingsForCommand(workflow, tokens),
    defaultFile,
  });
  Object.assign(env, loaded.environment);
  return { argv: tokens, configuration: loaded.configuration };
}

// Every generated Release continuation carries an explicitly selected file.
// External tool/worker commands and arbitrary data strings are left untouched.
export function attachReleaseConfiguration(payload, context) {
  if (!context?.configuration) return payload;
  const filename = context.configuration.file;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (
      filename &&
      Array.isArray(value.argv) &&
      value.argv[0] === "node" &&
      CLI_PATHS.includes(value.argv[1]) &&
      !value.argv.includes("--config-env")
    ) {
      value.argv.push("--config-env", filename);
      if (typeof value.command === "string")
        value.command = value.argv.map(quote).join(" ");
    } else if (
      filename &&
      typeof value.command === "string" &&
      CLI_PATHS.some((cli) => value.command.includes(cli)) &&
      !value.command.includes("--config-env")
    )
      value.command += ` --config-env ${quote(filename)}`;
    for (const [key, child] of Object.entries(value)) {
      if (key === "nextActions" && Array.isArray(child)) {
        for (let i = 0; i < child.length; i++)
          if (
            typeof child[i] === "string" &&
            filename &&
            CLI_PATHS.some((cli) => child[i].includes(cli)) &&
            !child[i].includes("--config-env")
          )
            child[i] += ` --config-env ${quote(filename)}`;
      }
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(payload);
  payload.configuration = context.configuration;
  return payload;
}
