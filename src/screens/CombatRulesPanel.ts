/**
 * The player aid ("Delver Phase" combat reference) shown beside the
 * hand: on the BoardScreen during the Delver Phase and on the
 * FirstTurnPick screen before the wave's first turn.
 */

/**
 * Which cheatsheet "next step" lines should be highlighted right now.
 *   - `placeWeapon` = "At the start of each turn, choose a weapon card..."
 *   - `useWeapon`   = "Tap your weapon card for the weapon or slot ability."
 *   - `moveDelver`  = "Tap your delver token to move."
 *
 * Multiple flags can be true at once (e.g. after a placement, both
 * `useWeapon` and `moveDelver` glow until the player commits one of
 * them). Computed in `renderBoardScreen` from the active delver's
 * `HeroTurnState` so the cheatsheet stays in lockstep with the rest
 * of the action overlays.
 */
export interface CheatsheetActive {
  placeWeapon: boolean;
  useWeapon: boolean;
  moveDelver: boolean;
}

/**
 * "Rules of combat" cheat sheet that fills the empty space to the
 * LEFT of the hand of equipment cards (in `.board-bottom-row`, which
 * sits beneath the suit board). Reactive: each "next step" line gets
 * a green pulsing highlight when the active delver still has that
 * step to take this turn (see {@link CheatsheetActive}).
 *
 * The sections are laid out as a vertical stack inside the panel
 * since this slot is taller-than-wide.
 */
export function renderCombatRulesPanel(active: CheatsheetActive): string {
  const cls = (on: boolean) => on ? "cheatsheet-step--active" : "";
  return `
    <div class="combat-rules-stack" aria-label="Combat reference">
      <div class="combat-rules-panel">
        <h3 class="combat-rules-title">Delver Phase</h3>
        <div class="combat-rules-grid">
          <section class="combat-rules-section">
            <h4>Each turn</h4>
            <ul>
              <li class="${cls(active.placeWeapon)}">Each turn, choose a <strong>weapon card</strong> to exhaust and where to exhaust it.</li>
              <li>A turn = one <strong>movement</strong> + one <strong>action</strong>, in any order.</li>
            </ul>
          </section>

          <section class="combat-rules-section">
            <h4>Your turn</h4>
            <ul>
              <li class="${cls(active.useWeapon)}">Action: tap your <strong>weapon card</strong> for the weapon or slot ability.</li>
              <li class="${cls(active.moveDelver)}">Move: tap your <strong>delver token</strong> to move.</li>
              <li>You may spend <strong>consumable tokens</strong> any time during your turn.</li>
            </ul>
          </section>

          <section class="combat-rules-section">
            <h4>Counterattacks</h4>
            <p class="small muted">Targeted enemies roll a die:</p>
            <ul class="combat-rules-die-list">
              <li><span class="die-pill die-pill--miss">1</span><span>They miss.</span></li>
              <li><span class="die-pill die-pill--white">2&ndash;5</span><span><strong>White arrows</strong> counterattack.</span></li>
              <li><span class="die-pill die-pill--black">6</span><span><strong>Black arrows</strong> counterattack.</span></li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  `;
}
