#!/usr/bin/env node
import {
  configureReleaseCli,
  isDirectEntry,
  attachReleaseConfiguration,
} from "../environment/lib/cli-configuration.mjs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
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
      usage: `${fileURLToPath(import.meta.url)} --artifact-dir PATH [--config-env FILE] --builder ABSOLUTE_WORKER_CLI --package-id UUID --release-run-id UUID --confirm-manifest SHA256`,
      action:
        "Upload verified Worker artifacts, independently read back, register and bind. Does not approve or publish.",
      environment:
        "Uses the common Release configuration loader; no secret CLI arguments.",
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
if (isDirectEntry(import.meta.url)) {
  try {
    const context = await configureReleaseCli(
      "query-artifact",
      process.argv.slice(2),
    );
    console.log(
      JSON.stringify(
        attachReleaseConfiguration(
          await runQueryArtifactCli(
            context.argv.includes("--help") ? ["--help"] : context.argv,
          ),
          context,
        ),
      ),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        code: String(error.code).startsWith("final_environment_")
          ? error.code
          : "query_artifact_registration_failed",
        recovery: String(error.code).startsWith("final_environment_")
          ? "Correct shared Release configuration and run Environment check before any upload or registration."
          : "Inspect the exact artifact, package and release identities. A remote outcome may be partial or unknown. Retry only the same immutable inputs; never rebuild or publish automatically.",
      }),
    );
    process.exitCode = 1;
  }
}
