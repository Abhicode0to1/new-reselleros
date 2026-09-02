/**
 * Hosting landing content — ported from the engine's own landing page
 * (app.anutech.in), which is the page Pardeep wants as THE hosting page inside
 * ResellerOS (2 Sep 2026: "bilkul yahi hona chahiye meri app me").
 *
 * Everything the page says lives here, in ONE file, so copy and prices are
 * changed in a single place rather than inside markup.
 *
 * ⚠️ PLACEHOLDER CONTENT, flagged deliberately:
 *   · TRUSTED_LOGOS and TESTIMONIALS are the engine's existing placeholder
 *     names and stock portraits — they are NOT real, signed-off customer
 *     references. The rest of this site already labels such content ("Client
 *     names and figures are placeholders until the real case studies are signed
 *     off"). Replace them with real reviews, or drop the sections, before this
 *     page is promoted as the public face.
 *
 * PRICES: these mirror the engine's commercial tiers (config/hosting-plans.ts
 * there), which is what the shop actually charges today. `price` is the rate
 * when billed YEARLY; billed monthly is 2× (exactly how the engine prices it).
 * Once the DMS is deployed, `Sync hosting` on /items brings the same tiers into
 * the catalogue, and this table becomes the display fallback rather than the
 * source.
 */

export interface LandingPlan {
  planId: string;
  name: string;
  description: string;
  /** ₹/month when billed yearly. Monthly billing is 2× this. */
  price: number;
  currency: string;
  features: string[];
  highlightFeatures: string[];
  isPopular: boolean;
}

export const LANDING_PLANS: readonly LandingPlan[] = [
  {
    planId: "starter",
    name: "Starter",
    description: "Small business solution",
    price: 49.99,
    currency: "INR",
    features: [
      "10 GB SSD storage",
      "Unlimited Free SSL",
      "100GB Bandwidth",
      "Host 1 Website",
      "24/7 Phone & Email Support",
      "99.99% Uptime Guarantee",
      "Free Website Migration",
      "Backup",
    ],
    highlightFeatures: ["Host 1 Website"],
    isPopular: false,
  },
  {
    planId: "standard",
    name: "Standard",
    description: "Growing business sites",
    price: 125.0,
    currency: "INR",
    features: [
      "25 GB SSD storage",
      "Unlimited Free SSL",
      "200GB Bandwidth",
      "Host Multiple Websites",
      "24/7 Phone & Email Support",
      "99.99% Uptime Guarantee",
      "Free Website Migration",
      "Backup",
    ],
    highlightFeatures: ["Host Multiple Websites"],
    isPopular: true,
  },
  {
    planId: "plus",
    name: "Plus",
    description: "High scale sites",
    price: 187.2,
    currency: "INR",
    features: [
      "50 GB SSD storage",
      "Unlimited Free SSL",
      "Unmetered Bandwidth",
      "Host Multiple Websites",
      "24/7 Phone & Email Support",
      "99.99% Uptime Guarantee",
      "Free Website Migration",
      "Priority Support",
      "Advanced Security Features",
      "Backup",
    ],
    highlightFeatures: ["Host Multiple Websites"],
    isPopular: false,
  },
] as const;

/** ⚠️ Placeholder client names — see the file header. */
export const TRUSTED_LOGOS = ["travelizo", "Crafto.", "TechSolution", "Brilliant", "GrowMore Digital"] as const;

export const HOSTING_FEATURES = [
  { icon: "cloud",      title: "Google Cloud Infrastructure", body: "Enterprise-grade infrastructure for maximum speed, security & reliability.", tint: "bg-blue-50 text-blue-500" },
  { icon: "zap",        title: "Lightning Fast Performance",  body: "NVMe SSD storage, LiteSpeed servers and an optimized stack for ultra-fast websites.", tint: "bg-violet-50 text-violet-500" },
  { icon: "lock",       title: "Free SSL Certificate",        body: "Secure your website with a free SSL certificate + HTTPS activation.", tint: "bg-green-50 text-green-500" },
  { icon: "refresh",    title: "Daily Backups",               body: "Automatic daily backups keep your data safe and restorable.", tint: "bg-sky-50 text-sky-500" },
  { icon: "rocket",     title: "Free Website Migration",      body: "We'll move your website to Anutech for FREE. No technical hassle.", tint: "bg-rose-50 text-rose-500" },
  { icon: "headphones", title: "24×7 Expert Support",         body: "Real people, real support. Get help anytime via chat, ticket or call.", tint: "bg-orange-50 text-orange-500" },
] as const;

