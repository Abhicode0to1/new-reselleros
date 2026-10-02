import { chromium } from "@playwright/test";

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const EMAIL = process.env.TEST_EMAIL || "pardeep@anutech.in";
const PASSWORD = process.env.TEST_PASSWORD || "Admin@123456";

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function highlight(page, selector, text = "") {
  try {
    const loc = page.locator(selector).first();
    if (await loc.isVisible()) {
      await loc.evaluate((el) => {
        el.style.outline = "3px solid #3b82f6";
        el.style.transition = "outline 0.3s ease";
      });
      if (text) {
        console.log(`👁️ [Action] ${text}`);
      }
      await sleep(400);
      await loc.evaluate((el) => {
        el.style.outline = "";
      });
    }
  } catch {
    // Ignore highlight failure if element shifted
  }
}

async function runHumanTest() {
  console.log("==================================================");
  console.log("🤖 Human-like AI Browser Testing Starting...");
  console.log(`🌐 Target: ${BASE_URL}`);
  console.log(`👤 User: ${EMAIL}`);
  console.log("==================================================\n");

  const channel = process.env.BROWSER_CHANNEL || "chrome";
  const browser = await chromium.launch({
    channel,
    headless: false, // Opens visible browser on user's screen!
    slowMo: 700,     // Human-like speed
    args: ["--start-maximized"],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 850 },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();

  try {
    // 1. Visit Login Page
    console.log("👉 Step 1: Navigating to Login Page...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
    await sleep(1000);

    // 2. Type Credentials like a human
    console.log("👉 Step 2: Entering Email...");
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    await highlight(page, 'input[name="email"], input[type="email"]', "Focusing email field");
    await emailInput.click();
    await emailInput.pressSequentially(EMAIL, { delay: 60 });

    console.log("👉 Step 3: Entering Password...");
    const passInput = page.locator('input[type="password"], input[name="password"]').first();
    await highlight(page, 'input[name="password"], input[type="password"]', "Focusing password field");
    await passInput.click();
    await passInput.pressSequentially(PASSWORD, { delay: 60 });

    console.log("👉 Step 4: Submitting Login Form...");
    const submitBtn = page.locator('button[type="submit"]').first();
    await highlight(page, 'button[type="submit"]', "Clicking Sign In button");
    await submitBtn.click();

    // 3. Wait for Dashboard to Load
    console.log("⏳ Step 5: Waiting for Dashboard...");
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
    await sleep(2000);
    console.log(`✅ Logged in successfully! Current URL: ${page.url()}`);

    // 4. Explore Dashboard Elements
    console.log("👉 Step 6: Exploring Dashboard Overview...");
    await page.mouse.wheel(0, 400);
    await sleep(1200);
    await page.mouse.wheel(0, -400);
    await sleep(800);

    // 5. Test Leads / CRM section
    console.log("👉 Step 7: Navigating to Leads / Pipeline...");
    const leadsLink = page.locator('a[href*="/leads"]').first();
    if (await leadsLink.isVisible()) {
      await highlight(page, 'a[href*="/leads"]', "Clicking Leads menu");
      await leadsLink.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(2000);
      console.log(`✅ Leads page loaded: ${page.url()}`);
      await page.mouse.wheel(0, 300);
      await sleep(1000);
      await page.mouse.wheel(0, -300);
    } else {
      await page.goto(`${BASE_URL}/leads`);
      await sleep(2000);
    }

    // 6. Test Customers section
    console.log("👉 Step 8: Navigating to Customers...");
    const customersLink = page.locator('a[href*="/customers"]').first();
    if (await customersLink.isVisible()) {
      await highlight(page, 'a[href*="/customers"]', "Clicking Customers menu");
      await customersLink.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(2000);
      console.log(`✅ Customers page loaded: ${page.url()}`);
    } else {
      await page.goto(`${BASE_URL}/customers`);
      await sleep(2000);
    }

    // 7. Test Invoices section
    console.log("👉 Step 9: Navigating to Invoices...");
    const invoicesLink = page.locator('a[href*="/invoices"]').first();
    if (await invoicesLink.isVisible()) {
      await highlight(page, 'a[href*="/invoices"]', "Clicking Invoices menu");
      await invoicesLink.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(2000);
      console.log(`✅ Invoices page loaded: ${page.url()}`);
    } else {
      await page.goto(`${BASE_URL}/invoices`);
      await sleep(2000);
    }

    // 8. Test Subscriptions section
    console.log("👉 Step 10: Navigating to Subscriptions...");
    const subsLink = page.locator('a[href*="/subscriptions"]').first();
    if (await subsLink.isVisible()) {
      await highlight(page, 'a[href*="/subscriptions"]', "Clicking Subscriptions menu");
      await subsLink.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(2000);
      console.log(`✅ Subscriptions page loaded: ${page.url()}`);
    } else {
      await page.goto(`${BASE_URL}/subscriptions`);
      await sleep(2000);
    }

    // Return to Dashboard
    console.log("👉 Step 11: Returning to Dashboard...");
    await page.goto(`${BASE_URL}/dashboard`);
    await sleep(2000);

    console.log("\n🎉 Testing Completed Successfully!");
    console.log("Leaving browser open for 15 seconds so you can see the result...");
    await sleep(15000);

  } catch (err) {
    console.error("❌ Error during testing:", err.message);
  } finally {
    await browser.close();
    console.log("🏁 Browser session closed.");
  }
}

runHumanTest();
