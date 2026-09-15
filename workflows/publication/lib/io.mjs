import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail, hashJson, sha256Bytes } from "./common.mjs";

export async function readJson(file, code = "artifact_missing") {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    fail(code, `Required artifact is unavailable: ${file}`, {
      cause: error?.code ?? "unknown",
    });
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    fail("artifact_json_invalid", `Artifact is not valid JSON: ${file}`);
  }
}

export async function assertAbsent(target) {
  try {
    await access(target);
    fail("output_exists", `Refusing to overwrite existing output: ${target}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function writeImmutableDirectory(target, build) {
  await assertAbsent(target);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(`${target}.tmp-`);
  try {
    await build(staging);
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function writeCanonical(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, canonicalJson(value), { flag: "wx" });
}

export function verifyJsonHash(value, expected, code, label) {
  const observed = hashJson(value);
  if (observed !== expected)
    fail(code, `${label} hash has drifted`, { expected, observed });
  return observed;
}

export function verifyBytes(bytes, expected, code, label) {
  const observed = sha256Bytes(bytes);
  if (observed !== expected)
    fail(code, `${label} bytes have drifted`, { expected, observed });
  return observed;
}

export function containedPath(root, relative, code = "artifact_path_escape") {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative
      .split(/[\\/]/u)
      .some((part) => !part || part === "." || part === "..")
  )
    fail(code, `Unsafe relative artifact path: ${relative}`);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`))
    fail(code, `Artifact path escapes its root: ${relative}`);
  return target;
}

export function assertExactObject(value, allowedKeys, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(code, `${label} must be an object`);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length)
    fail(code, `${label} contains unknown fields`, { unknown: unknown.sort() });
  return value;
}

/**
 * Recursively reject unknown fields.
 *
 * `shape` mirrors the artifact structure:
 *   - a nested object recurses into the child object;
 *   - a one-element array recurses into every element;
 *   - `undefined` requires the key to be present but does not constrain its
 *     value type (the CLI validates those values explicitly);
 *   - `null` requires the key to be present and exactly null.
 */
export function deepAssertExactObject(value, shape, code, label = "") {
  const at = label.trim();
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(code, `${at || "Artifact"} must be an object`);
  const unknown = Object.keys(value).filter((key) => !(key in shape));
  if (unknown.length)
    fail(code, `${at || "Artifact"} contains unknown fields`, {
      unknown: unknown.sort(),
      at: at || null,
    });
  for (const [key, child] of Object.entries(shape)) {
    const next = `${at}.${key}`;
    if (!(key in value)) fail(code, `${next} is missing`, { at: next });
    const childValue = value[key];
    if (Array.isArray(child)) {
      if (!Array.isArray(childValue))
        fail(code, `${next} must be an array`, { at: next });
      for (const [index, item] of childValue.entries())
        deepAssertExactObject(item, child[0], code, `${next}[${index}]`);
      continue;
    }
    if (child && typeof child === "object") {
      deepAssertExactObject(childValue, child, code, next);
      continue;
    }
    if (child === null && childValue !== null)
      fail(code, `${next} must be null`, { at: next });
  }
  return value;
}
