/**
 * Firebase Realtime Database room transport (two computers, over the
 * internet). Selected by `NET_TRANSPORT = "firebase"` in `netConfig.ts`.
 *
 * Data layout — one node per room, same shape as `RoomDoc`:
 *   /rooms/{code} = { code, createdAt, hostClientId, guestClientId,
 *                     hostRole, ended, snapshot: {rev, by, at, stateJson,
 *                     screen, storyPage}, presence: {clientId: serverMs} }
 *
 * RTDB gotchas handled here:
 *   - It deletes null-valued keys and empty objects, so every read goes
 *     through `normalizeRoom` (missing → null / {} / false).
 *   - `stateJson` stays a string (it would drop empty arrays otherwise).
 *   - A transaction handler is first called with the LOCAL cache, which
 *     can be null even when the room exists. Handlers therefore return
 *     null (not abort) on a null input; the server then re-runs them
 *     with the real value. Outcomes are checked after commit.
 *   - Presence is written with the server clock and converted to this
 *     computer's clock via `.info/serverTimeOffset`, so "disconnected"
 *     works even when the two computers' clocks disagree.
 *
 * Sign-in: anonymous auth (must be enabled in the Firebase console).
 * The game's client ids stay random per tab (not the auth uid) so two
 * tabs in one browser can still hold different seats for testing.
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import {
  get,
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  runTransaction,
  serverTimestamp,
  set,
  type Database,
} from "firebase/database";
import { FIREBASE_CONFIG } from "./netConfig";
import { RoomError, type DelverRole, type FlowScreen, type RoomDoc, type RoomSnapshot, type RoomTransport } from "./types";

/** Turn a raw RTDB value into a complete `RoomDoc` (null → room missing). */
export function normalizeRoom(raw: unknown, serverOffsetMs = 0): RoomDoc | null {
  if (raw === null || raw === undefined) return null;
  const r = raw as Partial<RoomDoc> & { snapshot?: Partial<RoomSnapshot> | null };
  if (typeof r.code !== "string" || typeof r.hostClientId !== "string") {
    throw new Error(`Corrupt online room data: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  const presence: Record<string, number> = {};
  for (const [id, ms] of Object.entries(r.presence ?? {})) {
    if (typeof ms === "number") presence[id] = ms - serverOffsetMs;
  }
  const s = r.snapshot ?? null;
  return {
    code: r.code,
    createdAt: r.createdAt ?? 0,
    hostClientId: r.hostClientId,
    guestClientId: r.guestClientId ?? null,
    hostRole: r.hostRole ?? null,
    ended: r.ended ?? false,
    presence,
    snapshot: s === null
      ? null
      : {
          rev: s.rev ?? 0,
          by: s.by ?? "",
          at: s.at ?? 0,
          stateJson: s.stateJson ?? "",
          screen: (s.screen ?? null) as FlowScreen | null,
          storyPage: s.storyPage ?? 0,
          promptJson: s.promptJson ?? "",
          busy: s.busy ?? false,
        },
  };
}

/** Explain the two setup mistakes players will actually hit. */
function explain(e: unknown): Error {
  const err = e as { code?: string; message?: string };
  const msg = err.message ?? String(e);
  if (err.code === "auth/operation-not-allowed" || err.code === "auth/admin-restricted-operation") {
    return new Error("Anonymous sign-in is turned off. In the Firebase console: Security → Authentication → Sign-in method → Anonymous → Enable.");
  }
  if (/permission[_ ]denied/i.test(msg)) {
    return new Error("The Realtime Database rules refused access. Publish the rules from the README (Multiplayer section) in the Firebase console.");
  }
  return e instanceof Error ? e : new Error(msg);
}

export class FirebaseRoomTransport implements RoomTransport {
  readonly kind = "firebase" as const;
  readonly label = "online via Firebase";
  private readonly app: FirebaseApp;
  private readonly db: Database;
  private readonly signedIn: Promise<void>;
  private serverOffsetMs = 0;
  private readonly disconnectArmed = new Set<string>();

  constructor() {
    if (FIREBASE_CONFIG === null) {
      throw new RoomError("not-configured", "Firebase is selected in src/net/netConfig.ts but FIREBASE_CONFIG is empty.");
    }
    this.app = initializeApp(FIREBASE_CONFIG, "g2g-online");
    this.db = getDatabase(this.app);
    onValue(ref(this.db, ".info/serverTimeOffset"), (s) => {
      this.serverOffsetMs = Number(s.val() ?? 0);
    });
    this.signedIn = signInAnonymously(getAuth(this.app)).then(() => undefined);
  }

  private async ready(): Promise<void> {
    try {
      await this.signedIn;
    } catch (e) {
      throw explain(e);
    }
  }

  private roomRef(code: string) {
    return ref(this.db, `rooms/${code}`);
  }

  private async mustRead(code: string): Promise<RoomDoc> {
    const doc = await this.getRoom(code);
    if (doc === null) throw new RoomError("not-found", `No session with code ${code}.`);
    if (doc.ended) throw new RoomError("ended", `Session ${code} has ended.`);
    return doc;
  }

  async createRoom(hostClientId: string): Promise<RoomDoc> {
    await this.ready();
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      const fresh = {
        code,
        createdAt: Date.now(),
        hostClientId,
        guestClientId: null,
        hostRole: null,
        snapshot: null,
        presence: { [hostClientId]: serverTimestamp() },
        ended: false,
      };
      let taken = false;
      try {
        const res = await runTransaction(this.roomRef(code), (cur: unknown) => {
          taken = false;
          if (cur !== null && !(cur as { ended?: boolean }).ended) {
            taken = true;
            return undefined; // abort: code in use
          }
          return fresh;
        });
        if (res.committed && !taken) return normalizeRoom(res.snapshot.val(), this.serverOffsetMs)!;
      } catch (e) {
        throw explain(e);
      }
    }
    throw new RoomError("no-free-code", "Could not find a free 4-digit session code. Try again.");
  }

  async getRoom(code: string): Promise<RoomDoc | null> {
    await this.ready();
    try {
      return normalizeRoom((await get(this.roomRef(code))).val(), this.serverOffsetMs);
    } catch (e) {
      throw explain(e);
    }
  }

  async claimGuestSeat(code: string, clientId: string): Promise<RoomDoc> {
    await this.ready();
    let failure: RoomError | null = null;
    let res;
    try {
      res = await runTransaction(this.roomRef(code), (cur: Record<string, unknown> | null) => {
        failure = null;
        if (cur === null) return null; // cache miss — server re-runs with the real value
        if (cur.ended) {
          failure = new RoomError("ended", `Session ${code} has ended.`);
          return undefined;
        }
        if (cur.hostClientId === clientId) {
          failure = new RoomError("not-member", `You are already the host of session ${code}.`);
          return undefined;
        }
        const guest = (cur.guestClientId as string | undefined) ?? null;
        if (guest !== null && guest !== clientId) {
          failure = new RoomError("full", `Session ${code} already has two players.`);
          return undefined;
        }
        cur.guestClientId = clientId;
        cur.presence = { ...((cur.presence as object | undefined) ?? {}), [clientId]: serverTimestamp() };
        return cur;
      });
    } catch (e) {
      throw explain(e);
    }
    if (failure) throw failure;
    const doc = normalizeRoom(res.snapshot.val(), this.serverOffsetMs);
    if (doc === null) throw new RoomError("not-found", `No session with code ${code}.`);
    return doc;
  }

  async releaseGuestSeat(code: string, clientId: string): Promise<void> {
    await this.ready();
    try {
      await runTransaction(this.roomRef(code), (cur: Record<string, unknown> | null) => {
        if (cur === null) return null;
        if (cur.guestClientId !== clientId) return undefined;
        cur.guestClientId = null;
        const presence = { ...((cur.presence as Record<string, unknown> | undefined) ?? {}) };
        delete presence[clientId];
        cur.presence = presence;
        return cur;
      });
    } catch (e) {
      throw explain(e);
    }
  }

  async setHostRole(code: string, role: DelverRole | null): Promise<void> {
    await this.mustRead(code);
    try {
      await set(ref(this.db, `rooms/${code}/hostRole`), role);
    } catch (e) {
      throw explain(e);
    }
  }

  async pushSnapshot(code: string, snap: RoomSnapshot): Promise<void> {
    // RTDB aborts a transaction with the error "set" when another write
    // (e.g. this client's presence heartbeat) lands on the room mid-way.
    // That abort means "nothing was written — run it again", not a
    // failure; anything else still throws.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pushSnapshotOnce(code, snap);
        return;
      } catch (e) {
        if (attempt >= 3 || !(e instanceof Error) || e.message !== "set") throw e;
      }
    }
  }

  private async pushSnapshotOnce(code: string, snap: RoomSnapshot): Promise<void> {
    await this.ready();
    let failure: RoomError | null = null;
    let res;
    try {
      res = await runTransaction(this.roomRef(code), (cur: Record<string, unknown> | null) => {
        failure = null;
        if (cur === null) return null;
        if (cur.ended) {
          failure = new RoomError("ended", `Session ${code} has ended.`);
          return undefined;
        }
        const prevRev = ((cur.snapshot as { rev?: number } | undefined)?.rev) ?? 0;
        if (snap.rev !== prevRev + 1) {
          failure = new RoomError("stale-revision", `Session ${code} moved on (have rev ${prevRev}, tried to write rev ${snap.rev}).`);
          return undefined;
        }
        cur.snapshot = { ...snap };
        return cur;
      });
    } catch (e) {
      throw explain(e);
    }
    if (failure) throw failure;
    const written = normalizeRoom(res.snapshot.val(), this.serverOffsetMs);
    if (written === null) throw new RoomError("not-found", `No session with code ${code}.`);
    if (written.snapshot?.rev !== snap.rev || written.snapshot.by !== snap.by) {
      throw new RoomError("stale-revision", `Session ${code} moved on while sending your move.`);
    }
  }

  async heartbeat(code: string, clientId: string): Promise<void> {
    await this.ready();
    const presenceRef = ref(this.db, `rooms/${code}/presence/${clientId}`);
    try {
      const key = `${code}/${clientId}`;
      if (!this.disconnectArmed.has(key)) {
        // Firebase clears our presence the moment this tab drops, so the
        // other player sees "disconnected" without waiting for a timeout.
        await onDisconnect(presenceRef).remove();
        this.disconnectArmed.add(key);
      }
      await set(presenceRef, serverTimestamp());
    } catch (e) {
      throw explain(e);
    }
  }

  async endRoom(code: string): Promise<void> {
    await this.ready();
    try {
      await set(ref(this.db, `rooms/${code}/ended`), true);
    } catch (e) {
      throw explain(e);
    }
  }

  subscribe(code: string, cb: (doc: RoomDoc | null) => void, onError: (e: Error) => void): () => void {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    this.ready().then(
      () => {
        if (cancelled) return;
        unsub = onValue(
          this.roomRef(code),
          (s) => {
            try {
              cb(normalizeRoom(s.val(), this.serverOffsetMs));
            } catch (e) {
              onError(e as Error);
            }
          },
          (e) => onError(explain(e)),
        );
      },
      (e: Error) => onError(e),
    );
    return () => {
      cancelled = true;
      unsub?.();
    };
  }
}
