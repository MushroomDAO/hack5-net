import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// vitest runs the Worker inside the real workerd runtime with a genuine local D1 (Miniflare), so these
// are integration/e2e tests, not mocks of our own logic. Migrations are read from ./migrations at config
// time and handed to the test as a binding; each suite applies them to the ephemeral D1 in beforeAll.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
  };
});
