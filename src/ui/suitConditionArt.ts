/**
 * The printed Suit Condition sheet (Game Materials, Nov 17) rendered
 * as live UI: each equipment type's R4 / R5 dot is filled once that
 * rank is unlocked (`unlockedForHigherRanks`). The art prints R1-R3
 * filled and R4-R5 hollow, matching "the highest rank the delver has
 * access to".
 *
 * Used by the Campaign Sheet (read-only) and by the Suit Condition
 * rank-unlock modal (boss-card backs), where eligible types become
 * clickable hotspots over their printed rows and the selected type
 * shows a pulsing preview dot for the rank it would unlock.
 *
 * Coordinates are the centre of each type's FIRST rank dot, measured
 * in the source image's pixels; dots are `DOT_PITCH` px apart.
 */

import type { CampaignState } from "../state";
import type { EquipmentType } from "../types";

const SUIT_CONDITION_ART: Record<"mind" | "body", {
  src: string;
  w: number;
  h: number;
  firstDot: Record<EquipmentType, [number, number]>;
}> = {
  body: {
    src: "/suits/suit-condition-body.jpg", w: 1569, h: 1488,
    firstDot: {
      Gauntlet: [1335, 412], Hammer: [1335, 538], Trident: [1335, 668],
      OS: [225, 538], Beam: [225, 668],
      Sword: [225, 1015], Mace: [225, 1144], Shield: [225, 1274],
      Armor: [1335, 999], Supercharger: [1335, 1129], Battery: [1335, 1258],
      Shockwave: [419, 1432], Harvester: [781, 1432], Boots: [1146, 1432],
    },
  },
  mind: {
    src: "/suits/suit-condition-mind.jpg", w: 1565, h: 1487,
    firstDot: {
      Sword: [1330, 463], Mace: [1330, 592], Shield: [1330, 722],
      OS: [224, 540], Beam: [224, 669],
      Gauntlet: [224, 1014], Hammer: [224, 1144], Trident: [224, 1273],
      Armor: [1330, 999], Supercharger: [1330, 1128], Battery: [1330, 1257],
      Shockwave: [417, 1430], Harvester: [778, 1430], Boots: [1141, 1430],
    },
  },
};
const DOT_PITCH = 30.5;
/** Printed row box (name plate + RANK dots) relative to the first dot, in source px. */
const ROW_BOX = { dx: -172, dy: -96, w: 345, h: 120 };
const BASE_CAP = 3;

export interface SuitConditionArtOptions {
  /** Types rendered as clickable hotspots (`data-suit-pick-type`). */
  pickable?: readonly EquipmentType[];
  /** Selected type — its row is highlighted and the next rank dot(s) preview. */
  selected?: EquipmentType | null;
  /** Rank cap the selected type reaches after the pick (preview dots up to this). */
  selectedAfter?: number;
}

const pct = (v: number, of: number): string => `${(v / of * 100).toFixed(2)}%`;

export function renderSuitConditionArt(
  state: CampaignState,
  heroId: string,
  suit: "mind" | "body",
  opts: SuitConditionArtOptions = {},
): string {
  const art = SUIT_CONDITION_ART[suit];
  const entries = Object.entries(art.firstDot) as [EquipmentType, [number, number]][];
  const dots = entries.flatMap(([type, [x, y]]) => {
    const cap = state.unlockedForHigherRanks?.[heroId]?.[type] ?? BASE_CAP;
    const previewTo = opts.selected === type ? (opts.selectedAfter ?? cap) : cap;
    const out: string[] = [];
    for (let rank = BASE_CAP + 1; rank <= previewTo; rank++) {
      const preview = rank > cap;
      out.push(`<span class="suit-condition-art-dot${preview ? " suit-condition-art-dot--preview" : ""}"
        title="${type} R${rank} ${preview ? "(this unlock)" : "unlocked"}"
        style="left:${pct(x + (rank - 1) * DOT_PITCH, art.w)};top:${pct(y, art.h)}"></span>`);
    }
    return out;
  }).join("");
  const hotspots = entries
    .filter(([type]) => opts.pickable?.includes(type))
    .map(([type, [x, y]]) => {
      const cap = state.unlockedForHigherRanks?.[heroId]?.[type] ?? BASE_CAP;
      const selected = opts.selected === type;
      return `<button class="suit-condition-art-hotspot${selected ? " suit-condition-art-hotspot--selected" : ""}"
        data-suit-pick-type="${type}" title="${type}: max R${cap} → R${cap + 1}"
        style="left:${pct(x + ROW_BOX.dx, art.w)};top:${pct(y + ROW_BOX.dy, art.h)};width:${pct(ROW_BOX.w, art.w)};height:${pct(ROW_BOX.h, art.h)}"></button>`;
    }).join("");
  return `
    <div class="suit-condition-art${hotspots ? " suit-condition-art--pickable" : ""}" style="aspect-ratio:${art.w} / ${art.h}">
      <img src="${art.src}" alt="${suit === "mind" ? "Mind" : "Body"} Delver Suit Condition sheet" draggable="false" />
      ${dots}
      ${hotspots}
    </div>
  `;
}
