import { DIFFICULTIES } from "../../sim/constants.ts";
import type { Contact, Difficulty } from "../../sim/types.ts";
import type { RoomMode } from "../../net/protocol.ts";

type Option<T extends string> = { value: T; label: string; blurb: string };

/** What each difficulty is called on screen. */
export const DIFFICULTY_LABELS: Record<Difficulty, { label: string; blurb: string }> = {
  chill: { label: "😌 Chill", blurb: "Slower hazards, quick respawns" },
  wild: { label: "🔥 Wild", blurb: "Full speed, like the bots" },
};

/** What each way of racing is called on screen. */
export const RACE_LABELS: Record<RoomMode, { label: string; blurb: string }> = {
  coop: { label: "🤝 Co-op", blurb: "Everyone on one raft" },
  ghost: { label: "👻 Ghost race", blurb: "Two rafts that pass through each other" },
  bump: { label: "💥 Bump race", blurb: "Two rafts that collide: shove them into the spikes" },
};

const CONTACT_OPTIONS: readonly Option<Contact>[] = [
  { value: "ghost", label: "👻 Ghost", blurb: RACE_LABELS.ghost.blurb },
  { value: "bump", label: "💥 Bump", blurb: RACE_LABELS.bump.blurb },
];

let pickers = 0;

/**
 * A row of radio buttons under a label, styled like the player count buttons. `onChange` fires
 * on every pick (not on `set`); `value()` is the current one.
 */
export function radioPicker<T extends string>(
  title: string,
  options: readonly Option<T>[],
  initial: T,
  onChange?: (value: T) => void,
) {
  let value = initial;
  const el = document.createElement("div");
  el.innerHTML = `<div class="menu-label">${title}</div>
    <div class="menu-players" role="radiogroup">
      ${options
        .map(
          (o) =>
            `<button type="button" role="radio" data-value="${o.value}" title="${o.blurb}">${o.label}</button>`,
        )
        .join("")}
    </div>`;
  const group = el.querySelector<HTMLElement>("[role=radiogroup]")!;
  const label = el.querySelector<HTMLElement>(".menu-label")!;
  label.id = `picker-label-${++pickers}`;
  group.setAttribute("aria-labelledby", label.id);
  const buttons = [...el.querySelectorAll<HTMLButtonElement>("[data-value]")];

  const render = () => {
    buttons.forEach((b, i) => {
      const on = options[i]!.value === value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => {
      value = options[i]!.value;
      render();
      onChange?.(value);
    });
  });
  render();
  return {
    el,
    value: () => value,
    set(next: T) {
      value = next;
      render();
    },
  };
}

/** Chill / Wild. */
export const difficultyPicker = (initial: Difficulty, onChange?: (d: Difficulty) => void) =>
  radioPicker(
    "Difficulty",
    DIFFICULTIES.map((d) => ({ value: d, ...DIFFICULTY_LABELS[d] })),
    initial,
    onChange,
  );

/** Ghost / Bump: how a team race's rafts meet. */
export const contactPicker = (initial: Contact, onChange?: (c: Contact) => void) =>
  radioPicker("Rafts", CONTACT_OPTIONS, initial, onChange);

/**
 * Co-op or Team race, and for a team race Ghost or Bump (shown only then). `value()` is the room
 * mode it adds up to.
 */
export function racePicker(initial: RoomMode, onChange?: (mode: RoomMode) => void) {
  let contact: Contact = initial === "bump" ? "bump" : "ghost";
  const el = document.createElement("div");
  el.className = "race-picker";
  const kind = radioPicker(
    "Race",
    [
      { value: "coop", label: RACE_LABELS.coop.label, blurb: RACE_LABELS.coop.blurb },
      { value: "team", label: "🏁 Team race", blurb: "Your crew against a rival raft" },
    ],
    initial === "coop" ? "coop" : "team",
    () => changed(),
  );
  const how = contactPicker(contact, (c) => {
    contact = c;
    changed();
  });
  el.append(kind.el, how.el);
  const value = (): RoomMode => (kind.value() === "coop" ? "coop" : contact);
  function changed() {
    how.el.hidden = kind.value() === "coop";
    onChange?.(value());
  }
  how.el.hidden = kind.value() === "coop";
  return { el, value };
}
