import js from "@eslint/js"
import tseslint from "@typescript-eslint/eslint-plugin"
import tsParser from "@typescript-eslint/parser"
import globals from "globals"

export default [
  { ignores: ["coverage/**", ".wrangler/**", "worker-configuration.d.ts"] },
  {
    // src/storekit/ is meant to be vendored into other Workers, whose ESLint configs vary. It
    // carries eslint-disable directives for hosts that still enable the base no-unused-vars rule
    // on structural callback signatures; those are inert here and must not be reported as unused.
    linterOptions: { reportUnusedDisableDirectives: "off" }
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        sourceType: "module",
        ecmaVersion: "latest"
      },
      globals: {
        ...globals.es2022,
        ...globals.node,
        Env: "readonly",
        D1Database: "readonly",
        D1PreparedStatement: "readonly"
      }
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript already resolves ambient Workers types (ExecutionContext, Env, D1Database).
      // ESLint's no-undef cannot see them and only produces false positives in a TS project.
      "no-undef": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ]
    }
  },
  {
    files: ["**/*.js"],
    languageOptions: { globals: { ...globals.es2022, ...globals.node } }
  }
]
