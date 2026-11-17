/**
 * Town Visit screen — Chapter 1 narrative + Shop.
 *
 * Renders the page indicated by `state.townVisit.pageId`, dispatches:
 *   - `kind: "shop"`   -> hands off to `renderShopBody` (Shop.ts)
 *   - `choices`        -> renders 1-N choice buttons
 *   - `next`           -> renders a single Continue button
 *
 * Storybook layout reuses the `.screen--story` chrome from Story.ts
 * so the porthole background, particle ambience, and storybook card
 * styling carry over without duplicating CSS. Differs from Story.ts:
 *   - Resumable across refresh (state lives on `state.townVisit`,
 *     not module-locals).
 *   - Page navigation is engine-driven (advanceTownVisitPage /
 *     chooseTownVisitOption) so onEnter side-effects fire reliably.
 *
 * Typewriter reveal (added 2026-05-09): the storybook prose reveals
 * character-by-character via the shared `screens/typewriter.ts`
 * helper — same pacing as Story.ts and the End-of-Wave page. Click
 * anywhere on the screen to fast-forward; the first click on any
 * choice / continue / shop button while typing also skips the reveal
 * instead of advancing (the user's next click then advances normally).
 * Choice / shop UIs themselves do NOT participate in the reveal —
 * only `.storybook-text` carries `.tt-char` spans.
 *
 * Rewards gate (added 2026-05-18): if the page's `onEnter` actions
 * emit one or more `RewardEvent`s, the typewriter completion mounts
 * a single "Collect Rewards" button in the action slot instead of
 * the page's real navigation (Continue / choices / shop UI). The
 * player taps it to open the rewards modal. On dismissal:
 *   - Linear narrative page (`next` only, no choices, not shop):
 *     auto-advance to the next page. Skipping a redundant Continue
 *     tap because the modal's Continue button already conveyed the
 *     player's "I'm ready to move on" intent.
 *   - Choice / shop page: replace the gate button with the real
 *     navigation (choices / shop UI) because the player still has
 *     a decision to make.
 *
 * Bootstrap: the End-of-Wave router (`screens/WavePhases.ts`) pre-
 * sets `state.townVisit = { chapterId: "ch1", pageId: "page6", ... }`
 * before navigating here. If somehow we land here without a visit
 * (direct router.goTo bypass), `startTownVisit` lazily anchors at
 * Chapter 1 page 6 so the screen is never blank.
 *
 * Page art (added 2026-05-09):
 *   - `page.image` -> side `<aside class="storybook-portrait">` (e.g.
 *     speaker portrait or location splash). Aspect-preserving
 *     (`width:100%; height:auto`).
 *   - `page.decoration` -> centred `<figure class="storybook-decoration">`
 *     ABOVE the storybook card. Used on chapter intro pages (currently
 *     only `page6`) to set the scene with a chapter-frame illustration.
 *     Aspect-preserving via `object-fit: contain` and a height cap.
 */

import type { Router } from "../main";
import {
  applyOnEnter,
  advanceTownVisitPage,
  chooseTownVisitOption,
  currentTownVisitPage,
  finishTownVisit,
  lastQuestDeathOutcome,
  questDeathsMatch,
  resolveTownVisitDieRoll,
  startTownVisit,
  townVisitChoiceGated,
} from "../engine/townVisit";
import { renderShopBody, logShopLayoutSnapshot } from "./Shop";
import { renderTownsfolkAssignment } from "./TownsfolkAssignment";
import { presentRewards } from "./RewardsModal";
import { drainSuitConditionPicksViaModal } from "./SuitConditionRankPickModal";
import { onlineIsActorNow } from "../net/onlineController";
import { drainAcademyDonationResolutionViaModal } from "./AcademyDonationResolutionModal";
import { hasPendingSuitConditionRankPicks } from "../engine/suitConditionGrants";
import {
  hasPendingAcademyDonationResolution,
  totalAcademyDonation,
  donationTierForTotal,
} from "../engine/academyDonation";
import { presentPayerPick } from "./PayerPickModal";
import { HEROES, getHero } from "../data";
import { startStoryParticles, type StoryParticles } from "./storyParticles";
import { resetStoryProgress } from "./Story";
import {
  formatNarrativeWithTypewriterSpans,
  startTypewriter,
  stopActiveTypewriter,
  withTypewriterSkipFirst,
  wireSkipOnClick,
} from "./typewriter";
import { logEvent } from "../debug/sessionLog";
import { rollD6 } from "../util/random";
import type { RewardEvent } from "../types";

let activeParticles: StoryParticles | null = null;

function stopActiveParticles(): void {
  if (activeParticles) {
    activeParticles.stop();
    activeParticles = null;
  }
}

