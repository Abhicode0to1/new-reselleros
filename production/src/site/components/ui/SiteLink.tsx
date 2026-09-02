import NextLink from "next/link";
import type { ComponentProps } from "react";
import type { UrlObject } from "url";

/**
 * The marketing site's <Link>. The site was written for a Next app WITHOUT
 * `experimental.typedRoutes`, so its hrefs are plain strings; ResellerOS HAS
 * typedRoutes, which would reject every one. Rather than cast at 40 call sites,
 * the ported site imports Link from here — a thin wrapper that takes a string
 * href and hands it to next/link. The routes are real; only the compile-time
 * literal-route check is what we're stepping around, for the site subtree only.
 */
type SiteLinkProps = Omit<ComponentProps<typeof NextLink>, "href"> & { href: string | UrlObject };

export default function SiteLink({ href, ...rest }: SiteLinkProps) {
  return <NextLink href={href as never} {...rest} />;
}
