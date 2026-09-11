/**
 * Does the customer portal still look like the staff panel? Measured, not eyeballed.
 *
 *   cd production && node scripts/check-portal-matches-panel.mjs
 *
 * Needs the dev server on :3000, the local Supabase stack up, and the demo
 * accounts seeded (`scripts/seed-portal-test-customer.sql`). It signs in as both
 * the staff owner and the portal test customer using the dev login box, so it
 * only works against a development build.
 *
 * ─── WHY A SCRIPT AND NOT A TEST ────────────────────────────────────────────
 * It drives a real browser against a running app and takes about a minute, which
 * is not something to put in a 7,000-test suite that runs on every change. It is
 * the check to run after touching either shell — the portal drifted three times
 * in one afternoon before this existed, and each time the drift was found by a
 * person looking at two screenshots.
 *
 * ─── WHAT IT WOULD HAVE CAUGHT ──────────────────────────────────────────────
 * Everything the screenshots did, and two things they did not: a 1px header
 * difference, and six properties that were being reported as MATCHING while
 * measuring nothing at all on either side ("(none)" equals "(none)"). That is
 * why unmeasured is counted separately and loudly — a comparison that cannot
 * tell "identical" from "I found neither" is worse than no comparison.
 *
 *  A. 39 computed properties on both dashboards, side by side.
 *  B. Touch targets at 390px on both navigations.
 *  C. Exactly one navigation visible at every width, on both.
 *  D. The shell tokens on every portal page, not just the dashboard.
 *
 * Read with getComputedStyle and getBoundingClientRect. Never from class names:
 * identical classes render differently inside different parents, and different
 * classes can render the same.
 */
const pw = await import("file:///C:/xampp/htdocs/anutechbilling/production/node_modules/playwright/index.js");
const chromium = pw.chromium ?? pw.default.chromium;