export function renderTownVisit(root: HTMLElement, router: Router): void {
  logEvent("screen.renderTownVisit.enter", {
    hadVisit: router.state.townVisit !== null,
    pageId: router.state.townVisit?.pageId ?? null,
    pagesEntered: router.state.townVisit?.pagesEntered.length ?? 0,
  });

  // Lazy bootstrap if we landed here without a visit anchor (the
  // End-of-Wave routing path normally sets this; this is the
  // defensive direct-navigate case).
  if (!router.state.townVisit) {
    startTownVisit(router.state, "ch1");
    router.persist();
  }

  // Fire on-enter side-effects exactly once for this page (the engine
  // dedupes via `pagesEntered`). If anything was applied we persist so
  // a refresh between the action and the next interaction doesn't
  // lose the grant. Capture the `RewardEvent[]` so the rewards modal
  // (mounted below after the typewriter completes) can present each
  // grant as a card / token visual.
  //
  // IMPORTANT: must run BEFORE the typewriter starts, because the
  // engine's `pagesEntered` dedupe means re-rendering won't return
  // the events a second time (a refresh mid-modal would skip the
  // grant and skip the modal). Mid-modal refresh is rare — players
  // navigating away clears the modal because the screen is unmounted
  // anyway — but the capture order matters for correctness.
  const onEnterResult = applyOnEnter(router.state);
  if (onEnterResult.ran) {
    router.persist();
  }
  const rewardEvents: RewardEvent[] = onEnterResult.events;

  const ctx = currentTownVisitPage(router.state);
  if (!ctx) {
    logEvent("screen.renderTownVisit.bounce-to-title", { reason: "no-page-ctx" });
    // Defensive — corrupt visit state. Bounce to title.
    router.goTo({ name: "title" });
    return;
  }
  const { page } = ctx;
  logEvent("screen.renderTownVisit.page", {
    pageId: ctx.visit.pageId,
    kind: page.kind,
    title: page.title,
    hasChoices: (page.choices?.length ?? 0) > 0,
    choiceCount: page.choices?.length ?? 0,
    hasNext: !!page.next,
    hasDecoration: !!page.decoration,
    hasImage: !!page.image,
  });

  // Auto-advance through "narrowed to one continue-style choice" pages
  // (2026-05-21). The motivating case: the Ch2 location hub has 4
  // choices — 3 location visits gated by `requireStoryTokens:
  // "positive"` + `hideIfDecisionMade`, plus a "Continue to the Town
  // Center" gated by `requireStoryTokens: "zero"`. After the player
  // spends both story tokens by visiting 2 locations and returns to
  // the hub, only the Continue choice is left visible — the hub
  // becomes a redundant "click through this page with one button"
  // step. Skip it: walk straight to the hub's `next` for the player.
  //
  // Narrowly scoped to avoid false positives:
  //   - rewardEvents.length === 0  (rewards must be acknowledged first)
  //   - the page started with 2+ printed choices (single-choice pages
  //     are intentional standalone decisions and must NOT be skipped)
  //   - after gating, exactly ONE choice remains visible
  //   - that surviving choice has `requireStoryTokens === "zero"`
  //     (the "you've exhausted your token pool, continue" affordance —
  //     today only emitted by the Ch2 hub, but the predicate is
  //     generic so any future "spend N tokens then continue" page
  //     inherits the same auto-advance)
  //   - that surviving choice has no `prePay` cost (a pre-pay would
  //     require player confirmation in the payer picker modal, which
  //     must NOT be silently skipped)
  // Logs a `screen.renderTownVisit.auto-advance` row so the bypass is
  // traceable in session logs (this is the kind of UX shortcut that
  // would otherwise be invisible at debug time).
  if (
    rewardEvents.length === 0
    && (page.choices?.length ?? 0) >= 2
  ) {
    const visibleChoices = (page.choices ?? []).filter((choice) => {
      if (choice.hideIfDecisionMade && router.state.townDecisions.includes(choice.hideIfDecisionMade)) return false;
      if (choice.showIfDecision && !router.state.townDecisions.includes(choice.showIfDecision)) return false;
      if (choice.requireStoryTokens === "positive" && router.state.storyTokens <= 0) return false;
      if (choice.requireStoryTokens === "zero" && router.state.storyTokens > 0) return false;
      if (!questDeathsMatch(router.state, choice)) return false;
      if (townVisitChoiceGated(router.state, choice)) return false;
      return true;
    });
    // A page narrowed by `requireQuestDeaths` is NOT skipped: its text
    // ("The Festival Begins", "The Fallen") is story the player should
    // read. It renders with just the matching button instead.
    if (visibleChoices.length === 1 && !visibleChoices[0]!.prePay && !visibleChoices[0]!.requireQuestDeaths) {
      const only = visibleChoices[0]!;
      // Determine which gate did the narrowing — used purely for
      // log readability (a `reason` of `single-visible-choice` vs
      // `single-zero-token-continue` makes session traces self-
      // documenting). The prePay gate stays a hard skip above:
      // any prePay-bearing choice MUST go through the payer pick.
      const reason = only.requireStoryTokens === "zero"
        ? "single-zero-token-continue"
        : "single-visible-choice";
      logEvent("screen.renderTownVisit.auto-advance", {
        pageId: ctx.visit.pageId,
        reason,
        decisionKey: only.decisionKey,
        toPageId: only.next,
        printedChoiceCount: page.choices?.length ?? 0,
        storyTokens: router.state.storyTokens,
      });
      chooseTownVisitOption(router.state, only.decisionKey);
      router.save();
      return;
    }
  }

  stopActiveParticles();
  // Cancel any prior typewriter — page navigation can land us here
  // mid-reveal of a different screen's narrative (e.g. clicked
  // Continue on End-of-Wave while it was still typing). The shared
  // module's `startTypewriter` call below also defensively clears
  // its previous interval, but stopping here is explicit + cheap.
  stopActiveTypewriter();

  const wrap = document.createElement("div");
  // The `image-choices` layout suppresses the storybook article in
  // favour of a large centred page-image + the choice/Continue row.
  // We need the page to actually carry an `image` for that to make
  // sense; if it doesn't, fall back to the default layout and log a
  // diagnostic so the data bug is loud (rather than silently
  // shipping a blank screen).
  //
  // We ALSO defer the image-focus layout on the very first entry of
  // the page if `onEnter` produced any rewards: the narrative text
  // is the player's primary read on first arrival, and the rewards
  // gate (the "Collect Rewards" button) wants to sit alongside it
  // so the player can see WHAT they're being granted and WHY. Once
  // the rewards modal is dismissed, the rewards-dismiss handler
  // (below) triggers a full `router.save()` re-render; on that
  // second render the engine's `applyOnEnter` dedupe returns no
  // events, `pageHasPendingRewards` is false, and the image-focus
  // layout finally takes over for the "pick a place" prompt.
  // Refresh-during-modal lands the player straight on the
  // image-focus layout because the engine has already recorded
  // the page as entered — that's a deliberate trade for keeping
  // the rewards gate single-fire (matching the existing
  // `pagesEntered` semantics).
  const pageHasPendingRewards = rewardEvents.length > 0;
  // Image-choices layout source-of-art resolution:
  //   - `layoutBackground` is the strongest signal: when set, the
  //     image-choices layout swaps the SCREEN BACKGROUND for this
  //     art and suppresses the centred focal `<figure>` (the bg
  //     IS the focal art, so a small centred copy would just
  //     duplicate itself). Pre-rewards (standard) layout keeps
  //     using `pageBackground` because the article is overlaid on
  //     the speaker portrait at that point.
  //   - Otherwise, the centred focal `<figure>` renders
  //     `layoutImage` (if set) or `image` (the standard layout's
  //     side portrait) as the focal art.
  // The "has at least one source of image-choices art" check below
  // gates whether the page is allowed to use this layout at all.
  const focusImage = page.layoutImage ?? page.image;
  let useImageChoicesLayout = page.layout === "image-choices";
  if (useImageChoicesLayout && !focusImage && !page.layoutBackground) {
    logEvent("screen.renderTownVisit.layout-fallback", {
      pageId: ctx.visit.pageId,
      requestedLayout: "image-choices",
      reason: "page-has-no-image-layoutImage-or-layoutBackground",
    });
    useImageChoicesLayout = false;
  }
  if (useImageChoicesLayout && pageHasPendingRewards) {
    logEvent("screen.renderTownVisit.layout-deferred", {
      pageId: ctx.visit.pageId,
      requestedLayout: "image-choices",
      reason: "pending-rewards-on-first-entry",
      rewardEventCount: rewardEvents.length,
    });
    useImageChoicesLayout = false;
  }

  // Shop pages get an extra `--shop` modifier so the storybook
  // porthole / delver backing art (inherited from `.screen--story`)
  // can be suppressed via CSS \u2014 the product grid needs a calm
  // background to read cleanly. Narrative pages keep the porthole.
  // image-choices pages get their own modifier so the layout CSS
  // can centre the focal image and hide article-specific chrome.
  const layoutClass = page.kind === "shop"
    ? " screen--town-visit-shop"
    : useImageChoicesLayout
      ? " screen--town-visit-image-choices"
      : "";
  // Chapter-id modifier lets the stylesheet swap the default
  // backdrop per chapter (Ch1 keeps the storybook-bg porthole; Ch2
  // gets an ambient underwater scene). The same `.screen--ch2`
  // class is also applied by `screens/Story.ts` for the quest-2
  // intro so the chapter's backdrop is consistent across both
  // narrative-screen types. Page-level `pageBackground` inline
  // styles still win — the per-chapter rule is only the
  // fall-through that replaces the global `.screen--story`
  // background for pages that don't specify their own.
  const chapterClass = ctx.visit.chapterId === "ch2" || ctx.visit.chapterId === "ch3" || ctx.visit.chapterId === "ch4"
    ? " screen--ch2"
    : "";
  wrap.className = "screen screen--story screen--town-visit" + layoutClass + chapterClass;
  // Background resolution (priority order):
  //   1. `layoutBackground` — only when image-choices layout is
  //      ACTIVE. Lets a page swap its backdrop between the
  //      pre-rewards standard-layout state and the post-rewards
  //      image-choices state (e.g. Ch1 page7's Bram-portrait
  //      while reading vs Bird's Nest map while picking).
  //   2. `pageBackground` — page-wide override; applies in all
  //      states the page renders in.
  //   3. (none) — falls through to the default `.screen--story`
  //      porthole CSS background.
  // Same `center / 50% auto no-repeat` treatment as the global
  // background so the asset's intrinsic aspect ratio is preserved
  // (no stretching) and the sizing convention stays consistent
  // across pages. Inline `background` shorthand wins over
  // `.screen--story { background: ... }` without `!important`.
  const activeBackground = (useImageChoicesLayout && page.layoutBackground)
    ? page.layoutBackground
    : page.pageBackground;
  if (activeBackground) {
    wrap.style.background = `url("${activeBackground}") center / 50% auto no-repeat, #000`;
  }
  if (useImageChoicesLayout) {
    // When `layoutBackground` is the source of art, the background
    // IS the focal image — suppress the centred `<figure>` so the
    // same painting doesn't render at two different scales at
    // once. Otherwise emit the centred focal image (resolved above
    // as `layoutImage ?? image`).
    const focusFigure = page.layoutBackground
      ? ""
      : `
        <figure class="storybook-image-focus">
          <img alt="" src="${focusImage!}" />
        </figure>
      `;
    wrap.innerHTML = `
      <div class="story-stage story-stage--image-choices">
        ${focusFigure}
        <div class="story-actions" data-town-actions></div>
      </div>
    `;
  } else {
    // Body-text source resolution: pages that ship a
    // `postRewardsText` get the longer intro prose ONLY while the
    // Collect Rewards gate is still pending; once dismissed the
    // re-render (`pageHasPendingRewards = false`) swaps in the
    // leaner instruction copy. Pages without `postRewardsText`
    // keep `text` in both states (no behavioural change for
    // existing pages).
    const rawText = (!pageHasPendingRewards && page.postRewardsText)
      ? page.postRewardsText
      : page.text;
    // Resolve the dynamic Arlen donation-reaction sentinel injected
    // by page34-town-center-resolution. We read the live donation
    // total from state so the quote always reflects the actual tier
    // regardless of when the page is re-entered (e.g. after a reload).
    const bodyText = rawText === "__arlen-donation-reaction__"
      ? arlenDonationReaction(router.state)
      : rawText === "__arlen-donation-reaction-ch3__"
        ? arlenDonationReactionCh3(router.state)
        : rawText === "__arlen-donation-reaction-ch4__"
          ? arlenDonationReactionCh4(router.state)
          : rawText;
    wrap.innerHTML = `
      <div class="story-stage">
        ${page.decoration ? `
          <figure class="storybook-decoration">
            <img alt="" src="${page.decoration}" />
          </figure>
        ` : ""}
        <div class="story-stage-row">
          <article class="storybook-page">
            <div class="storybook-eyebrow small muted">${escapeHtml(page.title)}</div>
            ${page.subtitle ? `<h2>${escapeHtml(page.subtitle)}</h2>` : ""}
            ${renderStoryTokensCounter(page, router.state.storyTokens)}
            <div class="storybook-text" data-story-text>${formatNarrativeWithTypewriterSpans(bodyText)}</div>
            ${page.footnote ? `<p class="storybook-footnote small muted">${escapeHtml(page.footnote)}</p>` : ""}
          </article>
          ${page.image ? `
            <aside class="storybook-portrait">
              <img alt="" src="${page.image}" />
            </aside>
          ` : ""}
        </div>
        <div class="story-actions" data-town-actions></div>
      </div>
    `;
  }
  root.appendChild(wrap);

  activeParticles = startStoryParticles(wrap);

  const actions = wrap.querySelector<HTMLDivElement>("[data-town-actions]")!;

  // Build the navigation row (choices / Continue / shop / fallback)
  // and mount it into `.story-actions`. Extracted into a thunk so
  // we can defer the actual append until the typewriter has fully
  // revealed the page's dialogue AND any pending rewards have been
  // collected by the player — they shouldn't be able to tap "Check
  // out the Misty Eagle Pub" before they've read why it matters or
  // seen what they earned. Added 2026-05-18 in response to a UX
  // request.
  //
  // Idempotency: starts by clearing `actions` and resetting the
  // `town-choices` class because we may be replacing a previously
  // mounted "Collect Rewards" placeholder (see `mountCollectRewards`
  // below). Without the reset, the placeholder button would linger
  // alongside the real navigation and the choice flex layout could
  // double-toggle.
  const mountActions = () => {
    actions.innerHTML = "";
    actions.classList.remove("town-choices", "town-choices--cards");
    if (page.kind === "shop") {
      // Shop rendering replaces the simple action row with the full
      // shop UI (wallets + product grid + finish). Lives in Shop.ts
      // so the storybook screen stays narrative-focused. Shop UI
      // buttons do NOT skip-wrap their handlers — by the time the
      // player is tapping product buttons the reveal is essentially
      // always done (the shop briefing prose is short), and
      // intercepting buys to skip-first would feel laggy. The
      // storybook-page click skip still works for users who want to
      // skip explicitly.
      renderShopBody(actions, router);
      // Layout snapshot fires AFTER the browser commits the next
      // paint so we measure the actual computed boxes (not the
      // pre-layout 0x0 placeholders). Critical for diagnosing the
      // recurring "huge gap" bug class — the snapshot reports
      // computed heights + bounding rects of screen/stage/article/
      // wallets/grid/finish, which is the only way to localise
      // vertical slack without a screen recording.
      logShopLayoutSnapshot(wrap, actions);
      return;
    }
    if (page.kind === "townsfolk-assignment") {
      renderTownsfolkAssignment(actions, router);
      return;
    }

    if (page.choices && page.choices.length > 0) {
      actions.classList.add("town-choices");
      for (const choice of page.choices) {
        // `hideIfDecisionMade` gate: if the player has already made
        // this decision earlier in the visit (recorded in
        // `townDecisions`), suppress the button entirely. Used by
        // Ch2's "Tour the Town" hub page to hide already-visited
        // location buttons on the player's second pass through.
        if (choice.hideIfDecisionMade && router.state.townDecisions.includes(choice.hideIfDecisionMade)) {
          logEvent("screen.renderTownVisit.choice.hidden", {
            pageId: ctx.visit.pageId,
            decisionKey: choice.decisionKey,
            reason: "decision-already-made",
            hiddenBy: choice.hideIfDecisionMade,
          });
          continue;
        }
        if (choice.showIfDecision && !router.state.townDecisions.includes(choice.showIfDecision)) continue;
        // `requireStoryTokens` gate: render only when the campaign's
        // `storyTokens` counter matches the requested condition.
        // `"positive"` shows while there's a token to spend (the
        // hub's location buttons); `"zero"` shows once the pool is
        // empty (the hub's "Continue to Town Center" button).
        if (choice.requireStoryTokens === "positive" && router.state.storyTokens <= 0) {
          logEvent("screen.renderTownVisit.choice.hidden", {
            pageId: ctx.visit.pageId,
            decisionKey: choice.decisionKey,
            reason: "story-tokens-zero",
          });
          continue;
        }
        if (choice.requireStoryTokens === "zero" && router.state.storyTokens > 0) {
          logEvent("screen.renderTownVisit.choice.hidden", {
            pageId: ctx.visit.pageId,
            decisionKey: choice.decisionKey,
            reason: "story-tokens-positive",
            storyTokens: router.state.storyTokens,
          });
          continue;
        }
        // `requireQuestDeaths` gate: the "did any delver die?" pages
        // show only the branch matching who actually died on the last
        // quest (`state.lastQuestDeaths`) instead of asking.
        if (!questDeathsMatch(router.state, choice)) {
          logEvent("screen.renderTownVisit.choice.hidden", {
            pageId: ctx.visit.pageId,
            decisionKey: choice.decisionKey,
            reason: "quest-deaths-mismatch",
            required: choice.requireQuestDeaths,
            actual: lastQuestDeathOutcome(router.state),
          });
          continue;
        }
        // `requireDecision` / `requireKeyItemAny` gates (Ch3+): e.g. the
        // Dahlia's Cave hub button needs Quest #3 completed, and its
        // option A needs Key Item #4 or #8.
        if (townVisitChoiceGated(router.state, choice)) {
          logEvent("screen.renderTownVisit.choice.hidden", {
            pageId: ctx.visit.pageId,
            decisionKey: choice.decisionKey,
            reason: "requirement-not-met",
          });
          continue;
        }
        // Pre-pay eligibility check: if the choice declares a cost,
        // compute who can afford BEFORE rendering so we can grey
        // out the button when nobody can pay. Driven from the
        // typed `prePay` field (today only `"minion-parts"`).
        const eligibleForPrePay = choice.prePay
          ? eligiblePayers(router.state, choice.prePay)
          : null;
        const prePayBlocked = eligibleForPrePay !== null && eligibleForPrePay.length === 0;

        const btn = document.createElement("button");
        btn.className = `btn btn--primary town-choice-btn${choice.image ? " town-choice-btn--card" : ""}`;
        if (choice.image) actions.classList.add("town-choices--cards");
        const blockedHint = prePayBlocked
          ? `<span class="town-choice-hint small muted">No delver has enough minion parts to spare.</span>`
          : "";
        btn.innerHTML = `
          ${choice.image ? `<img class="town-choice-card" src="${choice.image}" alt="" draggable="false" />` : ""}
          <span class="town-choice-label">${escapeHtml(choice.label)}</span>
          ${choice.hint ? `<span class="town-choice-hint small muted">${escapeHtml(choice.hint)}</span>` : ""}
          ${blockedHint}
        `;
        if (prePayBlocked) {
          btn.disabled = true;
          btn.classList.add("town-choice-btn--blocked");
        }
        // `withTypewriterSkipFirst` is now redundant for the natural
        // flow (the button only mounts after completion), but we
        // keep it for the edge case where a player triggers another
        // typewriter mid-mount (e.g. devtools, weird re-entry). It's
        // a no-op in the happy path.
        btn.addEventListener("click", withTypewriterSkipFirst(() => {
          logEvent("click.town-choice", {
            pageId: ctx.visit.pageId,
            decisionKey: choice.decisionKey,
            label: choice.label,
            prePay: choice.prePay ?? null,
            prePayEligible: eligibleForPrePay,
          });
          if (choice.prePay && eligibleForPrePay) {
            void runPrePayThenChoose(wrap, router, choice, eligibleForPrePay);
            return;
          }
          chooseTownVisitOption(router.state, choice.decisionKey);
          router.save();
        }));
        actions.appendChild(btn);
      }
      return;
    }

    if (page.startQuest && page.next) {
      const questId = page.startQuest;
      const btn = document.createElement("button");
      btn.className = "btn btn--accent";
      btn.innerHTML = "Descend into the Tide \u2192";
      btn.addEventListener("click", withTypewriterSkipFirst(() => {
        logEvent("click.town-start-quest", { pageId: ctx.visit.pageId, questId });
        // Park the visit on `next` so it resumes there after the quest.
        advanceTownVisitPage(router.state);
        router.state.currentQuestId = questId;
        router.state.encounter = null;
        resetStoryProgress();
        router.save();
        router.goTo({ name: "story" });
      }));
      actions.appendChild(btn);
      return;
    }

    if (page.dieRoll) {
      // "Roll a die" page: roll, show the result + its bracket, then
      // Continue to the bracket's page.
      const outcomes = page.dieRoll;
      const rollBtn = document.createElement("button");
      rollBtn.className = "btn btn--accent";
      rollBtn.textContent = "Roll a die";
      rollBtn.addEventListener("click", withTypewriterSkipFirst(() => {
        const roll = rollD6();
        const outcome = outcomes.find((o) => roll >= o.min && roll <= o.max);
        logEvent("click.town-die-roll", { pageId: ctx.visit.pageId, roll, toPageId: outcome?.next ?? null });
        actions.innerHTML = `
          <div class="town-die-result">
            <span class="town-die-face" aria-label="Rolled ${roll}">${roll}</span>
            <span class="town-die-label">${escapeHtml(outcome?.label ?? "")}</span>
          </div>
        `;
        const cont = document.createElement("button");
        cont.className = "btn btn--primary";
        cont.innerHTML = "Continue \u2192";
        cont.addEventListener("click", () => {
          resolveTownVisitDieRoll(router.state, roll);
          router.save();
        });
        actions.appendChild(cont);
      }));
      actions.appendChild(rollBtn);
      return;
    }

    if (page.next) {
      const btn = document.createElement("button");
      btn.className = "btn btn--primary";
      btn.innerHTML = "Continue \u2192";
      btn.addEventListener("click", withTypewriterSkipFirst(() => {
        logEvent("click.town-continue", {
          pageId: ctx.visit.pageId,
          toPageId: page.next ?? null,
        });
        advanceTownVisitPage(router.state);
        router.save();
      }));
      actions.appendChild(btn);
      return;
    }

    // Terminal narrative page — explicit "Finish Town Visit" exit.
    // Same call shape as Shop.ts's Finish button (confirm + clear
    // encounter + return to title) so leaving the visit feels
    // identical whether the player ends from a shop scene or a
    // narrative beat. Gated on `kind === "end-town-visit"` so a
    // mis-configured page (forgot to add `next` or `choices`) still
    // falls through to the Title bounce below instead of silently
    // ending the visit.
    if (page.kind === "end-town-visit") {
      // Chapter 1 -> after the visit, the campaign flips into Quest 2
      // (handled by `finishTownVisit`). Auto-advance straight into the
      // Q2 intro Story screen so the player flows seamlessly:
      //   Q1 W1 victory -> Ch1 Town Visit -> Q2 intro -> Q2 W1.
      // Chapter 2 -> Q3+ isn't shipped yet, so the End of Chapter 2
      // bounces back to Title. When Quest 3 lands, this becomes the
      // mirror of Ch1's auto-advance (Reset story progress + goTo
      // story screen, after `finishTownVisit` bumps `currentQuestId`
      // to "quest3"). For now, "Return to Title (End of Chapter 2)"
      // is the honest label.
      const isCh1 = ctx.visit.chapterId === "ch1";
      const isCh2 = ctx.visit.chapterId === "ch2";
      const isCh3 = ctx.visit.chapterId === "ch3";
      const btnLabel = isCh1
        ? "Finish Town Visit \u2192 Quest 2 Intro"
        : isCh2
          ? "Continue to Chapter 3 \u2192"
          : isCh3
            ? "Continue to Chapter 4 \u2192"
            : "Finish Chapter 4";
      const btn = document.createElement("button");
      btn.className = "btn btn--accent";
      btn.innerHTML = btnLabel;
      btn.addEventListener("click", withTypewriterSkipFirst(() => {
        // No confirm() gate here: the button is only enabled after
        // the player has actively walked through the Town Visit
        // typewriter pages, and the label explicitly states where
        // it leads ("Finish Town Visit -> Quest 2 Intro"), so the
        // native browser dialog was just adding friction with no
        // information value.
        logEvent("click.town-finish", { pageId: ctx.visit.pageId, chapterId: ctx.visit.chapterId });
        finishTownVisit(router.state);
        router.state.encounter = null;
        // Ch1 finish auto-advances to the Q2 intro Story screen
        // (`finishTownVisit` has already bumped `currentQuestId`).
        // Reset story progress so the Q2 intro starts at page 1, not
        // wherever the Q1 intro happened to leave the ephemeral
        // cursor (the cursor is a module-local state in Story.ts).
        if (isCh1) {
          resetStoryProgress();
          router.goTo({ name: "story" });
        } else if (isCh2) {
          // Ch3's Quests (#3 / #5 / #6) aren't playable yet, so Ch3
          // opens with a Quest Report page instead of a Story screen.
          startTownVisit(router.state, "ch3");
          router.save();
          router.goTo({ name: "townVisit" });
        } else if (isCh3) {
          startTownVisit(router.state, "ch4");
          router.save();
          router.goTo({ name: "townVisit" });
        } else {
          showChapterEndOverlay(router, 4);
        }
      }));
      actions.appendChild(btn);
      // "Stop for now" (user request 2026-11-15): end the chapter the same
      // way, but return to the Title screen instead of starting the next
      // one. Title already resumes from exactly this state — its main
      // button reads "Continue → Quest 2 Intro" / "→ Chapter 3" /
      // "→ Chapter 4" once `finishTownVisit` has run. Chapter 4 has no
      // next chapter; its overlay already offers download + exit.
      if (isCh1 || isCh2 || isCh3) {
        const stopBtn = document.createElement("button");
        stopBtn.className = "btn btn--ghost";
        stopBtn.innerHTML = "Stop for now";
        stopBtn.title = "Save and return to the title screen. Continue from there whenever you're ready.";
        stopBtn.addEventListener("click", withTypewriterSkipFirst(() => {
          logEvent("click.town-finish.stop-for-now", { pageId: ctx.visit.pageId, chapterId: ctx.visit.chapterId });
          finishTownVisit(router.state);
          router.state.encounter = null;
          router.goTo({ name: "title" });
        }));
        actions.appendChild(stopBtn);
      }
      return;
    }

    // Defensive — page with neither choices nor next nor end-town-
    // visit kind. Render a Title bounce so the player isn't stuck.
    logEvent("screen.renderTownVisit.fallback", {
      pageId: ctx.visit.pageId,
      reason: "no-choices-no-next-no-end-kind",
    });
    const fallback = document.createElement("button");
    fallback.className = "btn btn--ghost";
    fallback.textContent = "Return to Title";
    fallback.addEventListener("click", withTypewriterSkipFirst(() => {
      logEvent("click.town-fallback-title");
      router.goTo({ name: "title" });
    }));
    actions.appendChild(fallback);
  };

  // Reveal the storybook prose char-by-char (paragraph + linebreak
  // structure preserved). Click anywhere on the storybook card to
  // fast-forward; the `onComplete` callback runs the post-reveal
  // chain (rewards gate -> real navigation).
  //
  // Reveal -> (Collect Rewards gate) -> navigation sequence:
  //   1. Typewriter finishes (natural / skip / zero-char).
  //   2. If rewardEvents.length > 0, mount a single "Collect Rewards"
  //      button under .story-actions. Tapping it opens the rewards
  //      modal; once dismissed, the real navigation mounts.
  //   3. Otherwise (no rewards), mount the real navigation directly.
  //
  // Why a gate button (and not auto-popup):
  //   The auto-popup pattern (modal-first, then nav) interrupted the
  //   player's reading rhythm — they hit the end of the typewriter
  //   and a modal slammed up before they'd registered the "Continue"
  //   shape. Putting a single "Collect Rewards" button in the same
  //   slot where Continue would normally sit lets the player drive
  //   the modal at their own tempo while still gating the page
  //   advance on acknowledgement of every grant.
  //
  // The `revealMounted` latch covers any double-fire from a
  // skip-then-tick race (typewriter's own `onCompleteFired` latch
  // already prevents that, but defence in depth).
  const textEl = wrap.querySelector<HTMLElement>("[data-story-text]");
  let revealMounted = false;
  // Whether dismissing the rewards modal should auto-advance to
  // the next page (skipping a redundant "Continue" tap). True only
  // when the page has a single linear `next` exit — choice pages
  // need player input, and shop pages need the shop UI to render
  // before the player can buy / finish. The auto-advance applies
  // ONLY when the gate fires (i.e. rewardEvents is non-empty); the
  // "no rewards" path goes straight to the page's real navigation
  // (which IS the Continue button), so no auto-advance shortcut is
  // possible / needed there.
  const autoAdvanceOnRewardDismiss =
    page.kind !== "shop"
    && (page.choices?.length ?? 0) === 0
    && !page.startQuest
    && !!page.next;

  const mountCollectRewards = () => {
    actions.innerHTML = "";
    actions.classList.remove("town-choices", "town-choices--cards");
    const btn = document.createElement("button");
    btn.className = "btn btn--primary";
    // Label swap for the "shop products added to the shop" batch:
    // those events stock the shop rather than grant something to
    // the player, so "Collect Rewards" misframes the moment. When
    // EVERY pending event is `shop-products-added`, surface the
    // gate as a plain "Continue" — the modal it opens will also
    // re-title itself to "Added to Shop" via the matching check
    // in `presentRewards`. Mixed batches (e.g. a shop-products-
    // added arrives alongside a key-item-gained) keep the
    // "Collect Rewards" label since the player IS collecting at
    // least one thing.
    const isShopOnlyBatch =
      rewardEvents.length > 0
      && rewardEvents.every((e) => e.kind === "shop-products-added");
    // Picks-only batch (no reward events, but a Suit Condition
    // pick or academy-donation resolution is queued — typical of
    // the page22-died-* sub-pages and the Town Center Resolution
    // page): surface the button as the pick prompt so the player
    // knows what they're stepping into. Otherwise it would just
    // read "Collect Rewards" with an empty modal preceding the
    // picker.
    const isPicksOnlyBatch =
      rewardEvents.length === 0
      && (hasPendingSuitConditionRankPicks(router.state)
          || hasPendingAcademyDonationResolution(router.state));
    btn.innerHTML = isShopOnlyBatch
      ? "Continue \u2192"
      : isPicksOnlyBatch
        ? "Choose Equipment Bonus \u2192"
        : "Collect Rewards \u2192";
    btn.addEventListener("click", () => {
      logEvent("click.town-collect-rewards", {
        pageId: ctx.visit.pageId,
        eventCount: rewardEvents.length,
        eventKinds: rewardEvents.map((e) => e.kind),
        willAutoAdvance: autoAdvanceOnRewardDismiss,
      });
      // Disable to prevent double-tap re-open while the modal is
      // mounting (`presentRewards` itself is async-resolved, not
      // async-mounted, but the disable keeps intent obvious).
      btn.disabled = true;
      // Chain: rewards modal -> Suit Condition picker (if any) ->
      // a second rewards modal showing the resolved bumps.
      // The picker drain is in-place against `wrap`, then we
      // present the collected `suit-condition-rank-bumped`
      // events through the same `presentRewards` so the player
      // sees one "After your choice, here's the bump" card per
      // resolved pick (mirroring how the opinion rank picker
      // emits a follow-on toast).
      const afterRewardsModal = async () => {
        // Order matters: the academy-donation resolution drains
        // FIRST because it's tied to the Town Center Resolution
        // page that just emitted the headline event. The
        // suit-condition picker drain that follows then catches
        // any picks queued from other sources (e.g. a future
        // page that combines a donation with a `blood-soaked
        // power` pick — defensive even though the current Ch2
        // flow doesn't stack them on the same page).
        const collectedBumps: Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>> = [];
        if (hasPendingAcademyDonationResolution(router.state)) {
          const res = router.state.pendingAcademyDonationResolution!;
          logEvent("screen.renderTownVisit.academy-donation-resolution.start", {
            pageId: ctx.visit.pageId,
            tier: res.tier,
            totalDonated: res.totalDonated,
          });
          const donationBumps = await drainAcademyDonationResolutionViaModal(wrap, router);
          collectedBumps.push(...donationBumps);
          logEvent("screen.renderTownVisit.academy-donation-resolution.completed", {
            pageId: ctx.visit.pageId,
            collectedCount: donationBumps.length,
          });
        }
        if (hasPendingSuitConditionRankPicks(router.state)) {
          logEvent("screen.renderTownVisit.suit-condition-picker.start", {
            pageId: ctx.visit.pageId,
            pendingPickCount: router.state.pendingSuitConditionPicks.length,
          });
          const collected = await drainSuitConditionPicksViaModal(wrap, router);
          // No router.save() here — the picker already saves after
          // each pick internally. A save here would trigger a
          // TownVisit re-render while the page is still at page34
          // (before auto-advance fires), showing the storybook page
          // prematurely with a redundant Continue button.
          collectedBumps.push(...collected);
          if (collected.length > 0) {
            logEvent("screen.renderTownVisit.suit-condition-picker.completed", {
              pageId: ctx.visit.pageId,
              collectedCount: collected.length,
            });
          }
        }
        if (collectedBumps.length > 0) {
          await presentRewards(wrap, collectedBumps);
        }
      };
      void presentRewards(wrap, rewardEvents).then(afterRewardsModal).then(() => {
        // Online: a player who only resolved their own delver's picks
        // hands back here; the host continues the page.
        if (!onlineIsActorNow()) {
          router.refresh();
          return;
        }
        if (autoAdvanceOnRewardDismiss) {
          // On a single-exit narrative page, the modal's Continue
          // tap IS the page's Continue tap — surfacing a second
          // Continue button felt like "you're back where you
          // started". Advance straight to the next page; router.save
          // re-renders so the player lands on the new scene.
          logEvent("click.town-continue", {
            pageId: ctx.visit.pageId,
            toPageId: page.next ?? null,
            viaRewardDismiss: true,
          });
          advanceTownVisitPage(router.state);
          router.save();
          return;
        }
        if (page.layout === "image-choices") {
          // Deferred-layout pages render in the standard storybook
          // layout on first entry so the narrative text + rewards
          // sit together (see `pageHasPendingRewards` above). Now
          // that the player has collected the rewards, trigger a
          // full re-render so the page flips into its image-focus
          // layout — `applyOnEnter` is deduped by the engine, so
          // the re-render sees no pending rewards and uses the
          // image-choices layout for the "pick a place" prompt.
          logEvent("screen.renderTownVisit.image-choices.activate", {
            pageId: ctx.visit.pageId,
            via: "rewards-dismiss",
          });
          router.save();
          return;
        }
        if (page.postRewardsText) {
          // Same "swap-the-page" pattern as image-choices, just for
          // the body-text axis: the long intro prose played with the
          // Collect Rewards card; now that the player has dismissed
          // the modal the re-render swaps in the leaner post-rewards
          // copy (see `bodyText` resolution above). Shop pages benefit
          // most — the rules intro can finally make way for the
          // "When you are done shopping" instruction next to the
          // product grid — but the swap is generic. Same dedup
          // protection: `applyOnEnter` re-runs and emits no events,
          // so the rewards gate doesn't re-mount.
          logEvent("screen.renderTownVisit.post-rewards-text.activate", {
            pageId: ctx.visit.pageId,
            via: "rewards-dismiss",
          });
          router.save();
          return;
        }
        // Choice / shop pages: the player still needs to interact,
        // so drop the gate and reveal the real navigation buttons
        // in the same `.story-actions` slot.
        mountActions();
      });
    });
    actions.appendChild(btn);
  };
  const onReveal = () => {
    if (revealMounted) return;
    revealMounted = true;
    // A page that enqueued Suit Condition picks (e.g. the
    // page22-died-* "blood-soaked power" pages) or staged an
    // academy-donation resolution (page34-town-center-resolution)
    // still needs the rewards gate so the player explicitly
    // enters the picker / resolution modal — otherwise the page
    // silently advances with the pending interaction still live
    // and the next page would render the modal on top of itself.
    const hasPicks = hasPendingSuitConditionRankPicks(router.state);
    const hasDonation = hasPendingAcademyDonationResolution(router.state);
    logEvent("screen.renderTownVisit.actions-revealed", {
      pageId: ctx.visit.pageId,
      kind: page.kind,
      pendingRewards: rewardEvents.length,
      pendingSuitConditionPicks: hasPicks ? router.state.pendingSuitConditionPicks.length : 0,
      pendingAcademyDonation: hasDonation
        ? router.state.pendingAcademyDonationResolution!.tier
        : null,
    });
    if (rewardEvents.length > 0 || hasPicks || hasDonation) {
      mountCollectRewards();
    } else {
      mountActions();
    }
  };
  // image-choices pages omit the storybook article entirely — there
  // is no `[data-story-text]` to type into. Skip the typewriter
  // wholesale and fire onReveal synchronously so the rewards gate
  // (or, when there are no rewards, the navigation row) mounts
  // immediately. We still go through the same `onReveal` chain so
  // the `revealMounted` latch + rewards-gate behaviour stays
  // consistent across layouts.
  if (!textEl) {
    onReveal();
    wireSkipOnClick(wrap);
    return;
  }
  const tw = startTypewriter(textEl, onReveal);
  // Shop pages are interactive (wallets / buy buttons / Finish),
  // not narrative. Each purchase re-renders the screen via
  // `router.save()`, which would re-fire the typewriter on the
  // shop's intro prose — the prose would re-type from scratch and
  // the shop UI would vanish during the reveal gate, creating a
  // disruptive "the scene just moved on" flicker on every buy.
  // Fix: on shop pages, skip the typewriter the moment it starts so
  // the text is fully visible and `onReveal` fires immediately. The
  // first entry still triggers the rewards modal (via `onReveal`),
  // and re-renders mount the shop UI in place without any flicker.
  if (page.kind === "shop") {
    tw.skip();
  }
  // Tap-anywhere-to-skip: wire the whole screen wrap, not just the
  // storybook card, so clicks on the background / portrait /
  // decoration / empty space ALL fast-forward the reveal. Safe
  // because the action buttons are deferred until typewriter
  // completion — there's nothing else to accidentally interact with
  // during the reveal. Broadened 2026-05-18.
  wireSkipOnClick(wrap);
}

