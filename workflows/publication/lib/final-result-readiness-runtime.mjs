import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { resolveActorAccessToken } from "./actor-session.mjs";
import { fail } from "./common.mjs";

import {
  preparePublicationEnvironment,
  readPublicationConfigFile as boundedFile,
  PUBLICATION_STORAGE_SETTINGS,
  PUBLICATION_STORAGE_CREDENTIALS,
} from "./publication-environment.mjs";

const execute = promisify(execFile);
const SETTINGS = [
  ...PUBLICATION_STORAGE_SETTINGS,
  ...PUBLICATION_STORAGE_CREDENTIALS,
  "TIANGONG_LCA_API_BASE_URL",
  "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY",
  "TIANGONG_LCA_ACCESS_TOKEN",
  "RESULT_QUERY_ENDPOINT",
  "RESULT_QUERY_SERVICE_SECRET",
  "RESULT_QUERY_SERVICE_SECRET_FILE",
  "RESULT_QUERY_SERVICE_SECRET_SSH_HOST",
  "RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE",
];
const failConfig = (code, setting) =>
  fail(code, "Readiness configuration is invalid; check the named setting", {
    setting,
  });
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

// Readiness-specific reader/session preparation follows shared config loading. It never
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
  const { environment: result, directory } =
    await preparePublicationEnvironment(options, { env, cwd, settings });
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
