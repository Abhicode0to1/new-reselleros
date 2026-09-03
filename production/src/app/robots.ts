import type { MetadataRoute } from "next";
import { SITE_URL } from "@/site/lib/config";

/**
 * /robots.txt — lets the public marketing site be crawled and indexed, while
 * keeping the authenticated app, the API, and the transactional flow out of the
 * index. AI crawlers (GPTBot, Google-Extended, PerplexityBot, ClaudeBot …) are
 * NOT singled out — they follow the "*" rules, so they may read the public pages
 * and cite Anutech Digital; that is the intent (Pardeep: rank on Google AND be
 * quoted by ChatGPT/Gemini).
 *
 * `host` and `sitemap` both point at SITE_URL (anutech.in), the canonical origin.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/dev/",
          // the authenticated app
          "/dashboard",
          "/leads",
          "/customers",
          "/quotes",
          "/invoices",
          "/online-orders",
          "/setup",
          "/portal",
          // auth
          "/login",
          "/signup",
          "/forgot-password",
          // transactional — nothing to rank, and often per-visitor
          "/cart",
          "/checkout",
          "/done",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