/**
 * Compute which delvers can afford a `TownVisitChoice.prePay` cost.
 * Returns the heroIds (preserving HEROES order) that satisfy the
 * requested resource floor. Today only `"minion-parts"` is supported
 * — future resources (boss-parts, memory chips) extend the switch.
 *
 * Empty result -> the choice can't be taken (button should be greyed
 * out). Single result -> auto-select that delver (no modal). 2+
 * results -> the player picks.
 */
function eligiblePayers(
  state: import("../state").CampaignState,
  prePay: NonNullable<import("../types").TownVisitChoice["prePay"]>,
): string[] {
  const out: string[] = [];
  for (const hero of HEROES) {
    let have = 0;
    switch (prePay.kind) {
      case "minion-parts":
        have = state.minionParts[hero.id] ?? 0;
        break;
    }
    if (have >= prePay.amount) out.push(hero.id);
  }
  return out;
}

/**
 * Run the pre-pay "who pays?" flow for a Town Visit choice, then
 * dispatch the choice navigation iff the player commits to a payer.
 *
 * - 1 eligible payer: silently flip `state.currentDelverId` to them
 *   and navigate (no modal — the player has no decision to make).
 * - 2+ eligible payers: mount `presentPayerPick`. On selection, flip
 *   `currentDelverId` and navigate. On cancel (Escape / backdrop /
 *   Cancel button), abort — the player stays on the parent choice
 *   page and can pick a different branch.
 *
 * `state.currentDelverId` is the engine's read-channel for
 * `to: "active-delver"` actions, so flipping it BEFORE the
 * `chooseTownVisitOption` call ensures the downstream
 * `lose-minion-parts` debits the chosen payer.
 *
 * Caller is responsible for ensuring `eligible` is non-empty (the
 * button would be disabled otherwise — this helper short-circuits
 * defensively if called with `[]` anyway, leaving the page state
 * untouched).
 */
