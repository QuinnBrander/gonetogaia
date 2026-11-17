/**
 * Draggable popups. Every popup panel (`.action-menu-body`,
 * `.rewards-modal-body`) gets a grip bar at its top; dragging it moves
 * the panel so the player can check the board / story text behind it.
 *
 * - Only the grip starts a drag, so touch-scrolling a long popup still
 *   scrolls it (touch-first).
 * - Screens re-render popups by replacing their markup, so the offset is
 *   kept here and re-applied to the new panel (same panel class). It
 *   resets once no popup is open, so the next popup opens centred.
 * - Once a popup has been moved, `body.popup-moved` clears the dimming
 *   backdrops (see styles.css) so what's behind it is readable.
 * - Panels may live inside the scaled `#app-stage`; drag deltas are
 *   divided by the panel's on-screen scale so it tracks the finger.
 */

const PANEL_SELECTOR = ".action-menu-body, .rewards-modal-body";

let offset = { x: 0, y: 0 };
let offsetKey = "";

function applyOffset(panel: HTMLElement): void {
  panel.style.translate = offset.x === 0 && offset.y === 0 ? "" : `${offset.x}px ${offset.y}px`;
}

function decorate(panel: HTMLElement): void {
  if (panel.querySelector(":scope > .popup-drag-handle")) return;
  const handle = document.createElement("div");
  handle.className = "popup-drag-handle";
  handle.setAttribute("data-net-view", "");
  handle.title = "Drag to move this popup";
  handle.setAttribute("aria-label", "Drag to move this popup");
  panel.prepend(handle);
  if (panel.className !== offsetKey) {
    offsetKey = panel.className;
    offset = { x: 0, y: 0 };
  }
  applyOffset(panel);
}

function sync(): void {
  const panels = document.querySelectorAll<HTMLElement>(PANEL_SELECTOR);
  if (panels.length === 0) {
    offset = { x: 0, y: 0 };
    offsetKey = "";
  }
  panels.forEach(decorate);
  document.body.classList.toggle("popup-moved", panels.length > 0 && (offset.x !== 0 || offset.y !== 0));
}

function startDrag(ev: PointerEvent): void {
  const handle = (ev.target as Element | null)?.closest?.(".popup-drag-handle");
  if (!handle) return;
  const panel = handle.parentElement as HTMLElement | null;
  if (!panel) return;
  ev.preventDefault();
  const scale = panel.offsetWidth > 0 ? panel.getBoundingClientRect().width / panel.offsetWidth : 1;
  const start = { px: ev.clientX, py: ev.clientY, x: offset.x, y: offset.y };
  offsetKey = panel.className;
  (handle as HTMLElement).setPointerCapture(ev.pointerId);
  const move = (e: PointerEvent): void => {
    // Keep the grip on screen so the popup can always be dragged back.
    const cx = Math.min(Math.max(e.clientX, 8), window.innerWidth - 8);
    const cy = Math.min(Math.max(e.clientY, 8), window.innerHeight - 8);
    offset = { x: start.x + (cx - start.px) / scale, y: start.y + (cy - start.py) / scale };
    applyOffset(panel);
    document.body.classList.add("popup-moved");
  };
  const end = (): void => {
    handle.removeEventListener("pointermove", move as EventListener);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
  };
  handle.addEventListener("pointermove", move as EventListener);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

export function installDraggablePopups(): void {
  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("pointerdown", startDrag);
  sync();
}
