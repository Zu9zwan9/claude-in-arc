import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        chrome: "readonly",
        globalThis: "readonly",
      },
    },
  },
  {
    // Node build/config scripts run outside the extension sandbox.
    files: ["**/*.mjs", "*.config.js", "*.config.ts"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
  },
);
