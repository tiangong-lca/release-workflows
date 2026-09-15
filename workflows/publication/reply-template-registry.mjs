const ROOT = "workflows/publication/reply-templates";

const portalPlanPrepared = [
  "portal-lcia-plan-prepared",
  "portal-lcia-plan-prepared.md",
  ["command", "outcome", "completeness", "artifacts", "nextActions"],
];

const portalPublicationEvent = [
  "portal-lcia-publication-event",
  "portal-lcia-publication-event.md",
  ["command", "outcome", "completeness", "artifacts", "nextActions"],
];

const portalCommandFailed = [
  "portal-lcia-command-failed",
  "portal-lcia-command-failed.md",
  ["command", "outcome", "completeness", "error", "nextActions"],
];

const templates = Object.freeze({
  "plan prepare": [
    "publish-plan-prepared",
    "publish-plan-prepared.md",
    [
      "candidate",
      "component",
      "targetId",
      "requestedRootCount",
      "dependencyAdditionCount",
      "prunedDatasetCount",
      "effectiveDatasetCount",
      "effectiveSetHash",
      "publicationDraftPlanSha256",
      "publicationAuthorized",
      "artifacts",
      "nextActions",
    ],
  ],
  "payload materialize": [
    "publication-payload-materialized",
    "publication-payload-materialized.md",
    [
      "datasetCount",
      "datasetSetHash",
      "payloadManifestSha256",
      "artifacts",
      "nextActions",
    ],
  ],
  "target inspect": [
    "publication-target-inspected",
    "publication-target-inspected.md",
    [
      "datasetCount",
      "targetFingerprint",
      "publishedState",
      "executablePlanSha256",
      "artifacts",
      "nextActions",
    ],
  ],
  "approval create": [
    "publication-approved",
    "publication-approved.md",
    [
      "executablePlanSha256",
      "approvalSha256",
      "approvedBy",
      "expiresAt",
      "artifacts",
      "nextActions",
    ],
  ],
  "result-process prepare": [
    "publication-result-process-prepared",
    "publication-result-process-prepared.md",
    [
      "completeness",
      "operationCount",
      "targetStateCode",
      "sourceKind",
      "operationSetHash",
      "preparationSha256",
      "preparationHash",
      "preparationClassification",
      "existingState",
      "artifacts",
      "nextActions",
    ],
  ],
  "result-process execute": [
    "publication-result-process-executed",
    "publication-result-process-executed.md",
    [
      "operationCount",
      "completedKeys",
      "executionReceiptSha256",
      "reused",
      "artifacts",
      "nextActions",
    ],
  ],
  "result-process verify": [
    "publication-result-process-verified",
    "publication-result-process-verified.md",
    [
      "operationCount",
      "targetStateCode",
      "verifiedSetHash",
      "readbackReceiptSha256",
      "artifacts",
      "nextActions",
    ],
  ],
  "publish execute": [
    "publication-executed",
    "publication-executed.md",
    [
      "datasetCount",
      "completedKeys",
      "executionReceiptSha256",
      "artifacts",
      "nextActions",
    ],
  ],
  "readback verify": [
    "publication-readback-verified",
    "publication-readback-verified.md",
    [
      "datasetCount",
      "verifiedSetHash",
      "readbackReceiptSha256",
      "artifacts",
      "nextActions",
    ],
  ],
  "projection prepare": portalPlanPrepared,
  "projection package-plan": portalPlanPrepared,
  "projection package-publish": portalPublicationEvent,
  "projection finalize": portalPublicationEvent,
  "projection verify": portalPublicationEvent,
  "projection revoke": portalPublicationEvent,
});

export function replyTemplateFor(command, { ok } = {}) {
  const entry = ok
    ? templates[command]
    : command.startsWith("projection ")
      ? portalCommandFailed
      : [
          "publication-command-failed",
          "publication-command-failed.md",
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
