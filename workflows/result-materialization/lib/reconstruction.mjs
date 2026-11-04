import { fail } from "./common.mjs";

const ABSOLUTE_TOLERANCE = 1e-10;
const RELATIVE_TOLERANCE = 1e-8;

const FLOW_RELATIVE_WARNING_LIMIT = 1e-5;

export function validateOneHopReconstruction(context, processIndex) {
  const reconstructed = new Map();
  for (const record of context.biosphere.get(processIndex) ?? []) {
    add(reconstructed, record, Number(record.meanAmount));
  }
  const edges = context.technosphereEdges.filter(
    (edge) => edge.dependentProcessIndex === processIndex,
  );
  for (const edge of edges) {
    for (const record of context.lci.get(edge.balancingProcessIndex) ?? []) {
      add(
        reconstructed,
        record,
        Number(edge.activityRequirement) * Number(record.meanAmount),
      );
    }
  }
  const expected = new Map();
  for (const record of context.lci.get(processIndex) ?? [])
    add(expected, record, Number(record.meanAmount));
  const keys = new Set([...reconstructed.keys(), ...expected.keys()]);
  const comparisons = [];
  const groupScales = new Map();
  let maxAbsoluteDifference = 0;
  for (const key of keys) {
    const observed = reconstructed.get(key) ?? 0;
    const target = expected.get(key) ?? 0;
    const difference = Math.abs(observed - target);
    maxAbsoluteDifference = Math.max(maxAbsoluteDifference, difference);
    if (!Number.isFinite(difference))
      fail(
        "non_finite_reconstruction_value",
        "Non-finite inventory difference",
      );
    const comparisonGroup = comparableQuantityGroup(key);
    groupScales.set(
      comparisonGroup,
      Math.max(
        groupScales.get(comparisonGroup) ?? 0,
        Math.abs(observed),
        Math.abs(target),
      ),
    );
    comparisons.push({
      key,
      observed,
      target,
      difference,
      comparisonGroup,
    });
  }
  const warnings = [];
  const blockers = [];
  let maxAllowedDifference = 0;
  let maxRelativeDifference = 0;
  let maxToleranceRatio = 0;
  for (const {
    key,
    observed,
    target,
    difference,
    comparisonGroup,
  } of comparisons) {
    const comparisonScale = groupScales.get(comparisonGroup) ?? 0;
    const allowedDifference =
      ABSOLUTE_TOLERANCE + RELATIVE_TOLERANCE * comparisonScale;
    maxAllowedDifference = Math.max(maxAllowedDifference, allowedDifference);
    maxToleranceRatio = Math.max(
      maxToleranceRatio,
      allowedDifference > 0 ? difference / allowedDifference : 0,
    );
    if (comparisonScale > 0) {
      maxRelativeDifference = Math.max(
        maxRelativeDifference,
        difference / comparisonScale,
      );
    }
    if (difference > allowedDifference) {
      const flowScale = Math.max(Math.abs(target), Math.abs(observed));
      const withinWarningLimit =
        reconstructed.has(key) &&
        expected.has(key) &&
        difference <= FLOW_RELATIVE_WARNING_LIMIT * flowScale;
      const finding = {
        key,
        observed,
        expected: target,
        absoluteDifference: difference,
        comparisonGroup,
        comparisonScale,
        allowedDifference,
        flowRelativeDifference: difference / flowScale,
      };
      (withinWarningLimit ? warnings : blockers).push(finding);
    }
  }
  if (blockers.length) {
    fail(
      "one_hop_reconstruction_mismatch",
      "One-hop inventory exceeds per-flow tolerance",
      {
        processIndex,
        warnings,
        blockers,
      },
    );
  }
  return {
    outcome: warnings.length ? "passed_with_warnings" : "passed",
    processIndex,
    warnings,
    flowRelativeWarningLimit: FLOW_RELATIVE_WARNING_LIMIT,
    flowCount: keys.size,
    providerEdgeCount: edges.length,
    maxAbsoluteDifference,
    maxAllowedDifference,
    maxRelativeDifference,
    maxToleranceRatio,
    comparisonScale: "direction_and_unit",
    absoluteTolerance: ABSOLUTE_TOLERANCE,
    relativeTolerance: RELATIVE_TOLERANCE,
  };
}

export function summarizeReconstructionError(error) {
  if (
    error.code !== "one_hop_reconstruction_mismatch" ||
    !error.details?.findings
  ) {
    return error.details ?? {};
  }
  const { blockerCount, warningCount, findings } = error.details;
  const first = findings.find((item) => item.blockers.length);
  return {
    blockerCount,
    warningCount,
    processIndex: first.processIndex,
    sourceProcess: first.sourceProcess,
    ...first.blockers[0],
  };
}

function comparableQuantityGroup(key) {
  const [, , direction, unit] = key.split("|");
  return `${direction}|${unit}`;
}

function add(target, record, amount) {
  if (!Number.isFinite(amount))
    fail("non_finite_reconstruction_value", "Non-finite reconstruction value");
  const key = [
    record.flow.id.toLowerCase(),
    record.flow.version,
    String(record.direction).toLowerCase(),
    record.unit,
    record.location ?? "",
  ].join("|");
  target.set(key, (target.get(key) ?? 0) + amount);
}
