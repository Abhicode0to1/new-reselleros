# ResellerOS — Production

The complete operating system for Indian cloud resellers.

**Status:** Week 1 — Foundation. Component library + design system + scaffolding done. Auth + DB + screens coming.

---

## 🚀 Quick start for a new developer

### What you need first

| | Why |
|---|---|
| **Node.js 20+** | [nodejs.org](https://nodejs.org/) — LTS version |
| **Docker Desktop** | [docker.com](https://docker.com/products/docker-desktop) — your database runs inside it. On Windows, run `wsl --install` in an **Administrator** Command Prompt first, then restart. |

Docker must be **running** — open Docker Desktop and wait for it to say *Engine running*.

### Then two commands

```bash
cd production/
npm install
npm run setup
```

`npm run setup` checks your prerequisites, starts a **local database on your own
machine**, and loads the real production schema into it — 87 tables, 133 functions, 286
policies, and no customer data. If something is missing it stops and tells you what,
rather than failing later with a Postgres error.

Your database is yours alone. Nothing you do touches production or anyone else's work.

### Daily

```bash
npm run dev          # the app          → http://localhost:3000
npm run db:studio    # browse your DB   → http://localhost:14323
npm run db:stop      # stop the DB      (it keeps running otherwise)
```

### Before pushing

```bash
npm run typecheck && npm run test && npm run lint
```

Lint **warnings** are fine; lint **errors** are not. Baseline: **1492 tests passing**.

Then open a pull request into `main`. You cannot push to `main` directly — it is
protected, and CI must be green before anything merges. That is deliberate: on a feature
branch CI does not run at all, which is how four unit tests once sat broken for months.

### Database changes

```bash
npm run migration:new -- add_customer_credit_limit
```

Timestamp-named, so two people writing a migration on the same day cannot collide.

⚠️ **Do not build a database from `supabase/migrations-archive/`.** Those 218 files are
the real history of production, but they cannot build a database from empty — several
tables were created directly in prod and only captured in git under a *higher* number
than the migration that uses them. The full story is in that folder's README. A fresh
database comes from `supabase/baseline.sql`, which `npm run setup` handles for you.

📖 **Read [`AGENTS.md`](../AGENTS.md) before your first change.** It is short, and every
rule in it is there because it cost somebody something — starting with the fact that
**money is stored in whole rupees, not paise**, which the docs claimed the opposite of
until 14 Aug 2026.

---

## 📂 What's in this folder

```
production/
├── CLAUDE.md             # Project memory for Claude Code (READ THIS)
├── README.md             # You are here
├── package.json          # Dependencies
├── tailwind.config.ts    # Design tokens
├── next.config.mjs       # Next.js config
├── tsconfig.json         # TypeScript strict config
├── components.json       # shadcn/ui config
├── .env.example          # Environment template (copy to .env.local)
├── src/
│   ├── app/              # Next.js pages (App Router)
│   │   ├── globals.css   # Design tokens (HSL CSS variables)
│   │   ├── layout.tsx    # Root layout (fonts, metadata)
│   │   ├── page.tsx      # Landing page
│   │   └── dev/
│   │       └── components/page.tsx  # Visual showcase
│   ├── components/
│   │   └── ui/           # Production components (Button, Card, Badge, Icon)
│   └── lib/
│       ├── utils.ts      # cn(), rupee(), formatDate, etc.
│       └── types.ts      # Shared TypeScript types
└── public/               # Static assets (images, icons)
```

---

## ✅ What's already built (Week 1, Day 1)

| Component | Status | File |
|---|---|---|
| **Project scaffolding** | ✅ | `package.json`, configs |
| **Design tokens** | ✅ | `src/app/globals.css` |
| **Tailwind config** | ✅ | `tailwind.config.ts` |
| **Type system** | ✅ | `tsconfig.json` (strict) |
| **Utility library** | ✅ | `src/lib/utils.ts` |
| **Type definitions** | ✅ | `src/lib/types.ts` |
| **Button** | ✅ | `src/components/ui/button.tsx` |
| **Card** | ✅ | `src/components/ui/card.tsx` |
| **Badge** | ✅ | `src/components/ui/badge.tsx` |
| **Icon** | ✅ | `src/components/ui/icon.tsx` |
| **Showcase page** | ✅ | `/dev/components` |

---

## 📅 What's coming (Week 1, rest of week)

| Component | Status |
|---|---|
| Skeleton (loading placeholder) | Pending |
| EmptyState | Pending |
| GeminiCard (AI suggestion) | Pending |
| ActivityTimeline | Pending |
| Input, Select, Textarea | Pending |
| KPI tile | Pending |
| Avatar | Pending |
| Tabs | Pending |
| Toast (sonner integration) | Pending |
| CommandPalette (cmdk) | Pending |
| NotificationPanel | Pending |

---

## 🔧 Stack at a glance

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 14 App Router | Server components, fast, Vercel-native |
| Language | TypeScript strict | Type safety, no `any` |
| Styling | Tailwind CSS | Fast iteration, consistent design |
| Components | shadcn/ui base + custom | Accessible, copy-paste ownership |
| Database | Supabase (Postgres) | Multi-tenant with RLS, realtime |
| Auth | Supabase Auth | Email + Google OAuth |
| State (server) | TanStack Query v5 | Caching, optimistic updates |
| State (forms) | React Hook Form + Zod | Type-safe forms |
| Charts | Recharts | Production-grade charting |
| Animation | Framer Motion | Micro-interactions |
| i18n | next-intl | Hindi + English support |
| Email | Resend | Transactional emails |
| Payments | Razorpay | India payment gateway |
| Hosting | Vercel | Auto preview deploys |
| Monitoring | Sentry + Plausible | Errors + analytics |
| Testing | Vitest + Playwright | Unit + E2E |

---

## 🧠 Working with Claude Code

This project is designed for AI-assisted development. Claude Code reads `CLAUDE.md` automatically and follows conventions.

### Recommended workflow

1. **Open Claude Code** in this directory (`production/`)
2. **Give a specific task**: *"Port the Lead Pipeline screen from `../prototype/screens/leads.jsx` to `src/app/(app)/leads/page.tsx`. Use Supabase + TanStack Query."*
3. **Claude generates code** following all conventions
4. **You test locally**: `npm run dev`
5. **You commit + push**: Vercel auto-deploys preview
6. **Repeat**

### Tips for best Claude Code results

- **Be specific**: "Port screen X" → better than "do some frontend work"
- **Reference prototype**: Claude reads `../prototype/` for UX reference
- **Show, don't tell**: Paste error messages, screenshots, file paths
- **Iterate small**: One component or page at a time, not 10
- **Always review**: AI generates drafts; you own the merge button
- **Update CLAUDE.md**: When a new convention emerges, add it

---

## 🆘 Troubleshooting

| Problem | Solution |
|---|---|
| `npm install` fails | Make sure Node.js 20+, try `npm cache clean --force` then retry |
| `Cannot find module '@/...'` | Restart TS server in VS Code: Cmd+Shift+P → "Restart TS Server" |
| Tailwind classes not working | Restart dev server (`Ctrl+C` then `npm run dev`) |
| Dark mode looks broken | We haven't built dark theme polish yet — coming in Phase 4 |
| Type errors | Run `npm run typecheck` — fix all errors before committing |

---

## 📚 Learn the stack (recommended reading)

If new to any of these (~half a day each):
- [Next.js App Router docs](https://nextjs.org/docs/app)
- [shadcn/ui](https://ui.shadcn.com/)
- [TanStack Query](https://tanstack.com/query/latest)
- [Tailwind CSS](https://tailwindcss.com/docs)
- [Supabase docs](https://supabase.com/docs)

---

## 📞 Project contacts

| Question | Owner |
|---|---|
| Architecture / security | Tech Lead (P1) |
| Backend integrations | P3 |
| Tests / deployment | P4 |
| Product / business | Pardeep |
| AI usage best practices | `CLAUDE.md` in this folder |

---

## 📜 License

Proprietary. © 2026 Excel Technologies Pvt Ltd. All rights reserved.
