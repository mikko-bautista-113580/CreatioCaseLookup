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
function escMultiline(t) { return esc(t).replace(/\n/g, "<br/>"); }
function renderSegments(segments) {
  return (segments || [])
    .map((s) =>
      s.type === "text"
        ? `<div class="seg-text">${escMultiline(s.text)}</div>`
        : `<img class="seg-img" src="${imgSrc(s)}" loading="lazy" alt="attachment" title="Click to enlarge" />`
    )
    .join("");
}
function renderThumbs(images) {
  if (!images || !images.length) return "";
  return `<div class="thumbs">${images
    .map((im) => `<img class="seg-img thumb" src="/api/file?entity=${encodeURIComponent(im.entity)}&id=${encodeURIComponent(im.id)}" loading="lazy" alt="attachment" title="Click to enlarge" />`)
    .join("")}</div>`;
}

function renderDetail(c, detail) {
  const d = c.detail || {};
  let html = '<div class="detail-box">';
  if (detail.includes("description")) {
    const body = d.descriptionSegments && d.descriptionSegments.length
      ? `<div class="desc rich">${renderSegments(d.descriptionSegments)}</div>`
      : `<div class="desc">${esc(d.description || "(none)")}</div>`;
    html += `<h4>Description</h4>${body}`;
  }
  if (detail.includes("latest") && d.latest !== undefined) {
    html += `<h4>Latest update</h4>${d.latest ? tlEntry(d.latest) : '<div class="desc">(no timeline entries)</div>'}`;
  }
  if (detail.includes("timeline")) {
    const tl = d.timeline || [];
    html += `<h4>Conversation / timeline (${tl.length})</h4>`;
    html += tl.length
      ? `<ul class="timeline">${tl.map(tlEntry).join("")}</ul><p class="hint">Authors are unresolved over this read-only access — message text and @mentions are shown as-is.</p>`
      : '<div class="desc">(no timeline entries)</div>';
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
    html += `<h4>Extra fields</h4><div class="extra-grid">${erows
      .map(([k, v]) => `<span class="k">${esc(k)}</span><span>${esc(v)}</span>`)
      .join("")}</div>`;
  }
  html += "</div>";
  return html;
}

function tlEntry(t) {
  const meta =
    t.kind === "EMAIL"
      ? `<div class="tl-meta">${esc(t.sender || "")} → ${esc(t.recipient || "")}${t.title ? " · " + esc(t.title) : ""}</div>`
      : "";
  // Feed posts are clean rich text → render inline (incl. FeedFile images).
  // Emails → trimmed text + any real file attachments as thumbnails.
  let body;
  if (t.kind === "FEED" && t.segments && t.segments.length) {
    body = `<div class="tl-text rich">${renderSegments(t.segments)}</div>`;
  } else {
    body = `<div class="tl-text">${esc(t.text || "(empty)")}</div>${renderThumbs(t.images)}`;
  }
  return `<li class="tl-entry ${t.kind}">
    <div class="tl-head"><span class="tl-kind ${t.kind}">${t.kind}</span><span>${esc(fmtDate(t.ts))}</span></div>
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
        <button id="aiStop" class="ai-tool" title="Stop">■ Stop</button>
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
        finishTools(panel, raw, single || (preset === "ask" ? "question" : preset));
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
      if (raw) finishTools(panel, raw, single || preset);
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
function finishTools(panel, raw, label) {
  const tools = $(".ai-tools", panel);
  if (!tools) return;
  $("#aiStop", panel)?.remove();
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
    a.download = `case-analysis-${String(label).replace(/[^\w.-]+/g, "_")}.md`;
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
