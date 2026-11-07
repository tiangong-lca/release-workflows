import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail } from "./common.mjs";

export const SEVEN_ZIP_VERSION = "26.05";
const MAX_MEMBERS = 2_000_000;
const MAX_UNPACKED = 32 * 1024 ** 3;
const qualified = new Map();
const binary = () =>
  process.env.RELEASE_7ZIP_BIN ?? (process.platform === "win32" ? "7z" : "7zz");

// Use the same qualified implementation and fixed parameters as the real-data
// benchmark. This is a local tool dependency, never a provider/data connection.
export function runSevenZip(args, { cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary(), args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      pending = "",
      failure;
    const timer = setTimeout(
      () => {
        failure = Object.assign(
          new Error("7-Zip exceeded the local archive timeout"),
          { code: "final_archive_timeout" },
        );
        child.kill();
      },
      30 * 60 * 1000,
    );
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-65536);
      if (!onLine || failure) return;
      try {
        const lines = (pending + chunk).split("\n");
        pending = lines.pop();
        if (pending.length > 65536)
          fail(
            "final_archive_catalog_invalid",
            "Archive catalog line is too long",
          );
        for (const line of lines) onLine(line.replace(/\r$/u, ""));
      } catch (error) {
        failure = error;
        child.kill();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-65536);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        Object.assign(
          new Error(
            `Install 7-Zip ${SEVEN_ZIP_VERSION} and set RELEASE_7ZIP_BIN to its console executable`,
          ),
          { code: "final_archive_tool_missing" },
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        if (failure) throw failure;
        if (pending && onLine) onLine(pending.replace(/\r$/u, ""));
        resolve({ code, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function requireSevenZip() {
  const executable = binary();
  if (!qualified.has(executable))
    qualified.set(
      executable,
      (async () => {
        const result = await runSevenZip(["i"]);
        if (
          result.code !== 0 ||
          !/^7-Zip(?: \([^\n]*\))? 26\.05(?: |\r?$)/mu.test(result.stdout)
        )
          fail(
            "final_archive_tool_version",
            `Result archives require qualified 7-Zip ${SEVEN_ZIP_VERSION}; set RELEASE_7ZIP_BIN`,
          );
      })().catch((error) => {
        qualified.delete(executable);
        throw error;
      }),
    );
  await qualified.get(executable);
}

function safeMember(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 65535 ||
    /[\\:\x00-\x1f\x7f*?]/u.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((p) => !p || p === "." || p === "..")
  )
    fail(
      "final_archive_member_invalid",
      "Archive contains an unsafe member path",
    );
  return name;
}

export async function inspectSevenZip(archive) {
  await requireSevenZip();
  const members = new Map();
  let entry = {},
    unpackedBytes = 0;
  const flush = () => {
    if (!Object.keys(entry).length) return;
    const name = safeMember(entry.Path);
    const size = Number(entry.Size);
    if (
      members.has(name) ||
      members.size >= MAX_MEMBERS ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      entry.Folder === "+" ||
      entry.Encrypted === "+" ||
      /[dl]/u.test(entry.Attributes ?? "") ||
      "Symbolic Link" in entry ||
      "Hard Link" in entry ||
      size > MAX_UNPACKED - unpackedBytes
    )
      fail(
        "final_archive_catalog_invalid",
        "Archive catalog exceeds limits or contains unsupported members",
      );
    members.set(name, size);
    unpackedBytes += size;
    entry = {};
  };
  const result = await runSevenZip(
    ["l", "-slt", "-ba", "-sccUTF-8", "--", path.resolve(archive)],
    {
      onLine(line) {
        if (!line) return flush();
        const split = line.indexOf(" = ");
        if (split < 1 || Object.keys(entry).length > 32 || line.length > 65536)
          fail(
            "final_archive_catalog_invalid",
            "Invalid archive catalog record",
          );
        const key = line.slice(0, split);
        if (Object.hasOwn(entry, key))
          fail("final_archive_catalog_invalid", "Duplicate archive property");
        entry[key] = line.slice(split + 3);
      },
    },
  );
  flush();
  if (result.code !== 0 || !members.size)
    fail("final_archive_invalid", "Cannot list complete archive contents");
  return { members, memberCount: members.size, unpackedBytes };
}

async function fileTree(root) {
  const files = new Map();
  async function visit(relative = "") {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const name = safeMember(
        relative ? `${relative}/${entry.name}` : entry.name,
      );
      if (entry.isSymbolicLink())
        fail(
          "final_archive_member_invalid",
          "Archive trees must not contain symlinks",
        );
      if (entry.isDirectory()) {
        await visit(name);
        continue;
      }
      if (!entry.isFile() || files.size >= MAX_MEMBERS)
        fail("final_archive_member_invalid", "Invalid archive tree member");
      const file = path.join(root, name);
      const info = await lstat(file);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      files.set(name, { size: info.size, sha256: hash.digest("hex") });
    }
  }
  await visit();
  return files;
}

export async function extractSevenZip(archive, destination) {
  const catalog = await inspectSevenZip(archive);
  await mkdir(destination); // Must be a fresh caller-owned directory.
  const result = await runSevenZip([
    "x",
    "-y",
    "-bb0",
    "-bsp0",
    "-sccUTF-8",
    `-o${path.resolve(destination)}`,
    "--",
    path.resolve(archive),
  ]);
  if (result.code !== 0)
    fail("final_archive_invalid", "Archive extraction failed");
  const actual = await fileTree(destination);
  if (
    actual.size !== catalog.memberCount ||
    [...actual].some(([name, file]) => catalog.members.get(name) !== file.size)
  )
    fail(
      "final_archive_member_mismatch",
      "Extracted files differ from the complete archive catalog",
    );
  return { ...catalog, files: actual };
}

export async function withSevenZipReadback(archive, action) {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "release-7z-readback-"),
  );
  try {
    const root = path.join(temporary, "files");
    await extractSevenZip(archive, root);
    return await action(root);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// The Toolkit ZIP is a validated, local intermediate. Only the final 7z bytes
// enter the paired receipt, Candidate and publication package descriptors.
export async function compressResultPackage(zipPath, output) {
  await requireSevenZip();
  try {
    await lstat(output);
    fail("output_exists", "Archive output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = await mkdtemp(path.join(path.dirname(output), ".7z-work-"));
  try {
    const source = path.join(temporary, "source");
    const original = await extractSevenZip(zipPath, source);
    for (const name of original.files.keys())
      await chmod(path.join(source, name), 0o644);
    const list = path.join(temporary, "members.txt");
    await writeFile(list, [...original.files.keys()].sort().join("\n") + "\n", {
      flag: "wx",
    });
    const result = await runSevenZip(
      [
        "a",
        "-t7z",
        "-m0=LZMA2",
        "-mx=9",
        "-md=256m",
        "-ms=4g",
        "-mmt=8",
        "-mtc=off",
        "-mta=off",
        "-mtm=off",
        "-bb0",
        "-bsp0",
        "-scsUTF-8",
        "-sccUTF-8",
        "-spd",
        "-ssc",
        path.resolve(output),
        `@${list}`,
      ],
      { cwd: source },
    );
    if (result.code !== 0)
      fail(
        "final_archive_compression_failed",
        "7-Zip could not encode the Result archive",
      );
    const readback = await extractSevenZip(
      output,
      path.join(temporary, "readback"),
    );
    if (
      original.files.size !== readback.files.size ||
      [...original.files].some(([name, expected]) => {
        const actual = readback.files.get(name);
        return (
          actual?.size !== expected.size || actual?.sha256 !== expected.sha256
        );
      })
    )
      fail(
        "final_archive_content_mismatch",
        "Final 7z contents differ from the validated Toolkit package",
      );
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
