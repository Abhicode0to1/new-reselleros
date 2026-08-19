/**
 * Navigation config — single source of truth for sidebar + breadcrumbs.
 *
 * Adding a new screen?
 * 1. Add an entry to APP_NAV
 * 2. Add a breadcrumb to SCREEN_TITLES
 * 3. Create the page at src/app/(app)/[id]/page.tsx
 */

// Roles live in one place now — see src/lib/auth/roles.ts for why. Re-exported
// so the many `import { UserRole } from "@/lib/nav"` call sites keep working.
import type { UserRole } from "@/lib/auth/roles";
export type { UserRole };

export interface NavItem {
  id: string;
  /** URL path (relative, starts with /) */
  href: string;
  label: string;
  /** Icon name from our Icon component */
  icon: string;
  /** Optional badge text (e.g., count of pending items) */
  badge?: string;
  /**
   * Roles that can see this nav item. Omit = visible to everyone (default).
   * Use to lock down sales-only or owner-only entries. Filtered in Sidebar.tsx.
   */
  roles?: UserRole[];
  /** Sub-links rendered as an accordion under this item (e.g. Reports → sub-reports). */
  children?: NavItem[];
  /** External URL — opens in a new tab (e.g. Google Drive) instead of in-app routing. */
  external?: boolean;
  /** Hover tooltip — a one-line hint so a data-entry user knows what belongs here. */
  hint?: string;
}

export interface NavSection {
  section: string;
  /** Icon for the group header (Zoho-style expandable group). */
  icon?: string;
  items: NavItem[];
  /** Roles that can see this section. Omit = visible to everyone. */
  roles?: UserRole[];
}

/**
 * Filter nav sections + items by the caller's role. Sections whose every item is
 * filtered out are dropped. Used by Sidebar to render a role-appropriate menu.
 *
 * ─── THE can_view_deals GATE IS GONE (17 Aug 2026) ──────────────────────────
 * Removed because Pardeep confirmed the requirement is obsolete: everyone on the team
 * should see the pipeline.
 *
 * BE CLEAR ABOUT WHAT THIS CHANGED, because it is more than a menu. This function
 * feeds allowedRoutesForRole(), which middleware:105 uses to decide whether a request
 * is permitted at all — a plain `sales` user without the flag typing /deals was
 * redirected to their ROLE_HOME. So the gate had teeth in BOTH places: it hid the menu
 * item AND blocked the route. Removing it opens the route to every sales user, which
 * is the intended outcome and not a side effect.
 *
 * (An earlier note in deals/page.tsx claimed the gate lived in middleware's
 * PROTECTED_PREFIXES. It did not — that list is the auth check. The real enforcement
 * was this function, one call away. Worth knowing if a restriction is ever wanted
 * again: this is where it goes.)
 *
 * The `can_view_deals` COLUMN is deliberately left in the database and on the /team
 * screen. Dropping a permission column is not a one-step reversal, and if a real
 * restriction is wanted later it should be re-applied here — or, better, as a
 * server-side row filter, since hiding a page never hid the underlying data from the
 * API.
 */
export interface NavFilterOpts {
  /** No longer used for gating. Accepted so existing callers keep compiling until
   *  they are tidied; passing it changes nothing. */
  canViewDeals?: boolean;
}
export function filterNavForRole(
  nav: NavSection[],
  role: UserRole | undefined,
  /* Accepted and ignored — see NavFilterOpts. Kept in the signature so the three
     existing call sites (Sidebar, MobileBottomNav, command palette) keep compiling
     until they are tidied separately. */
  _opts: NavFilterOpts = {},
): NavSection[] {
  if (!role) return nav;
  // "sales_senior" sees the same menu as "sales" (visibility), but is NEVER
  // gated on the deals entry — a senior seller always handles the pipeline.
  const visRole: UserRole = role === "sales_senior" ? "sales" : role;
  return nav
    .filter((s) => !s.roles || s.roles.includes(visRole))
    .map((s) => ({
      ...s,
      items: s.items.filter((i) => !i.roles || i.roles.includes(visRole)),
    }))
    .filter((s) => s.items.length > 0);
}

