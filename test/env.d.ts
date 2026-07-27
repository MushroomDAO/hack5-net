/// <reference types="@cloudflare/vitest-pool-workers" />

// Types for the bindings the test runtime exposes via `cloudflare:test`. Kept out of the main tsconfig
// (which includes only src/**), so `npm run typecheck` stays scoped to production code.
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    SHOTS: KVNamespace;
    TEST_MIGRATIONS: D1Migration[];
    WORKBENCH_BASE_URL: string;
    WORKBENCH_CALLBACK_SECRET: string;
    [key: string]: unknown;
  }
}
