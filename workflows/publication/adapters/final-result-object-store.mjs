import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { fail, hashJson } from "../lib/common.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_FILE = 32 * 1024 ** 3;
const PART = 16 * 1024 ** 2;
const QUERY_NAMES = new Set([
  "manifest.json",
  "results.json.gz",
  "inventory-items.json.gz",
  "impacts.json.gz",
  "lci.h5",
  "lcia.h5",
]);
const CANDIDATE_NAMES = new Set([
  "release-candidate.json",
  "publication-catalog.json",
  "result.tidas.7z",
  "result.ilcd.7z",
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireValue(value, code = "final_storage_contract_invalid") {
  if (!value) fail(code, "Invalid final Result storage contract");
}
function fileDescriptor(value, allowed) {
  requireValue(
    value &&
      Object.keys(value).length === 3 &&
      allowed.has(value.name) &&
      HASH.test(value.sha256 ?? "") &&
      Number.isSafeInteger(value.byteSize) &&
      value.byteSize >= 1 &&
      value.byteSize <= MAX_FILE,
  );
}
function reference(value) {
  requireValue(
    value &&
      Object.keys(value).length === 4 &&
      value.schemaVersion === "tiangong.query-artifact.v2" &&
      UUID.test(value.artifactId ?? "") &&
      HASH.test(value.manifestSha256 ?? "") &&
      Number.isSafeInteger(value.manifestByteSize) &&
      value.manifestByteSize >= 1 &&
      value.manifestByteSize <= 128 * 1024 ** 2,
  );
}
export function finalResultStorageTarget({
  databaseTargetHash,
  bucket,
  region,
  endpoint = null,
  prefix = "",
}) {
  requireValue(
    HASH.test(databaseTargetHash ?? "") &&
      typeof bucket === "string" &&
      typeof region === "string" &&
      /^[a-z0-9-]{1,64}$/u.test(region) &&
      typeof prefix === "string" &&
      prefix.length <= 256 &&
      (prefix === "" ||
        (prefix.split("/").every((p) => p && p !== "." && p !== "..") &&
          /^[A-Za-z0-9._/-]+$/u.test(prefix))),
  );
  let normalized = null;
  if (endpoint !== null) {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      requireValue(false);
    }
    requireValue(
      !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.pathname === "/" ||
          (url.pathname === "/storage/v1/s3" &&
            (/^[a-z0-9]{20}\.storage\.supabase\.co$/u.test(url.hostname) ||
              ["127.0.0.1", "[::1]"].includes(url.hostname)))) &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "[::1]"].includes(url.hostname))),
    );
    normalized = url.origin + (url.pathname === "/" ? "" : url.pathname);
  }
  // Supabase's existing path-style buckets may contain underscores.
  const bucketPattern = normalized?.endsWith("/storage/v1/s3")
    ? /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u
    : /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
  requireValue(bucketPattern.test(bucket));
  const target = {
    schemaVersion: "tiangong.final-result-storage-target.v1",
    databaseTargetHash,
    bucket,
    region,
    endpoint: normalized,
    prefix,
  };
  return { target, targetHash: hashJson(target) };
}

