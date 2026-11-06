import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export function candidateNextDecision() {
  const publication = helpCommand("publication", ["plan", "prepare"]);
  const transformation = helpCommand("dataset-transformation", [
    "dsl",
    "inspect",
  ]);
  return {
    required: true,
    prompt: "Choose the next path for this immutable Candidate.",
    choices: [
      {
        id: "plan_publication_scope",
        label: "Plan Publication",
        workflow: "publication",
        availability: "available",
        description:
          "Enter Publication to choose Unit Process, Result, Both, or exact datasets and prepare a dependency-closed, unauthorized Publish Plan without changing this Candidate.",
        ...publication,
      },
      {
        id: "transform_candidate_data",
        label: "Transform Candidate data",
        workflow: "dataset-transformation",
        availability: "available",
        description:
          "Inspect, freeze and execute weighted Unit/Result Transformation after the required user decisions. Completion produces local output and a handoff, not a new Candidate: Use materialize derived followed by the explicit result intake/inspect/freeze/build route for a paired Result-only Candidate; its v2 publication adapter remains required. Unit outputs require new calculation through its supported input and authorization contract.",
        ...transformation,
      },
    ],
  };
}

function helpCommand(workflow, action) {
  const entry = fileURLToPath(
    new URL(`../../${workflow}/cli.mjs`, import.meta.url),
  );
  const argv = ["node", entry, ...action, "--help"];
  const quotedEntry = `'${entry.replaceAll("'", `'\\''`)}'`;
  return { command: `node ${quotedEntry} ${action.join(" ")} --help`, argv };
}

export function intakeContinuation({
  releaseIntake,
  outputRoot,
  deliveryFormat,
}) {
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
  const choices = [
    {
      id: "result-7z-hdf5",
      label: "Result 7z + HDF5",
      description:
        "Result-only two 7z archives and paired LCI/LCIA HDF5. Continue through intake, inspect, freeze, then build offline; no new calculation.",
      args: [
        "result",
        "intake",
        "--release-intake",
        releaseIntake,
        "--out-dir",
        `${outputRoot}/result-intakes/${basename(releaseIntake)}`,
        "--json",
      ],
    },
    {
      id: "legacy-four-zips",
      label: "Legacy four ZIPs (no HDF5)",
      description:
        "Unit Process, Result and LifecycleModel distribution profile. This route does not generate HDF5.",
      args: [
        "package",
        "build",
        "--release-intake",
        releaseIntake,
        "--profile",
        "standalone-lifecyclemodel-result-full-closure.v1",
        "--out-dir",
        `${outputRoot}/candidates/${basename(releaseIntake)}`,
        "--json",
      ],
    },
  ].map(({ args, ...choice }) => {
    const argv = ["node", cli, ...args];
    return { ...choice, argv, command: argv.map(quote).join(" ") };
  });
  if (
    deliveryFormat !== undefined &&
    !choices.some((c) => c.id === deliveryFormat)
  )
    throw Object.assign(
      new Error("--delivery-format must be result-7z-hdf5 or legacy-four-zips"),
      { code: "invalid_arguments" },
    );
  return {
    deliveryFormat: deliveryFormat ?? null,
    nextDecision: {
      required: deliveryFormat === undefined,
      prompt:
        "Select the required deliverables; reuse an already stated user choice.",
      choices,
    },
    nextActions:
      deliveryFormat === undefined
        ? []
        : [choices.find((c) => c.id === deliveryFormat)],
  };
}

const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
