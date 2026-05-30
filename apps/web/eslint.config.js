import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"],
    rules: {
      // We intentionally omit eslint-plugin-react-hooks in this repo right now.
      // These disables are used inline in a few places.
      "react-hooks/exhaustive-deps": "off",
    },
  },
];
