import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fail, hashJson } from "../lib/common.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const MAX_RESPONSE = 2 * 1024 ** 2;
function requireValue(value, code = "final_reader_contract_invalid") {
  if (!value) fail(code, "Final Result reader verification failed");
}
function keys(value, names) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === names.sort().join(",")
  );
}
const same = (a, b) => {
  try {
    return a !== undefined && b !== undefined && hashJson(a) === hashJson(b);
  } catch {
    return false;
  }
};

export function validateFinalReaderRequest(request) {
  requireValue(
    keys(request, ["schemaVersion", "scope", "artifact", "result", "query"]),
  );
  const { scope, artifact, result, query } = request;
  requireValue(
    request.schemaVersion === "result.query.request.v2" &&
      keys(scope, ["kind", "releaseRunId", "selectionHash"]) &&
      scope.kind === "readiness" &&
      UUID.test(scope.releaseRunId ?? "") &&
      HASH.test(scope.selectionHash ?? "") &&
      keys(artifact, [
        "schemaVersion",
        "artifactId",
        "manifestSha256",
        "manifestByteSize",
      ]) &&
      artifact.schemaVersion === "tiangong.query-artifact.v2" &&
      UUID.test(artifact.artifactId ?? "") &&
      HASH.test(artifact.manifestSha256 ?? "") &&
      Number.isSafeInteger(artifact.manifestByteSize) &&
      artifact.manifestByteSize > 0 &&
      artifact.manifestByteSize <= 128 * 1024 ** 2 &&
      keys(result, ["uuid", "version"]) &&
      UUID.test(result.uuid ?? "") &&
      VERSION.test(result.version ?? ""),
  );
  requireValue(
    query?.kind === "lci"
      ? keys(query, ["kind", "limit", "cursor", "filter"]) &&
          Number.isSafeInteger(query.limit) &&
          query.limit >= 1 &&
          query.limit <= 1000 &&
          query.filter === null &&
          (query.cursor === null ||
            (typeof query.cursor === "string" &&
              query.cursor.length > 0 &&
              query.cursor.length <= 4096))
      : keys(query, ["kind"]) && ["overview", "lcia"].includes(query.kind),
  );
}

// A private verifier transport, never a browser/publication resolver. It cannot
// sign arbitrary paths, public scopes, filters, SQL or storage locators.
export function createFinalResultReader({
  endpoint,
  secret,
  timeoutMs = 30000,
  preparingMs = 300000,
}) {
  let origin;
  try {
    origin = new URL(endpoint);
  } catch {
    requireValue(false);
  }
  requireValue(
    !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      origin.pathname === "/" &&
      (origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(origin.hostname))) &&
      typeof secret === "string" &&
      Buffer.byteLength(secret) >= 32 &&
      Buffer.byteLength(secret) <= 4096 &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 100 &&
      timeoutMs <= 60000 &&
      Number.isSafeInteger(preparingMs) &&
      preparingMs >= 0 &&
      preparingMs <= 900000,
  );
  const url = new URL("/internal/results/query-v2", origin).href;
  return {
    async query(request, { readerSha256, authorize }) {
      validateFinalReaderRequest(request);
      requireValue(
        HASH.test(readerSha256 ?? "") && typeof authorize === "function",
      );
      // Snapshot before awaiting an actor check: callers cannot change the signed
      // request while an asynchronous authorization is in flight.
      request = structuredClone(request);
      const body = JSON.stringify(request);
      requireValue(Buffer.byteLength(body) <= 64 * 1024);
      const deadline = performance.now() + preparingMs + timeoutMs;
      const prepareDeadline = performance.now() + preparingMs;
      for (;;) {
        const authController = new AbortController();
        let authTimer;
        try {
          await Promise.race([
            Promise.resolve().then(() => authorize(authController.signal)),
            new Promise((resolve, reject) => {
              authTimer = setTimeout(
                () => {
                  authController.abort();
                  reject(new Error("Authorization deadline exceeded"));
                },
                Math.min(timeoutMs, Math.max(1, deadline - performance.now())),
              );
            }),
          ]);
        } catch {
          requireValue(false, "final_reader_authorization_changed");
        } finally {
          clearTimeout(authTimer);
          authController.abort();
        }
        requireValue(performance.now() < deadline, "final_reader_timeout");
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = createHmac("sha256", secret)
          .update(`${timestamp}.${body}`)
          .digest("hex");
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          Math.min(timeoutMs, Math.max(1, deadline - performance.now())),
        );
        timer.unref();
        let response;
        let value;
        try {
          response = await fetch(url, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              "x-query-timestamp": timestamp,
              "x-query-signature": signature,
            },
            body,
          });
          requireValue(
            response.status === 200 || response.status === 202,
            "final_reader_unavailable",
          );
          requireValue(
            response.headers.get("content-type")?.split(";")[0].trim() ===
              "application/json",
            "final_reader_response_invalid",
          );
          const length = response.headers.get("content-length");
          requireValue(
            length === null ||
              (/^\d+$/u.test(length) && Number(length) <= MAX_RESPONSE),
            "final_reader_response_budget",
          );
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            requireValue(size <= MAX_RESPONSE, "final_reader_response_budget");
            chunks.push(chunk);
          }
          value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          );
        } catch (error) {
          if (
            typeof error.code === "string" &&
            error.code.startsWith("final_reader_")
          )
            throw error;
          requireValue(
            false,
            controller.signal.aborted
              ? "final_reader_timeout"
              : "final_reader_response_invalid",
          );
        } finally {
          controller.abort();
          clearTimeout(timer);
        }
        if (response.status === 202) {
          requireValue(
            keys(value, ["schemaVersion", "status", "artifactId", "scope"]) &&
              value.schemaVersion === "result.query.response.v2" &&
              value.status === "preparing" &&
              value.artifactId === request.artifact.artifactId &&
              same(value.scope, request.scope),
            "final_reader_response_binding",
          );
          requireValue(
            performance.now() < prepareDeadline,
            "final_reader_preparing_timeout",
          );
          await delay(
            Math.min(200, Math.max(1, prepareDeadline - performance.now())),
          );
          continue;
        }
        requireValue(
          keys(value, [
            "schemaVersion",
            "reader",
            "scope",
            "artifactId",
            "result",
            "data",
          ]) &&
            value.schemaVersion === "result.query.response.v2" &&
            same(value.reader, {
              schemaVersion: "tiangong.final-result-reader.v1",
              executableSha256: readerSha256,
            }) &&
            same(value.scope, request.scope) &&
            value.artifactId === request.artifact.artifactId &&
            same(value.result, request.result),
          "final_reader_response_binding",
        );
        return value.data;
      }
    },
  };
}
