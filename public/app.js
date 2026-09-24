"use strict";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stClass = (name) => "st-" + String(name || "").replace(/[^a-z]/gi, "");

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === "auth") {
    showAuthBanner(data.message);
    throw new Error(data.message || "Session expired");
  }
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

function showAuthBanner(msg) {
  const b = $("#authBanner");
  b.querySelector("span").textContent =
    msg || "Creatio session cookies have expired. Update them in Settings.";
  b.classList.remove("hidden");
}
function hideAuthBanner() { $("#authBanner").classList.add("hidden"); }

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  if (name === "settings") loadConfig();
  else if (name === "workspace") loadWorkspace();
}
$$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) switchTab(g.dataset.goto);
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  mode: "owner",
  chosen: [],      // chosen candidate GUIDs (owner/account)
  meta: null,
  cases: [],       // last loaded case rows
  aiAvailable: false,
  analyzing: false,
  currentAbort: null, // AbortController for the running analysis
  // Workspace panel: 1-3 folders analyzed together as one unit.
  ws: {
    paths: [],
    files: [],
    folders: [],
    count: 0,
    cap: 10,
    maxPaths: 3,
    overCap: false,
    skipped: null,
    running: false,
    abort: null,
    // Phase 1: the bound case. `brief` holds its description + timeline as
    // fetched by the server; client-written prose, shown as data.
    case: { number: "", brief: null, ageHours: null },
    // Phase 1's own search state, kept separate from the Lookup tab's.
    picker: { mode: "number", chosen: "", cases: [], searching: false },
    // Phase 3: the proposed fix, awaiting approval. Never applied implicitly.
    plan: null,
    planning: false,
    planAbort: null,
  },
};

// ---------------------------------------------------------------------------
// Mode segmented control
// ---------------------------------------------------------------------------
const MODE_CFG = {
  owner: { label: "Owner name", placeholder: "e.g. Leyba", hint: "Type a name, then pick the right person.", resolve: true },
  account: { label: "Account / school name", placeholder: "e.g. Hope Christian Academy", hint: "Type an account, then pick the right one.", resolve: true },
  number: { label: "Case number(s)", placeholder: "e.g. SR00026236, SR00031980", hint: "Comma-separate multiple SR numbers.", resolve: false },
  recent: { label: "", placeholder: "", hint: "Returns the newest cases regardless of owner.", resolve: false },
};

function setMode(mode) {
  state.mode = mode;
  state.chosen = [];
  $$("#modeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const cfg = MODE_CFG[mode];
  const valueField = $("#valueField");
  if (mode === "recent") {
    valueField.classList.add("hidden");
  } else {
    valueField.classList.remove("hidden");
    $("#valueLabel").textContent = cfg.label;
    $("#valueInput").placeholder = cfg.placeholder;
    $("#valueInput").value = "";
    $("#valueHint").textContent = cfg.hint;
    $("#resolveBtn").classList.toggle("hidden", !cfg.resolve);
  }
  $("#candidates").classList.add("hidden");
  $("#candidates").innerHTML = "";
}
$$("#modeSeg button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

// ---------------------------------------------------------------------------
// Resolve (owner/account) -> candidate picker
// ---------------------------------------------------------------------------
async function doResolve() {
  const name = $("#valueInput").value.trim();
  if (!name) return;
  const box = $("#candidates");
  box.classList.remove("hidden");
  box.innerHTML = '<div class="candidate"><span class="spinner"></span>&nbsp;Searching…</div>';
  try {
    const { candidates } = await api(`/api/resolve?type=${state.mode}&name=${encodeURIComponent(name)}`);
    if (!candidates.length) {
      box.innerHTML = '<div class="candidate">No matches found.</div>';
      return;
    }
    state.chosen = [];
    const many = candidates.length > 1;
    box.innerHTML =
      (many ? `<div class="candidate" data-all="1"><strong>Select all ${candidates.length} matches</strong></div>` : "") +
      candidates
        .map(
          (c) =>
            `<div class="candidate" data-id="${esc(c.Id)}"><span>${esc(c.Name)}</span><span class="cid">${esc(c.Id.slice(0, 8))}…</span></div>`
        )
        .join("");
    if (candidates.length === 1) {
      state.chosen = [candidates[0].Id];
      box.querySelector(".candidate[data-id]").classList.add("chosen");
    }
    box.querySelectorAll(".candidate").forEach((el) => {
      el.addEventListener("click", () => {
        if (el.dataset.all) {
          const ids = candidates.map((c) => c.Id);
          const allChosen = ids.every((id) => state.chosen.includes(id));
          state.chosen = allChosen ? [] : ids;
        } else {
          const id = el.dataset.id;
          if (state.chosen.includes(id)) state.chosen = state.chosen.filter((x) => x !== id);
          else state.chosen.push(id);
        }
        box.querySelectorAll(".candidate[data-id]").forEach((c) =>
          c.classList.toggle("chosen", state.chosen.includes(c.dataset.id))
        );
      });
    });
  } catch (e) {
    box.innerHTML = `<div class="candidate">Error: ${esc(e.message)}</div>`;
  }
}
$("#resolveBtn").addEventListener("click", doResolve);
$("#valueInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); MODE_CFG[state.mode].resolve ? doResolve() : doSearch(); }
});

// ---------------------------------------------------------------------------
// Status chips
// ---------------------------------------------------------------------------
function buildStatusChips() {
  const chips = $("#statusChips");
  const openActive = state.meta.openActive;
  const items = [
    { value: "__open", label: "Open / active", checked: true },
    ...state.meta.statuses.map((s) => ({ value: s, label: s })),
    { value: "__all", label: "All statuses" },
  ];
  chips.innerHTML = items
    .map(
      (it) =>
        `<label class="chip"><input type="checkbox" value="${esc(it.value)}" ${it.checked ? "checked" : ""}/>${esc(it.label)}</label>`
    )
    .join("");
  chips.querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("change", () => {
      if (inp.value === "__open" && inp.checked) { setGroup(openActive); uncheck("__all"); }
      else if (inp.value === "__all" && inp.checked) { setGroup(state.meta.statuses); uncheck("__open"); }
      else if (inp.value.startsWith("__")) { /* group uncheck: leave individuals */ }
      else { uncheck("__open"); uncheck("__all"); }
    });
  });
  function setGroup(names) {
    chips.querySelectorAll("input").forEach((i) => {
      if (!i.value.startsWith("__")) i.checked = names.includes(i.value);
    });
  }
  function uncheck(val) {
    const el = chips.querySelector(`input[value="${val}"]`);
    if (el) el.checked = false;
  }
}

function selectedStatuses() {
  const chips = $("#statusChips");
  if (chips.querySelector('input[value="__all"]')?.checked) return state.meta.statuses;
  if (chips.querySelector('input[value="__open"]')?.checked) return state.meta.openActive;
  const picked = [...chips.querySelectorAll("input:checked")].map((i) => i.value).filter((v) => !v.startsWith("__"));
  return picked.length ? picked : state.meta.openActive;
}

function selectedDetail() {
  const picked = $$('#detailChips input:checked').map((i) => i.value);
  return picked.length ? picked : ["summary"];
}

// ---------------------------------------------------------------------------
// Search + render
// ---------------------------------------------------------------------------
async function doSearch() {
  hideAuthBanner();
  const status = $("#searchStatus");
  const btn = $("#searchBtn");

  const body = { statuses: selectedStatuses(), detail: selectedDetail(), mode: state.mode };
  if (state.mode === "owner" || state.mode === "account") {
    if (!state.chosen.length) {
      status.textContent = "Pick at least one match first (click Find).";
      status.className = "status err";
      return;
    }
    body.guids = state.chosen;
  } else if (state.mode === "number") {
    const nums = $("#valueInput").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!nums.length) { status.textContent = "Enter at least one SR number."; status.className = "status err"; return; }
    body.numbers = nums;
  }

  btn.disabled = true;
  status.textContent = "";
  status.className = "status";
  showProgress(true);
  setProgress(null, "Searching…");
  try {
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.error === "auth") { showAuthBanner(data.message); throw new Error(data.message); }
      throw new Error(data.message || `Search failed (${res.status})`);
    }
    await consumeSse(res.body, {
      found: (d) => {
        state.cases = d.cases.map((c) => ({ ...c }));
        renderResults({ cases: d.cases, tally: d.tally, truncated: d.truncated, caveats: d.caveats });
        if (d.needDetail) setProgress(0, `Loading details 0/${d.total}`);
        else setProgress(100, "");
      },
      case: (d) => {
        if (state.cases[d.index]) { state.cases[d.index].detail = d.detail; updateDetailCell(d.index); }
      },
      progress: (d) => {
        const pct = d.total ? Math.round((d.done / d.total) * 100) : 100;
        setProgress(pct, `Loading details ${d.done}/${d.total} (${pct}%)`);
      },
      done: () => {},
      error: (d) => { if (d.kind === "auth") showAuthBanner(d.message); throw new Error(d.message || "Search error"); },
    });
    status.textContent = `${state.cases.length} case${state.cases.length === 1 ? "" : "s"} found`;
    status.className = "status ok";
  } catch (e) {
    status.textContent = e.message;
    status.className = "status err";
  } finally {
    btn.disabled = false;
    hideProgressSoon();
  }
}
$("#searchBtn").addEventListener("click", doSearch);

// Progress bar helpers
function showProgress(on) { $("#searchProgress")?.classList.toggle("hidden", !on); }
function hideProgressSoon() { setTimeout(() => showProgress(false), 600); }
function setProgress(pct, label) {
  const fill = $("#progressFill");
  const lab = $("#progressLabel");
  if (fill) {
    if (pct == null) { fill.classList.add("indeterminate"); fill.style.width = "35%"; }
    else { fill.classList.remove("indeterminate"); fill.style.width = pct + "%"; }
  }
  if (lab) lab.textContent = label || "";
}

function renderResults(data) {
  const root = $("#results");
  if (!data.cases.length) {
    root.innerHTML = '<div class="card"><div class="empty">No cases matched your filters.</div></div>';
    return;
  }
  const detail = selectedDetail();
  const showDetail = detail.some((d) => d !== "summary");

  const tally = Object.entries(data.tally)
    .map(([k, v]) => `<span class="pill">${esc(k)}: ${v}</span>`)
    .join("");
  const caveats = (data.caveats || []).map((c) => `<div class="caveat">⚠ ${esc(c)}</div>`).join("");

  const rows = data.cases
    .map((c, i) => {
      const summary = `
        <tr class="case-row" data-i="${i}">
          <td class="chk"><input type="checkbox" class="rowchk" data-i="${i}" checked /></td>
          <td class="num">${esc(c.Number)}</td>
          <td>${esc(c.Subject)}</td>
          <td><span class="st-badge ${stClass(c.Status)}">${esc(c.Status)}</span></td>
          <td>${esc(c.Account)}</td>
          <td>${esc(c.Contact)}</td>
          <td>${esc(fmtDate(c.CreatedOn))}</td>
          <td class="row-actions">
            ${state.aiAvailable ? `<button class="row-ai" data-ai="${i}" title="Analyze this case with AI">✨</button>` : ""}
            ${showDetail ? `<button class="expand-btn" data-exp="${i}">▸ detail</button>` : ""}
          </td>
        </tr>`;
      const detailRow = showDetail
        ? `<tr class="detail-row hidden" data-detail="${i}"><td colspan="8" class="detail-cell"><div class="detail-pending"><span class="spinner"></span> loading…</div></td></tr>`
        : "";
      return summary + detailRow;
    })
    .join("");

  root.innerHTML = `
    ${state.aiAvailable ? aiToolbarHtml() : aiSetupHtml()}
    <div class="card">
      <div class="tally">${tally}</div>
      ${caveats}
      <div class="table-wrap">
      <table class="cases">
        <thead><tr>
          <th class="chk"><input type="checkbox" id="chkAll" checked /></th>
          <th>Number</th><th>Subject</th><th>Status</th><th>Account</th><th>Contact</th><th>Created</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>
    <div id="analysisPanel" class="card analysis hidden"></div>`;

  root.querySelectorAll("[data-exp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = btn.dataset.exp;
      const dr = root.querySelector(`[data-detail="${i}"]`);
      const open = !dr.classList.contains("hidden");
      dr.classList.toggle("hidden", open);
      btn.textContent = open ? "▸ detail" : "▾ detail";
    });
  });

  // Per-case "analyze this one"
  root.querySelectorAll("[data-ai]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = state.cases[+btn.dataset.ai];
      runAnalysis("summarize", "", [mapCaseForAnalysis(c)]);
    });
  });

  // Selection wiring
  const chkAll = $("#chkAll");
  const rowChks = () => $$(".rowchk", root);
  if (chkAll) chkAll.addEventListener("change", () => { rowChks().forEach((c) => (c.checked = chkAll.checked)); updateScope(); });
  rowChks().forEach((c) => c.addEventListener("change", updateScope));

  if (state.aiAvailable) wireAiToolbar();
  updateScope();

  // Fill any detail cells whose data already arrived (e.g. re-render).
  state.cases.forEach((c, i) => { if (c.detail) updateDetailCell(i); });
}

