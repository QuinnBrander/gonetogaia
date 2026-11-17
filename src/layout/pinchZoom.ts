/**
 * Player-controlled zoom and pan for the game stage.
 *
 * Layered on top of the base viewport-fit scale (`--stage-scale`).
 * Controls:
 *   - Ctrl+scroll wheel  → zoom (Electron/desktop)
 *   - Trackpad pinch     → zoom (Chromium maps this to Ctrl+wheel)
 *   - Left-click drag    → pan while zoomed in (desktop/exe)
 *   - Two-finger touch   → zoom + pan (touch screens)
 *   - Double-tap         → reset zoom to 1×
 *   - On-screen button   → reset zoom (visible only while zoomed in)
 *
 * Three CSS variables are written to `:root`:
 *   --user-zoom   multiplied into --stage-scale for total scale
 *   --pan-x / --pan-y  viewport-space translate applied before scale
 *
 * Pan clamping: the stage is never panned further than the amount
 * needed to keep at least the viewport's worth of content visible.
 * When userZoom = 1 pan is forced to (0, 0).
 *
 * Drag-to-pan vs click disambiguation: a DRAG_THRESHOLD of 5 px must
 * be exceeded before the mouse move is treated as a pan. If it is, a
 * one-shot capture-phase `click` listener on `window` swallows the
 * click that the browser fires after mouseup — so game elements are
 * never accidentally activated at the end of a drag.
 *
 * Zoom-centring math: when zooming at a cursor/midpoint offset
 * `vpX` from viewport centre with zoom ratio `r = newZoom / oldZoom`:
 *   newPanX = vpX + (panX - vpX) * r
 * This keeps the design-space point directly under the cursor/midpoint
 * stationary in viewport space as the scale changes.
 *
 * Two-finger pinch+drag formula:
 *   newPanX = currentMidVpX + (startPanX - startMidVpX) * r
 * — equivalent to the cursor formula but using the pinch midpoint as
 * the invariant point and adding the midpoint's own translation.
 */

import { DESIGN_WIDTH, DESIGN_HEIGHT } from "./stageScale";

const MIN_ZOOM = 1.0;
const MAX_ZOOM = 4.0;

let userZoom = 1.0;
let panX = 0;
let panY = 0;

// ---- Helpers ---------------------------------------------------------------

function getBaseFit(): number {
  if (typeof document === "undefined") return 1;
  const v = document.documentElement.style.getPropertyValue("--stage-scale");
  return parseFloat(v) || 1;
}

/** Maximum viewport-space pan offset before the stage edge crosses centre. */
function maxPanFor(zoom: number): { mx: number; my: number } {
  const s = getBaseFit() * zoom;
  return {
    mx: Math.max(0, (DESIGN_WIDTH * s - window.innerWidth) / 2),
    my: Math.max(0, (DESIGN_HEIGHT * s - window.innerHeight) / 2),
  };
}

function clampPan(zoom: number, px: number, py: number): { x: number; y: number } {
  if (zoom <= 1.0) return { x: 0, y: 0 };
  const { mx, my } = maxPanFor(zoom);
  return {
    x: Math.max(-mx, Math.min(mx, px)),
    y: Math.max(-my, Math.min(my, py)),
  };
}

function applyTransform(zoom: number, px: number, py: number): void {
  userZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  const { x, y } = clampPan(userZoom, px, py);
  panX = x;
  panY = y;

  const root = document.documentElement;
  root.style.setProperty("--user-zoom", String(userZoom));
  root.style.setProperty("--pan-x", panX + "px");
  root.style.setProperty("--pan-y", panY + "px");

  const btn = document.getElementById("pinch-zoom-reset");
  if (btn) btn.style.display = userZoom > 1.01 ? "flex" : "none";

  // Cursor: show grab hand when zoomed so the player knows they can drag.
  // Only update when not in the middle of an active drag (grabbing).
  const shell = document.getElementById("viewport-shell");
  if (shell && shell.style.cursor !== "grabbing") {
    shell.style.cursor = userZoom > 1.01 ? "grab" : "";
  }
}

// ---- Install ---------------------------------------------------------------

