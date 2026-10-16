/** A strip across the top for connection status. Returns a function that removes it. */
export function showBanner(host: HTMLElement, text: string, tone: "info" | "error"): () => void {
  const el = document.createElement("div");
  el.className = `banner ${tone}`;
  el.textContent = text;
  host.append(el);
  return () => el.remove();
}
