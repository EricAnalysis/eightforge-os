import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["lib/extraction/**/*.ts"],
    ignores: [
      "lib/extraction/**/*.test.ts",
      "lib/extraction/**/*.spec.ts",
      // Frozen legacy back-edge. The architecture test rejects any new tuple.
      "lib/extraction/xlsx/normalizeTransactionData.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@/lib/validator",
            "@/lib/interpretation",
            "@/lib/contracts",
            "@/lib/invoices",
          ],
          patterns: [
            "@/lib/validator/**",
            "@/lib/interpretation/**",
            "@/lib/contracts/**",
            "@/lib/invoices/**",
            "@/lib/project*",
          ],
        },
      ],
    },
  },
  {
    files: ["lib/interpretation/**/*.ts"],
    ignores: ["lib/interpretation/**/*.test.ts", "lib/interpretation/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@/lib/validator",
            "@/lib/extraction/pdf",
            "@/lib/extraction/runtime",
            "@/lib/extraction/persistence",
          ],
          patterns: [
            "@/lib/validator/**",
            "@/lib/extraction/pdf/**",
            "@/lib/extraction/runtime/**",
            "@/lib/extraction/persistence/**",
          ],
        },
      ],
    },
  },
  {
    files: ["lib/validator/**/*.ts"],
    ignores: [
      "lib/validator/**/*.test.ts",
      "lib/validator/**/*.spec.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@/lib/extraction/pdf",
            "@/lib/extraction/runtime",
            "@/lib/extraction/persistence",
            "@/lib/pipeline/nodes",
          ],
          patterns: [
            "@/lib/extraction/pdf/**",
            "@/lib/extraction/runtime/**",
            "@/lib/extraction/persistence/**",
            "@/lib/pipeline/nodes/**",
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
