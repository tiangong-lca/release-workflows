const ROOT = "workflows/release-candidate/reply-templates";

const templates = Object.freeze({
  "cache status": [
    "elementary-flow-cache",
    "elementary-flow-cache.md",
    ["cache", "status", "recordCount", "databaseWatermark", "nextActions"],
  ],
  "cache refresh": [
    "elementary-flow-cache",
    "elementary-flow-cache.md",
    ["cache", "status", "recordCount", "databaseWatermark", "nextActions"],
  ],
  "intake prepare": [
    "release-intake-prepared",
    "release-intake-prepared.md",
    [
      "releaseIntake",
      "addedExactFlowCount",
      "uniqueReferenceCount",
      "elementaryFlowCacheRecordCount",
      "artifacts",
      "nextActions",
    ],
  ],
  "failure analyze": [
    "release-exclusion-impact-analyzed",
    "release-exclusion-impact-analyzed.md",
    [
      "impactReport",
      "impactReportSha256",
      "reviewWorkbookRequired",
      "nextActions",
    ],
  ],
  "failure review": [
    "release-exclusion-impact",
    "release-exclusion-impact.md",
    [
      "impactReport",
      "impactReportSha256",
      "reviewWorkbook",
      "reviewWorkbookSha256",
      "invalidDatasetCount",
      "affectedRootCount",
      "affectedMaterializedDatasetCount",
      "newlyUnreachableSupportDatasetCount",
      "excludedDatasetCount",
      "originalDatasetCount",
      "resultingDatasetCount",
      "remainingReferenceConflictCount",
      "safeToExclude",
      "choices",
      "nextActions",
    ],
  ],
  "failure decide": [
    "release-scope-decision",
    "release-scope-decision.md",
    [
      "action",
      "decidedAt",
      "decidedBy",
      "scopeDecision",
      "scopeDecisionSha256",
      "publicationAuthorized",
      "artifacts",
      "nextActions",
    ],
  ],
  ...Object.fromEntries(
    ["intake", "inspect", "register", "build", "verify"].map((action) => [
      `result ${action}`,
      [
        "final-result-workflow",
        "final-result-workflow.md",
        [
          "command",
          "outcome",
          "completeness",
          "artifacts",
          "publicationAuthorized",
          "nextActions",
        ],
      ],
    ]),
  ),
  "package build": [
    "release-candidate-built",
    "release-candidate-built.md",
    [
      "candidate",
      "profile",
      "releaseVersion",
      "packageCount",
      "packageSetHash",
      "publicationAuthorized",
      "artifacts",
      "nextDecision",
      "nextActions",
    ],
  ],
});

const inputDriftCodes = new Set([
  "materialized_dataset_hash_mismatch",
  "source_closure_hash_mismatch",
  "source_dataset_hash_mismatch",
  "materialization_manifest_hash_mismatch",
  "canonical_index_hash_mismatch",
]);

export function replyTemplateFor(
  command,
  { ok, outcome, errorCode, retainedBuild } = {},
) {
  const entry =
    outcome === "release_version_confirmation_required"
      ? [
          "release-version-confirmation-required",
          "release-version-confirmation-required.md",
          ["recommendedVersion", "fileNames", "nextActions"],
        ]
      : retainedBuild
        ? [
            "release-package-validation-failed",
            "release-package-validation-failed.md",
            [
              "command",
              "error",
              "artifacts",
              "publicationAuthorized",
              "nextActions",
            ],
          ]
        : ok
          ? templates[command]
          : inputDriftCodes.has(errorCode)
            ? [
                "release-input-drift",
                "release-input-drift.md",
                ["command", "error", "nextActions"],
              ]
            : [
                "release-command-failed",
                "release-command-failed.md",
                ["command", "error", "nextActions"],
              ];
  if (!entry) return undefined;
  const [id, filename, requiredFacts] = entry;
  return {
    id,
    path: `${ROOT}/${filename}`,
    format: "markdown",
    placeholderSyntax: "{{...}}",
    requiredFacts,
  };
}

export const REPLY_TEMPLATE_COMMANDS = Object.freeze(Object.keys(templates));
