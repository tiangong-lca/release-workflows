const ROOT = "workflows/calculation/reply-templates";

const templates = Object.freeze({
  "result-set.list": [
    "result-set-listed",
    "result-set-listed.md",
    ["data.items", "completeness", "nextActions"],
  ],
  "result-set.get": [
    "result-set-ready",
    "result-set-ready.md",
    ["data.id", "data.name", "contextPath", "nextDecision", "nextActions"],
  ],
  "result-set.create": [
    "result-set-ready",
    "result-set-ready.md",
    [
      "data.id",
      "data.name",
      "contextPath",
      "warnings",
      "nextDecision",
      "nextActions",
    ],
  ],
  "closure.start": [
    "closure-submitted",
    "closure-submitted.md",
    [
      "data.jobId",
      "data.resourceId",
      "data.identityCompleteness",
      "data.status",
      "data.effectiveInput",
      "nextDecision",
      "nextActions",
    ],
  ],
  "closure.get": [
    "closure-inspected",
    "closure-inspected.md",
    [
      "data.closureCheckId",
      "data.runStatus",
      "data.scanCompleteness",
      "data.certificateValidity",
      "data.calculationReady",
      "data.binding",
      "completeness",
      "warnings",
      "nextActions",
    ],
  ],
  "calculation.start": [
    "calculation-submitted",
    "calculation-submitted.md",
    [
      "data.jobId",
      "data.identityCompleteness",
      "data.status",
      "data.effectiveInput",
      "nextDecision",
      "nextActions",
    ],
  ],
  "calculation.get": [
    "calculation-inspected",
    "calculation-inspected.md",
    [
      "data.jobId",
      "data.workerStatus",
      "data.domainStatus",
      "data.domainValidity",
      "data.terminal",
      "data.diagnosticsRecommended",
      "data.resultPackageId",
      "data.statusAuthority",
      "completeness",
      "nextActions",
    ],
  ],
  "calculation-bundle.list": [
    "calculation-bundle-listed",
    "calculation-bundle-listed.md",
    ["data.items", "completeness", "warnings", "nextActions"],
  ],
  "calculation-bundle.get": [
    "calculation-bundle-inspected",
    "calculation-bundle-inspected.md",
    ["data.packageId", "data.bundle", "completeness", "nextActions"],
  ],
  "calculation-bundle.download": [
    "calculation-bundle-downloaded",
    "calculation-bundle-downloaded.md",
    [
      "data.packageId",
      "data.bundleDirectory",
      "data.receiptPath",
      "data.verification",
      "data.artifactCount",
      "data.productDownloadCount",
      "nextActions",
    ],
  ],
  "environment.sync": [
    "data-plane-environment-synchronized",
    "data-plane-environment-synchronized.md",
    [
      "data.copiedKeys",
      "data.preservedKeys",
      "data.missingSourceKeys",
      "nextActions",
    ],
  ],
  "worker.logs": [
    "worker-log-delegated",
    "worker-log-delegated.md",
    ["data.jobId", "data.workingDirectory", "data.instruction"],
  ],
});

export function replyTemplateFor(command, { ok, errorCode } = {}) {
  const entry = ok
    ? templates[command]
    : errorCode === "result_set_name_confirmation_required"
      ? [
          "result-set-name-recommended",
          "result-set-name-recommended.md",
          ["error.details.recommendedName", "nextActions"],
        ]
      : errorCode === "remote_outcome_unknown"
        ? [
            "remote-outcome-unknown",
            "remote-outcome-unknown.md",
            ["command", "error", "nextActions"],
          ]
        : [
            "command-failed",
            "command-failed.md",
            ["command", "error", "nextActions"],
          ];
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
