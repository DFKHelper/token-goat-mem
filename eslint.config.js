import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules", "dist", "coverage"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Enforce strict type checking for TypeScript
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/explicit-module-boundary-types": "warn",

      // General best practices
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "eqeqeq": ["error", "always"],
      "curly": ["error", "all"],
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
      },
    },
  },
  // Type-aware rules on the shipped code only. The type information they need was already being
  // computed for every file above (`parserOptions.project`), so the expensive part was paid for and
  // none of it collected. `no-floating-promises` alone justifies this: it finds zero violations
  // today, which is precisely when a rule is worth turning on -- it costs nothing now and catches
  // the first unawaited write to the database.
  //
  // src/ only, not tests/: the `no-unsafe-*` family fires ~57 times in test fixtures that parse JSON
  // into `any` and immediately assert on it, which is a legitimate shape for a fixture and a
  // pointless thing to fight in a test.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
  })),
);
