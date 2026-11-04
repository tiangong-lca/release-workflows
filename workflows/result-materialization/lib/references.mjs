export function globalReference({
  type,
  category,
  uuid,
  version,
  description,
}) {
  return {
    "@refObjectId": uuid.toLowerCase(),
    "@type": type,
    "@uri": `../${category}/${uuid.toLowerCase()}_${version}.json`,
    "@version": version,
    "common:shortDescription": { "@xml:lang": "en", "#text": description },
  };
}

/**
 * TIDAS schema limit for `baseName` text (`too_big`, maximum 500).
 * Generated names must stay within it or the dataset fails SDK validation.
 */
export const MAX_BASE_NAME_LENGTH = 500;

const ELLIPSIS = "…";

export function suffixName(name, suffix, maxLength = MAX_BASE_NAME_LENGTH) {
  const copy = structuredClone(name);
  const values = Array.isArray(copy.baseName) ? copy.baseName : [copy.baseName];
  const updated = values.map((item) =>
    item?.["@xml:lang"] === "en"
      ? { ...item, "#text": appendSuffix(item["#text"], suffix, maxLength) }
      : item,
  );
  copy.baseName = Array.isArray(copy.baseName) ? updated : updated[0];
  return copy;
}

/**
 * Append the generation suffix without exceeding the schema limit.
 * The suffix is provenance and is kept intact; only the source-derived head is
 * shortened, deterministically, with an explicit truncation marker.
 */
function appendSuffix(text, suffix, maxLength) {
  const tail = ` — ${suffix}`;
  const composed = `${text}${tail}`;
  if ([...composed].length <= maxLength) return composed;
  const room = maxLength - [...tail].length - [...ELLIPSIS].length;
  if (room <= 0) return [...`${ELLIPSIS}${tail}`].slice(-maxLength).join("");
  const head = [...text].slice(0, room).join("");
  return `${head}${ELLIPSIS}${tail}`;
}