const PROBE = () => {
  const px = (n) => `${Math.round(parseFloat(n) || 0)}px`;
  const g = (el, p) => (el ? getComputedStyle(el)[p] : null);
  const o = {};

  const aside = document.querySelector("aside");
  o["rail.width"] = aside ? px(g(aside, "width")) : "(none)";
  o["rail.position"] = g(aside, "position") ?? "(none)";
  o["rail.borderRight"] = aside ? `${px(g(aside, "borderRightWidth"))} ${g(aside, "borderRightColor")}` : "(none)";
  o["rail.background"] = g(aside, "backgroundColor") ?? "(none)";
  o["page.background"] = getComputedStyle(document.body).backgroundColor;

  const header = document.querySelector("header");
  o["header.height"] = header ? px(g(header, "height")) : "(none)";
  o["header.borderBottom"] = header ? `${px(g(header, "borderBottomWidth"))} ${g(header, "borderBottomColor")}` : "(none)";
  const crumb = document.querySelector('nav[aria-label="Breadcrumb"]');
  o["breadcrumb.present"] = crumb ? "yes" : "no";
  o["breadcrumb.fontSize"] = crumb ? px(g(crumb, "fontSize")) : "(none)";
  o["breadcrumb.color"] = g(crumb, "color") ?? "(none)";

  const h1 = document.querySelector("h1");
  o["h1.fontFamily"] = (g(h1, "fontFamily") ?? "").split(",")[0].replace(/["']/g, "");
  o["h1.fontSize"] = h1 ? px(g(h1, "fontSize")) : "(none)";
  o["h1.color"] = g(h1, "color") ?? "(none)";
  const eyebrow = h1?.parentElement?.querySelector("p");
  o["eyebrow.fontSize"] = eyebrow ? px(g(eyebrow, "fontSize")) : "(none)";
  o["eyebrow.transform"] = g(eyebrow, "textTransform") ?? "(none)";
  o["eyebrow.letterSpacing"] = eyebrow ? px(g(eyebrow, "letterSpacing")) : "(none)";
  o["eyebrow.color"] = g(eyebrow, "color") ?? "(none)";

  const row = h1?.closest("div")?.parentElement;
  const primary = [...(row?.querySelectorAll("a,button") ?? [])].find((b) => {
    const bg = getComputedStyle(b).backgroundColor;
    return bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
  });
  o["primaryAction.bg"] = g(primary, "backgroundColor") ?? "(none)";
  o["primaryAction.height"] = primary ? px(g(primary, "height")) : "(none)";
  o["primaryAction.radius"] = primary ? px(g(primary, "borderRadius")) : "(none)";

  const kpiLabel = [...document.querySelectorAll("span,div,p")].find((el) => {
    if (el.children.length !== 0) return false;
    if (getComputedStyle(el).textTransform !== "uppercase") return false;
    const box = el.closest("div")?.closest("div[class*='rounded']");
    if (!box) return false;
    const bs = getComputedStyle(box);
    return parseFloat(bs.borderTopWidth) > 0 && parseFloat(bs.borderRadius) >= 8;
  });
  const kpi = kpiLabel?.closest("div[class*='border']");
  o["kpi.radius"] = kpi ? px(g(kpi, "borderRadius")) : "(none)";
  o["kpi.border"] = kpi ? `${px(g(kpi, "borderTopWidth"))} ${g(kpi, "borderTopColor")}` : "(none)";
  o["kpi.background"] = g(kpi, "backgroundColor") ?? "(none)";
  o["kpi.padding"] = kpi ? px(g(kpi, "paddingTop")) : "(none)";
  o["kpiLabel.fontSize"] = kpiLabel ? px(g(kpiLabel, "fontSize")) : "(none)";
  o["kpiLabel.color"] = g(kpiLabel, "color") ?? "(none)";

  const act = document.querySelector('aside a[aria-current="page"]');
  o["navActive.bg"] = g(act, "backgroundColor") ?? "(none)";
  o["navActive.color"] = g(act, "color") ?? "(none)";
  o["navActive.weight"] = g(act, "fontWeight") ?? "(none)";
  o["navActive.radius"] = act ? px(g(act, "borderRadius")) : "(none)";
  o["navActive.minHeight"] = act ? px(g(act, "minHeight")) : "(none)";

  const grp = document.querySelector("aside nav button[aria-expanded]");
  o["navGroup.present"] = grp ? "yes" : "no";
  o["navGroup.fontSize"] = grp ? px(g(grp, "fontSize")) : "(none)";
  o["navGroup.padding"] = grp ? `${px(g(grp, "paddingTop"))}/${px(g(grp, "paddingLeft"))}` : "(none)";

  const card = [...document.querySelectorAll("div")].find((el) => {
    const s = getComputedStyle(el);
    return parseFloat(s.borderTopWidth) > 0 && parseFloat(s.borderRadius) >= 8 &&
      el.getBoundingClientRect().width > 300 && el.querySelector("h3") &&
      s.borderTopColor === "rgb(230, 224, 214)";
  });
  o["card.radius"] = card ? px(g(card, "borderRadius")) : "(none)";
  o["card.border"] = card ? `${px(g(card, "borderTopWidth"))} ${g(card, "borderTopColor")}` : "(none)";
  o["card.background"] = g(card, "backgroundColor") ?? "(none)";
  const h3 = card?.querySelector("h3") ?? document.querySelector("h3");
  o["sectionTitle.fontFamily"] = (g(h3, "fontFamily") ?? "").split(",")[0].replace(/["']/g, "");
  o["sectionTitle.fontSize"] = h3 ? px(g(h3, "fontSize")) : "(none)";
  return o;
};

const browser = await chromium.launch({ channel: "chrome" });

const staffCtx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, hasTouch: true });
const staff = await staffCtx.newPage();
await staff.goto("http://localhost:3000/login", { waitUntil: "load" });
await staff.waitForLoadState("networkidle").catch(() => {});
await staff.waitForTimeout(2500);
await staff.getByRole("button", { name: /pardeep@anutech\.in/ }).click();
await staff.waitForTimeout(400);
await staff.getByRole("button", { name: "Sign in", exact: true }).click();
await staff.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 90_000 });
await staff.goto("http://localhost:3000/dashboard", { waitUntil: "load" });
await staff.waitForLoadState("networkidle").catch(() => {});
await staff.waitForTimeout(3000);
if ((await staff.evaluate(() => location.pathname)) !== "/dashboard") { console.log("ABORT staff"); await browser.close(); process.exit(1); }
const A = await staff.evaluate(PROBE);

const portalCtx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, hasTouch: true });
const portal = await portalCtx.newPage();
await portal.goto("http://localhost:3000/login", { waitUntil: "load" });
await portal.waitForLoadState("networkidle").catch(() => {});
await portal.waitForTimeout(2500);
await portal.locator('form[action="/api/dev/portal-signin"] button').first().click();
await portal.waitForURL(/\/portal\/dashboard/, { timeout: 90_000 });
await portal.waitForLoadState("networkidle").catch(() => {});
await portal.waitForTimeout(2000);
if ((await portal.evaluate(() => location.pathname)) !== "/portal/dashboard") { console.log("ABORT portal"); await browser.close(); process.exit(1); }
const B = await portal.evaluate(PROBE);

