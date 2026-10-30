#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { registerQueryArtifact } from "./adapters/query-artifact-store.mjs";

export async function runQueryArtifactCli(
  args,
  operation = registerQueryArtifact,
) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean" },
      "artifact-dir": { type: "string" },
      builder: { type: "string" },
      "package-id": { type: "string" },
      "release-run-id": { type: "string" },
      "confirm-manifest": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help)
    return {
      usage: `${fileURLToPath(import.meta.url)} --artifact-dir PATH --builder ABSOLUTE_WORKER_CLI --package-id UUID --release-run-id UUID --confirm-manifest SHA256`,
      action:
        "Upload verified Worker artifacts, independently read back, register and bind. Does not approve or publish.",
      environment:
        "CONN and S3_* must be explicitly supplied by the operator; no secret CLI arguments.",
    };
  if (
    !values["artifact-dir"] ||
    !values.builder ||
    !values["package-id"] ||
    !values["release-run-id"] ||
    !values["confirm-manifest"]
  )
    throw new Error("query_artifact_arguments_required");
  return operation({
    directory: values["artifact-dir"],
    builder: values.builder,
    packageId: values["package-id"],
    releaseRunId: values["release-run-id"],
    confirmManifest: values["confirm-manifest"],
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(await runQueryArtifactCli(process.argv.slice(2))),
    );
  } catch {
    console.log(
      JSON.stringify({
        ok: false,
        code: "query_artifact_registration_failed",
        recovery:
          "Inspect the exact artifact, package and release identities. A remote outcome may be partial or unknown. Retry only the same immutable inputs; never rebuild or publish automatically.",
      }),
    );
    process.exitCode = 1;
  }
}
