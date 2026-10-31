/**
 * A strip across the top for connection status, with an optional button (`action`). Returns a
 * function that removes it.
 */
export function showBanner(
  host: HTMLElement,
  text: string,
  tone: "info" | "error",
  action?: { label: string; run: () => void },
): () => void {
  const el = document.createElement("div");
  el.className = `banner ${tone}`;
  el.textContent = text;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "banner-action";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    // Space and Enter belong to the fart, not to a focused button; Esc still reaches the menu.
    button.addEventListener("keydown", (e) => {
      if (e.code !== "Escape") e.stopPropagation();
    });
    el.append(" ", button);
  }
  host.append(el);
  return () => el.remove();
}