/**
 * The set of routes a given role + permission set is allowed to visit.
 * Anything outside this set is redirected to ROLE_HOME[role] by middleware.
 */
export function allowedRoutesForRole(role: UserRole, opts: NavFilterOpts = {}): string[] {
  return filterNavForRole(APP_NAV, role, opts).flatMap((s) => s.items.map((i) => i.href));
}

/** Where each role lands by default (after login + on disallowed-route redirect). */
export const ROLE_HOME: Record<UserRole, string> = {
  owner:        "/dashboard",
  manager:      "/dashboard",
  sales:        "/leads",
  /* Was "/deals". Repointed with the same commit that removed the Deal Pipeline nav
     entry, and that ORDER matters: ROLE_HOME and allowedRoutesForRole are two halves
     of one rule, and a home the role can no longer reach makes middleware redirect to
     it, disallow it, and redirect again — the ERR_TOO_MANY_REDIRECTS login loop this
     file already records once. */
  sales_senior: "/leads",
  // The CA / accountant lands on the P&L — the headline figure for ITR.
  accountant:   "/accounting/pnl",
  support:      "/support",
  billing:      "/invoices",
  delivery:     "/projects",
  // MUST have a matching APP_NAV entry that admits this role (see the Admin &
  // Control section). ROLE_HOME and allowedRoutesForRole are two halves of one
  // rule: a home the role is not allowed to visit makes middleware redirect to
  // it, disallow it, and redirect again — a login that ends in a loop.
  partner_agent: "/partners",
};

