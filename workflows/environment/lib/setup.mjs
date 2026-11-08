import path from "node:path";
import {
  readFile,
  writeFile,
  rename,
  rm,
  mkdir,
  stat,
  lstat,
} from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  loadReleaseEnvironment,
  readReleaseConfigFile,
} from "./configuration.mjs";
import { DATA_PLANE_SETTINGS, RELEASE_ROOT } from "./settings.mjs";

export class EnvironmentBootstrapError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EnvironmentBootstrapError";
    this.code = code;
    this.details = details;
  }
}
export async function initializeConfiguration(filename) {
  await mkdir(path.dirname(filename), { recursive: true });
  try {
    await writeFile(
      filename,
      await readFile(path.join(RELEASE_ROOT, ".env.example")),
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    throw new EnvironmentBootstrapError(
      "final_environment_init_refused",
      "Configuration was not created; choose a new file and preserve existing configuration",
    );
  }
  return { created: true, valuesExposed: false };
}
function encodedSetting(key, value) {
  for (const candidate of [`"${value}"`, `'${value}'`, value]) {
    const line = `${key}=${candidate}`;
    if (parseEnv(line)[key] === value) return line;
  }
  throw new EnvironmentBootstrapError(
    "final_environment_sync_value_invalid",
    "A setting cannot be safely written in .env syntax",
    { setting: key },
  );
}
export async function syncDataPlaneEnvironment({ source, target }) {
  source = path.resolve(source);
  target = path.resolve(target);
  if (source === target)
    throw new EnvironmentBootstrapError(
      "invalid_request",
      "Source and target configuration files must differ",
    );
  const { environment: sourceValues } = await loadReleaseEnvironment(
    { "config-env": source },
    { env: {}, settings: DATA_PLANE_SETTINGS },
  );
  let original;
  try {
    if ((await lstat(target)).isSymbolicLink())
      throw new EnvironmentBootstrapError(
        "final_environment_sync_target_invalid",
        "Select the actual configuration file; synchronization does not replace symbolic links",
      );
    original = await readReleaseConfigFile(target, 65536, "config-env");
  } catch (error) {
    // Only a genuinely absent target can be created. Unreadable, invalid or
    // oversized existing files are never treated as an empty configuration.
    try {
      await stat(target);
      throw error;
    } catch (cause) {
      if (cause.code !== "ENOENT") throw error;
    }
  }
  const targetValues = parseEnv(original ?? "");
  const copiedKeys = [],
    preservedKeys = [],
    missingSourceKeys = [],
    skippedKeys = [],
    additions = [];
  for (const key of DATA_PLANE_SETTINGS) {
    if (targetValues[key]?.trim()) {
      preservedKeys.push(key);
      continue;
    }
    if (!sourceValues[key]?.trim()) {
      if (
        [
          "CONN",
          "S3_ENDPOINT",
          "S3_REGION",
          "S3_BUCKET",
          "S3_ACCESS_KEY_ID",
          "S3_SECRET_ACCESS_KEY",
        ].includes(key)
      )
        missingSourceKeys.push(key);
      continue;
    }
    if (
      key === "RELEASE_DATABASE_CA_FILE" &&
      targetValues.CONN?.trim() &&
      targetValues.CONN !== sourceValues.CONN
    ) {
      skippedKeys.push(key);
      continue;
    }
    additions.push(encodedSetting(key, sourceValues[key]));
    copiedKeys.push(key);
  }
  if (additions.length) {
    const next = `${original ?? ""}${original && !original.endsWith("\n") ? "\n" : ""}# Release data-plane environment (local and ignored)\n${additions.join("\n")}\n`;
    if (Buffer.byteLength(next) > 65536)
      throw new EnvironmentBootstrapError(
        "final_environment_sync_size",
        "Configuration exceeds the bounded file size",
      );
    if (original === undefined)
      await writeFile(target, next, { flag: "wx", mode: 0o600 });
    else {
      const temporary = `${target}.environment-${process.pid}-${Date.now()}`;
      try {
        await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
        if (
          (await readReleaseConfigFile(target, 65536, "config-env")) !==
          original
        )
          throw new EnvironmentBootstrapError(
            "final_environment_sync_changed",
            "Configuration changed during synchronization; inspect and retry",
          );
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  return {
    source,
    target,
    copiedKeys,
    preservedKeys,
    missingSourceKeys,
    skippedKeys,
    valuesExposed: false,
  };
}
