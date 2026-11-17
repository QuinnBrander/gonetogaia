/**
 * Campaign Sheet — utilitarian summary of all campaign-level state.
 *
 * Modeled after the printed Campaign Sheet (rulebook p7) but trimmed
 * to Quest #1 scope (DESIGN.md §1): per-delver minion + boss parts,
 * shared XP / Level / Level-Up Cards owed, quest #1 completion flag,
 * memory chip count.
 *
 * Also exposes a "Mark a Level Up Card drawn" decrement button per
 * DESIGN.md §3.3 — players draw their cards at the table, so the
 * digital sheet is just bookkeeping.
 *
 * Read-mostly screen. The only mutation is the level-up decrement.
 * Out of scope for v1: scars, shop purchases, opinions, witness,
 * memory chip spend, fundraising.
 */

import type { Router } from "../main";
import { HEROES, SPAWN_CARDS, getHero, getHeroCard, getShopProduct, ELEMENTS, ELEMENT_IMAGE, keyItemImageOrNull, opinionCardImageOrNull, questImageOrNull, shopProductImageOrNull, getEquipmentByTypeSuit, scenarioCardOrNull } from "../data";
import type { Element } from "../types";
import { SUIT_PART_EQUIPMENT_TYPES_BY_SUIT, SUIT_PART_LABEL, type SuitPart, type EquipmentType } from "../types";
import { xpCostForNextLevel } from "../xp";
import { presentSpawnDeck } from "./SpawnDeckViewer";
import { presentEquipmentCards } from "./EquipmentCardsModal";
import { getEffectiveEquipmentRank, type CampaignState } from "../state";
import { totalKeyItemClues } from "../engine/townVisit";
import { renderSuitConditionArt } from "../ui/suitConditionArt";

/** Inline element token icon — used in table headers + future inline use. */
function elementIcon(id: Element, size = 28): string {
  return `<img class="campaign-icon campaign-icon--element"
    src="/tokens/${ELEMENT_IMAGE[id]}"
    alt="${id}"
    title="${id.charAt(0).toUpperCase() + id.slice(1)}"
    width="${size}" height="${size}" />`;
}

/** Suit-aware part icon (mind delver gets the mind variant; body gets body). */
function partIcon(
  suit: "mind" | "body",
  kind: "minion" | "boss-lvl-1" | "boss-lvl-2" | "boss-lvl-3" | "boss-lvl-4" | "boss-lvl-5",
  size = 28,
): string {
  const file = kind === "minion" ? `minion-${suit}.webp` : `${kind}-${suit}.webp`;
  return `<img class="campaign-icon campaign-icon--part"
    src="/tokens/${file}"
    alt="${kind}-${suit}"
    width="${size}" height="${size}" />`;
}

