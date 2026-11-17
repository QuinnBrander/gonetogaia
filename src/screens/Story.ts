/**
 * Story screen — narrative beats from the Rising Tide Book.
 *
 * Page sequence on a fresh quest entry:
 *   1..N. One page per `quest1.intro[]` entry (Master Bram on the
 *         cliff edge — split at narrative beats so each page fits the
 *         viewport without scrolling).
 *   N+1.  Wave 1 intro (descent into the Tide — `quest1.pages.wave1_intro`).
 *
 * The user advances one page at a time with "Next →"; on the last page
 * the button reads "Descend into the Tide →" and routes to the Board.
 * Advancing never sets quest state — the encounter is bootstrapped on
 * entering the Board, not here.
 *
 * Page navigation IS NOT a `router.refresh()`. We mutate the title /
 * body / progress / button INSIDE the existing `wrap` so the ambient
 * particle canvas (and its rAF loop) survive across page-turns and
 * the drift looks visually continuous instead of restarting on every
 * Next click. Only a true screen change (-> board) discards the wrap.
 *
 * Typewriter reveal: shared with TownVisit.ts and WavePhases.ts via
 * `screens/typewriter.ts` (extracted 2026-05-09 so all narrative
 * screens have identical reveal pacing + skip-first semantics).
 * Clicking the Next button (or the body of the page) while typing is
 * in progress completes the reveal instantly; a subsequent Next click
 * then advances pages.
 *
 * Rendered between Title's "Begin Quest" button and BoardScreen.
 */

import type { Router } from "../main";
import { getQuestData } from "../data";
import { startStoryParticles, type StoryParticles } from "./storyParticles";
import {
  formatNarrativeWithTypewriterSpans,
  getActiveTypewriter,
  startTypewriter,
  stopActiveTypewriter,
  wireSkipOnClick,
} from "./typewriter";

interface StoryPage {
  key: string;
  title: string;
  text: string;
  /** Optional portrait shown to the right of the text card. Path is
   * served from `/public` (e.g. `/story/bram.png`). Pages without an
   * image render with a centered, single-column text card as before. */
  image?: string;
  /** Optional "ENEMY ABILITIES" rules block rendered below the
   * narrative on the same storybook page. Surfaced visually with a
   * dedicated header + italic body so the printed-rule prose reads
   * as a parenthetical mechanic explainer rather than story beat —
   * keeps the wave-1 intro narrative paragraph clean while still
   * teaching the new ability (Fatal Flaw, Rotates, etc.) inline
   * the first time the player encounters it.
   *
   * Sourced from a sibling `<pageKey>_ability_rules` entry in the
   * quest's `pages` map (e.g. quest2 carries `wave1_intro` +
   * `wave1_intro_ability_rules`). The pattern is generic so any
   * future intro page that introduces a new printed ability can opt
   * in without touching this file. */
  abilityRules?: string;
  /** Optional printed ability name surfaced under the "ENEMY
   * ABILITIES" header as a sub-label (e.g. "FATAL FLAW",
   * "ROTATES"). Rendered uppercase via CSS so the data field can
   * stay human-cased ("Fatal Flaw"). Sourced from a sibling
   * `<pageKey>_ability_name` entry in the quest's `pages` map.
   * Independent of `abilityRules` so a page can in principle show
   * the label alone (just the headline) or the rules alone (no
   * named ability), though in practice both ship together. */
  abilityName?: string;
}

/** Per-quest theming for the Story screen — title text + portrait
 *  shown on every intro page. Wave-1 intro page swaps to a different
 *  portrait when defined so the change of subject (briefing → monster
 *  the delvers will face) is signalled visually as well as by the
 *  title change.
 *
 *  `introPortraitOverrides` lets specific intro pages (keyed by
 *  0-based index into `quest.intro`) swap to a different portrait
 *  when the speaker/subject changes mid-sequence (e.g. Quest 2's
 *  fourth intro page is Master Bram giving the "chin up" send-off,
 *  not Father Flores who carries the first three pages). Pages not
 *  in the override map fall back to `introPortrait`.
 */
interface QuestStoryTheme {
  introTitle: string;
  introPortrait: string;
  introPortraitOverrides?: Record<number, string>;
  wave1Title: string;
  wave1Portrait: string;
}

