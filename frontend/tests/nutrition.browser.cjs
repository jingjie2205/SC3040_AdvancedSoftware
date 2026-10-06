const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

async function main() {
  const user = { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "nutrition-test@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const auth = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/users/me"
      ? { userId: user.id, email: user.email, age: 33, weight: 70, height: 175, biologicalSex: "MALE", activityLevel: "SEDENTARY", fitnessGoal: "MAINTAIN", isStravaConnected: false }
      : user));
  });
  await new Promise(resolve => auth.listen(54329, "127.0.0.1", resolve));
  const frontend = path.resolve(__dirname, "..");
  const output = path.join(frontend, ".next", "nutrition-qa");
  fs.mkdirSync(output, { recursive: true });
  const server = spawn(process.execPath, ["-e", "require('next/dist/server/lib/start-server').startServer({dir:process.cwd(),isDev:true,port:3107,hostname:'127.0.0.1',allowRetry:false})"], {
    cwd: frontend, windowsHide: true,
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54329", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key", NEXT_PUBLIC_BACKEND_URL: "http://127.0.0.1:54329", NEXT_PUBLIC_STRAVA_CLIENT_ID: "", NEXT_PUBLIC_STRAVA_REDIRECT_URI: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", data => { serverLog += data; });
  server.stderr.on("data", data => { serverLog += data; });
  let browser;
  try {
    for (let i = 0; i < 90; i++) {
      if (server.exitCode !== null) throw new Error(serverLog);
      try { const response = await fetch("http://localhost:3107/login"); if (response.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const session = { access_token: "fixture-token", refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user };
    await context.addCookies([{ name: "sb-127-auth-token", value: "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url"), domain: "localhost", path: "/" }]);
    let meals = [];
    let savedBody;
    let analysisCalls = 0;
    await context.route("**/api/nutrition/**", async route => {
      const req = route.request();
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (req.url().endsWith("/analyze")) {
        analysisCalls++;
        return route.fulfill({ headers, json: { meal_name: "Photo rice bowl", confidence_score: 0.85,
          training_context_note: "Estimated meal for recovery.", items: [{ name: "Rice", estimated_weight_g: 100, calories: 200, protein_g: 4, carbs_g: 42, fat_g: 0.5 }] } });
      }
      if (req.method() === "POST") {
        savedBody = req.postDataJSON();
        const total = savedBody.items.reduce((sum, item) => sum + item.calories, 0);
        meals = [{ ...savedBody, total_calories: total, protein_g: 4, carbs_g: 42, fat_g: 0.5 }];
        return route.fulfill({ status: 201, headers, json: meals[0] });
      }
      if (req.method() === "DELETE") { meals = []; return route.fulfill({ status: 204, headers }); }
      return route.fulfill({ headers, json: { date: "2026-10-07", meals, total_calories: meals.reduce((sum, meal) => sum + meal.total_calories, 0), protein_g: 0, carbs_g: 0, fat_g: 0, bmr: null, active_calories: null, net_energy: null } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://localhost:3107/dashboard/nutrition");
    await page.getByText("A fresh plate, a fresh start.").waitFor();
    await page.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });
    await page.getByLabel("Choose meal photo", { exact: true }).setInputFiles({ name: "meal.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") });
    await page.getByRole("button", { name: "Analyze meal", exact: true }).click();
    await page.getByText("85% visual confidence").waitFor();
    assert.equal(analysisCalls, 1);
    assert.equal(meals.length, 0);
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await page.getByRole("button", { name: "Or enter a meal manually" }).click();
    await page.getByLabel("Meal name", { exact: true }).fill("Test rice bowl");
    await page.getByLabel("Ingredient 1 name").fill("Rice");
    await page.getByLabel("Calories", { exact: true }).fill("200");
    await page.getByLabel("Protein (g)", { exact: true }).fill("4");
    await page.getByLabel("Carbs (g)", { exact: true }).fill("42");
    await page.getByLabel("Weight (g)", { exact: true }).fill("200");
    assert.equal(await page.getByLabel("Calories", { exact: true }).inputValue(), "400");
    await page.getByRole("button", { name: "Add ingredient" }).click();
    await page.getByLabel("Ingredient 2 name").fill("Mistaken item");
    await page.getByRole("button", { name: "Remove ingredient 2" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, "mobile-review.png"), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByRole("button", { name: "Confirm & log meal" }).click();
    await page.getByText("Meal saved. Your daily totals have been updated.").waitFor();
    assert.equal(savedBody.items.length, 1);
    assert.equal(savedBody.items[0].calories, 400);
    assert.equal(savedBody.meal_type, "lunch");
    await page.locator("summary").filter({ hasText: "Test rice bowl" }).click();
    await page.getByRole("button", { name: "Delete meal", exact: true }).click();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await page.getByText("A fresh plate, a fresh start.").waitFor();
    assert.deepEqual(errors, []);
    await page.goto("http://localhost:3107/dashboard/settings");
    await page.getByRole("heading", { name: "Profile & TDEE Engine" }).waitFor();
    assert.equal(await page.getByRole("spinbutton").first().inputValue(), "33");
    await page.getByRole("link", { name: "Integrations", exact: true }).click();
    await page.getByText("Strava connection is not configured yet.").waitFor();
    assert.ok(page.url().includes("/dashboard/settings?tab=integrations"));
    await page.goto("http://localhost:3107/api/auth/callback?error=access_denied");
    assert.ok(page.url().includes("/dashboard/settings?tab=integrations&error=access_denied"));
    await context.clearCookies();
    await page.goto("http://localhost:3107/dashboard/nutrition");
    assert.ok(page.url().endsWith("/login"));
    console.log("PASS: nutrition workflow, Settings profile using configured backend, integration links without Strava keys, OAuth error redirect, and unauthenticated redirect.");
  } catch (error) {
    console.error(serverLog.slice(-4000));
    throw error;
  } finally {
    await browser?.close();
    server.kill();
    server.stdout.destroy(); server.stderr.destroy(); server.unref();
    auth.close();
    auth.closeAllConnections();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
