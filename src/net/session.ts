/**
 * OnlineSession — the DOM-free core of online co-op.
 *
 * Owns: this client's identity + seat, the room subscription, the
 * shared-state baseline, publish/apply of full-state snapshots, and the
 * "who may act" rule. The browser glue (`onlineController.ts`) wires it
 * to the Router, timers and the HUD.
 *
 * Authority rule (see `roles.ts`): a local change is accepted only if
 * this client's seat is the acting seat of the LAST SHARED state
 * (`baselineActor`). Deciding on the pre-change state matters: the
 * guest's End Turn flips the phase to the host's control, and that
 * very commit must still be accepted.
 *
 * Rejected changes are rolled back to the baseline (the caller then
 * re-renders + tells the player whose turn it is). There is no merge:
 * if two publishes race, the loser gets `stale-revision`, shows an
 * error and reloads the room's latest snapshot.
 */
import type { CampaignState } from "../state";
import { actingRole, actingSeat, NO_ACTOR_CONTEXT, roleForSeat, type ActorContext } from "./roles";
import { PEER_TIMEOUT_MS } from "./netConfig";
import type { KeyValueStore } from "./localTransport";
import { RoomError, type DelverRole, type FlowScreen, type RoomDoc, type RoomSnapshot, type RoomTransport, type Seat } from "./types";

/** Persisted so a refresh / reopened browser can rejoin. */
export interface SessionRecord {
  code: string;
  clientId: string;
  seat: Seat;
}

export const SESSION_RECORD_KEY = "g2g.net.session";

export interface SessionBridge {
  getState(): CampaignState;
  getFlowScreen(): FlowScreen | null;
  getStoryPage(): number;
  /** The relayed prompt open on this client (JSON, see `RoomSnapshot.promptJson`), or "". */
  getPrompt(): string;
  /** This client is mid-flow (see `roles.ts > ActorContext.busy`). */
  getBusy(): boolean;
  /** Which delver's player must answer a relayed prompt ("" → null). */
  promptDeciderRole(promptJson: string): DelverRole | null;
  /** Replace the live campaign with a remote snapshot and redraw. */
  applyRemote(state: CampaignState, screen: FlowScreen | null, storyPage: number, promptJson: string): void;
  /** Replace the live campaign contents (rollback) — no redraw. */
  replaceState(state: CampaignState): void;
}

export interface SessionEvents {
  /** Anything shown in the HUD changed (room, presence, role, seat). */
  status(): void;
  /** A problem the player must see. */
  error(message: string): void;
  /** The session is over (host ended it, or the room vanished). */
  ended(message: string): void;
}

export type CommitResult = "ok" | "rejected";

export class OnlineSession {
  private doc: RoomDoc | null = null;
  private unsubscribe: (() => void) | null = null;
  private baselineJson: string;
  private baselineActor: Seat = "host";
  /** Prompt + busy flag that go with the baseline (published / received). */
  private baselinePrompt = "";
  private baselineBusy = false;
  private lastRev = 0;
  private lastPublished: { json: string; screen: FlowScreen | null; storyPage: number; promptJson: string; busy: boolean } | null = null;
  private publishScheduled = false;
  private publishChain: Promise<void> = Promise.resolve();
  /** False until the first snapshot is applied — that one always
   *  redraws (and routes) so a resumed client lands back in the game. */
  private appliedOnce = false;

  private constructor(
    private readonly transport: RoomTransport,
    readonly record: SessionRecord,
    private readonly bridge: SessionBridge,
    private readonly events: SessionEvents,
    private readonly schedule: (fn: () => void) => void,
    private readonly now: () => number,
  ) {
    this.baselineJson = JSON.stringify(bridge.getState());
  }

  // --- lifecycle --------------------------------------------------------

  static async host(deps: SessionDeps): Promise<OnlineSession> {
    const clientId = deps.newClientId();
    const doc = await deps.transport.createRoom(clientId);
    const s = new OnlineSession(deps.transport, { code: doc.code, clientId, seat: "host" }, deps.bridge, deps.events, deps.schedule, deps.now);
    s.attach(doc);
    return s;
  }

