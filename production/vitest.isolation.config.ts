import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Tenant-isolation proof against a real Postgres built by `npm run db:local`.
// DATABASE_URL = app_runtime (what the app uses), ADMIN_DATABASE_URL = local superuser (seeding).
// Same aliases as the unit config; its `test` block is replaced, not merged (it excludes us).
export default defineConfig({
  ...base,
  test: {
    include: ["tests/isolation/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://app_runtime:localdev@localhost:54329/ros",
      JOBS_DATABASE_URL: process.env.JOBS_DATABASE_URL ?? "postgresql://app_jobs:localdev@localhost:54329/ros",
      ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL ?? "postgresql://postgres:localdev@localhost:54329/ros",
      DB_POOL_MAX: "1",
    },
  },
});
