/**
 * Online co-op data model (shared by every transport).
 *
 * One "room" per online session, addressed by a 4-digit code. The
 * shape is deliberately flat + JSON-only so it maps 1:1 onto a
 * Firebase Realtime Database node at `/rooms/{code}` later (see
 * `firebaseTransport.ts`). The campaign travels as a JSON *string*
 * (`stateJson`) rather than a nested object because RTDB silently
 * drops empty arrays / nulls / empty objects, which would corrupt a
 * `CampaignState` round-trip.
 *
 * Sync model: full-state snapshots. Whichever client is allowed to
 * act (see `roles.ts > actingSeat`) publishes the whole campaign +
 * its current game-flow screen after each change; the other client
 * replaces its copy and redraws.
 */

/** Which chair a client sits in. The host created the room. */
export type Seat = "host" | "guest";

/** Which delver a player controls. Mind = `hero-01`, Body = `hero-02`. */
export type DelverRole = "mind" | "body";

/**
 * Screens that are part of the shared game flow. Viewer screens
 * (campaign sheet, data viewer, counter-attack viewer) and the title
 * screen are local to each client and never published.
 */
export type FlowScreen = "board" | "story" | "townVisit";

export interface RoomSnapshot {
  /** Monotonic revision; each publish must be exactly previous + 1. */
  rev: number;
  /** Client id of the publisher. */
  by: string;
  /** Publish time (ms since epoch, publisher's clock). */
  at: number;
  /** `JSON.stringify(CampaignState)`. */
  stateJson: string;
  /** The publisher's current game-flow screen, or null if it has
   *  never entered one (e.g. still on the title screen). */
  screen: FlowScreen | null;
  /** Story screen page cursor (only meaningful when screen = story). */
  storyPage: number;
  /**
   * A relayed on-screen prompt (Shield) as JSON `{modal, ownerRole}`, or
   * "" for none. A string (not null) because RTDB drops nulls.
   */
  promptJson: string;
  /** The publisher was mid-flow (see `roles.ts > ActorContext.busy`). */
  busy: boolean;
}

export interface RoomDoc {
  code: string;
  createdAt: number;
  hostClientId: string;
  /** Null until a guest claims the seat (or after the guest leaves). */
  guestClientId: string | null;
  /** Role the host picked; the guest gets the other one. Null until
   *  the host picks (reset whenever the host replaces the campaign). */
  hostRole: DelverRole | null;
  snapshot: RoomSnapshot | null;
  /** Last heartbeat per client id (ms since epoch). */
  presence: Record<string, number>;
  /** Set when the host ends the session. Guests leave on seeing it. */
  ended: boolean;
}

/** Thrown for every room-level failure the player should see. */
export class RoomError extends Error {
  constructor(
    public readonly kind:
      | "not-found"
      | "ended"
      | "full"
      | "not-member"
      | "stale-revision"
      | "no-free-code"
      | "not-configured",
    message: string,
  ) {
    super(message);
    this.name = "RoomError";
  }
}

/**
 * Transport = where rooms live. Every method is async so the local
 * (same-browser) implementation and the future Firebase one share the
 * exact same call shape.
 */
export interface RoomTransport {
  readonly kind: "local" | "firebase";
  /** Short human label shown in the UI (e.g. "same-computer test mode"). */
  readonly label: string;
  /** Create a room with a fresh, unused 4-digit code. */
  createRoom(hostClientId: string): Promise<RoomDoc>;
  /** Read a room (null if it doesn't exist). */
  getRoom(code: string): Promise<RoomDoc | null>;
  /**
   * Claim the guest seat. Succeeds if the seat is free or already
   * held by `clientId` (rejoin). Throws `RoomError` otherwise.
   */
  claimGuestSeat(code: string, clientId: string): Promise<RoomDoc>;
  /** Free the guest seat (guest pressed Leave). No-op if not held by clientId. */
  releaseGuestSeat(code: string, clientId: string): Promise<void>;
  setHostRole(code: string, role: DelverRole | null): Promise<void>;
  /**
   * Compare-and-set publish: succeeds only if the stored snapshot's
   * rev is `snap.rev - 1` (or there is no snapshot and `snap.rev` is
   * 1). Throws `RoomError("stale-revision")` otherwise.
   */
  pushSnapshot(code: string, snap: RoomSnapshot): Promise<void>;
  heartbeat(code: string, clientId: string): Promise<void>;
  endRoom(code: string): Promise<void>;
  /**
   * Listen for changes to a room. `cb` gets null if the room is deleted;
   * `onError` gets listener failures (e.g. database rules refusing access).
   */
  subscribe(code: string, cb: (doc: RoomDoc | null) => void, onError: (e: Error) => void): () => void;
}