// Fill a case's detail cell once its streamed detail arrives.
function updateDetailCell(i) {
  const cell = $(`[data-detail="${i}"] .detail-cell`);
  if (!cell || !state.cases[i]) return;
  cell.innerHTML = renderDetail(state.cases[i], selectedDetail());
}

// Send only the summary fields; the server auto-fetches description + timeline.
function mapCaseForAnalysis({ Id, Number, Subject, Status, Account, Contact, CreatedOn }) {
  return { Id, Number, Subject, Status, Account, Contact, CreatedOn };
}

function selectedCaseRows() {
  const idxs = $$(".rowchk").filter((c) => c.checked).map((c) => +c.dataset.i);
  const rows = idxs.length ? idxs.map((i) => state.cases[i]) : state.cases;
  return rows.map(mapCaseForAnalysis);
}

function updateScope() {
  const el = $("#aiScope");
  if (!el) return;
  const total = state.cases.length;
  const sel = $$(".rowchk").filter((c) => c.checked).length;
  el.textContent = sel && sel < total ? `${sel} selected` : `all ${total}`;
}

// ---------------------------------------------------------------------------
// Detail rendering
// ---------------------------------------------------------------------------
// --- attachment / inline-image helpers ---
function imgSrc(seg) {
  return seg.dataUri
    ? seg.dataUri
    : `/api/file?entity=${encodeURIComponent(seg.entity)}&id=${encodeURIComponent(seg.id)}`;
}
// Mention sentinels, mirrored from src/caseLookup.ts. The server wraps an
// @mention's display name in these private-use code points; escaping leaves
// them untouched, so we escape FIRST and only then swap them for chip markup —
// no Creatio HTML ever reaches the DOM.
const MENTION_OPEN = "\uE000";
const MENTION_CLOSE = "\uE001";
const MENTION_RE = new RegExp(MENTION_OPEN + "([^" + MENTION_CLOSE + "]*)" + MENTION_CLOSE, "g");

/** Swap mention sentinels in ALREADY-ESCAPED text for chips. */
function withMentions(escaped) {
  return String(escaped).replace(MENTION_RE, (_m, name) => {
    const letter = (name.match(/[A-Za-z0-9]/) || ["@"])[0].toUpperCase();
    return (
      `<span class="mention">` +
      `<span class="mention-dot" style="background:hsl(${avatarHue(name)} 52% 40%)">${letter}</span>` +
      `${name}</span>`
    );
  });
}
/** Escape, keep soft line breaks, then render mentions. */
function inlineText(t) {
  return withMentions(esc(String(t || "")).replace(/\n/g, "<br/>"));
}

// A blank line starts a new paragraph; a single newline is a soft break inside
// one. Real <p> blocks (rather than white-space:pre-wrap) are what keep every
// paragraph flush to the same left edge.
function renderTextBlock(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${inlineText(p)}</p>`)
    .join("");
}
function renderSegments(segments) {
  return (segments || [])
    .map((s) => {
      if (s.type === "text") return `<div class="seg-text">${renderTextBlock(s.text)}</div>`;
      if (s.type === "list") {
        const tag = s.ordered ? "ol" : "ul";
        return `<${tag} class="seg-list">${(s.items || [])
          .map((i) => `<li>${inlineText(i)}</li>`)
          .join("")}</${tag}>`;
      }
      return `<img class="seg-img" src="${imgSrc(s)}" loading="lazy" alt="attachment" title="Click to enlarge" />`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Timeline entry header — who posted, and when
// ---------------------------------------------------------------------------
/** Stable per-person colour: the same name always lands on the same hue, so a
 *  person's avatar looks the same on every case. */
function avatarHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (parts[0][0] + last).toUpperCase();
}
/** Creatio's wording for recent posts; anything older gets the real date. The
 *  absolute timestamp stays available as the element's tooltip. */
function relDate(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
  if (days < 0 || days >= 7) return fmtDate(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  if (days === 2) return `The day before yesterday at ${time}`;
  return `${d.toLocaleDateString([], { weekday: "long" })} at ${time}`;
}
/** True when this entry is one of the contacts you searched by. There is no
 *  configured "current user", so with no owner selected nothing is tagged. */
function isMine(authorId) {
  if (!authorId || state.mode !== "owner") return false;
  const id = String(authorId).toLowerCase();
  return (state.chosen || []).some((g) => String(g).toLowerCase() === id);
}
function tlHead(t) {
  const name = t.author || "";
  const style = name ? `background:hsl(${avatarHue(name)} 52% 40%)` : "background:var(--muted)";
  const verb = t.kind === "EMAIL" ? "emailed on" : "posted in";
  return `<div class="tl-head">
    <span class="tl-avatar" style="${style}" aria-hidden="true">${esc(name ? initials(name) : "?")}</span>
    <div class="tl-headtext">
      <div class="tl-byline">
        <span class="tl-author${name ? "" : " unknown"}">${esc(name || "Unknown author")}</span>
        <span class="tl-verb">${verb} case</span>
        ${isMine(t.authorId) ? '<span class="tl-you">you</span>' : ""}
        <span class="tl-kind ${t.kind}">${t.kind}</span>
      </div>
      <div class="tl-when" title="${esc(fmtDate(t.ts))}">${esc(relDate(t.ts))}</div>
    </div>
  </div>`;
}

function renderThumbs(images) {
  if (!images || !images.length) return "";
  return `<div class="thumbs">${images
    .map((im) => `<img class="seg-img thumb" src="/api/file?entity=${encodeURIComponent(im.entity)}&id=${encodeURIComponent(im.id)}" loading="lazy" alt="attachment" title="Click to enlarge" />`)
    .join("")}</div>`;
}

/**
 * A case's detail, split the way Creatio splits it: General info is what the
 * case IS (description, dates, hours), Timeline is what has HAPPENED on it.
 *
 * Tabs only appear when both halves have content — with a single section there
 * is nothing to switch between, so the bar would be noise.
 */
function renderDetail(c, detail) {
  const d = c.detail || {};
  const general = [];
  const timeline = [];

  if (detail.includes("description")) {
    const body = d.descriptionSegments && d.descriptionSegments.length
      ? `<div class="desc rich">${renderSegments(d.descriptionSegments)}</div>`
      : `<div class="desc">${esc(d.description || "(none)")}</div>`;
    general.push(`<h4>Description</h4>${body}`);
  }
  if (detail.includes("extra") && d.extra) {
    const e = d.extra;
    const erows = [
      ["Registered", fmtDate(e.RegisteredOn)],
      ["Modified", fmtDate(e.ModifiedOn)],
      ["Response due", fmtDate(e.ResponseDate)],
      ["Solution date", fmtDate(e.SolutionDate)],
      ["Solution overdue", e.SolutionOverdue == null ? "" : e.SolutionOverdue ? "Yes" : "No"],
      ["Hours worked", e.NltHoursWorked ?? ""],
    ].filter(([, v]) => v !== "" && v != null);
    general.push(
      `<h4>Extra fields</h4><div class="extra-grid">${erows
        .map(([k, v]) => `<span class="k">${esc(k)}</span><span>${esc(v)}</span>`)
        .join("")}</div>`
    );
  }

  if (detail.includes("latest") && d.latest !== undefined) {
    timeline.push(
      `<h4>Latest update</h4>${d.latest ? tlEntry(d.latest) : '<div class="desc">(no timeline entries)</div>'}`
    );
  }
  let tlCount = null;
  if (detail.includes("timeline")) {
    const tl = d.timeline || [];
    tlCount = tl.length;
    timeline.push(
      `<h4>Conversation / timeline (${tl.length})</h4>` +
        (tl.length
          ? `<ul class="timeline">${tl.map(tlEntry).join("")}</ul>`
          : '<div class="desc">(no timeline entries)</div>')
    );
  }

  // Creatio's order: Timeline first, General info second.
  const panes = [
    { key: "timeline", label: `Timeline${tlCount === null ? "" : ` (${tlCount})`}`, html: timeline.join("") },
    { key: "general", label: "General info", html: general.join("") },
  ].filter((p) => p.html);

  if (!panes.length) return '<div class="detail-box"></div>';
  if (panes.length === 1) return `<div class="detail-box">${panes[0].html}</div>`;

  // Open on General info: read what the case is about before the back-and-forth.
  const active = panes.some((p) => p.key === "general") ? "general" : panes[0].key;
  const tabs = panes
    .map(
      (p) =>
        `<button type="button" class="dtab${p.key === active ? " active" : ""}" role="tab" ` +
        `aria-selected="${p.key === active}" data-dpane="${p.key}">${esc(p.label)}</button>`
    )
    .join("");
  const bodies = panes
    .map(
      (p) =>
        `<div class="dpane${p.key === active ? "" : " hidden"}" role="tabpanel" data-dpane="${p.key}">${p.html}</div>`
    )
    .join("");
  return `<div class="detail-box"><div class="dtabs" role="tablist">${tabs}</div>${bodies}</div>`;
}

// Detail boxes are re-rendered wholesale, so switching tabs is delegated rather
// than wired per box.
document.addEventListener("click", (e) => {
  const tab = e.target.closest(".dtab");
  if (!tab) return;
  const box = tab.closest(".detail-box");
  if (!box) return;
  const key = tab.dataset.dpane;
  $$(".dtab", box).forEach((b) => {
    const on = b.dataset.dpane === key;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $$(".dpane", box).forEach((p) => p.classList.toggle("hidden", p.dataset.dpane !== key));
});

function tlEntry(t) {
  // The sender is already the header's author line, so the meta row only needs
  // to say who it went to.
  const meta =
    t.kind === "EMAIL"
      ? `<div class="tl-meta">to ${esc(t.recipient || "(unknown)")}${t.title ? " · " + esc(t.title) : ""}</div>`
      : "";
  // Feed posts are clean rich text → render inline (incl. FeedFile images).
  // Emails → trimmed text + any real file attachments as thumbnails.
  let body;
  if (t.kind === "FEED" && t.segments && t.segments.length) {
    body = `<div class="tl-text rich">${renderSegments(t.segments)}</div>`;
  } else {
    body = `<div class="tl-text">${renderTextBlock(t.text) || "<p>(empty)</p>"}</div>${renderThumbs(t.images)}`;
    // (renderTextBlock already escapes and renders any mention sentinels)
  }
  return `<li class="tl-entry ${t.kind}">
    ${tlHead(t)}
    ${meta}
    ${body}
  </li>`;
}

// Lightbox: click any attachment image to view full size.
document.addEventListener("click", (e) => {
  const img = e.target.closest("img.seg-img");
  if (img) { openLightbox(img.src); return; }
  if (e.target.id === "lightbox" || e.target.classList.contains("lb-close")) closeLightbox();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });
function openLightbox(src) {
  let lb = $("#lightbox");
  if (!lb) {
    lb = document.createElement("div");
    lb.id = "lightbox";
    lb.className = "lightbox hidden";
    lb.innerHTML = '<button class="lb-close" title="Close (Esc)">✕</button><img class="lb-img" alt="attachment" />';
    document.body.appendChild(lb);
  }
  $(".lb-img", lb).src = src;
  lb.classList.remove("hidden");
}
function closeLightbox() { $("#lightbox")?.classList.add("hidden"); }

// ===========================================================================
// AI analysis
// ===========================================================================
const PRESETS = [
  { key: "summarize", label: "Summarize & prioritize", icon: "📋" },
  { key: "themes", label: "Common themes", icon: "🧩" },
  { key: "actions", label: "Next actions", icon: "✅" },
];

function aiToolbarHtml() {
  return `
  <div class="card ai-bar">
    <div class="ai-bar-head">
      <span class="ai-title">✨ Analyze with AI</span>
      <span class="ai-scope">Scope: <strong id="aiScope">all</strong> cases</span>
    </div>
    <div class="ai-actions">
      ${PRESETS.map((p) => `<button class="ai-preset" data-preset="${p.key}"><span>${p.icon}</span> ${esc(p.label)}</button>`).join("")}
    </div>
    <div class="ai-ask">
      <input id="aiQuestion" type="text" placeholder="…or ask anything about these cases (e.g. which are stale and waiting on the client?)" />
      <button id="aiAskBtn" class="secondary">Ask</button>
    </div>
  </div>`;
}

function aiSetupHtml() {
  return `
  <div class="card ai-bar disabled">
    <div class="ai-bar-head"><span class="ai-title">✨ Analyze with AI</span></div>
    <p class="hint">To enable AI analysis, install the Claude CLI and sign in:
    open a terminal, run <code>npm i -g @anthropic-ai/claude-code</code>, then <code>claude</code> and log in.
    Restart the app afterwards.</p>
  </div>`;
}

function wireAiToolbar() {
  $$(".ai-preset").forEach((b) => b.addEventListener("click", () => runAnalysis(b.dataset.preset)));
  const askBtn = $("#aiAskBtn");
  const q = $("#aiQuestion");
  if (askBtn) askBtn.addEventListener("click", () => runAnalysis("ask", q.value));
  if (q) q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runAnalysis("ask", q.value); } });
}

async function runAnalysis(preset, question, casesOverride) {
  if (state.analyzing) return;
  const cases = casesOverride || selectedCaseRows();
  if (!cases.length) return;
  if (preset === "ask" && !(question || "").trim()) {
    $("#aiQuestion")?.focus();
    return;
  }

  const panel = $("#analysisPanel");
  panel.classList.remove("hidden");
  const single = casesOverride && casesOverride.length === 1 ? casesOverride[0].Number : null;
  const presetLabel = preset === "ask" ? "Question" : (PRESETS.find((p) => p.key === preset)?.label || preset);
  const scopeLabel = single ? esc(single) : `${cases.length} case${cases.length === 1 ? "" : "s"}`;
  panel.innerHTML = `
    <div class="ai-head">
      <span class="ai-run-title">✨ ${esc(presetLabel)} <span class="muted">· ${scopeLabel}</span></span>
      <span class="ai-tools">
        <button id="aiStop" class="ai-tool stop-btn" title="Stop">■ Stop</button>
        <span class="ai-status"><span class="spinner"></span> thinking…</span>
      </span>
    </div>
    ${preset === "ask" ? `<div class="ai-question">${esc(question)}</div>` : ""}
    <div class="ai-output md streaming" id="aiOutput"></div>
    <div class="ai-foot hidden" id="aiFoot"></div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const output = $("#aiOutput");
  let raw = "";
  let stopped = false;
  state.analyzing = true;
  setPresetsDisabled(true);

  const controller = new AbortController();
  state.currentAbort = controller;
  $("#aiStop").addEventListener("click", () => { stopped = true; controller.abort(); });

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset, question, cases }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `Analysis failed (${res.status})`);
    }
    await consumeSse(res.body, {
      chunk: (d) => { raw += d.text; output.innerHTML = renderMarkdown(raw); output.scrollTop = output.scrollHeight; },
      done: (d) => {
        output.classList.remove("streaming");
        $(".ai-status", panel).innerHTML = "✓ done";
        finishTools($(".ai-tools", panel), raw, single || (preset === "ask" ? "question" : preset));
        const foot = $("#aiFoot");
        const bits = [];
        if (d.totalTokens) bits.push(`${d.totalTokens.toLocaleString()} tokens`);
        if (typeof d.costUsd === "number") bits.push(`$${d.costUsd.toFixed(4)}`);
        if (d.durationMs) bits.push(`${(d.durationMs / 1000).toFixed(1)}s`);
        if (d.truncatedCases) bits.push(`⚠ ${d.truncatedCases} case(s) omitted to fit context`);
        if (bits.length) { foot.textContent = bits.join(" · "); foot.classList.remove("hidden"); }
      },
      error: (d) => { throw new Error(d.message || "Analysis error"); },
    });
  } catch (e) {
    output.classList.remove("streaming");
    const st = $(".ai-status", panel);
    if (stopped || e.name === "AbortError") {
      if (st) st.innerHTML = '<span class="muted">stopped</span>';
      if (raw) finishTools($(".ai-tools", panel), raw, single || preset);
    } else {
      if (st) st.innerHTML = '<span class="err-text">failed</span>';
      output.innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
    }
  } finally {
    state.analyzing = false;
    state.currentAbort = null;
    setPresetsDisabled(false);
    $("#aiStop")?.remove();
  }
}