const STORY_THEMES: Record<string, QuestStoryTheme> = {
  quest3: {
    introTitle: "QUEST #03 - XAVIER'S REQUEST",
    introPortrait: "/story/ch2/academy-xavier.png",
    wave1Title: "QUEST #03 - WAVE 1",
    wave1Portrait: "/cards/enemy_cerberus_031.jpg",
  },
  quest5: {
    introTitle: "QUEST #05 - THE ROGUE DELVER",
    introPortrait: "/quests/quest-05.jpg",
    wave1Title: "QUEST #05 - WAVE 1",
    wave1Portrait: "/cards/enemy_bob_079.jpg",
  },
  quest6: {
    introTitle: "QUEST #06 - THE FORGOTTEN VAULT",
    introPortrait: "/story/ch2/library-rodrigo.png",
    wave1Title: "QUEST #06 - WAVE 1",
    wave1Portrait: "/cards/enemy_joyce_029.jpg",
  },
  quest4: {
    introTitle: "QUEST #04 - A HAND OUTSTRETCHED",
    introPortrait: "/quests/quest-04.jpg",
    wave1Title: "QUEST #04 - WAVE 1",
    wave1Portrait: "/cards/enemy_hugh_112.jpg",
  },
  quest7: {
    introTitle: "QUEST #07 - FURTHER AFIELD",
    introPortrait: "/quests/quest-07.jpg",
    wave1Title: "QUEST #07 - WAVE 1",
    wave1Portrait: "/cards/enemy_spike_129.jpg",
  },
  quest13: {
    introTitle: "QUEST #13 - UNDERNEATH THE WATCHTOWER",
    introPortrait: "/quests/quest-13.jpg",
    wave1Title: "QUEST #13 - WAVE 1",
    wave1Portrait: "/cards/enemy_billy_132.jpg",
  },
  assault: {
    introTitle: "STORY QUEST - ASSAULT ON BIRD'S NEST",
    introPortrait: "/story/ch2/master-bram.png",
    wave1Title: "ASSAULT ON BIRD'S NEST - WAVE 1 / 1",
    wave1Portrait: "/cards/enemy_mistspawn_104.jpg",
  },
  quest1: {
    introTitle: "CHAPTER 1 - FINAL EXAM",
    introPortrait: "/story/bram.png",
    // Page 2 (index 1) is the "A thousand years have passed... we
    // grant you the use of our most priceless objects: delversuits"
    // page where Bram presents the delversuit behind him. Swap to
    // the delversuits art so the image matches what Bram is showing
    // off rather than another head-shot of Bram himself.
    introPortraitOverrides: {
      1: "/story/delversuits.png",
    },
    wave1Title: "QUEST #01 - INTRO",
    wave1Portrait: "/story/soulhunter.png",
  },
  quest2: {
    introTitle: "CHAPTER 2 - DELVERS OF BIRD'S NEST",
    // Ch2 is Father Flores's arc — he's the one who sends the comms
    // message recruiting the delvers (see chapter1.json page35) — so
    // his framed portrait reads better than Bram's beside the intro
    // prose for the opening sermon + binocular hand-off pages.
    introPortrait: "/story/father-flores.png",
    // Per-page overrides where the speaker/subject changes mid-
    // sequence:
    //   - Page 3 (index 2) introduces Witness — "This is Witness.
    //     He's useless in a fight, but he'll haul your gear for
    //     you." Swap to the Witness portrait so the face beside
    //     the page matches the character being introduced.
    //   - Page 4 (index 3) is Bram's send-off — "Chin up,
    //     delvers," Master Bram adds, with a grin. Swap to Bram.
    introPortraitOverrides: {
      2: "/story/witness.png",
      3: "/story/bram.png",
    },
    wave1Title: "QUEST #02 - INTRO",
    // Q2's wave-1 intro page describes the Venena swarm + Goldmonger
    // ambush + the Fatal Flaw turn-order rule, so we show the printed
    // Goldmonger creature card back (which prints the Fatal Flaw
    // value, the bear-merged-with-beehive flavour text, and the
    // Venena swarm callout). Replaces the placeholder Bram portrait
    // that was filling this slot until proper art landed.
    wave1Portrait: "/story/goldmonger.png",
  },
};

/** Build the full page sequence each render so a data edit in
 * `questN.json` (e.g. adding/removing an intro chunk) takes effect on
 * reload without needing to touch this file. */
