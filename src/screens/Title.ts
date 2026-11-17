import type { Router } from "../main";
import { clearCampaign, newCampaign, saveCampaign, loadCampaignFromJson } from "../state";
import { clearAllUiState } from "../uiState";
import { resetStoryProgress } from "./Story";
import { startTownVisit } from "../engine/townVisit";
import { startStoryParticles } from "./storyParticles";
import { logEvent } from "../debug/sessionLog";
import { simulateCampaignTo, type QuickStartChapter } from "../debug/quickStart";
import {
  currentSession,
  forgetRememberedSession,
  hostGame,
  joinGame,
  leaveGame,
  rejoin,
  rememberedSession,
  transportLabel,
} from "../net/onlineController";
import { pickHostRole, showJoinDialog } from "../net/onlineDialogs";
import { roleLabel, otherRole } from "../net/roles";

export function renderTitle(root: HTMLElement, router: Router): void {
  const wrap = document.createElement("div");
  wrap.className = "screen screen--title";

  wrap.innerHTML = `
    <h1 class="title-logo">Gone to Gaia</h1>
  `;

  const buttons = document.createElement("div");
  buttons.className = "title-buttons";

  // --- Online co-op ------------------------------------------------------
  // Guests get a reduced title screen: the host drives every campaign-
  // level action (start, upload, quick start, reset).
  const online = currentSession();
  if (online && online.seat === "guest") {
    renderGuestTitle(root, wrap, buttons, router);
    return;
  }
  if (online) {
    buttons.appendChild(sessionPanel());
    const endBtn = button("END ONLINE GAME", () => {
      if (!confirm(`End online session ${online.code} for both players?`)) return;
      void leaveGame().catch((e: Error) => alert(`Could not end the session: ${e.message}`));
    });
    endBtn.classList.add("btn--danger");
    buttons.appendChild(endBtn);
  } else {
    appendOnlineEntryButtons(buttons, router);
  }

  // "Resume" if there's a wave in progress (encounter !== null), else
  // "Begin". The encounter field is the single source of truth for
  // mid-quest state. Fresh "Begin" goes through the Story screen for
  // the quest intro narrative; Resume goes straight to the board.
  //
  // A mid-flow Town Visit takes precedence over a fresh quest start
  // so the player doesn't accidentally lose their narrative position
  // by hitting Start. Mid-wave is still the highest priority — if
  // somehow both an encounter AND a town visit exist, finish the
  // wave first.
  const inProgress = router.state.encounter !== null;
  const inTownVisit = !inProgress && router.state.townVisit !== null;
  // "Continue Quest 2 Intro" appears once Ch1 has been completed
  // (which auto-flips `currentQuestId` to "quest2") but the player
  // hasn't started Q2 yet (no encounter). Otherwise we'd label
  // their natural progression "Start" which reads like a fresh
  // campaign reset \u2014 misleading after they've already played Q1.
  const isPastQ1Intro =
    !inProgress && !inTownVisit && router.state.currentQuestId !== "quest1";
  // A save that finished Chapter 2 before Chapter 3 shipped lands
  // here with no visit in progress — offer the Ch3 Town Visit.
  const readyForCh3 =
    !inProgress && !inTownVisit
    && router.state.townVisit2Completed && !router.state.townVisit3Completed;
  const readyForCh4 =
    !inProgress && !inTownVisit
    && router.state.townVisit3Completed && !router.state.townVisit4Completed;
  let startLabel: string;
  if (inProgress) startLabel = "Continue";
  else if (inTownVisit) startLabel = "Continue Town Visit";
  else if (readyForCh3) startLabel = "Continue \u2192 Chapter 3";
  else if (readyForCh4) startLabel = "Continue \u2192 Chapter 4";
  else if (isPastQ1Intro) startLabel = "Continue \u2192 Quest 2 Intro";
  else startLabel = "Start";
  const startBtn = button(startLabel, () => void (async () => {
    // Online host: a fresh campaign always asks for a role; continuing
    // asks only if no role has been picked in this session yet.
    const gate = startLabel === "Start"
      ? await hostRoleGate("always", "You're starting a new campaign.")
      : await hostRoleGate("ifUnset", "You're continuing this campaign online.");
    if (!gate) return;
    if (inProgress) {
      router.goTo({ name: "board" });
    } else if (inTownVisit) {
      router.goTo({ name: "townVisit" });
    } else if (readyForCh3) {
      startTownVisit(router.state, "ch3");
      router.save();
      router.goTo({ name: "townVisit" });
    } else if (readyForCh4) {
      startTownVisit(router.state, "ch4");
      router.save();
      router.goTo({ name: "townVisit" });
    } else {
      resetStoryProgress();
      router.goTo({ name: "story" });
    }
  })());
  buttons.appendChild(startBtn);

  // Secondary "Continue Town Visit" — only relevant when the main
  // start button is locked into "Continue" (board) because there's
  // an encounter in progress. In that case the player still needs a
  // way to resume a parked town visit if both states coexist (rare,
  // but possible: encounter started, town visit was parked from a
  // previous chapter). When there's NO encounter, the main button
  // above already says "Continue Town Visit" and routes there — so
  // duplicating it here would produce two identical buttons (which
  // it did, until the `inProgress` gate was added on 2026-05-18 in
  // response to the screenshotted duplicate-button bug).
  if (inProgress && router.state.townVisit !== null) {
    const tvBtn = button("Continue Town Visit", () => router.goTo({ name: "townVisit" }));
    buttons.appendChild(tvBtn);
  }

  // Hide the Campaign Sheet on a fresh campaign (nothing meaningful
  // to show yet). Show it once the player has any progress.
  const isFreshCampaign = startLabel === "Start";
  if (!isFreshCampaign) {
    const sheetBtn = button("View Campaign Sheet", () => router.goTo({ name: "campaignSheet" }));
    sheetBtn.classList.add("btn--ghost");
    buttons.appendChild(sheetBtn);
  }

  const dataBtn = button("View Loaded Data", () => router.goTo({ name: "dataViewer" }));
  dataBtn.classList.add("btn--ghost");
  // buttons.appendChild(dataBtn); // hidden — keep logic for future use

  // Debug shortcut: jump straight to Quest 2's intro without
  // replaying Q1 + Ch1 town visit. Useful while Q2's Wave 1 spawn-
  // deck + Fatal Flaw engine is being built — lets us test the
  // intro narrative repeatedly in isolation, and (once Phase B
  // lands) the spawn-deck encounter without a Q1 prelude every
  // time. Currently it will hit the "Quest 2 - Wave 1 not yet
  // wired" placeholder on BoardScreen after the intro, which is
  // the intended UX until the engine catches up.
  //
  // Confirms first because it wipes any in-progress encounter /
  // town visit / debug session state. Disabled while there's an
  // active encounter so the user can't accidentally lose mid-wave
  // state — they must finish or reset the wave first.
  const startQ2Btn = button("Start from Quest 2 (debug)", () => {
    if (router.state.encounter !== null) {
      alert(
        "Finish or reset your current wave first before jumping to Quest 2.",
      );
      return;
    }
    if (
      !confirm(
        "Jump straight to Quest 2's intro?\n\n" +
          "This skips Quest 1 and Chapter 1's Town Visit. Your active " +
          "Town Visit (if any) will be cleared. Campaign progress " +
          "(parts, memory chips, hero unlocks, key items, favour, " +
          "opinion cards, owned shop products) is kept. Per-quest " +
          "stats (HP, current level, XP on hand, level-up queue) are " +
          "reset as if Q2 was starting fresh.",
      )
    ) {
      return;
    }
    jumpToQuest("quest2", router);
  });
  startQ2Btn.classList.add("btn--ghost");
  // buttons.appendChild(startQ2Btn); // hidden — keep logic for future use

  // Show Reset whenever there's ANY progress to wipe — an active
  // encounter, accumulated XP, completed quests, or stockpiled
  // tokens. Previously we only checked totalXp / quest1Completed,
  // which hid the Reset button while the player was mid-wave with no
  // kills yet.
  const hasAnyProgress =
    inProgress ||
    router.state.quest1Completed ||
    router.state.totalXp > 0 ||
    router.state.currentLevel > 1 ||
    router.state.levelUpCardsOwed > 0 ||
    router.state.townVisit !== null;

  // Download Progress — exports the current campaign as a JSON file
  // the player can keep and re-upload on a future version of the app
  // to continue their campaign. Only shown when there's progress to
  // save (mirrors the Campaign Sheet visibility rule).
  if (hasAnyProgress) {
    const dlBtn = button("Download Progress", () => {
      downloadCampaign(router.state);
      logEvent("campaign.export");
    });
    dlBtn.classList.add("btn--ghost", "btn--save");
    buttons.appendChild(dlBtn);
  }

  // Upload Progress — always shown so a returning playtester can
  // load their save on any device / fresh copy of the app.
  const ulBtn = button("Upload Progress", () => {
    void triggerUpload(router, hasAnyProgress);
  });
  ulBtn.classList.add("btn--ghost", "btn--save");
  buttons.appendChild(ulBtn);

  // Debug: simulate an average party up to the start of Chapter 2/3/4.
  for (const chapter of [2, 3, 4] as const) {
    const qsBtn = button(`Quick Start Chapter ${chapter}`, () => void quickStartChapter(chapter, router, hasAnyProgress));
    qsBtn.classList.add("btn--ghost");
    buttons.appendChild(qsBtn);
  }

  if (hasAnyProgress) {
    const resetBtn = button("Reset Campaign Save", () => {
      if (confirm("Erase all campaign progress?")) {
        currentSession()?.hostTakeControl();
        clearCampaign();
        Object.assign(router.state, newCampaign());
        // Wipe ephemeral UI state too (peek, selected card, armed
        // ability, open modal) — a fresh save shouldn't inherit them
        // from the previous run.
        clearAllUiState();
        router.save();
      }
    });
    resetBtn.classList.add("btn--danger");
    buttons.appendChild(resetBtn);
  }

  wrap.appendChild(buttons);
  root.appendChild(wrap);

  // Ambient drifting particles behind the title content. The canvas
  // self-cleans when `wrap` is detached (the rAF loop checks
  // `host.isConnected` each tick), so navigating away from the title
  // tears the loop down without any explicit teardown call here.
  startStoryParticles(wrap);
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// --- Campaign save/load helpers ------------------------------------------

/**
 * Trigger a browser file-download of the full campaign state as a
 * pretty-printed JSON file. The filename embeds today's date so
 * players can keep multiple snapshots.
 */
function downloadCampaign(state: Parameters<typeof saveCampaign>[0]): void {
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  a.href = url;
  a.download = `gone-to-gaia-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Open a file-picker for `.json` save files, then:
 *   1. If a campaign is already in progress, offer to download it first.
 *   2. Parse + migrate the uploaded file.
 *   3. Write it to state, save, and refresh.
 */
async function triggerUpload(router: Router, hasActiveCampaign: boolean): Promise<void> {
  const file = await pickJsonFile();
  if (!file) return;

  // Offer to back up the current campaign before overwriting it.
  if (hasActiveCampaign) {
    if (confirm("You have an active campaign.\n\nDownload your current progress before loading the new file?")) {
      downloadCampaign(router.state);
    }
  }

  const raw = await file.text();
  let imported;
  try {
    imported = loadCampaignFromJson(raw);
  } catch {
    alert("Could not read the save file — it may be corrupted or not a valid campaign file.");
    return;
  }
  if (!imported) {
    alert("This save file is too old to load, or is not a valid campaign file.");
    return;
  }
  if (!(await hostRoleGate("always", "You're loading a campaign from a file."))) return;

  // Commit the imported state.
  saveCampaign(imported);
  Object.assign(router.state, imported);
  clearAllUiState();
  router.save();
  logEvent("campaign.import", { version: imported.version });
  router.refresh();
}

/** Resolve with the chosen File, or null if the user cancelled. */
function pickJsonFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", () => {
      resolve(input.files?.[0] ?? null);
    });
    // Cancelled — browsers don't fire "change", so use a focus-return
    // heuristic: if the window regains focus and no file was chosen,
    // resolve with null after a short delay.
    window.addEventListener("focus", function onFocus() {
      window.removeEventListener("focus", onFocus);
      setTimeout(() => {
        if (!input.files?.length) resolve(null);
      }, 300);
    }, { once: true });
    input.click();
  });
}

/**
 * DEBUG: replace the save with a simulated campaign (see
 * `debug/quickStart.ts`) and drop the player at the start of `chapter`:
 * Ch2 -> Quest #2's intro, Ch3/Ch4 -> the chapter's Town Visit.
 */
async function quickStartChapter(chapter: QuickStartChapter, router: Router, hasActiveCampaign: boolean): Promise<void> {
  if (hasActiveCampaign && !confirm(
    `Quick Start Chapter ${chapter}?\n\nThis REPLACES your current campaign save with a simulated ` +
      `party that has played up to the start of Chapter ${chapter}.`,
  )) return;
  let simulated;
  try {
    simulated = simulateCampaignTo(chapter);
  } catch (e) {
    logEvent("debug.quickStart.error", { chapter, message: (e as Error).message });
    alert(`Quick Start Chapter ${chapter} failed — your save was not changed.\n\n${(e as Error).message}`);
    return;
  }
  if (!(await hostRoleGate("always", `You're quick-starting Chapter ${chapter}.`))) return;
  clearCampaign();
  Object.assign(router.state, simulated);
  clearAllUiState();
  router.save();
  logEvent("debug.quickStart", { chapter });
  if (chapter === 2) {
    resetStoryProgress();
    router.goTo({ name: "story" });
  } else {
    router.goTo({ name: "townVisit" });
  }
}

/**
 * DEBUG helper: hard-reset the campaign to a fresh state, then
 * fast-forward the Q1 + Ch1 completion flags so the target quest
 * starts "as if" the player had finished the prerequisites
 * naturally.
 *
 * We deliberately reuse `newCampaign()` (not "preserve current
 * progress + override the questId") so the debug start is
 * predictable across runs — every press of the debug button puts
 * the campaign in the same known state. If you need to test a
 * quest with accumulated parts / shop products / opinion cards
 * from earlier, play through normally; the debug button is
 * specifically the "blank-slate at this quest" entry point.
 *
 * Wired by the Title screen's "Start from Quest 2 (debug)"
 * button. Will accept other quest ids in the future as more
 * quests need testing without re-playing the campaign.
 */
function jumpToQuest(questId: string, router: Router): void {
  clearCampaign();
  const fresh = newCampaign();
  // Pretend the player finished Q1 + Ch1 naturally. These flags
  // gate the narrative routing decisions in the engine; without
  // them, end-of-wave routing on a Q2 victory might try to send
  // the player back to a Ch1 visit they "never" did.
  fresh.quest1Completed = true;
  fresh.townVisit1Completed = true;
  fresh.currentQuestId = questId;
  Object.assign(router.state, fresh);
  clearAllUiState();
  resetStoryProgress();
  router.save();
  logEvent("debug.jumpToQuest", { questId });
  router.goTo({ name: "story" });
}

// --- Online co-op title helpers -------------------------------------------

/**
 * Online host only (no-op offline / for guests): ask the host to pick
 * Mind or Body, store it on the room, and take the acting seat so the
 * campaign change that follows is accepted. Resolves false on Cancel.
 */
async function hostRoleGate(mode: "always" | "ifUnset", reason: string): Promise<boolean> {
  const s = currentSession();
  if (!s || s.seat !== "host") return true;
  if (mode === "ifUnset" && s.hostRole !== null) return true;
  const role = await pickHostRole(reason);
  if (role === null) return false;
  try {
    await s.hostSetRole(role);
  } catch (e) {
    alert(`Could not save your role choice: ${(e as Error).message}`);
    return false;
  }
  s.hostTakeControl();
  logEvent("online.role", { hostRole: role });
  return true;
}

/** HOST GAME / JOIN GAME (+ REJOIN when this browser remembers a session). */
function appendOnlineEntryButtons(buttons: HTMLElement, router: Router): void {
  const remembered = rememberedSession();
  if (remembered) {
    const rejoinBtn = button(`REJOIN GAME ${remembered.code}`, () => void rejoin(remembered, true));
    rejoinBtn.classList.add("btn--online");
    buttons.appendChild(rejoinBtn);
    const forgetBtn = button("Forget that game", () => {
      forgetRememberedSession();
      router.refresh();
    });
    forgetBtn.classList.add("btn--ghost");
    buttons.appendChild(forgetBtn);
  }
  const hostBtn = button("HOST GAME", () => {
    hostBtn.disabled = true;
    hostGame().catch((e: Error) => {
      hostBtn.disabled = false;
      alert(`Could not host a game: ${e.message}`);
    });
  });
  hostBtn.classList.add("btn--online");
  buttons.appendChild(hostBtn);
  const joinBtn = button("JOIN GAME", () => showJoinDialog((code) => joinGame(code)));
  joinBtn.classList.add("btn--online");
  buttons.appendChild(joinBtn);
}

/** Code + roles + connection, shown at the top of the title buttons. */
function sessionPanel(): HTMLElement {
  const s = currentSession()!;
  const panel = document.createElement("div");
  panel.className = "online-panel";
  const line = (cls: string, text: string) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    panel.appendChild(d);
  };
  line("online-panel__line", s.seat === "host" ? "Online game - give your friend this code:" : "Online game");
  line("online-panel__code", s.code);
  const my = s.myRole;
  if (my === null) {
    line("online-panel__line", s.seat === "host"
      ? "You'll pick Mind or Body when you start or load a campaign."
      : "Waiting for the host to pick roles and start.");
  } else {
    line("online-panel__line", `You play ${roleLabel(my)} · your friend plays ${roleLabel(otherRole(my))}`);
  }
  if (s.seat === "host") {
    line("online-panel__line", s.hasGuest
      ? (s.peerOnline() ? "Your friend is connected." : "Your friend is disconnected - they can rejoin with the same code.")
      : "Waiting for a player to join...");
  } else {
    line("online-panel__line", s.peerOnline() ? "Host is connected." : "Host is disconnected - waiting for them to come back.");
  }
  line("online-panel__mode", `(${transportLabel()})`);
  return panel;
}

