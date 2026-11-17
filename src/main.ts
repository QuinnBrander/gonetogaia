/**
 * Entry point + screen router.
 *
 * Each screen is a function that takes the root element and a Router, then
 * renders into the root. Screen transitions blow away the root and re-render.
 *
 * No framework: a board-game UI is event-driven, low-frame-rate, mostly
 * static between user actions. The DOM is the right tool.
 */

import { clearCampaignIfNewBuild } from "./build/buildIdGuard";
import { loadCampaign, saveCampaign, type CampaignState } from "./state";
import { renderTitle } from "./screens/Title";
import { renderDataViewer } from "./screens/DataViewer";
import { renderCounterAttackViewer } from "./screens/CounterAttackViewer";
import { renderBoardScreen } from "./screens/BoardScreen";
import { renderCampaignSheet } from "./screens/CampaignSheet";
import { renderStoryScreen } from "./screens/Story";
import { renderTownVisit } from "./screens/TownVisit";
import { installViewportTracker, logEvent } from "./debug/sessionLog";
import { installGlobalSessionLogPanel } from "./debug/SessionLogPanel";
import { installFullscreenButton } from "./layout/fullscreenToggle";
import { installStageScaler } from "./layout/stageScale";
import { installPinchZoom } from "./layout/pinchZoom";
import { installMusicPlayer } from "./audio/musicPlayer";
import { installSoundToggleButton } from "./ui/soundToggleButton";
import { installDraggablePopups } from "./ui/draggablePopups";
import { installOnline, onlineCommit, onlinePersistsLocally } from "./net/onlineController";

export type ScreenName =
  | { name: "title" }
  | { name: "dataViewer" }
  | { name: "counterAttackViewer" }
  | { name: "board" }
  | { name: "story" }
  | { name: "campaignSheet" }
  | { name: "townVisit" };

export interface Router {
  state: CampaignState;
  goTo(screen: ScreenName): void;
  /** Save state to localStorage AND re-render the active screen. */
  save(): void;
  /** Save state to localStorage WITHOUT re-rendering. Use during initial
   *  mount when you mutate state but don't want to recurse into render. */
  persist(): void;
  /** Re-render the active screen WITHOUT saving (for UI-only state changes
   *  like opening a modal). */
  refresh(): void;
}

const root = document.getElementById("app");
if (!root) throw new Error("#app element missing from index.html");

clearCampaignIfNewBuild();
const state = loadCampaign();
let active: ScreenName = { name: "title" };

/**
 * Re-render the active screen while preserving window scroll position.
 * Used by `save()` / `refresh()` because those are SAME-screen
 * updates triggered by in-place interactions (e.g. buying a shop
 * product, transferring parts) — losing the player's scroll on every
 * such tick is jarring, especially when they've scrolled down to a
 * product card to click "Buy".
 *
 * Two-phase restore: set scroll synchronously after `render()`
 * returns (the new DOM is already attached so `scrollHeight` is
 * known; the next paint will land at the right offset) AND once more
 * inside `requestAnimationFrame` as a backup. The rAF pass covers
 * the case where late layout work (image loads with `aspect-ratio`,
 * font-induced reflow) grows the doc just after the sync write and
 * the initial position would otherwise be clamped against an
 * intermediate `scrollHeight`. Cost is one extra cheap assignment
 * per re-render.
 *
 * Skipped (no restore) when scrollY is 0 — the common case of
 * "user hasn't scrolled" — so we don't fight the browser's natural
 * top-of-page when there's nothing to preserve.
 */
function renderPreservingScroll(): void {
  const scrollY = window.scrollY;
  render();
  if (scrollY <= 0) return;
  window.scrollTo(0, scrollY);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }
}

/**
 * Online co-op gate (see `net/onlineController.ts`). Offline it always
 * passes. Online, a change made while it's the other player's turn is
 * rolled back (returns false); accepted changes are published to the
 * other computer. Guests never write their own single-player save.
 */
function commit(kind: "user" | "render"): boolean {
  if (!onlineCommit(kind)) return false;
  if (onlinePersistsLocally()) saveCampaign(state);
  return true;
}

const router: Router = {
  state,
  goTo(next) {
    active = next;
    commit("user");
    // Real screen change — let the new screen start at the top
    // (standard "new page, start fresh" UX). Same as a click-through
    // navigation in a web app.
    render();
  },
  save() {
    commit("user");
    renderPreservingScroll();
  },
  persist() {
    commit("render");
  },
  refresh() {
    // Never writes the local save (unchanged offline behaviour); online
    // it still gates + publishes in-memory changes.
    onlineCommit("user");
    renderPreservingScroll();
  },
};

