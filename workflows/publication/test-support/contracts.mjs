import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

/**
 * Validates Release Publication artifacts against the JSON Schemas in
 * `workflows/publication/contracts/`.
 *
 * This reuses the repository's existing schema validator stack — `ajv@8.20.0`
 * in Draft 2020-12 mode, exactly as `workflows/dataset-transformation/lib/contracts.mjs`
 * already does — rather than introducing a second, hand-written validator.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("uuid", {
  type: "string",
  validate: (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    ),
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) && !Number.isNaN(Date.parse(value)),
});

const cache = new Map();

export function contractValidator(name) {
  if (!cache.has(name)) {
    const file = fileURLToPath(
      new URL(`../contracts/${name}`, import.meta.url),
    );
    cache.set(name, ajv.compile(JSON.parse(readFileSync(file, "utf8"))));
  }
  return cache.get(name);
}

export function validateArtifact(name, value) {
  const validate = contractValidator(name);
  return validate(value) ? [] : (validate.errors ?? []);
}

export function assertMatchesSchema(value, schemaName, label = schemaName) {
  const errors = validateArtifact(schemaName, value);
  if (errors.length)
    throw new Error(
      `${label} does not match ${schemaName}:\n${errors
        .map(
          (error) =>
            `  ${error.instancePath || "#"} ${error.message ?? ""}${
              error.params?.additionalProperty
                ? ` (${error.params.additionalProperty})`
                : ""
            }`,
        )
        .join("\n")}`,
    );
}
