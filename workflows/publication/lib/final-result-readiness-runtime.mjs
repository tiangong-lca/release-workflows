import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { parseEnv, promisify } from "node:util";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { resolveActorAccessToken } from "./actor-session.mjs";
import { fail } from "./common.mjs";

const execute = promisify(execFile);
const SETTINGS = [
  "CONN",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_PREFIX",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_SESSION_TOKEN",
  "TIANGONG_LCA_API_BASE_URL",
  "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY",
  "TIANGONG_LCA_ACCESS_TOKEN",
  "RESULT_QUERY_ENDPOINT",
  "RESULT_QUERY_SERVICE_SECRET",
  "RESULT_QUERY_SERVICE_SECRET_FILE",
  "RESULT_QUERY_SERVICE_SECRET_SSH_HOST",
  "RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE",
  "RELEASE_DATABASE_CA_FILE",
  // Existing archive readers can require this local executable override.
  "RELEASE_7ZIP_BIN",
];
const failConfig = (code, setting) =>
  fail(code, "Readiness configuration is invalid; check the named setting", {
    setting,
  });
async function boundedFile(filename, maximum, setting) {
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size > maximum) throw new Error();
    const data = await readFile(filename);
    if (data.length > maximum) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    failConfig("final_readiness_config_file_invalid", setting);
  }
}
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

// One fixed remote read. The operator explicitly chooses the host and env file;
// neither a shell command nor secret value is accepted as a CLI argument.
async function readSshSecret(host, filename, executeFile) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,255}$/u.test(host))
    failConfig(
      "final_readiness_secret_source_invalid",
      "RESULT_QUERY_SERVICE_SECRET_SSH_HOST",
    );
  if (
    !/^\/[A-Za-z0-9_./-]+$/u.test(filename) ||
    filename.split("/").includes("..")
  )
    failConfig(
      "final_readiness_secret_source_invalid",
      "RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE",
    );
  const program = `import pathlib,shlex,sys
p=pathlib.Path(sys.argv[1])
if not p.is_file() or p.stat().st_size>65536: raise ValueError('invalid file')
values=[]
for line in p.read_text().splitlines():
 line=line.strip()
 if not line or line.startswith('#') or '=' not in line: continue
 key,value=line.split('=',1)
 if key.strip()=='RESULT_QUERY_SERVICE_SECRET':
  parts=shlex.split(value,comments=True)
  if len(parts)!=1: raise ValueError('invalid value')
  values.append(parts[0])
if len(values)!=1 or not 32<=len(values[0].encode())<=4096: raise ValueError('invalid secret')
sys.stdout.write(values[0])`;
  const sshEnv = Object.fromEntries(
    ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SSH_AUTH_SOCK"]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  try {
    const result = await executeFile(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        host,
        `sudo -n python3 -c ${quote(program)} ${quote(filename)}`,
      ],
      {
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 8192,
        windowsHide: true,
        shell: false,
        env: sshEnv,
      },
    );
    return result.stdout;
  } catch {
    failConfig(
      "final_readiness_secret_unavailable",
      "RESULT_QUERY_SERVICE_SECRET_SSH_HOST",
    );
  }
}

