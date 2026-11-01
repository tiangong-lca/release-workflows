import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createFinalResultActorTransport } from "./final-result-actor-transport.mjs";
import { fail } from "../lib/common.mjs";
function required(value, code = "final_public_readback_transport_invalid") {
  if (!value)
    fail(code, "Public Result readback did not match its bounded contract");
}
function safeUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    required(false);
  }
  required(
    !u.username &&
      !u.password &&
      !u.hash &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(u.hostname))),
  );
  return u;
}
// Uses the same actor and API origin as publication. Never sends actor headers
// to a signed ZIP URL; no reader/service secret, ambient credential or redirect.
export function createFinalResultPublicReader(config) {
  const actor = createFinalResultActorTransport(config);
  const origin = new URL(config.endpoint);
  async function call(body) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(
          new URL("/functions/v1/lca_release_results", origin),
          {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              apikey: config.publishableKey,
              Authorization: `Bearer ${config.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
        required(
          response.headers.get("content-type")?.split(";")[0].trim() ===
            "application/json" && response.body,
        );
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          required(size <= 2 * 1024 ** 2);
          chunks.push(chunk);
        }
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks));
        } catch {
          required(false);
        }
        if (
          body.mode === "final_download" &&
          response.status === 404 &&
          data?.code === "RESULT_PACKAGE_NOT_AVAILABLE"
        )
          return null;
        required(
          response.ok &&
            data?.ok === true &&
            data.mode === body.mode &&
            data.data,
          "final_public_readback_unavailable",
        );
        if (response.status !== 202) return data.data;
        required(
          body.mode === "final_query" &&
            data.data?.data?.status === "preparing" &&
            attempt < 4,
          "final_public_readback_preparing",
        );
      } catch (e) {
        if (e.code?.startsWith("final_public_")) throw e;
        required(false, "final_public_readback_unavailable");
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      await delay(2000);
    }
  }
  return {
    actorId: actor.actorId,
    apiTargetHash: actor.apiTargetHash,
    query(body) {
      return call({ mode: "final_query", ...body });
    },
    async download(publicationId, format, expected) {
      const data = await call({
        mode: "final_download",
        publicationId,
        format,
      });
      if (data === null) return { status: "unavailable" };
      required(
        data.publicationId === publicationId &&
          data.file?.name === expected.name &&
          data.file?.sha256 === expected.sha256 &&
          data.file?.byteSize === expected.byteSize,
      );
      required(
        Number.isSafeInteger(expected.byteSize) &&
          expected.byteSize > 0 &&
          expected.byteSize <= 32 * 1024 ** 3,
      );
      const expires = Date.parse(data.expiresAt);
      required(expires > Date.now() && expires <= Date.now() + 65000);
      const url = safeUrl(data.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      try {
        const response = await fetch(url, {
          redirect: "error",
          signal: controller.signal,
        });
        required(response.status === 200 && response.body);
        const h = createHash("sha256");
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          required(size <= expected.byteSize);
          h.update(chunk);
        }
        required(
          size === expected.byteSize && h.digest("hex") === expected.sha256,
          "final_public_zip_mismatch",
        );
        return { status: "verified", file: expected };
      } catch (e) {
        if (e.code?.startsWith("final_public_")) throw e;
        required(false, "final_public_zip_unavailable");
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
