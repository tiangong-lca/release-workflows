import {
  loadReleaseEnvironment,
  readReleaseConfigFile,
} from "../../environment/lib/configuration.mjs";
import {
  DATABASE_SETTINGS,
  STORAGE_SETTINGS,
  STORAGE_CREDENTIALS,
} from "../../environment/lib/settings.mjs";
export const PUBLICATION_STORAGE_SETTINGS = [
  ...DATABASE_SETTINGS,
  ...STORAGE_SETTINGS,
  "RELEASE_7ZIP_BIN",
];
export const PUBLICATION_STORAGE_CREDENTIALS = STORAGE_CREDENTIALS;
export const preparePublicationEnvironment = (
  options,
  { settings = PUBLICATION_STORAGE_SETTINGS, ...rest } = {},
) => loadReleaseEnvironment(options, { settings, ...rest });
export const readPublicationConfigFile = readReleaseConfigFile;