/** How a typical host compares, per row. */
export const HOSTING_COMPARISON: readonly { feature: string; typical: "yes" | "no" | "partial" }[] = [
  { feature: "Google Cloud Infrastructure", typical: "no" },
  { feature: "Free SSL Certificate",        typical: "yes" },
  { feature: "Free Website Migration",      typical: "partial" },
  { feature: "15-Day Free Trial",           typical: "no" },
  { feature: "Daily Backups",               typical: "yes" },
  { feature: "99.99% Uptime Guarantee",     typical: "partial" },
  { feature: "24×7 Expert Support",         typical: "no" },
  { feature: "No Hidden Fees",              typical: "no" },
] as const;

export const HOSTING_STEPS = [
  { num: 1, icon: "card",   title: "Create Your Account",  body: "Sign up in less than 60 seconds. No credit card required." },
  { num: 2, icon: "globe",  title: "Choose Domain",        body: "Register a new domain or connect your existing one." },
  { num: 3, icon: "server", title: "Build Your Website",   body: "Install WordPress or use one-click apps to build your site." },
  { num: 4, icon: "rocket", title: "Go Live & Upgrade",    body: "Launch your website. Upgrade anytime if you love our service!" },
] as const;

/** ⚠️ Placeholder testimonials + stock portraits — see the file header. */
export const HOSTING_TESTIMONIALS = [
  { quote: "Anutech Hosting is fast, reliable and the support team is outstanding. Highly recommended!", name: "Ravi Sharma",     role: "Founder, TechSolution",        img: "https://randomuser.me/api/portraits/men/32.jpg" },
  { quote: "Our website migrated seamlessly and the performance boost is amazing. Great support!",       name: "Priya Mehta",     role: "Marketing Head, Crafto",       img: "https://randomuser.me/api/portraits/women/44.jpg" },
  { quote: "Finally, a hosting company that actually cares about its customers. 10/10!",                 name: "Amit Verma",      role: "CEO, DigitalGrow",             img: "https://randomuser.me/api/portraits/men/54.jpg" },
  { quote: "Affordable pricing with premium features. Best decision for our business.",                  name: "Sneha Iyer",      role: "Co-founder, Travelizo",        img: "https://randomuser.me/api/portraits/women/68.jpg" },
  { quote: "Setup took minutes and our site has not gone down once. Rock-solid uptime.",                 name: "Karan Malhotra",  role: "Owner, Brilliant Studio",      img: "https://randomuser.me/api/portraits/men/76.jpg" },
  { quote: "The free migration was painless and support answered within minutes. Fantastic.",            name: "Neha Kapoor",     role: "Director, GrowMore Digital",   img: "https://randomuser.me/api/portraits/women/12.jpg" },
] as const;

export const HOSTING_FAQS = [
  { question: "How does the 15-Day Free Trial work?", answer: "Start your trial with full access to all hosting features for 15 days — no credit card required. If you love it, upgrade to a paid plan anytime. If not, simply let it expire." },
  { question: "Do I need a credit card to start the trial?", answer: "No. You can start your 15-day free trial without entering any payment details. You only pay when you decide to continue after the trial." },
  { question: "Can I migrate my website to Anutech for free?", answer: "Yes! We offer free website migration on all plans. Our team moves your site over with no downtime and no technical hassle on your end." },
  { question: "What happens after the 15-Day Trial?", answer: "When the trial ends you can convert to any paid plan to keep your website live. Your first invoice is generated only at that point — that is when your card / UPI mandate is charged for the first time." },
  { question: "Do you offer a money-back guarantee?", answer: "Yes, we offer a 30-day money-back guarantee on all yearly hosting plans. Monthly plans and domain registrations are not covered by this guarantee." },
  { question: "Can I upgrade or downgrade my plan anytime?", answer: "Absolutely. You can change your plan at any time from your dashboard, and we prorate the difference automatically." },
] as const;