/** Guest title: watch-only - the host drives campaign-level actions. */
function renderGuestTitle(root: HTMLElement, wrap: HTMLElement, buttons: HTMLElement, router: Router): void {
  const s = currentSession()!;
  buttons.appendChild(sessionPanel());
  const screen = s.snapshotScreen;
  if (screen !== null) {
    const goBtn = button("GO TO GAME", () => router.goTo({ name: screen }));
    goBtn.classList.add("btn--online");
    buttons.appendChild(goBtn);
  }
  if (s.hasSnapshot) {
    const sheetBtn = button("View Campaign Sheet", () => router.goTo({ name: "campaignSheet" }));
    sheetBtn.classList.add("btn--ghost");
    buttons.appendChild(sheetBtn);
    const dlBtn = button("Download Progress", () => {
      downloadCampaign(router.state);
      logEvent("campaign.export", { online: true });
    });
    dlBtn.classList.add("btn--ghost", "btn--save");
    buttons.appendChild(dlBtn);
  }
  const leaveBtn = button("LEAVE ONLINE GAME", () => {
    if (!confirm(`Leave online session ${s.code}? You can join again with the same code.`)) return;
    void leaveGame().catch((e: Error) => alert(`Could not leave the session: ${e.message}`));
  });
  leaveBtn.classList.add("btn--danger");
  buttons.appendChild(leaveBtn);
  wrap.appendChild(buttons);
  root.appendChild(wrap);
  startStoryParticles(wrap);
}