async function runPrePayThenChoose(
  host: HTMLElement,
  router: Router,
  choice: import("../types").TownVisitChoice,
  eligible: string[],
): Promise<void> {
  if (eligible.length === 0) {
    logEvent("click.town-prePay.skip", {
      reason: "no-eligible-payers",
      decisionKey: choice.decisionKey,
    });
    return;
  }
  let payerId: string | null;
  if (eligible.length === 1) {
    payerId = eligible[0]!;
    logEvent("click.town-prePay.auto", {
      decisionKey: choice.decisionKey,
      payerId,
      reason: "single-eligible",
    });
  } else {
    const partsByHeroId: Record<string, number> = {};
    for (const id of eligible) {
      partsByHeroId[id] = router.state.minionParts[id] ?? 0;
    }
    const costLabel = `Cost: ${choice.prePay!.amount} minion part${choice.prePay!.amount === 1 ? "" : "s"}`;
    payerId = await presentPayerPick(host, {
      eligibleHeroIds: eligible,
      costLabel,
      prompt: "Who pays?",
      partsByHeroId,
    });
    if (!payerId) {
      logEvent("click.town-prePay.cancel", { decisionKey: choice.decisionKey });
      return;
    }
    logEvent("click.town-prePay.pick", {
      decisionKey: choice.decisionKey,
      payerId,
    });
  }
  // Defensive: confirm the picked id is actually in HEROES before
  // mutating state. A bad data round-trip shouldn't be able to
  // poison `currentDelverId`.
  try {
    getHero(payerId);
  } catch (err) {
    logEvent("click.town-prePay.invalid-payer", {
      decisionKey: choice.decisionKey,
      payerId,
      error: String(err),
    });
    return;
  }
  router.state.currentDelverId = payerId;
  chooseTownVisitOption(router.state, choice.decisionKey);
  router.save();
}