// ============================================================
// Internal app nav (the main sidebar for resellers)
// ============================================================
// Role conventions (applied to APP_NAV entries below):
//   • Items without an explicit `roles` list → visible to owner + manager.
//   • Sales-only users see ONLY the items explicitly tagged with "sales".
//   • Lead Pipeline + Tasks include "sales" because that's the day-to-day
//     surface for lead-only sellers (per Darshan's role at Excel Tech).
// Zoho-Books-style navigation: a few top-level EXPANDABLE groups (icon + label
// + chevron) instead of one long always-open wall. "Home" is a standalone row;
// every other group starts collapsed and auto-opens when you're inside it.
// Item hrefs are unchanged — only the grouping/labels changed — so routing +
// allowed-routes stay identical.
export const APP_NAV: NavSection[] = [
  {
    // Accountant / CA view — read-only compliance reports only.
    section: "Filing",
    icon: "file",
    roles: ["accountant"],
    items: [
      { id: "acc-pnl",     href: "/accounting/pnl",            label: "P&L Report",     icon: "trending_up" },
      { id: "acc-bs",      href: "/accounting/balance-sheet",  label: "Balance Sheet",  icon: "layout" },
      { id: "acc-cf",      href: "/accounting/cash-flow",      label: "Cash Flow",      icon: "rupee" },
      { id: "acc-gst",     href: "/accounting/gst",            label: "GST Reports",    icon: "file" },
      { id: "acc-tds",     href: "/accounting/tds-receivable", label: "TDS Receivable", icon: "rupee" },
      { id: "acc-esi",     href: "/accounting/esi-register",   label: "ESI Register",   icon: "file" },
      { id: "acc-aging",   href: "/accounting/aging",          label: "Customer Aging", icon: "clock" },
      /* Beside Customer Aging on purpose: aging answers "who owes me, across everyone",
         the ledger answers "send me MY statement" for one party. Different questions,
         adjacent in the menu so nobody builds a third page for the second one. */
      { id: "acc-ledger",  href: "/accounting/ledger",         label: "Ledger (Khata)", icon: "file" },
    ],
  },
  {
    section: "Home",
    icon: "home",
    items: [
      { id: "dashboard", href: "/dashboard", label: "Dashboard", icon: "home", roles: ["owner", "manager", "billing"] },
      { id: "my-attendance", href: "/attendance/me", label: "My Attendance", icon: "calendar", roles: ["owner", "manager", "sales", "sales_senior", "accountant", "support", "billing", "delivery"], hint: "Apni attendance khud mark karo — login hi identity proof hai." },
      { id: "my-expenses", href: "/my-expenses", label: "My Advance & Expenses", icon: "wallet", roles: ["owner", "manager", "sales", "sales_senior", "accountant", "support", "billing", "delivery"], hint: "Advance cash balances & mobile expense entries." },
    ],
  },
  {
    section: "Sales & CRM",
    icon: "target",
    roles: ["owner", "manager", "sales", "billing"],
    items: [
      { id: "leads",           href: "/leads",            label: "Sales & Pipeline", icon: "target", roles: ["owner", "manager", "sales"] },
      // /deals was referenced by ROLE_HOME.sales_senior and by the canViewDeals
      // special case in filterNavForRole, but the ITEM never existed here. So
      // allowedRoutesForRole could not return it, middleware bounced every
      // sales_senior to /deals, found /deals disallowed, and bounced again —
      // ERR_TOO_MANY_REDIRECTS on login, for that whole role. The id must stay
      // "deals": the canViewDeals gate above matches on it.
      /* "Deal Pipeline" removed 17 Aug 2026. /leads now shows every OPEN lead
         whatever stage it reached, with the Board view for drag-drop, so there is
         nothing left for a second entry to show. The ROUTE stays alive (bookmarks,
         and it was the sales_senior landing until today) and resolves to the same
         list — see deals/page.tsx.

         The id must NOT be reused: nav.ts:71's old gate matched on it, and the
         command palette flattens every item by id. */
      { id: "enquiries",       href: "/enquiries",        label: "Enquiries",     icon: "mail",   roles: ["owner", "manager", "sales"] },
      { id: "tasks",           href: "/tasks",            label: "Tasks",         icon: "clock",  roles: ["owner", "manager", "sales"] },
      // Same destination as the Home entry above, deliberately listed twice for
      // reach. The id must still differ: the command palette flattens every
      // section into one list and indexes on id, so two entries sharing one id
      // silently drop to a single result.
      { id: "my-expenses-sales", href: "/my-expenses",    label: "My Advance & Expenses", icon: "wallet", roles: ["owner", "manager", "sales"] },
      { id: "customers",       href: "/customers",        label: "Customers",     icon: "users",  roles: ["owner", "manager", "billing"] },
      { id: "customer-groups", href: "/customers/groups", label: "Parent Accounts", icon: "layout", roles: ["owner", "manager"] },
      { id: "contacts",        href: "/contacts",         label: "Contacts",      icon: "user",   roles: ["owner", "manager", "billing"] },
      { id: "referrals",       href: "/referrals",        label: "Referrals",     icon: "award",  roles: ["owner", "manager"] },
    ],
  },
  {
    // Its own group rather than a line under Sales: marketing answers "where do
    // leads come from and what does each cost", which is a different question
    // from "what is in the pipeline" — and this group is where campaigns,
    // channels and attribution will land as they get built.
    //
    // owner/manager only. It shows ad spend and CAC, which are the owner's
    // numbers, not something a rep needs to open their day on.
    section: "Marketing",
    icon: "chart",
    roles: ["owner", "manager"],
    items: [
      // Labelled "Marketing", not "ROAS & CAC", ON PURPOSE. The Sidebar renders
      // a section holding exactly one item as a standalone row with no group
      // header (see Sidebar.tsx), so the section NAME is invisible today — the
      // user would see a lone "ROAS & CAC" link and never learn there is a
      // Marketing area. Rename this to "ROAS & CAC" the moment a second
      // marketing page lands and the real "Marketing" header appears.
      { id: "marketing-roas", href: "/marketing/reports", label: "Marketing", icon: "chart", roles: ["owner", "manager"] },
    ],
  },
  {
    section: "Billing & Subscriptions",
    icon: "rupee",
    roles: ["owner", "manager", "sales", "billing", "delivery", "support"],
    items: [
      { id: "quotes",        href: "/quotes",        label: "Quotes",            icon: "file",    roles: ["owner", "manager", "sales"] },
      { id: "subscriptions", href: "/subscriptions", label: "Subscriptions",     icon: "refresh", roles: ["owner", "manager", "billing"] },
      { id: "renewals",      href: "/renewals",      label: "Renewals",          icon: "clock",   roles: ["owner", "manager", "billing", "support"] },
      { id: "invoices",      href: "/invoices",      label: "Invoices",          icon: "receipt", roles: ["owner", "manager", "billing"] },
      { id: "payments",      href: "/payments",      label: "Payments Received", icon: "rupee",   roles: ["owner", "manager", "billing"] },
      { id: "projects",      href: "/projects",      label: "Project Sales",     icon: "package", roles: ["owner", "manager", "sales", "delivery", "billing"] },
    ],
  },
  {
    section: "Operations",
    icon: "package",
    roles: ["owner", "manager", "billing", "support", "delivery"],
    items: [
      { id: "items",     href: "/items",           label: "Catalog & Products", icon: "package", roles: ["owner", "manager"] },
      { id: "documents", href: "/documents",       label: "Company Documents",  icon: "file",    roles: ["owner", "manager"] },
      { id: "support",   href: "/support",         label: "Support Desk",        icon: "ticket" },
      { id: "whatsapp",  href: "/whatsapp",        label: "WhatsApp Inbox",      icon: "whatsapp" },
    ],
  },
  {
    section: "Purchases & Vendors",
    icon: "cart",
    roles: ["owner", "manager", "billing"],
    items: [
      { id: "vendor-portal",   href: "/vendor-portal",             label: "Vendor Portal & Bids", icon: "sparkles", hint: "Vendor marketplace, wholesale license rate bids & PO sourcing." },
      { id: "purchase-orders", href: "/purchase-orders",           label: "Purchase Orders",      icon: "cart" },
      { id: "vendors",         href: "/accounting/vendors",        label: "Vendors Master",       icon: "users" },
      { id: "bills",           href: "/accounting/bills",          label: "COGS Bills",           icon: "receipt" },
      { id: "bill-payments",   href: "/accounting/bill-payments",  label: "Payments Made",        icon: "rupee" },
      { id: "expenses",        href: "/accounting/expenses",       label: "Expenses",             icon: "rupee" },
    ],
  },
  {
    section: "Accounting & Finance",
    icon: "chart",
    roles: ["owner", "manager", "billing", "accountant"],
    items: [
      { id: "reports",             href: "/reports",                  label: "Reports Hub",         icon: "chart" },
      { id: "acc-overview",        href: "/accounting",               label: "Accounting Overview", icon: "layout" },
      { id: "banking",             href: "/accounting/banking",       label: "Banking",             icon: "rupee" },
      /* The khata. It sits in BOTH this section and the accountant-only "Filing" one,
         which is not a duplication mistake — P&L, Balance Sheet and Cash Flow already do
         the same, and the command palette de-dupes by href (command-palette.tsx:122).
         Adding it only to "Filing" made it invisible to the owner, who is exactly the
         person a customer asks for a statement. */
      { id: "ledger",              href: "/accounting/ledger",        label: "Ledger (Khata)",      icon: "file" },
      /* These three lived ONLY in the accountant-only "Filing" section, so the owner —
         the person who actually files the GST return and chases the money — had no menu
         route to any of them. They were reachable (middleware exempts owner and manager,
         middleware.ts:103) and reachable is not the same as findable: an owner who does
         not know the URL simply does not have the feature.
         GST Reports is the sharpest of the three. It is a monthly statutory deadline. */
      { id: "acc-aging-owner",     href: "/accounting/aging",         label: "Customer Aging",      icon: "clock" },
      { id: "pnl",                 href: "/accounting/pnl",           label: "P&L Report",          icon: "trending_up" },
      { id: "balance-sheet",       href: "/accounting/balance-sheet", label: "Balance Sheet",       icon: "layout" },
      { id: "cash-flow",           href: "/accounting/cash-flow",     label: "Cash Flow",           icon: "rupee" },
      { id: "gst-owner",           href: "/accounting/gst",           label: "GST Reports",         icon: "file" },
      { id: "tds-owner",           href: "/accounting/tds-receivable",label: "TDS Receivable",      icon: "rupee" },
      { id: "compliance-calendar", href: "/compliance",               label: "Compliance Calendar", icon: "calendar" },
    ],
  },
  {
    section: "HR & Payroll",
    icon: "users",
    roles: ["owner", "manager", "billing"],
    items: [
      { id: "employees",         href: "/accounting/employees",       label: "Employees & Team",       icon: "users" },
      { id: "attendance-reg",    href: "/accounting/attendance",      label: "Attendance Register",    icon: "calendar", hint: "Daily attendance logs, check-in/out & hours." },
      { id: "leave-reg",         href: "/accounting/leave",           label: "Leave Register",         icon: "file",     hint: "Casual leave, sick leave & earned leave tracking." },
      { id: "payroll",           href: "/accounting/payroll",         label: "Payroll Overview",       icon: "rupee" },
      { id: "salary-register",   href: "/accounting/salary-register", label: "Salary & Payroll Register", icon: "receipt", hint: "Monthly salary slip register, CTC & net payouts." },
      { id: "esi-register",      href: "/accounting/esi-register",    label: "ESI & PF Register",      icon: "file" },
      { id: "emp-loans",         href: "/accounting/loans",           label: "Loans & Salary Advances",icon: "rupee" },
    ],
  },
  {
    section: "Admin & Control",
    icon: "settings",
    roles: ["owner", "manager", "billing", "partner_agent"],
    items: [
      { id: "settings",  href: "/settings",             label: "Settings",         icon: "settings", roles: ["owner", "manager", "billing"] },
      // The ONLY entry partner_agent can see. It is also ROLE_HOME for that
      // role, so this line is what keeps their login from looping.
      { id: "partners",  href: "/partners",             label: "Partners",         icon: "award", roles: ["owner", "manager", "partner_agent"] },
      // owner/manager only — these are customers' admin console passwords, and
      // "billing" has no reason to reach a Google Admin login.
      { id: "vault",     href: "/vault",                label: "Password Vault",   icon: "lock", roles: ["owner", "manager"] },
      /* The owner's PRIVATE books — personal bank, drawings, net worth. Owner-only here,
         but understand what this line does and does not do: middleware skips its role
         guard entirely for `owner` AND `manager`, so this hides the menu item and nothing
         more. The data is protected by RLS scoped to auth.uid(), proven by
         supabase/tests/personal_vault_owner_isolation.test.sql. Note it is per-USER, not
         per-role: this tenant has three owners and none of them may read another's. */
      { id: "vault-personal", href: "/vault/personal",  label: "Private Vault",    icon: "wallet", roles: ["owner"], hint: "Aapke apne paise — team me kisi ko nahi dikhta" },
      /* Third page found with no nav entry, after Marketing and Backup. /team
         had a breadcrumb — so the app knew its NAME — and exactly one link in
         the whole codebase, buried in the Add Task dialog's help text. It is
         where teammates are invited, where a stranded colleague is claimed, and
         where join requests are approved; none of that was reachable by
         clicking. */
      { id: "team",      href: "/team",                 label: "Team",             icon: "users", roles: ["owner", "manager"] },
      /* Owner-only, and it had NO nav entry at all — the page existed, the
         breadcrumb below knew its name, and nothing anywhere linked to it. So the
         restore points and the data reset were reachable only by typing the URL.
         A safety feature nobody can find is not a safety feature; this is the
         same failure the Marketing group had. */
      { id: "backup",    href: "/settings/backup",      label: "Backup & Restore", icon: "database", roles: ["owner"] },
      /* The triage queue for bug reports the team files with Ctrl+Shift+B. Owner and
         manager only: the reports name source files and quote whatever the reporter
         typed, which regularly includes a customer's name and what went wrong for them. */
      { id: "feedback",  href: "/admin/feedback",       label: "Feedback & AI Fixes", icon: "bug", roles: ["owner", "manager"] },
      { id: "help",      href: "/help",                 label: "Help & Tutorial",  icon: "question" },
    ],
  },
];

