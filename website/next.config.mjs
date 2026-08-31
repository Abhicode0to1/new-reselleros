/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /* Cloud Run pattern, same as production/: standalone output runs on a tiny
     Node image with no node_modules at runtime. */
  output: "standalone",
  /* No eslint dependency in this package — the gate is build + typecheck + vitest.
     (production/ carries the full lint setup; this is a content site.) */
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