/**
 * Render the "Story Tokens remaining" chip that sits just under
 * the page subtitle on town-hub pages (the only pages that gate
 * choices on `requireStoryTokens`). We only emit it when the
 * page actually has at least one `requireStoryTokens`-gated
 * choice -- silent on every other story page, so beats that
 * don't care about the pool stay visually unchanged.
 *
 * Counting the remaining tokens is just a read of
 * `state.storyTokens` because the engine decrements it inside
 * `chooseTownVisitOption` whenever the player commits to a
 * gated choice -- so the chip is always live without needing
 * any per-page hookup in the JSON.
 */
function renderStoryTokensCounter(
  page: { choices?: ReadonlyArray<{ requireStoryTokens?: string }> },
  storyTokens: number,
): string {
  const gated = (page.choices ?? []).some(
    (c) => c.requireStoryTokens === "positive" || c.requireStoryTokens === "zero",
  );
  if (!gated) return "";
  const label = storyTokens === 1 ? "Story Token" : "Story Tokens";
  return `
    <div class="storybook-story-tokens" data-story-tokens-remaining>
      <span class="story-tokens-chip">
        <span class="story-tokens-chip-label">${escapeHtml(label)} remaining:</span>
        <span class="story-tokens-chip-count">${storyTokens}</span>
      </span>
    </div>
  `;
}

