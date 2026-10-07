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
          "Inspect, freeze and execute weighted Unit/Result Transformation after the required user decisions. Completion produces local output and a handoff, not a new Candidate: Derived Result consumption by Materialization and Result-only Candidate packaging are not implemented. Unit outputs require new calculation through its supported input and authorization contract.",
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
