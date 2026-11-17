/**
 * DataViewer \u2014 debug screen for verifying every piece of extracted gameplay
 * data side-by-side with the original card art.
 *
 * Sections (in order):
 *   1. Heroes
 *   2. Equipment cards (with range visualization + card image)
 *   3. Enemies (with counter-range visualization + card image)
 *   4. Quest #1 (with spawn visualization + storybook page image)
 *   5. Elements
 *   6. Delver Boards (slot abilities + element mapping)
 *
 * If any extracted value here looks wrong against the printed card, the JSON
 * file under data/ is the only place to fix it.
 */

import type { Router } from "../main";
import {
  HEROES, EQUIPMENT, ENEMIES, QUEST1, ELEMENTS, DELVER_BOARDS,
  getEquipment,
} from "../data";
import type {
  EquipmentCard, EnemyCard, Offset, WeaponRange, Suit,
} from "../types";
import { ADJACENT_OFFSETS_8WAY, RAY_DIRECTIONS_4WAY, RAY_DIRECTIONS_8WAY } from "../rules";

export function renderDataViewer(root: HTMLElement, router: Router): void {
  const wrap = document.createElement("div");
  wrap.className = "screen screen--data";

  wrap.appendChild(topBar(router));

  wrap.appendChild(section("Heroes", heroesTable()));
  wrap.appendChild(section("Equipment cards (the 6 starting cards for Quest #1)", equipmentList()));
  wrap.appendChild(section("Enemies (Crystanid 001-007 + Soulhunter 001)", enemiesList()));
  wrap.appendChild(section("Quest #1 - Reach the Buoy", questBlock()));
  wrap.appendChild(section("Elements", elementsTable()));
  wrap.appendChild(section("Delver Boards", delverBoardsBlock()));

  root.appendChild(wrap);
}

// --- Section helpers -----------------------------------------------------

function topBar(router: Router): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "topbar";
  const left = document.createElement("div");
  left.innerHTML = "<strong>Data Viewer</strong> - verify extracted values against printed cards";
  const back = document.createElement("button");
  back.className = "btn btn--small btn--ghost";
  back.textContent = "\u2190 Back to Title";
  back.addEventListener("click", () => router.goTo({ name: "title" }));
  bar.append(left, back);
  return bar;
}

function section(title: string, body: HTMLElement): HTMLElement {
  const s = document.createElement("section");
  s.className = "data-section";
  const h = document.createElement("h2");
  h.textContent = title;
  s.append(h, body);
  return s;
}

// --- Heroes --------------------------------------------------------------

function heroesTable(): HTMLElement {
  const tbl = document.createElement("table");
  tbl.className = "data-table";
  tbl.innerHTML = `
    <thead><tr><th>ID</th><th>Hero #</th><th>Suit</th><th>Starting Equipment</th></tr></thead>
    <tbody></tbody>
  `;
  const body = tbl.querySelector("tbody")!;
  for (const h of HEROES) {
    const tr = document.createElement("tr");
    const equip = h.startingEquipment.map((id) => {
      const e = getEquipment(id);
      return `${e.name} (${e.type} R${e.rank})`;
    }).join(" \u00b7 ");
    tr.innerHTML = `<td><code>${h.id}</code></td><td>#${h.number}</td><td>${h.suit}</td><td>${equip}</td>`;
    body.appendChild(tr);
  }
  return tbl;
}

// --- Equipment -----------------------------------------------------------

function equipmentList(): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "card-grid";
  for (const card of EQUIPMENT) {
    grid.appendChild(equipmentCardBlock(card));
  }
  return grid;
}

function equipmentCardBlock(card: EquipmentCard): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "card-block";

  const img = document.createElement("img");
  img.className = "card-image";
  img.src = `/cards/${card.image}`;
  img.alt = card.name;
  wrap.appendChild(img);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.innerHTML = `
    <h3>${card.name} <span class="muted">(${card.type} R${card.rank})</span></h3>
    <div class="row"><b>Suit:</b> ${card.suit}</div>
    <div class="row"><b>Category:</b> ${card.category}</div>
    <div class="row"><b>Card #:</b> ${card.cardNumber}</div>
    ${card.damageType ? `<div class="row"><b>Damage:</b> ${card.damageMultiplier ?? 1}\u00d7 ${card.damageType.toUpperCase()}</div>` : ""}
    ${card.range ? `<div class="row"><b>Range type:</b> <code>${card.range.kind}</code></div>` : ""}
    <div class="ability"><b>Ability:</b> <em>${card.abilityText}</em></div>
    ${card.effects?.length ? `<div class="row"><b>Effects:</b> <code>${JSON.stringify(card.effects)}</code></div>` : ""}
  `;
  wrap.appendChild(meta);

  if (card.range) {
    const rangeViz = renderRangeViz(card.range);
    wrap.appendChild(rangeViz);
  }

  return wrap;
}