// Replace the Stop button with Copy / Download once a run ends (with text).
// Takes the .ai-tools ELEMENT rather than a panel + id lookup: the case panel
// and the workspace panel can stream concurrently, and an id-based query would
// find the wrong one.
function finishTools(tools, raw, label, filePrefix = "case-analysis") {
  if (!tools) return;
  $(".stop-btn", tools)?.remove();
  const copyBtn = document.createElement("button");
  copyBtn.className = "ai-tool";
  copyBtn.textContent = "⧉ Copy";
  copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(raw); copyBtn.textContent = "✓ Copied"; setTimeout(() => (copyBtn.textContent = "⧉ Copy"), 1500); }
    catch { copyBtn.textContent = "copy failed"; }
  });
  const dlBtn = document.createElement("button");
  dlBtn.className = "ai-tool";
  dlBtn.textContent = "⬇ .md";
  dlBtn.title = "Download as Markdown";
  dlBtn.addEventListener("click", () => {
    const blob = new Blob([raw], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filePrefix}-${String(label).replace(/[^\w.-]+/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });
  tools.prepend(dlBtn);
  tools.prepend(copyBtn);
}

function setPresetsDisabled(v) {
  $$(".ai-preset").forEach((b) => (b.disabled = v));
  const ab = $("#aiAskBtn"); if (ab) ab.disabled = v;
  $$(".row-ai").forEach((b) => (b.disabled = v));
}

// Parse a Server-Sent Events stream from a fetch body.
async function consumeSse(body, handlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = "message", data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed; try { parsed = JSON.parse(data); } catch { continue; }
      if (handlers[event]) handlers[event](parsed);
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal, safe Markdown renderer (no external deps).
// Escapes HTML first, then applies a small subset: headings, bold, italic,
// inline code, fenced code, links, unordered/ordered lists, paragraphs.
// ---------------------------------------------------------------------------
function renderMarkdown(src) {
  const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  let listType = null; // 'ul' | 'ol'
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };

  const inline = (t) => {
    let s = esc(t);
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line.trim())) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      html += `<pre><code>${esc(buf.join("\n"))}</code></pre>`;
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; i++; continue; }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); html += "<hr/>"; i++; continue; }

    // Unordered list item
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) { if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; } html += `<li>${inline(ul[1])}</li>`; i++; continue; }

    // Ordered list item
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; } html += `<li>${inline(ol[1])}</li>`; i++; continue; }

    // Blank line
    if (!line.trim()) { closeList(); i++; continue; }

    // Paragraph (accumulate consecutive non-empty, non-special lines)
    closeList();
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+[.)]\s|\s*-{3,}\s*$)/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    html += `<p>${inline(para.join(" "))}</p>`;
  }
  closeList();
  return html;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function loadConfig() {
  const s = $("#cfgStatus");
  s.textContent = "";
  try {
    const cfg = await api("/api/config");
    $("#cfgBaseUrl").value = cfg.baseUrl || "";
    $("#cfgAllowlist").value = cfg.allowlist || "";
    $("#cfgMaxTop").value = cfg.maxTop || "";
    $("#cfgAspx").value = "";
    $("#cfgCsrf").value = "";
    $("#cfgLoader").value = "";
    $("#cfgAspx").placeholder = cfg.cookies.hasAspx ? cfg.cookies.aspx : "paste .ASPXAUTH value";
    $("#cfgCsrf").placeholder = cfg.cookies.hasCsrf ? cfg.cookies.csrf : "paste BPMCSRF value";
    $("#cfgLoader").placeholder = cfg.cookies.hasLoader ? cfg.cookies.loader : "paste BPMLOADER value";
    setPill("#stAspx", cfg.cookies.hasAspx);
    setPill("#stCsrf", cfg.cookies.hasCsrf);
    setPill("#stLoader", cfg.cookies.hasLoader);
  } catch (e) {
    s.textContent = e.message;
    s.className = "status err";
  }
}
function setPill(sel, set) {
  const el = $(sel);
  el.textContent = set ? "set" : "not set";
  el.className = "pill " + (set ? "set" : "unset");
}

$("#revealCookies").addEventListener("change", (e) => {
  const type = e.target.checked ? "text" : "password";
  ["#cfgAspx", "#cfgCsrf", "#cfgLoader"].forEach((s) => ($(s).type = type));
});

async function saveConfig() {
  const s = $("#cfgStatus");
  s.innerHTML = '<span class="spinner"></span> Saving…';
  s.className = "status";
  try {
    const data = await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: $("#cfgBaseUrl").value,
        allowlist: $("#cfgAllowlist").value,
        maxTop: $("#cfgMaxTop").value,
        aspx: $("#cfgAspx").value,
        csrf: $("#cfgCsrf").value,
        loader: $("#cfgLoader").value,
      }),
    });
    let msg = "Saved.";
    if (data.connection && data.connection.ok) { msg += " Connection OK."; hideAuthBanner(); }
    else if (data.connection) msg += " But connection test failed: " + (data.connection.error || "").slice(0, 120);
    if (data.restartNeeded) msg += " (Base URL / allowlist / row cap changes need an app restart.)";
    s.textContent = msg;
    s.className = "status " + (data.connection && data.connection.ok ? "ok" : "err");
    loadConfig();
  } catch (e) {
    s.textContent = e.message;
    s.className = "status err";
  }
}
$("#saveCfgBtn").addEventListener("click", saveConfig);

async function testConn() {
  const s = $("#cfgStatus");
  s.innerHTML = '<span class="spinner"></span> Testing…';
  s.className = "status";
  try {
    const r = await api("/api/test-auth");
    if (r.ok) { s.textContent = "Connection OK — cookies are valid."; s.className = "status ok"; hideAuthBanner(); }
    else { s.textContent = "Failed: " + (r.error || "").slice(0, 160); s.className = "status err"; }
  } catch (e) {
    s.textContent = e.message;
    s.className = "status err";
  }
}
$("#testCfgBtn").addEventListener("click", testConn);

