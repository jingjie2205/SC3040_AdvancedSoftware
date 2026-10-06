const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../lib/nutrition.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const exportsObject = {};
vm.runInNewContext(compiled.outputText, {
  exports: exportsObject, process, require: () => ({ createClient: () => { throw new Error("Unexpected network access"); } }),
});
const { scaleItem, mealTotals } = exportsObject;
const item = { name: "Rice", estimated_weight_g: 150, calories: 195, protein_g: 4, carbs_g: 42, fat_g: 0.5 };

test("changing a portion scales every nutrient without network access", () => {
  const doubled = scaleItem(item, 300);
  for (const key of ["calories", "protein_g", "carbs_g", "fat_g"]) assert.equal(doubled[key], item[key] * 2);
  assert.equal(item.estimated_weight_g, 150);
});

test("repeated portion adjustments do not accumulate rounding errors", () => {
  let adjusted = item;
  for (let i = 0; i < 100; i++) adjusted = scaleItem(scaleItem(adjusted, 137), 150);
  assert.ok(Math.abs(adjusted.calories - item.calories) < 1e-8);
  assert.ok(Math.abs(adjusted.fat_g - item.fat_g) < 1e-8);
});

test("zero, negative and non-finite weights cannot destroy the baseline", () => {
  for (const weight of [0, -1, NaN, Infinity, 10001]) assert.equal(scaleItem(item, weight), item);
});

test("adding and removing items recalculates totals", () => {
  assert.equal(mealTotals([item, item]).total_calories, 390);
  assert.equal(mealTotals([item]).carbs_g, 42);
  assert.equal(mealTotals([]).total_calories, 0);
});

test("meal requests reject signed-out users before contacting the backend", async () => {
  const result = {};
  vm.runInNewContext(compiled.outputText, {
    exports: result, process, Headers,
    require: () => ({ createClient: () => ({ auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
    } }) }),
    fetch: () => { throw new Error("Unexpected backend request"); },
  });
  await assert.rejects(result.fetchDailyLog("2026-10-07"), /Please sign in/);
});

test("meal requests send the signed-in user's bearer token", async () => {
  const result = {};
  let request;
  vm.runInNewContext(compiled.outputText, {
    exports: result, process, Headers, AbortSignal,
    require: () => ({ createClient: () => ({ auth: {
      getSession: async () => ({ data: { session: { access_token: "test-token" } }, error: null }),
    } }) }),
    fetch: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ meals: [] }) }; },
  });
  await result.fetchDailyLog("2026-10-07");
  assert.equal(request.options.headers.get("Authorization"), "Bearer test-token");
  assert.match(request.url, /api\/nutrition\/daily/);
});
