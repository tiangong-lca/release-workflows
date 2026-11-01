import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createFinalResultObjectStore,
  finalResultStorageTarget,
} from "../../adapters/final-result-object-store.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const ref = {
  schemaVersion: "tiangong.query-artifact.v2",
  artifactId: "87920000-0000-4000-8000-000000000001",
  manifestSha256: "a".repeat(64),
  manifestByteSize: 12,
};
export const target = {
  databaseTargetHash: "d".repeat(64),
  bucket: "synthetic-results",
  region: "us-east-1",
  prefix: "test-owned",
};

// Real SDK/HTTP serialization with an intentionally small synthetic S3 server.
// This is transport proof, not cloud IAM or a production storage qualification.
export async function fixture(
  t,
  {
    mode = "normal",
    bytes = Buffer.from("synthetic-final-file"),
    timeoutMs = 3000,
    databaseTargetHash = target.databaseTargetHash,
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "final-object-store-"));
  const filePath = path.join(directory, "lci.h5");
  await writeFile(filePath, bytes);
  const objects = new Map(),
    parts = new Map(),
    requests = [];
  let uploadCount = 0;
  const xmlError = (response, status, code) => {
    response.writeHead(status, { "content-type": "application/xml" });
    response.end(
      `<Error><Code>${code}</Code><Message>provider-secret-never-log</Message></Error>`,
    );
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const key = url.pathname;
    requests.push({
      method: request.method,
      key,
      search: url.search,
      conditional: request.headers["if-none-match"],
      bytes: 0,
    });
    const record = requests.at(-1);
    if (mode === "forbidden") return xmlError(response, 403, "AccessDenied");
    if (request.method === "GET") {
      const value = objects.get(key);
      if (!value) return xmlError(response, 404, "NoSuchKey");
      response.writeHead(200, {
        "content-length": value.length,
        etag: '"not-a-content-hash"',
      });
      if (mode === "stall") {
        response.write(value.subarray(0, 1));
        return;
      }
      response.end(value);
      return;
    }
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const id = `synthetic-upload-${++uploadCount}`;
      parts.set(id, []);
      if (mode === "create-lost-ack") {
        response.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<InitiateMultipartUploadResult><Bucket>synthetic-results</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
      return;
    }
    if (request.method === "DELETE") {
      assert.ok(
        url.searchParams.has("uploadId"),
        "only own multipart abort, never DeleteObject",
      );
      if (mode === "abort-failure")
        return xmlError(response, 403, "AccessDenied");
      parts.delete(url.searchParams.get("uploadId"));
      response.writeHead(204);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    record.bytes = body.length;
    if (request.method === "PUT" && url.searchParams.has("partNumber")) {
      const id = url.searchParams.get("uploadId"),
        n = Number(url.searchParams.get("partNumber"));
      parts.get(id)[n - 1] = body;
      response.writeHead(200, { etag: `"part-${n}"` });
      response.end();
      return;
    }
    const multipart =
      request.method === "POST" && url.searchParams.has("uploadId");
    assert.ok(multipart || request.method === "PUT");
    assert.equal(request.headers["if-none-match"], "*");
    if (["race-same", "multipart-race"].includes(mode)) objects.set(key, bytes);
    if (mode === "race-different")
      objects.set(key, Buffer.from("wrong-content"));
    if (objects.has(key)) return xmlError(response, 412, "PreconditionFailed");
    const value = multipart
      ? Buffer.concat(parts.get(url.searchParams.get("uploadId")))
      : body;
    objects.set(key, value);
    if (multipart) parts.delete(url.searchParams.get("uploadId"));
    if (mode === "lost-ack") {
      response.destroy();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/xml",
      etag: '"opaque"',
    });
    response.end(
      multipart
        ? `<CompleteMultipartUploadResult><Bucket>synthetic-results</Bucket><Key>${key}</Key><ETag>"opaque"</ETag></CompleteMultipartUploadResult>`
        : "",
    );
  });
  let store;
  t.after(async () => {
    store?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  store = createFinalResultObjectStore({
    target: {
      ...target,
      databaseTargetHash,
      endpoint: `http://127.0.0.1:${server.address().port}`,
    },
    credentials: {
      accessKeyId: "synthetic-access",
      secretAccessKey: "synthetic-secret",
    },
    timeoutMs,
  });
  const descriptor = {
    name: "lci.h5",
    sha256: hash(bytes),
    byteSize: bytes.length,
  };
  const key = `/synthetic-results/test-owned/query-artifacts/${ref.artifactId}/${ref.manifestSha256}/lci.h5`;
  return { store, descriptor, filePath, requests, objects, parts, key, bytes };
}