// Interactive browser login — opens a real browser at Creatio's login page and
// captures the session cookies when the user finishes signing in. Progress
// arrives over SSE because the sign-in (with MFA) can take minutes.
async function browserLogin() {
  const btn = $("#browserLoginBtn");
  const s = $("#loginStatus");
  btn.disabled = true;
  s.innerHTML = '<span class="spinner"></span> Opening browser…';
  s.className = "status";
  try {
    const res = await fetch("/api/browser-login", { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Login failed (${res.status})`);
    }
    let settled = false;
    await consumeSse(res.body, {
      progress: (d) => {
        s.innerHTML = '<span class="spinner"></span> ' + esc(d.message || "Working…");
        s.className = "status";
      },
      done: (d) => {
        settled = true;
        if (d.connection && d.connection.ok) {
          s.textContent = "Signed in — connection OK.";
          s.className = "status ok";
          hideAuthBanner();
        } else {
          s.textContent =
            "Signed in, but the connection test failed: " +
            ((d.connection && d.connection.error) || "").slice(0, 160);
          s.className = "status err";
        }
        loadConfig();
      },
      error: (d) => {
        settled = true;
        s.textContent =
          d.kind === "cancelled" ? "Login cancelled." : "Login failed: " + (d.message || "").slice(0, 200);
        s.className = "status err";
      },
    });
    if (!settled) {
      s.textContent = "Login ended unexpectedly.";
      s.className = "status err";
    }
  } catch (e) {
    s.textContent = e.message;
    s.className = "status err";
  } finally {
    btn.disabled = false;
  }
}
$("#browserLoginBtn").addEventListener("click", browserLogin);

// ---------------------------------------------------------------------------
// Workspace tab
//
// A workspace is 1-3 folders, entered as text boxes and analyzed together as
// one unit (a fix often spans a report template and the includes it pulls in).
// The paths are stored server-side in .env so the skills and the app agree on
// what "the workspace" is. Analysis here is strictly read-only — the server
// spawns Claude with only Read/Glob/Grep. Edits happen in Claude Code.
// ---------------------------------------------------------------------------
function wsSetStatus(text, cls = "") {
  const s = $("#wsStatus");
  s.textContent = text || "";
  s.className = "status" + (cls ? " " + cls : "");
}

function wsSetHint(text, isErr = false) {
  const h = $("#wsPathHint");
  h.textContent = text || "";
  h.className = "hint" + (isErr ? " err" : "");
}

/** The path inputs currently on screen, in order. */
function wsPathInputs() {
  return $$("#wsPathRows input");
}

/** Non-empty trimmed values from the path inputs. */
function wsPathValues() {
  return wsPathInputs()
    .map((i) => i.value.trim())
    .filter(Boolean);
}

/**
 * Render `paths` as text boxes — always at least one, never more than maxPaths.
 * Rows beyond the first get a Remove button.
 */
function renderPathRows(paths) {
  const max = state.ws.maxPaths;
  const values = (paths && paths.length ? paths : [""]).slice(0, max);
  const rows = $("#wsPathRows");
  rows.innerHTML = values
    .map(
      (v, i) => `
      <div class="row ws-path-row" data-i="${i}">
        <input id="wsPath${i}" type="text" spellcheck="false" autocomplete="off"
               value="${esc(v)}"
               placeholder="${i === 0 ? "C:\\neldevsrc\\Github\\MyProject" : "another folder to include"}" />
        ${i > 0 ? `<button class="secondary ws-remove" data-remove="${i}" title="Remove this folder">Remove</button>` : ""}
      </div>`
    )
    .join("");

  // Enter in any box saves; Remove drops that row and saves the rest.
  wsPathInputs().forEach((inp) =>
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveWorkspace();
      }
    })
  );
  $$(".ws-remove", rows).forEach((b) =>
    b.addEventListener("click", () => {
      const keep = wsPathValues().filter((_, i) => i !== Number(b.dataset.remove));
      renderPathRows(keep.length ? keep : [""]);
      saveWorkspace();
    })
  );

  updatePathControls();
}

function updatePathControls() {
  const shown = wsPathInputs().length;
  const max = state.ws.maxPaths;
  $("#wsAddPathBtn").classList.toggle("hidden", shown >= max);
  $("#wsPathCount").textContent = shown > 1 ? `${shown} of ${max} folders` : "";
}

function addPathRow() {
  const values = wsPathInputs().map((i) => i.value.trim());
  if (values.length >= state.ws.maxPaths) return;
  renderPathRows([...values, ""]);
  // Focus the box that was just added, so it can be typed into immediately.
  wsPathInputs().at(-1)?.focus();
}

async function loadWorkspace() {
  try {
    const data = await api("/api/workspace");
    state.ws.paths = data.paths || [];
    state.ws.cap = data.cap || 10;
    state.ws.maxPaths = data.maxPaths || 3;
    renderPathRows(state.ws.paths);

    if (!data.aiAvailable) {
      $("#wsAnalyzeBtn").disabled = true;
      wsSetStatus("");
      wsSetHint(
        "AI analysis is unavailable: the Claude CLI wasn't found. Run `npm i -g @anthropic-ai/claude-code`, then `claude` to log in, and restart the app.",
        true
      );
    } else if (data.error) {
      wsSetHint(data.error, true);
    } else if (!state.ws.paths.length) {
      wsSetHint("Type the full path of the folder you're working in, then Save.");
    } else {
      wsSetHint(data.stale ? "Saved. Files have changed since the last analysis." : "Saved.");
    }

    renderStored(data.analysis, data.stale);
    state.ws.analysisReady = !!(data.analysis && data.analysis.directory);
    state.ws.analysisStale = !!data.stale;
    if (data.valid) await rescan();
  } catch (e) {
    wsSetHint(e.message, true);
  }
  // Phases 1 and 3 refresh with phase 2, so finishing an analysis flips the
  // handoff to ready with no extra wiring (runWorkspaceAnalysis calls us).
  await loadCase();
  // Fetch the last plan BEFORE rendering phase 3, so its "show" link can be
  // part of that render rather than needing a second pass.
  await loadLastPlan();
  renderHandoff();
}

/**
 * Note the last stored plan without rendering it.
 *
 * A reload starts phase 3 clean — reopening a long report you've already dealt
 * with is noise. But a plan costs real money to produce, so it isn't dropped
 * either: it's offered as a one-line link that renders it on demand.
 */
async function loadLastPlan() {
  state.ws.lastPlan = null;
  if (state.ws.planning) return;
  try {
    // Nothing stored is the normal case, so a failure here is not worth showing.
    const { plan } = await api("/api/workspace/fix");
    if (plan) state.ws.lastPlan = plan;
  } catch {
    /* leave it unset */
  }
}

/** Render the stored plan the user asked to see. */
function showLastPlan() {
  const plan = state.ws.lastPlan;
  if (!plan) return;
  state.ws.plan = plan;
  renderFixPlan(plan);
  $("#wsFixPlan").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveWorkspace() {
  const paths = wsPathValues();
  const btn = $("#wsSaveBtn");
  btn.disabled = true;
  wsSetStatus("");
  try {
    const res = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The server reports which box was bad — mark it rather than guessing.
      wsSetHint(data.message || `Save failed (${res.status})`, true);
      const inputs = wsPathInputs();
      inputs.forEach((i) => i.classList.remove("bad"));
      if (typeof data.index === "number" && inputs[data.index]) {
        inputs[data.index].classList.add("bad");
        inputs[data.index].focus();
      }
      return;
    }
    wsPathInputs().forEach((i) => i.classList.remove("bad"));
    state.ws.paths = data.paths;
    renderPathRows(data.paths);
    wsSetHint("Saved.");
    applyCensus(data.enumeration);
    // A different folder set has its own stored report.
    const info = await api("/api/workspace");
    renderStored(info.analysis, info.stale);
  } catch (e) {
    wsSetHint(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/**
 * Clear the saved folders and everything derived from them.
 *
 * Non-destructive by design: the stored analyses stay on disk, keyed by folder,
 * so putting the same path back brings its report along instead of costing
 * another analysis run. Only the pointer in .env is cleared.
 */
async function clearWorkspace() {
  try {
    await api("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
  } catch (e) {
    wsSetStatus(e.message);
    return;
  }

  Object.assign(state.ws, {
    paths: [],
    files: [],
    folders: [],
    count: 0,
    overCap: false,
    skipped: null,
    analysisReady: false,
    analysisStale: false,
    plan: null,
  });

  renderPathRows([]);
  for (const id of ["#wsFiles", "#wsStored", "#wsPanel", "#wsFixPanel", "#wsFixPlan"]) {
    const el = $(id);
    el.classList.add("hidden");
    el.innerHTML = "";
  }
  wsSetHint("Type the full path of the folder you're working in, then Save.");
  wsSetStatus("Cleared. Any stored analysis is kept — re-enter the path to get it back.", " ok");
  renderHandoff();
}

async function rescan() {
  try {
    const en = await api("/api/workspace/files");
    applyCensus(en);
  } catch (e) {
    $("#wsFiles").classList.add("hidden");
    wsSetHint(e.message, true);
  }
}

function applyCensus(en) {
  if (!en) return;
  Object.assign(state.ws, {
    files: en.files || [],
    folders: en.folders || [],
    count: en.count || 0,
    cap: en.cap || state.ws.cap,
    overCap: !!en.overCap,
    skipped: en.skipped || null,
  });
  renderCensus();
}

function renderCensus() {
  const box = $("#wsFiles");
  const { files, folders, count, cap, overCap, skipped } = state.ws;
  if (!state.ws.paths.length) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");

  const pills = [];
  if (skipped?.secrets)
    pills.push(
      `<span class="pill warn" title="Files that may hold credentials are never read">⚠ ${skipped.secrets} secret-bearing file(s) excluded</span>`
    );
  if (skipped?.binaries) pills.push(`<span class="pill">${skipped.binaries} non-text skipped</span>`);
  if (skipped?.oversized) pills.push(`<span class="pill">${skipped.oversized} too large</span>`);
  if (skipped?.entriesTruncated)
    pills.push(`<span class="pill warn">⚠ folder listing truncated</span>`);

  // Group the list by folder when there's more than one.
  let list;
  if (!count) {
    list = `<p class="hint">No top-level source or text files in ${folders.length > 1 ? "these folders" : "this folder"}.</p>`;
  } else {
    const groups = (folders.length ? folders : [{ path: state.ws.paths[0], files, dirs: [] }])
      .filter((f) => f.files?.length)
      .map(
        (f) => `
        ${folders.length > 1 ? `<p class="ws-folder-head"><code>${esc(f.path)}</code> · ${f.files.length} file${f.files.length === 1 ? "" : "s"}</p>` : ""}
        <dl>${f.files
          .map((x) => `<dt>${esc(x.name)}</dt><dd>${x.size.toLocaleString()} bytes</dd>`)
          .join("")}</dl>`
      )
      .join("");
    list = `<details class="ws-file-list">
        <summary>${count} top-level source file${count === 1 ? "" : "s"}${folders.length > 1 ? ` across ${folders.length} folders` : ""}</summary>
        ${groups}
      </details>`;
  }

  const allDirs = (folders || []).flatMap((f) => (f.dirs || []).map((d) => d));
  const subdirs = allDirs.length
    ? `<p class="hint">Subdirectories (not counted): ${allDirs.map((d) => esc(d)).join(", ")}</p>`
    : "";

  const choice = overCap
    ? `<div class="ws-choice" id="wsChoice">
         <p class="caveat">⚠ ${count} top-level files${folders.length > 1 ? ` across ${folders.length} folders` : ""} — more than the ${cap}-file quick-analysis limit.
            A full analysis will take noticeably longer and cost more.</p>
         <div class="row wrap">
           <button id="wsAll" class="secondary">Analyze all ${count} anyway</button>
           <span class="muted">or analyze just one file:</span>
           <select id="wsOne">
             <option value="">Pick a file…</option>
             ${files
               .map(
                 (f, i) =>
                   `<option value="${i}">${esc(f.name)}${folders.length > 1 ? ` — ${esc(String(f.folder || "").split(/[\\/]/).pop() || "")}` : ""}</option>`
               )
               .join("")}
           </select>
           <button id="wsOneGo" class="secondary" disabled>Analyze this file</button>
         </div>
       </div>`
    : "";

  box.innerHTML = `<h2>Files</h2>${pills.length ? `<div class="chips">${pills.join("")}</div>` : ""}${list}${subdirs}${choice}`;

  if (overCap) {
    $("#wsAll").addEventListener("click", () =>
      runWorkspaceAnalysis({ mode: "directory", force: true })
    );
    const sel = $("#wsOne");
    const go = $("#wsOneGo");
    sel.addEventListener("change", () => (go.disabled = sel.value === ""));
    go.addEventListener("click", () => {
      if (sel.value === "") return;
      // Index into the census, so a name that exists in two folders is unambiguous.
      const f = files[Number(sel.value)];
      if (f) runWorkspaceAnalysis({ mode: "file", file: f.name, folder: f.folder });
    });
  }
}

function renderStored(analysis, stale) {
  const box = $("#wsStored");
  const dir = analysis?.directory;
  const files = analysis?.files || [];
  if (!dir && !files.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");

  const rows = [];
  if (dir) {
    rows.push(
      `<li><button class="link" data-ws-open="directory">Whole workspace</button>
         <span class="muted">· ${fmtDate(dir.finishedAt)} · ${dir.fileCount} file${dir.fileCount === 1 ? "" : "s"}${dir.truncated ? " · ⚠ partial" : ""}${stale ? " · ⚠ files changed since" : ""}</span></li>`
    );
  }
  for (const f of files) {
    rows.push(
      `<li><button class="link" data-ws-open="file" data-ws-file="${esc(f.name)}">${esc(f.name)}</button>
         <span class="muted">· ${fmtDate(f.finishedAt)}${f.truncated ? " · ⚠ partial" : ""}</span></li>`
    );
  }

  box.innerHTML = `
    <h2>Stored analysis</h2>
    <p class="hint">Saved under <code>.analysis/</code> (git-ignored) and read by the
       <code>workspace-analysis</code> and <code>creatio-case-fix</code> skills.</p>
    <ul class="ws-stored-list">${rows.join("")}</ul>
    <div id="wsStoredBody" class="md"></div>`;

  $$("[data-ws-open]", box).forEach((b) =>
    b.addEventListener("click", () => openStored(b.dataset.wsOpen, b.dataset.wsFile))
  );
}

async function openStored(mode, file) {
  const body = $("#wsStoredBody");
  body.innerHTML = '<p class="hint"><span class="spinner"></span> Loading…</p>';
  try {
    const q = new URLSearchParams({ mode });
    if (file) q.set("file", file);
    const data = await api(`/api/workspace/analysis?${q}`);
    body.innerHTML = renderMarkdown(data.markdown);
  } catch (e) {
    body.innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
  }
}

async function runWorkspaceAnalysis(opts) {
  if (state.ws.running) return;
  if (!state.ws.paths.length) {
    wsSetHint("Save a folder path first.", true);
    return;
  }

  const mode = opts.mode || "directory";
  const panel = $("#wsPanel");
  panel.classList.remove("hidden");
  const scope =
    mode === "file"
      ? opts.file
      : `${state.ws.count} file${state.ws.count === 1 ? "" : "s"}` +
        (state.ws.paths.length > 1 ? ` · ${state.ws.paths.length} folders` : "");
  panel.innerHTML = `
    <div class="ai-head">
      <span class="ai-run-title">📂 Workspace analysis <span class="muted">· ${esc(scope)}</span></span>
      <span class="ai-tools">
        <button id="wsStop" class="ai-tool stop-btn" title="Stop">■ Stop</button>
        <span class="ai-status"><span class="spinner"></span> reading…</span>
      </span>
    </div>
    <ul class="ws-activity" id="wsActivity"></ul>
    <div class="ai-output md streaming" id="wsOutput"></div>
    <div class="ai-foot hidden" id="wsFoot"></div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const output = $("#wsOutput");
  const activity = $("#wsActivity");
  const tools = $(".ai-tools", panel);
  let raw = "";
  let stopped = false;

  state.ws.running = true;
  $("#wsAnalyzeBtn").disabled = true;
  wsSetStatus("analyzing…");

  const controller = new AbortController();
  state.ws.abort = controller;
  $("#wsStop").addEventListener("click", () => {
    stopped = true;
    controller.abort();
  });

  try {
    const res = await fetch("/api/workspace/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: state.ws.paths,
        mode,
        file: opts.file,
        folder: opts.folder,
        force: opts.force,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      // The server enforces the cap too — surface its choice prompt.
      if (data.error === "over_cap") {
        applyCensus({ ...state.ws, count: data.count, cap: data.cap, overCap: true, files: data.files });
        throw new Error(data.message);
      }
      throw new Error(data.message || `Analysis failed (${res.status})`);
    }
    await consumeSse(res.body, {
      start: (d) => {
        $(".ai-status", panel).innerHTML =
          `<span class="spinner"></span> reading ${d.count} file${d.count === 1 ? "" : "s"}…`;
      },
      tool: (d) => {
        const li = document.createElement("li");
        const target = (d.target || "").split(/[\\/]/).pop() || "";
        li.textContent = `${d.name}${target ? " " + target : ""}`;
        activity.appendChild(li);
        activity.scrollTop = activity.scrollHeight;
      },
      chunk: (d) => {
        raw += d.text;
        output.innerHTML = renderMarkdown(raw);
        output.scrollTop = output.scrollHeight;
      },
      done: (d) => {
        output.classList.remove("streaming");
        $(".ai-status", panel).innerHTML = "✓ done";
        finishTools(tools, raw, mode === "file" ? opts.file : "workspace", "workspace-analysis");
        const bits = [];
        if (d.filesAnalyzed) bits.push(`${d.filesAnalyzed} file(s) in scope`);
        if (d.toolCalls) bits.push(`${d.toolCalls} tool call(s)`);
        if (d.totalTokens) bits.push(`${d.totalTokens.toLocaleString()} tokens`);
        if (typeof d.costUsd === "number") bits.push(`$${d.costUsd.toFixed(4)}`);
        if (d.durationMs) bits.push(`${(d.durationMs / 1000).toFixed(1)}s`);
        if (d.saved) bits.push(`saved to ${d.report}`);
        if (d.truncated) bits.push("⚠ partial — rests on incomplete information");
        const foot = $("#wsFoot");
        if (bits.length) {
          foot.textContent = bits.join(" · ");
          foot.classList.remove("hidden");
        }
        wsSetStatus(d.saved ? "saved" : "done", "ok");
        loadWorkspace();
      },
      error: (d) => {
        throw new Error(d.message || "Analysis error");
      },
    });
  } catch (e) {
    output.classList.remove("streaming");
    const st = $(".ai-status", panel);
    if (stopped || e.name === "AbortError") {
      if (st) st.innerHTML = '<span class="muted">stopped</span>';
      if (raw) finishTools(tools, raw, "partial", "workspace-analysis");
      wsSetStatus("stopped");
    } else {
      if (st) st.innerHTML = '<span class="err-text">failed</span>';
      output.innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
      wsSetStatus("failed", "err");
    }
  } finally {
    state.ws.running = false;
    state.ws.abort = null;
    $("#wsAnalyzeBtn").disabled = false;
  }
}

$("#wsAddPathBtn").addEventListener("click", addPathRow);
$("#wsSaveBtn").addEventListener("click", saveWorkspace);
$("#wsRescanBtn").addEventListener("click", rescan);
$("#wsClearBtn").addEventListener("click", clearWorkspace);
$("#wsAnalyzeBtn").addEventListener("click", () => {
  // Over the cap we never auto-run — the user has to make the call.
  if (state.ws.overCap) {
    const choice = $("#wsChoice");
    if (choice) {
      choice.scrollIntoView({ behavior: "smooth", block: "center" });
      choice.classList.add("flash");
      setTimeout(() => choice.classList.remove("flash"), 1200);
    }
    wsSetStatus("Choose how to proceed below.");
    return;
  }
  runWorkspaceAnalysis({ mode: "directory" });
});

// ---------------------------------------------------------------------------
// Workspace · phase 1: the case
//
// A second, deliberately smaller case picker. It cannot reuse the Lookup tab's
// markup: renderResults() writes straight into #results, selectedCaseRows()
// queries .rowchk document-wide, and #chkAll / #aiOutput / #aiStop are single
// hard-coded ids, so mounting that DOM twice would cross-wire the two tabs.
// What matters is shared instead — the same /api/resolve and /api/cases routes,
// consumeSse, and esc / fmtDate / stClass.
//
// This phase binds exactly ONE case, so its result list uses radios.
// ---------------------------------------------------------------------------
const WSC_MODE_CFG = {
  number: {
    label: "Case number",
    placeholder: "SR00031980",
    hint: "Enter the case number, then Search.",
    resolve: false,
    statuses: false,
  },
  owner: {
    label: "Owner name",
    placeholder: "e.g. Leyba",
    hint: "Type a name, click Find, then pick the right person.",
    resolve: true,
    statuses: true,
  },
  account: {
    label: "Account / school",
    placeholder: "e.g. Holy Trinity",
    hint: "Type a school name, click Find, then pick the right account.",
    resolve: true,
    statuses: true,
  },
  recent: {
    label: "",
    placeholder: "",
    hint: "Search the newest cases regardless of owner.",
    resolve: false,
    statuses: true,
  },
};

function wscHint(text, isErr = false) {
  const el = $("#wscHint");
  el.textContent = text;
  el.className = isErr ? "hint err" : "hint";
}

function wscSetMode(mode) {
  const cfg = WSC_MODE_CFG[mode] || WSC_MODE_CFG.number;
  state.ws.picker.mode = mode;
  state.ws.picker.chosen = "";
  state.ws.picker.cases = [];

  $$("#wscMode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#wscValueField").classList.toggle("hidden", mode === "recent");
  $("#wscValueLabel").textContent = cfg.label;
  const input = $("#wscValue");
  input.placeholder = cfg.placeholder;
  input.value = "";
  $("#wscFind").classList.toggle("hidden", !cfg.resolve);
  $("#wscStatusField").classList.toggle("hidden", !cfg.statuses);
  $("#wscCandidates").classList.add("hidden");
  $("#wscCandidates").innerHTML = "";
  $("#wscResults").classList.add("hidden");
  wscHint(cfg.hint);

  if (cfg.statuses) wscBuildStatusChips();
}

/**
 * Two options rather than the Lookup tab's full chip grid — you're picking one
 * case to fix, not surveying a queue.
 */
function wscBuildStatusChips() {
  const chips = $("#wscStatus");
  if (chips.dataset.built) return;
  chips.innerHTML =
    `<label class="chip"><input type="radio" name="wscSt" value="open" checked />Open / active</label>` +
    `<label class="chip"><input type="radio" name="wscSt" value="all" />All statuses</label>`;
  chips.dataset.built = "1";
}

function wscSelectedStatuses() {
  const all = $('#wscStatus input[value="all"]')?.checked;
  if (!state.meta) return undefined;
  return all ? state.meta.statuses : state.meta.openActive;
}

/** Resolve an owner or account name to one GUID. Single-select, unlike Lookup. */
async function wscResolve() {
  const name = $("#wscValue").value.trim();
  const box = $("#wscCandidates");
  if (!name) {
    wscHint("Type a name first.", true);
    return;
  }
  wscHint("Searching…");
  try {
    const { candidates } = await api(
      `/api/resolve?type=${state.ws.picker.mode}&name=${encodeURIComponent(name)}`
    );
    if (!candidates.length) {
      box.classList.add("hidden");
      wscHint(`No match for "${name}".`, true);
      return;
    }
    box.innerHTML = candidates
      .map(
        (c) =>
          `<div class="candidate" data-id="${esc(c.Id)}"><span>${esc(c.Name)}</span>` +
          `<span class="cid">${esc(String(c.Id).slice(0, 8))}…</span></div>`
      )
      .join("");
    box.classList.remove("hidden");
    $$(".candidate", box).forEach((el) => {
      el.addEventListener("click", () => {
        state.ws.picker.chosen = el.dataset.id;
        $$(".candidate", box).forEach((o) => o.classList.toggle("chosen", o === el));
        wscHint("Picked. Now click Search.");
      });
    });
    if (candidates.length === 1) {
      state.ws.picker.chosen = candidates[0].Id;
      $(".candidate", box).classList.add("chosen");
      wscHint(`One match: ${candidates[0].Name}. Click Search.`);
    } else {
      wscHint(`${candidates.length} matches — pick one.`);
    }
  } catch (e) {
    box.classList.add("hidden");
    wscHint(e.message, true);
  }
}

/** Search for candidate cases. Summary detail only — binding fetches the rest. */
async function wscSearch() {
  const p = state.ws.picker;
  if (p.searching) return;

  const body = { mode: p.mode, detail: ["summary"] };
  const cfg = WSC_MODE_CFG[p.mode];

  if (cfg.resolve) {
    if (!p.chosen) {
      wscHint("Click Find and pick a match first.", true);
      return;
    }
    body.guids = [p.chosen];
  } else if (p.mode === "number") {
    const nums = $("#wscValue")
      .value.split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!nums.length) {
      wscHint("Enter a case number first.", true);
      return;
    }
    body.numbers = nums;
  }
  if (cfg.statuses) body.statuses = wscSelectedStatuses();

  p.searching = true;
  wscHint("Searching…");
  try {
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.message || `Search failed (${res.status})`);
    }
    await consumeSse(res.body, {
      found: (d) => {
        p.cases = d.cases || [];
        wscRenderResults(p.cases, d.caveats || []);
        wscHint(
          p.cases.length
            ? `${p.cases.length} case${p.cases.length === 1 ? "" : "s"} — pick the one you're fixing.`
            : "No cases matched."
        );
      },
      error: (d) => {
        if (d.kind === "auth") showAuthBanner(d.message);
        throw new Error(d.message || "Search failed");
      },
    });
  } catch (e) {
    wscHint(e.message, true);
  } finally {
    p.searching = false;
  }
}

