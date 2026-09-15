#!/usr/bin/env node
/**
 * Opt-in LIVE acceptance for the Result-only Publication chain.
 *
 * This is NOT an offline test and NOT a mock. It drives the current production
 * transport (`globalThis.fetch`, the real `lib/result-process*.mjs` adapter) over
 * a real HTTP PostgREST endpoint supplied by the operator, and asserts on the
 * responses that endpoint actually returns. Nothing is stubbed, no response is
 * synthesized, and no authority is replaced.
 *
 * It never starts, resets or provisions a database; it only talks to the loopback
 * instance the operator has already prepared.
 *
 * Run with:
 *   TIANGONG_RELEASE_LIVE_ACCEPTANCE=1 \
 *   TIANGONG_LCA_API_BASE_URL=http://127.0.0.1:<port> \
 *   TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY=<publishable key> \
 *   TIANGONG_LCA_ACCESS_TOKEN=<manager actor JWT> \
 *   TIANGONG_RELEASE_LIVE_FIXTURE_UUID=<fresh, unused uuid> \
 *   node workflows/publication/live/result-only-acceptance.mjs \
 *     --out-dir .release/publication/live-acceptance/<run>
 *
 * Optional:
 *   TIANGONG_RELEASE_LIVE_NON_MANAGER_TOKEN=<second actor JWT without the role>
 *   TIANGONG_RELEASE_LIVE_FIXTURE_VERSION=<NN.NN.NNN>   (default 01.00.000)
 *   TIANGONG_RELEASE_LIVE_TIMEOUT_MS=<ms>               (default 30000)
 *
 * Optional but strongly recommended, so the run cannot accidentally interpret an
 * unrelated local stack as the intended target:
 *   TIANGONG_RELEASE_LIVE_EXPECTED_REF=<expected project ref / instance label>
 *
 * Secrets are read from the environment only. Tokens, keys and raw HTTP failure
 * bodies are never printed, never written to artifacts, and never passed as
 * command-line arguments.
 */
import { access, mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LIVE_ACCEPTANCE_ENV = "TIANGONG_RELEASE_LIVE_ACCEPTANCE";

/**
 * Ports that belong to shared or default local stacks.
 *
 * These are refused even on loopback: another agent's Supabase stack, a shared
 * local PostgREST, or a default project port is not this task's dedicated
 * instance, and writing a state-120 row into it would corrupt unrelated work.
 * The dedicated task instance uses a distinct port (for example 61321 or 63321).
 */
export const SHARED_LOCAL_PORTS = new Set([
  54321, 54322, 55321, 55322, 56321, 56322, 57321, 57322, 58321, 58322,
]);

/**
 * Loopback-only guard with strict IP parsing.
 *
 * `net.isIP` is used rather than a string prefix: a prefix test such as
 * `host.startsWith("127.")` would admit a hosted DNS name like
 * `127.attacker.example`. Only the exact loopback literals are accepted.
 */
export function assertLoopbackEndpoint(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw liveError(
      "live_acceptance_endpoint_invalid",
      "TIANGONG_LCA_API_BASE_URL must be an absolute URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw liveError(
      "live_acceptance_endpoint_invalid",
      "TIANGONG_LCA_API_BASE_URL must be http(s)",
    );
  // Never silently strip a supplied path, query or fragment: a caller that
  // supplied one did not mean the bare origin.
  if (parsed.username || parsed.password)
    throw liveError(
      "live_acceptance_endpoint_invalid",
      "TIANGONG_LCA_API_BASE_URL must not embed credentials",
    );
  if (parsed.pathname !== "/" && parsed.pathname !== "")
    throw liveError(
      "live_acceptance_endpoint_invalid",
      "TIANGONG_LCA_API_BASE_URL must not carry a path",
      { pathname: parsed.pathname },
    );
  if (parsed.search || parsed.hash)
    throw liveError(
      "live_acceptance_endpoint_invalid",
      "TIANGONG_LCA_API_BASE_URL must not carry a query string or fragment",
    );

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const literal = host === "localhost" || isIP(host) !== 0;
  if (!literal)
    throw liveError(
      "live_acceptance_endpoint_not_loopback",
      "Live acceptance accepts only a literal loopback address or localhost",
      { host },
    );
  if (host !== "localhost") {
    const family = isIP(host);
    const loopback =
      (family === 4 && host.startsWith("127.")) ||
      (family === 6 && host === "::1");
    if (!loopback)
      throw liveError(
        "live_acceptance_endpoint_not_loopback",
        "Live acceptance refuses a non-loopback address",
        { host, family },
      );
  }

  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw liveError(
      "live_acceptance_endpoint_invalid",
      "Endpoint port must be a valid TCP port",
      { port: parsed.port },
    );
  if (SHARED_LOCAL_PORTS.has(port))
    throw liveError(
      "live_acceptance_endpoint_shared_port",
      "That port belongs to a shared or default local stack; use this task's dedicated instance port",
      { port, sharedPorts: [...SHARED_LOCAL_PORTS].sort((a, b) => a - b) },
    );
  return { url: parsed, host, port };
}

export function requireLiveEnvironment(env = process.env) {
  if (String(env[LIVE_ACCEPTANCE_ENV] ?? "").trim() !== "1")
    throw liveError(
      "live_acceptance_not_opted_in",
      `Set ${LIVE_ACCEPTANCE_ENV}=1 to run the live acceptance runner`,
    );
  const baseUrl = required(env, "TIANGONG_LCA_API_BASE_URL");
  const publishableKey = required(env, "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY");
  const accessToken = required(env, "TIANGONG_LCA_ACCESS_TOKEN");
  const fixtureUuid = required(env, "TIANGONG_RELEASE_LIVE_FIXTURE_UUID");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      fixtureUuid,
    )
  )
    throw liveError(
      "live_acceptance_fixture_invalid",
      "TIANGONG_RELEASE_LIVE_FIXTURE_UUID must be a lowercase UUID",
    );
  if (publishableKey.startsWith("sb_secret_"))
    throw liveError(
      "publication_secret_key_forbidden",
      "A Supabase secret key is not accepted; supply the publishable key",
    );
  const version =
    String(env.TIANGONG_RELEASE_LIVE_FIXTURE_VERSION ?? "").trim() ||
    "01.00.000";
  if (!/^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u.test(version))
    throw liveError(
      "live_acceptance_fixture_invalid",
      "TIANGONG_RELEASE_LIVE_FIXTURE_VERSION must be NN.NN.NNN",
    );

  // The operator must name the instance this run is authorized to write to, and
  // state the exact expected endpoint. Both are required: a typo in the port or
  // an inherited URL from another shell must not become a write to the wrong
  // local stack.
  const instanceLabel = required(env, "TIANGONG_RELEASE_LIVE_INSTANCE").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(instanceLabel))
    throw liveError(
      "live_acceptance_instance_label_invalid",
      "TIANGONG_RELEASE_LIVE_INSTANCE must be a short label, not a URL or credential",
    );
  // The endpoint is host-checked here; label binding is declared here and
  // verified against the server later, in `assertInstanceBinding`.
  const expectedEndpoint = required(
    env,
    "TIANGONG_RELEASE_LIVE_EXPECTED_ENDPOINT",
  ).trim();
  if (normalizeEndpoint(expectedEndpoint) !== normalizeEndpoint(baseUrl))
    throw liveError(
      "live_acceptance_expected_endpoint_mismatch",
      "TIANGONG_RELEASE_LIVE_EXPECTED_ENDPOINT must match TIANGONG_LCA_API_BASE_URL exactly",
    );

  const timeoutRaw = String(env.TIANGONG_RELEASE_LIVE_TIMEOUT_MS ?? "").trim();
  const timeoutMs = timeoutRaw === "" ? 30_000 : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000)
    throw liveError(
      "live_acceptance_timeout_invalid",
      "TIANGONG_RELEASE_LIVE_TIMEOUT_MS must be an integer between 1000 and 300000",
      { received: timeoutRaw || null },
    );

  const endpoint = assertLoopbackEndpoint(baseUrl);
  return {
    baseUrl: normalizeEndpoint(baseUrl),
    host: endpoint.host,
    port: endpoint.port,
    publishableKey,
    accessToken,
    fixtureUuid: fixtureUuid.toLowerCase(),
    version,
    instanceLabel,
    expectedEndpoint: normalizeEndpoint(expectedEndpoint),
    nonManagerToken:
      String(env.TIANGONG_RELEASE_LIVE_NON_MANAGER_TOKEN ?? "").trim() || null,
    timeoutMs,
  };
}