// ============================================================
// Customer-facing pages (chromeless — used in nav switcher)
// ============================================================
export const CUSTOMER_NAV: NavSection[] = [
  {
    section: "Customer-facing",
    items: [
      { id: "landing",          href: "/",                  label: "Marketing Landing", icon: "globe" },
      { id: "buy-workspace",    href: "/buy/workspace",     label: "Buy · Workspace",   icon: "sparkles" },
      { id: "buy-m365",         href: "/buy/m365",          label: "Buy · Microsoft 365", icon: "package" },
      { id: "buy-zoho",         href: "/buy/zoho",          label: "Buy · Zoho",        icon: "package" },
      { id: "portal",           href: "/portal",            label: "Customer Portal",   icon: "layout" },
      { id: "quote-accept",     href: "/quote/Q-2026-0042", label: "Quote Accept & Pay", icon: "check_circle" },
      { id: "support-customer", href: "/support-customer",  label: "Customer Support",  icon: "question" },
    ],
  },
];

// ============================================================
// Breadcrumb titles — by URL path
// ============================================================
// NB: /leads + /deals share the same component (the /deals route file
//     re-exports from /leads). The titles still need separate entries here.
export const SCREEN_TITLES: Record<string, string[]> = {
  "/dashboard":       ["Home", "Dashboard"],
  "/leads":           ["Sales", "Leads"],
  "/my-expenses":     ["Me", "My Advance & Expenses"],
  "/vault":           ["Admin", "Password Vault"],
  "/admin/feedback":  ["Admin", "Feedback & AI Fixes"],
  "/vault/personal":  ["Admin", "Private Vault"],
  "/marketing/reports": ["Marketing", "ROAS & CAC"],
  "/enquiries":       ["Sales", "Enquiries"],
  "/deals":           ["Sales", "Deal Pipeline"],
  "/tasks":           ["Sales", "Tasks"],
  "/customers":       ["Sales", "Customers"],
  "/customers/groups":      ["Sales", "Parent Accounts"],
  "/customers/groups/[id]": ["Sales", "Parent Accounts", "Detail"],
  "/customers/new":   ["Sales", "Customers", "New"],
  "/customers/[id]":  ["Sales", "Customers", "Profile"],
  "/customers/[id]/edit": ["Sales", "Customers", "Edit"],
  "/contacts":        ["Sales", "Contacts"],
  "/contacts/[id]":   ["Sales", "Contacts", "Profile"],
  "/referrals":       ["Sales", "Referrals"],
  "/online-orders":   ["Revenue", "Online Orders"],
  "/quotes":          ["Revenue", "Quotes"],
  "/quotes/new":      ["Revenue", "Quotes", "New"],
  "/quotes/[id]":     ["Revenue", "Quotes", "Detail"],
  "/projects":        ["Revenue", "Project Sales"],
  "/projects/[id]":   ["Revenue", "Project Sales", "Detail"],
  "/payments":        ["Revenue", "Payments Received"],
  "/invoices":        ["Revenue", "Invoices"],
  "/invoices/[id]":   ["Revenue", "Invoices", "Detail"],
  "/subscriptions":   ["Revenue", "Subscriptions"],
  "/renewals":        ["Revenue", "Renewals"],
  "/vendor-portal":   ["Purchases", "Vendor Portal & Bids"],
  "/purchase-orders": ["Purchases", "Purchase Orders"],
  "/accounting/vendors":       ["Purchases", "Vendors"],
  "/accounting/bills":         ["Purchases", "COGS Bills"],
  "/accounting/bill-payments": ["Purchases", "Payments Made"],
  "/accounting/expenses":      ["Purchases", "Expenses"],
  "/accounting/reimbursements": ["Purchases", "Reimbursements"],
  "/accounting":               ["Accounting", "Overview"],
  "/accounting/saas-metrics":  ["Accounting", "SaaS Metrics"],
  "/accounting/ledger":        ["Accounting", "Ledger"],
  "/accounting/banking":       ["Accounting", "Banking"],
  "/accounting/banking/[id]":  ["Accounting", "Banking", "Account"],
  "/accounting/business-loans": ["Accounting", "Business Loans"],
  "/accounting/pnl":           ["Accounting", "P&L Report"],
  "/accounting/balance-sheet": ["Accounting", "Balance Sheet"],
  "/accounting/cash-flow":     ["Accounting", "Cash Flow"],
  "/accounting/assets":        ["Accounting", "Assets & EMIs"],
  "/accounting/prepaid":       ["Accounting", "Prepaid / Advances"],
  "/accounting/profitability": ["Accounting", "Customer Margin"],
  "/accounting/aging":         ["Accounting", "Customer Aging"],
  "/accounting/esi-register":  ["Payroll", "ESI Register"],
  "/performance":              ["Payroll", "Team Performance"],
  "/assessments":              ["Payroll", "Reasoning Tests"],
  "/accounting/tds-receivable":          ["Accounting", "TDS Receivable"],
  "/accounting/tds-receivable/year-end": ["Accounting", "TDS Receivable", "Year-End"],
  "/accounting/gst":      ["Accounting", "GST Reports"],
  "/compliance":            ["Compliance", "Compliance Calendar"],
  "/compliance/roc":        ["Compliance", "ROC / MCA"],
  "/compliance/gst":        ["Compliance", "GST Returns"],
  "/compliance/income-tax": ["Compliance", "Income Tax & TDS"],
  "/accounting/loans":         ["Payroll", "Loans & Advances"],
  "/accounting/employees":     ["Payroll", "Employees"],
  "/accounting/payroll":       ["Payroll", "Payroll"],
  "/accounting/salary-register": ["Payroll", "Salary Register"],
  "/accounting/leave":         ["Payroll", "Leave Register"],
  "/accounting/attendance":    ["Payroll", "Attendance Register"],
  "/attendance/kiosk":         ["Payroll", "Attendance Kiosk"],
  "/attendance/me":            ["My Attendance"],
  "/activity":                 ["Reports", "Activity Log"],
  "/scorecard":                ["Payroll", "Scorecards"],
  "/whatsapp":        ["Engage", "WhatsApp Inbox"],
  "/campaigns":       ["Engage", "Campaigns"],
  "/online-promos":   ["Engage", "Online Promos"],
  "/coupons":         ["Engage", "Coupons"],
  "/reports":         ["Reports", "All Reports"],
  "/reports/profit":  ["Reports", "Profit by product/service"],
  "/reports/purchases": ["Reports", "Purchase report"],
  "/purchases/inbox":   ["Purchases", "Purchase Inbox"],
  "/support":         ["Engage", "Support"],
  "/items":           ["Catalog"],
  "/documents":       ["Company Documents", "Documents"],
  "/settings":        ["Settings", "Settings"],
  "/settings/backup": ["Settings", "Backup"],
  "/team":            ["Settings", "Team"],
  "/partners":        ["Settings", "Partners"],
  "/lead-gen":        ["Settings", "Lead Sources"],
  "/mobile":          ["Settings", "Mobile (PWA)"],
  "/setup":           ["Settings", "Setup Wizard"],
  "/help":            ["Help", "Help & Tutorial"],
};