export function renderCampaignSheet(root: HTMLElement, router: Router): void {
  const state = router.state;
  const openQuests = state.revealedQuests.filter((q) => !state.completedQuests.includes(q.number));
  const completedQuests = state.revealedQuests.filter((q) => state.completedQuests.includes(q.number));

  const wrap = document.createElement("div");
  wrap.className = "screen screen--campaign-sheet";
  wrap.innerHTML = `
    <div class="board-topbar">
      <div class="board-topbar-goal">
        <strong>Campaign Sheet</strong>
      </div>
      <div class="board-topbar-actions">
        <button class="btn btn--small btn--ghost" data-action="back">Back to title</button>
      </div>
    </div>

    <div class="campaign-sheet-grid">

      <!-- ROW 1: 1+1+1+1+1 = 5 -->
      <section class="campaign-card">
        <h3>Quest progress</h3>
        <ul class="campaign-list">
          <li>
            <span>Quest #1 - Reach the Buoy</span>
            <strong>${state.quest1Completed ? "Completed" : "In progress / not yet attempted"}</strong>
          </li>
          <li>
            <span>Encounter in progress?</span>
            <strong>${state.encounter ? `Yes (phase: ${state.encounter.phase})` : "No"}</strong>
          </li>
        </ul>
      </section>

      <section class="campaign-card">
        <h3>Town Visits</h3>
        <ul class="campaign-list">
          <li>
            <span>Chapter 1 Town Visit</span>
            <strong>${townVisitStatus(state.townVisit1Completed, state.townVisit?.chapterId === "ch1", state.townVisit?.pageId)}</strong>
          </li>
          <li>
            <span>Chapter 2 Town Visit</span>
            <strong>${townVisitStatus(state.townVisit2Completed, state.townVisit?.chapterId === "ch2", state.townVisit?.pageId)}</strong>
          </li>
          <li>
            <span>Chapter 3 Town Visit</span>
            <strong>${townVisitStatus(state.townVisit3Completed, state.townVisit?.chapterId === "ch3", state.townVisit?.pageId)}</strong>
          </li>
        </ul>
        ${state.townDecisions.length > 0 ? `
          <details class="campaign-decisions">
            <summary class="small muted">${state.townDecisions.length} decision${state.townDecisions.length === 1 ? "" : "s"} recorded</summary>
            <ul class="campaign-decisions-list small">
              ${state.townDecisions.map((d) => `<li><code>${escapeHtml(d)}</code></li>`).join("")}
            </ul>
          </details>
        ` : ""}
      </section>

      <section class="campaign-card">
        <h3>Open quests</h3>
        ${openQuests.length === 0 ? `
          <p class="small muted">No open quests.</p>
        ` : `
          <div class="campaign-quest-grid">
            ${openQuests.map((q) => {
              const img = questImageOrNull(q.number);
              const art = img
                ? `<img class="campaign-quest-art" src="/quests/${img}" alt="Quest #${q.number} - ${escapeHtml(q.name)}" />`
                : `<div class="campaign-quest-art campaign-quest-art--placeholder">#${q.number}</div>`;
              return `
                <article class="campaign-quest-card">
                  ${art}
                  <div class="campaign-quest-card-label">
                    <strong>Quest #${String(q.number).padStart(2, "0")}</strong>
                    <span class="small muted">${escapeHtml(q.name)}</span>
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        `}
      </section>

      ${completedQuests.length > 0 ? `
        <section class="campaign-card">
          <h3>Completed quests</h3>
          <ul class="campaign-list">
            ${completedQuests.map((q) => `
              <li><span>Quest #${String(q.number).padStart(2, "0")}</span><strong>${escapeHtml(q.name)}</strong></li>
            `).join("")}
          </ul>
        </section>
      ` : ""}

      ${state.scenarioDeckTop.length > 0 ? `
        <section class="campaign-card">
          <h3>Top of the Scenario Deck</h3>
          <ul class="campaign-list">
            ${state.scenarioDeckTop.map((n) => {
              const card = scenarioCardOrNull(n);
              return `<li><span>${escapeHtml(card?.printedId ?? `#${n}`)}</span><strong>${escapeHtml(card?.name ?? "")}</strong></li>`;
            }).join("")}
          </ul>
        </section>
      ` : ""}

      <section class="campaign-card">
        <h3>Spawn Deck</h3>
        <button class="btn btn--small btn--ghost" data-action="view-spawn-deck">
          View Spawn Deck (${SPAWN_CARDS.length} cards)
        </button>
      </section>

      <section class="campaign-card">
        <h3>Key items</h3>
        ${state.keyItems.length === 0 ? `
          <p class="small muted">No key items collected yet.</p>
        ` : `
          <div class="campaign-keyitem-grid">
            ${state.keyItems.map((k) => {
              const img = keyItemImageOrNull(k.number);
              const art = img
                ? `<img class="campaign-keyitem-art" src="/key-items/${img}" alt="Key Item #${k.number} - ${escapeHtml(k.name)}" />`
                : `<div class="campaign-keyitem-art campaign-keyitem-art--placeholder">#${k.number}</div>`;
              return `
                <article class="campaign-keyitem-card">
                  ${art}
                  <div class="campaign-keyitem-card-label">
                    <strong>Key Item #${k.number}</strong>
                    <span class="small muted">${escapeHtml(k.name)}</span>
                  </div>
                </article>
              `;
            }).join("")}
          </div>
          <p class="small campaign-keyitem-clue-total">&#128270; ${totalKeyItemClues(state)} total clue icon${totalKeyItemClues(state) === 1 ? "" : "s"} &mdash; unlocks Shop Product #13 at 2+, #14 at 4+</p>
        `}
      </section>

      <!-- ROW 2: 1+1+1+2 = 5 -->
      <section class="campaign-card">
        <h3>Favour</h3>
        ${Object.keys(state.favour).length === 0 ? `
          <p class="small muted">No characters met yet.</p>
        ` : `
          <div class="campaign-favour-list">
            ${Object.entries(state.favour)
              .sort(([, a], [, b]) => b.value - a.value)
              .map(([id, f]) => {
                const variant = f.value > 0 ? "ally" : f.value < 0 ? "detractor" : "neutral";
                const signed = f.value > 0 ? `+${f.value}` : `${f.value}`;
                return `
                  <div class="campaign-favour-row campaign-favour-row--${variant}" data-character-id="${escapeHtml(id)}">
                    <div class="campaign-favour-avatar" aria-hidden="true">${escapeHtml(initialsOfCharacter(f.name))}</div>
                    <div class="campaign-favour-name">
                      <strong>${escapeHtml(f.name)}</strong>
                      <div class="small muted">${variant === "ally" ? "Ally opinion" : variant === "detractor" ? "Detractor opinion" : "Neutral"}</div>
                    </div>
                    <span class="campaign-favour-value campaign-favour-value--${variant}">${signed}</span>
                  </div>
                `;
              }).join("")}
          </div>
        `}
      </section>

      <section class="campaign-card">
        <h3>Shared resources</h3>
        <ul class="campaign-list">
          <li><span>XP on hand</span><strong>${state.xpOnHand}</strong></li>
          <li><span>Total XP gained (campaign)</span><strong>${state.totalXp}</strong></li>
          <li><span>Current Level</span><strong>${state.currentLevel}</strong></li>
          <li><span>XP to next level</span><strong>${xpCostForNextLevel(state.currentLevel)}</strong></li>
          <li><span>Memory chips collected</span><strong>${state.memoryChips}</strong></li>
          <li><span>Memory cards drawn</span><strong>${state.memoryCards.length}</strong></li>
        </ul>
      </section>

      <section class="campaign-card">
        <h3>Scars</h3>
        <div class="campaign-scars">
          ${HEROES.map((h) => {
            const hero = getHero(h.id);
            const suitLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
            const scarList: string[] = state.scars?.[h.id] ?? [];
            return `
              <div class="campaign-scars-delver">
                <span class="campaign-suit-delver-heading">${escapeHtml(suitLabel)}</span>
                ${scarList.length === 0
                  ? `<p class="small muted">No scars yet.</p>`
                  : `<div class="campaign-scars-list">
                      ${scarList.map((kw) => `<span class="campaign-scar-tag">${escapeHtml(kw)}</span>`).join("")}
                    </div>`
                }
              </div>
            `;
          }).join("")}
        </div>
      </section>

      ${(() => {
        const entries = state.graveyard ?? [];
        return `
        <section class="campaign-card campaign-card--span2">
          <h3>Graveyard</h3>
          ${entries.length === 0
            ? `<p class="small muted">No heroes lost yet.</p>`
            : `<div class="campaign-graveyard-list">
                ${entries.map((e) => {
                  let cardName = e.cardName;
                  try { cardName = getHeroCard(e.cardNumber).name; } catch { /* keep stored name */ }
                  let heroCard;
                  try { heroCard = getHeroCard(e.cardNumber); } catch { /* none */ }
                  const cardImage = heroCard ? `/cards/heroes/${heroCard.image}` : null;
                  return `
                    <div class="campaign-graveyard-entry">
                      ${cardImage ? `<img class="campaign-graveyard-art" src="${escapeHtml(cardImage)}" alt="${escapeHtml(cardName)}" draggable="false" />` : ""}
                      <div class="campaign-graveyard-body">
                        <div class="campaign-graveyard-name">${escapeHtml(cardName)}</div>
                        <div class="campaign-graveyard-meta small muted">Fell in ${escapeHtml(e.questId.replace("quest", "Quest #"))} Wave ${e.waveNumber}</div>
                        ${e.finalWords
                          ? `<blockquote class="campaign-graveyard-words">${escapeHtml(e.finalWords)}</blockquote>`
                          : `<p class="small muted campaign-graveyard-words--silent"><em>Left no final words.</em></p>`
                        }
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>`
          }
        </section>
        `;
      })()}

      <section class="campaign-card campaign-card--span2">
        <h3>Opinion cards earned</h3>        ${state.opinionCards.length === 0 ? `
          <p class="small muted">No opinion cards earned yet.</p>
        ` : `
          <div class="campaign-opinion-grid">
            ${state.opinionCards.map((o) => {
              const img = opinionCardImageOrNull(o.characterId, o.level);
              const levelLabel = o.level.charAt(0).toUpperCase() + o.level.slice(1);
              const art = img
                ? `<img class="campaign-opinion-art" src="/opinion-cards/${img}" alt="${escapeHtml(o.characterName)} - ${escapeHtml(levelLabel)} Opinion Card" />`
                : `<div class="campaign-opinion-art campaign-opinion-art--placeholder">
                     <div class="campaign-opinion-art-label">OPINION</div>
                     <div class="campaign-opinion-art-name">${escapeHtml(o.characterName)}</div>
                     <div class="campaign-opinion-art-level small">${escapeHtml(levelLabel.toUpperCase())}</div>
                   </div>`;
              const status = describeOpinionCardStatus(state, o.characterId, o.level);
              const statusHtml = status
                ? `<span class="campaign-opinion-status campaign-opinion-status--${status.tone}" title="${escapeHtml(status.tooltip)}">${escapeHtml(status.label)}</span>`
                : "";
              const cardCls = status?.tone === "spent"
                ? `campaign-opinion-card campaign-opinion-card--${o.level} campaign-opinion-card--spent`
                : `campaign-opinion-card campaign-opinion-card--${o.level}`;
              return `
                <article class="${cardCls}">
                  ${art}
                  <div class="campaign-opinion-card-label">
                    <strong>${escapeHtml(o.characterName)}</strong>
                    <span class="small muted">${escapeHtml(levelLabel)}</span>
                    ${statusHtml}
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        `}
      </section>

      <!-- ROW 3: 3+2 = 5 -->
      <section class="campaign-card campaign-card--span3">
        <h3>Shop products owned</h3>
        ${(() => {
          const anyOwned = HEROES.some((h) => (state.shopProductsOwned[h.id] ?? []).length > 0);
          if (!anyOwned && state.shopProductsAvailable.length === 0) {
            return `<p class="small muted">No shop products unlocked yet. Complete Chapter 1's Town Visit to add Products #1-7 to the shop.</p>`;
          }
          return `
            <table class="campaign-table">
              <thead>
                <tr>
                  <th>Delver</th>
                  <th>Products owned</th>
                </tr>
              </thead>
              <tbody>
                ${HEROES.map((h) => {
                  const owned = state.shopProductsOwned[h.id] ?? [];
                  const cells = owned.length === 0
                    ? `<span class="muted small">none</span>`
                    : `<div class="campaign-shop-grid">${owned.map((n) => {
                        const p = getShopProduct(n);
                        const img = shopProductImageOrNull(p.number);
                        const art = img
                          ? `<img class="campaign-shop-art" src="/shop-products/${img}" alt="Shop Product #${p.number} - ${escapeHtml(p.name)}" />`
                          : `<div class="campaign-shop-art campaign-shop-art--placeholder">#${p.number}</div>`;
                        return `
                          <article class="campaign-shop-card" title="${escapeHtml(p.effectText)}">
                            ${art}
                            <div class="campaign-shop-card-label">
                              <strong>#${p.number}</strong>
                              <span class="small muted">${escapeHtml(p.name)}</span>
                            </div>
                          </article>
                        `;
                      }).join("")}</div>`;
                  return `
                    <tr>
                      <td><strong>${escapeHtml(getHero(h.id).suit === "mind" ? "Mind" : "Body")}</strong></td>
                      <td>${cells}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
            ${state.shopProductsAvailable.length > 0 ? `
              <p class="small muted">${state.shopProductsAvailable.length} product${state.shopProductsAvailable.length === 1 ? "" : "s"} still for sale.</p>
            ` : ""}
          `;
        })()}
      </section>

      <section class="campaign-card campaign-card--span2">
        <h3>Per-delver inventory</h3>
        <table class="campaign-table">
          <thead>
            <tr>
              <th>Delver</th>
              <th>Hero</th>
              <th>Minion parts</th>
              <th>Boss parts (Lvl 1)</th>
            </tr>
          </thead>
          <tbody>
            ${HEROES.map((h) => {
              const hero = getHero(h.id);
              const suit = hero.suit;
              return `
                <tr>
                  <td><strong>${escapeHtml(suit === "mind" ? "Mind Delver" : "Body Delver")}</strong></td>
                  <td>${escapeHtml(hero.name)}</td>
                  <td>
                    <span class="campaign-count-cell">
                      ${partIcon(suit, "minion")}
                      <span class="campaign-count-num">${state.minionParts[h.id] ?? 0}</span>
                    </span>
                  </td>
                  <td>
                    <span class="campaign-count-cell" title="Lvl 1 Boss Parts">
                      ${partIcon(suit, "boss-lvl-1")}
                      <span class="campaign-count-num">${state.bossParts[h.id] ?? 0}</span>
                    </span>
                    <span class="campaign-count-cell" title="Lvl 2 Boss Parts">
                      ${partIcon(suit, "boss-lvl-2")}
                      <span class="campaign-count-num">${state.bossPartsLvl2[h.id] ?? 0}</span>
                    </span>
                    <span class="campaign-count-cell" title="Lvl 3 Boss Parts">
                      ${partIcon(suit, "boss-lvl-3")}
                      <span class="campaign-count-num">${state.bossPartsLvl3[h.id] ?? 0}</span>
                    </span>
                    <span class="campaign-count-cell" title="Lvl 4 Boss Parts">
                      ${partIcon(suit, "boss-lvl-4")}
                      <span class="campaign-count-num">${state.bossPartsLvl4[h.id] ?? 0}</span>
                    </span>
                    <span class="campaign-count-cell" title="Lvl 5 Boss Parts">
                      ${partIcon(suit, "boss-lvl-5")}
                      <span class="campaign-count-num">${state.bossPartsLvl5[h.id] ?? 0}</span>
                    </span>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </section>

      <!-- ROW 4: 2+3 = 5 -->
      <section class="campaign-card campaign-card--span2">
        <h3>Per-delver elements</h3>
        <table class="campaign-table">
          <thead>
            <tr>
              <th>Delver</th>
              ${ELEMENTS.map((e) => `<th class="campaign-element-th">${elementIcon(e.id)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${HEROES.map((h) => {
              const bag = state.elements[h.id] ?? {};
              return `
                <tr>
                  <td><strong>${escapeHtml(getHero(h.id).suit === "mind" ? "Mind" : "Body")}</strong></td>
                  ${ELEMENTS.map((e) => `<td>${bag[e.id] ?? 0}</td>`).join("")}
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </section>

      <section class="campaign-card campaign-card--span3">
        <h3>Per-delver loadout (live)</h3>
        <table class="campaign-table">
          <thead>
            <tr>
              <th>Delver</th>
              <th>HP</th>
              <th>AP</th>
              <th>Movement</th>
              <th>Slots filled</th>
            </tr>
          </thead>
          <tbody>
            ${HEROES.map((h) => {
              const lo = state.loadouts[h.id];
              if (!lo) return "";
              const filled = lo.slotCards.filter((c) => c !== null).length;
              return `
                <tr>
                  <td><strong>${escapeHtml(getHero(h.id).suit === "mind" ? "Mind" : "Body")}</strong></td>
                  <td>${lo.currentHp}/${lo.maxHp}</td>
                  <td>${lo.currentAp}/${lo.baseAp}</td>
                  <td>${lo.currentMovement} (base ${lo.baseMovement})</td>
                  <td>${filled}/${lo.slotCards.length}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </section>

      <!-- ROW 5: full -->
      <section class="campaign-card campaign-card--full">
        <h3>Suit Condition</h3>
        <div class="campaign-suit-condition">
          ${HEROES.map((h) => {
            const hero = getHero(h.id);
            const suitLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
            const parts = (Object.keys(SUIT_PART_EQUIPMENT_TYPES_BY_SUIT.mind) as SuitPart[]);
            const suitPartTypes = SUIT_PART_EQUIPMENT_TYPES_BY_SUIT[hero.suit];
            return `
              <div class="campaign-suit-delver">
                <h4 class="campaign-suit-delver-heading turn-${hero.suit}">${escapeHtml(suitLabel)}</h4>
                ${renderSuitConditionArt(state, h.id, hero.suit)}
                <table class="campaign-table campaign-suit-table">
                  <thead>
                    <tr>
                      <th>Suit Part</th>
                      <th>Equipment</th>
                      <th>Rank</th>
                      <th>Unlocked</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${parts.flatMap((part) =>
                      suitPartTypes[part].map((type, typeIdx) => {
                        const rank = getEffectiveEquipmentRank(state, h.id, type);
                        const unlockedCap = (state.unlockedForHigherRanks?.[h.id]?.[type] as number | undefined) ?? null;
                        const equipment = getEquipmentByTypeSuit(hero.suit, type);
                        const rankDisplay = rank === 0 ? `<span class="muted">—</span>` : `<strong>R${rank}</strong>`;
                        const unlockedDisplay = unlockedCap !== null
                          ? `<span class="campaign-suit-unlock" title="Can level up to R${unlockedCap}">R${unlockedCap} access</span>`
                          : `<span class="muted small">—</span>`;
                        return `
                          <tr>
                            ${typeIdx === 0 ? `<td rowspan="${suitPartTypes[part].length}" class="campaign-suit-part-cell"><strong>${escapeHtml(SUIT_PART_LABEL[part])}</strong></td>` : ""}
                            <td class="small">${escapeHtml(equipment.name)}</td>
                            <td>${rankDisplay}</td>
                            <td>${unlockedDisplay}</td>
                          </tr>
                        `;
                      })
                    ).join("")}
                  </tbody>
                </table>
              </div>
            `;
          }).join("")}
        </div>
      </section>

      <!-- ROW 6: full -->
      <section class="campaign-card campaign-card--full">
        <h3>Starting Equipment Loadouts</h3>
        <div class="campaign-loadouts">
          ${HEROES.map((h) => {
            const hero = getHero(h.id);
            const suitLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
            const heroLoadouts: Array<Array<{ type: EquipmentType; rank: number } | null>> =
              state.suitLoadouts?.[h.id] ?? [[null, null, null], [null, null, null], [null, null, null]];
            return `
              <div class="campaign-loadouts-delver">
                <div class="campaign-suit-delver-heading">${escapeHtml(suitLabel)}</div>
                <div class="campaign-loadouts-grid">
                  ${heroLoadouts.map((slots, idx) => {
                    return `
                      <div class="campaign-loadout-card">
                        <div class="campaign-loadout-header">
                          <span class="campaign-loadout-title">Loadout ${idx + 1}</span>
                        </div>
                        <div class="campaign-loadout-slots">
                          ${slots.map((slot) => {
                            if (slot === null) {
                              return `
                                <div class="campaign-loadout-slot campaign-loadout-slot-empty">
                                  <span class="campaign-loadout-slot-name small muted">Empty</span>
                                  <span class="campaign-loadout-slot-rank muted">—</span>
                                </div>
                              `;
                            }
                            const equipment = getEquipmentByTypeSuit(hero.suit, slot.type);
                            return `
                              <div class="campaign-loadout-slot">
                                <span class="campaign-loadout-slot-name small">${escapeHtml(equipment.name)}</span>
                                <span class="campaign-loadout-slot-rank">+${slot.rank}</span>
                              </div>
                            `;
                          }).join("")}
                        </div>
                      </div>
                    `;
                  }).join("")}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </section>
    </div>
  `;
  root.appendChild(wrap);

  wrap.querySelector<HTMLButtonElement>("[data-action=back]")!
    .addEventListener("click", () => router.goTo({ name: "title" }));

  const dec = wrap.querySelector<HTMLButtonElement>("[data-action=dec-levelup]");
  if (dec) {
    dec.addEventListener("click", () => {
      if (router.state.levelUpCardsOwed > 0) {
        router.state.levelUpCardsOwed -= 1;
        router.save();
      }
    });
  }

  // "SEE EQUIPMENT" buttons under each hero card -- open the
  // EquipmentCardsModal scoped to that hero card's starting
  // loadout. Works for both locked and unlocked cards (the card
  // catalog itself is global; locked just means the player
  // doesn't OWN it yet, but the data is still browsable).
  for (const btn of wrap.querySelectorAll<HTMLButtonElement>("[data-action=see-equipment]")) {
    btn.addEventListener("click", () => {
      const num = Number(btn.dataset["cardNumber"]);
      if (!Number.isFinite(num)) return;
      void presentEquipmentCards(document.body, { heroCardNumber: num });
    });
  }

  const viewSpawnDeck = wrap.querySelector<HTMLButtonElement>("[data-action=view-spawn-deck]");
  if (viewSpawnDeck) {
    viewSpawnDeck.addEventListener("click", () => {
      // Fire-and-forget — `presentSpawnDeck` returns a promise that
      // resolves on dismiss but we don't need to await it; the
      // overlay self-cleans and the underlying screen is unchanged
      // by the viewer (it's read-only).
      void presentSpawnDeck(wrap);
    });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Status pill for an Opinion Card on the Campaign Sheet: what the card
 * is doing right now (Nov 15 card rules).
 *   - `passive`  ongoing effect (shop prices, quest start, limits...).
 *   - `active`   a one-shot that is armed / waiting to fire on its own.
 *   - `ready`    a one-shot the player redeems (says where).
 *   - `spent`    redeemed / discarded.
 *   - `pending`  printed effect the prototype doesn't run yet.
 */
function describeOpinionCardStatus(
  state: import("../state").CampaignState,
  characterId: string,
  level: "nemesis" | "detractor" | "ally" | "confidant",
): { label: string; tone: "passive" | "active" | "spent" | "pending" | "ready"; tooltip: string } | null {
  const spent = state.opinionCardsSpent.includes(`${characterId}-${level}`);
  const passive = (tooltip: string) => ({ label: "Ongoing", tone: "passive" as const, tooltip });
  const ready = (where: string, tooltip: string) => spent
    ? { label: "Spent", tone: "spent" as const, tooltip: "Already redeemed - the card is discarded." }
    : { label: `Ready to redeem (${where})`, tone: "ready" as const, tooltip };
  const key = `${characterId}-${level}`;
  switch (key) {
    case "xavier-ally": case "xavier-confidant": case "xavier-detractor": case "xavier-nemesis":
      return { label: "Quest-start passive", tone: "passive", tooltip: "Applies at the start of every quest while you hold this card (Opinion-Card Rank Pick)." };
    case "samantha-ally": case "samantha-confidant":
      return spent
        ? { label: "Spent", tone: "spent", tooltip: "Samantha already stopped one opinion loss." }
        : { label: "Waiting to shield", tone: "active", tooltip: "Popular: the next time you would lose Opinion with someone, you don't. Fires automatically." };
    case "samantha-detractor":
      return spent ? { label: "Resolved", tone: "spent", tooltip: "You paid Samantha." } : passive("The next Machinist product is unpurchasable until you pay Samantha 1 Lvl 1 Boss Part (Shop).");
    case "samantha-nemesis": return passive("Shop Products from the Machinist are unpurchasable.");
    case "flores-ally":
      if (state.floresDiscountArmed) return { label: "Armed", tone: "active", tooltip: "The next shop purchase costs one fewer boss part." };
      return ready("Shop", "Remove 1 boss part cost from any 1 Shop Product.");
    case "flores-confidant": return passive("You may spend minion parts in place of boss parts (3 minion parts per boss level) - applied automatically when you buy.");
    case "flores-detractor": return passive("Shop Products from the Equipment Market cost 1 more minion part.");
    case "flores-nemesis": return passive("Shop Products from the Equipment Market cost 2 more minion parts.");
    case "ira-ally":
      if (state.iraDiscountActive) return { label: "Active this visit", tone: "active", tooltip: "All Shop Products cost 1 less minion part this town visit." };
      return ready("Shop", "This town visit, all Shop Products cost 1 less minion part.");
    case "ira-confidant": return passive("All Shop Products cost 1 less minion part.");
    case "ira-detractor": return passive("All Shop Products cost 1 more minion part.");
    case "ira-nemesis": return passive("All Shop Products cost 2 more minion parts.");
    case "elayne-ally": case "elayne-confidant":
      return ready("BoardScreen", "Med Kit: use the Med Kit button in the BoardScreen top bar during a wave to heal both delvers to full.");
    case "elayne-detractor": return passive("At the end of each wave (when continuing to the next), each delver loses 2 elements.");
    case "elayne-nemesis": return passive("At the end of each wave (when continuing to the next), delvers lose all elements.");
    case "rodrigo-ally": case "rodrigo-confidant":
      return ready("BoardScreen", "Elemental Kit: use the Elemental Kit button in the BoardScreen top bar during a wave to refresh every spent consumable token.");
    case "rodrigo-detractor": return passive("At the end of each wave (when continuing to the next), lose 2 XP on hand.");
    case "rodrigo-nemesis": return passive("At the end of each wave (when continuing to the next), lose all XP on hand.");
    case "vera-ally": return ready("Shop", "Gift: open the Shop during a town visit to choose a delver who gains a Level 2 Boss Part.");
    case "arlen-ally":
      return spent ? { label: "Spent", tone: "spent", tooltip: "Used on a donation resolution." }
        : { label: "Next donation", tone: "active", tooltip: "Connected: the next Academy donation resolves at its best result, regardless of the amount donated." };
    case "arlen-confidant": return passive("Academy donations always resolve at their best result, regardless of the amount donated.");
    case "arlen-detractor": return passive("You can't hold more than two Ally/Confidant cards at a time.");
    case "arlen-nemesis": return passive("You can't hold more than one Ally/Confidant card at a time.");
    case "dahlia-ally": return passive("Delvers start quests with 1 consumable token of their choice (pick in the Shop).");
    case "dahlia-confidant": return passive("Both delvers start quests with 1 Universal 2x Damage and 1 Block Counterattack token.");
    case "dahlia-detractor": return passive("Every wave has at least 1 Lieutenant: if the spawn has none, one is added next to the boss, matching its level.");
    case "dahlia-nemesis": return passive("Every wave has at least 2 Lieutenants: missing ones are added next to the boss, matching its level.");
    case "elias-ally": case "elias-confidant":
      return ready("Shop", "Spend 3 minion parts to gain 1 Memory Chip token.");
    case "elias-detractor": return { label: "Resolved", tone: "spent", tooltip: "You lost 1 Memory Chip token on hand (if you had one)." };
    case "elias-nemesis": return passive("You cannot gain new Memory Chip tokens.");
  }
  return null;
}

/** Avatar initials for a character row — "Vera Brass" -> "VB",
 * "Xavier" -> "X". Two-char cap so the disc never overflows.
 * Mirrors the helper in `RewardsModal.ts`; kept duplicated to
 * avoid a screen->screen import (both are very thin formatters). */
function initialsOfCharacter(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * "Completed" / "In progress (page X)" / "Not started" — three-way
 * status for a chapter's Town Visit row. Completed wins over an
 * in-progress visit so the rare case of starting a fresh Q1 retry
 * after the visit (which leaves `townVisit === null` AND `Completed
 * === true`) shows as Completed rather than Not started.
 */
function townVisitStatus(completed: boolean, isThisChapter: boolean, pageId: string | undefined): string {
  if (completed) return "Completed";
  if (isThisChapter && pageId) return `In progress (${pageId})`;
  return "Not started";
}

