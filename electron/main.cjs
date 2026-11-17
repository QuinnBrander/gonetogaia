/**
 * Electron main process for the G2G ("Gone to Gaia") portable build.
 *
 * Wraps the Vite-built static site (`dist/index.html`) in a single
 * Chromium window. The wrapper is intentionally minimal — no menu,
 * no IPC, no auto-update — so the .exe behaves like a self-contained
 * desktop app: double-click to play, close to quit.
 *
 * Loaded by Electron when `package.json#main` points here, which
 * `electron-builder` reads when packaging the portable .exe.
 *
 * The renderer process talks to nothing outside Electron — the game
 * is pure browser code with no Node integration — so we keep the
 * default `nodeIntegration: false` + `contextIsolation: true` for
 * sandbox hygiene even though there's no untrusted content here.
 *
 * --- Asset loading: custom `app://` protocol ---
 * The renderer references runtime assets via root-absolute paths
 * (e.g. `/board/tide.jpg`, `/tokens/memory-fragment.webp`,
 * `url("/story/storybook-bg.png")` in CSS, story portraits, etc.).
 * Those paths only work when the document is served from an HTTP
 * origin where `/` maps to `dist/`. Under `file://`, a leading `/`
 * means the FILESYSTEM root — `file:///board/tide.jpg` resolves to
 * `C:\board\tide.jpg` and 404s.
 *
 * We avoid touching gameplay code (~15 hard-coded absolute paths
 * across screens + CSS background-images) by registering a custom
 * `app://` scheme that serves files out of the packaged `dist/`
 * directory. The renderer document is loaded as `app://-/index.html`
 * (the `-` is a placeholder host so URL parsing produces a clean
 * pathname), which means:
 *
 *   - Vite-emitted relative chunks (`./assets/index-XXX.js`,
 *     `./assets/index-YYY.css`) resolve to `app://-/assets/...`
 *   - Source-level absolute paths (`/board/tide.jpg`) resolve to
 *     `app://-/board/tide.jpg`
 *   - CSS `url("/story/storybook-bg.png")` in
 *     `app://-/assets/index-YYY.css` resolves to
 *     `app://-/story/storybook-bg.png`
 *
 * All three forms hit our `protocol.handle("app", …)` handler, which
 * maps the URL's pathname under `dist/` and streams the file back.
 * The scheme is registered as `standard + secure + supportFetchAPI`
 * before `app.whenReady()` so it behaves like an HTTP origin —
 * fetch(), service-worker-style relative resolution, and the
 * standard same-origin model all work as expected.
 *
 * Path-traversal guard: the resolved on-disk path is verified to
 * remain inside `dist/` before the file is served, so a request like
 * `app://-/../../etc/passwd` is rejected with 403 even though the
 * scheme has filesystem access.
 */

const { app, BrowserWindow, protocol, net } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Must run before `app.whenReady()`. Marking the scheme as `standard`
// gives it URL parsing that matches http/https (with host + pathname),
// `secure` enables same-origin features like localStorage, and
// `supportFetchAPI` lets renderer fetch() calls hit our handler.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#000000",
    title: "Gone to Gaia",
    autoHideMenuBar: true,
    webPreferences: {
      // Game is a pure browser app, no IPC or Node calls from the
      // renderer — keep the default secure sandbox.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // `app://-/index.html` — the `-` host is arbitrary but stable, so
  // any future relative navigation stays on the same origin.
  win.loadURL("app://-/index.html");
}

app.whenReady().then(() => {
  // `__dirname` resolves to `<app>/electron/` inside the asar/app
  // bundle, so the dist sits one level up. Both packaged and
  // dev-launch paths share this layout.
  const distRoot = path.join(__dirname, "..", "dist");

  protocol.handle("app", async (request) => {
    const reqUrl = new URL(request.url);
    // Pathname like `/index.html` or `/board/tide.jpg`. Strip the
    // leading slash so `path.join` doesn't reset to filesystem root.
    let relPath = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, "");
    if (relPath === "") relPath = "index.html";

    const filePath = path.normalize(path.join(distRoot, relPath));

    // Path-traversal guard: the resolved file must remain inside
    // `dist/`. Compare with a trailing separator on `distRoot` so
    // `distRoot` itself + true descendants are accepted but a sibling
    // directory like `distRoot + "-foo"` is rejected.
    const distRootWithSep = distRoot.endsWith(path.sep) ? distRoot : distRoot + path.sep;
    if (filePath !== distRoot && !filePath.startsWith(distRootWithSep)) {
      return new Response("Forbidden", { status: 403 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });

  createWindow();

  // macOS convention: re-create a window when the dock icon is
  // clicked and no other windows are open. No-op on Windows but
  // harmless to keep so the wrapper is portable.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed (Windows / Linux convention).
// macOS apps stay running in the dock — we still quit to match
// player expectations on a single-window game build.
app.on("window-all-closed", () => {
  app.quit();
});
