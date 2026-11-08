import { fileURLToPath } from "node:url";

export const RELEASE_ROOT = fileURLToPath(
  new URL("../../../", import.meta.url),
);
export const RELEASE_ENV_FILE = fileURLToPath(
  new URL("../../../.env", import.meta.url),
);
export const ACTOR_SETTINGS = [
  "TIANGONG_LCA_API_BASE_URL",
  "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY",
  "TIANGONG_LCA_ACCESS_TOKEN",
];
export const DATABASE_SETTINGS = ["CONN", "RELEASE_DATABASE_CA_FILE"];
export const STORAGE_SETTINGS = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_PREFIX",
];
export const STORAGE_CREDENTIALS = [
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_SESSION_TOKEN",
];
export const TOOL_SETTINGS = [
  "TIDAS_BIN",
  "TIDAS_MEMORY_BUDGET_MIB",
  "RELEASE_HDF5_BIN",
  "RELEASE_7ZIP_BIN",
  "TIANGONG_TIDAS_EXECUTABLE",
  "TIANGONG_LCA_CLI_EXECUTABLE",
];
export const READER_SETTINGS = [
  "RESULT_QUERY_ENDPOINT",
  "RESULT_QUERY_SERVICE_SECRET",
  "RESULT_QUERY_SERVICE_SECRET_FILE",
  "RESULT_QUERY_SERVICE_SECRET_SSH_HOST",
  "RESULT_QUERY_SERVICE_SECRET_SSH_ENV_FILE",
];
export const DATA_PLANE_SETTINGS = [
  ...DATABASE_SETTINGS,
  ...STORAGE_SETTINGS,
  ...STORAGE_CREDENTIALS,
];
export const PROFILES = Object.freeze({
  local: [],
  materialization: [],
  candidate: TOOL_SETTINGS,
  calculation: [
    ...ACTOR_SETTINGS,
    "TIANGONG_LCA_API_KEY",
    "TIANGONG_LCA_DATA_PRODUCT_COMMAND_URL",
  ],
  download: DATA_PLANE_SETTINGS,
  storage: [...DATA_PLANE_SETTINGS, ...TOOL_SETTINGS],
  readiness: [
    "TIANGONG_LCA_API_KEY",
    ...DATA_PLANE_SETTINGS,
    ...TOOL_SETTINGS,
    ...ACTOR_SETTINGS,
    ...READER_SETTINGS,
  ],
});

export function settingsForCommand(workflow, argv) {
  const [family, action] = argv;
  if (workflow === "query-artifact") return DATA_PLANE_SETTINGS;
  if (workflow === "calculation") {
    if (family === "calculation-bundle")
      return action === "download" ? DATA_PLANE_SETTINGS : DATABASE_SETTINGS;
    if (["environment", "worker"].includes(family)) return [];
    return PROFILES.calculation;
  }
  if (workflow === "release-candidate") {
    if ((family === "cache" && action !== "status") || family === "intake")
      return [
        ...TOOL_SETTINGS,
        ...DATABASE_SETTINGS,
        ...STORAGE_SETTINGS,
        ...STORAGE_CREDENTIALS,
        "RELEASE_FLOW_CACHE_REMOTE_HOST",
      ];
    if (family === "result" && action === "versions")
      return [...TOOL_SETTINGS, ...DATABASE_SETTINGS];
    return TOOL_SETTINGS;
  }
  if (workflow === "publication") {
    if (family === "result-storage")
      return [
        ...DATABASE_SETTINGS,
        ...STORAGE_SETTINGS,
        ...TOOL_SETTINGS,
        ...(action === "execute" ? STORAGE_CREDENTIALS : []),
      ];
    if (family === "result-readiness")
      return [
        ...PROFILES.readiness.filter((key) => key !== "TIANGONG_LCA_API_KEY"),
        ...(argv.includes("--bootstrap-session")
          ? ["TIANGONG_LCA_API_KEY"]
          : []),
      ];
    return ACTOR_SETTINGS;
  }
  return [];
}