// ── A ──────────────────────────────────────────────────────────────────
const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])];
let same = 0, diff = 0, unmeasured = 0;
const bad = [];
for (const k of keys) {
  const a = String(A[k]), b = String(B[k]);
  if (a === "(none)" && b === "(none)") { unmeasured++; bad.push(`? ${k}: unmeasured on both`); }
  else if (a === b) same++;
  else { diff++; bad.push(`≠ ${k}: staff ${a}  |  portal ${b}`); }
}
console.log(`A. dashboard properties   same ${same} · different ${diff} · unmeasured ${unmeasured}  (of ${keys.length})`);
bad.forEach((l) => console.log("     " + l));

// ── B ──────────────────────────────────────────────────────────────────
const tapStaff = await (async () => {
  await staff.setViewportSize({ width: 390, height: 900 });
  await staff.waitForTimeout(900);
  await staff.locator("header button").first().click();
  await staff.waitForTimeout(1200);
  return staff.evaluate(() => {
    const s = document.querySelector('[role="dialog"]') || document.querySelector("aside");
    const h = (q) => [...s.querySelectorAll(q)].map((e) => Math.round(e.getBoundingClientRect().height)).filter((x) => x > 0);
    const l = h("a"), g = h("button[aria-expanded]");
    return { n: l.length + g.length, under: [...l, ...g].filter((x) => x < 44).length, min: Math.min(...l, ...g) };
  });
})();
const tapPortal = await (async () => {
  await portal.setViewportSize({ width: 390, height: 900 });
  await portal.waitForTimeout(900);
  return portal.evaluate(() => {
    const navs = [...document.querySelectorAll('nav[aria-label="Portal sections"]')].filter((n) => n.offsetParent !== null);
    const els = navs.flatMap((n) => [...n.querySelectorAll("a")]);
    const hs = els.map((e) => Math.round(e.getBoundingClientRect().height)).filter((x) => x > 0);
    return { n: hs.length, under: hs.filter((x) => x < 44).length, min: hs.length ? Math.min(...hs) : null };
  });
})();
console.log(`B. touch targets @390px   staff: ${tapStaff.n} rows, min ${tapStaff.min}px, under-44 ${tapStaff.under}  |  portal: ${tapPortal.n} rows, min ${tapPortal.min}px, under-44 ${tapPortal.under}`);

// ── C ──────────────────────────────────────────────────────────────────
const countNavs = async (page, sel) => {
  const out = [];
  for (const w of [390, 767, 820, 1024, 1100, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(350);
    const v = await page.evaluate((s) => [...document.querySelectorAll(s)]
      .filter((n) => n.offsetParent !== null && n.getBoundingClientRect().height > 0).length, sel);
    out.push(`${w}:${v}`);
  }
  return out.join(" ");
};
console.log(`C. navs visible (portal)   ${await countNavs(portal, 'nav[aria-label="Portal sections"]')}   (want 1 at every width)`);

// ── D ──────────────────────────────────────────────────────────────────
await portal.setViewportSize({ width: 1440, height: 1000 });
const PAGES = ["/portal/domains", "/portal/hosting", "/portal/invoices", "/portal/orders",
                "/portal/subscription", "/portal/billing", "/portal/support", "/portal/profile", "/portal/shop"];
const shells = [];
for (const p of PAGES) {
  await portal.goto(`http://localhost:3000${p}`, { waitUntil: "load" });
  await portal.waitForLoadState("networkidle").catch(() => {});
  await portal.waitForTimeout(600);
  const d = await portal.evaluate(() => {
    const aside = document.querySelector("aside");
    const header = document.querySelector("header");
    const h1 = document.querySelector("h1");
    return {
      rail: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
      header: header ? Math.round(header.getBoundingClientRect().height) : 0,
      h1: h1 ? Math.round(parseFloat(getComputedStyle(h1).fontSize)) : 0,
      crumb: !!document.querySelector('nav[aria-label="Breadcrumb"]'),
    };
  });
  shells.push({ p, ...d });
}
const ok = shells.every((s) => s.rail === A["rail.width"].replace("px", "") * 1 && s.header === 56 && s.h1 === 36 && s.crumb);
console.log(`D. every portal page       rail ${[...new Set(shells.map((s) => s.rail))].join("/")}px · header ${[...new Set(shells.map((s) => s.header))].join("/")}px · h1 ${[...new Set(shells.map((s) => s.h1))].join("/")}px · breadcrumb on ${shells.filter((s) => s.crumb).length}/${shells.length}  → ${ok ? "all match the dashboard" : "MISMATCH"}`);

await browser.close();