// Track the most recently entered top-level screen so we don't spam
// `screen.enter` once per `router.refresh()` call (refresh re-runs
// `render` but doesn't change the screen). A `screen.enter` row only
// fires when the destination screen actually changes.
let lastLoggedScreen: string | null = null;

function render(): void {
  root!.innerHTML = "";
  if (active.name !== lastLoggedScreen) {
    logEvent("screen.enter", { name: active.name });
    lastLoggedScreen = active.name;
  }
  switch (active.name) {
    case "title":
      renderTitle(root!, router);
      return;
    case "dataViewer":
      renderDataViewer(root!, router);
      return;
    case "counterAttackViewer":
      renderCounterAttackViewer(root!, router);
      return;
    case "board":
      renderBoardScreen(root!, router);
      return;
    case "story":
      renderStoryScreen(root!, router);
      return;
    case "campaignSheet":
      renderCampaignSheet(root!, router);
      return;
    case "townVisit":
      renderTownVisit(root!, router);
      return;
  }
}

// Fixed-aspect stage scaler. Sized against 3538×2211 (see
// `layout/stageScale.ts`); installs a resize listener that
// keeps `--stage-scale` in sync with the viewport so every
// screen scales uniformly with letterboxed black bars.
// MUST run before the first `render()` so the stage is sized
// correctly on the very first paint (otherwise the user sees a
// 1-frame flash at scale=1 / overflowing).
installStageScaler();

// Viewport tracker — installed once at app load so the session
// log always carries an anchor (`viewport.initial`) plus any
// subsequent resize / mobile-chrome / keyboard events. Critical
// for diagnosing layout-flavoured bugs ("the screen briefly
// resized") that don't surface in the gameplay event stream.
installViewportTracker();

// Global session-log panel — mounts a floating panel into
// `document.body` and binds `~` (backtick) on `document` to toggle
// it. This makes the log reachable from EVERY screen (title, story,
// town visit, board) instead of just BoardScreen, so the user can
// dump the log during a town-visit or story bug without first
// navigating back to the board.
installGlobalSessionLogPanel();

// Floating fullscreen-toggle button — bottom-right of the actual
// viewport (NOT scaled by `#app-stage`, so it stays a constant
// touch-target size on shrinking windows). Same idea as the
// session log panel: a small piece of always-visible chrome that
// lives outside the game world.
installFullscreenButton();

// Pinch-to-zoom + Ctrl+scroll zoom for the game stage. Works in the
// packaged Electron .exe (Chromium maps trackpad pinch to Ctrl+wheel)
// and on touch screens. Double-tap or the floating "RESET ZOOM" button
// returns to fit-scale. Must run after installStageScaler so that
// --stage-scale is already defined when the first applyTransform fires.
installPinchZoom();

// Persistent looping soundtrack. Owns a module-scoped audio
// element living OUTSIDE `#app`, so router screen swaps
// (`root.innerHTML = ""`) never tear it down — the track plays
// continuously across Title → Story → Board → Town Visit. Tries
// to autoplay first (works inside the packaged Electron app);
// falls back to starting on the player's first pointer/key/touch
// gesture in the browser.
installMusicPlayer();

// Sound on/off toggle — speaker emoji anchored top-left of the
// stage (inside `#app-stage`, outside `#app`, so screen swaps never
// tear it down and it scales with the design canvas). Full-colour 🔊
// when sound is on, greyed crossed-out 🔇 when muted. Preference
// persists in localStorage via `audio/musicPlayer.ts`. Must run
// after `installMusicPlayer()` so the stored preference is already
// applied to the audio element it reflects.
installSoundToggleButton();

// Every popup gets a drag grip so the player can move it aside and
// check the board / story text behind it.
installDraggablePopups();

// Online co-op (HOST GAME / JOIN GAME on the title screen). Must run
// before the first render: it auto-rejoins this tab's session after a
// refresh, which re-routes to the shared game screen.
installOnline({
  state,
  getActive: () => active,
  show(screen) {
    active = screen;
    render();
  },
  rerender: renderPreservingScroll,
  loadLocalCampaign: loadCampaign,
});

render();