// Explicit opt-in runtime preparation, scoped to result-readiness only. It never
// mutates process.env or writes tokens, credentials, remote config or evidence.
export async function prepareFinalResultReadinessEnvironment(
  options,
  {
    env = process.env,
    cwd = process.cwd(),
    executeFile = execute,
    resolveSession = resolveActorAccessToken,
  } = {},
) {
  const settings = [
    ...SETTINGS,
    ...(options["bootstrap-session"] ? ["TIANGONG_LCA_API_KEY"] : []),
  ];
  const result = Object.fromEntries(
    settings
      .filter((k) => typeof env[k] === "string" && env[k].trim())
      .map((k) => [k, env[k]]),
  );
  let directory = cwd;
  if (options["config-env"]) {
    const filename = path.resolve(cwd, options["config-env"]);
    directory = path.dirname(filename);
    let parsed;
    try {
      parsed = parseEnv(await boundedFile(filename, 65536, "config-env"));
    } catch (e) {
      if (e.code?.startsWith("final_readiness_")) throw e;
      failConfig("final_readiness_config_file_invalid", "config-env");
    }
    for (const key of settings) {
      if (!parsed[key]?.trim()) continue;
      if (result[key]?.trim() && result[key] !== parsed[key])
        failConfig("final_readiness_environment_conflict", key);
      result[key] = parsed[key];
    }
  }
  if (result.TIANGONG_LCA_API_BASE_URL) {
    try {
      const url = new URL(result.TIANGONG_LCA_API_BASE_URL.trim());
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !["/", "/functions/v1", "/functions/v1/"].includes(url.pathname)
      )
        throw new Error();
      result.TIANGONG_LCA_API_BASE_URL = url.origin;
    } catch {
      failConfig(
        "final_readiness_api_origin_invalid",
        "TIANGONG_LCA_API_BASE_URL",
      );
    }
  }
  if (result.RELEASE_DATABASE_CA_FILE) {
    const filename = path.resolve(directory, result.RELEASE_DATABASE_CA_FILE);
    const cert = await boundedFile(
      filename,
      131072,
      "RELEASE_DATABASE_CA_FILE",
    );
    try {
      new X509Certificate(cert);
      const conn = new URL(result.CONN);
      if (
        conn.searchParams.has("sslrootcert") &&
        path.resolve(cwd, conn.searchParams.get("sslrootcert")) !== filename
      )
        throw new Error();
      conn.searchParams.set("sslmode", "verify-full");
      conn.searchParams.set("sslrootcert", filename);
      result.CONN = conn.href;
    } catch {
      failConfig(
        "final_readiness_database_ca_invalid",
        "RELEASE_DATABASE_CA_FILE",
      );
    }
  }
  const sources = [
    "RESULT_QUERY_SERVICE_SECRET",
    "RESULT_QUERY_SERVICE_SECRET_FILE",
    "RESULT_QUERY_SERVICE_SECRET_SSH_HOST",
  ].filter((k) => result[k]?.trim());
  if (
    sources.length > 1 ||
    (result.RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE &&
      !result.RESULT_QUERY_SERVICE_SECRET_SSH_HOST)
  )
    failConfig(
      "final_readiness_secret_source_conflict",
      "RESULT_QUERY_SERVICE_SECRET",
    );
  if (sources[0] === "RESULT_QUERY_SERVICE_SECRET_FILE")
    result.RESULT_QUERY_SERVICE_SECRET = await boundedFile(
      path.resolve(directory, result.RESULT_QUERY_SERVICE_SECRET_FILE),
      4098,
      "RESULT_QUERY_SERVICE_SECRET_FILE",
    );
  if (sources[0] === "RESULT_QUERY_SERVICE_SECRET_SSH_HOST") {
    if (!result.RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE)
      failConfig(
        "final_readiness_secret_source_invalid",
        "RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE",
      );
    result.RESULT_QUERY_SERVICE_SECRET = await readSshSecret(
      result.RESULT_QUERY_SERVICE_SECRET_SSH_HOST,
      result.RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE,
      executeFile,
    );
  }
  if (result.RESULT_QUERY_SERVICE_SECRET) {
    result.RESULT_QUERY_SERVICE_SECRET =
      result.RESULT_QUERY_SERVICE_SECRET.trim();
    if (
      Buffer.byteLength(result.RESULT_QUERY_SERVICE_SECRET) < 32 ||
      Buffer.byteLength(result.RESULT_QUERY_SERVICE_SECRET) > 4096 ||
      /[\r\n\0]/u.test(result.RESULT_QUERY_SERVICE_SECRET)
    )
      failConfig(
        "final_readiness_secret_invalid",
        "RESULT_QUERY_SERVICE_SECRET",
      );
  }
  if (options["bootstrap-session"] && !result.TIANGONG_LCA_ACCESS_TOKEN) {
    try {
      result.TIANGONG_LCA_ACCESS_TOKEN = await resolveSession({ env: result });
    } catch {
      failConfig("final_readiness_session_unavailable", "TIANGONG_LCA_API_KEY");
    }
  }
  delete result.TIANGONG_LCA_API_KEY;
  return result;
}