/**
 * Origin-only normalization. A supplied path, query or fragment is rejected by
 * `assertLoopbackEndpoint`, never silently stripped here.
 */
export function normalizeEndpoint(value) {
  const parsed = new URL(String(value).trim());
  return `${parsed.protocol}//${parsed.host}`;
}

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value)
    throw liveError(
      "live_acceptance_environment_incomplete",
      `Missing required environment variable: ${name}`,
    );
  return value;
}

function liveError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

/**
 * Redaction for anything that might end up in output.
 *
 * Raw HTTP failure bodies are never surfaced: the runner only ever reports the
 * semantic `ok`/`code` fields, which are part of the reviewed contract.
 */
export function redact(text, secrets = []) {
  let output = String(text ?? "");
  for (const secret of secrets)
    if (secret) output = output.split(secret).join("<redacted>");
  return output;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = requireLiveEnvironment();
  const { runLiveAcceptance } = await import("./live-acceptance.mjs");
  const outDir = path.resolve(
    options["out-dir"] ?? ".release/publication/live-acceptance",
  );
  // Immutable-output preflight: never write into an existing run directory.
  await assertOutputAbsent(outDir);
  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "live-acceptance-manifest.json");
  const result = await runLiveAcceptance({
    config,
    outDir,
    manifestPath,
    // No fetchImpl is passed: the production `globalThis.fetch` default runs.
  });
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  process.stdout.write(`manifest: ${manifestPath}\n`);
}

async function assertOutputAbsent(target) {
  try {
    await access(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw liveError(
    "live_acceptance_output_exists",
    "Refusing to write into an existing run directory; use a new --out-dir",
    { outDir: target },
  );
}

function parseArgs(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--out-dir") {
      options["out-dir"] = tokens[index + 1];
      index += 1;
    } else if (token === "--help" || token === "-h") {
      process.stdout.write(
        "See the header of this file for the required environment variables.\n",
      );
      process.exit(0);
    } else {
      throw liveError(
        "live_acceptance_arguments_invalid",
        `Unsupported argument: ${token}`,
      );
    }
  }
  return options;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // Only the code and message are printed: never the token, key or a response
    // body.
    const secrets = [
      process.env.TIANGONG_LCA_ACCESS_TOKEN,
      process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY,
      process.env.TIANGONG_RELEASE_LIVE_NON_MANAGER_TOKEN,
    ];
    process.stderr.write(
      `${error.code ?? "live_acceptance_failed"}: ${redact(error.message, secrets)}\n`,
    );
    if (error.details && Object.keys(error.details).length)
      process.stderr.write(
        `details: ${redact(JSON.stringify(error.details), secrets)}\n`,
      );
    process.exitCode = 1;
  });
}

export { main, liveError };
