import { chromium } from "@playwright/test";
import { exec } from "node:child_process";

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const EMAIL = process.env.TEST_EMAIL || "pardeep@anutech.in";
const PASSWORD = process.env.TEST_PASSWORD || "Admin@123456";

function bringToFrontWindows() {
  // Use PowerShell to force Chrome into the foreground
  const ps = `powershell -Command "$w = New-Object -ComObject WScript.Shell; $w.AppActivate('ResellerOS') -or $w.AppActivate('Chrome')"`;
  exec(ps);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanHighlight(page, selector, label = "") {
  try {
    const loc = page.locator(selector).first();
    if (await loc.isVisible()) {
      await loc.scrollIntoViewIfNeeded();
      await loc.evaluate((el) => {
        el.style.outline = "4px solid #ef4444"; // bright red focus box
        el.style.boxShadow = "0 0 15px rgba(239, 68, 68, 0.8)";
        el.style.transition = "all 0.4s ease";
      });
      if (label) console.log(`👉 [Focus]: ${label}`);
      await sleep(1000);
      await loc.evaluate((el) => {
        el.style.outline = "";
        el.style.boxShadow = "";
      });
    }
  } catch (e) {
    // Ignore if element is not in DOM
  }
}

async function run() {
  console.log("==================================================");
  console.log("🚀 Starting Foreground Focused Human-like AI Tour...");
  console.log("==================================================");

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    slowMo: 1000, // 1 second per action so user clearly sees everything
    args: [
      "--start-maximized",
      "--new-window",
      "--no-sandbox"
    ],
  });

  const context = await browser.newContext({
    viewport: null, // use actual maximized window size
  });

  const page = await context.newPage();

  // Bring to front
  await page.bringToFront();
  setTimeout(bringToFrontWindows, 1000);
  setTimeout(bringToFrontWindows, 3000);

  try {
    // 1. Open login or dashboard
    console.log("🌐 Step 1: Navigating to http://localhost:3001/dashboard");
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    bringToFrontWindows();

    // Check if redirected to login
    if (page.url().includes("/login")) {
      console.log("🔑 Logging in as Pardeep...");
      const emailInput = page.locator('input[type="email"], input[name="email"]').first();
      await humanHighlight(page, 'input[name="email"], input[type="email"]', "Email Field");
      await emailInput.click();
      await emailInput.pressSequentially(EMAIL, { delay: 80 });

      const passInput = page.locator('input[type="password"], input[name="password"]').first();
      await humanHighlight(page, 'input[name="password"], input[type="password"]', "Password Field");
      await passInput.click();
      await passInput.pressSequentially(PASSWORD, { delay: 80 });

      await humanHighlight(page, 'button[type="submit"]', "Sign In Button");
      await page.locator('button[type="submit"]').first().click();

      await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
      await sleep(2000);
    }

    console.log("✅ On Dashboard!");
    bringToFrontWindows();

    // 2. Highlight Greeting and Deals on Dashboard
    await humanHighlight(page, 'h1, h2:has-text("Good morning")', "Welcome Greeting");
    await sleep(1000);

    // 3. Highlight Quick add quote button and click it to open modal
    console.log("📝 Step 2: Testing '+ Quick add quote' button...");
    const quickQuoteBtn = page.locator('button:has-text("Quick add quote"), a:has-text("Quick add quote")').first();
    if (await quickQuoteBtn.isVisible()) {
      await humanHighlight(page, 'button:has-text("Quick add quote"), a:has-text("Quick add quote")', "Quick add quote button");
      await quickQuoteBtn.click();
      await sleep(2500);

      // Close modal / dialog if opened
      const closeBtn = page.locator('button[aria-label="Close"], button:has-text("Cancel")').first();
      if (await closeBtn.isVisible()) {
        await humanHighlight(page, 'button[aria-label="Close"], button:has-text("Cancel")', "Closing dialog");
        await closeBtn.click();
        await sleep(1000);
      }
    }

    // 4. Scroll down dashboard smoothly
    console.log("📜 Step 3: Scrolling through Dashboard metrics...");
    await humanHighlight(page, 'text="PIPELINE"', "Pipeline metric");
    await page.mouse.wheel(0, 500);
    await sleep(2000);
    await page.mouse.wheel(0, 500);
    await sleep(2000);
    await page.mouse.wheel(0, -1000);
    await sleep(1500);

    // 5. Sidebar Navigation: Sales & Pipeline
    console.log("📊 Step 4: Clicking Sales & Pipeline...");
    const pipelineLink = page.locator('a[href*="/leads"], button:has-text("Sales & Pipeline"), a:has-text("Sales & Pipeline")').first();
    if (await pipelineLink.isVisible()) {
      await humanHighlight(page, 'a[href*="/leads"], a:has-text("Sales & Pipeline")', "Sales & Pipeline Menu");
      await pipelineLink.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(2500);
      await page.mouse.wheel(0, 400);
      await sleep(1500);
      await page.mouse.wheel(0, -400);
    }

    // 6. Sidebar Navigation: Quotes
    console.log("📄 Step 5: Clicking Quotes...");
    const quotesLink = page.locator('a[href*="/quotes"], a:has-text("Quotes")').first();
    if (await quotesLink.isVisible()) {
      await humanHighlight(page, 'a[href*="/quotes"], a:has-text("Quotes")', "Quotes Menu");
      await quotesLink.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(2500);
      await page.mouse.wheel(0, 400);
      await sleep(1500);
    }

    // 7. Sidebar Navigation: Customers
    console.log("👥 Step 6: Clicking Customers...");
    const custLink = page.locator('a[href*="/customers"], a:has-text("Customers")').first();
    if (await custLink.isVisible()) {
      await humanHighlight(page, 'a[href*="/customers"], a:has-text("Customers")', "Customers Menu");
      await custLink.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(2500);
      await page.mouse.wheel(0, 400);
      await sleep(1500);
    }

    // 8. Back to Dashboard
    console.log("🏠 Step 7: Returning to Dashboard...");
    const dashLink = page.locator('a[href*="/dashboard"], a:has-text("Dashboard")').first();
    if (await dashLink.isVisible()) {
      await humanHighlight(page, 'a[href*="/dashboard"], a:has-text("Dashboard")', "Dashboard Menu");
      await dashLink.click();
    } else {
      await page.goto(`${BASE_URL}/dashboard`);
    }
    await sleep(2000);

    console.log("\n==================================================");
    console.log("🎉 AI Tour Completed! Browser will remain OPEN for 120 seconds.");
    console.log("You can now click and use it freely on your screen!");
    console.log("==================================================");
    await sleep(120000);

  } catch (err) {
    console.error("Error during visual tour:", err);
    await sleep(10000);
  } finally {
    await browser.close();
  }
}

run();
