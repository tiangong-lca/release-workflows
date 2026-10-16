import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePnpmInvocation } from "./pnpm-invocation.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKSPACE_PACKAGES = [
  "workflows/calculation",
  "workflows/result-materialization",
  "workflows/release-candidate",
  "workflows/dataset-transformation",
  "workflows/publication",
];
const PACKAGE_MANIFESTS = [".", ...WORKSPACE_PACKAGES];
const PNPM_INVOCATION = resolvePnpmInvocation(process.env.npm_execpath);

test("the repository pins one exact Node and pnpm toolchain", () => {
  const rootManifest = readJson("package.json");
  assert.equal(rootManifest.packageManager, "pnpm@11.24.0");
  assert.equal(readText(".node-version").trim(), "24.22.0");

  for (const directory of PACKAGE_MANIFESTS) {
    const relativePath = path.join(directory, "package.json");
    const manifest = readJson(relativePath);
    assert.equal(
      manifest.engines?.node,
      "24.22.0",
      `${relativePath} must reject every other Node release`,
    );
  }

  const result = spawnSync(
    PNPM_INVOCATION.command,
    [
      ...PNPM_INVOCATION.prefixArgs,
      "config",
      "list",
      "--location=project",
      "--json",
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      shell: false,
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const effectiveConfig = JSON.parse(result.stdout);
  assert.equal(effectiveConfig.engineStrict, true);
  assert.equal(effectiveConfig.strictPeerDependencies, true);
  assert.equal(effectiveConfig.sharedWorkspaceLockfile, true);
  assert.equal(effectiveConfig.savePrefix, "");
  assert.equal(effectiveConfig.pmOnFail, "error");
  assert.equal(existsSync(new URL("../.npmrc", import.meta.url)), false);
});

test("the six install trees are one pnpm workspace with one lockfile", () => {
  const workspace = readText("pnpm-workspace.yaml");
  for (const packagePath of WORKSPACE_PACKAGES) {
    assert.match(workspace, new RegExp(escapeRegex(packagePath)));
  }

  const packageLocks = findFiles(REPOSITORY_ROOT, "package-lock.json");
  const pnpmLocks = findFiles(REPOSITORY_ROOT, "pnpm-lock.yaml");
  assert.deepEqual(packageLocks, []);
  assert.deepEqual(pnpmLocks, [path.join(REPOSITORY_ROOT, "pnpm-lock.yaml")]);
});

test("active package commands and automation are pnpm-only", () => {
  for (const directory of PACKAGE_MANIFESTS) {
    const relativePath = path.join(directory, "package.json");
    const scripts = JSON.stringify(readJson(relativePath).scripts ?? {});
    assert.doesNotMatch(scripts, /(^|[\s"'])npm(?=\s|$)/m, relativePath);
  }

  for (const relativePath of [
    "AGENTS.md",
    "workflows/result-materialization/AGENTS.md",
    "workflows/result-materialization/README.md",
    "workflows/release-candidate/README.md",
    "workflows/publication/README.md",
  ]) {
    assert.doesNotMatch(
      readText(relativePath),
      /(^|\s)npm(?:\s+(?:ci|install|run)|\s+--prefix)/m,
      relativePath,
    );
  }

  const ci = readText(".github/workflows/ci.yml");
  assert.match(
    ci,
    /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6/,
  );
  assert.match(
    ci,
    /pnpm\/setup@84cb39b217b10273981911c288cd62326dc7c6d2 # v2\.0\.2/,
  );
  assert.match(ci, /version:\s*11\.24\.0/);
  assert.match(ci, /runtime:\s*node@24\.22\.0/);
  assert.match(ci, /cache:\s*true/);
  assert.match(ci, /install:\s*false/);
  assert.doesNotMatch(ci, /pnpm\/action-setup@/);
  assert.doesNotMatch(ci, /actions\/setup-node@/);
  assert.match(ci, /pnpm install --frozen-lockfile/);
  assert.match(ci, /pnpm run prepush:gate/);
  assert.doesNotMatch(ci, /(^|\s)npm(?:\s|$)/m);
});

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8");
}

function findFiles(directory, basename) {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", ".release", "node_modules"].includes(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...findFiles(absolutePath, basename));
    else if (entry.name === basename) matches.push(absolutePath);
  }
  return matches.sort();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
