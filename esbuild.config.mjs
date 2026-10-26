import esbuild from "esbuild";
import path from "path";

// Route the Agent SDK's `events` import through shims/events.cjs (see that file).
const eventsShim = {
  name: "sdk-events-shim",
  setup(build) {
    build.onResolve({ filter: /^(node:)?events$/ }, (args) =>
      args.importer.includes("claude-agent-sdk") ? { path: path.resolve("shims/events.cjs") } : undefined,
    );
  },
};

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  // The Agent SDK is ESM and calls createRequire(import.meta.url) at load time;
  // give it a real file URL inside Obsidian's CommonJS plugin loader.
  define: { "import.meta.url": "__importMetaUrl" },
  banner: {
    js: 'const __importMetaUrl = require("url").pathToFileURL(typeof __filename === "string" ? __filename : require("path").join(process.cwd(), "main.js")).href;',
  },
  plugins: [eventsShim],
  logLevel: "info",
});
