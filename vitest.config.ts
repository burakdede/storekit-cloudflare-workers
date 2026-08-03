import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    sequence: { shuffle: false },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/worker.ts", "src/auth.ts"],
      thresholds: { lines: 80, branches: 60, functions: 85, statements: 80 }
    }
  }
})