/**
 * Get breadcrumb path for a URL.
 * Falls back to ["Home", "Dashboard"] — the same crumb `/dashboard` itself maps
 * to. (Was ["Workspace", …]: a section that no longer exists in APP_NAV, so a
 * shell-rendered route with no SCREEN_TITLES entry — e.g. /platform — showed a
 * stale section name.)
 */
export function getCrumb(pathname: string): string[] {
  if (SCREEN_TITLES[pathname]) return SCREEN_TITLES[pathname];
  const segs = pathname.split("/").filter(Boolean);
  // Dynamic route (e.g. /customers/<uuid>, /customers/<uuid>/edit, /quotes/Q-ET-…,
  // /accounting/banking/<id>): the exact match fails because one segment is a live
  // id. Try substituting each single segment with the `[id]` placeholder to hit a
  // templated key — this catches mid-path ids (…/[id]/edit) the plain walk-up below
  // can't, so an edit/sub-page gets its own crumb instead of the parent's.
  for (let r = segs.length - 1; r >= 1; r--) {
    const cand = "/" + segs.map((s, idx) => (idx === r ? "[id]" : s)).join("/");
    if (SCREEN_TITLES[cand]) return SCREEN_TITLES[cand];
  }
  // Fallback: walk up to the longest known parent — try the `[id]` placeholder
  // first (nicer 3-level crumb), then the bare section path. Keeps the section
  // correct instead of wrongly falling back to "Dashboard".
  for (let i = segs.length - 1; i >= 1; i--) {
    const prefix = "/" + segs.slice(0, i).join("/");
    if (SCREEN_TITLES[`${prefix}/[id]`]) return SCREEN_TITLES[`${prefix}/[id]`];
    if (SCREEN_TITLES[prefix]) return SCREEN_TITLES[prefix];
  }
  return ["Home", "Dashboard"];
}

