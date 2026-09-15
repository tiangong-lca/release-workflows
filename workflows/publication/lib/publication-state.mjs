import { fail, sha256Bytes } from "./common.mjs";

export const RESULT_PROCESS_ROLE = "result_process";
export const RESULT_PROCESS_TARGET_STATE = 120;
export const ORDINARY_TARGET_STATE = 100;
export const RESULT_PROCESS_CONTENT_HASH_DOMAIN = "result-process-content.v1";
export const IDEMPOTENCY_DOMAIN =
  "tiangong.release.result-process.idempotency.v1";

const ORDINARY_ROLES = new Set(["unit_process", "lifecycle_model", "support"]);

/**
 * Publication role -> platform publication state code.
 *
 * A dataset always follows its own role. A dependency member never inherits the
 * target of the component that happened to select it, so a support Flow reached
 * from a Result closure stays ordinary.
 */
export function targetStateCodeForRole(role) {
  if (role === RESULT_PROCESS_ROLE) return RESULT_PROCESS_TARGET_STATE;
  if (ORDINARY_ROLES.has(role)) return ORDINARY_TARGET_STATE;
  fail(
    "publication_dataset_role_unsupported",
    `Publication has no state mapping for dataset role: ${role}`,
  );
}

export function contentTypeForRole(role) {
  return role === RESULT_PROCESS_ROLE ? "result-process" : "ordinary-dataset";
}

export function isResultProcessRole(role) {
  return role === RESULT_PROCESS_ROLE;
}

export function stateMapping() {
  return {
    roleTargets: {
      [RESULT_PROCESS_ROLE]: RESULT_PROCESS_TARGET_STATE,
      unit_process: ORDINARY_TARGET_STATE,
      lifecycle_model: ORDINARY_TARGET_STATE,
      support: ORDINARY_TARGET_STATE,
    },
    singleGlobalState: false,
  };
}

/**
 * Build the per-operation mixed-state contract from verified payload rows and
 * their classified target observations.
 *
 * Every operation carries its own `targetStateCode` and `contentType`, so a plan
 * never has a single global published state.
 */
export function buildPublicationOperations({ datasets, observationByKey }) {
  return datasets.map((dataset) => {
    const observation = observationByKey.get(dataset.key);
    if (!observation)
      fail(
        "publication_operation_observation_missing",
        `No target observation for payload dataset: ${dataset.key}`,
      );
    const targetStateCode = targetStateCodeForRole(dataset.role);
    if (
      observation.classification === "matching_published" &&
      observation.stateCode !== targetStateCode
    )
      fail(
        "publication_dataset_state_conflict",
        `Dataset is published at a state that is not its role target: ${dataset.key}`,
        {
          role: dataset.role,
          targetStateCode,
          observedStateCode: observation.stateCode,
        },
      );
    // A Result Process always goes through the manager-attested command, even
    // when a generic observation already sees matching published content. The
    // reviewed contract is explicit that content candidacy is never
    // authorization and never a no-op: only an exact receipt can release that
    // identity, so there is no generic Result no-op.
    const resultProcess = isResultProcessRole(dataset.role);
    const remoteWrites =
      resultProcess || observation.classification !== "matching_published";
    return {
      key: dataset.key,
      role: dataset.role,
      contentType: contentTypeForRole(dataset.role),
      table: dataset.table,
      uuid: dataset.uuid,
      version: dataset.version,
      expectedCanonicalContentHash: dataset.canonicalContentHash,
      targetStateCode,
      action: resultProcess
        ? "reconcile_via_manager_command"
        : actionFor(observation.classification),
      remoteWrites,
      classification: observation.classification,
      observedStateCode: observation.stateCode,
      observedContentHash: observation.observedContentHash,
    };
  });
}

function actionFor(classification) {
  if (classification === "absent") return "create_then_publish";
  if (classification === "matching_published") return "already_published_noop";
  return "publish_existing";
}

/**
 * Fail closed before any write when a set of operations still carries the
 * legacy single-state (100) Result authorization.
 *
 * Historical all-100 evidence stays readable: this only refuses to treat it as
 * new authorization for a Result Process write.
 */
export function assertOperationsAuthorizePerRoleTarget({
  operations,
  publishedStateCode,
  executablePlanSha256 = null,
}) {
  const blockers = [];
  for (const operation of operations) {
    if (typeof operation.targetStateCode === "number") {
      const expected = targetStateCodeForRole(operation.role);
      if (operation.targetStateCode !== expected)
        blockers.push({
          key: operation.key,
          role: operation.role,
          code: "operation_target_state_mismatch",
          expected,
          targetStateCode: operation.targetStateCode,
        });
      continue;
    }
    if (publishedStateCode !== ORDINARY_TARGET_STATE)
      blockers.push({
        key: operation.key,
        role: operation.role,
        code: "legacy_state_mapping_out_of_scope",
        publishedStateCode: publishedStateCode ?? null,
      });
    else if (isResultProcessRole(operation.role))
      blockers.push({
        key: operation.key,
        role: operation.role,
        code: "result_process_requires_per_role_target",
      });
  }
  if (blockers.length)
    fail(
      "result_process_publication_authorization_unsupported",
      "Approval does not carry a mixed-state per-operation authorization and cannot authorize these writes",
      {
        blockers,
        executablePlanSha256,
        acceptedContractVersion: 2,
        acceptedSchemaVersion: "tiangong.release.publication-approval.v2",
        historicalEvidenceReadable: true,
      },
    );
}

export function deriveIdempotencyKey({
  executablePlanSha256,
  key,
  contentSha256,
}) {
  return sha256Bytes(
    Buffer.from(
      [IDEMPOTENCY_DOMAIN, executablePlanSha256, key, contentSha256].join("|"),
      "utf8",
    ),
  );
}

/**
 * The Result Process target state is served by the manager-attested Database
 * command, never by the platform dataset commands. Reaching a Result Process
 * identity through the 0/100 route is a routing defect, not a missing feature.
 */
export function assertNotPlatformRoute(role, key) {
  if (role === RESULT_PROCESS_ROLE)
    fail(
      "publication_result_process_route_violation",
      `Result Process datasets are never written through the platform dataset commands: ${key}`,
      { key, targetStateCode: RESULT_PROCESS_TARGET_STATE },
    );
}
