/**
 * NavDirectory — renders an APP_NAV item's `directory` rows on its landing page (S30).
 *
 * The Reports directory (/reports) and the Marketing Hub (/marketing) list their pages
 * from here, so the list IS the nav: the same entries, the same role filter the sidebar
 * and the route guard use, and a page added to the directory in nav.ts appears here
 * without anyone editing the landing page. nav-s30.test.ts fails if a landing page with
 * a directory stops rendering this component.
 */
"use client";

import Link from "next/link";
import type { Route } from "next";

import { Icon } from "@/components/ui/icon";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { APP_NAV, filterNavForRole, groupDirectory, type UserRole } from "@/lib/nav";

export function NavDirectory({ parentId, title }: { parentId: string; title?: string }) {
  const { data: me } = useCurrentUser();
  /* Wait for the role: filterNavForRole(undefined) returns the WHOLE nav, and a flash of
     owner-only links is exactly what the filter exists to prevent. */
  const nav = me ? filterNavForRole(APP_NAV, me.role as UserRole | undefined) : [];
  const parent = nav.flatMap((s) => s.items).find((i) => i.id === parentId);
  const groups = groupDirectory(parent?.directory ?? []);
  if (groups.length === 0) return null;

  return (
    <nav aria-label={title ?? `${parent?.label ?? ""} directory`} className="space-y-4">
      {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map(({ group, items }) => (
          <section key={group} aria-label={group} className="rounded-lg border border-hairline bg-paper p-3">
            <h3 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">{group}</h3>
            <ul className="space-y-1">
              {items.map((i) => (
                <li key={i.id}>
                  <Link
                    href={i.href as Route}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                  >
                    <Icon name={i.icon} size={14} className="mt-0.5 flex-shrink-0 text-ink-3" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{i.label}</span>
                      {i.hint && <span className="block text-2xs text-ink-3 leading-snug">{i.hint}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}
