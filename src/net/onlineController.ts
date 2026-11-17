/**
 * Browser glue for online co-op: one `OnlineSession` per tab, wired to
 * the Router (via `installOnline`), timers, storage and the HUD.
 *
 * main.ts calls `onlineCommit()` from every router save/persist/goTo/
 * refresh; a `false` return means the change was rolled back because
 * it's the other player's turn (or the host drives this part).
 */
import type { CampaignState } from "../state";
import type { ScreenName } from "../main";
import { getStoryPage, onStoryPageTurn, setStoryPage } from "../screens/Story";
import { logEvent } from "../debug/sessionLog";
import { LocalRoomTransport, browserChangeChannel } from "./localTransport";
import { FirebaseRoomTransport } from "./firebaseTransport";
import { HEARTBEAT_MS, NET_TRANSPORT } from "./netConfig";
import {
  OnlineSession,
  clearSessionRecord,
  readSessionRecord,
  saveSessionRecord,
  type SessionDeps,
  type SessionRecord,
} from "./session";
import { actingSeat, delverIdForRole, otherRole, roleForDelverId, roleLabel, type ActorContext } from "./roles";
import { getArmedAbility, getModal, setModal, type Modal } from "../uiState";
import { RoomError, type DelverRole, type FlowScreen, type RoomTransport } from "./types";
import { mountOnlineHud, showOnlineToast, updateOnlineHud } from "./onlineHud";

export interface OnlineRouterHooks {
  state: CampaignState;
  getActive(): ScreenName;
  /** Navigate without publishing (remote-driven). */
  show(screen: ScreenName): void;
  /** Re-render the active screen, keeping scroll. */
  rerender(): void;
  /** Campaign to fall back to when a guest leaves: their own local save. */
  loadLocalCampaign(): CampaignState;
}

const FLOW_SCREENS: ReadonlySet<string> = new Set<FlowScreen>(["board", "story", "townVisit"]);
const VIEWER_SCREENS: ReadonlySet<string> = new Set(["campaignSheet", "dataViewer", "counterAttackViewer"]);

let hooks: OnlineRouterHooks | null = null;
let transport: RoomTransport | null = null;
let session: OnlineSession | null = null;
let lastFlowScreen: FlowScreen | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function h(): OnlineRouterHooks {
  if (!hooks) throw new Error("installOnline() must run before online play is used.");
  return hooks;
}

function getTransport(): RoomTransport {
  if (transport) return transport;
  transport = NET_TRANSPORT === "firebase"
    ? new FirebaseRoomTransport()
    : new LocalRoomTransport(localStorage, browserChangeChannel());
  return transport;
}

function replaceStateContents(target: CampaignState, next: CampaignState): void {
  const t = target as unknown as Record<string, unknown>;
  for (const k of Object.keys(t)) if (!(k in next)) delete t[k];
  Object.assign(target, next);
}

// --- relayed prompts + "busy" ----------------------------------------------
//
// Sol / Lunar Shield prompts can belong to the delver whose player is NOT
// running the current flow (a tile-mate during a counterattack, or either
// delver during Parting Shots). The flow owner's client relays the open
// prompt in the snapshot; the bearer's client shows it and answers; the
// owner's client finishes the flow (it holds the attack session).

/** Modal kinds that are relayed to the shield bearer's player. */
const RELAYED_MODALS: ReadonlySet<Modal["kind"]> = new Set<Modal["kind"]>(["shield-prompt", "parting-shot-shield-prompt"]);

/**
 * Modals that are a queued per-delver choice (state-driven, see
 * `roles.ts > pendingChoiceOwner`) or only for looking. An open one does
 * not make the flow owner "busy".
 */
const NOT_BUSY_MODALS: ReadonlySet<Modal["kind"]> = new Set<Modal["kind"]>([
  "level-up", "element-pick", "suit-condition-rank-pick", "opinion-rank-pick", "equipment-roll",
  "xp-roll", "creature-part-pick", "ritual-pick", "scenario-card", "friendly-encounter",
  "scenario-delver-pick", "rules-viewer", "shield-prompt", "parting-shot-shield-prompt",
]);

/** Role of the player whose flow a relayed prompt belongs to (null = no relay running). */
let relayOwnerRole: DelverRole | null = null;

interface RelayedPrompt { modal: Modal; ownerRole: DelverRole }

/** Which delver's player must answer `modal` (a relayed kind). Past the
 *  last bearer the prompt goes back to the owner, who finishes the flow. */
function relayedDecider(modal: Modal, ownerRole: DelverRole): DelverRole {
  if (modal.kind !== "shield-prompt" && modal.kind !== "parting-shot-shield-prompt") return ownerRole;
  const op = modal.queue[modal.cursor];
  return op ? roleForDelverId(op.shieldBearerHeroId) : ownerRole;
}

