import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BASE_NAME_LENGTH, suffixName } from "../lib/references.mjs";

const MODEL_SUFFIX = "generated resolved one-hop lifecycle model";
const RESULT_SUFFIX = "aggregated LCI/LCIA result";

function nameWith(text) {
  return { baseName: [{ "@xml:lang": "en", "#text": text }] };
}

function baseText(name) {
  return name.baseName[0]["#text"];
}

test("keeps the composed name unchanged while it fits the schema limit", () => {
  const source = nameWith("Sewing needles, knitting needles");
  const result = suffixName(source, MODEL_SUFFIX);
  assert.equal(
    baseText(result),
    `Sewing needles, knitting needles — ${MODEL_SUFFIX}`,
  );
});

test("keeps a name that lands exactly on the limit unchanged", () => {
  const head = "a".repeat(MAX_BASE_NAME_LENGTH - ` — ${MODEL_SUFFIX}`.length);
  const result = suffixName(nameWith(head), MODEL_SUFFIX);
  const text = baseText(result);
  assert.equal(text, `${head} — ${MODEL_SUFFIX}`);
  assert.equal([...text].length, MAX_BASE_NAME_LENGTH);
});

test("truncates the source head and keeps the provenance suffix at the limit", () => {
  const head = "b".repeat(469);
  const result = suffixName(nameWith(head), MODEL_SUFFIX);
  const text = baseText(result);
  assert.ok(
    [...text].length <= MAX_BASE_NAME_LENGTH,
    `expected <= ${MAX_BASE_NAME_LENGTH}, got ${[...text].length}`,
  );
  assert.ok(text.endsWith(` — ${MODEL_SUFFIX}`));
  assert.ok(text.includes("…"), "truncation must be explicit");
  assert.ok(head.startsWith(text.split("…")[0]));
});

test("preserves head characters before the truncation marker", () => {
  const head = "c".repeat(600);
  const text = baseText(suffixName(nameWith(head), RESULT_SUFFIX));
  const [kept] = text.split("…");
  assert.ok(kept.length > 0);
  assert.ok(head.startsWith(kept));
});

test("never splits a surrogate pair when truncating", () => {
  const head = "𝔁".repeat(400);
  const text = baseText(suffixName(nameWith(head), MODEL_SUFFIX));
  assert.ok([...text].length <= MAX_BASE_NAME_LENGTH);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text));
});

test("is deterministic for the same input", () => {
  const source = nameWith("d".repeat(510));
  assert.deepEqual(
    suffixName(source, MODEL_SUFFIX),
    suffixName(source, MODEL_SUFFIX),
  );
});

test("handles the object form of baseName", () => {
  const source = { baseName: { "@xml:lang": "en", "#text": "e".repeat(510) } };
  const result = suffixName(source, MODEL_SUFFIX);
  assert.ok(Array.isArray(result.baseName) === false);
  assert.ok([...result.baseName["#text"]].length <= MAX_BASE_NAME_LENGTH);
});

test("leaves non-English entries untouched", () => {
  const source = {
    baseName: [
      { "@xml:lang": "en", "#text": "f".repeat(510) },
      { "@xml:lang": "zh", "#text": "中文名称" },
    ],
  };
  const result = suffixName(source, MODEL_SUFFIX);
  assert.deepEqual(result.baseName[1], {
    "@xml:lang": "zh",
    "#text": "中文名称",
  });
  assert.ok([...result.baseName[0]["#text"]].length <= MAX_BASE_NAME_LENGTH);
});
