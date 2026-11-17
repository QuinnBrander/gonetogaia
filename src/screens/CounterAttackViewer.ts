import type { Router } from "../main";
import { ENEMIES } from "../data";
import enemiesJson from "../../data/enemies.json";
import type { EnemyCard } from "../types";

/**
 * Editor screen for correcting counterattack arrow mappings in
 * enemies.json against the printed card art.
 *
 * For each enemy card we render the card image alongside a 7×7
 * directional grid (offsets -3…+3 in both axes). Click a grid cell
 * to cycle through: empty → common (white) → uncommon (dark) →
 * empty. The edits live in memory + sessionStorage; when finished,
 * the user clicks "Download enemies.json" to get a complete copy
 * of the file with all edits applied, ready to paste into
 * `games/G2G/data/enemies.json`.
 *
 * The original loaded data is treated as immutable — we read from
 * `enemiesJson` directly so we know the on-disk values and can
 * highlight which enemies have been modified.
 */

const GRID_HALF = 3;
const GRID_SIZE = GRID_HALF * 2 + 1; // 7

type CellState = "empty" | "common" | "uncommon";

interface EditState {
  common: Set<string>;
  uncommon: Set<string>;
}

const STORAGE_KEY = "ca-edits-v2";

/**
 * Per-enemy edits. Keyed by enemy id. Sets contain "dx,dy"
 * strings (matching the grid cell key format).
 */
const edits = new Map<string, EditState>();

function offsetKey(dx: number, dy: number): string {
  return `${dx},${dy}`;
}

function parseKey(k: string): { dx: number; dy: number } {
  const parts = k.split(",");
  return { dx: Number(parts[0]), dy: Number(parts[1]) };
}

function loadEditsFromStorage(): void {
  edits.clear();
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, { common: string[]; uncommon: string[] }>;
    for (const [id, v] of Object.entries(parsed)) {
      edits.set(id, {
        common: new Set(v.common ?? []),
        uncommon: new Set(v.uncommon ?? []),
      });
    }
  } catch {
    /* swallow */
  }
}

function persistEdits(): void {
  const out: Record<string, { common: string[]; uncommon: string[] }> = {};
  for (const [id, v] of edits.entries()) {
    out[id] = { common: [...v.common], uncommon: [...v.uncommon] };
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(out));
}

/**
 * Build an edit state for an enemy. If the user has edits in
 * memory, use those; otherwise initialise from the on-disk data.
 */
function getOrInitEdit(card: EnemyCard): EditState {
  const existing = edits.get(card.id);
  if (existing) return existing;
  const fresh: EditState = {
    common: new Set((card.counterCommon ?? []).map((o) => offsetKey(o.dx, o.dy))),
    uncommon: new Set((card.counterUncommon ?? []).map((o) => offsetKey(o.dx, o.dy))),
  };
  edits.set(card.id, fresh);
  return fresh;
}

/**
 * The original (on-disk) state for a card — used to detect "dirty"
 * status. Read straight from the JSON import so it's frozen at
 * page load.
 */
