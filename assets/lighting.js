// Panel lighting: night by default, day on request. Runs in <head> so the
// saved choice applies before first paint; storage failures fall back to night.
(() => {
  "use strict";
  const KEY = "panel-lighting";
  const COLORS = { dark: "#1c231f", light: "#c3ccbd" };
  const root = document.documentElement;

  let theme = "dark";
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") theme = saved;
  } catch {}
  root.dataset.theme = theme;

  function sync() {
    const night = root.dataset.theme !== "light";
    for (const b of document.querySelectorAll(".lighting")) {
      b.setAttribute("aria-checked", String(night));
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = night ? COLORS.dark : COLORS.light;
  }

  document.addEventListener("DOMContentLoaded", () => {
    sync();
    for (const b of document.querySelectorAll(".lighting")) {
      b.addEventListener("click", () => {
        root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
        try { localStorage.setItem(KEY, root.dataset.theme); } catch {}
        sync();
      });
    }
  });
})();