// Internal service adapter only. It exposes no arbitrary object key, signed URL,
// DeleteObject or actor publication operation. SDK credentials remain in memory.
export function createFinalResultObjectStore({
  target: configuration,
  credentials,
  timeoutMs = 900000,
}) {
  const { target, targetHash } = finalResultStorageTarget(configuration);
  requireValue(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 3600000,
  );
  const client = new S3Client({
    region: target.region,
    endpoint: target.endpoint ?? undefined,
    forcePathStyle: target.endpoint !== null,
    credentials,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const fullKey = (key) => [target.prefix, key].filter(Boolean).join("/");
  async function timed(operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
  async function getVerified(key, file) {
    return timed(async (signal) => {
      let response;
      try {
        response = await client.send(
          new GetObjectCommand({ Bucket: target.bucket, Key: fullKey(key) }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) return null;
        fail(
          "final_storage_readback_failed",
          "Full object readback failed; retry the same immutable storage plan",
        );
      }
      const body = response.Body;
      const hash = createHash("sha256");
      let size = 0;
      const abort = () => body?.destroy?.();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        requireValue(
          body?.[Symbol.asyncIterator] &&
            response.ContentLength === file.byteSize,
          "final_storage_content_conflict",
        );
        for await (const chunk of body) {
          size += chunk.length;
          requireValue(size <= file.byteSize, "final_storage_content_conflict");
          hash.update(chunk);
        }
        requireValue(
          !signal.aborted &&
            size === file.byteSize &&
            hash.digest("hex") === file.sha256,
          "final_storage_content_conflict",
        );
        return { ...file };
      } catch (error) {
        if (
          typeof error.code === "string" &&
          error.code.startsWith("final_storage_")
        )
          throw error;
        fail(
          "final_storage_readback_failed",
          "Full object readback failed; retry the same immutable storage plan",
        );
      } finally {
        signal.removeEventListener("abort", abort);
        body?.destroy?.();
      }
    });
  }
  async function upload(key, file, sourcePath) {
    let handle,
      uploadId,
      complete = false;
    let cleanupRequired = false;
    let multipartStarted = false;
    let stage = "local_read";
    try {
      handle = await open(sourcePath, "r");
      const info = await handle.stat();
      requireValue(
        info.isFile() && info.size === file.byteSize,
        "final_storage_local_drift",
      );
      const keyFields = { Bucket: target.bucket, Key: fullKey(key) };
      const read = async (position, size) => {
        const buffer = Buffer.allocUnsafe(size);
        let used = 0;
        while (used < size) {
          const result = await handle.read(
            buffer,
            used,
            size - used,
            position + used,
          );
          requireValue(result.bytesRead > 0, "final_storage_local_drift");
          used += result.bytesRead;
        }
        return buffer;
      };
      if (file.byteSize <= PART) {
        const bytes = await read(0, file.byteSize);
        requireValue(
          digest(bytes) === file.sha256,
          "final_storage_local_drift",
        );
        stage = "put_object";
        await timed((signal) =>
          client.send(
            new PutObjectCommand({
              ...keyFields,
              Body: bytes,
              ContentLength: bytes.length,
              IfNoneMatch: "*",
              ContentType: file.name.endsWith(".7z")
                ? "application/x-7z-compressed"
                : "application/octet-stream",
            }),
            { abortSignal: signal },
          ),
        );
      } else {
        multipartStarted = true;
        stage = "create_multipart";
        const begun = await timed((signal) =>
          client.send(
            new CreateMultipartUploadCommand({
              ...keyFields,
              ContentType: file.name.endsWith(".7z")
                ? "application/x-7z-compressed"
                : "application/octet-stream",
            }),
            { abortSignal: signal },
          ),
        );
        requireValue(
          typeof begun.UploadId === "string" && begun.UploadId.length > 0,
          "final_storage_upload_unknown",
        );
        uploadId = begun.UploadId;
        const parts = [],
          hash = createHash("sha256");
        for (
          let position = 0, number = 1;
          position < file.byteSize;
          position += PART, number++
        ) {
          const bytes = await read(
            position,
            Math.min(PART, file.byteSize - position),
          );
          hash.update(bytes);
          stage = "upload_part";
          const part = await timed((signal) =>
            client.send(
              new UploadPartCommand({
                ...keyFields,
                UploadId: uploadId,
                PartNumber: number,
                Body: bytes,
                ContentLength: bytes.length,
              }),
              { abortSignal: signal },
            ),
          );
          requireValue(
            typeof part.ETag === "string" && part.ETag.length > 0,
            "final_storage_upload_unknown",
          );
          parts.push({ PartNumber: number, ETag: part.ETag });
        }
        requireValue(
          hash.digest("hex") === file.sha256,
          "final_storage_local_drift",
        );
        stage = "complete_multipart";
        await timed((signal) =>
          client.send(
            new CompleteMultipartUploadCommand({
              ...keyFields,
              UploadId: uploadId,
              MultipartUpload: { Parts: parts },
              IfNoneMatch: "*",
            }),
            { abortSignal: signal },
          ),
        );
        complete = true;
      }
    } catch (error) {
      const tooLarge =
        error.$metadata?.httpStatusCode === 413 ||
        error.name === "EntityTooLarge";
      if (multipartStarted && !uploadId) cleanupRequired = !tooLarge;
      if (uploadId && !complete) {
        try {
          await timed((signal) =>
            client.send(
              new AbortMultipartUploadCommand({
                Bucket: target.bucket,
                Key: fullKey(key),
                UploadId: uploadId,
              }),
              { abortSignal: signal },
            ),
          );
        } catch (abortError) {
          cleanupRequired = abortError.$metadata?.httpStatusCode !== 404;
        }
      }
      if (error.code === "final_storage_local_drift") {
        error.details = {
          ...error.details,
          multipartCleanupRequired: cleanupRequired,
        };
        throw error;
      }
      // A failed response does not prove that the conditional write failed.
      // Reconcile with a full GET below, never an unconditional overwrite.
      return {
        outcomeUnknown: true,
        cleanupRequired,
        tooLarge,
        diagnostic: {
          fileName: file.name,
          byteSize: file.byteSize,
          stage,
          ...(Number.isInteger(error.$metadata?.httpStatusCode) &&
          error.$metadata.httpStatusCode >= 400 &&
          error.$metadata.httpStatusCode <= 599
            ? { httpStatus: error.$metadata.httpStatusCode }
            : {}),
        },
      };
    } finally {
      await handle?.close().catch(() => {});
    }
    return { outcomeUnknown: false, cleanupRequired: false };
  }
  async function ensure(key, file, sourcePath) {
    const existing = await getVerified(key, file);
    if (existing)
      return {
        file: existing,
        reused: true,
        targetHash,
        multipartCleanupRequired: false,
      };
    const uploaded = await upload(key, file, sourcePath);
    let verified;
    try {
      verified = await getVerified(key, file);
    } catch (error) {
      error.details = {
        ...error.details,
        ...uploaded.diagnostic,
        multipartCleanupRequired: uploaded.cleanupRequired,
      };
      throw error;
    }
    if (!verified)
      fail(
        uploaded.tooLarge
          ? "final_storage_object_too_large"
          : "final_storage_upload_unknown",
        uploaded.tooLarge
          ? "Storage rejected the object size. Verify the effective upload limit or build a smaller archive; unchanged retries cannot resolve this rejection."
          : "No complete matching object was recovered; reconcile the same immutable storage plan before retry",
        {
          ...uploaded.diagnostic,
          multipartCleanupRequired: uploaded.cleanupRequired,
        },
      );
    return {
      file: verified,
      reused: uploaded.outcomeUnknown,
      targetHash,
      multipartCleanupRequired: uploaded.cleanupRequired,
    };
  }
  return {
    targetHash,
    databaseTargetHash: target.databaseTargetHash,
    async verifyQuery(artifact, file) {
      reference(artifact);
      fileDescriptor(file, QUERY_NAMES);
      if (file.name === "manifest.json")
        requireValue(
          file.sha256 === artifact.manifestSha256 &&
            file.byteSize === artifact.manifestByteSize,
        );
      const verified = await getVerified(
        `query-artifacts/${artifact.artifactId}/${artifact.manifestSha256}/${file.name}`,
        file,
      );
      requireValue(verified, "final_storage_object_missing");
      return { file: verified, targetHash };
    },
    async verifyCandidate(candidateHash, file) {
      requireValue(HASH.test(candidateHash ?? ""));
      fileDescriptor(file, CANDIDATE_NAMES);
      if (file.name === "release-candidate.json")
        requireValue(file.sha256 === candidateHash);
      const verified = await getVerified(
        `release-candidates/${candidateHash}/${file.name}`,
        file,
      );
      requireValue(verified, "final_storage_object_missing");
      return { file: verified, targetHash };
    },
    async ensureQuery(artifact, file, sourcePath) {
      reference(artifact);
      fileDescriptor(file, QUERY_NAMES);
      if (file.name === "manifest.json")
        requireValue(
          file.sha256 === artifact.manifestSha256 &&
            file.byteSize === artifact.manifestByteSize,
        );
      return ensure(
        `query-artifacts/${artifact.artifactId}/${artifact.manifestSha256}/${file.name}`,
        file,
        sourcePath,
      );
    },
    async ensureCandidate(candidateHash, file, sourcePath) {
      requireValue(HASH.test(candidateHash ?? ""));
      fileDescriptor(file, CANDIDATE_NAMES);
      if (file.name === "release-candidate.json")
        requireValue(file.sha256 === candidateHash);
      return ensure(
        `release-candidates/${candidateHash}/${file.name}`,
        file,
        sourcePath,
      );
    },
    close: () => client.destroy(),
  };
}