/**
 * Returns Arlen's reaction quote for the Academy donation resolution
 * page, keyed to the actual donation total in state. The format
 * matches what the player would read off the printed card.
 */
function arlenDonationReaction(state: Parameters<typeof totalAcademyDonation>[0]): string {
  const tier = donationTierForTotal(totalAcademyDonation(state));
  switch (tier) {
    case "none":
      return "Arlen says \"You're a kick-the-ladder-out-from-under-you type, I see.\"";
    case "small":
      return "Arlen says \"Thank you. With this, we'll be able to arm our new recruits with more than just the standard issue equipment.\"";
    case "medium":
      return "Arlen says \"That's very generous. Our new students are going to be well armed for their first foray into the Tide, thanks to you.\"";
    case "large":
      return "Arlen says \"This... this is incredible! Now we can equip the new students with our most state-of-the-art equipment!\"";
  }
}

/** Ch3 "Experimental Division" reaction — keyed off the campaign
 *  RUNNING donation total, matching the printed Ch3 table. */
function arlenDonationReactionCh3(state: Parameters<typeof totalAcademyDonation>[0]): string {
  const tier = donationTierForTotal(state.academyDonationLifetime, "ch3");
  switch (tier) {
    case "none":
      return "Arlen says \"What goes around comes around, you know.\"";
    case "small":
      return "Arlen says \"We'll have to make do with this.\"";
    case "medium":
      return "Arlen says \"Our next set of experiments are off to a strong start thanks to you.\"";
    case "large":
      return "Arlen says \"This... this is remarkably generous! Your donation will be put to good use, I promise.\"";
  }
}

