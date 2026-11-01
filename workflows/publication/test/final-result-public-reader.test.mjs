import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createFinalResultPublicReader } from "../adapters/final-result-public-reader.mjs";
const actorId = "87990000-0000-4000-8000-000000000001";
const pub = "87990000-0000-4000-8000-000000000002";
const bytes = Buffer.from("synthetic complete ZIP transport bytes");
const file = {
  name: "result.tidas.zip",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byteSize: bytes.length,
};
async function fixture(t) {
  let body, downloadHeaders;
  const state = { status: 200, bytes, patch: {}, badMode: false };
  const token = `e30.${Buffer.from(JSON.stringify({ sub: actorId, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.test`;
  const server = createServer(async (req, res) => {
    if (req.url === "/zip") {
      downloadHeaders = req.headers;
      res.writeHead(200);
      res.end(state.bytes);
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers.apikey, "sb_publishable_fixture");
    assert.equal(req.url, "/functions/v1/lca_release_results");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks));
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        state.status === 404
          ? { ok: false, code: "RESULT_PACKAGE_NOT_AVAILABLE" }
          : {
              ok: true,
              mode: state.badMode ? "query" : body.mode,
              data:
                body.mode === "final_query"
                  ? { observed: body }
                  : {
                      publicationId: pub,
                      file,
                      url: `http://127.0.0.1:${server.address().port}/zip`,
                      expiresAt: new Date(Date.now() + 60000).toISOString(),
                      ...state.patch,
                    },
            },
      ),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const reader = createFinalResultPublicReader({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    publishableKey: "sb_publishable_fixture",
    accessToken: token,
  });
  return { reader, state, headers: () => downloadHeaders };
}
test("public reader preserves actor pins and verifies complete ZIP bytes without forwarding actor credentials", async (t) => {
  const { reader, headers } = await fixture(t);
  const request = {
    resultId: actorId,
    resultVersion: "01.00.000",
    publicationId: pub,
    runtimeRevision: actorId,
    query: { kind: "lci", cursor: "exact", limit: 1 },
  };
  assert.deepEqual(await reader.query(request), {
    observed: { mode: "final_query", ...request },
  });
  assert.deepEqual(await reader.download(pub, "tidas", file), {
    status: "verified",
    file,
  });
  assert.equal(headers().authorization, undefined);
  assert.equal(headers().apikey, undefined);
});
test("public reader rejects corrupted bytes, unsafe/expired links and wrong file bindings", async (t) => {
  const { reader, state } = await fixture(t);
  state.bytes = Buffer.from("X".repeat(bytes.length));
  await assert.rejects(reader.download(pub, "tidas", file), {
    code: "final_public_zip_mismatch",
  });
  state.bytes = Buffer.concat([bytes, Buffer.from("overflow")]);
  await assert.rejects(reader.download(pub, "tidas", file), {
    code: "final_public_readback_transport_invalid",
  });
  state.bytes = bytes;
  for (const patch of [
    { url: "http://remote.invalid/zip" },
    { url: "https://user:secret@example.invalid/zip" },
    { expiresAt: "2020-01-01T00:00:00Z" },
    { file: { ...file, sha256: "0".repeat(64) } },
    { publicationId: actorId },
  ]) {
    state.patch = patch;
    await assert.rejects(reader.download(pub, "tidas", file), {
      code: "final_public_readback_transport_invalid",
    });
  }
});
test("only explicit package denial counts as unavailable; errors never become success", async (t) => {
  const { reader, state } = await fixture(t);
  state.status = 404;
  assert.deepEqual(await reader.download(pub, "tidas", file), {
    status: "unavailable",
  });
  await assert.rejects(
    reader.query({ resultId: actorId, query: { kind: "overview" } }),
    { code: "final_public_readback_unavailable" },
  );
  state.status = 500;
  await assert.rejects(reader.download(pub, "tidas", file), {
    code: "final_public_readback_unavailable",
  });
  state.status = 200;
  state.badMode = true;
  await assert.rejects(reader.query({ query: { kind: "overview" } }), {
    code: "final_public_readback_unavailable",
  });
});