function localPromptJson(): string {
  const m = getModal();
  const mine = session?.myRole ?? null;
  if (!m || !RELAYED_MODALS.has(m.kind) || mine === null) {
    relayOwnerRole = null;
    return "";
  }
  if (relayOwnerRole === null) relayOwnerRole = mine;
  const p: RelayedPrompt = { modal: m, ownerRole: relayOwnerRole };
  return JSON.stringify(p);
}

function localBusy(): boolean {
  if (getArmedAbility() !== null) return true;
  const m = getModal();
  return m !== null && !NOT_BUSY_MODALS.has(m.kind);
}

/** Mirror a received relayed prompt into this client's modal. */
function applyRemotePrompt(promptJson: string): void {
  if (promptJson !== "") {
    const p = JSON.parse(promptJson) as RelayedPrompt;
    relayOwnerRole = p.ownerRole;
    setModal(p.modal);
    return;
  }
  if (relayOwnerRole === null) return;
  // The relay ended. The owner already moved on locally; the other
  // player drops the mirrored prompt.
  const m = getModal();
  if (m && RELAYED_MODALS.has(m.kind) && relayOwnerRole !== (session?.myRole ?? null)) setModal(null);
  relayOwnerRole = null;
}

/**
 * True when this client finishes a relayed prompt's flow: offline, no
 * relay running, or it is the relay's owner. The other player's client
 * only records its answer and hands the prompt back.
 */
export function isRelayedPromptOwner(): boolean {
  if (!session || relayOwnerRole === null) return true;
  return relayOwnerRole === session.myRole;
}

/**
 * May this client act on the live campaign right now? Always true
 * offline. Uses the LIVE state (not the last commit), so a modal that
 * just resolved a choice can ask "is the next step still mine?" before
 * it continues the flow.
 */
export function onlineIsActorNow(): boolean {
  if (!session) return true;
  const hr = session.hostRole;
  if (hr === null) return session.seat === "host";
  const ctx: ActorContext = { promptDeciderRole: null, busy: false };
  return actingSeat(h().state, hr, ctx) === session.seat;
}

/** The delver this client plays online, or null offline / before roles. */
export function onlineMyDelverId(): string | null {
  const r = session?.myRole ?? null;
  return r === null ? null : delverIdForRole(r);
}

/** Fired after a remote snapshot replaced the campaign and redrew. */
export const REMOTE_APPLIED_EVENT = "g2g:remote-applied";

function deps(): SessionDeps {
  const hk = h();
  return {
    transport: getTransport(),
    newClientId: () => crypto.randomUUID(),
    schedule: (fn) => queueMicrotask(fn),
    now: () => Date.now(),
    bridge: {
      getState: () => hk.state,
      getFlowScreen: () => {
        const a = hk.getActive().name;
        if (FLOW_SCREENS.has(a)) lastFlowScreen = a as FlowScreen;
        return lastFlowScreen;
      },
      getStoryPage: () => getStoryPage(),
      getPrompt: () => localPromptJson(),
      getBusy: () => localBusy(),
      promptDeciderRole: (promptJson) => {
        if (promptJson === "") return null;
        const p = JSON.parse(promptJson) as RelayedPrompt;
        return relayedDecider(p.modal, p.ownerRole);
      },
      replaceState: (next) => replaceStateContents(hk.state, next),
      applyRemote: (next, screen, storyPage, promptJson) => {
        replaceStateContents(hk.state, next);
        setStoryPage(storyPage);
        applyRemotePrompt(promptJson);
        const active = hk.getActive().name;
        if (screen !== null && !VIEWER_SCREENS.has(active) && active !== screen) {
          lastFlowScreen = screen;
          hk.show({ name: screen });
        } else {
          hk.rerender();
        }
        document.dispatchEvent(new CustomEvent(REMOTE_APPLIED_EVENT));
      },
    },
    events: {
      status: () => refreshHud(),
      error: (msg) => {
        logEvent("online.error", { message: msg });
        showOnlineToast(msg, "error");
      },
      ended: (msg) => endLocally(msg),
    },
  };
}

// --- public API ------------------------------------------------------------

/** Called once from main.ts after the router exists. Auto-rejoins this tab's session. */
export function installOnline(routerHooks: OnlineRouterHooks): void {
  hooks = routerHooks;
  mountOnlineHud();
  onStoryPageTurn((prevIdx) => {
    if (!session) return;
    if (!session.canAct) {
      setStoryPage(prevIdx);
      h().rerender();
      showOnlineToast(notYourMoveText(), "info");
      return;
    }
    session.commit();
  });
  const tabRecord = readSessionRecord(sessionStorage);
  if (tabRecord) void rejoin(tabRecord);
}

export function currentSession(): OnlineSession | null {
  return session;
}

export function transportLabel(): string {
  return getTransport().label;
}

/** A remembered session from an earlier visit that this tab isn't in. */
export function rememberedSession(): SessionRecord | null {
  if (session) return null;
  return readSessionRecord(localStorage);
}

/**
 * Router hook. Returns false when the change was rolled back.
 * `user` = a player action (shows "not your turn"); `render` = a
 * screen mutating state while mounting (silently discarded on the
 * watching client — the acting client's copy is the one that counts).
 */
