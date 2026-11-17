import { defineConfig } from "vite";

// Build ID strategy
// -----------------
// The game's CampaignState is persisted to localStorage. For a portable
// .exe distributed to playtesters, we want every freshly-built .exe to
// reset previous progress on first launch (so testers always start from
// a clean campaign with the latest schema / content).
//
// Each `vite build --mode portable` (invoked by `package:exe`) injects
// a unique `__G2G_BUILD_ID__` into the bundle. On boot, the renderer
// compares the bundled ID against one stored in localStorage and clears
// campaign + session-log state on mismatch. See `src/build/buildIdGuard.ts`.
//
// Dev (`vite`) and regular `vite build` (Cloudflare deploy / web preview)
// keep the constant `"dev"`, so HMR reloads and live-deploy refreshes
// never drop player progress.
export default defineConfig(({ command, mode }) => {
  const isPortable = command === "build" && mode === "portable";
  const buildId = isPortable ? `exe-${Date.now()}` : "dev";
  return {
    base: command === "build" ? "./" : "/",
    define: {
      __G2G_BUILD_ID__: JSON.stringify(buildId),
    },
    optimizeDeps: {
      entries: ["index.html"],
    },
  };
});