function wscRenderResults(cases, caveats) {
  const box = $("#wscResults");
  if (!cases.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.innerHTML =
    caveats.map((c) => `<p class="caveat">${esc(c)}</p>`).join("") +
    `<table class="wsc-table"><tbody>` +
    cases
      .map(
        (c) => `<tr data-pick="${esc(c.Number)}">
          <td class="chk"><input type="radio" name="wscPick" value="${esc(c.Number)}" /></td>
          <td class="num">${esc(c.Number)}</td>
          <td>${esc(c.Subject)}</td>
          <td><span class="st-badge ${stClass(c.Status)}">${esc(c.Status)}</span></td>
          <td>${esc(c.Account)}</td>
          <td>${esc(fmtDate(c.CreatedOn))}</td>
        </tr>`
      )
      .join("") +
    `</tbody></table>`;
  box.classList.remove("hidden");

  // Whole row is the hit target; the radio is just the affordance.
  $$("tr[data-pick]", box).forEach((tr) => {
    tr.addEventListener("click", () => {
      $("input", tr).checked = true;
      wscBind(tr.dataset.pick);
    });
  });
}

/**
 * Bind a case. The server re-fetches it by number and stores the brief — we
 * deliberately don't post the row we already have, because the brief is what
 * the fix skill will act on and it should come from the source.
 */
async function wscBind(number) {
  wscHint(`Fetching ${number}…`);
  try {
    const data = await api("/api/workspace/case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number }),
    });
    state.ws.case = { number: data.number, brief: data.brief, ageHours: data.ageHours };
    renderCaseBrief();
    renderHandoff();
    wscHint(`Bound ${data.number}.`);
  } catch (e) {
    wscHint(e.message, true);
  }
}

