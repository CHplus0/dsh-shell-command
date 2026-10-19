import { build } from "tsdown";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const css = readFileSync(new URL(import.meta.resolve("@xterm/xterm/css/xterm.css")), "utf8");
await build({
  cwd: root,
  entry: { client: "src/client.js" },
  outDir: "lib",
  clean: false,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  dts: false,
  sourcemap: false,
  minify: true,
  outputOptions: {
    entryFileNames: "[name].js",
    banner: 'window.__ModuleLoader__.load({ id: "dsh-shell-command", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;',
    footer: "return module.exports;\n} });",
  },
  deps: {
    onlyBundle: [/^@xterm\//],
    alwaysBundle: [/^@xterm\//],
    neverBundle: ["react", "react-dom", /^@deepseek-ai\//],
  },
  define: { __XTERM_CSS__: JSON.stringify(css) },
});
console.log(`DSH browser bundle ready: ${resolve(root, "lib/client.js")}`);