function originalState(card: EnemyCard): { common: Set<string>; uncommon: Set<string> } {
  return {
    common: new Set((card.counterCommon ?? []).map((o) => offsetKey(o.dx, o.dy))),
    uncommon: new Set((card.counterUncommon ?? []).map((o) => offsetKey(o.dx, o.dy))),
  };
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function isDirty(card: EnemyCard): boolean {
  const cur = getOrInitEdit(card);
  const orig = originalState(card);
  return !setsEqual(cur.common, orig.common) || !setsEqual(cur.uncommon, orig.uncommon);
}

function cellStateAt(state: EditState, dx: number, dy: number): CellState {
  const key = offsetKey(dx, dy);
  if (state.common.has(key)) return "common";
  if (state.uncommon.has(key)) return "uncommon";
  return "empty";
}

function cycleCell(state: EditState, dx: number, dy: number): void {
  const key = offsetKey(dx, dy);
  if (state.common.has(key)) {
    state.common.delete(key);
    state.uncommon.add(key);
  } else if (state.uncommon.has(key)) {
    state.uncommon.delete(key);
  } else {
    state.common.add(key);
  }
}

function renderGrid(card: EnemyCard, onChange: () => void): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "ca-grid-wrapper";

  const compass = document.createElement("div");
  compass.className = "ca-compass";
  compass.innerHTML = `
    <span class="ca-compass-n">N</span>
    <div class="ca-grid-and-ew">
      <span class="ca-compass-w">W</span>
      <div class="ca-grid" style="--gs:${GRID_SIZE}"></div>
      <span class="ca-compass-e">E</span>
    </div>
    <span class="ca-compass-s">S</span>
  `;

  const grid = compass.querySelector(".ca-grid") as HTMLElement;
  const state = getOrInitEdit(card);

  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const dx = col - GRID_HALF;
      const dy = row - GRID_HALF;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "ca-cell";

      if (dx === 0 && dy === 0) {
        cell.classList.add("ca-cell--enemy");
        cell.textContent = "E";
        cell.disabled = true;
      } else {
        const cs = cellStateAt(state, dx, dy);
        cell.classList.add(`ca-cell--${cs}`);
        cell.title = `(${dx >= 0 ? "+" : ""}${dx}, ${dy >= 0 ? "+" : ""}${dy}) — click to cycle`;
        cell.addEventListener("click", () => {
          cycleCell(state, dx, dy);
          persistEdits();
          onChange();
        });
      }

      grid.appendChild(cell);
    }
  }

  const legend = document.createElement("div");
  legend.className = "ca-legend";
  legend.innerHTML = `
    <span class="ca-legend-item"><span class="ca-cell ca-cell--common"></span> Common (2–5)</span>
    <span class="ca-legend-item"><span class="ca-cell ca-cell--uncommon"></span> Uncommon (6)</span>
    <span class="ca-legend-hint">Click to cycle</span>
  `;

  wrapper.appendChild(compass);
  wrapper.appendChild(legend);
  return wrapper;
}

/**
 * Render the offsets as a sorted, readable list. Sort order:
 * top-to-bottom, left-to-right (dy first, then dx).
 */
function renderOffsetList(label: string, offsets: { dx: number; dy: number }[]): string {
  if (!offsets.length) return `<div class="ca-offset-list"><strong>${label}:</strong> <em>(none)</em></div>`;
  const sorted = [...offsets].sort((a, b) => a.dy - b.dy || a.dx - b.dx);
  const items = sorted
    .map((o) => `(${o.dx >= 0 ? "+" : ""}${o.dx}, ${o.dy >= 0 ? "+" : ""}${o.dy})`)
    .join(" &nbsp; ");
  return `<div class="ca-offset-list"><strong>${label}:</strong> ${items}</div>`;
}

function stateToOffsets(s: Set<string>): { dx: number; dy: number }[] {
  return [...s].map(parseKey).sort((a, b) => a.dy - b.dy || a.dx - b.dx);
}

