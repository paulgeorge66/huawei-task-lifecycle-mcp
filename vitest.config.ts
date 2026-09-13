import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          // Deterministic test-only values keep a clean clone independent of .dev.vars.
          CODEX_WEBHOOK_TOKEN: "test-codex-webhook-token-not-for-production",
          HUAWEI_AUTH_CODE: "test-huawei-auth-code-not-for-production",
          OWNER_PASSWORD: "test-owner-password-not-for-production",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