/** Ch4 "Experimental Division" reaction (running total 11 / 21 / 35). */
function arlenDonationReactionCh4(state: Parameters<typeof totalAcademyDonation>[0]): string {
  switch (donationTierForTotal(state.academyDonationLifetime, "ch4")) {
    case "none": return 'Arlen says "You hide your ungratefulness well."';
    case "small": return 'Arlen says "You could have spared a few more creature parts, but I suppose beggars can' + "'" + 't be choosers."';
    case "medium": return 'Arlen says "That is very giving of you."';
    case "large": return 'Arlen says "You continue to surpass my highest expectations."';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Chapter 2 end ────────────────────────────────────────────────────

function downloadCampaignFile(state: Router["state"]): void {
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `gone-to-gaia-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Shows a full-screen overlay informing the player that Chapter 2 is
 * the current end of the app, and gives them the option to download
 * their campaign progress before returning to the Title screen.
 *
 * Called after `finishTownVisit` has already been applied, so the
 * downloaded state captures a fully-completed Chapter 2 save.
 */
function showChapterEndOverlay(router: Router, chapterNumber: number): void {
  const overlay = document.createElement("div");
  overlay.className = "ch2-end-overlay";
  overlay.innerHTML = `
    <div class="ch2-end-modal">
      <h2>End of Chapter ${chapterNumber}</h2>
      <p>
        The app currently ends here. Chapter ${chapterNumber + 1} and beyond are in development.
      </p>
      <p>
        We recommend downloading your progress so you can continue your campaign
        from this point when future chapters are added.
      </p>
      <div class="ch2-end-actions">
        <button class="btn btn--accent" data-action="download-and-exit">
          Download progress and return to Title screen
        </button>
        <button class="btn btn--ghost" data-action="skip-and-exit">
          Don't download progress and return to Title screen
        </button>
      </div>
    </div>
  `;

  overlay.querySelector<HTMLButtonElement>("[data-action='download-and-exit']")
    ?.addEventListener("click", () => {
      downloadCampaignFile(router.state);
      overlay.remove();
      router.goTo({ name: "title" });
    });

  overlay.querySelector<HTMLButtonElement>("[data-action='skip-and-exit']")
    ?.addEventListener("click", () => {
      overlay.remove();
      router.goTo({ name: "title" });
    });

  document.body.appendChild(overlay);
}
