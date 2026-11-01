import {
  readFile,
  stat,
  realpath,
  mkdir,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { sha256Bytes, fail } from "./common.mjs";
const MAX_INDEX = 128 * 1024 * 1024;
const MAX_NUMERIC = 32 * 1024 * 1024 * 1024;
export async function safeFile(root, relative) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((p) => !p || p === "." || p === "..")
  )
    fail("final_pair_path_invalid", "Invalid paired artifact path");
  const base = await realpath(root);
  const file = await realpath(path.join(base, relative));
  if (!file.startsWith(`${base}${path.sep}`))
    fail("final_pair_path_escape", "Paired file escapes root");
  return file;
}
export async function verifiedBytes(root, descriptor, limit) {
  const file = await safeFile(root, descriptor.name);
  const size = (await stat(file)).size;
  if (
    !Number.isSafeInteger(descriptor.byteSize) ||
    size !== descriptor.byteSize ||
    size > limit
  )
    fail("final_pair_file_size", "Paired file size mismatch");
  const bytes = await readFile(file);
  if (sha256Bytes(bytes) !== descriptor.sha256)
    fail("final_pair_file_hash", "Paired file hash mismatch");
  return bytes;
}
export async function verifyLargeFile(root, descriptor) {
  const file = await safeFile(root, descriptor.name);
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(file)) {
    size += bytes.length;
    if (size > MAX_NUMERIC || size > descriptor.byteSize)
      fail("final_pair_file_size", "Paired file exceeds size");
    hash.update(bytes);
  }
  if (size !== descriptor.byteSize || hash.digest("hex") !== descriptor.sha256)
    fail("final_pair_file_hash", "Paired matrix integrity mismatch");
}
export async function indexFile(root, manifest, name) {
  const descriptor = manifest.files.find((f) => f.name === name);
  if (
    !descriptor ||
    !Number.isSafeInteger(descriptor.plainByteSize) ||
    descriptor.plainByteSize < 1 ||
    descriptor.plainByteSize > MAX_INDEX
  )
    fail("final_pair_index_size", "Invalid paired index size");
  const bytes = gunzipSync(await verifiedBytes(root, descriptor, MAX_INDEX), {
    maxOutputLength: descriptor.plainByteSize + 1,
  });
  if (bytes.length !== descriptor.plainByteSize)
    fail("final_pair_index_size", "Paired index length mismatch");
  const result = JSON.parse(bytes);
  if (!Array.isArray(result))
    fail("final_pair_index_shape", "Paired index must be an array");
  return result;
}

export async function readLocalJson(root, relative, limit = MAX_INDEX) {
  const file = await safeFile(root, relative);
  const size = (await stat(file)).size;
  if (size < 1 || size > limit)
    fail("final_metadata_size", "Final metadata exceeds its byte budget");
  const bytes = await readFile(file);
  if (bytes.length !== size)
    fail("final_metadata_drift", "Final metadata changed while reading");
  return JSON.parse(bytes);
}

// Commit the qualification marker last. If a move fails, preserve both owned
// directories so identity receipts and successful files are never deleted.
export async function commitFrozenDirectory(
  staging,
  target,
  marker,
  { move = rename } = {},
) {
  await safeFile(staging, marker);
  await mkdir(target);
  try {
    for (const name of await readdir(staging))
      if (name !== marker)
        await move(path.join(staging, name), path.join(target, name));
    await move(path.join(staging, marker), path.join(target, marker));
  } catch (error) {
    error.details = { ...error.details, incompleteTarget: target };
    throw error;
  }
  await rm(staging, { recursive: true, force: true }).catch(() => {});
}
