import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    clean: true,
    dts: true,
    sourcemap: true,
    splitting: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    clean: false,
    dts: false,
    sourcemap: true,
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