  static async join(deps: SessionDeps, code: string): Promise<OnlineSession> {
    if (!/^\d{4}$/.test(code)) throw new RoomError("not-found", "Session codes are 4 digits.");
    const clientId = deps.newClientId();
    const doc = await deps.transport.claimGuestSeat(code, clientId);
    const s = new OnlineSession(deps.transport, { code, clientId, seat: "guest" }, deps.bridge, deps.events, deps.schedule, deps.now);
    s.attach(doc);
    return s;
  }

  /**
   * Rejoin after a refresh / dropped connection, keeping the same seat.
   * `fromOtherWindow` = the record came from the browser-wide memory
   * (REJOIN button), not this tab's own: refuse while that seat is still
   * heartbeating, i.e. open in another window, so one seat never ends
   * up driven from two windows.
   */
  static async resume(deps: SessionDeps, record: SessionRecord, fromOtherWindow = false): Promise<OnlineSession> {
    if (fromOtherWindow) {
      const live = await deps.transport.getRoom(record.code);
      const seen = live?.presence[record.clientId];
      if (seen !== undefined && deps.now() - seen <= PEER_TIMEOUT_MS) {
        throw new RoomError(
          "not-member",
          `Session ${record.code} is still open in another window on this device. Close it there (or wait a few seconds) and try again.`,
        );
      }
    }
    let doc: RoomDoc;
    if (record.seat === "guest") {
      doc = await deps.transport.claimGuestSeat(record.code, record.clientId);
    } else {
      const found = await deps.transport.getRoom(record.code);
      if (found === null) throw new RoomError("not-found", `Session ${record.code} no longer exists.`);
      if (found.ended) throw new RoomError("ended", `Session ${record.code} has ended.`);
      if (found.hostClientId !== record.clientId) {
        throw new RoomError("not-member", `This computer is no longer the host of session ${record.code}.`);
      }
      doc = found;
    }
    const s = new OnlineSession(deps.transport, record, deps.bridge, deps.events, deps.schedule, deps.now);
    s.attach(doc);
    return s;
  }

  /** Host: end the session for both players. Guest: free the seat. */
  async leave(): Promise<void> {
    this.detach();
    if (this.record.seat === "host") await this.transport.endRoom(this.record.code);
    else await this.transport.releaseGuestSeat(this.record.code, this.record.clientId);
  }

  /** Stop listening without telling the room (used when the room ended). */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async heartbeat(): Promise<void> {
    await this.transport.heartbeat(this.record.code, this.record.clientId);
  }

  private attach(doc: RoomDoc): void {
    this.unsubscribe = this.transport.subscribe(
      doc.code,
      (d) => this.onRoom(d),
      (e) => this.events.error(`Lost the connection to session ${doc.code}: ${e.message}`),
    );
    // A brand-new room has nothing to land on; only a resume/join into
    // a room that already has a snapshot needs the forced first apply.
    if (doc.snapshot === null) this.appliedOnce = true;
    this.onRoom(doc);
  }

  // --- status -----------------------------------------------------------

  get code(): string { return this.record.code; }
  get seat(): Seat { return this.record.seat; }
  get hostRole(): DelverRole | null { return this.doc?.hostRole ?? null; }
  get myRole(): DelverRole | null {
    const hr = this.hostRole;
    return hr === null ? null : roleForSeat(this.seat, hr);
  }
  get hasGuest(): boolean { return (this.doc?.guestClientId ?? null) !== null; }
  get hasSnapshot(): boolean { return (this.doc?.snapshot ?? null) !== null; }
  get snapshotScreen(): FlowScreen | null { return this.doc?.snapshot?.screen ?? null; }

  /** Seat allowed to change the campaign right now. */
  get actor(): Seat { return this.baselineActor; }
  get canAct(): boolean { return this.baselineActor === this.seat; }

  /** Role of the player who acts now (null until the host picks roles). */
  get actorRole(): DelverRole | null {
    const hr = this.hostRole;
    return hr === null ? null : actingRole(JSON.parse(this.baselineJson) as CampaignState, hr, this.baselineCtx());
  }