function renderRangeViz(range: WeaponRange): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "range-viz";

  const label = document.createElement("div");
  label.className = "viz-label";

  switch (range.kind) {
    case "single-adjacent":
      label.textContent = "Range: any 1 adjacent enemy (player chooses) - adjacency is 8-way (orthogonal + diagonal)";
      wrap.appendChild(label);
      wrap.appendChild(grid5([...ADJACENT_OFFSETS_8WAY], "any-of"));
      break;
    case "fixed-pattern":
      label.textContent = "Range: fixed pattern";
      wrap.appendChild(label);
      wrap.appendChild(grid5(range.tiles, "all"));
      break;
    case "die-roll-fixed":
      label.textContent = "Range: depends on D6 roll";
      wrap.appendChild(label);
      for (const r of range.rolls) {
        const sub = document.createElement("div");
        sub.className = "roll-block";
        sub.innerHTML = `<div class="viz-sublabel">${r.min}-${r.max}</div>`;
        sub.appendChild(grid5(r.tiles, "all"));
        wrap.appendChild(sub);
      }
      break;
    case "straight-line": {
      const dirs = range.includeDiagonals ? RAY_DIRECTIONS_8WAY : RAY_DIRECTIONS_4WAY;
      label.innerHTML = `Range: like a bow - ${range.firstTargetOnly ? "<b>first</b> enemy" : "every enemy"} along any of the ${dirs.length} straight rays from the delver, at <b>any</b> distance${range.includeDiagonals ? " (orthogonal + diagonal)" : " (orthogonal only)"}`;
      wrap.appendChild(label);
      // Expand each direction to every tile reachable along that ray within
      // the 5x5 visualization (the actual ray continues to the board edge).
      const rayTiles: Offset[] = [];
      for (const d of dirs) {
        for (let step = 1; step <= 2; step++) {
          rayTiles.push({ dx: d.dx * step, dy: d.dy * step });
        }
      }
      wrap.appendChild(grid5(rayTiles, "any-of"));
      const note = document.createElement("div");
      note.className = "viz-note";
      note.textContent = "(highlighted tiles continue past the 5x5 preview to the board edge)";
      wrap.appendChild(note);
      break;
    }
    case "chain": {
      const lines = [
        "Range: chain of <b>connected</b> enemies",
        range.requiresAdjacentTo === "self"
          ? "Gated by the <b>attacker</b> being adjacent to at least one enemy in the chain"
          : "Gated by the <b>other</b> delver being adjacent to at least one enemy in the chain",
        "Connection follows the same 8-way adjacency as movement",
      ].filter(Boolean);
      label.innerHTML = lines.join(" - ");
      wrap.appendChild(label);
      // Render the adjacency definition next to the chain text so the
      // adjacency rule used for "connected" is visually unambiguous.
      const adj = document.createElement("div");
      adj.className = "viz-sublabel";
      adj.textContent = "Adjacency definition (used to determine which enemies are 'connected'):";
      wrap.appendChild(adj);
      wrap.appendChild(grid5([...ADJACENT_OFFSETS_8WAY], "any-of"));
      break;
    }
  }
  return wrap;
}

// --- Enemies -------------------------------------------------------------

function enemiesList(): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "card-grid";
  for (const enemy of ENEMIES) {
    grid.appendChild(enemyCardBlock(enemy));
  }
  return grid;
}

