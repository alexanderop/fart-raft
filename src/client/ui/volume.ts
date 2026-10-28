import {
  CHANNELS,
  speakerLevel,
  type Channel,
  type Volume,
  type VolumeStore,
} from "../fx/volume.ts";

const LABELS: Record<Channel, string> = { master: "Volume", farts: "Farts", effects: "Effects" };

const SPEAKER = `<path d="M4 9.5h3.5L12.5 5v14l-5-4.5H4z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`;
const WAVES: Record<ReturnType<typeof speakerLevel>, string> = {
  muted: `<path d="M16 9.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>`,
  low: `<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>`,
  high: `<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>`,
};

/** Speaker icon for the current level: muted (or 0), low, high. */
export const speakerIcon = (v: Volume): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}${WAVES[speakerLevel(v)]}</svg>`;

let panels = 0;

const slider = (ch: Channel) =>
  `<label class="vol-slider"><span>${LABELS[ch]}</span><input type="range" min="0" max="100" step="5" data-ch="${ch}" /></label>`;

/**
 * Sliders for master, farts and effects plus a mute button, bound to `store`. `compact` (the
 * start menu) shows only master and folds the other two behind a "Mix" button.
 *
 * Every key pressed inside stays inside (except Esc), so arrows, Space, Enter, R and M work the
 * slider and buttons instead of steering, farting, restarting or muting through the game's
 * window-level handlers.
 */
export function volumePanel(store: VolumeStore, opts: { compact?: boolean } = {}) {
  const id = `vol-${++panels}`;
  const el = document.createElement("div");
  el.className = opts.compact ? "vol vol-compact" : "vol";
  el.innerHTML = `<div class="vol-row">
      <button type="button" class="vol-mute" data-mute></button>
      ${slider("master")}
      ${opts.compact ? `<button type="button" class="vol-more" data-more aria-expanded="false" aria-controls="${id}-mix">Mix</button>` : ""}
    </div>
    <div class="vol-mix" id="${id}-mix" ${opts.compact ? "hidden" : ""}>
      ${slider("farts")}
      ${slider("effects")}
    </div>`;
  const mute = el.querySelector<HTMLButtonElement>("[data-mute]")!;
  const inputs = CHANNELS.map((ch) => el.querySelector<HTMLInputElement>(`[data-ch="${ch}"]`)!);
  const more = el.querySelector<HTMLButtonElement>("[data-more]");
  const mix = el.querySelector<HTMLElement>(".vol-mix")!;

  CHANNELS.forEach((ch, i) => {
    const input = inputs[i]!;
    input.addEventListener("input", () => store.set(ch, Number(input.value) / 100));
  });
  mute.addEventListener("click", () => store.toggleMute());
  more?.addEventListener("click", () => {
    mix.hidden = !mix.hidden;
    more.setAttribute("aria-expanded", String(!mix.hidden));
  });
  el.addEventListener("keydown", (e) => {
    if (e.code !== "Escape") e.stopPropagation();
  });

  const unsubscribe = store.subscribe((v) => {
    CHANNELS.forEach((ch, i) => {
      const input = inputs[i]!;
      const pct = Math.round(v[ch] * 100);
      input.value = String(pct);
      input.style.setProperty("--fill", `${pct}%`);
      input.setAttribute("aria-valuetext", `${pct}%`);
    });
    const silent = speakerLevel(v) === "muted";
    mute.innerHTML = speakerIcon(v);
    mute.setAttribute("aria-pressed", String(silent));
    mute.setAttribute("aria-label", silent ? "Unmute" : "Mute");
    el.classList.toggle("is-muted", silent);
  });

  return { el, focus: () => inputs[0]!.focus(), dispose: unsubscribe };
}

/**
 * In-race speaker button (top right, under the puff counter) that opens a popover with the
 * sliders. Esc closes the popover and is kept from reaching main.ts's back-to-menu handler; a
 * tap or click anywhere else closes it too.
 */
export function createVolumeButton(host: HTMLElement, store: VolumeStore) {
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="vol-hud" data-vol-hud>
      <button type="button" class="vol-toggle" data-vol-toggle aria-haspopup="dialog" aria-expanded="false" aria-controls="vol-pop" aria-label="Volume"></button>
      <div class="vol-pop" id="vol-pop" role="dialog" aria-label="Volume" hidden></div>
    </div>`,
  );
  const root = [...host.querySelectorAll<HTMLElement>("[data-vol-hud]")].at(-1)!;
  const toggle = root.querySelector<HTMLButtonElement>("[data-vol-toggle]")!;
  const pop = root.querySelector<HTMLElement>(".vol-pop")!;
  const panel = volumePanel(store);
  pop.append(panel.el);
  const unsubscribe = store.subscribe((v) => {
    toggle.innerHTML = speakerIcon(v);
    toggle.dataset.level = speakerLevel(v);
  });

  const isOpen = () => !pop.hidden;
  const open = () => {
    pop.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    panel.focus();
  };
  // Focus leaves the widget on close, so game keys (Space, Enter) go straight back to the race.
  const close = () => {
    pop.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement))
      document.activeElement.blur();
  };

  toggle.addEventListener("click", () => (isOpen() ? close() : open()));
  // Space and Enter press the focused button, not the fart key.
  toggle.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter") e.stopPropagation();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.code !== "Escape" || !isOpen()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  const onPointer = (e: PointerEvent) => {
    if (isOpen() && !(e.target instanceof Node && root.contains(e.target))) close();
  };
  // Capture on window runs before main.ts's own Esc listener.
  addEventListener("keydown", onKey, true);
  addEventListener("pointerdown", onPointer, true);

  return {
    dispose() {
      removeEventListener("keydown", onKey, true);
      removeEventListener("pointerdown", onPointer, true);
      unsubscribe();
      panel.dispose();
      root.remove();
    },
  };
}