  private ctxFor(promptJson: string, busy: boolean): ActorContext {
    if (promptJson === "" && !busy) return NO_ACTOR_CONTEXT;
    return { promptDeciderRole: this.bridge.promptDeciderRole(promptJson), busy };
  }

  private baselineCtx(): ActorContext {
    return this.ctxFor(this.baselinePrompt, this.baselineBusy);
  }

  /** Guests never overwrite their own single-player save on this device. */
  get persistsLocally(): boolean { return this.seat === "host"; }

  peerOnline(): boolean {
    const doc = this.doc;
    if (doc === null) return false;
    const peerId = this.seat === "host" ? doc.guestClientId : doc.hostClientId;
    if (peerId === null) return false;
    const seen = doc.presence[peerId];
    return seen !== undefined && this.now() - seen <= PEER_TIMEOUT_MS;
  }

  // --- host controls ----------------------------------------------------

  /**
   * Host is about to replace / reset the whole campaign from the title
   * screen (fresh Start, Upload Progress, Quick Start, Reset). Takes the
   * acting seat so that commit is accepted even mid-way through the
   * guest's turn. The next commit recomputes the actor from the new state.
   */
  hostTakeControl(): void {
    if (this.seat !== "host") throw new Error("Only the host can replace the campaign.");
    this.baselineActor = "host";
    this.events.status();
  }

  /** Host picks Mind or Body; the guest gets the other. */
  async hostSetRole(role: DelverRole): Promise<void> {
    if (this.seat !== "host") throw new Error("Only the host picks roles.");
    await this.transport.setHostRole(this.code, role);
    if (this.doc) this.doc.hostRole = role;
    this.baselineActor = actingSeat(JSON.parse(this.baselineJson) as CampaignState, role, this.baselineCtx());
    this.events.status();
  }

  // --- local commits ------------------------------------------------------

  /**
   * Called by the router on every save/persist/goTo/refresh. Accepts the
   * change (and schedules a publish) when this client may act;
   * otherwise rolls the campaign back to the shared baseline.
   */
  commit(): CommitResult {
    const json = JSON.stringify(this.bridge.getState());
    if (!this.canAct) {
      // A watcher's own UI (open viewers, the mirrored prompt) never
      // counts; only a campaign change is refused and rolled back.
      if (json === this.baselineJson) return "ok";
      this.bridge.replaceState(JSON.parse(this.baselineJson) as CampaignState);
      return "rejected";
    }
    const promptJson = this.bridge.getPrompt();
    const busy = this.bridge.getBusy();
    const changed = json !== this.baselineJson || promptJson !== this.baselinePrompt || busy !== this.baselineBusy;
    this.baselineJson = json;
    this.baselinePrompt = promptJson;
    this.baselineBusy = busy;
    if (changed) this.baselineActor = actingSeat(this.bridge.getState(), this.hostRole, this.baselineCtx());
    this.schedulePublish();
    if (changed) this.events.status();
    return "ok";
  }

  /** Resolves once every scheduled publish has been written. */
  async flush(): Promise<void> {
    await this.publishChain;
  }

  private schedulePublish(): void {
    if (this.publishScheduled) return;
    this.publishScheduled = true;
    this.schedule(() => {
      this.publishScheduled = false;
      this.publishChain = this.publishChain.then(() => this.publishNow());
    });
  }

  private async publishNow(): Promise<void> {
    // Only accepted commits schedule a publish, so no actor check here:
    // the commit that hands the turn to the other player must still go
    // out. Publish the accepted baseline, not whatever is live now.
    if (this.unsubscribe === null) return;
    const json = this.baselineJson;
    const promptJson = this.baselinePrompt;
    const busy = this.baselineBusy;
    const screen = this.bridge.getFlowScreen();
    const storyPage = this.bridge.getStoryPage();
    const lp = this.lastPublished;
    if (lp && lp.json === json && lp.screen === screen && lp.storyPage === storyPage
      && lp.promptJson === promptJson && lp.busy === busy) return;
    const snap: RoomSnapshot = {
      rev: this.lastRev + 1,
      by: this.record.clientId,
      at: this.now(),
      stateJson: json,
      screen,
      storyPage,
      promptJson,
      busy,
    };
    try {
      await this.transport.pushSnapshot(this.code, snap);
      this.lastRev = Math.max(this.lastRev, snap.rev);
      this.lastPublished = { json, screen, storyPage, promptJson, busy };
    } catch (e) {
      if (e instanceof RoomError && e.kind === "stale-revision") {
        this.events.error("Both players changed the game at once — reloading the latest shared state.");
        const doc = await this.transport.getRoom(this.code);
        if (doc?.snapshot) this.applySnapshot(doc.snapshot, true);
        return;
      }
      this.events.error(`Could not send your move: ${(e as Error).message}`);
    }
  }