/** Reset the picker's inputs and results. Does not touch the binding. */
function clearPicker() {
  const p = state.ws.picker;
  p.chosen = "";
  p.cases = [];
  $("#wscValue").value = "";
  for (const id of ["#wscResults", "#wscCandidates"]) {
    const el = $(id);
    el.classList.add("hidden");
    el.innerHTML = "";
  }
}

/**
 * Re-pull the bound case from Creatio.
 *
 * The brief is a snapshot: a case keeps moving after you bind it, so this
 * refetches the description and timeline and resets the "fetched" age. It goes
 * through the same bind route, so the stored brief the fix planner reads is the
 * one that gets updated.
 */
async function refreshCase() {
  const n = state.ws.case.number;
  if (!n) return;
  const btn = $(".ws-refresh");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Refreshing…";
  }
  clearPicker();
  await wscBind(n);
  renderHandoff();
}

async function clearCase() {
  try {
    await api("/api/workspace/case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number: "" }),
    });
  } catch (e) {
    wscHint(e.message, true);
    return;
  }
  state.ws.case = { number: "", brief: null, ageHours: null };
  renderCaseBrief();
  renderHandoff();
  wscHint("Case unbound.");
}

async function loadCase() {
  try {
    const data = await api("/api/workspace/case");
    state.ws.case = {
      number: data.number || "",
      brief: data.brief || null,
      ageHours: data.ageHours,
    };
  } catch {
    state.ws.case = { number: "", brief: null, ageHours: null };
  }
  renderCaseBrief();
}

/**
 * Render client-written case text so it can actually be read.
 *
 * A support case is usually a numbered list of asks, but Creatio's HTML is
 * flattened to plain text upstream and every line break is collapsed — so it
 * arrives as one long paragraph. This puts the structure back: numbered items
 * become a real ordered list keeping the client's own numbers, dashes become
 * bullets, everything else stays a paragraph.
 *
 * All output is escaped. This is third-party text, shown as data.
 */
