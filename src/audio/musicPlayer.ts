/**
 * Persistent looping background music.
 *
 * Owns a single module-scoped `HTMLAudioElement` that lives OUTSIDE
 * the `#app` root, so the router's `root.innerHTML = ""` wipe during
 * `goTo()` can never tear it down. That's the whole point of this
 * module: the track keeps playing seamlessly across screen
 * transitions (Title → Story → Board → Town Visit → Results → ...).
 *
 * Browser autoplay policies block silent `audio.play()` calls without
 * a user gesture (Chrome, Safari, Firefox all enforce this). We try
 * to autoplay anyway in case the user has whitelisted the origin /
 * is on Electron (where autoplay is permitted by default — relevant
 * for the packaged .exe), and fall back to starting on the first
 * pointerdown / keydown / touchstart. Listeners stay attached after
 * unlock; they no-op once the track is playing (cheap paused-check).
 *
 * The audio element is also stored on `window` under a private key so
 * Vite HMR module reloads reuse the same element instead of spawning
 * a second overlapping track (or silently losing audio because the
 * module-local `audio` variable was reset to null while `main.ts`
 * wasn't re-executed and never re-called `installMusicPlayer`).
 *
 * Mute UI: `ui/soundToggleButton.ts` mounts a floating speaker-emoji
 * toggle wired to `setMusicMuted()` / `isMusicMuted()` below. Mute is
 * implemented as `audio.muted` (NOT pause) so the autoplay-unlock
 * dance is unaffected — a muted track still counts as "playing", the
 * loop keeps its position, and unmuting resumes instantly. The
 * preference persists in localStorage under its own key, deliberately
 * OUTSIDE the campaign/session keys wiped by `buildIdGuard`, so a
 * freshly-distributed .exe keeps the player's sound choice.
 */

const DEFAULT_VOLUME = 0.45;
/** window property used to survive Vite HMR module re-executions. */
const AUDIO_KEY = "__g2g_music__";
/** localStorage key for the persisted mute preference. */
const MUTE_KEY = "g2g.soundMuted.v1";

let audio: HTMLAudioElement | null = null;
let unlocked = false;

/**
 * Idempotent. Call once at app boot from `main.ts`. Safe to call
 * multiple times (HMR re-executions, accidental double-installs).
 */
export function installMusicPlayer(src = "/soundtrack.mp3"): void {
  // Survive Vite HMR module reloads: if a prior install left an audio
  // element on window, reuse it instead of spawning a second track.
  const win = window as unknown as Record<string, unknown>;
  const existing = win[AUDIO_KEY];
  if (existing instanceof HTMLAudioElement) {
    audio = existing;
    audio.muted = loadMutedPref();
    unlocked = !audio.paused;
    if (!unlocked) void tryStart();
    return;
  }

  const el = new Audio(src);
  el.loop = true;
  el.preload = "auto";
  el.volume = DEFAULT_VOLUME;
  el.muted = loadMutedPref();
  audio = el;
  win[AUDIO_KEY] = el;

  void tryStart();

  const unlock = (): void => {
    if (audio && !audio.paused) return; // Already playing — skip
    void tryStart();
  };
  const opts: AddEventListenerOptions = { passive: true };
  document.addEventListener("pointerdown", unlock, opts);
  document.addEventListener("keydown", unlock);
  document.addEventListener("touchstart", unlock, opts);
}

/**
 * 0..1 volume. Persists for the rest of the session; safe to call
 * before `installMusicPlayer()` (queued by stashing on the next
 * created element... actually not implemented — install first).
 */
export function setMusicVolume(volume: number): void {
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, volume));
}

/** True once the browser has accepted `play()` (autoplay or user-gesture). */
export function isMusicPlaying(): boolean {
  return audio !== null && !audio.paused;
}

/**
 * Current mute preference. Reads from localStorage (not the audio
 * element) so it's correct even before `installMusicPlayer()` runs.
 */
export function isMusicMuted(): boolean {
  return loadMutedPref();
}

/**
 * Mute / unmute the soundtrack and persist the choice. Uses
 * `audio.muted` rather than pause so the track keeps looping in
 * place — unmuting picks up mid-song instead of restarting, and the
 * autoplay-unlock listeners in `installMusicPlayer` stay valid.
 */
export function setMusicMuted(muted: boolean): void {
  saveMutedPref(muted);
  if (audio) audio.muted = muted;
}

function loadMutedPref(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false; // Private-mode / storage-denied: default to sound on.
  }
}

function saveMutedPref(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // Storage denied — the in-session `audio.muted` still applies.
  }
}

async function tryStart(): Promise<void> {
  if (!audio) return;
  if (!audio.paused) {
    unlocked = true;
    return; // Already playing — nothing to do.
  }
  try {
    await audio.play();
    unlocked = true;
  } catch {
    // Autoplay was blocked. Don't log — this is expected on the
    // very first attempt in every modern browser. The unlock
    // listeners will retry on the next user gesture.
  }
}
