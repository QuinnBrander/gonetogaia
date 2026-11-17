/**
 * Online co-op groundwork: the same-browser room transport, the
 * OnlineSession sync/authority rules, roles and the rejoin record.
 * Two "tabs" share one in-memory store + change bus.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { newCampaign, type CampaignState } from "../state";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { LocalRoomTransport, type ChangeChannel, type KeyValueStore } from "../net/localTransport";
import {
  OnlineSession,
  clearSessionRecord,
  readSessionRecord,
  saveSessionRecord,
  type SessionDeps,
} from "../net/session";
import { actingRole, actingSeat, delverIdForRole, pendingChoiceOwner, roleForDelverId, roleForSeat } from "../net/roles";
import { RoomError, type FlowScreen } from "../net/types";
import { normalizeRoom } from "../net/firebaseTransport";

class MemoryStore implements KeyValueStore {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

/** Shared bus: a post reaches every OTHER tab's listeners (like BroadcastChannel). */
class MemoryBus {
  private listeners: { owner: number; cb: (code: string) => void }[] = [];
  private next = 0;
  channel(): ChangeChannel {
    const owner = this.next++;
    return {
      post: (code) => { for (const l of [...this.listeners]) if (l.owner !== owner) l.cb(code); },
      listen: (cb) => {
        const entry = { owner, cb };
        this.listeners.push(entry);
        return () => { this.listeners = this.listeners.filter((l) => l !== entry); };
      },
    };
  }
}

interface Tab {
  state: CampaignState;
  screen: FlowScreen | null;
  storyPage: number;
  /** Local relayed prompt (test shape: `{"decider": role}`) or "". */
  prompt: string;
  busy: boolean;
  applied: number;
  errors: string[];
  ended: string[];
  deps: SessionDeps;
}

let store: MemoryStore;
let bus: MemoryBus;
let queue: (() => void)[];
let clock: number;
let ids: number;

function makeTab(): Tab {
  const transport = new LocalRoomTransport(store, bus.channel(), () => 0.4321, () => clock);
  const tab: Tab = {
    state: newCampaign(),
    screen: null,
    storyPage: 0,
    prompt: "",
    busy: false,
    applied: 0,
    errors: [],
    ended: [],
    deps: undefined as unknown as SessionDeps,
  };
  tab.deps = {
    transport,
    newClientId: () => `client-${ids++}`,
    schedule: (fn) => queue.push(fn),
    now: () => clock,
    bridge: {
      getState: () => tab.state,
      getFlowScreen: () => tab.screen,
      getStoryPage: () => tab.storyPage,
      getPrompt: () => tab.prompt,
      getBusy: () => tab.busy,
      // Test prompts are `{"decider": "mind" | "body"}`.
      promptDeciderRole: (j) => (j === "" ? null : (JSON.parse(j) as { decider: "mind" | "body" }).decider),
      replaceState: (next) => { tab.state = next; },
      applyRemote: (next, screen, page, prompt) => {
        tab.state = next;
        tab.screen = screen;
        tab.storyPage = page;
        tab.prompt = prompt;
        tab.applied++;
      },
    },
    events: {
      status: () => {},
      error: (m) => tab.errors.push(m),
      ended: (m) => tab.ended.push(m),
    },
  };
  return tab;
}

async function pump(...sessions: OnlineSession[]): Promise<void> {
  for (let i = 0; i < 10; i++) {
    while (queue.length) queue.shift()!();
    for (const s of sessions) await s.flush();
    if (queue.length === 0) return;
  }
}

/** A real Quest 1 encounter, put into the hero phase for `delverId`. */
function setHeroTurn(state: CampaignState, delverId: string): void {
  if (state.encounter === null) ensureEncounter(state, QUEST1, (pool: readonly string[]) => [...pool]);
  state.encounter!.phase = "hero";
  state.currentDelverId = delverId;
}

beforeEach(() => {
  store = new MemoryStore();
  bus = new MemoryBus();
  queue = [];
  clock = 1_000_000;
  ids = 1;
});