/**
 * Get the primary destination for a section name, so a breadcrumb like
 * `Workspace / Dashboard` can wrap "Workspace" in a Link → /dashboard.
 *
 * Returns the first nav item's href in that section. If no match (the label
 * isn't a known section name — e.g., a sub-page label like "Year-End"),
 * returns null and the caller renders plain text.
 */
/**
 * Nearest ancestor list page for a detail route — `/quotes/Q-1` → `/quotes`,
 * `/customers/<id>/edit` → `/customers`, `/accounting/banking/<id>` →
 * `/accounting/banking`. Mirrors `getCrumb()`'s walk-up over the same map.
 *
 * Used by the mobile Back button when there is no history to pop, i.e. the user
 * DEEP-LINKED straight into a detail page (a quote/invoice link from WhatsApp or
 * email — the common path for this product). Always returns something navigable,
 * so Back can never dead-end (CLAUDE.md §24).
 *
 * NOTE: do not use `getSectionPrimaryHref()` for this. That takes a *section
 * name* ("Home", "Sales & CRM"), not a pathname — passing a pathname always
 * returns null.
 */
export function getParentListHref(pathname: string): string {
  const segs = pathname.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 1; i--) {
    const prefix = "/" + segs.slice(0, i).join("/");
    if (SCREEN_TITLES[prefix]) return prefix;
  }
  return "/dashboard";
}

export function getSectionPrimaryHref(sectionName: string): string | null {
  const section = APP_NAV.find((s) => s.section === sectionName);
  if (!section || section.items.length === 0) return null;
  return section.items[0].href;
}