function enemyCardBlock(enemy: EnemyCard): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "card-block";

  const img = document.createElement("img");
  img.className = "card-image card-image--enemy";
  img.src = `/cards/${enemy.image}`;
  img.alt = enemy.name;
  wrap.appendChild(img);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.innerHTML = `
    <h3>${enemy.name} <span class="muted">(${enemy.kind} #${enemy.cardNumber}/${enemy.family})</span></h3>
    <div class="row"><b>HP:</b> ${enemy.hp} \u00b7 <b>ATK:</b> ${enemy.attack}</div>
    <div class="row"><b>Parting Shot:</b> <em>${enemy.partingShotText}</em></div>
    ${enemy.abilityText ? `<div class="row"><b>Ability:</b> <em>${enemy.abilityText}</em></div>` : ""}
    <div class="row"><b>On Death:</b> drops [${enemy.onDeath.drops.join(", ")}]
      ${enemy.onDeath.gainXp ? `\u00b7 +${enemy.onDeath.gainXp} XP` : ""}
      ${enemy.onDeath.gainElements?.length ? `\u00b7 grants elements: ${enemy.onDeath.gainElements.join(", ")}` : ""}
      ${enemy.onDeath.gainLevelUpCards ? `\u00b7 +${enemy.onDeath.gainLevelUpCards} LEVEL UP card` : ""}
    </div>
  `;
  wrap.appendChild(meta);

  const counters = document.createElement("div");
  counters.className = "counter-vizes";

  const common = document.createElement("div");
  common.className = "counter-block counter-block--common";
  common.innerHTML = `<div class="viz-sublabel">Common (rolled 2-5) - white arrows on purple</div>`;
  if (enemy.counterCommon.length === 0) {
    common.appendChild(emptyNote());
  } else {
    common.appendChild(grid5(enemy.counterCommon, "all", "common"));
  }
  counters.appendChild(common);

  const uncommon = document.createElement("div");
  uncommon.className = "counter-block counter-block--uncommon";
  uncommon.innerHTML = `<div class="viz-sublabel">Uncommon (rolled 6) - black arrows on green</div>`;
  if (enemy.counterUncommon.length === 0) {
    uncommon.appendChild(emptyNote());
  } else {
    uncommon.appendChild(grid5(enemy.counterUncommon, "all", "uncommon"));
  }
  counters.appendChild(uncommon);

  // Per-direction compass: a 3x3 grid showing each of the 8 directions with
  // its encoded color (common/uncommon/none) and number of tiles. Much
  // easier to spot-check against the printed card than the raw mini-grid.
  const compass = document.createElement("div");
  compass.className = "counter-block";
  compass.innerHTML = `<div class="viz-sublabel">Per-direction breakdown (compass)</div>`;
  compass.appendChild(renderCompass(enemy));
  counters.appendChild(compass);

  wrap.appendChild(counters);
  return wrap;
}

function emptyNote(): HTMLElement {
  const e = document.createElement("div");
  e.className = "viz-empty";
  e.textContent = "(none extracted)";
  return e;
}

/** Return all offsets along the given unit direction, in order from closest. */
function tilesAlongDir(offsets: Offset[], dir: Offset): Offset[] {
  // Filter to those that lie exactly along `dir` from origin (i.e. positive
  // integer multiple of dir), sorted by distance.
  const out: Array<{ step: number; t: Offset }> = [];
  for (const o of offsets) {
    if (dir.dx === 0) {
      if (o.dx !== 0) continue;
      if (Math.sign(o.dy) !== Math.sign(dir.dy)) continue;
      out.push({ step: Math.abs(o.dy), t: o });
    } else if (dir.dy === 0) {
      if (o.dy !== 0) continue;
      if (Math.sign(o.dx) !== Math.sign(dir.dx)) continue;
      out.push({ step: Math.abs(o.dx), t: o });
    } else {
      // Diagonal: must satisfy o.dx/dir.dx === o.dy/dir.dy and be positive.
      if (o.dx === 0 || o.dy === 0) continue;
      if (Math.sign(o.dx) !== Math.sign(dir.dx)) continue;
      if (Math.sign(o.dy) !== Math.sign(dir.dy)) continue;
      if (Math.abs(o.dx) !== Math.abs(o.dy)) continue;
      out.push({ step: Math.abs(o.dx), t: o });
    }
  }
  return out.sort((a, b) => a.step - b.step).map((r) => r.t);
}