export function installPinchZoom(): () => void {
  // Floating reset button — lives outside #app-stage so it stays at a
  // constant on-screen size regardless of the zoom level.
  const btn = document.createElement("button");
  btn.id = "pinch-zoom-reset";
  btn.textContent = "RESET ZOOM";
  Object.assign(btn.style, {
    display: "none",
    position: "fixed",
    bottom: "80px",
    right: "16px",
    zIndex: "99999",
    background: "rgba(0,0,0,0.80)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.4)",
    borderRadius: "6px",
    padding: "6px 14px",
    fontSize: "13px",
    fontFamily: "sans-serif",
    cursor: "pointer",
    userSelect: "none",
    alignItems: "center",
    gap: "6px",
    letterSpacing: "0.04em",
    pointerEvents: "auto",
  });
  btn.addEventListener("click", () => applyTransform(1, 0, 0));
  document.body.appendChild(btn);

  // ---- Ctrl+wheel (covers trackpad pinch in Chromium/Electron) -------------

  function onWheel(e: WheelEvent): void {
    if (!e.ctrlKey) return;
    e.preventDefault();

    // Continuous sensitivity: exp(-deltaY * k). k=0.003 makes 100px of
    // scroll (one detent on most mice, Electron deltaMode=0) ≈ 26% zoom.
    const factor = Math.exp(-e.deltaY * 0.003);
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, userZoom * factor));
    const r = newZoom / userZoom;

    // Keep the point under the cursor stationary.
    const vpX = e.clientX - window.innerWidth / 2;
    const vpY = e.clientY - window.innerHeight / 2;
    applyTransform(newZoom, vpX + (panX - vpX) * r, vpY + (panY - vpY) * r);
  }

  // ---- Mouse drag-to-pan (left button, only while zoomed) -----------------
  //
  // Threshold before a mousedown+move is treated as a pan rather than a click.
  // Kept small (5 px) so the drag starts quickly, but large enough that tiny
  // hand tremors during a click don't accidentally pan.
  const DRAG_THRESHOLD = 5;

  let dragStart: { x: number; y: number; px: number; py: number } | null = null;
  let isDragging = false;

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return; // left button only
    if (userZoom <= 1.01) return; // no panning when at fit-scale
    dragStart = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    isDragging = false;
  }

  function onMouseMove(e: MouseEvent): void {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (!isDragging) {
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      isDragging = true;
      shell.style.cursor = "grabbing";
    }
    applyTransform(userZoom, dragStart.px + dx, dragStart.py + dy);
  }

  function onMouseUp(e: MouseEvent): void {
    if (e.button !== 0) return;
    const wasDragging = isDragging;
    dragStart = null;
    isDragging = false;
    // Restore grab cursor (or clear it if we've zoomed back to 1 in the meantime).
    shell.style.cursor = userZoom > 1.01 ? "grab" : "";
    if (wasDragging) {
      // Swallow the click the browser fires immediately after mouseup so that
      // game elements (board cells, cards, buttons) under the cursor are not
      // accidentally activated at the end of a drag.
      window.addEventListener("click", cancelClick, { capture: true, once: true });
    }
  }

  function cancelClick(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
  }

  // ---- Touch pinch + two-finger drag ---------------------------------------

  interface Gesture {
    startZoom: number;
    startPanX: number;
    startPanY: number;
    /** Start midpoint in viewport coords (relative to viewport centre). */
    smVpX: number;
    smVpY: number;
    startDist: number;
  }

  let gesture: Gesture | null = null;

  function touchInfo(t: TouchList): { dist: number; midVpX: number; midVpY: number } {
    const t0 = t[0]!;
    const t1 = t[1]!;
    const dx = t1.clientX - t0.clientX;
    const dy = t1.clientY - t0.clientY;
    return {
      dist: Math.sqrt(dx * dx + dy * dy),
      midVpX: (t0.clientX + t1.clientX) / 2 - window.innerWidth / 2,
      midVpY: (t0.clientY + t1.clientY) / 2 - window.innerHeight / 2,
    };
  }

  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 2) return;
    const { dist, midVpX, midVpY } = touchInfo(e.touches);
    gesture = {
      startZoom: userZoom,
      startPanX: panX,
      startPanY: panY,
      smVpX: midVpX,
      smVpY: midVpY,
      startDist: dist,
    };
  }

  function onTouchMove(e: TouchEvent): void {
    if (e.touches.length !== 2 || !gesture) return;
    e.preventDefault();

    const { dist, midVpX, midVpY } = touchInfo(e.touches);
    const scaleFactor = gesture.startDist > 0 ? dist / gesture.startDist : 1;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, gesture.startZoom * scaleFactor));
    const r = newZoom / gesture.startZoom;

    // newPan = currentMidVp + (startPan - startMidVp) * r
    const newPanX = midVpX + (gesture.startPanX - gesture.smVpX) * r;
    const newPanY = midVpY + (gesture.startPanY - gesture.smVpY) * r;
    applyTransform(newZoom, newPanX, newPanY);
  }

  function onTouchEnd(e: TouchEvent): void {
    if (e.touches.length < 2) gesture = null;
  }

  // Double-tap to reset zoom (single finger, two taps within 350 ms).
  let lastTapMs = 0;
  function onTouchEndDoubleTap(e: TouchEvent): void {
    if (e.changedTouches.length !== 1 || e.touches.length !== 0) return;
    const now = Date.now();
    if (now - lastTapMs < 350) {
      applyTransform(1, 0, 0);
      lastTapMs = 0;
    } else {
      lastTapMs = now;
    }
  }

  const shell = document.getElementById("viewport-shell") ?? document.body;

  window.addEventListener("wheel", onWheel, { passive: false });
  // Mouse drag-to-pan: mousedown on the shell, move/up on window so the pan
  // continues even if the cursor leaves the shell during a fast drag.
  shell.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  shell.addEventListener("touchstart", onTouchStart as EventListener, { passive: true });
  shell.addEventListener("touchmove", onTouchMove as EventListener, { passive: false });
  shell.addEventListener("touchend", onTouchEnd as EventListener, { passive: true });
  shell.addEventListener("touchend", onTouchEndDoubleTap as EventListener, { passive: true });

  // Initialise variables to their default state.
  applyTransform(1, 0, 0);

  return () => {
    window.removeEventListener("wheel", onWheel);
    shell.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    shell.removeEventListener("touchstart", onTouchStart as EventListener);
    shell.removeEventListener("touchmove", onTouchMove as EventListener);
    shell.removeEventListener("touchend", onTouchEnd as EventListener);
    shell.removeEventListener("touchend", onTouchEndDoubleTap as EventListener);
    btn.remove();
  };
}
