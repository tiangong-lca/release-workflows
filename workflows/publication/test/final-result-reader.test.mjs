import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { createFinalResultReader } from "../adapters/final-result-reader.mjs";
import { ref } from "./fixtures/final-storage.mjs";
const secret = "synthetic-reader-secret-at-least-32-characters";
const readerSha256 = "b".repeat(64);
const request = {
  schemaVersion: "result.query.request.v2",
  scope: {
    kind: "readiness",
    releaseRunId: ref.artifactId,
    selectionHash: "c".repeat(64),
  },
  artifact: ref,
  result: { uuid: ref.artifactId, version: "01.00.000" },
  query: { kind: "overview" },
};
const response = () => ({
  schemaVersion: "result.query.response.v2",
  reader: {
    schemaVersion: "tiangong.final-result-reader.v1",
    executableSha256: readerSha256,
  },
  scope: request.scope,
  artifactId: ref.artifactId,
  result: request.result,
  data: { lciAvailable: true },
});
async function server(t, handle, options = {}) {
  const calls = [];
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const timestamp = req.headers["x-query-timestamp"];
    assert.equal(req.url, "/internal/results/query-v2");
    assert.equal(
      req.headers["x-query-signature"],
      createHmac("sha256", secret)
        .update(timestamp + ".")
        .update(body)
        .digest("hex"),
    );
    assert.ok(Math.abs(Number(timestamp) - Date.now() / 1000) < 30);
    assert.equal(req.headers.authorization, undefined);
    calls.push(JSON.parse(body));
    handle(req, res, calls.length);
  });
  t.after(async () => {
    http.closeAllConnections();
    await new Promise((r) => http.close(r));
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return {
    calls,
    reader: createFinalResultReader({
      endpoint: `http://127.0.0.1:${http.address().port}`,
      secret,
      ...options,
    }),
  };
}
const send = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

test("signed private transport retries cold cache only after a fresh authorization", async (t) => {
  const f = await server(t, (req, res, count) =>
    send(
      res,
      count === 1
        ? {
            schemaVersion: "result.query.response.v2",
            status: "preparing",
            artifactId: ref.artifactId,
            scope: request.scope,
          }
        : response(),
      count === 1 ? 202 : 200,
    ),
  );
  let checks = 0;
  assert.deepEqual(
    await f.reader.query(request, {
      readerSha256,
      authorize: async () => checks++,
    }),
    response().data,
  );
  assert.equal(checks, 2);
  assert.equal(f.calls.length, 2);
});
test("revoked authority stops a cold-cache retry before a second signed request", async (t) => {
  const f = await server(t, (req, res) =>
    send(
      res,
      {
        schemaVersion: "result.query.response.v2",
        status: "preparing",
        artifactId: ref.artifactId,
        scope: request.scope,
      },
      202,
    ),
  );
  let checks = 0;
  await assert.rejects(
    f.reader.query(request, {
      readerSha256,
      authorize: async () => {
        if (++checks > 1) throw new Error("private actor credential");
      },
    }),
    { code: "final_reader_authorization_changed" },
  );
  assert.equal(f.calls.length, 1);
});
for (const field of ["reader", "scope", "artifactId", "result", "unknown"]) {
  test(`response ${field} drift cannot become reader proof`, async (t) => {
    const value = response();
    value[field] = "wrong";
    const f = await server(t, (req, res) => send(res, value));
    await assert.rejects(
      f.reader.query(request, { readerSha256, authorize: async () => {} }),
      { code: "final_reader_response_binding" },
    );
  });
}
test("private transport rejects public scopes, filters, query extras and insecure targets before I/O", async () => {
  const reader = createFinalResultReader({
    endpoint: "https://reader.example",
    secret,
  });
  for (const bad of [
    {
      ...request,
      scope: { kind: "publication", publicationId: ref.artifactId },
    },
    {
      ...request,
      query: { kind: "lci", limit: 1, cursor: null, filter: "private" },
    },
    { ...request, query: { kind: "overview", locator: "secret" } },
  ])
    await assert.rejects(
      reader.query(bad, {
        readerSha256,
        authorize: () => assert.fail("must not call authority"),
      }),
      { code: "final_reader_contract_invalid" },
    );
  for (const endpoint of [
    "http://reader.example",
    "https://user:pass@reader.example",
    "https://reader.example/path",
    "https://reader.example/?x=1",
  ])
    assert.throws(() => createFinalResultReader({ endpoint, secret }), {
      code: "final_reader_contract_invalid",
    });
});
test("request is snapshotted before the asynchronous authority check", async (t) => {
  const f = await server(t, (req, res) => send(res, response()));
  const input = structuredClone(request);
  await f.reader.query(input, {
    readerSha256,
    authorize: async () => {
      input.result.uuid = "wrong";
    },
  });
  assert.deepEqual(f.calls[0], request);
});
test("redirects do not forward the service signature and raw provider errors stay private", async (t) => {
  const f = await server(t, (req, res) => {
    res.writeHead(307, { location: "http://127.0.0.1:1/private-secret" });
    res.end("provider-secret");
  });
  await assert.rejects(
    f.reader.query(request, { readerSha256, authorize: async () => {} }),
    (error) =>
      error.code === "final_reader_response_invalid" &&
      !String(error).includes("secret"),
  );
  assert.equal(f.calls.length, 1);
});
test("chunked responses over 2 MiB abort without buffering unlimited output", async (t) => {
  const f = await server(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('"' + "x".repeat(2 * 1024 ** 2) + '"');
  });
  await assert.rejects(
    f.reader.query(request, { readerSha256, authorize: async () => {} }),
    { code: "final_reader_response_budget" },
  );
});
test("a stalled body has a bounded deadline", async (t) => {
  const f = await server(
    t,
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    },
    { timeoutMs: 100 },
  );
  await assert.rejects(
    f.reader.query(request, { readerSha256, authorize: async () => {} }),
    { code: "final_reader_timeout" },
  );
});
test("preparing timeout returns no successful observation", async (t) => {
  const f = await server(
    t,
    (req, res) =>
      send(
        res,
        {
          schemaVersion: "result.query.response.v2",
          status: "preparing",
          artifactId: ref.artifactId,
          scope: request.scope,
        },
        202,
      ),
    { preparingMs: 0 },
  );
  await assert.rejects(
    f.reader.query(request, { readerSha256, authorize: async () => {} }),
    { code: "final_reader_preparing_timeout" },
  );
});

test("hanging authority has a deadline and sends no service request", async (t) => {
  const f = await server(t, () => assert.fail("no HTTP before authority"), {
    timeoutMs: 100,
  });
  let aborted = false;
  await assert.rejects(
    f.reader.query(request, {
      readerSha256,
      authorize: (signal) =>
        new Promise(() =>
          signal.addEventListener("abort", () => {
            aborted = true;
          }),
        ),
    }),
    { code: "final_reader_authorization_changed" },
  );
  assert.equal(aborted, true);
  assert.equal(f.calls.length, 0);
});
test("missing nested identity and malformed provider JSON cannot leak raw exceptions", async (t) => {
  const f = await server(t, (req, res) => {
    const value = response();
    value.reader = { schemaVersion: "tiangong.final-result-reader.v1" };
    send(res, value);
  });
  await assert.rejects(
    f.reader.query(request, { readerSha256, authorize: async () => {} }),
    { code: "final_reader_response_binding" },
  );
});