const COMPASS_DIRS: ReadonlyArray<{ key: string; label: string; dir: Offset }> = [
  { key: "NW", label: "NW", dir: { dx: -1, dy: -1 } },
  { key: "N",  label: "N",  dir: { dx:  0, dy: -1 } },
  { key: "NE", label: "NE", dir: { dx:  1, dy: -1 } },
  { key: "W",  label: "W",  dir: { dx: -1, dy:  0 } },
  { key: "C",  label: "",   dir: { dx:  0, dy:  0 } },
  { key: "E",  label: "E",  dir: { dx:  1, dy:  0 } },
  { key: "SW", label: "SW", dir: { dx: -1, dy:  1 } },
  { key: "S",  label: "S",  dir: { dx:  0, dy:  1 } },
  { key: "SE", label: "SE", dir: { dx:  1, dy:  1 } },
];

function renderCompass(enemy: EnemyCard): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "compass";
  for (const d of COMPASS_DIRS) {
    const cell = document.createElement("div");
    cell.className = "compass-cell";
    if (d.key === "C") {
      cell.classList.add("compass-cell--center");
      cell.textContent = enemy.name;
      wrap.appendChild(cell);
      continue;
    }
    const inCommon = tilesAlongDir([...enemy.counterCommon], d.dir);
    const inUncommon = tilesAlongDir([...enemy.counterUncommon], d.dir);
    if (inCommon.length === 0 && inUncommon.length === 0) {
      cell.classList.add("compass-cell--empty");
      cell.innerHTML = `<div class="compass-dir">${d.label}</div><div class="compass-info">-</div>`;
    } else if (inCommon.length > 0 && inUncommon.length > 0) {
      cell.classList.add("compass-cell--mixed");
      cell.innerHTML = `<div class="compass-dir">${d.label}</div>
        <div class="compass-info"><span class="pill pill--common">${inCommon.length}</span> + <span class="pill pill--uncommon">${inUncommon.length}</span></div>`;
    } else if (inCommon.length > 0) {
      cell.classList.add("compass-cell--common");
      cell.innerHTML = `<div class="compass-dir">${d.label}</div>
        <div class="compass-info"><span class="pill pill--common">${inCommon.length}</span> common</div>`;
    } else {
      cell.classList.add("compass-cell--uncommon");
      cell.innerHTML = `<div class="compass-dir">${d.label}</div>
        <div class="compass-info"><span class="pill pill--uncommon">${inUncommon.length}</span> uncommon</div>`;
    }
    wrap.appendChild(cell);
  }
  return wrap;
}

// --- Quest 1 -------------------------------------------------------------

function questBlock(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "quest-block";

  // DataViewer is Q1-only today; the spawn-viz below only knows how
  // to render the hand-authored variant. If a future quest is
  // selected here the caller will need to fan out by `spawn.kind`.
  const w1 = QUEST1.waves[0]!;
  wrap.innerHTML = `
    <div class="quest-meta">
      <div class="row"><b>Name:</b> ${QUEST1.name}</div>
      <div class="row"><b>Wave 1 Goal:</b> ${w1.goal}</div>
      <div class="row"><b>Boss:</b> ${w1.bossEnemyId}</div>
      <div class="row"><b>Minion Pool:</b> ${w1.minionEnemyIds.join(", ")}</div>
      <div class="row"><b>End of Wave - both survive:</b> page <code>${w1.endOfWave.bothSurvive}</code></div>
      <div class="row"><b>End of Wave - any die:</b> page <code>${w1.endOfWave.anyDie}</code></div>
    </div>

    <div class="quest-spawn-pair">
      <div>
        <div class="viz-sublabel">Encoded spawn (5x5):</div>
        <div class="spawn-viz" id="spawn-viz"></div>
        <div class="spawn-legend">
          <span class="legend-item legend-item--delver">D</span> Delver start &nbsp;
          <span class="legend-item legend-item--boss">B</span> Boss &nbsp;
          <span class="legend-item legend-item--minion">M</span> Minion
        </div>
      </div>
      <div>
        <div class="viz-sublabel">Source (storybook page 4):</div>
        <img class="spawn-source" src="/cards/storybook_ch1_page4.jpg" alt="Storybook page 4" />
      </div>
    </div>

    <div class="quest-pages">
      <h3>Narrative pages</h3>
      ${QUEST1.intro.map((text, i) => `
        <div class="page-block"><b>Intro p${i + 1}:</b><p>${escapeNl(text)}</p></div>
      `).join("")}
      ${Object.entries(QUEST1.pages).map(([id, text]) => `
        <div class="page-block"><b>${id}:</b><p>${escapeNl(text)}</p></div>
      `).join("")}
    </div>
  `;

  // Render the spawn viz as a 5x5 grid with markers. Q1's spawn is
  // always hand-authored — narrow here so the per-cell viz code
  // below can read `delverStart` / `boss` / `minions` directly.
  const spawn = w1.spawn;
  if (spawn.kind !== "hand-authored") {
    throw new Error(
      `DataViewer.questBlock expected Q1 hand-authored spawn, got "${spawn.kind}"`,
    );
  }
  const vizEl = wrap.querySelector("#spawn-viz")!;
  for (let y = 0; y < spawn.boardSize.h; y++) {
    for (let x = 0; x < spawn.boardSize.w; x++) {
      const cell = document.createElement("div");
      cell.className = "spawn-cell";
      if (spawn.delverStart.x === x && spawn.delverStart.y === y) {
        cell.classList.add("spawn-cell--delver");
        cell.textContent = "D";
      } else if (spawn.boss.x === x && spawn.boss.y === y) {
        cell.classList.add("spawn-cell--boss");
        cell.textContent = "B";
      } else if (spawn.minions.some((m) => m.x === x && m.y === y)) {
        cell.classList.add("spawn-cell--minion");
        cell.textContent = "M";
      }
      vizEl.appendChild(cell);
    }
  }

  return wrap;
}

