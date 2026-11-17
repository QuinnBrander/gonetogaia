/**
 * Chapter 4 Town Square "Unfolding Disasters" (page kind
 * `townsfolk-assignment`). Each townsfolk token goes to one action;
 * townsfolk on "Assist with combat" also name the delver who gets
 * their reward for the Assault on Bird's Nest. Scoring lives in
 * engine/townsfolk.ts.
 */
import type { Router } from "../main";
import {
  ACTION_LABELS,
  SCORED_ACTIONS,
  TOWNSFOLK,
  resolveTownsfolkAssignment,
  scoreAction,
  type TownsfolkActionId,
  type TownsfolkAssignment,
} from "../engine/townsfolk";
import { advanceTownVisitPage } from "../engine/townVisit";
import { presentRewards } from "./RewardsModal";
import { logEvent } from "../debug/sessionLog";

const ACTIONS: TownsfolkActionId[] = ["fire", "dig", "first-aid", "combat"];
const HEROES: { id: string; label: string }[] = [{ id: "hero-01", label: "Mind" }, { id: "hero-02", label: "Body" }];

/** Draft picks, kept across re-renders until the page is committed. */
let draft: Record<string, { action?: TownsfolkActionId; heroId?: string }> = {};

const RESULT_TEXT = { success: "Success", partial: "Partial success", failure: "Failure" } as const;

export function renderTownsfolkAssignment(host: HTMLElement, router: Router): void {
  const rerender = () => renderTownsfolkAssignment(host, router);
  const rows = TOWNSFOLK.map((t) => {
    const pick = draft[t.id] ?? {};
    const actionBtns = ACTIONS.map((a) =>
      `<button class="btn btn--small ${pick.action === a ? "btn--primary" : "btn--ghost"}" data-tf="${t.id}" data-action="${a}">${ACTION_LABELS[a]}</button>`).join("");
    const heroBtns = pick.action === "combat"
      ? `<div class="townsfolk-hero">Reward goes to: ${HEROES.map((h) =>
          `<button class="btn btn--small ${pick.heroId === h.id ? "btn--primary" : "btn--ghost"}" data-tf="${t.id}" data-hero="${h.id}">${h.label} delver</button>`).join("")}</div>`
      : "";
    return `
      <div class="townsfolk-row">
        <img class="townsfolk-portrait" src="${t.image}" alt="${t.name}" />
        <div class="townsfolk-info">
          <strong>${t.name}</strong>
          <span class="small">Talents: ${t.talents.join(", ")} &middot; Weakness: ${t.weakness}</span>
          <span class="small muted">Assist with combat (${t.bonus}): ${t.rewardText}</span>
        </div>
        <div class="townsfolk-actions">${actionBtns}${heroBtns}</div>
      </div>`;
  }).join("");

  const scores = SCORED_ACTIONS.map((a) => {
    const assigned = TOWNSFOLK.filter((t) => draft[t.id]?.action === a.id).map((t) => t.id);
    const { score, result } = scoreAction(a, assigned);
    return `<li><strong>${a.label}</strong>: ${score} point${score === 1 ? "" : "s"} - ${RESULT_TEXT[result]} (${a.characterName}'s opinion ${result === "success" ? "+1" : result === "failure" ? "-1" : "unchanged"})</li>`;
  }).join("");

  const missing = TOWNSFOLK.filter((t) => !draft[t.id]?.action || (draft[t.id]!.action === "combat" && !draft[t.id]!.heroId));
  host.innerHTML = `
    <div class="townsfolk-board">
      <p class="small muted">Scoring: each townsfolk with the action's talent scores 2, with its weakness 0, anyone else 1.
      Put out the fire (Smart / Naive): 2+ success, 0 failure. Dig out survivors (Strong / Weak): 2+ success, 0 failure.
      Administer first aid (Resourceful / Unimaginative): 4+ success, 2 or less failure.</p>
      ${rows}
      <ul class="townsfolk-scores">${scores}</ul>
      <button class="btn btn--accent" data-confirm ${missing.length ? "disabled" : ""}>${missing.length ? `Assign ${missing.map((t) => t.name).join(", ")}` : "Confirm assignments →"}</button>
    </div>`;

  host.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => btn.addEventListener("click", () => {
    const id = btn.dataset.tf!;
    const action = btn.dataset.action as TownsfolkActionId;
    draft[id] = { action, heroId: action === "combat" ? draft[id]?.heroId : undefined };
    rerender();
  }));
  host.querySelectorAll<HTMLButtonElement>("[data-hero]").forEach((btn) => btn.addEventListener("click", () => {
    const id = btn.dataset.tf!;
    draft[id] = { ...draft[id], heroId: btn.dataset.hero! };
    rerender();
  }));
  host.querySelector<HTMLButtonElement>("[data-confirm]")!.addEventListener("click", async () => {
    const assignments: TownsfolkAssignment[] = TOWNSFOLK.map((t) => ({
      townsfolkId: t.id, action: draft[t.id]!.action!, ...(draft[t.id]!.heroId ? { heroId: draft[t.id]!.heroId } : {}),
    }));
    logEvent("click.townsfolk-confirm", { assignments });
    const events = resolveTownsfolkAssignment(router.state, assignments);
    draft = {};
    router.persist();
    if (events.length > 0) await presentRewards(document.body, events);
    advanceTownVisitPage(router.state);
    router.save();
  });
}
