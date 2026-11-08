import { existsSync } from "node:fs";
import path from "node:path";

export function resolvePnpmInvocation(
  value,
  {
    execPath = process.execPath,
    fileExists = existsSync,
    pathValue = process.env.PATH,
    platform = process.platform,
    pnpmHome = process.env.PNPM_HOME,
  } = {},
) {
  const entry = value?.trim();
  if (!entry) {
    throw new Error(
      "pnpm execution contract is unavailable: npm_execpath is missing",
    );
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const requestedBasename = pathApi.basename(entry).toLowerCase();
  const bareEntry = requestedBasename === entry.toLowerCase();
  const executableName = platform === "win32" ? "pnpm.exe" : "pnpm";
  const javascriptNames = ["pnpm.cjs", "pnpm.js", "pnpm.mjs"];
  if (!["pnpm", "pnpm.exe", ...javascriptNames].includes(requestedBasename)) {
    throw new Error(
      `pnpm execution contract is unavailable: npm_execpath does not identify a supported pnpm entry (${requestedBasename || "unknown"})`,
    );
  }
  const candidateName = javascriptNames.includes(requestedBasename)
    ? requestedBasename
    : executableName;
  const candidates = bareEntry
    ? [
        ...(pnpmHome
          ? [
              pathApi.join(pnpmHome, candidateName),
              pathApi.join(pnpmHome, "bin", candidateName),
            ]
          : []),
        ...String(pathValue ?? "")
          .split(pathApi.delimiter)
          .filter(Boolean)
          .map((directory) => pathApi.join(directory, candidateName)),
      ]
    : [entry];
  const resolvedEntry = [...new Set(candidates)].find(fileExists);
  if (!resolvedEntry) {
    throw new Error(
      "pnpm execution contract is unavailable: npm_execpath is not a readable file",
    );
  }

  const basename = pathApi.basename(resolvedEntry).toLowerCase();
  if (javascriptNames.includes(basename)) {
    return { command: execPath, prefixArgs: [resolvedEntry] };
  }
  if (
    (platform === "win32" && basename === "pnpm.exe") ||
    (platform !== "win32" && basename === "pnpm")
  ) {
    return { command: resolvedEntry, prefixArgs: [] };
  }
  throw new Error(
    `pnpm execution contract is unavailable: npm_execpath does not identify a supported pnpm entry (${basename || "unknown"})`,
  );
}