function buildPages(questId: string): StoryPage[] {
  const quest = getQuestData(questId);
  const theme = STORY_THEMES[questId] ?? STORY_THEMES["quest1"]!;
  const pages: StoryPage[] = quest.intro.map((text, i) => ({
    key: `${questId}-intro-${i + 1}`,
    title: theme.introTitle,
    text,
    // Per-page portrait override (e.g. Q2 page 4 → Bram) falls
    // through to the theme's default `introPortrait` when no
    // override is registered for this page index.
    image: theme.introPortraitOverrides?.[i] ?? theme.introPortrait,
  }));
  const wave1 = quest.pages.wave1_intro;
  if (wave1) {
    // Optional sibling fields that, when present, surface a
    // dedicated "ENEMY ABILITIES" block (header + named ability +
    // italicised rules prose) under the narrative. Lets quest data
    // split mechanic-explainer copy out of the narrative paragraph
    // without changing the page contract (still a
    // `Record<string, string>`).
    const wave1AbilityName = quest.pages.wave1_intro_ability_name;
    const wave1AbilityRules = quest.pages.wave1_intro_ability_rules;
    pages.push({
      key: `${questId}-wave-1-intro`,
      title: theme.wave1Title,
      text: wave1,
      image: theme.wave1Portrait,
      ...(wave1AbilityName ? { abilityName: wave1AbilityName } : {}),
      ...(wave1AbilityRules ? { abilityRules: wave1AbilityRules } : {}),
    });
  }
  return pages;
}

let pageIdx = 0;

/** Active particle system (one per mounted story screen). Cleared on
 * full re-mount and on `resetStoryProgress` so the rAF loop doesn't
 * keep running against a detached canvas after navigating away.
 * NOT cleared on internal page-turn — that's the whole point. */
let activeParticles: StoryParticles | null = null;

function stopActiveParticles(): void {
  if (activeParticles !== null) {
    activeParticles.stop();
    activeParticles = null;
  }
}

/** Online co-op: current page cursor (published with each snapshot). */
export function getStoryPage(): number {
  return pageIdx;
}

/** Online co-op: jump to the host's page (caller re-renders). */
export function setStoryPage(idx: number): void {
  pageIdx = idx;
}

/** Online co-op hook: fired after an in-place page turn by this client. */
let storyPageListener: ((prevIdx: number) => void) | null = null;
export function onStoryPageTurn(cb: (prevIdx: number) => void): void {
  storyPageListener = cb;
}

export function resetStoryProgress(): void {
  pageIdx = 0;
  stopActiveTypewriter();
  stopActiveParticles();
}

export function renderStoryScreen(root: HTMLElement, router: Router): void {
  // Full mount: this is called by main.ts > render() whenever the
  // active route is "story". `root.innerHTML` was just wiped, so any
  // previous wrap / canvas / typewriter is already detached — the
  // explicit stop calls below just sever the (now-orphaned) handles.
  stopActiveTypewriter();
  stopActiveParticles();

  const pages = buildPages(router.state.currentQuestId);
  const page = pages[pageIdx];
  if (!page) {
    pageIdx = 0;
    router.goTo({ name: "board" });
    return;
  }

  const wrap = document.createElement("div");
  // Chapter-id modifier (`screen--ch2`) lets the stylesheet swap the
  // default storybook-bg porthole for an ambient underwater backdrop
  // on Chapter 2 narrative pages. Mirrors the same class applied in
  // `screens/TownVisit.ts` so a single CSS rule covers both screen
  // types. Today only quest-2 lives in Chapter 2; future Ch2 quests
  // (or a chapter lookup table) extend the condition.
  const isChapter2 = router.state.currentQuestId !== "quest1";
  const chapterClass = isChapter2 ? " screen--ch2" : "";
  wrap.className = "screen screen--story" + chapterClass;
  wrap.innerHTML = `
    <div class="story-stage">
      <div class="story-stage-row">
        <article class="storybook-page">
          <h2 data-story-title></h2>
          <div class="storybook-text" data-story-text></div>
          <div class="story-progress small muted" data-story-progress></div>
        </article>
        <aside class="storybook-portrait" data-story-portrait hidden>
          <img alt="" data-story-portrait-img />
        </aside>
      </div>
      <div class="story-actions">
        <button class="btn btn--primary" data-action="next" data-story-next></button>
      </div>
    </div>
  `;
  root.appendChild(wrap);

  // Mount the ambient particle drift behind the storybook card. The
  // canvas is a child of `wrap` and we DO NOT recreate `wrap` on
  // page-turn (see `goToPage` below), so the rAF loop keeps running
  // continuously across pages. Navigating to a different screen
  // (-> board) wipes `root.innerHTML`, detaches the canvas, and the
  // loop self-cleans via its `host.isConnected` check.
  activeParticles = startStoryParticles(wrap);

  // Handlers wired ONCE at mount; they read the latest typewriter /
  // page idx via module state on each click. Tap anywhere on the
  // screen (background, portrait, card body) → fast-forward the
  // typewriter (no advance). The Next button below has its own
  // skip-then-advance logic so it stays a discrete action.
  // Broadened from `.storybook-page` to the full screen wrap on
  // 2026-05-18.
  wireSkipOnClick(wrap);

  wrap.querySelector<HTMLButtonElement>("[data-action=next]")!
    .addEventListener("click", () => {
      const tw = getActiveTypewriter();
      if (tw && !tw.isComplete()) {
        tw.skip();
        return;
      }
      advance(wrap, router);
    });

  // Paint the current page (page 0 on first entry, or whatever index
  // we left off at if the user came back to the screen).
  paintPage(wrap, pages, pageIdx);
}