function renderCardPanel(card: EnemyCard, refresh: () => void): HTMLElement {
  const panel = document.createElement("div");
  const dirty = isDirty(card);
  panel.className = `ca-card-panel${dirty ? " ca-card-panel--dirty" : ""}`;

  // Card image
  const imgWrap = document.createElement("div");
  imgWrap.className = "ca-img-wrap";
  if (card.image) {
    const img = document.createElement("img");
    img.src = `/cards/${card.image}`;
    img.alt = card.name;
    img.className = "ca-card-img";
    img.loading = "lazy";
    imgWrap.appendChild(img);
  }

  // Grid (editable)
  const gridEl = renderGrid(card, refresh);

  // Info + buttons
  const info = document.createElement("div");
  info.className = "ca-info";

  const title = document.createElement("div");
  title.className = "ca-title";
  title.innerHTML = `${card.name} — ${card.id} ${dirty ? '<span class="ca-dirty-badge">● EDITED</span>' : '<span class="ca-clean-badge">✓ original</span>'}`;

  const state = getOrInitEdit(card);
  const offsets = document.createElement("div");
  offsets.className = "ca-offsets";
  offsets.innerHTML =
    renderOffsetList("Common", stateToOffsets(state.common)) +
    renderOffsetList("Uncommon", stateToOffsets(state.uncommon));

  const btnRow = document.createElement("div");
  btnRow.className = "ca-btn-row";

  const resetBtn = document.createElement("button");
  resetBtn.className = "btn btn--ghost ca-reset-btn";
  resetBtn.textContent = "Reset to file";
  resetBtn.disabled = !dirty;
  resetBtn.addEventListener("click", () => {
    edits.delete(card.id);
    persistEdits();
    refresh();
  });

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn ca-copy-btn";
  copyBtn.textContent = "Copy snippet";
  copyBtn.addEventListener("click", () => {
    const snippet = formatSnippet(card.id, state);
    navigator.clipboard.writeText(snippet).then(() => {
      copyBtn.textContent = "✓ Copied";
      setTimeout(() => (copyBtn.textContent = "Copy snippet"), 1500);
    });
  });

  btnRow.appendChild(resetBtn);
  btnRow.appendChild(copyBtn);

  info.appendChild(title);
  info.appendChild(offsets);
  info.appendChild(btnRow);

  panel.appendChild(imgWrap);
  panel.appendChild(gridEl);
  panel.appendChild(info);

  return panel;
}

/**
 * Format the counterCommon / counterUncommon snippet for one
 * enemy in the same indentation style as enemies.json. Useful for
 * pasting a single-enemy fix without touching the rest.
 */
function formatSnippet(id: string, state: EditState): string {
  const common = stateToOffsets(state.common);
  const uncommon = stateToOffsets(state.uncommon);
  const fmt = (arr: { dx: number; dy: number }[]) => {
    if (!arr.length) return "[]";
    const items = arr.map((o) => `      { "dx": ${String(o.dx).padStart(2)}, "dy": ${String(o.dy).padStart(2)} }`).join(",\n");
    return `[\n${items}\n    ]`;
  };
  return `"id": "${id}",
"counterCommon": ${fmt(common)},
"counterUncommon": ${fmt(uncommon)}`;
}

/**
 * Build the full enemies.json with current edits applied. Returns
 * a JSON string formatted to match the existing file style
 * (pretty-printed outer, but counterCommon / counterUncommon as
 * inline arrays of compact single-line offset objects).
 */
function buildUpdatedEnemiesJson(): string {
  const raw = enemiesJson as readonly EnemyCard[];
  const updated = raw.map((card) => {
    const edit = edits.get(card.id);
    if (!edit) return card;
    return {
      ...card,
      counterCommon: stateToOffsets(edit.common),
      counterUncommon: stateToOffsets(edit.uncommon),
    };
  });
  // Standard pretty-print, then post-process the offset arrays to
  // be inline single-line for diff cleanliness.
  let json = JSON.stringify(updated, null, 2);
  json = json.replace(
    /"(counterCommon|counterUncommon)": \[([^\]]*)\]/g,
    (_m, key, body) => {
      const inline = body
        .split("\n")
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0)
        .join(" ");
      return `"${key}": [ ${inline} ]`.replace(/,\s*\]/, " ]");
    },
  );
  return json;
}

