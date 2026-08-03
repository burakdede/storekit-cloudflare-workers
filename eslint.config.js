import js from "@eslint/js"
import tseslint from "@typescript-eslint/eslint-plugin"
import tsParser from "@typescript-eslint/parser"
import globals from "globals"

export default [
  { ignores: ["coverage/**", ".wrangler/**", "worker-configuration.d.ts"] },
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
