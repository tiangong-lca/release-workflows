import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { parseEnv } from "node:util";
import { X509Certificate } from "node:crypto";
import { fail } from "./common.mjs";

export const PUBLICATION_STORAGE_SETTINGS = [
  "CONN",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_PREFIX",
  "RELEASE_DATABASE_CA_FILE",
  "RELEASE_7ZIP_BIN",
];
export const PUBLICATION_STORAGE_CREDENTIALS = [
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_SESSION_TOKEN",
];
const invalid = (code, setting) =>
  fail(code, "Publication configuration is invalid; check the named setting", {
    setting,
  });

export async function readPublicationConfigFile(filename, maximum, setting) {
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size > maximum) throw new Error();
    const data = await readFile(filename);
    if (data.length > maximum) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    invalid("final_publication_config_file_invalid", setting);
  }
}

// Explicit files only, immutable process environment, and caller-specific keys.
// Storage inspection/preflight never touch S3/actor/reader secret properties.
export async function preparePublicationEnvironment(
  options,
  {
    env = process.env,
    cwd = process.cwd(),
    settings = PUBLICATION_STORAGE_SETTINGS,
  } = {},
) {
  const environment = Object.fromEntries(
    settings
      .filter((key) => typeof env[key] === "string" && env[key].trim())
      .map((key) => [key, env[key]]),
  );
  let directory = cwd;
  if (options["config-env"]) {
    const filename = path.resolve(cwd, options["config-env"]);
    directory = path.dirname(filename);
    let parsed;
    try {
      parsed = parseEnv(
        await readPublicationConfigFile(filename, 65536, "config-env"),
      );
    } catch {
      invalid("final_publication_config_file_invalid", "config-env");
    }
    for (const key of settings) {
      if (!parsed[key]?.trim()) continue;
      if (environment[key]?.trim() && environment[key] !== parsed[key])
        invalid("final_publication_environment_conflict", key);
      environment[key] = parsed[key];
    }
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
          await readPublicationConfigFile(
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
      if (error.code?.startsWith("final_publication_")) throw error;
      invalid(
        environment.RELEASE_DATABASE_CA_FILE
          ? "final_publication_database_ca_invalid"
          : "final_publication_connection_invalid",
        environment.RELEASE_DATABASE_CA_FILE
          ? "RELEASE_DATABASE_CA_FILE"
          : "CONN",
      );
    }
  } else if (environment.RELEASE_DATABASE_CA_FILE) {
    invalid("final_publication_connection_required", "CONN");
  }
  return { environment, directory };
}