describe("roles", () => {
  it("maps Mind/Body to hero-01/hero-02 and seats", () => {
    expect(delverIdForRole("mind")).toBe("hero-01");
    expect(delverIdForRole("body")).toBe("hero-02");
    expect(roleForDelverId("hero-02")).toBe("body");
    expect(() => roleForDelverId("hero-07")).toThrow(/unknown delver/);
    expect(roleForSeat("guest", "mind")).toBe("body");
    expect(roleForSeat("host", "body")).toBe("body");
  });

  it("hero phase: the turn owner acts; everything else: host", () => {
    const s = newCampaign();
    expect(actingSeat(s, "body")).toBe("host");
    setHeroTurn(s, "hero-01");
    expect(actingSeat(s, "body")).toBe("guest");
    expect(actingSeat(s, "mind")).toBe("host");
    expect(actingSeat(s, null)).toBe("host");
    (s.encounter as { phase: string }).phase = "enemy";
    expect(actingSeat(s, "body")).toBe("host");
  });
});

describe("LocalRoomTransport", () => {
  it("creates a 4-digit room, lets one guest in, and rejects a third player", async () => {
    const t = makeTab().deps.transport;
    const room = await t.createRoom("h");
    expect(room.code).toMatch(/^\d{4}$/);
    await t.claimGuestSeat(room.code, "g");
    await t.claimGuestSeat(room.code, "g"); // rejoin with same id is fine
    await expect(t.claimGuestSeat(room.code, "x")).rejects.toMatchObject({ kind: "full" });
    await t.releaseGuestSeat(room.code, "g");
    await expect(t.claimGuestSeat(room.code, "x")).resolves.toMatchObject({ guestClientId: "x" });
  });

  it("refuses unknown and ended rooms", async () => {
    const t = makeTab().deps.transport;
    await expect(t.claimGuestSeat("9999", "g")).rejects.toMatchObject({ kind: "not-found" });
    const room = await t.createRoom("h");
    await t.endRoom(room.code);
    await expect(t.claimGuestSeat(room.code, "g")).rejects.toMatchObject({ kind: "ended" });
  });

  it("does not hand out a code that is in use", async () => {
    const t = makeTab().deps.transport; // random is fixed → same first code every time
    const a = await t.createRoom("h1");
    await expect(t.createRoom("h2")).rejects.toMatchObject({ kind: "no-free-code" });
    await t.endRoom(a.code);
    await expect(t.createRoom("h2")).resolves.toMatchObject({ code: a.code });
  });

  it("pushSnapshot is compare-and-set on rev", async () => {
    const t = makeTab().deps.transport;
    const room = await t.createRoom("h");
    const snap = { rev: 1, by: "h", at: 0, stateJson: "{}", screen: null, storyPage: 0, promptJson: "", busy: false };
    await t.pushSnapshot(room.code, snap);
    await expect(t.pushSnapshot(room.code, snap)).rejects.toMatchObject({ kind: "stale-revision" });
    await t.pushSnapshot(room.code, { ...snap, rev: 2 });
  });

  it("notifies the other tab and tracks presence separately", async () => {
    const a = makeTab().deps.transport;
    const b = makeTab().deps.transport;
    const room = await a.createRoom("h");
    const seen: (string | null)[] = [];
    b.subscribe(room.code, (d) => seen.push(d?.guestClientId ?? null), (e) => { throw e; });
    await a.claimGuestSeat(room.code, "g");
    expect(seen).toEqual(["g"]);
    clock += 500;
    await b.heartbeat(room.code, "g");
    expect((await a.getRoom(room.code))!.presence.g).toBe(clock);
  });
});

