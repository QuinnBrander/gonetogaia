/**
 * Touch-first dialogs for online co-op: Join (4-digit code) and the
 * host's Mind/Body role picker. Mounted on `document.body` so they're
 * a constant, finger-sized scale regardless of the stage zoom.
 */
import "./online.css";
import type { DelverRole } from "./types";

function overlay(): { root: HTMLDivElement; panel: HTMLDivElement; close: () => void } {
  const root = document.createElement("div");
  root.className = "online-dialog";
  const panel = document.createElement("div");
  panel.className = "online-dialog__panel";
  root.appendChild(panel);
  document.body.appendChild(root);
  return { root, panel, close: () => root.remove() };
}

function bigButton(label: string, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `online-dialog__btn ${cls}`.trim();
  b.textContent = label;
  return b;
}

/**
 * Ask for a 4-digit code and run `onSubmit` with it. Errors thrown by
 * `onSubmit` are shown inline so the player can fix the code.
 */
export function showJoinDialog(onSubmit: (code: string) => Promise<void>): void {
  const { panel, close } = overlay();
  panel.innerHTML = `
    <h2 class="online-dialog__title">Join Game</h2>
    <p class="online-dialog__text">Enter the 4-digit code shown on the host's screen.</p>
  `;
  const input = document.createElement("input");
  input.className = "online-dialog__code";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.maxLength = 4;
  input.pattern = "[0-9]*";
  input.placeholder = "0000";
  input.setAttribute("aria-label", "Session code");
  const err = document.createElement("p");
  err.className = "online-dialog__error";
  const join = bigButton("JOIN", "online-dialog__btn--primary");
  const cancel = bigButton("Cancel", "online-dialog__btn--ghost");
  const actions = document.createElement("div");
  actions.className = "online-dialog__actions";
  actions.append(join, cancel);
  panel.append(input, err, actions);

  const submit = async () => {
    const code = input.value.trim();
    if (!/^\d{4}$/.test(code)) {
      err.textContent = "Codes are 4 digits.";
      return;
    }
    join.disabled = true;
    err.textContent = "";
    try {
      await onSubmit(code);
      close();
    } catch (e) {
      err.textContent = (e as Error).message;
      join.disabled = false;
    }
  };
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 4);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  join.addEventListener("click", () => void submit());
  cancel.addEventListener("click", close);
  input.focus();
}

/** Host picks which delver they'll play. Resolves null on Cancel. */
export function pickHostRole(reason: string): Promise<DelverRole | null> {
  return new Promise((resolve) => {
    const { panel, close } = overlay();
    panel.innerHTML = `
      <h2 class="online-dialog__title">Choose your delver</h2>
      <p class="online-dialog__text"></p>
    `;
    panel.querySelector(".online-dialog__text")!.textContent =
      `${reason} The other player gets the other delver.`;
    const mind = bigButton("MIND", "online-dialog__btn--mind");
    const body = bigButton("BODY", "online-dialog__btn--body");
    const cancel = bigButton("Cancel", "online-dialog__btn--ghost");
    const roles = document.createElement("div");
    roles.className = "online-dialog__roles";
    roles.append(mind, body);
    const actions = document.createElement("div");
    actions.className = "online-dialog__actions";
    actions.append(cancel);
    panel.append(roles, actions);
    const done = (r: DelverRole | null) => {
      close();
      resolve(r);
    };
    mind.addEventListener("click", () => done("mind"));
    body.addEventListener("click", () => done("body"));
    cancel.addEventListener("click", () => done(null));
  });
}
