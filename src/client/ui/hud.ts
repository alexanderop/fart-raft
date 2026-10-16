import { GAS_MAX, TICK_RATE } from "../../sim/constants";
import type { SimEvent, Snapshot } from "../../sim/types";

const LOW_GAS = 0.25;

/** Re-run a CSS animation class on an element, even if it is already playing. */
function replay(el: HTMLElement, className: string) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

export function createHud(host: HTMLElement, seatLabels: readonly string[]) {
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="hud">
      <div class="hud-status" data-status></div>
      <div class="hud-count" data-count></div>
      <div class="hud-toast" data-toast></div>
      <div class="hud-finish" data-finish>
        <div class="finish-title">Finish!</div>
        <div class="finish-time" data-finish-time></div>
        <div class="finish-hint">R to restart</div>
      </div>
      <div class="hud-gas">${seatLabels
        .map((label, i) => `<div class="gas" data-seat="${i}"><span>${label}</span><i></i></div>`)
        .join("")}</div>
    </div>`,
  );
  const status = host.querySelector<HTMLElement>("[data-status]")!;
  const count = host.querySelector<HTMLElement>("[data-count]")!;
  const toast = host.querySelector<HTMLElement>("[data-toast]")!;
  const finish = host.querySelector<HTMLElement>("[data-finish]")!;
  const finishTime = host.querySelector<HTMLElement>("[data-finish-time]")!;
  const gasBars = [...host.querySelectorAll<HTMLElement>(".gas")];
  const fills = gasBars.map((g) => g.querySelector<HTMLElement>("i")!);
  const lastGas = gasBars.map(() => GAS_MAX);
  let shownCount = "";

  status.addEventListener("animationend", () => status.classList.remove("pop"));

  const show = (text: string, kind: "slam" | "bounce") => {
    toast.textContent = text;
    toast.className = `hud-toast ${kind}`;
    replay(toast, "on");
  };

  return {
    onEvent(e: SimEvent) {
      if (e.type === "go") show("GO!", "slam");
      if (e.type === "checkpoint") {
        show(`Checkpoint ${e.index + 1}`, "bounce");
        replay(status, "pop");
      }
    },
    draw(snap: Snapshot) {
      const { phase } = snap;
      status.textContent =
        phase.kind === "countdown"
          ? "0.0s"
          : phase.kind === "racing"
            ? `${((snap.tick - phase.startTick) / TICK_RATE).toFixed(1)}s`
            : `${(phase.timeMs / 1000).toFixed(2)}s`;

      // Big countdown number: pops in each time it changes.
      const number = phase.kind === "countdown" ? `${Math.ceil(phase.ticksLeft / TICK_RATE)}` : "";
      if (number !== shownCount) {
        shownCount = number;
        count.textContent = number;
        if (number) replay(count, "on");
        else count.classList.remove("on");
      }

      const done = phase.kind === "finished";
      if (done && !finish.classList.contains("on")) {
        finishTime.textContent = `${(phase.timeMs / 1000).toFixed(2)}s`;
        replay(finish, "on");
      } else if (!done) finish.classList.remove("on");

      fills.forEach((fill, i) => {
        const gas = snap.gas[i]!;
        const frac = gas / GAS_MAX;
        fill.style.width = `${frac * 100}%`;
        gasBars[i]!.classList.toggle("low", frac < LOW_GAS);
        gasBars[i]!.classList.toggle("draining", gas < lastGas[i]! - 1e-6);
        lastGas[i] = gas;
      });
    },
  };
}