describe("OnlineSession", () => {
  async function hostAndJoin() {
    const hostTab = makeTab();
    const guestTab = makeTab();
    const host = await OnlineSession.host(hostTab.deps);
    const guest = await OnlineSession.join(guestTab.deps, host.code);
    return { hostTab, guestTab, host, guest };
  }

  it("host publishes a full snapshot; guest replaces its campaign and follows the screen", async () => {
    const { hostTab, guestTab, host, guest } = await hostAndJoin();
    expect(host.hasGuest).toBe(true);
    await host.hostSetRole("body");
    expect(guest.myRole).toBe("mind");
    hostTab.state.totalXp = 42;
    hostTab.screen = "story";
    hostTab.storyPage = 3;
    expect(host.commit()).toBe("ok");
    await pump(host, guest);
    expect(guestTab.state.totalXp).toBe(42);
    expect(guestTab.screen).toBe("story");
    expect(guestTab.storyPage).toBe(3);
    expect(guest.hasSnapshot).toBe(true);
  });

  it("guest changes are rolled back while the host drives", async () => {
    const { guestTab, host, guest } = await hostAndJoin();
    await host.hostSetRole("mind");
    guestTab.state.totalXp = 99;
    expect(guest.canAct).toBe(false);
    expect(guest.commit()).toBe("rejected");
    expect(guestTab.state.totalXp).toBe(0);
    // Pure navigation / no state change is fine.
    expect(guest.commit()).toBe("ok");
  });

  it("in the hero phase only the turn owner's changes stick, and the turn hand-off commit is accepted", async () => {
    const { hostTab, guestTab, host, guest } = await hostAndJoin();
    await host.hostSetRole("mind"); // guest = Body = hero-02
    setHeroTurn(hostTab.state, "hero-02");
    host.commit();
    await pump(host, guest);
    expect(guest.canAct).toBe(true);
    expect(host.canAct).toBe(false);

    hostTab.state.totalXp = 5;
    expect(host.commit()).toBe("rejected");
    expect(hostTab.state.totalXp).toBe(0);

    guestTab.state.totalXp = 7;
    (guestTab.state.encounter as { phase: string }).phase = "enemy"; // End Turn
    expect(guest.commit()).toBe("ok");
    expect(guest.canAct).toBe(false);
    await pump(host, guest);
    expect(hostTab.state.totalXp).toBe(7);
    expect(host.canAct).toBe(true);
  });

  it("host can take control from the title screen mid-way through the guest's turn", async () => {
    const { hostTab, guestTab, host, guest } = await hostAndJoin();
    await host.hostSetRole("mind");
    setHeroTurn(hostTab.state, "hero-02");
    host.commit();
    await pump(host, guest);
    expect(host.canAct).toBe(false);
    await host.hostSetRole("body");
    host.hostTakeControl();
    Object.assign(hostTab.state, newCampaign(), { totalXp: 3 });
    expect(host.commit()).toBe("ok");
    await pump(host, guest);
    expect(guestTab.state.totalXp).toBe(3);
    expect(guest.myRole).toBe("mind");
  });

  it("a guest refresh rejoins the same seat and lands on the shared game", async () => {
    const { hostTab, host, guest } = await hostAndJoin();
    await host.hostSetRole("mind");
    hostTab.state.totalXp = 11;
    hostTab.screen = "board";
    host.commit();
    await pump(host, guest);
    guest.detach(); // tab closed

    const reopened = makeTab();
    const back = await OnlineSession.resume(reopened.deps, guest.record);
    expect(back.seat).toBe("guest");
    expect(reopened.state.totalXp).toBe(11);
    expect(reopened.screen).toBe("board");
    expect(reopened.applied).toBe(1);
  });

  it("a host refresh resumes as host and re-lands on the published screen", async () => {
    const { hostTab, host, guest } = await hostAndJoin();
    hostTab.screen = "townVisit";
    hostTab.state.totalXp = 2;
    host.commit();
    await pump(host, guest);
    host.detach();
    const reopened = makeTab();
    reopened.state = JSON.parse(JSON.stringify(hostTab.state)) as CampaignState;
    const back = await OnlineSession.resume(reopened.deps, host.record);
    expect(back.seat).toBe("host");
    expect(reopened.screen).toBe("townVisit");
  });

  it("REJOIN from another window is refused while the seat is still live, allowed once it goes quiet", async () => {
    const { host } = await hostAndJoin();
    const other = makeTab();
    await expect(OnlineSession.resume(other.deps, host.record, true)).rejects.toThrow(/another window/);
    host.detach();
    clock += 60_000;
    const back = await OnlineSession.resume(other.deps, host.record, true);
    expect(back.seat).toBe("host");
  });

  it("a stranger cannot take an occupied seat or resume as host", async () => {
    const { host } = await hostAndJoin();
    const third = makeTab();
    await expect(OnlineSession.join(third.deps, host.code)).rejects.toBeInstanceOf(RoomError);
    await expect(OnlineSession.resume(third.deps, { ...host.record, clientId: "imposter" }))
      .rejects.toMatchObject({ kind: "not-member" });
  });

  it("ending the session tells the guest; leaving frees the guest seat", async () => {
    const { guestTab, host, guest } = await hostAndJoin();
    await guest.leave();
    expect(host.hasGuest).toBe(false);
    const again = makeTab();
    await OnlineSession.join(again.deps, host.code);
    await host.leave();
    expect(again.ended[0]).toMatch(/ended/);
    expect(guestTab.ended).toEqual([]);
  });

  it("reports peer presence with a timeout", async () => {
    const { host, guest } = await hostAndJoin();
    expect(host.peerOnline()).toBe(true);
    clock += 60_000;
    expect(host.peerOnline()).toBe(false);
    await guest.heartbeat();
    expect(host.peerOnline()).toBe(true);
  });

  it("a stale publish surfaces an error and reloads the shared state", async () => {
    const { hostTab, host, guest } = await hostAndJoin();
    // Someone else already wrote rev 1 behind this client's back.
    await hostTab.deps.transport.pushSnapshot(host.code, {
      rev: 1, by: "other", at: 0, stateJson: JSON.stringify({ ...newCampaign(), totalXp: 77 }), screen: "board", storyPage: 0, promptJson: "", busy: false,
    });
    // Host missed it (simulate by detaching its listener first is not needed: rev
    // tracking already moved). Force a conflicting rev by rewinding.
    (host as unknown as { lastRev: number }).lastRev = 0;
    hostTab.state.totalXp = 1;
    host.commit();
    await pump(host, guest);
    expect(hostTab.errors[0]).toMatch(/at once/);
    expect(hostTab.state.totalXp).toBe(77);
  });

  it("join validates the code format", async () => {
    await expect(OnlineSession.join(makeTab().deps, "12a4")).rejects.toThrow(/4 digits/);
  });
});