export function onlineCommit(kind: "user" | "render"): boolean {
  if (!session) return true;
  const result = session.commit();
  if (result === "ok") return true;
  logEvent("online.rejected", { kind, actor: session.actor, seat: session.seat });
  if (kind === "user") showOnlineToast(notYourMoveText(), "info");
  return false;
}

/** Guests never overwrite their own single-player save. */
export function onlinePersistsLocally(): boolean {
  return session === null || session.persistsLocally;
}

export async function hostGame(): Promise<void> {
  if (session) throw new Error(`Already in session ${session.code}.`);
  start(await OnlineSession.host(deps()));
  logEvent("online.host", { code: session!.code });
}

export async function joinGame(code: string): Promise<void> {
  if (session) throw new Error(`Already in session ${session.code}.`);
  start(await OnlineSession.join(deps(), code));
  logEvent("online.join", { code });
}

/** `fromOtherWindow`: record came from the browser-wide REJOIN memory, not this tab. */
export async function rejoin(record: SessionRecord, fromOtherWindow = false): Promise<void> {
  try {
    start(await OnlineSession.resume(deps(), record, fromOtherWindow));
    logEvent("online.rejoin", { code: record.code, seat: record.seat });
    showOnlineToast(`Reconnected to session ${record.code}.`, "info");
  } catch (e) {
    // Still open elsewhere: keep the memory so REJOIN works once that window closes.
    const stillLive = fromOtherWindow && e instanceof RoomError && e.kind === "not-member" && /another window/.test(e.message);
    if (!stillLive) clearSessionRecord(sessionStorage, localStorage, record.code);
    logEvent("online.rejoin.failed", { code: record.code, message: (e as Error).message });
    showOnlineToast(`Could not rejoin session ${record.code}: ${(e as Error).message}`, "error");
    h().rerender();
  }
}

/** Host: ends the session for both. Guest: leaves and gets their own save back. */
export async function leaveGame(): Promise<void> {
  const s = session;
  if (!s) return;
  await s.leave();
  endLocally(s.seat === "host" ? `You ended session ${s.code}.` : `You left session ${s.code}.`);
}

/** Forget a remembered session without rejoining it. */
export function forgetRememberedSession(): void {
  const rec = readSessionRecord(localStorage);
  if (rec) clearSessionRecord(sessionStorage, localStorage, rec.code);
}

// --- internals ---------------------------------------------------------------

function start(s: OnlineSession): void {
  session = s;
  saveSessionRecord(sessionStorage, localStorage, s.record);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const beat = () => {
    if (!session) return;
    session.heartbeat().catch((e: Error) => showOnlineToast(`Connection problem: ${e.message}`, "error"));
    refreshHud();
  };
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  refreshHud();
  h().rerender();
}

function endLocally(message: string): void {
  const s = session;
  if (!s) return;
  s.detach();
  session = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clearSessionRecord(sessionStorage, localStorage, s.code);
  lastFlowScreen = null;
  const hk = h();
  if (s.seat === "guest") replaceStateContents(hk.state, hk.loadLocalCampaign());
  showOnlineToast(message, "info");
  refreshHud();
  hk.show({ name: "title" });
}

function notYourMoveText(): string {
  if (!session) return "";
  const actor = session.actorRole;
  if (actor === null) return "The host drives this part of the game — watch along.";
  return `${roleLabel(actor)}'s player is choosing — watch along.`;
}

/** What the title-screen session panel shows; redraw the title when it changes. */
let lastTitleKey = "";

function refreshHud(): void {
  const s = session;
  const titleKey = s
    ? [s.code, s.seat, s.hostRole, s.hasGuest, s.peerOnline(), s.hasSnapshot, s.snapshotScreen].join("|")
    : "offline";
  if (titleKey !== lastTitleKey) {
    lastTitleKey = titleKey;
    if (hooks && hooks.getActive().name === "title") hooks.rerender();
  }
  if (!s) {
    updateOnlineHud(null);
    return;
  }
  const my = s.myRole;
  const peerLabel = my === null ? (s.seat === "host" ? "Guest" : "Host") : `${roleLabel(otherRole(my))}'s player`;
  let watching: string | null = null;
  if (!s.canAct) {
    const actor = s.actorRole;
    watching = actor === null ? "Host is choosing" : `${roleLabel(actor)} player is choosing`;
  }
  updateOnlineHud({
    code: s.code,
    you: my === null ? (s.seat === "host" ? "Host (pick a role to start)" : "Guest (host picks roles)") : roleLabel(my),
    peer: s.seat === "host" && !s.hasGuest ? "waiting for a player to join" : `${peerLabel} ${s.peerOnline() ? "connected" : "disconnected"}`,
    peerOk: s.peerOnline(),
    watching,
    myRole: my,
    notMyTurn: (() => {
      const enc = h().state.encounter;
      return my !== null && enc !== null && enc.phase === "hero" && h().state.currentDelverId !== delverIdForRole(my);
    })(),
  });
}
