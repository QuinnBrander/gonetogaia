/**
 * Sound on/off toggle button.
 *
 * Mounts a speaker-emoji button into `#app-stage` (NOT `#app`), so:
 *   - the router's `root.innerHTML = ""` wipe during `goTo()` never
 *     tears it down — the button follows the player across every
 *     screen with zero per-screen wiring, and
 *   - it lives in STAGE coordinates (the fixed 3538×2211 design
 *     canvas) rather than viewport coordinates, so its position
 *     relative to the game UI is identical at every window size —
 *     which is what lets `.board-topbar`'s `padding-left`
 *     reservation in `styles.css` guarantee it never covers the
 *     topbar buttons regardless of stage scale.
 *
 * Anchored top-left: the Title / Story / Town Visit screens keep
 * their top-left corner empty (centered card layouts), and the
 * Board / Campaign Sheet topbars reserve room for it via CSS.
 * (Top-right is the session-log panel's home; bottom-right is the
 * fullscreen + reset-zoom cluster.)
 *
 * Visual states (per user spec — a simple emoji):
 *   - Sound ON:  🔊 full colour.
 *   - Sound OFF: 🔇 (crossed-out speaker) greyed via CSS
 *     `grayscale` filter — see `.sound-toggle--off` in styles.css.
 *
 * State + persistence live in `audio/musicPlayer.ts`
 * (`isMusicMuted` / `setMusicMuted`); this module is UI only.
 */

import { isMusicMuted, setMusicMuted } from "../audio/musicPlayer";
import { logEvent } from "../debug/sessionLog";

/** Mount the sound toggle into `#app-stage`. Idempotent — a second
 *  call sees the existing element and bails. Returns a cleanup
 *  function for tests / hot-reload. */
export function installSoundToggleButton(): () => void {
  if (typeof document === "undefined") return () => {};
  if (document.getElementById("sound-toggle")) return () => {}; // idempotent

  // Fall back to <body> if the stage is missing (tests / harnesses).
  const host = document.getElementById("app-stage") ?? document.body;

  const btn = document.createElement("button");
  btn.id = "sound-toggle";
  btn.className = "sound-toggle";
  btn.type = "button";

  const sync = (): void => {
    const muted = isMusicMuted();
    btn.textContent = muted ? "\u{1F507}" : "\u{1F50A}"; // 🔇 / 🔊
    btn.classList.toggle("sound-toggle--off", muted);
    btn.setAttribute("aria-pressed", String(!muted));
    const label = muted ? "Sound is off. Click to turn sound on." : "Sound is on. Click to turn sound off.";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  };
  sync();

  btn.addEventListener("click", () => {
    const next = !isMusicMuted();
    setMusicMuted(next);
    logEvent("click.sound-toggle", { muted: next });
    sync();
  });

  host.appendChild(btn);
  return () => {
    btn.remove();
  };
}