function downloadUpdatedJson(): void {
  const json = buildUpdatedEnemiesJson();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "enemies.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Build a compact "all edited enemies" digest for the user to
 * paste back to the agent. One block per edited enemy with
 * common / uncommon offsets listed inline.
 */
function buildCompactEditsDigest(): string {
  const lines: string[] = [];
  for (const card of ENEMIES) {
    if (!isDirty(card)) continue;
    const state = edits.get(card.id)!;
    const fmt = (s: Set<string>) =>
      stateToOffsets(s)
        .map((o) => `(${o.dx},${o.dy})`)
        .join(" ");
    lines.push(`${card.id}:`);
    lines.push(`  common:   ${fmt(state.common) || "(none)"}`);
    lines.push(`  uncommon: ${fmt(state.uncommon) || "(none)"}`);
    lines.push("");
  }
  return lines.length ? lines.join("\n").trimEnd() : "(no edits)";
}

export function renderCounterAttackViewer(root: HTMLElement, router: Router): void {
  loadEditsFromStorage();

  const wrap = document.createElement("div");
  wrap.className = "screen screen--ca-viewer";

  const header = document.createElement("div");
  header.className = "ca-header";
  header.innerHTML = `<h2>Counterattack Editor</h2>
    <p>Click any cell to cycle empty → common (white) → uncommon (dark). Edits are kept in this tab's sessionStorage.</p>`;

  const backBtn = document.createElement("button");
  backBtn.className = "btn btn--ghost";
  backBtn.textContent = "← Back";
  backBtn.addEventListener("click", () => router.goTo({ name: "title" }));
  header.appendChild(backBtn);

  wrap.appendChild(header);

  // Top action bar
  const actionBar = document.createElement("div");
  actionBar.className = "ca-summary-bar";

  const summary = document.createElement("span");
  actionBar.appendChild(summary);

  const copyAllBtn = document.createElement("button");
  copyAllBtn.className = "btn btn--ghost";
  copyAllBtn.textContent = "Copy all edits";
  copyAllBtn.addEventListener("click", () => {
    const digest = buildCompactEditsDigest();
    navigator.clipboard.writeText(digest).then(() => {
      copyAllBtn.textContent = "✓ Copied";
      setTimeout(() => (copyAllBtn.textContent = "Copy all edits"), 1500);
    });
  });
  actionBar.appendChild(copyAllBtn);

  const downloadBtn = document.createElement("button");
  downloadBtn.className = "btn";
  downloadBtn.textContent = "⬇ Download enemies.json";
  downloadBtn.addEventListener("click", () => downloadUpdatedJson());
  actionBar.appendChild(downloadBtn);

  const resetAllBtn = document.createElement("button");
  resetAllBtn.className = "btn btn--ghost btn--danger";
  resetAllBtn.textContent = "Reset all edits";
  resetAllBtn.addEventListener("click", () => {
    if (!confirm("Discard ALL edits in this session?")) return;
    edits.clear();
    persistEdits();
    refreshAll();
  });
  actionBar.appendChild(resetAllBtn);

  wrap.appendChild(actionBar);

  // List grouped by family
  const families: Record<string, EnemyCard[]> = {};
  for (const card of ENEMIES) {
    const fam = card.family ?? "Unknown";
    if (!families[fam]) families[fam] = [];
    families[fam].push(card);
  }

  const listEl = document.createElement("div");
  listEl.className = "ca-list";
  wrap.appendChild(listEl);

  // Track per-card containers so we can rebuild a single panel
  // when its cell is clicked, rather than re-rendering the whole
  // screen (which would jump scroll and re-create images).
  const panelContainers = new Map<string, HTMLElement>();

  function rebuildPanel(card: EnemyCard): void {
    const container = panelContainers.get(card.id);
    if (!container) return;
    const next = renderCardPanel(card, () => {
      rebuildPanel(card);
      updateSummary();
    });
    container.replaceWith(next);
    panelContainers.set(card.id, next);
  }

  function refreshAll(): void {
    for (const card of ENEMIES) rebuildPanel(card);
    updateSummary();
  }

  function updateSummary(): void {
    const total = ENEMIES.length;
    const edited = ENEMIES.filter((c) => isDirty(c)).length;
    summary.innerHTML = `
      <strong>${edited}</strong> of ${total} enemies edited
    `;
  }

  for (const [family, cards] of Object.entries(families)) {
    const section = document.createElement("div");
    section.className = "ca-family-section";

    const heading = document.createElement("h3");
    heading.className = "ca-family-heading";
    heading.textContent = family;
    section.appendChild(heading);

    for (const card of cards) {
      const panel = renderCardPanel(card, () => {
        rebuildPanel(card);
        updateSummary();
      });
      panelContainers.set(card.id, panel);
      section.appendChild(panel);
    }

    listEl.appendChild(section);
  }

  root.appendChild(wrap);
  updateSummary();
}
