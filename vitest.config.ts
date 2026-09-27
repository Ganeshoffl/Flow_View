import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, not built output. A stale `dist` should never be able to make a
    // failing change look green.
    alias: {
      "@flow-view/trace-schema/validate": fileURLToPath(
        new URL("./packages/trace-schema/src/validate.ts", import.meta.url),
      ),
      "@flow-view/trace-schema": src("trace-schema"),
      "@flow-view/trace-store": src("trace-store"),
      "@flow-view/trace-fixtures": src("trace-fixtures"),
    },
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
      // Replays real adapter output. Needs `python conformance/runner.py` to have run first, and
      // fails loudly rather than skipping if it has not.
      "conformance/test/**/*.test.ts",
    ],
    environment: "node",
  },
});
