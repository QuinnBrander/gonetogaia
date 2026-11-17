/**
 * Same-browser room transport — for testing online co-op with two
 * tabs/windows on ONE computer, before Firebase is hooked up.
 *
 * Rooms live in `localStorage` under `g2g.net.room.<code>` (so they
 * survive a refresh, which is what lets the reconnect flow be tested),
 * and a `BroadcastChannel` pings other tabs when a room changes. Two
 * different computers can NOT reach each other through this transport.
 *
 * Storage + channel are injected so tests can run two "tabs" against
 * an in-memory store.
 */
import { RoomError, type DelverRole, type RoomDoc, type RoomSnapshot, type RoomTransport } from "./types";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Cross-tab "room changed" notifications. Must NOT echo to the sender. */
export interface ChangeChannel {
  post(code: string): void;
  listen(cb: (code: string) => void): () => void;
}

export const LOCAL_ROOM_KEY_PREFIX = "g2g.net.room.";
/** Presence lives in its own key per client so a heartbeat never
 *  read-modify-writes (and clobbers) the room doc another tab just wrote. */
export const LOCAL_PRESENCE_KEY_PREFIX = "g2g.net.presence.";

export function browserChangeChannel(name = "g2g-net-rooms"): ChangeChannel {
  const bc = new BroadcastChannel(name);
  return {
    post: (code) => bc.postMessage(code),
    listen: (cb) => {
      const h = (e: MessageEvent) => cb(String(e.data));
      bc.addEventListener("message", h);
      return () => bc.removeEventListener("message", h);
    },
  };
}

export class LocalRoomTransport implements RoomTransport {
  readonly kind = "local" as const;
  readonly label = "same-computer test mode";
  private readonly subs = new Map<string, Set<(doc: RoomDoc | null) => void>>();

  constructor(
    private readonly store: KeyValueStore,
    private readonly channel: ChangeChannel,
    private readonly random: () => number = Math.random,
    private readonly now: () => number = Date.now,
  ) {
    this.channel.listen((code) => this.notifyLocal(code));
  }

  async createRoom(hostClientId: string): Promise<RoomDoc> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = String(1000 + Math.floor(this.random() * 9000));
      const existing = this.read(code);
      if (existing !== null && !existing.ended) continue;
      const doc: RoomDoc = {
        code,
        createdAt: this.now(),
        hostClientId,
        guestClientId: null,
        hostRole: null,
        snapshot: null,
        presence: {},
        ended: false,
      };
      this.writePresence(code, hostClientId);
      this.write(doc);
      return doc;
    }
    throw new RoomError("no-free-code", "Could not find a free 4-digit session code. Try again.");
  }

  async getRoom(code: string): Promise<RoomDoc | null> {
    return this.read(code);
  }

  async claimGuestSeat(code: string, clientId: string): Promise<RoomDoc> {
    const doc = this.mustRead(code);
    if (doc.hostClientId === clientId) {
      throw new RoomError("not-member", `You are already the host of session ${code}.`);
    }
    if (doc.guestClientId !== null && doc.guestClientId !== clientId) {
      throw new RoomError("full", `Session ${code} already has two players.`);
    }
    doc.guestClientId = clientId;
    this.writePresence(code, clientId);
    this.write(doc);
    return doc;
  }

  async releaseGuestSeat(code: string, clientId: string): Promise<void> {
    const doc = this.read(code);
    if (doc === null || doc.guestClientId !== clientId) return;
    doc.guestClientId = null;
    this.store.removeItem(this.presenceKey(code, clientId));
    this.write(doc);
  }

  async setHostRole(code: string, role: DelverRole | null): Promise<void> {
    const doc = this.mustRead(code);
    doc.hostRole = role;
    this.write(doc);
  }

  async pushSnapshot(code: string, snap: RoomSnapshot): Promise<void> {
    const doc = this.mustRead(code);
    const prevRev = doc.snapshot?.rev ?? 0;
    if (snap.rev !== prevRev + 1) {
      throw new RoomError(
        "stale-revision",
        `Session ${code} moved on (have rev ${prevRev}, tried to write rev ${snap.rev}).`,
      );
    }
    doc.snapshot = snap;
    this.write(doc);
  }

  async heartbeat(code: string, clientId: string): Promise<void> {
    const doc = this.read(code);
    if (doc === null || doc.ended) return;
    this.writePresence(code, clientId);
    this.notifyLocal(code);
    this.channel.post(code);
  }

  async endRoom(code: string): Promise<void> {
    const doc = this.read(code);
    if (doc === null) return;
    doc.ended = true;
    this.write(doc);
  }

  subscribe(code: string, cb: (doc: RoomDoc | null) => void, _onError: (e: Error) => void): () => void {
    let set = this.subs.get(code);
    if (!set) {
      set = new Set();
      this.subs.set(code, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  // --- internals -------------------------------------------------------

  private read(code: string): RoomDoc | null {
    const raw = this.store.getItem(LOCAL_ROOM_KEY_PREFIX + code);
    if (raw === null) return null;
    const doc = JSON.parse(raw) as RoomDoc;
    doc.presence = {};
    for (const id of [doc.hostClientId, doc.guestClientId]) {
      if (id === null) continue;
      const seen = this.store.getItem(this.presenceKey(code, id));
      if (seen !== null) doc.presence[id] = Number(seen);
    }
    return doc;
  }

  private presenceKey(code: string, clientId: string): string {
    return `${LOCAL_PRESENCE_KEY_PREFIX}${code}.${clientId}`;
  }

  private writePresence(code: string, clientId: string): void {
    this.store.setItem(this.presenceKey(code, clientId), String(this.now()));
  }

  private mustRead(code: string): RoomDoc {
    const doc = this.read(code);
    if (doc === null) throw new RoomError("not-found", `No session with code ${code}.`);
    if (doc.ended) throw new RoomError("ended", `Session ${code} has ended.`);
    return doc;
  }

  private write(doc: RoomDoc): void {
    this.store.setItem(LOCAL_ROOM_KEY_PREFIX + doc.code, JSON.stringify({ ...doc, presence: {} }));
    this.notifyLocal(doc.code);
    this.channel.post(doc.code);
  }

  private notifyLocal(code: string): void {
    const set = this.subs.get(code);
    if (!set || set.size === 0) return;
    const doc = this.read(code);
    for (const cb of [...set]) cb(doc);
  }
}
