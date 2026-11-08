import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { parseEnv } from "node:util";
import { X509Certificate } from "node:crypto";
import { RELEASE_ENV_FILE, RELEASE_ROOT, TOOL_SETTINGS } from "./settings.mjs";
const fail = (code, message, details) => {
  throw Object.assign(new Error(message), { code, details });
};

const invalid = (code, setting) =>
  fail(code, "Release configuration is invalid; check the named setting", {
    setting,
  });

export async function readReleaseConfigFile(filename, maximum, setting) {
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size > maximum) throw new Error();
    const data = await readFile(filename);
    if (data.length > maximum) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    invalid("final_environment_config_file_invalid", setting);
  }
}

// Explicit files only, immutable process environment, and caller-specific keys.
// Storage inspection/preflight never touch S3/actor/reader secret properties.
export async function loadReleaseEnvironment(
  options,
  {
    env = process.env,
    cwd = process.cwd(),
    settings = [],
    defaultFile = false,
  } = {},
) {
  const environment = Object.fromEntries(
    settings
      .filter((key) => typeof env[key] === "string" && env[key].trim())
      .map((key) => [key, env[key]]),
  );
  let directory = cwd;
  let filename = options["config-env"]
    ? path.resolve(cwd, options["config-env"])
    : defaultFile === true
      ? RELEASE_ENV_FILE
      : defaultFile;
  if (filename && !options["config-env"]) {
    try {
      await stat(filename);
    } catch (error) {
      if (error.code === "ENOENT") filename = false;
      else invalid("final_environment_config_file_invalid", "config-env");
    }
  }
  const sources = Object.fromEntries(
    Object.keys(environment).map((key) => [key, "process"]),
  );
  if (filename) {
    filename = path.resolve(cwd, filename);
    directory = path.dirname(filename);
    let parsed;
    try {
      parsed = parseEnv(
        await readReleaseConfigFile(filename, 65536, "config-env"),
      );
    } catch {
      invalid("final_environment_config_file_invalid", "config-env");
    }
    for (const key of settings) {
      if (!parsed[key]?.trim()) continue;
      if (environment[key]?.trim() && environment[key] !== parsed[key])
        invalid("final_environment_conflict", key);
      environment[key] = parsed[key];
      sources[key] ??= "file";
    }
  }
  for (const key of [
    ...TOOL_SETTINGS.filter(
      (k) => k.endsWith("_BIN") || k.endsWith("_EXECUTABLE"),
    ),
    "RELEASE_DATABASE_CA_FILE",
    "RESULT_QUERY_SERVICE_SECRET_FILE",
  ]) {
    const value = environment[key];
    if (
      value &&
      (key.endsWith("_FILE") || value.includes("/") || value.includes("\\"))
    )
      environment[key] = path.resolve(directory, value);
  }
  if (!environment.TIDAS_BIN && environment.TIANGONG_TIDAS_EXECUTABLE)
    environment.TIDAS_BIN = environment.TIANGONG_TIDAS_EXECUTABLE;
  if (settings.includes("RELEASE_HDF5_BIN") && !environment.RELEASE_HDF5_BIN) {
    const built = path.join(
      RELEASE_ROOT,
      "workflows/release-candidate/native/target/debug",
      process.platform === "win32"
        ? "release-result-hdf5.exe"
        : "release-result-hdf5",
    );
    try {
      if ((await stat(built)).isFile()) {
        environment.RELEASE_HDF5_BIN = built;
        sources.RELEASE_HDF5_BIN = "project-build";
      }
    } catch {}
  }
  // Resolve TLS files identically for every PostgreSQL consumer. TLS settings
  // do not change the existing host/port/database/user target identity.
  if (environment.CONN) {
    try {
      const conn = new URL(environment.CONN);
      let changed = false;
      // pg 8.23.1 already treats these modes as verify-full. Make that
      // existing behavior explicit and keep its deprecation warning out of
      // machine-readable CLI diagnostics; never weaken certificate checks.
      if (
        ["require", "prefer", "verify-ca"].includes(
          conn.searchParams.get("sslmode"),
        )
      ) {
        conn.searchParams.set("sslmode", "verify-full");
        changed = true;
      }
      for (const key of ["sslrootcert", "sslcert", "sslkey"]) {
        if (!conn.searchParams.has(key)) continue;
        conn.searchParams.set(
          key,
          path.resolve(directory, conn.searchParams.get(key)),
        );
        changed = true;
      }
      if (environment.RELEASE_DATABASE_CA_FILE) {
        const filename = path.resolve(
          directory,
          environment.RELEASE_DATABASE_CA_FILE,
        );
        new X509Certificate(
          await readReleaseConfigFile(
            filename,
            131072,
            "RELEASE_DATABASE_CA_FILE",
          ),
        );
        if (
          conn.searchParams.has("sslrootcert") &&
          conn.searchParams.get("sslrootcert") !== filename
        )
          throw new Error();
        conn.searchParams.set("sslmode", "verify-full");
        conn.searchParams.set("sslrootcert", filename);
        changed = true;
      }
      if (changed) environment.CONN = conn.href;
    } catch (error) {
      if (error.code?.startsWith("final_environment_")) throw error;
      invalid(
        environment.RELEASE_DATABASE_CA_FILE
          ? "final_environment_database_ca_invalid"
          : "final_environment_connection_invalid",
        environment.RELEASE_DATABASE_CA_FILE
          ? "RELEASE_DATABASE_CA_FILE"
          : "CONN",
      );
    }
  } else if (environment.RELEASE_DATABASE_CA_FILE) {
    invalid("final_environment_connection_required", "CONN");
  }
  return {
    environment,
    directory,
    configuration: { file: filename || null, sources, valuesExposed: false },
  };
}
