import {
  ANIMAL_LABELS,
  ANIMALS,
  COSTUMES,
  GADGET_LABELS,
  GADGETS,
  HAT_LABELS,
  HATS,
  LOOK_COLORS,
  OUTFIT_LABELS,
  OUTFITS,
  randomLook,
  type Look,
} from "../../look.ts";
import { MAX_NAME } from "../../net/protocol.ts";
import { createLookPreview, type LookPreview } from "../render/preview.ts";

export type Dressing = { name: string; look: Look };

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

type Slot = "animal" | "hat" | "outfit" | "gadget";

const chips = <T extends string>(slot: Slot, values: readonly T[], labels: Record<T, string>) =>
  `<div class="wardrobe-chips" role="radiogroup" aria-label="${slot}">${values
    .map(
      (v) =>
        `<button type="button" role="radio" data-${slot}="${v}">${escapeHtml(labels[v])}</button>`,
    )
    .join("")}</div>`;

/**
 * The wardrobe: a turning preview of your rider, with its animal, color, costume sets and each
 * hat, outfit and gadget. `name` shows a name field when given. Resolves with the choice on
 * Done, or `undefined` on Cancel / Esc / `signal` abort. Keys typed here never reach the menus underneath.
 */
export function openWardrobe(
  host: HTMLElement,
  opts: { title: string; look: Look; name?: string; signal?: AbortSignal },
): Promise<Dressing | undefined> {
  let look = opts.look;
  const named = opts.name !== undefined;
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="menu wardrobe" role="dialog" aria-modal="true" aria-labelledby="wardrobe-title">
      <form class="menu-card wardrobe-card" novalidate>
        <h2 id="wardrobe-title" class="wardrobe-title">${escapeHtml(opts.title)}</h2>
        <div class="wardrobe-body">
          <div class="wardrobe-stage">
            <div class="wardrobe-preview" data-preview></div>
            <button type="button" class="menu-online wardrobe-random" data-random>🎲 Surprise me</button>
          </div>
          <div class="wardrobe-pick">
            ${
              named
                ? `<label class="menu-label" for="wardrobe-name">Name</label>
              <input id="wardrobe-name" class="lobby-input" data-name maxlength="${MAX_NAME}"
                autocomplete="nickname" placeholder="Captain Toot" />`
                : ""
            }
            <div class="menu-label">Animal</div>
            ${chips("animal", ANIMALS, ANIMAL_LABELS)}
            <div class="menu-label">Color</div>
            <div class="wardrobe-colors" role="radiogroup" aria-label="Color">${LOOK_COLORS.map(
              (c, i) =>
                `<button type="button" role="radio" data-color="${i}" style="--c:${c}" aria-label="Color ${i + 1}"></button>`,
            ).join("")}</div>
            <div class="menu-label">Costumes</div>
            <div class="wardrobe-chips">${COSTUMES.map(
              (c, i) => `<button type="button" data-costume="${i}">${escapeHtml(c.label)}</button>`,
            ).join("")}</div>
            <div class="menu-label">Hat</div>
            ${chips("hat", HATS, HAT_LABELS)}
            <div class="menu-label">Outfit</div>
            ${chips("outfit", OUTFITS, OUTFIT_LABELS)}
            <div class="menu-label">Gadget</div>
            ${chips("gadget", GADGETS, GADGET_LABELS)}
          </div>
        </div>
        <div class="wardrobe-actions">
          <button type="button" class="lobby-back" data-cancel>Cancel</button>
          <button type="submit" class="menu-start wardrobe-done" data-done>Done</button>
        </div>
      </form>
    </div>`,
  );
  const root = [...host.querySelectorAll<HTMLElement>(".wardrobe")].at(-1)!;
  const form = root.querySelector<HTMLFormElement>("form")!;
  const nameInput = root.querySelector<HTMLInputElement>("[data-name]");
  if (nameInput) nameInput.value = opts.name ?? "";

  let preview: LookPreview | undefined;
  let closed = false;
  void createLookPreview(root.querySelector<HTMLElement>("[data-preview]")!).then((p) => {
    if (closed) return p.dispose();
    preview = p;
    p.show(look);
  });

  const render = () => {
    for (const b of root.querySelectorAll<HTMLButtonElement>("[role=radio]")) {
      const on =
        b.dataset.animal === look.animal ||
        b.dataset.hat === look.hat ||
        b.dataset.outfit === look.outfit ||
        b.dataset.gadget === look.gadget ||
        b.dataset.color === String(look.color);
      b.setAttribute("aria-checked", String(on));
    }
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-costume]")) {
      const c = COSTUMES[Number(b.dataset.costume)]!;
      const on = c.hat === look.hat && c.outfit === look.outfit && c.gadget === look.gadget;
      b.classList.toggle("on", on);
    }
    preview?.show(look);
  };
  const set = (next: Partial<Look>) => {
    look = { ...look, ...next };
    render();
  };

  root.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest<HTMLButtonElement>("button") : null;
    if (!b) return;
    const d = b.dataset;
    if (d.animal) set({ animal: ANIMALS.find((v) => v === d.animal) });
    else if (d.color) set({ color: Number(d.color) });
    else if (d.hat) set({ hat: HATS.find((v) => v === d.hat) });
    else if (d.outfit) set({ outfit: OUTFITS.find((v) => v === d.outfit) });
    else if (d.gadget) set({ gadget: GADGETS.find((v) => v === d.gadget) });
    else if (d.costume) {
      const { hat, outfit, gadget } = COSTUMES[Number(d.costume)]!;
      set({ hat, outfit, gadget });
    } else if (d.random !== undefined) set(randomLook());
  });
  render();
  (nameInput ?? root.querySelector<HTMLButtonElement>("[data-done]")!).focus();

  return new Promise((resolve) => {
    const finish = (result: Dressing | undefined) => {
      if (closed) return;
      closed = true;
      preview?.dispose();
      root.remove();
      resolve(result);
    };
    // Keys stay here: digits, Enter, Space and Esc mean something else to the menus below.
    root.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.code === "Escape") finish(undefined);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      finish({ name: nameInput?.value.trim() ?? "", look });
    });
    root.querySelector("[data-cancel]")!.addEventListener("click", () => finish(undefined));
    opts.signal?.addEventListener("abort", () => finish(undefined), { once: true });
  });
}
