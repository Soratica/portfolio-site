// Drives the panel's lamps from the live status feed under /status/.
// Everything degrades to the static diagram when the feed is unreachable.
(() => {
  "use strict";

  const FEED = {
    status: "/status/status.json",   // in-cluster CronJob, every minute
    host: "/status/host.json",       // Proxmox host watcher, every 5 minutes
    register: "/status/register.json",
    route: "/status/route",          // nginx: serving pod + Cloudflare edge
  };
  const STALE_AFTER_S = { status: 300, host: 900 };
  const POLL_MS = 60_000;

  const STATE_TEXT = {
    running: "Running",
    deploying: "Deploying",
    down: "Fault",
    "switched-out": "Switched out",
    nodata: "No reading",
  };

  const NAMES = {
    portfolio: "Portfolio station, this site",
    gymhero: "Gym Hero station",
    music: "Music Shuffler station",
    "job-planner": "Job Planner station",
    monitoring: "Monitoring station",
  };

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  async function getJSON(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  const ageSeconds = (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? Infinity : Math.max(0, (Date.now() - t) / 1000);
  };

  function ago(iso) {
    const s = ageSeconds(iso);
    if (!Number.isFinite(s)) return "—";
    if (s < 90) return `${Math.round(s)} s ago`;
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 172800) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  function duration(sec) {
    if (!Number.isFinite(sec)) return "—";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    return d > 0 ? `up ${d} d ${h} h` : `up ${h} h`;
  }

  // ---- turn the feeds into one reading per station ----
  function readings(status, host) {
    const out = {};
    const statusFresh = status && ageSeconds(status.generated_at) < STALE_AFTER_S.status;
    const hostFresh = host && ageSeconds(host.generated_at) < STALE_AFTER_S.host;

    if (statusFresh) {
      for (const [id, s] of Object.entries(status.stations || {})) {
        out[id] = {
          state: s.state in STATE_TEXT ? s.state : "nodata",
          ready: Number.isFinite(s.desired) ? `${s.ready ?? 0}/${s.desired}` : "—",
          rollout: s.last_rollout || null,
        };
      }
    }
    if (hostFresh) {
      const h = host.stations || {};
      if (h.host) out.host = { state: h.host.state, ready: duration(h.host.uptime_s), rollout: null };
      if (h["docker-ct"]) out["docker-ct"] = { state: h["docker-ct"].state, ready: "—", rollout: null };
      if (h.watcher) out.watcher = { state: h.watcher.state, ready: `ran ${ago(h.watcher.last_run)}`, rollout: null, readyTitle: h.watcher.last_run };
      if (h.build) out.build = { state: h.build.state, ready: "—", rollout: null };
      const ct = h["k3s-learn"];
      const nodeReady = statusFresh && status.node && status.node.ready;
      if (ct || statusFresh) {
        let state = "nodata";
        if (ct && ct.state !== "running") state = ct.state;
        else if (statusFresh) state = nodeReady ? "running" : "down";
        out["k3s-learn"] = { state, ready: statusFresh && status.node ? status.node.version || "—" : "—", rollout: null };
      }
    } else if (statusFresh && status.node) {
      out["k3s-learn"] = { state: status.node.ready ? "running" : "down", ready: status.node.version || "—", rollout: null };
    }
    return { out, statusFresh, hostFresh };
  }

  function apply(out) {
    const ids = new Set($$("[data-stn]").map((el) => el.dataset.stn));
    for (const id of ids) {
      if (id === "visitor" || id === "edge") continue;
      const r = out[id] || { state: "nodata", ready: "—", rollout: null };
      for (const el of $$(`[data-stn="${id}"]`)) {
        el.dataset.state = r.state;
        const ind = el.querySelector("[data-ind]");
        if (ind) ind.textContent = STATE_TEXT[r.state];
        const ready = el.querySelector("[data-ready]");
        if (ready) {
          ready.textContent = r.ready;
          if (r.readyTitle) ready.title = new Date(r.readyTitle).toLocaleString();
        }
        const ro = el.querySelector("[data-rollout]");
        if (ro) {
          ro.textContent = r.rollout ? ago(r.rollout) : "—";
          ro.title = r.rollout ? new Date(r.rollout).toLocaleString() : "";
        }
      }
      for (const el of $$(`[data-reading="${id}"]`)) {
        if (id === "portfolio") { el.textContent = r.state === "nodata" ? "you are here" : `${r.ready} · you are here`; continue; }
        el.textContent = r.state === "switched-out" ? "switched out" : r.state === "nodata" ? "no reading" : `${r.ready} ${r.state === "running" ? "ready" : STATE_TEXT[r.state].toLowerCase()}`;
      }
      for (const a of $$(`[data-stn-link="${id}"]`)) {
        a.setAttribute("aria-label", `${NAMES[id] || id}: ${STATE_TEXT[r.state].toLowerCase()}`);
      }
    }
  }

  // ---- feed notice ----
  let lastStatusAt = null;
  function feedNotice(ok) {
    const lamp = document.querySelector("[data-feed-lamp]");
    const text = document.querySelector("[data-feed-text]");
    if (!lamp || !text) return;
    if (!ok) {
      lamp.dataset.state = "nodata";
      text.textContent = "Readings unavailable right now; showing the diagram only.";
      return;
    }
    lamp.dataset.state = "running";
    text.textContent = `Readings live · updated ${ago(lastStatusAt)}`;
  }

  // ---- register ----
  function renderRegister(reg) {
    const list = document.querySelector("[data-register]");
    if (!list) return;
    list.replaceChildren();
    const entries = reg && Array.isArray(reg.entries) ? reg.entries : null;
    if (!entries || entries.length === 0) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.className = "empty";
      span.textContent = entries ? "No deploys recorded yet. The next commit to any watched repo will appear here." : "Register unavailable right now.";
      li.append(span);
      list.append(li);
      return;
    }
    for (const e of entries.slice(0, 12)) {
      const li = document.createElement("li");
      const time = document.createElement("time");
      time.dateTime = e.at;
      time.title = new Date(e.at).toLocaleString();
      time.textContent = ago(e.at);
      const what = document.createElement("span");
      what.className = "what";
      const strong = document.createElement("strong");
      strong.textContent = e.app;
      const code = document.createElement("code");
      code.textContent = ` @ ${String(e.commit || "").slice(0, 7)}`;
      const subj = document.createElement("span");
      subj.className = "subject";
      subj.textContent = e.subject || "";
      what.append(strong, code, subj);
      li.append(time, what);
      list.append(li);
    }
  }

  // ---- route lights ----
  const SVGNS = "http://www.w3.org/2000/svg";
  const INGRESS = [
    [[390, 64], [450, 64]],
    [[530, 82], [530, 214]],
    [[610, 232], [695, 232]],
    [[760, 250], [760, 330]],
  ];
  const branch = (x) => [[[760, 330], [x, 330]], [[x, 330], [x, 392]]];

  function dotsFor(segments, step = 17) {
    const pts = [];
    for (const [[x1, y1], [x2, y2]] of segments) {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(1, Math.round(len / step));
      for (let i = 0; i <= n; i++) {
        if (i === 0 && pts.length) continue;
        const t = i / n;
        pts.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
      }
    }
    return pts;
  }

  const layer = document.getElementById("route-lights");
  const dotIndex = new Map();
  function dot([x, y]) {
    const key = `${Math.round(x)},${Math.round(y)}`;
    if (dotIndex.has(key)) return dotIndex.get(key);
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", x.toFixed(1));
    c.setAttribute("cy", y.toFixed(1));
    c.setAttribute("r", "2.6");
    c.setAttribute("class", "d-rl");
    layer.append(c);
    dotIndex.set(key, c);
    return c;
  }

  let visitorRoute = [];
  function setRoute(dots, cls, animate) {
    for (const c of dotIndex.values()) c.classList.remove("on", "trace");
    if (!animate || reduceMotion) {
      dots.forEach((c) => c.classList.add(cls));
      return;
    }
    dots.forEach((c, i) => setTimeout(() => c.classList.add(cls), 260 + i * 28));
  }

  function initRouteLights() {
    if (!layer) return;
    const stationXs = $$("a.stn[data-x]").map((a) => Number(a.dataset.x));
    for (const x of stationXs) dotsFor([...INGRESS, ...branch(x)]).forEach(dot);
    visitorRoute = dotsFor([...INGRESS, ...branch(420)]).map(dot);

    for (const a of $$("a.stn[data-x]")) {
      const route = dotsFor([...INGRESS, ...branch(Number(a.dataset.x))]).map(dot);
      const on = () => setRoute(route, "trace", false);
      const off = () => setRoute(visitorRoute, "on", false);
      a.addEventListener("mouseenter", on);
      a.addEventListener("focus", on);
      a.addEventListener("mouseleave", off);
      a.addEventListener("blur", off);
    }
  }

  // ---- route + pod ----
  async function loadRoute() {
    const r = await getJSON(FEED.route);
    const pod = document.querySelector("[data-pod]");
    if (r && r.pod && pod) pod.textContent = r.pod;
    const edge = r && /^[A-Z]{3}$/.test(r.edge || "") ? r.edge : null;
    for (const el of $$("[data-edge-label]")) el.textContent = edge ? `edge location ${edge}` : "edge location —";
    const reached = Boolean(r);
    for (const el of $$('[data-stn="visitor"], [data-stn="edge"]')) el.dataset.state = reached && (el.dataset.stn === "visitor" || edge) ? "running" : "nodata";
    if (reached && layer) setRoute(visitorRoute, "on", true);
  }

  // ---- main loop ----
  async function refresh() {
    const [status, host, reg] = await Promise.all([getJSON(FEED.status), getJSON(FEED.host), getJSON(FEED.register)]);
    const { out, statusFresh } = readings(status, host);
    apply(out);
    lastStatusAt = statusFresh ? status.generated_at : null;
    feedNotice(statusFresh);
    renderRegister(reg);
  }

  initRouteLights();
  loadRoute();
  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(() => { if (lastStatusAt) feedNotice(true); }, 5000);
})();