/** Internal page-turn. Called on Next-button after typewriter is
 * complete. Mutates the existing wrap so the particle canvas (and
 * its rAF loop) keeps running uninterrupted. Falls back to a real
 * route change only when leaving the Story screen entirely. */
function advance(wrap: HTMLElement, router: Router): void {
  const pages = buildPages(router.state.currentQuestId);
  pageIdx += 1;
  if (pageIdx >= pages.length) {
    pageIdx = 0;
    router.goTo({ name: "board" });
    return;
  }
  paintPage(wrap, pages, pageIdx);
  storyPageListener?.(pageIdx - 1);
}

/** Replace the page-specific content (title, body, progress, button
 * label) inside `wrap` and start a fresh typewriter on the new body.
 * Does NOT touch the canvas or rebuild the wrap structure. */
function paintPage(wrap: HTMLElement, pages: StoryPage[], idx: number): void {
  const page = pages[idx]!;
  const isLast = idx === pages.length - 1;

  wrap.querySelector<HTMLHeadingElement>("[data-story-title]")!
    .textContent = page.title;
  wrap.querySelector<HTMLDivElement>("[data-story-progress]")!
    .textContent = `Page ${idx + 1} of ${pages.length}`;
  wrap.querySelector<HTMLButtonElement>("[data-story-next]")!
    .innerHTML = isLast ? "Descend into the Tide \u2192" : "Next \u2192";

  // Portrait beside the text card — set the src and reveal the
  // <aside> when this page declares an image, otherwise blank the
  // src and hide the wrapper so the text card centers on its own.
  const portrait = wrap.querySelector<HTMLElement>("[data-story-portrait]")!;
  const portraitImg = wrap.querySelector<HTMLImageElement>("[data-story-portrait-img]")!;
  if (page.image) {
    if (portraitImg.getAttribute("src") !== page.image) {
      portraitImg.src = page.image;
    }
    portrait.removeAttribute("hidden");
  } else {
    portrait.setAttribute("hidden", "");
    portraitImg.removeAttribute("src");
  }

  const textEl = wrap.querySelector<HTMLDivElement>("[data-story-text]")!;
  const narrativeHtml = formatNarrativeWithTypewriterSpans(page.text);
  // The ability-rules block lives INSIDE `.storybook-text` (not a
  // sibling) so the typewriter — which walks `.tt-char` descendants
  // of the container it's started on — reveals the rules characters
  // as part of the same per-page reveal pass. The block's own
  // `<section class="storybook-ability-rules">` wrapper carries the
  // header + italic styling (see `.storybook-ability-rules*` in
  // styles.css). Without this nesting we'd need a second typewriter
  // pass on a sibling element, which would race the first.
  // Mount the ability block whenever the page declares EITHER a
  // name OR rules — both pieces ship together in practice, but
  // keeping the trigger inclusive means a future page that only
  // wants to surface the headline (no rules prose) or vice-versa
  // still gets the styled container without code changes.
  const abilityNameHtml = page.abilityName
    ? `<div class="storybook-ability-rules-name">${escapeHtml(page.abilityName)}</div>`
    : "";
  const abilityRulesHtml = (page.abilityName || page.abilityRules)
    ? `<section class="storybook-ability-rules" aria-label="Enemy Abilities">
         <h3 class="storybook-ability-rules-title">ENEMY ABILITIES</h3>
         ${abilityNameHtml}
         ${page.abilityRules ? formatNarrativeWithTypewriterSpans(page.abilityRules) : ""}
       </section>`
    : "";
  textEl.innerHTML = narrativeHtml + abilityRulesHtml;

  // Restart typewriter on the fresh `.tt-char` spans. The shared
  // module clears its previous interval inside `startTypewriter`
  // (defensively) so we don't have to call stop first here.
  startTypewriter(textEl);
}

/** Local HTML-escape — mirrors the per-file convention used by
 * the other screens in `src/screens/` (BoardScreen, RewardsModal,
 * etc.). Only applied to data-sourced labels we splice into
 * innerHTML (e.g. the ability name "Fatal Flaw"); the typewriter
 * helper already escapes each character it splits into spans. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