function renderClientText(text) {
  const raw = String(text || "").trim();
  if (!raw) return '<em class="muted">No text.</em>';

  let t = raw;
  // A flat "1) … 2) … 3) …" run: break before each marker so the list can be
  // rebuilt. Two or more markers required, so a lone "see item 3)" reference
  // isn't torn out of its sentence.
  if ((t.match(/(?:^|\s)\d{1,2}\)\s/g) || []).length >= 2) {
    t = t.replace(/(?:^|\s)(\d{1,2}\)\s)/g, "\n$1");
  }

  // `N)` with optional text after it (real cases put a bare "3)" on its own
  // line and the text on the next), or `N.` which REQUIRES trailing whitespace
  // so a decimal like "1.5 hours" is never read as a list marker.
  const MARKER = /^(\d{1,2})(?:\)\s*|\.\s+)(.*)$/;
  const BULLET = /^[-•*•]\s+(.+)$/;

  const intro = [];
  const items = [];
  let cur = null;

  for (const rawLine of t.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = line.match(MARKER);
    if (m) {
      cur = { num: m[1], parts: [], subs: [] };
      if (m[2].trim()) cur.parts.push(m[2].trim());
      items.push(cur);
      continue;
    }

    // Indented or bulleted lines are sub-points of the item above them;
    // everything else continues that item's own paragraph.
    const indented = /^[\t]|^ {2,}/.test(rawLine);
    const bullet = line.match(BULLET);
    if (cur && (indented || bullet)) cur.subs.push(bullet ? bullet[1] : line);
    else if (cur) cur.parts.push(line);
    else if (bullet) intro.push({ bullet: bullet[1] });
    else intro.push({ text: line });
  }

  const out = [];
  // Intro bullets before any number still deserve a list.
  let pend = [];
  const flushPend = () => {
    if (pend.length) {
      out.push(`<ul class="ct-list">${pend.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`);
      pend = [];
    }
  };
  for (const i of intro) {
    if (i.bullet) pend.push(i.bullet);
    else {
      flushPend();
      out.push(`<p>${esc(i.text)}</p>`);
    }
  }
  flushPend();

  if (items.length) {
    out.push(
      `<ol class="ct-list">` +
        items
          .map(
            (it) =>
              `<li value="${esc(it.num)}">` +
              (it.parts.length
                ? it.parts.map((p) => `<p>${esc(p)}</p>`).join("")
                : `<p class="muted">(no text)</p>`) +
              (it.subs.length
                ? `<ul class="ct-sub">${it.subs.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
                : "") +
              `</li>`
          )
          .join("") +
        `</ol>`
    );
  }

  return out.join("");
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1024 / 1024).toFixed(1) + " MB";
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/**
 * The case's attachments, as a reference while you review a fix.
 *
 * Only metadata is stored in the brief; the bytes come through the existing
 * read-only /api/file proxy on demand. Images render as thumbnails and reuse
 * the lightbox (the delegated handler keys off `img.seg-img`); anything else
 * gets a link that opens in a new tab.
 *
 * These are for YOU. The fix planner is told the filenames but cannot read
 * inside them, so a logo's actual colours still have to come from the case text.
 */
function renderAttachments(list) {
  const items = list || [];
  if (!items.length) return "";
  return `<div class="ws-attach">
    <div class="ws-attach-head">
      ${items.length} attachment${items.length === 1 ? "" : "s"}
      <span class="muted">· contents aren't read when planning a fix</span>
    </div>
    <div class="ws-attach-grid">
      ${items
        .map((a) => {
          const href = `/api/file?entity=CaseFile&id=${encodeURIComponent(a.id)}`;
          const meta = `${esc(fmtBytes(a.size))}${a.createdOn ? " · " + esc(fmtDate(a.createdOn)) : ""}`;
          const isImage = IMAGE_EXT.test(a.name);
          const body = isImage
            ? `<img class="seg-img ws-attach-img" src="${href}" loading="lazy" alt="${esc(a.name)}" title="Click to enlarge" />`
            : `<a class="ws-attach-file" href="${href}" target="_blank" rel="noopener">📄 open</a>`;
          // Only images can be dropped into a workspace folder, and only when
          // one is configured — see saveAssetToWorkspace() for why.
          const canSave = isImage && (state.ws.paths || []).length > 0;
          return `<figure class="ws-attach-item">
            ${body}
            <figcaption>
              <a href="${href}" target="_blank" rel="noopener" title="${esc(a.name)}">${esc(a.name)}</a>
              <span class="muted">${meta}</span>
              ${canSave ? `<button class="link ws-attach-save" data-id="${esc(a.id)}" data-name="${esc(a.name)}">↓ save to folder</button>` : ""}
            </figcaption>
          </figure>`;
        })
        .join("")}
    </div>
  </div>`;
}

/**
 * Offer to write one image attachment into a workspace folder.
 *
 * The filename is editable because the template usually references the logo by
 * a specific name, and the client's upload rarely matches it. Replacing an
 * existing file takes a second, explicit confirm; the server backs the original
 * up before overwriting.
 */
function openAttachSave(btn) {
  const fig = btn.closest(".ws-attach-item");
  if ($(".ws-attach-form", fig)) return;
  const paths = state.ws.paths || [];

  const form = document.createElement("div");
  form.className = "ws-attach-form";
  form.innerHTML = `
    <input type="text" class="wsa-name" value="${esc(btn.dataset.name)}" spellcheck="false" />
    ${
      paths.length > 1
        ? `<select class="wsa-folder">${paths
            .map((p) => `<option value="${esc(p)}">${esc(String(p).split(/[\\/]/).pop() || p)}</option>`)
            .join("")}</select>`
        : ""
    }
    <div class="row wrap">
      <button class="primary wsa-go">Save</button>
      <button class="secondary wsa-cancel">Cancel</button>
    </div>
    <span class="wsa-status status"></span>`;
  fig.appendChild(form);

  const status = $(".wsa-status", form);
  const nameEl = $(".wsa-name", form);
  const go = $(".wsa-go", form);

  $(".wsa-cancel", form).addEventListener("click", () => form.remove());

  let confirmOverwrite = false;
  go.addEventListener("click", async () => {
    go.disabled = true;
    status.textContent = "Saving…";
    status.className = "wsa-status status";
    try {
      const data = await api("/api/workspace/attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: btn.dataset.id,
          name: nameEl.value,
          folder: $(".wsa-folder", form)?.value || paths[0],
          overwrite: confirmOverwrite,
        }),
      });
      // The confirmation goes to phase 2's status line, NOT this form: the
      // refresh below re-renders the case panel, which would take the form and
      // its message with it before either could be read.
      wsSetStatus(
        `Saved ${data.name} into ${String(data.path).replace(/[\\/][^\\/]+$/, "")}` +
          (data.overwrote ? " — replaced the existing file, original backed up." : "."),
        " ok"
      );
      // The folder gained a file, so the census and staleness both moved.
      await rescan();
      await loadWorkspace();
    } catch (e) {
      go.disabled = false;
      status.textContent = e.message;
      status.className = "wsa-status status";
      // The server distinguishes "already there" so a replace can be offered
      // instead of leaving the user stuck.
      if (/already exists/i.test(e.message)) {
        confirmOverwrite = true;
        go.textContent = "Replace it";
      }
    }
  });

  nameEl.focus();
  nameEl.select();
}

function ageLabel(hours) {
  if (hours == null) return "";
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The bound case. Description and timeline are client-written text shown as
 * data — rendered with esc(), collapsed by default so the phase stays compact.
 */
function renderCaseBrief() {
  const box = $("#wsCaseBrief");
  const { number, brief, ageHours } = state.ws.case;

  if (!number) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  const actions =
    `<span class="ws-bound-actions">` +
    `<button class="secondary ws-refresh" title="Re-pull this case from Creatio">Refresh</button>` +
    `<button class="secondary ws-unbind" title="Stop working on this case">Unbind</button>` +
    `</span>`;

  if (!brief) {
    box.innerHTML =
      `<div class="ws-bound"><div class="ws-bound-head">` +
      `<strong>${esc(number)}</strong> <span class="muted">bound, but nothing stored for it yet</span>` +
      actions +
      `</div>` +
      `<p class="hint">Press Refresh to fetch its description and conversation, or search above and pick it again.</p></div>`;
  } else {
    const tl = brief.timeline || [];
    // A brief is a snapshot; past a day it's worth saying so rather than
    // letting a stale description quietly drive a fix.
    const stale = ageHours != null && ageHours > 24;
    box.innerHTML = `<div class="ws-bound">
      <div class="ws-bound-head">
        <strong>${esc(brief.number)}</strong>
        <span class="st-badge ${stClass(brief.status)}">${esc(brief.status)}</span>
        <span class="muted">fetched ${esc(ageLabel(ageHours))}</span>
        ${actions}
      </div>
      ${
        stale
          ? `<p class="caveat">This was fetched ${esc(ageLabel(ageHours))} — the case may have moved on. Press Refresh for the current description and conversation.</p>`
          : ""
      }
      <p class="ws-bound-subject">${esc(brief.subject)}</p>
      <p class="muted">${esc(brief.account)}${brief.contact ? " · " + esc(brief.contact) : ""} · opened ${esc(fmtDate(brief.createdOn))}</p>
      ${(brief.caveats || []).map((c) => `<p class="caveat">${esc(c)}</p>`).join("")}
      ${renderAttachments(brief.attachments)}
      <details class="ws-brief-detail">
        <summary>Description</summary>
        <div class="desc">${renderClientText(brief.description)}</div>
      </details>
      <details class="ws-brief-detail">
        <summary>Conversation / timeline (${tl.length}${brief.timelineTruncated ? "+" : ""})</summary>
        ${
          tl.length
            ? `<ul class="timeline">` +
              tl
                .map(
                  (t) => `<li class="tl-entry ${esc(t.kind)}">
                    ${tlHead(t)}
                    ${t.title ? `<div class="tl-meta">${esc(t.title)}</div>` : ""}
                    <div class="tl-text">${renderClientText(t.text)}</div>
                  </li>`
                )
                .join("") +
              `</ul>`
            : '<p class="muted">No feed posts or emails found for this case.</p>'
        }
      </details>
    </div>`;
  }

  box.classList.remove("hidden");
  $(".ws-refresh", box)?.addEventListener("click", refreshCase);
  $(".ws-unbind", box)?.addEventListener("click", clearCase);
  $$(".ws-attach-save", box).forEach((b) =>
    b.addEventListener("click", () => openAttachSave(b))
  );
}

// ---------------------------------------------------------------------------
// Workspace · phase 3: hand off to Claude Code
//
// This phase deliberately runs NOTHING. The app has no ability to edit files
// and never gets one: case text is written by clients, and pairing it with
// write access is the combination the analysis runner is built to avoid. So
// phase 3 checks that the pieces are in place and hands over the prompt. The
// creatio-case-fix skill does the work in your own session, behind its
// approval gate, and leaves the edits uncommitted.
// ---------------------------------------------------------------------------
/**
 * One line describing the stored plan, with a link to open it.
 *
 * Deliberately not the plan itself: it reappearing on every reload was noise,
 * but silently discarding something the user paid for would be worse.
 */
function lastPlanLine() {
  const p = state.ws.lastPlan;
  if (!p) return "";
  const n = p.edits.length;
  const usable = p.edits.filter((e) => e.ok).length;
  const state_ = p.appliedAt
    ? usable === n && n > 0
      ? `applied ${esc(fmtDate(p.appliedAt))}, since reverted`
      : `applied ${esc(fmtDate(p.appliedAt))}`
    : `not applied`;
  return `<p class="hint ws-last-plan">
    Last plan: ${n} edit${n === 1 ? "" : "s"}, ${state_}
    · <button id="wsShowLast" class="link">show it</button>
  </p>`;
}

function renderHandoff() {
  const box = $("#wsHandoff");
  const { number, brief, ageHours } = state.ws.case;
  const paths = state.ws.paths || [];
  const hasAnalysis = !!state.ws.analysisReady;

  const items = [];
  if (number) {
    const subject = brief ? ` — “${brief.subject}”` : "";
    const age = brief ? ` <span class="muted">(fetched ${esc(ageLabel(ageHours))})</span>` : "";
    items.push({ ok: true, html: `Case <strong>${esc(number)}</strong>${esc(subject)}${age}` });
  } else {
    items.push({ ok: false, html: `No case bound — find and pick one in <strong>phase 1</strong>.` });
  }

  if (paths.length) {
    items.push({
      ok: true,
      html: `${paths.length} folder${paths.length === 1 ? "" : "s"}: ${paths.map((p) => `<code>${esc(p)}</code>`).join(", ")}`,
    });
  } else {
    items.push({ ok: false, html: `No folders saved — add them in <strong>phase 2</strong>.` });
  }

  if (hasAnalysis) {
    items.push({
      ok: true,
      html: state.ws.analysisStale
        ? `Stored analysis <span class="muted">(stale — files changed since; re-run Analyze in phase 2)</span>`
        : `Stored analysis <span class="muted">(current)</span>`,
    });
  } else {
    items.push({ ok: false, html: `No stored analysis — click <strong>Analyze</strong> in phase 2.` });
  }

  const ready = !!number && paths.length > 0 && hasAnalysis;

  box.innerHTML = `
    <h2><span class="ws-step">3</span> Fix</h2>
    <p class="hint">
      Reads the case and the stored analysis, works out which lines are responsible,
      and shows you every edit as <strong>before/after</strong>. Nothing touches your
      files until you press Apply — and applied edits are left
      <strong>uncommitted</strong> so you review the diff yourself.
    </p>
    <ul class="ws-ready">
      ${items.map((it) => `<li class="${it.ok ? "ok" : "miss"}">${it.html}</li>`).join("")}
    </ul>
    ${
      ready
        ? `<div class="row wrap ws-fix-row">
             <button id="wsPlanBtn" class="primary">Plan the fix</button>
             <span class="muted">reads the case and your code, then shows the edits for approval</span>
           </div>
           ${lastPlanLine()}`
        : `<p class="hint">Finish the steps above and the fix button appears here.</p>`
    }`;

  if (!ready) return;

  $("#wsPlanBtn", box).addEventListener("click", runFixPlan);
  $("#wsShowLast", box)?.addEventListener("click", showLastPlan);
}

// ---------------------------------------------------------------------------
// Workspace · phase 3: plan a fix, review it, apply it
//
// Two steps, deliberately separate. "Plan the fix" runs a read-only Claude pass
// (Read/Glob/Grep only — no Edit, no Write, no Bash) that returns a structured
// list of edits. Nothing touches disk until you press Apply, and the server
// re-verifies every match before writing. Edits are left uncommitted.
// ---------------------------------------------------------------------------
async function runFixPlan() {
  if (state.ws.planning) return;
  state.ws.planning = true;

  const panel = $("#wsFixPanel");
  const planBox = $("#wsFixPlan");
  planBox.classList.add("hidden");
  planBox.innerHTML = "";

  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div class="ai-head">
      <span class="ai-run-title">🛠 Planning a fix <span class="muted">· ${esc(state.ws.case.number)}</span></span>
      <span class="ai-tools">
        <button id="wsFixStop" class="ai-tool stop-btn" title="Stop">■ Stop</button>
        <span class="ai-status"><span class="spinner"></span> reading the case…</span>
      </span>
    </div>
    <p class="hint">Read-only: this pass can read your files but cannot change them.</p>
    <ul class="ws-activity" id="wsFixActivity"></ul>
    <div class="ai-output md streaming" id="wsFixOutput"></div>
    <div class="ai-foot hidden" id="wsFixFoot"></div>`;

  const tools = $(".ai-tools", panel);
  const statusEl = $(".ai-status", panel);
  const output = $("#wsFixOutput", panel);
  const activity = $("#wsFixActivity", panel);
  const foot = $("#wsFixFoot", panel);

  const controller = new AbortController();
  state.ws.planAbort = controller;
  let stopped = false;
  $("#wsFixStop", panel).addEventListener("click", () => {
    stopped = true;
    controller.abort();
  });

  let raw = "";
  try {
    const res = await fetch("/api/workspace/fix/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.message || `Planning failed (${res.status})`);
    }

    await consumeSse(res.body, {
      start: (d) => {
        statusEl.innerHTML =
          `<span class="spinner"></span> reading ${d.files} file${d.files === 1 ? "" : "s"}…`;
        // Say plainly whether the workspace analysis is feeding this plan — it's
        // what lets the run go straight to the right files.
        const src = document.createElement("li");
        src.className = "ws-source";
        src.textContent = d.hasAnalysis
          ? `using the stored workspace analysis (${d.analysisFiles} file${d.analysisFiles === 1 ? "" : "s"}, ${
              d.analysisStale ? "stale — files changed since" : "current"
            })`
          : "no stored analysis — orienting from the files directly";
        activity.appendChild(src);
      },
      tool: (d) => {
        const li = document.createElement("li");
        const target = String(d.target || "").split(/[\\/]/).pop() || "";
        li.textContent = `${d.name}${target ? " " + target : ""}`;
        activity.appendChild(li);
      },
      chunk: (d) => {
        raw += d.text;
        output.innerHTML = renderMarkdown(raw);
      },
      done: (d) => {
        output.classList.remove("streaming");
        statusEl.textContent = "✓ planned";
        finishTools(tools, raw, state.ws.case.number, "fix-plan");
        const bits = [];
        if (d.totalTokens) bits.push(`${d.totalTokens.toLocaleString()} tokens`);
        if (d.costUsd != null) bits.push(`$${d.costUsd.toFixed(4)}`);
        if (d.durationMs) bits.push(`${Math.round(d.durationMs / 1000)}s`);
        if (bits.length) {
          foot.textContent = bits.join(" · ");
          foot.classList.remove("hidden");
        }
        state.ws.plan = d.plan;
        renderFixPlan(d.plan, d.planError);
      },
      error: (d) => {
        // A timeout or Stop that still produced a plan isn't a dead end.
        if (d.plan) {
          state.ws.plan = d.plan;
          renderFixPlan(d.plan, null, d.message);
        }
        throw new Error(d.message || "Planning failed");
      },
    });
  } catch (e) {
    output.classList.remove("streaming");
    if (stopped || e.name === "AbortError") {
      statusEl.textContent = "■ stopped";
      if (raw.trim()) finishTools(tools, raw, state.ws.case.number, "fix-plan");
    } else if (state.ws.plan) {
      // The plan survived; the run just didn't finish cleanly.
      statusEl.innerHTML = `<span class="err-text">incomplete</span>`;
      finishTools(tools, raw, state.ws.case.number, "fix-plan");
    } else {
      statusEl.innerHTML = `<span class="err-text">failed</span>`;
      const p = document.createElement("p");
      p.className = "ai-error";
      p.textContent = e.message;
      panel.appendChild(p);
    }
  } finally {
    state.ws.planning = false;
    state.ws.planAbort = null;
  }
}

/**
 * Render the proposed edits for review. Nothing has been written yet.
 * `incomplete` is set when the plan came out of a run that timed out or was
 * stopped — the edits are still fully validated, but the plan may not cover
 * everything the case asks for.
 *
 * `plan.warnings` are advisories about the plan as a whole (an unusually broad
 * one, say). They are rendered as caveats and deliberately do NOT suppress the
 * Apply button: the button's only precondition is at least one edit that still
 * matches the file on disk, because that — plus this review and the pre-write
 * backup — is what makes applying safe.
 */
function renderFixPlan(plan, planError, incomplete) {
  const box = $("#wsFixPlan");

  if (!plan) {
    box.innerHTML =
      `<h2>Proposed fix</h2><p class="caveat">${esc(planError || "No plan was produced.")}</p>` +
      `<p class="hint">Nothing was changed. The explanation above the fold is still worth reading.</p>`;
    box.classList.remove("hidden");
    return;
  }

  const wasApplied = Boolean(plan.appliedAt);
  const applicable = plan.edits.filter((e) => e.ok);
  const blocked = plan.edits.filter((e) => !e.ok);

  // An applied plan whose every edit STILL matches means its changes are not in
  // the files any more — reverted, or overwritten from elsewhere. Once an edit
  // has landed its `oldStr` is gone, so "all still applicable" can only mean
  // the work was undone. Offer to apply it again rather than dead-ending on a
  // read-only record of changes that aren't there.
  const reverted = wasApplied && plan.edits.length > 0 && blocked.length === 0;
  const done = wasApplied && !reverted;

  const section = (title, text) =>
    text && text.trim() ? `<div class="ws-plan-note"><strong>${title}</strong> ${esc(text)}</div>` : "";

  // Which client ask each edit serves, so a reviewer can check the plan against
  // the email in front of them rather than inferring intent from a diff.
  const requests = plan.requests || [];
  const reqById = new Map(requests.map((r) => [r.id, r]));
  const editCount = new Map();
  for (const e of plan.edits) {
    if (e.requestId) editCount.set(e.requestId, (editCount.get(e.requestId) || 0) + 1);
  }

  const REQ_LABEL = {
    addressed: "addressed",
    partial: "partly addressed",
    "not-addressed": "not addressed",
    unstated: "unclear",
  };

  const requestsHtml = requests.length
    ? `<div class="ws-requests">
         <h3>What the client asked for</h3>
         <ol class="ws-req-list">
           ${requests
             .map((r) => {
               const n = editCount.get(r.id) || 0;
               return `<li class="req-${esc(r.status)}">
                 <span class="ws-req-id">${esc(r.id)}</span>
                 <span class="ws-req-text">${esc(r.text)}</span>
                 <span class="ws-req-state">${esc(REQ_LABEL[r.status] || r.status)}${
                   n ? ` · ${n} edit${n === 1 ? "" : "s"}` : ""
                 }</span>
               </li>`;
             })
             .join("")}
         </ol>
       </div>`
    : "";

  const reqChip = (e) => {
    if (!e.requestId) return `<span class="ws-req-chip none">no request</span>`;
    const r = reqById.get(e.requestId);
    const text = r ? r.text : "";
    return `<span class="ws-req-chip" title="${esc(text)}">asked for #${esc(e.requestId)}</span>`;
  };

  const editHtml = (e, i) => `
    <div class="ws-edit ${e.ok ? "" : "blocked"}">
      <div class="ws-edit-head">
        <span class="ws-edit-n">${i + 1}</span>
        <code>${esc(e.file)}</code>
        ${e.line ? `<span class="muted">line ${e.line}</span>` : ""}
        ${reqChip(e)}
        ${e.ok ? "" : `<span class="pill warn">can't apply</span>`}
      </div>
      ${e.why ? `<p class="ws-edit-why">${esc(e.why)}</p>` : ""}
      ${e.problem ? `<p class="caveat">${esc(e.problem)}</p>` : ""}
      <div class="ws-diff">
        <pre class="ws-diff-old">${esc(e.oldStr)}</pre>
        <pre class="ws-diff-new">${esc(e.newStr) || '<em class="muted">(deleted)</em>'}</pre>
      </div>
    </div>`;

  box.innerHTML = `
    <h2>${done ? "Applied fix" : reverted ? "Previously applied fix" : "Proposed fix"}</h2>
    <p class="muted">
      ${esc(plan.caseNumber)} · ${
        done
          ? `${plan.edits.length} edit${plan.edits.length === 1 ? "" : "s"} planned, already applied`
          : `${applicable.length} edit${applicable.length === 1 ? "" : "s"} ready${blocked.length ? ` · ${blocked.length} blocked` : ""}`
      } · confidence ${esc(plan.confidence)}
    </p>
    ${
      done
        ? `<p class="status ok">Applied ${esc(fmtDate(plan.appliedAt))} — nothing staged, nothing committed.</p>
           <p class="hint">
             These changes are in your files. For a different fix, press
             <strong>Plan the fix</strong> again. The originals from that apply are under
             <code>.analysis/fixes/${esc(plan.id)}/backup/</code>.
           </p>`
        : reverted
          ? `<p class="caveat">
               This plan was applied ${esc(fmtDate(plan.appliedAt))}, but
               <strong>none of its changes are in your files now</strong> — they were reverted
               or overwritten. All ${plan.edits.length} edits still match, so you can apply it
               again without re-planning.
             </p>`
          : ""
    }
    ${
      incomplete
        ? `<p class="caveat">⚠ This plan came from a run that didn't finish (${esc(incomplete)}).
             The edits below were still fully checked against your files, but the plan may not
             cover everything the case asks for — read “Not fixed” before applying.</p>`
        : ""
    }
    ${(plan.warnings || []).map((w) => `<p class="caveat">⚠ ${esc(w)}</p>`).join("")}
    ${requestsHtml}
    ${section("Problem:", plan.problem)}
    ${section("Why this fixes it:", plan.whyItFixes)}
    ${section("Not fixed:", plan.notFixed)}
    ${section("Risks:", plan.risks)}
    ${section("Assumptions:", plan.assumptions)}
    ${plan.edits.length ? plan.edits.map(editHtml).join("") : `<p class="caveat">The plan proposes no edits — read the reasoning above for what it would need.</p>`}
    ${
      !done && applicable.length
        ? `<div class="row wrap ws-apply-row">
             <button id="wsApplyBtn" class="primary">${reverted ? "Apply again" : "Apply"} ${applicable.length} edit${applicable.length === 1 ? "" : "s"}</button>
             <button id="wsDiscardBtn" class="secondary">Discard</button>
             <span id="wsApplyStatus" class="status"></span>
           </div>
           <p class="hint">
             Applied edits are written straight to your files and left
             <strong>uncommitted and unstaged</strong>, so you review the diff. The
             originals are backed up first, so this is reversible either way.
           </p>`
        : ""
    }`;
  box.classList.remove("hidden");

  if (done || !applicable.length) return;
  $("#wsApplyBtn", box).addEventListener("click", () => applyFixPlan(plan.id, reverted));
  $("#wsDiscardBtn", box).addEventListener("click", () => {
    state.ws.plan = null;
    box.classList.add("hidden");
    box.innerHTML = "";
    $("#wsFixPanel").classList.add("hidden");
  });
}

async function applyFixPlan(id, reapply = false) {
  const box = $("#wsFixPlan");
  const status = $("#wsApplyStatus", box);
  const btn = $("#wsApplyBtn", box);
  btn.disabled = true;
  status.textContent = "Applying…";
  status.className = "status";

  try {
    const data = await api("/api/workspace/fix/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, reapply }),
    });
    // Edits and files are different counts — several edits usually share a file.
    const n = data.applied.length;
    const files = data.files || new Set(data.applied.map((a) => a.folder + "|" + a.file)).size;
    const byFile = new Map();
    for (const a of data.applied) {
      const k = a.file;
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k).push(a.line);
    }
    box.innerHTML = `
      <h2>Applied</h2>
      <p class="status ok">
        ${n} edit${n === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"}
        · nothing staged · nothing committed
      </p>
      <ul class="ws-file-applied">
        ${[...byFile.entries()]
          .map(
            ([file, lines]) =>
              `<li><code>${esc(file)}</code> <span class="muted">${lines.length} edit${
                lines.length === 1 ? "" : "s"
              } — line${lines.length === 1 ? "" : "s"} ${lines.filter(Boolean).sort((a, b) => a - b).join(", ")}</span></li>`
          )
          .join("")}
      </ul>
      <p class="hint">
        Review the diff before committing — <code>git diff</code> in the workspace folder,
        or your editor's source-control view. Originals were copied to
        <code>${esc(data.backupDir)}</code> first, so you can restore them even if the
        folder isn't a git repository.
      </p>`;
    state.ws.plan = null;
  } catch (e) {
    btn.disabled = false;
    status.textContent = e.message;
    status.className = "status";
    const p = document.createElement("p");
    p.className = "caveat";
    p.textContent = e.message;
    box.appendChild(p);
  }
}

// Phase 1 wiring
$$("#wscMode button").forEach((b) =>
  b.addEventListener("click", () => wscSetMode(b.dataset.mode))
);
$("#wscFind").addEventListener("click", wscResolve);
$("#wscSearch").addEventListener("click", wscSearch);
$("#wscValue").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (WSC_MODE_CFG[state.ws.picker.mode].resolve) wscResolve();
  else wscSearch();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    state.meta = await api("/api/meta");
    state.aiAvailable = !!state.meta.aiAvailable;
    const label = state.meta.baseUrl || "not configured";
    $("#baseUrlLabel").textContent = "read-only · " + label;
    $("#footBase").textContent = label;
    buildStatusChips();
    setMode("owner");
  } catch (e) {
    $("#baseUrlLabel").textContent = "error loading";
    console.error(e);
  }
}
boot();
