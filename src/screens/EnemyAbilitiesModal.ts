/**
 * Enemy Abilities reference modal — a read-only popup that lists
 * the rule blurbs for every passive enemy ability KIND present in
 * the current wave (Fatal Flaw / Rotates / Primordial / Teleports).
 * No per-enemy roster: the printed card art on the board already
 * tells the player WHICH enemies have which ability, so this modal
 * just answers "what does that ability actually do?".
 *
 * Triggered from the "ENEMY ABILITIES" button in the top-left of
 * the board topbar (BoardScreen, DelverSpawnPick, WavePhases).
 * Always available while there's a live encounter so the player
 * can sanity-check "wait, what does Fatal Flaw do again?" without
 * leaving the board.
 *
 * Lifecycle mirrors `HeroCardsModal`: `presentEnemyAbilities`
 * mounts the overlay and returns a Promise that resolves on
 * dismiss. Dismissal paths:
 *   - Click the backdrop (anywhere outside the modal body).
 *   - Click the Close button in the footer.
 *   - Press Escape / Enter / Space on the keyboard.
 *   - Host element unmounts (router navigates away mid-modal).
 *
 * The overlay self-cleans on every dismissal path so callers
 * don't have to teardown.
 */

import type { EncounterState } from "../state";
import { getEnemy } from "../data";
import type { EnemyAbility } from "../types";
import { logEvent } from "../debug/sessionLog";

/**
 * True iff at least one enemy in the current encounter carries
 * a printed passive ability (Fatal Flaw, Rotates, Primordial,
 * Teleports, ...). Drives whether the "Enemy Abilities" topbar
 * button is rendered at all — Quest #1 enemies have no
 * abilities, so the button would open a modal whose only
 * content is the "no enemies in this wave have a passive
 * ability" empty-state, which is more confusing than useful.
 * Hiding the button entirely in that case keeps the HUD clean.
 *
 * Defensive: skips enemy instances whose `cardId` isn't in
 * `data/enemies.json` (matches the same try/catch pattern used
 * inside `presentEnemyAbilities` itself) so a hand-edited save
 * can't crash the topbar render.
 *
 * Used by `BoardScreen`, `DelverSpawnPick`, and the two
 * `WavePhases` variants (parting-shots + end-of-wave) that mount
 * the topbar with the button.
 */
export function waveHasAnyEnemyAbilities(enc: EncounterState): boolean {
  for (const inst of enc.enemies) {
    try {
      const card = getEnemy(inst.cardId);
      if (card.abilities.length > 0) return true;
    } catch {
      // Same skip pattern as `presentEnemyAbilities` — unknown
      // card id is logged + skipped, not crashed.
    }
  }
  return false;
}

