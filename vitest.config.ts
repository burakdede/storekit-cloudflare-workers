import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // Tests import the package by its published name, so the entrypoint and its export map are
  // exercised the way an adopter's Worker exercises them.
  resolve: {
    alias: {
      "storekit-cloudflare-workers": fileURLToPath(new URL("./src/index.ts", import.meta.url))
    }
  },
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    sequence: { shuffle: false },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      thresholds: { lines: 80, branches: 60, functions: 85, statements: 80 }
    }
  }
})
