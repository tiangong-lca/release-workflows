import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePnpmInvocation } from "./pnpm-invocation.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXPECTED_WORKSPACE_PACKAGES = [
  "@tiangong-lca/release",
  "@tiangong-lca/release-result-materialization-workflow",
  "@tiangong-lca/release-workflow-calculation",
  "@tiangong-lca/release-workflow-candidate",
  "@tiangong-lca/release-workflow-dataset-transformation",
  "@tiangong-lca/release-workflow-publication",
];
const RETIRED_PRODUCTION_PACKAGES = new Set([
  "typescript",
  "ts-to-zod",
  "@typescript/vfs",
]);
const PNPM_INVOCATION = resolvePnpmInvocation(process.env.npm_execpath);

test("the installed production graph uses SDK 0.6.0 without retired compiler/codegen", () => {
  const result = spawnSync(
    PNPM_INVOCATION.command,
    [
      ...PNPM_INVOCATION.prefixArgs,
      "list",
      "--recursive",
      "--prod",
      "--depth",
      "Infinity",
      "--json",
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      shell: false,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const roots = JSON.parse(result.stdout);
  assert.deepEqual(
    roots.map(({ name }) => name).sort(),
    EXPECTED_WORKSPACE_PACKAGES,
  );

  const installed = [];
  for (const root of roots) collectDependencies(root, installed);

  const retired = installed
    .filter((dependency) => RETIRED_PRODUCTION_PACKAGES.has(dependency.name))
    .map(({ name, version }) => `${name}@${version}`)
    .sort();
  const sdkVersions = [
    ...new Set(
      installed
        .filter(({ name }) => name === "@tiangong-lca/tidas-sdk")
        .map(({ version }) => version),
    ),
  ].sort();

  assert.deepEqual(sdkVersions, ["0.6.0"]);
  assert.deepEqual(retired, []);
});

function collectDependencies(node, collected) {
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    const item = { name, version: dependency.version ?? "unknown" };
    collected.push(item);
    collectDependencies(dependency, collected);
  }
}