// --- Elements ------------------------------------------------------------

function elementsTable(): HTMLElement {
  const tbl = document.createElement("table");
  tbl.className = "data-table";
  tbl.innerHTML = `<thead><tr><th>ID</th><th>Name</th><th>Icon Hint</th></tr></thead><tbody></tbody>`;
  const body = tbl.querySelector("tbody")!;
  for (const e of ELEMENTS) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><code>${e.id}</code></td><td>${e.name}</td><td>${e.iconHint}</td>`;
    body.appendChild(tr);
  }
  return tbl;
}

// --- Delver Boards -------------------------------------------------------

function delverBoardsBlock(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "delver-boards-grid";

  for (const board of DELVER_BOARDS) {
    const block = document.createElement("div");
    block.className = "delver-board-block";

    block.innerHTML = `
      <h3>${suitLabel(board.suit)}</h3>
      <img class="delver-board-image" src="${board.background}" alt="${board.suit} delver suit" />
      <div class="slot-abilities">
        <div class="viz-sublabel">Weapon slot abilities + element mapping (left to right):</div>
        <ol class="slot-list">
          ${board.weaponSlots.map((s, i) => `
            <li><b>Slot ${i + 1}</b> [<code>${s.element}</code>]: <em>${s.slotAbilityText}</em></li>
          `).join("")}
        </ol>
      </div>
    `;

    wrap.appendChild(block);
  }

  return wrap;
}

function suitLabel(s: Suit): string {
  return s === "mind" ? "Disciple of the Mind" : "Disciple of the Body";
}

// --- 5x5 grid helper -----------------------------------------------------

/**
 * Render a small grid centered on the origin, with given offsets highlighted.
 * `mode` controls visual styling: 'all' = each tile is hit; 'any-of' = the
 * player picks one of the highlighted tiles.
 */
function grid5(tiles: Offset[], mode: "all" | "any-of", flavor: "default" | "common" | "uncommon" = "default"): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "mini-grid";
  // Use 5 cells centered on origin: x and y from -2..+2.
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      const c = document.createElement("div");
      c.className = "mini-cell";
      if (x === 0 && y === 0) {
        c.classList.add("mini-cell--origin");
        c.textContent = "*";
      } else if (tiles.some((t) => t.dx === x && t.dy === y)) {
        c.classList.add("mini-cell--hit");
        c.classList.add(`mini-cell--${flavor}`);
        c.classList.add(`mini-cell--${mode}`);
      }
      grid.appendChild(c);
    }
  }
  return grid;
}

function escapeNl(s: string): string {
  return s.replace(/\n/g, "<br>");
}