describe("session record", () => {
  it("is stored per tab and per browser; clearing only removes the matching browser record", () => {
    const tab = new MemoryStore();
    const browser = new MemoryStore();
    saveSessionRecord(tab, browser, { code: "1234", clientId: "c", seat: "guest" });
    expect(readSessionRecord(tab)).toEqual({ code: "1234", clientId: "c", seat: "guest" });
    clearSessionRecord(tab, browser, "9999");
    expect(readSessionRecord(tab)).toBeNull();
    expect(readSessionRecord(browser)?.code).toBe("1234");
    clearSessionRecord(tab, browser, "1234");
    expect(readSessionRecord(browser)).toBeNull();
  });

  it("throws on a corrupt record instead of ignoring it", () => {
    const s = new MemoryStore();
    s.setItem("g2g.net.session", JSON.stringify({ code: 1 }));
    expect(() => readSessionRecord(s)).toThrow(/Corrupt/);
  });
});

describe("Firebase room normalisation", () => {
  it("fills the keys RTDB drops (nulls, empty objects) and converts presence to local time", () => {
    const doc = normalizeRoom({ code: "1234", hostClientId: "h", createdAt: 5, presence: { h: 10_500 } }, 500);
    expect(doc).toEqual({
      code: "1234", createdAt: 5, hostClientId: "h", guestClientId: null, hostRole: null,
      ended: false, presence: { h: 10_000 }, snapshot: null,
    });
  });

  it("keeps a snapshot and defaults its dropped fields", () => {
    const doc = normalizeRoom({ code: "1234", hostClientId: "h", snapshot: { rev: 3, by: "h", at: 1, stateJson: "{}" } });
    expect(doc!.snapshot).toEqual({ rev: 3, by: "h", at: 1, stateJson: "{}", screen: null, storyPage: 0, promptJson: "", busy: false });
  });

  it("returns null for a missing room and throws on corrupt data", () => {
    expect(normalizeRoom(null)).toBeNull();
    expect(() => normalizeRoom({ code: 1 })).toThrow(/Corrupt/);
  });
});

// --- Who chooses (design owner 2026-11-15) ---------------------------------
// Each player makes the choices that only affect their own delver; shared
// choices stay with the phase rule (hero turn owner, else host).

