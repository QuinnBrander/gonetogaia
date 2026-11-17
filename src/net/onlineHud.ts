/**
 * Online status pill + toasts. Mounted on `document.body` (outside the
 * scaled `#app-stage`) so screen swaps never tear them down and they stay
 * a readable, constant size on phones.
 */
import "./online.css";

export interface HudModel {
  code: string;
  you: string;
  peer: string;
  peerOk: boolean;
  /** Non-null while this client is watching: who is choosing
   *  ("Mind player is choosing"). Shown as a second line of the pill. */
  watching: string | null;
  /** This client's delver role (null before the host picks roles). */
  myRole: "mind" | "body" | null;
  /** A wave's hero phase is running and it's the OTHER delver's turn —
   *  hide the turn controls even while this player answers a choice. */
  notMyTurn: boolean;
}

let hud: HTMLDivElement | null = null;
let toastHost: HTMLDivElement | null = null;
let banner: HTMLDivElement | null = null;

export function mountOnlineHud(): void {
  if (hud) return;
  hud = document.createElement("div");
  hud.className = "online-hud";
  hud.hidden = true;
  document.body.appendChild(hud);
  toastHost = document.createElement("div");
  toastHost.className = "online-toasts";
  document.body.appendChild(toastHost);
  // The "[Mind player is choosing]" line lives inside the pill, which
  // sits in the bottom-left corner (not top-centre, where it covered the
  // XP pills and story text) and can be dragged anywhere.
  banner = document.createElement("div");
  banner.className = "online-choosing-banner";
  banner.setAttribute("role", "status");
  banner.hidden = true;
  makeDraggable(hud);
}

/** Drag the pill by any part of it; it keeps its spot until reload. */
function makeDraggable(el: HTMLDivElement): void {
  el.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const rect = el.getBoundingClientRect();
    const dx = ev.clientX - rect.left;
    const dy = ev.clientY - rect.top;
    el.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent): void => {
      const x = Math.min(Math.max(e.clientX - dx, 0), window.innerWidth - rect.width);
      const y = Math.min(Math.max(e.clientY - dy, 0), window.innerHeight - rect.height);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.bottom = "auto";
    };
    const end = (): void => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  });
}

/**
 * Body markers the online CSS keys off:
 *   - `.online-watching`: this player can only watch right now; every
 *     game-changing button is hidden (see `online.css`).
 *   - `data-online-role="mind|body"`: hides the other delver's own
 *     controls (e.g. their shop buttons) on this player's screen.
 *   - `.online-not-my-turn`: the other delver's hero turn — its turn
 *     controls stay hidden even while this player answers a choice for
 *     their own delver (e.g. a Supercharger roll).
 */
function setBodyMarkers(watching: boolean, role: "mind" | "body" | null, notMyTurn = false): void {
  document.body.classList.toggle("online-watching", watching);
  document.body.classList.toggle("online-not-my-turn", notMyTurn);
  if (role === null) delete document.body.dataset["onlineRole"];
  else document.body.dataset["onlineRole"] = role;
}

export function updateOnlineHud(model: HudModel | null): void {
  if (!hud) return;
  if (model === null) {
    hud.hidden = true;
    if (banner) banner.hidden = true;
    setBodyMarkers(false, null);
    return;
  }
  hud.hidden = false;
  hud.innerHTML = "";
  const row = document.createElement("div");
  row.className = "online-hud__row";
  row.append(
    span("online-hud__code", `ONLINE · ${model.code}`),
    span("online-hud__you", `You: ${model.you}`),
    span(`online-hud__peer ${model.peerOk ? "is-ok" : "is-off"}`, model.peer),
  );
  hud.appendChild(row);
  if (banner) {
    hud.appendChild(banner);
    banner.hidden = model.watching === null;
    banner.textContent = model.watching === null ? "" : `[${model.watching}]`;
  }
  setBodyMarkers(model.watching !== null, model.myRole, model.notMyTurn);
}

export function showOnlineToast(message: string, tone: "info" | "error"): void {
  if (!toastHost) return;
  const t = document.createElement("div");
  t.className = `online-toast online-toast--${tone}`;
  t.textContent = message;
  t.addEventListener("click", () => t.remove());
  // Same message twice in a row (e.g. repeated taps while watching) — keep one.
  const last = toastHost.lastElementChild;
  if (last && last.textContent === message) last.remove();
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), tone === "error" ? 9000 : 3500);
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}