export function presentEnemyAbilities(
  host: HTMLElement,
  enc: EncounterState,
  waveLabel: string,
): Promise<void> {
  return new Promise((resolve) => {
    // Collect the unique set of ability KINDS that appear on any
    // enemy in the wave. We only care about the kind (not the
    // per-enemy parameters), so a Set keeps duplicates collapsed
    // — 7 Venenas with Fatal Flaw still produce ONE "Fatal Flaw"
    // blurb in the cheat-sheet.
    const presentAbilityKinds = new Set<EnemyAbility["kind"]>();
    for (const inst of enc.enemies) {
      // Defensive: a hand-edited save with a card id missing from
      // `data/enemies.json` would otherwise blow up the modal
      // mid-render. Skip silently + log so we surface it in the
      // audit trail rather than crashing the player out of the
      // board.
      try {
        const card = getEnemy(inst.cardId);
        for (const ab of card.abilities) presentAbilityKinds.add(ab.kind);
      } catch {
        logEvent("enemyAbilitiesModal.skipUnknownCard", { cardId: inst.cardId });
      }
    }

    logEvent("enemyAbilitiesModal.open", {
      waveLabel,
      enemyCount: enc.enemies.length,
      aliveCount: enc.enemies.filter((e) => e.alive).length,
      presentAbilities: Array.from(presentAbilityKinds),
    });

    const overlay = document.createElement("div");
    overlay.className = "rewards-modal enemy-abilities-modal";
    overlay.innerHTML = `
      <div class="rewards-modal-backdrop" data-eam-backdrop></div>
      <div class="rewards-modal-body" role="dialog" aria-modal="true" aria-labelledby="eam-title">
        <h3 class="rewards-modal-title" id="eam-title">Enemy Abilities &middot; ${escapeHtml(waveLabel)}</h3>
        ${renderRuleCheatsheetHtml(presentAbilityKinds)}
        <div class="rewards-modal-footer">
          <button class="btn btn--primary" data-eam-close>Close</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);

    let resolved = false;
    const dismiss = (reason: "backdrop" | "button" | "escape" | "unmount"): void => {
      if (resolved) return;
      resolved = true;
      logEvent("enemyAbilitiesModal.close", { reason });
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
      resolve();
    };
    const onKeydown = (ev: KeyboardEvent): void => {
      if (!overlay.isConnected) {
        dismiss("unmount");
        return;
      }
      if (ev.key === "Escape" || ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        dismiss("escape");
      }
    };

    overlay.querySelector<HTMLDivElement>("[data-eam-backdrop]")!
      .addEventListener("click", () => dismiss("backdrop"));
    overlay.querySelector<HTMLButtonElement>("[data-eam-close]")!
      .addEventListener("click", () => dismiss("button"));
    document.addEventListener("keydown", onKeydown);
  });
}

/**
 * Authored rule text for each enemy ability KIND, taken verbatim
 * from the game materials (rulebook / quest narrative pages).
 *
 * Hard rule: only kinds with a string in this table get a blurb
 * in the UI. If an ability ships in the engine before its rule
 * text is authored, the cheat-sheet OMITS it (and we log a
 * `missingRuleText` breadcrumb so dev sees the gap) rather than
 * fabricating a description — per the project requirement that
 * UI rule text always come from the source materials, never from
 * the implementer's own paraphrase.
 *
 * To add a new ability rule text:
 *   1. Find the printed string in the rulebook / narrative pages
 *      under `data/quest*.json`.
 *   2. Drop it in as `{ label, text }` keyed by `EnemyAbility["kind"]`.
 *
 * The `label` is the short anchor shown in bold at the start of
 * the bullet (e.g. "Fatal Flaw: N"); `text` is the full
 * description rendered after the em-dash.
 */
const ABILITY_RULE_TEXT: Record<EnemyAbility["kind"], { label: string; text: string }> = {
  "fatal-flaw": {
    label: "Fatal Flaw",
    text: 'These enemies can only be killed in the order specified next to this ability. For example, the enemies with the label "Fatal Flaw: 1" must be killed first, then the enemies with "Fatal Flaw: 2". Enemies with sequential numbers can be killed at the same time. They can still suffer damage in any order - only the final point of damage remains.',
  },
  "rotates": {
    label: "Rotates",
    text: "These enemies rotate their card 90 degrees clockwise after attempting to counterattack.",
  },
  "primordial": {
    label: "Primordial",
    text: "These enemies can only be damaged by weapons exhausted into one of their two Primordial slots. The slot does not need to carry an element token at swing time - only the slot's printed element matters.",
  },
  "teleports": {
    label: "Teleports",
    text: "After this enemy attempts to counterattack, it swaps positions with the nearest living enemy on the board.",
  },
  // Ch3 Quest #06 (storybook "Second Nest / Storm Nest Ruins" pages).
  "strength": {
    label: "Strength",
    text: "Each time the enemy counterattacks, afterwards add a monster token to its tile. Add its count of monster tokens to its damage.",
  },
  "stout": {
    label: "Stout",
    text: "This boss cannot suffer more than 8 damage from a single attack.",
  },
  // Ch3 Quest #03 (storybook "Xavier's Request" pages).
  "flees": {
    label: "Flees",
    text: "After attempting to counterattack, if the enemy isn't dead, they move 2 tiles away from the attacking delver if possible. (The prototype moves each one to the free tile farthest from the attacker.)",
  },
  "soothsayer": {
    label: "Soothsayer",
    text: "This boss kills both delvers if not defeated by the end of the wave.",
  },
  "synchronized": {
    label: "Synchronized",
    text: "When damaged, afterwards it and all enemies connected to it in a chain deal a counterattack.",
  },
  "all-claw": {
    label: "All-Claw",
    text: "When the counterattack die is rolled, on a roll of 1 it counterattacks with both white and black arrows.",
  },
  "death-heal": {
    label: "Death Heal",
    text: "When this enemy dies, it heals all damage on all adjacent enemies, unless they also just died.",
  },
  // Ch3 Quest #03 Wave 4 / Quest #06 Waves 3-4 / the Gaia wave.
  "immunity": {
    label: "Immunity",
    text: "Each enemy is immune to one damage type: light, medium or heavy damage, as specified on their card.",
  },
  "guards": {
    label: "Guards",
    text: "On spawn, these enemies start with the specified number of monster tokens. They suffer no damage while they have any monster tokens. Each attack removes 1 monster token. Weapon cards with multiple attacks remove multiple monster tokens.",
  },
  "accurate": {
    label: "Accurate",
    text: "After attempting to counterattack, this boss applies a monster token to the attacking delver's Delversuit board. If a delver with a monster token on their board attacks this boss, its counterattack always hits. Only one delver can have the token at a time, so if the other delver attacks it, the token moves to them.",
  },
  "countdown": {
    label: "Countdown",
    text: "Each time this enemy is attacked, add 1 monster token to a countdown pile. If the pile has 4 or more tokens, return them all and every enemy with this ability attempts to counterattack, in addition to normal counterattacks. (The prototype resolves these extra counterattacks with the same die roll as the attack's own counterattack.)",
  },
  "tough": {
    label: "Tough",
    text: "Damage from delver attacks to these enemies rounds down to the nearest 5.",
  },
  // Ch3 Quest #05 "The Rogue Delver".
  "vicious": {
    label: "Vicious",
    text: "On spawn, starts with a monster token. Whenever an adjacent delver suffers damage, remove the monster token. While it has a monster token, attacks deal a maximum of 1 damage to it.",
  },
  "alert": {
    label: "Alert",
    text: "After attempting to counterattack, rotate its card so the side with the Alert icon faces the attacking delver. (If it must be at an angle, the prototype turns it the shorter way.)",
  },
  "critical": {
    label: "Critical",
    text: "When rolling a counterattack die, if you roll a 5, the white arrows deal double damage.",
  },
  "frenzy": {
    label: "Frenzy",
    text: "If this enemy is overkilled (more damage is dealt than is needed to kill it), afterwards all enemies with this ability attempt to counterattack. (The prototype resolves these extra counterattacks with the same die roll as the attack's own counterattack.)",
  },
  // Ch4 Story Quest "Assault on Bird's Nest".
  "omen": {
    label: "Omen",
    text: "When a hero is damaged by an enemy with this ability, afterwards, place a monster token on their Delversuit board. Each time they take damage from now on, they take 1 extra damage for each monster token they have for the remainder of the Wave. Clear these monster tokens at the end of the Wave.",
  },
  // Ch4 Quests #4 / #7 / #13.
  "backup": {
    label: "Backup",
    text: "When this boss is damaged by a weapon card, 2 additional enemies also attempt to counterattack. (The prototype picks the 2 living enemies nearest the attacker.)",
  },
  "evasive": {
    label: "Evasive",
    text: "These enemies suffer half damage, rounding up, unless both delvers are adjacent to it.",
  },
  "hardy": {
    label: "Hardy",
    text: "This boss can only be reduced to 0 HP by an attack that also targets two or more other enemies.",
  },
  "steals": {
    label: "Steals",
    text: "After this boss is damaged by a weapon card, it steals it - while stolen, it cannot be used. Reclaim it by killing the boss or damaging it with a different weapon (the previous weapon returns and the new one is stolen). Returned weapons are exhausted. If the boss is removed from play, the stolen weapon is returned.",
  },
  "spiked": {
    label: "Spiked",
    text: "Deals 3 damage back each time it suffers 8 or more damage from a weapon card. It still attempts to counterattack like normal.",
  },
  "invulnerable": {
    label: "Invulnerable",
    text: "Starts without a monster token. After being damaged by an attack, place a monster token on it. While it has the token, the next delver attack deals no damage - then remove the token.",
  },
  "last-act": {
    label: "Last Act",
    text: "When this boss dies, the delver that slayed it suffers 4 damage.",
  },
  "ritual": {
    label: "Ritual",
    text: "After damaging this boss with a weapon card, choose one equipment to sacrifice and take its lower rank. A sacrificed Rank 1 card can't be used. When the boss is slain or removed from play, you get all of your sacrificed equipment back.",
  },
  "double-edged": {
    label: "Double Edged",
    text: "This boss deals and suffers double damage when its black arrow is targeting a delver (a delver stands on one of its black-arrow tiles).",
  },
  "soul-sap": {
    label: "Soul Sap",
    text: "When this boss deals damage to a delver, they must also exhaust a consumable token if possible.",
  },
  "brawler": {
    label: "Brawler",
    text: "This boss suffers half damage from melee attacks (the prototype treats an attack made while standing next to it as melee; rounds up).",
  },
  "corruption": {
    label: "Corruption",
    text: "If the boss successfully targets a delver, place a monster token on that delver's board and the boss. At the end of each turn, that delver suffers 1 damage until the boss is killed. Only one corruption can be active at a time - new corruptions replace old ones.",
  },
  "shell": {
    label: "Shell",
    text: "When this enemy attempts to counterattack and misses, afterwards add a monster token to its tile. While it has a monster token, it is invulnerable to damage. On a turn where it doesn't miss a counterattack, remove the token.",
  },
  "rebirth": {
    label: "Rebirth",
    text: "When the enemy dies, place 3 monster tokens on its tile. After each hero turn where no enemies died, remove 1 monster token from all tiles. Once a tile has its last monster token removed, respawn one of these dead enemies on this tile with 50% health. (If the tile is occupied, the prototype waits until it is clear.)",
  },
};

/** Short display name of an enemy ability ("Tough", "Rotates", ...).
 *  Shared with the board's ability-proc labels. */
export function enemyAbilityLabel(kind: EnemyAbility["kind"]): string {
  return ABILITY_RULE_TEXT[kind].label;
}


/**
 * Render one bullet per ability KIND present in the wave for
 * which we have an authored rule string. Kinds without an
 * authored string are skipped + logged. If after filtering
 * nothing remains, the modal shows an explicit empty state
 * instead of a blank panel.
 */
function renderRuleCheatsheetHtml(kinds: ReadonlySet<EnemyAbility["kind"]>): string {
  const blurbs: string[] = [];
  for (const k of kinds) {
    const entry = ABILITY_RULE_TEXT[k];
    if (!entry) {
      logEvent("enemyAbilitiesModal.missingRuleText", { kind: k });
      continue;
    }
    blurbs.push(
      `<li><strong>${escapeHtml(entry.label)}</strong> - ${escapeHtml(entry.text)}</li>`,
    );
  }
  if (blurbs.length === 0) {
    return `
      <p class="enemy-abilities-empty muted">
        No enemies in this wave have a passive ability printed on
        their card. Watch for parting shots when they die.
      </p>
    `;
  }
  return `
    <div class="enemy-abilities-cheatsheet">
      <h4 class="enemy-abilities-cheatsheet-title">Rules in this wave</h4>
      <ul class="enemy-abilities-cheatsheet-list">${blurbs.join("")}</ul>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