  // --- remote changes -------------------------------------------------------

  private onRoom(doc: RoomDoc | null): void {
    if (doc === null) {
      this.detach();
      this.events.ended(`Session ${this.code} no longer exists.`);
      return;
    }
    if (doc.ended) {
      this.doc = doc;
      this.detach();
      this.events.ended(`The host ended session ${this.code}.`);
      return;
    }
    if (this.seat === "guest" && doc.guestClientId !== this.record.clientId) {
      this.doc = doc;
      this.detach();
      this.events.ended(`Another player took your seat in session ${this.code}.`);
      return;
    }
    const roleChanged = (this.doc?.hostRole ?? null) !== doc.hostRole;
    this.doc = doc;
    if (doc.snapshot && doc.snapshot.rev > this.lastRev) {
      this.applySnapshot(doc.snapshot, false);
    } else if (roleChanged) {
      this.baselineActor = actingSeat(JSON.parse(this.baselineJson) as CampaignState, doc.hostRole, this.baselineCtx());
    }
    this.events.status();
  }

  private applySnapshot(snap: RoomSnapshot, force: boolean): void {
    this.lastRev = Math.max(this.lastRev, snap.rev);
    const mine = snap.by === this.record.clientId;
    const parsed = JSON.parse(snap.stateJson) as CampaignState;
    this.baselineJson = snap.stateJson;
    this.baselinePrompt = snap.promptJson;
    this.baselineBusy = snap.busy;
    this.baselineActor = actingSeat(parsed, this.hostRole, this.baselineCtx());
    this.lastPublished = {
      json: snap.stateJson, screen: snap.screen, storyPage: snap.storyPage, promptJson: snap.promptJson, busy: snap.busy,
    };
    const first = !this.appliedOnce;
    this.appliedOnce = true;
    // Our own echo: local state already matches.
    if (mine && !force && !first && JSON.stringify(this.bridge.getState()) === snap.stateJson) return;
    this.bridge.applyRemote(parsed, snap.screen, snap.storyPage, snap.promptJson);
  }
}

export interface SessionDeps {
  transport: RoomTransport;
  bridge: SessionBridge;
  events: SessionEvents;
  newClientId: () => string;
  schedule: (fn: () => void) => void;
  now: () => number;
}

// --- session record persistence ------------------------------------------

/**
 * Two copies: per-tab (sessionStorage) so two tabs on one computer can
 * hold different seats and each auto-rejoins after a refresh; and
 * per-browser (localStorage) so a closed browser can offer "Rejoin".
 */
export function saveSessionRecord(tab: KeyValueStore, browser: KeyValueStore, rec: SessionRecord): void {
  const raw = JSON.stringify(rec);
  tab.setItem(SESSION_RECORD_KEY, raw);
  browser.setItem(SESSION_RECORD_KEY, raw);
}

export function clearSessionRecord(tab: KeyValueStore, browser: KeyValueStore, code: string): void {
  tab.removeItem(SESSION_RECORD_KEY);
  const b = readSessionRecord(browser);
  if (b !== null && b.code === code) browser.removeItem(SESSION_RECORD_KEY);
}

export function readSessionRecord(store: KeyValueStore): SessionRecord | null {
  const raw = store.getItem(SESSION_RECORD_KEY);
  if (raw === null) return null;
  const rec = JSON.parse(raw) as SessionRecord;
  if (typeof rec.code !== "string" || typeof rec.clientId !== "string" || (rec.seat !== "host" && rec.seat !== "guest")) {
    throw new Error(`Corrupt online session record in storage: ${raw}`);
  }
  return rec;
}
