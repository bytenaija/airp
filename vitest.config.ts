import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ||
        "postgresql://airp:airp_password@localhost:5432/airp",
    },
  },
});
