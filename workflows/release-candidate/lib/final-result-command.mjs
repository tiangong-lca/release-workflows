import path from "node:path";
import { writeFile } from "node:fs/promises";
import { canonicalJson, hashJson } from "./common.mjs";
import { planFinalResultVersions } from "./final-result-version-plan.mjs";
import { fileURLToPath } from "node:url";
import { fail } from "./common.mjs";
import {
  prepareFinalResultIntake,
  loadFinalResultIntake,
} from "./final-result-intake.mjs";
import { prepareFinalResultInput } from "./final-result-input.mjs";
import { createFinalResultIdentityStore } from "./final-result-identity.mjs";
import {
  buildFinalResultCandidate,
  loadFinalResultCandidate,
} from "./final-result-candidate.mjs";
import { RESULT_PACKAGE_PROFILE } from "./package-build.mjs";
import { replyTemplateFor } from "../reply-template-registry.mjs";
const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const PUBLICATION = fileURLToPath(
  new URL("../../publication/cli.mjs", import.meta.url),
);
const MATERIALIZE = fileURLToPath(
  new URL("../../result-materialization/cli.mjs", import.meta.url),
);
const TRANSFORM = fileURLToPath(
  new URL("../../dataset-transformation/cli.mjs", import.meta.url),
);
const quote = (s) => `'${String(s).replaceAll("'", `'"'"'`)}'`;
const command = (argv) => argv.map(quote).join(" ");
const next = (kind, description, args) => ({
  kind,
  description,
  argv: ["node", CLI, ...args],
  command: command(["node", CLI, ...args]),
});
const OPTIONS = {
  intake: [
    "release-intake",
    "materialization",
    "candidate",
    "transformation",
    "spec",
    "parent-materialization",
    "out-dir",
    "tidas-bin",
    "tidas-memory-budget-mib",
  ],
  inspect: ["result-intake"],
  versions: ["result-intake", "out-file"],
  register: ["result-intake", "confirm-input-sha256", "out-dir"],
  build: [
    "final-input",
    "confirm-input-sha256",
    "release-version",
    "out-dir",
    "tidas-bin",
    "tidas-memory-budget-mib",
    "hdf5-bin",
  ],
  verify: ["candidate"],
};
function required(options, names) {
  const missing = names.filter((n) => !options[n]);
  if (missing.length)
    fail(
      "invalid_arguments",
      `Missing required options: ${missing.map((n) => `--${n}`).join(", ")}`,
    );
}
function versionSuggestion() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${value.year}.${value.month}.0`;
}
export async function runFinalResultCommand(
  action,
  options,
  {
    env = process.env,
    createIdentityAuthority = () =>
      createFinalResultIdentityStore({ connectionString: env.CONN }),
  } = {},
) {
  if (!OPTIONS[action]) fail("unknown_command", "Unknown final Result command");
  for (const key of Object.keys(options))
    if (![...OPTIONS[action], "json", "help"].includes(key))
      fail(
        "invalid_arguments",
        `Option --${key} is not accepted by result ${action}`,
      );
  const base = {
    ok: true,
    command: `result ${action}`,
    publicationAuthorized: false,
    profile: RESULT_PACKAGE_PROFILE,
    replyTemplate: replyTemplateFor(`result ${action}`, { ok: true }),
  };
  const toolOptions = {
    tidasBin: options["tidas-bin"],
    memoryBudgetMiB:
      options["tidas-memory-budget-mib"] ?? env.TIDAS_MEMORY_BUDGET_MIB,
  };
  if (action === "intake") {
    required(options, ["out-dir"]);
    const built = await prepareFinalResultIntake({
      releaseIntakeDir: options["release-intake"],
      materializationDir: options.materialization,
      candidateDir: options.candidate,
      transformationDir: options.transformation,
      specDir: options.spec,
      parentMaterializationDir: options["parent-materialization"],
      outDir: options["out-dir"],
      ...toolOptions,
    });
    return {
      ...base,
      outcome: "final_result_intake_prepared",
      completeness: "producer-and-standard-closure-verified",
      resultIntake: built.path,
      inputHash: built.manifest.inputHash,
      identityRegistered: false,
      artifacts: {
        manifest: path.join(built.path, "final-result-intake.json"),
        inspection: path.join(built.path, "input-inspection.json"),
      },
      nextActions: [
        next(
          "inspect_final_input",
          "Review exact contents before separately authorizing identity registration",
          ["result", "inspect", "--result-intake", built.path, "--json"],
        ),
      ],
    };
  }
  if (action === "versions") {
    required(options, ["result-intake", "out-file"]);
    const intake = await loadFinalResultIntake(options["result-intake"]);
    const output = path.resolve(options["out-file"]);
    if (
      output === intake.root ||
      output.startsWith(`${intake.root}${path.sep}`)
    )
      fail(
        "invalid_arguments",
        "Write the advisory version plan outside the immutable intake",
      );
    const plan = await planFinalResultVersions({
      inputPlan: intake.plan,
      createAuthority: createIdentityAuthority,
    });
    await writeFile(output, canonicalJson(plan), { flag: "wx", mode: 0o600 });
    const conflicts = plan.entries.filter((e) => e.reason === "conflict");
    return {
      ...base,
      outcome: "final_result_versions_planned",
      completeness: "advisory-occupancy-snapshot",
      inputHash: plan.inputHash,
      planHash: hashJson(plan),
      resultCount: plan.entries.length,
      conflictCount: conflicts.length,
      identityRegistered: false,
      artifacts: { versionPlan: output },
      nextActions: conflicts.length
        ? [
            {
              kind: "regenerate_upstream",
              description:
                "Direct: rerun the same Materialization request with --result-version-plan and this file. Derived: explicitly adopt toVersion and its matching URI in a new Transformation Draft, then inspect/freeze/execute and materialize derived. Rebuild Result Intake, inspect, register and build; never edit frozen artifacts or relabel existing HDF5/ZIP.",
              versionPlan: output,
              argv: conflicts.some((e) => e.relationKind === "derived")
                ? ["node", TRANSFORM, "dsl", "inspect", "--help"]
                : ["node", MATERIALIZE, "materialize", "--help"],
              command: command(
                conflicts.some((e) => e.relationKind === "derived")
                  ? ["node", TRANSFORM, "dsl", "inspect", "--help"]
                  : ["node", MATERIALIZE, "materialize", "--help"],
              ),
            },
          ]
        : [
            next(
              "inspect_final_input",
              "Occupancy is advisory; atomic registration still rechecks exact content",
              ["result", "inspect", "--result-intake", intake.root, "--json"],
            ),
          ],
    };
  }
  if (action === "inspect" || action === "register") {
    required(options, [
      "result-intake",
      ...(action === "register" ? ["confirm-input-sha256", "out-dir"] : []),
    ]);
    const intake = await loadFinalResultIntake(options["result-intake"]);
    const counts = {
      resultCount: intake.results.length,
      datasetCount: intake.index.datasets.length,
      derivedCount: intake.plan.lineage.results.filter(
        (r) => r.relationKind === "derived",
      ).length,
    };
    if (action === "inspect")
      return {
        ...base,
        outcome: "final_result_input_inspected",
        completeness: "exact-input-verified",
        ...counts,
        resultIntake: intake.root,
        inputHash: intake.plan.inputHash,
        identityRegistered: false,
        artifacts: {
          inspection: path.join(intake.root, "input-inspection.json"),
        },
        nextActions: [
          next(
            "register_final_identity",
            "Requires explicit authorization: claims immutable identities in the database configured by CONN",
            [
              "result",
              "register",
              "--result-intake",
              intake.root,
              "--confirm-input-sha256",
              intake.plan.inputHash,
              "--out-dir",
              `${intake.root}.registered`,
              "--json",
            ],
          ),
        ],
      };
    const frozen = await prepareFinalResultInput({
      ...intake,
      confirmInputHash: options["confirm-input-sha256"],
      outDir: options["out-dir"],
      createAuthority: createIdentityAuthority,
    });
    return {
      ...base,
      outcome: "final_result_identities_registered",
      completeness: "all-identities-registered-input-frozen",
      ...counts,
      finalInput: frozen.path,
      inputHash: frozen.input.inputHash,
      identityRegistered: true,
      artifacts: {
        finalInput: path.join(frozen.path, "final-result-input.json"),
        receipts: path.join(frozen.path, "registration-receipts.ndjson"),
      },
      nextActions: [
        next(
          "build_paired_candidate",
          "Review the release filename version before building a local Candidate",
          [
            "result",
            "build",
            "--final-input",
            frozen.path,
            "--confirm-input-sha256",
            frozen.input.inputHash,
            "--out-dir",
            `${frozen.path}.candidate`,
            "--json",
          ],
        ),
      ],
    };
  }
  if (action === "build") {
    required(options, ["final-input", "confirm-input-sha256", "out-dir"]);
    if (!options["release-version"]) {
      const recommendedVersion = versionSuggestion();
      const args = [
        "result",
        "build",
        "--final-input",
        path.resolve(options["final-input"]),
        "--confirm-input-sha256",
        options["confirm-input-sha256"],
        "--release-version",
        recommendedVersion,
        "--out-dir",
        path.resolve(options["out-dir"]),
      ];
      for (const k of ["tidas-bin", "tidas-memory-budget-mib", "hdf5-bin"])
        if (options[k]) args.push(`--${k}`, options[k]);
      args.push("--json");
      return {
        ...base,
        outcome: "release_version_confirmation_required",
        completeness: "decision_required",
        recommendedVersion,
        fileNames: ["tidas", "ilcd"].map(
          (f) => `TiangongLCA-${recommendedVersion}-ResultDatabase.${f}.zip`,
        ),
        nextActions: [
          next(
            "confirm_release_version",
            "Confirm or replace the suggested filename version before executing",
            args,
          ),
        ],
        replyTemplate: replyTemplateFor("result build", {
          ok: true,
          outcome: "release_version_confirmation_required",
        }),
      };
    }
    const built = await buildFinalResultCandidate({
      finalInputDir: options["final-input"],
      confirmInputHash: options["confirm-input-sha256"],
      outDir: options["out-dir"],
      releaseVersion: options["release-version"],
      encoder: options["hdf5-bin"],
      ...toolOptions,
    });
    return {
      ...base,
      outcome: "paired_result_candidate_built",
      completeness: "registered-content-and-paired-files-qualified",
      candidate: built.path,
      inputHash: built.candidate.inputHash,
      releaseVersion: built.candidate.releaseVersion,
      packageCount: built.candidate.packages.length,
      queryArtifactCount: built.candidate.queryArtifacts.length,
      candidateQualified: true,
      artifacts: {
        candidate: path.join(built.path, "release-candidate.json"),
        queryResults: path.join(built.path, "query-results.json"),
      },
      nextActions: [
        next(
          "verify_paired_candidate",
          "Recheck the immutable files before another workflow consumes them",
          ["result", "verify", "--candidate", built.path, "--json"],
        ),
      ],
    };
  }
  required(options, ["candidate"]);
  const checked = await loadFinalResultCandidate(options.candidate);
  return {
    ...base,
    outcome: "paired_result_candidate_verified",
    completeness: "all-bound-files-and-results-verified",
    candidate: checked.root,
    inputHash: checked.candidate.inputHash,
    resultCount: checked.input.results.length,
    packageCount: checked.candidate.packages.length,
    queryArtifactCount: checked.candidate.queryArtifacts.length,
    candidateQualified: true,
    artifacts: { candidate: path.join(checked.root, "release-candidate.json") },
    publicationIntegration: "final-result-publication-v2",
    nextActions: [
      {
        kind: "inspect_final_result_storage",
        description:
          "Inspect the exact Candidate storage plan locally; explicit target settings are required. Upload, readiness, approval, activation and public readback remain separate authorized steps.",
        argv: [
          "node",
          PUBLICATION,
          "result-storage",
          "inspect",
          "--candidate",
          checked.root,
          "--out-dir",
          `${checked.root}.storage-plan`,
          "--json",
        ],
        command: command([
          "node",
          PUBLICATION,
          "result-storage",
          "inspect",
          "--candidate",
          checked.root,
          "--out-dir",
          `${checked.root}.storage-plan`,
          "--json",
        ]),
      },
      {
        kind: "inspect_transformation",
        description:
          "Optional Result transformation; publication requires the separate v2 adapter",
        command: command(["node", TRANSFORM, "dsl", "inspect", "--help"]),
        argv: ["node", TRANSFORM, "dsl", "inspect", "--help"],
      },
    ],
  };
}
// No raw provider/stdout/SQL errors or arbitrary details enter the public CLI.
export function finalResultFailure(error) {
  const code = /^[a-z][a-z0-9_]{1,100}$/u.test(error.code ?? "")
    ? error.code
    : "final_result_command_failed";
  const details = {};
  for (const k of [
    "retainedInput",
    "retainedIntake",
    "retainedPairBuild",
    "retainedCandidateBuild",
    "incompleteTarget",
  ])
    if (
      typeof error.details?.[k] === "string" &&
      path.isAbsolute(error.details[k])
    )
      details[k] = error.details[k];
  const message =
    code === "final_identity_outcome_unknown"
      ? "Identity registration outcome is unknown. Reconcile retained requests or retry identical content; do not change versions."
      : [
            "final_identity_content_conflict",
            "final_identity_legacy_occupied",
            "final_input_version_occupied",
          ].includes(code)
        ? "The exact Result version is occupied. Use result versions for a read-only plan, regenerate upstream content, and inspect a new input."
        : code === "final_identity_connection_required"
          ? "Identity authority access requires the protected CONN environment setting; never pass credentials as CLI arguments."
          : code.includes("confirmation")
            ? "The confirmation hash must equal the inspected immutable input hash."
            : [
                  "invalid_arguments",
                  "unknown_option",
                  "duplicate_option",
                ].includes(code)
              ? error.message
              : "Final Result operation did not complete. Inspect the retained evidence and the command help; no publication was authorized.";
  return { code, message, details };
}
