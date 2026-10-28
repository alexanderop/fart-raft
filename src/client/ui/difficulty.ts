import { DIFFICULTIES } from "../../sim/constants.ts";
import type { Difficulty } from "../../sim/types.ts";

/** What each difficulty is called on screen. */
export const MODE_LABELS: Record<Difficulty, { label: string; blurb: string }> = {
  chill: { label: "😌 Chill", blurb: "Slower hazards, quick respawns" },
  wild: { label: "🔥 Wild", blurb: "Full speed, like the bots" },
};

let pickers = 0;

/**
 * A Chill / Wild radio pair, styled like the player count buttons. `onChange` fires on every
 * pick; `value()` is the current one.
 */
export function difficultyPicker(initial: Difficulty, onChange?: (d: Difficulty) => void) {
  let value = initial;
  const el = document.createElement("div");
  el.innerHTML = `<div class="menu-label" data-mode-label>Mode</div>
    <div class="menu-players" role="radiogroup">
      ${DIFFICULTIES.map(
        (d) =>
          `<button type="button" role="radio" data-mode="${d}" title="${MODE_LABELS[d].blurb}">${MODE_LABELS[d].label}</button>`,
      ).join("")}
    </div>`;
  const group = el.querySelector<HTMLElement>("[role=radiogroup]")!;
  const label = el.querySelector<HTMLElement>("[data-mode-label]")!;
  label.id = `mode-label-${++pickers}`;
  group.setAttribute("aria-labelledby", label.id);
  const buttons = [...el.querySelectorAll<HTMLButtonElement>("[data-mode]")];

  const render = () => {
    for (const b of buttons) {
      const on = b.dataset.mode === value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      value = b.dataset.mode === "wild" ? "wild" : "chill";
      render();
      onChange?.(value);
    });
  }
  render();
  return { el, value: () => value };
}