describe("roles: per-delver choices", () => {
  it("a queued choice for a delver goes to that delver's player where it is shown", () => {
    const s = newCampaign();
    setHeroTurn(s, "hero-01");
    expect(pendingChoiceOwner(s)).toBeNull();
    s.encounter!.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 1 });
    expect(pendingChoiceOwner(s)).toBe("hero-02");
    expect(actingSeat(s, "mind")).toBe("guest"); // guest plays Body
    expect(actingRole(s, "mind")).toBe("body");
    // Level-ups aren't shown at End Wave: its buttons stay with the host.
    s.encounter!.phase = "end-of-wave";
    expect(pendingChoiceOwner(s)).toBeNull();
    expect(actingSeat(s, "mind")).toBe("host");
    // Element picks aren't either (Elemental OS / Shield picks open on
    // the next wave's board), so End Wave stays with the host.
    s.encounter!.pendingElementChoices.push({ heroId: "hero-02", source: { kind: "end-of-wave", cardId: "x" } });
    expect(actingSeat(s, "mind")).toBe("host");
  });

  it("a flow owner that is mid-flow keeps the move until it finishes", () => {
    const s = newCampaign();
    setHeroTurn(s, "hero-01");
    s.encounter!.pendingElementChoices.push({ heroId: "hero-02", source: { kind: "end-of-wave", cardId: "x" } });
    expect(actingSeat(s, "mind", { promptDeciderRole: null, busy: true })).toBe("host");
    expect(actingSeat(s, "mind", { promptDeciderRole: null, busy: false })).toBe("guest");
  });

  it("a shared choice (no delver) falls back to the phase rule", () => {
    const s = newCampaign();
    setHeroTurn(s, "hero-02");
    s.pendingSuitConditionPicks.push({ pickId: "p", source: "t", delta: 1, heroId: null, pinnedType: null });
    expect(pendingChoiceOwner(s)).toBe("shared");
    expect(actingSeat(s, "mind")).toBe("guest"); // Body's hero turn
    s.pendingSuitConditionPicks[0]!.heroId = "hero-01";
    expect(actingSeat(s, "mind")).toBe("host");
  });

  it("the hero-card picker goes to each delver in turn", () => {
    const s = newCampaign();
    s.pendingHeroPickDelvers = ["hero-02", "hero-01"];
    expect(actingSeat(s, "mind")).toBe("guest");
    s.pendingHeroPickDelvers.shift();
    expect(actingSeat(s, "mind")).toBe("host");
  });

  it("a relayed Shield prompt beats everything; a shop turn beats the host default", () => {
    const s = newCampaign();
    setHeroTurn(s, "hero-01");
    expect(actingSeat(s, "mind", { promptDeciderRole: "body", busy: true })).toBe("guest");
    const t = newCampaign();
    t.townVisit = { chapterId: "ch2", pageId: "x", pagesEntered: [], shopTurn: "hero-02", shopDone: ["hero-01"] };
    expect(actingSeat(t, "mind")).toBe("guest");
    t.townVisit.shopTurn = null;
    expect(actingSeat(t, "mind")).toBe("host");
  });
});

describe("OnlineSession: relayed prompts", () => {
  it("the prompt's decider may answer it; the owner can't change the campaign meanwhile; handing back returns the move", async () => {
    const hostTab = makeTab();
    const guestTab = makeTab();
    const host = await OnlineSession.host(hostTab.deps);
    const guest = await OnlineSession.join(guestTab.deps, host.code);
    await host.hostSetRole("mind"); // guest = Body
    setHeroTurn(hostTab.state, "hero-01");
    host.commit();
    await pump(host, guest);
    expect(host.canAct).toBe(true);

    // Host's counterattack opens a Shield prompt for Body's bearer.
    hostTab.prompt = JSON.stringify({ decider: "body" });
    hostTab.busy = true;
    expect(host.commit()).toBe("ok");
    await pump(host, guest);
    expect(guestTab.prompt).toBe(hostTab.prompt);
    expect(guest.canAct).toBe(true);
    expect(host.canAct).toBe(false);
    expect(guest.actorRole).toBe("body");

    hostTab.state.totalXp = 3;
    expect(host.commit()).toBe("rejected");

    // Guest answers and hands the prompt back to Mind (the owner).
    guestTab.prompt = JSON.stringify({ decider: "mind" });
    expect(guest.commit()).toBe("ok");
    await pump(host, guest);
    expect(hostTab.prompt).toBe(guestTab.prompt);
    expect(host.canAct).toBe(true);
    expect(guest.canAct).toBe(false);

    // Owner finishes the flow: prompt closed, campaign changed.
    hostTab.prompt = "";
    hostTab.busy = false;
    hostTab.state.totalXp = 9;
    expect(host.commit()).toBe("ok");
    await pump(host, guest);
    expect(guestTab.state.totalXp).toBe(9);
    expect(guestTab.prompt).toBe("");
  });

  it("a watcher's own UI never counts as a move", async () => {
    const hostTab = makeTab();
    const guestTab = makeTab();
    const host = await OnlineSession.host(hostTab.deps);
    const guest = await OnlineSession.join(guestTab.deps, host.code);
    await host.hostSetRole("mind");
    host.commit();
    await pump(host, guest);
    guestTab.busy = true;
    expect(guest.commit()).toBe("ok");
    expect(guest.canAct).toBe(false);
  });
});
