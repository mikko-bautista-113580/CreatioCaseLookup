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
  // Districts reads a local cache, so this is cheap; it never starts a build.
  if (name === "districts" && !dx.building) loadDistricts($("#dxSearch")?.value.trim() || "");
  if (name === "fixes") loadFixList();
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
  workAvailable: false, // Claude CLI + custom-reports tree both present
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

/** District code as a chip that jumps to this district in the Districts tab. */
function districtCell(code) {
  if (!code) return '<span class="muted">—</span>';
  return `<button class="dx-link" data-district="${esc(code)}" title="See every ticket for ${esc(
    code
  )} in the Districts tab">${esc(code)}</button>`;
}

// Any district chip (results table or ticket overlay) jumps to the Districts tab.
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-district]");
  if (!el) return;
  closeTicket(); // no-op when the overlay isn't open
  gotoDistrict(el.dataset.district);
});

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
          <td>${districtCell(c.District)}</td>
          <td>${esc(c.Contact)}</td>
          <td>${esc(fmtDate(c.CreatedOn))}</td>
          <td class="row-actions">
            <button class="row-view" data-view="${i}" title="View ticket — full description, conversation and dates">🎫</button>
            ${state.aiAvailable ? `<button class="row-ai" data-ai="${i}" title="Analyze this case with AI">✨</button>` : ""}
            ${state.workAvailable ? `<button class="row-ai row-work" data-work="${i}" title="Work on this case — Claude proposes uncommitted edits in custom-reports for you to review">🔧</button>` : ""}
            <button class="row-ai row-fix" data-fix="${i}" title="Record my fix — save your hand-made custom-reports changes against this case">📌</button>
            ${showDetail ? `<button class="expand-btn" data-exp="${i}">▸ detail</button>` : ""}
          </td>
        </tr>`;
      const detailRow = showDetail
        ? `<tr class="detail-row hidden" data-detail="${i}"><td colspan="9" class="detail-cell"><div class="detail-pending"><span class="spinner"></span> loading…</div></td></tr>`
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
          <th>Number</th><th>Subject</th><th>Status</th><th>Account</th><th>District</th><th>Contact</th><th>Created</th><th></th>
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

  // Per-case "view full ticket" (fetches detail on demand, cached on the row)
  root.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => openTicket(state.cases[+btn.dataset.view]));
  });

  // Per-case "analyze this one"
  root.querySelectorAll("[data-ai]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = state.cases[+btn.dataset.ai];
      runAnalysis("summarize", "", [mapCaseForAnalysis(c)]);
    });
  });

  // Per-case "work on this one" (triage -> approve -> edit-capable agent)
  root.querySelectorAll("[data-work]").forEach((btn) => {
    btn.addEventListener("click", () => workOnCase(state.cases[+btn.dataset.work]));
  });

  // Per-case "record my fix" — jump to the My fixes tab with the case prefilled
  root.querySelectorAll("[data-fix]").forEach((btn) => {
    btn.addEventListener("click", () => startFixRecording(state.cases[+btn.dataset.fix]));
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
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const lb = $("#lightbox");
  if (lb && !lb.classList.contains("hidden")) { closeLightbox(); return; }
  if ($("#instrModal")) { closeInstructions(); return; }
  closeTicket();
});
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
// AI instructions viewer — the exact prompts every AI run is given, fetched
// from /api/instructions (which serves the app's live source constants).
// ===========================================================================
let instrCache = null;

function instrStageHtml(s) {
  return `
    <section class="instr-stage">
      <h3>${esc(s.title)}</h3>
      <p class="hint">${esc(s.when)}</p>
      <h4>Guardrails</h4>
      <ul class="instr-guards">${(s.guardrails || []).map((g) => `<li>${esc(g)}</li>`).join("")}</ul>
      <h4>System prompt</h4>
      <pre class="prompt">${esc(s.systemPrompt)}</pre>
      ${(s.instructions || [])
        .map((i) => `<h4>Instruction — ${esc(i.label)}</h4><pre class="prompt">${esc(i.text)}</pre>`)
        .join("")}
    </section>`;
}

function renderInstructions(body) {
  let overlay = $("#instrModal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "instrModal";
    overlay.className = "ticket-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest(".tk-close")) closeInstructions();
    });
    document.body.appendChild(overlay);
    document.body.classList.add("no-scroll");
  }
  overlay.innerHTML = `
    <div class="ticket-page" role="dialog" aria-modal="true" aria-label="AI instructions">
      <header class="ticket-head">
        <div class="tk-title">
          <h2>What the AI is told</h2>
          <p class="hint">The exact system prompt and instructions each AI run receives, served
          straight from the app's source. Case text is always passed separately and marked as
          data — never as instructions.</p>
        </div>
        <button class="tk-close" title="Close (Esc)">✕</button>
      </header>
      <div class="ticket-body">${body}</div>
    </div>`;
}

async function openInstructions() {
  renderInstructions('<div class="detail-pending"><span class="spinner"></span> loading…</div>');
  if (!instrCache) {
    try {
      instrCache = await api("/api/instructions");
    } catch (e) {
      renderInstructions(`<div class="ai-error">Couldn't load the instructions: ${esc(e.message)}</div>`);
      return;
    }
  }
  renderInstructions(
    `<p class="hint">Model: <code>${esc(instrCache.model)}</code></p>` +
      instrCache.stages.map(instrStageHtml).join("")
  );
}

function closeInstructions() {
  $("#instrModal")?.remove();
  // Keep the page locked if a ticket overlay is still open underneath.
  if (!$("#ticketModal")) document.body.classList.remove("no-scroll");
}

$("#aiInstrLink").addEventListener("click", openInstructions);

// ===========================================================================
// Ticket viewer — a full case page (like the Creatio case card) in an overlay.
// Opens instantly from any results row, fetches description + timeline + extra
// fields on demand, and caches them on the row so reopening is immediate.
// ===========================================================================
const ticket = { open: false, num: null };

async function openTicket(c) {
  if (!c) return;
  ticket.open = true;
  ticket.num = c.Number;
  renderTicket(c, false);

  const have = c.detail || {};
  const need = [];
  if (have.description === undefined) need.push("description");
  if (have.timeline === undefined) need.push("timeline");
  if (have.extra === undefined) need.push("extra");
  if (!need.length) { renderTicket(c, true); return; }

  try {
    const detail = await fetchCaseDetail(c.Number, need);
    if (!ticket.open || ticket.num !== c.Number) return; // closed / switched meanwhile
    c.detail = { ...(c.detail || {}), ...detail };
    renderTicket(c, true);
  } catch (e) {
    if (!ticket.open || ticket.num !== c.Number) return;
    renderTicket(c, true, e.message);
  }
}

function closeTicket() {
  ticket.open = false;
  ticket.num = null;
  $("#ticketModal")?.remove();
  document.body.classList.remove("no-scroll");
}

/** Fetch selected detail kinds for one case via the existing /api/cases SSE. */
async function fetchCaseDetail(number, kinds) {
  const res = await fetch("/api/cases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "number", numbers: [number], detail: kinds }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.error === "auth") showAuthBanner(data.message);
    throw new Error(data.message || `Request failed (${res.status})`);
  }
  let detail = null;
  let err = null;
  await consumeSse(res.body, {
    case: (d) => { if (d.error) err = d.error; else if (!detail) detail = d.detail; },
    error: (d) => { if (d.kind === "auth") showAuthBanner(d.message); err = d.message; },
    done: () => {},
  });
  if (err) throw new Error(err);
  if (!detail) throw new Error("No detail returned — the case may not be visible with the current cookies.");
  return detail;
}

function tkField(label, value, isHtml = false) {
  if (value === "" || value == null) return "";
  return `<div class="tk-field"><span class="tk-k">${esc(label)}</span><span class="tk-v">${isHtml ? value : esc(value)}</span></div>`;
}

function renderTicket(c, done, errMsg) {
  let overlay = $("#ticketModal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "ticketModal";
    overlay.className = "ticket-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest(".tk-close")) closeTicket();
    });
    document.body.appendChild(overlay);
    document.body.classList.add("no-scroll");
  }

  const d = c.detail || {};
  const x = d.extra || {};
  const pending = '<div class="detail-pending"><span class="spinner"></span> loading…</div>';

  const profile = [
    tkField("Status", `<span class="st-badge ${stClass(c.Status)}">${esc(c.Status)}</span>`, true),
    tkField("Account", c.Account),
    tkField("District", districtCell(c.District), true),
    tkField("Contact", c.Contact),
    tkField("Owner", c.Owner),
    tkField("Created", fmtDate(c.CreatedOn)),
    tkField("Registered", fmtDate(x.RegisteredOn)),
    tkField("Modified", fmtDate(x.ModifiedOn)),
    tkField("Response due", fmtDate(x.ResponseDate)),
    tkField("Solution date", fmtDate(x.SolutionDate)),
    tkField("Solution overdue", x.SolutionOverdue == null ? "" : x.SolutionOverdue ? "Yes" : "No"),
    tkField("Hours worked", x.NltHoursWorked ?? ""),
  ].join("");

  const descHtml =
    d.descriptionSegments && d.descriptionSegments.length
      ? `<div class="desc rich">${renderSegments(d.descriptionSegments)}</div>`
      : d.description !== undefined
        ? `<div class="desc">${esc(d.description || "(none)")}</div>`
        : done ? '<div class="desc">(none)</div>' : pending;

  const tl = d.timeline;
  const convHtml =
    tl !== undefined
      ? tl.length
        ? `<ul class="timeline">${tl.map(tlEntry).join("")}</ul>
           <p class="hint">Authors are unresolved over this read-only access — message text and @mentions are shown as-is.</p>`
        : '<div class="desc">(no conversation yet)</div>'
      : done ? '<div class="desc">(unavailable)</div>' : pending;

  overlay.innerHTML = `
    <div class="ticket-page" role="dialog" aria-modal="true" aria-label="Case ${esc(c.Number)}">
      <header class="ticket-head">
        <div class="tk-title">
          <div class="tk-num-line">
            <span class="num">${esc(c.Number)}</span>
            <span class="st-badge ${stClass(c.Status)}">${esc(c.Status)}</span>
          </div>
          <h2>${esc(c.Subject || "(no subject)")}</h2>
        </div>
        <button class="tk-close" title="Close (Esc)">✕</button>
      </header>
      <div class="ticket-body">
        ${errMsg ? `<div class="ai-error">Couldn't load the full ticket: ${esc(errMsg)}</div>` : ""}
        <div class="ticket-grid">
          <aside class="tk-profile">${profile}</aside>
          <div class="tk-main">
            <h4>Description</h4>
            ${descHtml}
            <h4>Conversation / timeline${tl !== undefined ? ` (${tl.length})` : ""}</h4>
            ${convHtml}
          </div>
        </div>
      </div>
    </div>`;
}

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
  // Called once per run, and a plan can be run file by file — drop the previous
  // run's buttons so they don't stack up (and don't hand back stale output).
  tools.querySelectorAll(".ai-tool-done").forEach((b) => b.remove());
  const copyBtn = document.createElement("button");
  copyBtn.className = "ai-tool ai-tool-done";
  copyBtn.textContent = "⧉ Copy";
  copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(raw); copyBtn.textContent = "✓ Copied"; setTimeout(() => (copyBtn.textContent = "⧉ Copy"), 1500); }
    catch { copyBtn.textContent = "copy failed"; }
  });
  const dlBtn = document.createElement("button");
  dlBtn.className = "ai-tool ai-tool-done";
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
  $$(".row-ai").forEach((b) => (b.disabled = v)); // includes .row-work buttons
}

// ===========================================================================
// Work on a case — triage brief -> explicit approval -> edit-capable agent.
// The agent edits ONLY the district folders in the staged scope, has no git,
// and every change stays uncommitted for the developer to review & finalize.
// ===========================================================================
const work = { running: false, abort: null, hint: "", case: null, planning: false, planAbort: null, planStaged: null };

function workStatus(html) {
  const el = $("#workStatus");
  if (el) el.innerHTML = html;
}

/** Current contents of the instruction box (falls back to the stored value). */
function workHint() {
  const box = $("#workHint");
  return (box ? box.value : work.hint || "").trim();
}

/**
 * Triage a case, then gate the edit-capable run behind an approval.
 * `hint` is the developer's own instructions: it goes to triage (where it can
 * still change the report type, candidate files and edit scope) and again to
 * the worker. Re-running with a corrected hint is the way to fix a brief that
 * guessed the wrong report type.
 */
async function workOnCase(c, hint) {
  if (work.running || state.analyzing) return;
  const panel = $("#analysisPanel");
  if (!panel) return;
  // A plan still in flight belongs to the brief we are about to replace.
  work.planAbort?.abort();
  work.case = c;
  work.hint = typeof hint === "string" ? hint : "";

  work.running = true;
  work.abort = new AbortController();
  setPresetsDisabled(true);

  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div class="ai-head">
      <span class="ai-run-title">🔧 Work on ${esc(c.Number)} <span class="muted">· ${esc(c.Subject)}</span></span>
      <span class="ai-tools">
        <button id="workStop" class="ai-tool" title="Stop">■ Stop</button>
        <span class="ai-status" id="workStatus"><span class="spinner"></span> triaging…</span>
      </span>
    </div>
    <div class="work-hint">
      <label for="workHint">Your instructions for Claude <span class="muted">— optional, but they beat its own guess</span></label>
      <textarea id="workHint" rows="2" spellcheck="false"
        placeholder="e.g. the client wants a NEW custom transcript — this is a transcript template, not a report card"></textarea>
      <p class="hint">Typed by you, so Claude treats this as direction (case text is only ever data).
        It steers triage <em>and</em> the edit run — re-run triage below to apply changes here.</p>
    </div>
    <div id="workBrief"></div>
    <div id="workAtts" class="work-atts hidden"></div>
    <div id="workPlan" class="work-plan hidden"></div>
    <div id="workGate" class="work-gate hidden"></div>
    <div id="workLog" class="tool-log hidden"></div>
    <div class="ai-output md hidden" id="workOut"></div>
    <div id="workChanges" class="work-changes hidden"></div>
    <div class="ai-foot hidden" id="workFoot"></div>`;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("#workStop").addEventListener("click", () => work.abort?.abort());

  // Survive the re-render, and keep typing available while triage runs.
  const hintBox = $("#workHint");
  hintBox.value = work.hint;
  hintBox.addEventListener("input", () => (work.hint = hintBox.value));

  try {
    const res = await fetch("/api/workon/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number: c.Number, hint: work.hint }),
      signal: work.abort.signal,
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.error === "auth") showAuthBanner(data.message);
      throw new Error(data.message || `Triage failed (${res.status})`);
    }

    let staged = null;
    await consumeSse(res.body, {
      progress: (d) => workStatus(`<span class="spinner"></span> ${esc(d.message || "working…")}`),
      brief: (d) => { staged = d; },
      error: (d) => {
        if (d.kind === "auth") showAuthBanner(d.message);
        throw new Error(d.message || "Triage error");
      },
      done: () => {},
    });
    if (!staged) throw new Error("Triage returned no brief for this case.");

    workStatus("triage done");
    $("#workStop")?.remove();
    renderWorkGate(staged);
  } catch (e) {
    $("#workStop")?.remove();
    if (e.name === "AbortError") {
      workStatus('<span class="muted">stopped</span>');
    } else {
      workStatus('<span class="err-text">failed</span>');
      $("#workBrief").innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
    }
  } finally {
    work.running = false;
    work.abort = null;
    setPresetsDisabled(false);
  }
}

// Show the validated brief + edit scope, gated behind an explicit approval.
function renderWorkGate(staged) {
  // No candidate-file list here: the plan card names every file it will touch
  // and what it will do to each. "Case doesn't say" stays — that gap is what
  // the instruction box below is for filling in.
  $("#workBrief").innerHTML = renderBriefCard(
    {
      caseNumber: staged.caseNumber,
      brief: staged.brief,
      guesses: staged.guesses,
    },
    { candidates: false }
  );

  renderWorkAttachments(staged);

  const gate = $("#workGate");
  gate.classList.remove("hidden");

  const dirs = (staged.scope?.dirs || []).map((d) => `<li><code>${esc(d)}/</code></li>`).join("");
  const docs = (staged.scope?.docs || []).map((d) => `<li><code>${esc(d)}</code></li>`).join("");

  // The scope is narrowed to the report type, so name the type on the heading
  // and say which folders that left out — a silent narrowing looks like a bug.
  const rtype = staged.brief?.reportType || "unknown";
  const typeName = (RTYPE_LABEL[rtype] || rtype).replace(/^\S+\s/, ""); // drop the emoji
  const scopeLabel = rtype === "unknown" || rtype === "module" ? "" : ` <span class="muted">· ${esc(typeName)} only</span>`;
  const excluded = staged.scope?.excluded || [];
  const excludedHtml = excluded.length
    ? `<p class="hint">Left out as not ${esc(typeName)} folders: ${excluded
        .map((d) => `<code>${esc(d)}/</code>`)
        .join(", ")}</p>`
    : "";

  const retriageBtn = `<button id="workRetriage" class="secondary"
    title="Re-run triage with what's in the instruction box — this is what changes the report type, candidate files and edit scope">↻ Re-run triage with my instructions</button>`;
  const wireRetriage = () =>
    $("#workRetriage")?.addEventListener("click", () => workOnCase(work.case, workHint()));

  if (!staged.canProceed) {
    // Be specific when the report-type filter is what emptied the scope: the
    // usual cause is a mislabelled type, which re-triage can fix.
    const onlyOtherTypes = excluded.length && !(staged.scope?.dirs || []).length;
    gate.innerHTML = `
      <div class="escal"><strong>Can't hand this to the worker:</strong>
        ${onlyOtherTypes
          ? `this district has no ${esc(typeName)} folder — only ${excluded
              .map((d) => `<code>${esc(d)}/</code>`)
              .join(", ")}, which a ${esc(typeName)} case must not edit.`
          : "no verified candidate files or no district folder could be scoped."}
        ${onlyOtherTypes ? "If the report type is wrong, say so in the instruction box above and re-run triage." : "This one needs a human from the start."}</div>
      <div class="actions">${retriageBtn}</div>`;
    wireRetriage();
    return;
  }

  gate.innerHTML = `
    <div class="work-scope">
      <div>
        <h4>Folders Claude may edit${scopeLabel}</h4>
        <ul>${dirs}</ul>
        ${excludedHtml}
      </div>
      <div>
        <h4>Docs it reads first</h4>
        <ul>${docs || "<li>(none found)</li>"}</ul>
      </div>
    </div>
    ${staged.brief.needsHuman
      ? '<div class="escal"><strong>Triage flagged this for review</strong> — proceed only if the brief above looks right to you.</div>'
      : ""}
    <div class="actions">
      <button id="workGo" class="primary">🔧 Let Claude edit these folders</button>
      <button id="workReplan" class="secondary"
        title="Re-plan with what's in the instruction box — same brief and scope, a new plan">↻ Re-plan with my instructions</button>
      ${retriageBtn}
      <span class="hint">No commits — changes stay in your working tree for you to review and finalize.</span>
    </div>`;

  $("#workGo").addEventListener("click", () => startWorkRun(staged));
  $("#workReplan").addEventListener("click", () => runWorkPlan(staged));
  // Wrong report type / wrong folder? Correct it in the box and re-triage —
  // the scope is derived from the brief, so only a new brief can move it.
  wireRetriage();

  // Plan before approving: the developer should see what Claude intends to
  // change, not just which folders it may touch. Read-only, so it is safe to
  // start unprompted.
  runWorkPlan(staged);
}

// ---------------------------------------------------------------------------
// The plan — a read-only pass that says what it intends to change, before the
// approve button does anything. Re-runnable with corrected instructions.
// ---------------------------------------------------------------------------
const PLAN_ACTION_LABEL = {
  edit: { icon: "✏️", text: "edit", cls: "pa-edit" },
  create: { icon: "✨", text: "create", cls: "pa-create" },
  "read-only": { icon: "👁", text: "read only", cls: "pa-read" },
};

/**
 * Enable/disable everything that can start or re-shape a run — the gate's
 * buttons and the plan's per-file run buttons. One lock for both, so a live
 * agent cannot be joined by a second one from the other list.
 */
function setGateBusy(busy, why) {
  for (const sel of ["#workGo", "#workReplan", "#workRetriage"]) {
    const el = $(sel);
    if (!el) continue;
    el.disabled = busy;
    el.title = busy ? why || "" : "";
  }
  document.querySelectorAll("[data-runstep]").forEach((b) => {
    b.disabled = busy;
    b.title = busy ? why || "" : b.dataset.runtitle || "";
  });
}

/** Gate + plan buttons while a plan is in flight. */
function setPlanBusy(busy) {
  setGateBusy(busy, "Planning — wait for the plan, or it won't be part of the run");
}

async function runWorkPlan(staged) {
  const box = $("#workPlan");
  if (!box || work.planning) return;

  work.planning = true;
  work.planAbort = new AbortController();
  work.planStaged = staged; // so the failure card's Retry knows what to re-plan
  setPlanBusy(true);
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="plan-head">
      <h4><span class="spinner"></span> Planning — what Claude intends to change</h4>
      <span class="plan-elapsed" id="planElapsed">reading the repo… 0:00</span>
      <button id="planStop" class="ai-tool" title="Stop planning">■ Stop</button>
    </div>
    <div class="plan-log tool-log" id="planLog"></div>`;
  $("#planStop").addEventListener("click", () => work.planAbort?.abort());

  // A plan can legitimately take minutes on a big district folder. Show the
  // clock and every file it opens, so a slow plan reads as working, not hung.
  const startedAt = Date.now();
  let steps = 0;
  const tick = setInterval(() => {
    const el = $("#planElapsed");
    if (!el) return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    el.textContent = `${steps} file${steps === 1 ? "" : "s"} examined · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);

  const logLine = (name, target) => {
    const log = $("#planLog");
    if (!log) return;
    log.insertAdjacentHTML(
      "beforeend",
      `<div class="tl-line"><span class="tl-name">${esc(name)}</span> <span class="tl-target">${esc(target || "")}</span></div>`
    );
    log.scrollTop = log.scrollHeight;
  };

  try {
    const res = await fetch("/api/workon/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: staged.workId, hint: workHint() }),
      signal: work.planAbort.signal,
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `Planning failed (${res.status})`);
    }

    let plan = null;
    let failure = "";
    await consumeSse(res.body, {
      progress: (d) => logLine("…", d.message || "working"),
      // Show the investigation as it happens — it is the evidence behind the plan.
      tool: (d) => { steps++; logLine(d.name, d.target); },
      plan: (d) => { plan = d.plan; },
      // Planning failing is not fatal: the gate keeps its approve button.
      error: (d) => { failure = d.message || "Planning failed."; },
      done: () => {},
    });

    if (plan) renderWorkPlan(plan, staged);
    else renderPlanFailure(failure || "Planning returned no plan.", steps);
  } catch (e) {
    renderPlanFailure(e.name === "AbortError" ? "Planning stopped." : e.message, steps);
  } finally {
    clearInterval(tick);
    work.planning = false;
    work.planAbort = null;
    setPlanBusy(false);
  }
}

/**
 * Planning failed, timed out, or was stopped. The retry lives HERE, in the card
 * you are already looking at — the gate's re-plan button is further down the
 * page and easy to miss when the failure is what has your attention.
 */
function renderPlanFailure(msg, steps) {
  const box = $("#workPlan");
  if (!box) return;
  const timedOut = /timed out/i.test(msg);
  box.innerHTML = `
    <div class="plan-head">
      <h4>Plan unavailable</h4>
      <button id="planRetry" class="secondary">↻ Try planning again</button>
    </div>
    <div class="ai-error">${esc(msg)}</div>
    <p class="hint">${
      timedOut
        ? `It got through ${steps || 0} file${steps === 1 ? "" : "s"} before the cap. Narrowing it usually fixes this — name the file or the change in the box above, then retry, so it stops searching and starts planning.`
        : "Nothing was changed."
    }
      You can also approve the run as-is — it will just go in without an agreed plan.</p>`;
  $("#planRetry").addEventListener("click", () => {
    if (work.planStaged) runWorkPlan(work.planStaged);
  });
}

function renderWorkPlan(plan, staged) {
  const box = $("#workPlan");
  if (!box) return;

  const steps = plan.steps || [];
  // Rank by what the plan DOES to each file: edits and creations first, files
  // it only reads last. The changes are the whole basis for approving the run;
  // the reads are the evidence behind them, so they get a quieter block at the
  // bottom instead of competing with the edits for the same attention. An
  // out-of-scope step is an edit/create, so it stays up top where it is seen.
  const changes = steps.filter((s) => s.action !== "read-only");
  const reads = steps.filter((s) => s.action === "read-only");

  // A file that does not exist yet cannot be opened, so "create" targets stay
  // plain text — a viewer that only ever errors is worse than no link.
  const pathHtml = (s) =>
    s.action === "create"
      ? `<code>${esc(s.path)}</code> <span class="plan-new">new file</span>`
      : `<button class="link path" data-viewfile="${esc(s.path)}" title="Open ${esc(s.path)}">${esc(s.path)}</button>`;

  // Each change can be run on its own. The button IS the approval for that one
  // file — same weight as the gate's approve button, narrower blast radius: the
  // server grants Edit/Write on that path only. An out-of-scope step gets no
  // button; running it could only end in a denied write.
  const runBtn = (s) => {
    if (s.outOfScope) return "";
    const verb = s.action === "create" ? "Create" : "Edit";
    const title = `Run Claude with write access to ${s.path} and nothing else`;
    return `<button class="plan-run" data-runstep="${esc(s.path)}" data-runtitle="${esc(title)}"
      title="${esc(title)}">🔧 ${verb} only this file</button>`;
  };

  const changeRows = changes.length
    ? changes
        .map((s, i) => {
          const a = PLAN_ACTION_LABEL[s.action] || PLAN_ACTION_LABEL["read-only"];
          return `
            <li class="plan-step ${s.outOfScope ? "plan-step-bad" : ""}">
              <span class="plan-n">${i + 1}</span>
              <div class="plan-body">
                <div class="plan-file">
                  <span class="plan-action ${a.cls}">${a.icon} ${a.text}</span>
                  ${pathHtml(s)}
                  ${s.outOfScope ? '<span class="plan-oos" title="Outside the approved folders — this edit would be denied at run time">out of scope</span>' : ""}
                </div>
                ${s.what ? `<p class="plan-what">${esc(s.what)}</p>` : ""}
                ${s.why ? `<p class="plan-why">${esc(s.why)}</p>` : ""}
                ${runBtn(s)}
              </div>
            </li>`;
        })
        .join("")
    : `<li class="plan-step plan-step-none"><div class="plan-body">
         <p class="plan-what">No file changes proposed${
           reads.length ? " — Claude expects to read and report, not edit." : "."
         }</p></div></li>`;

  // Collapsed once the list gets long enough to push the approve button off
  // screen; the count stays on the summary either way.
  const readsHtml = reads.length
    ? `<details class="plan-reads"${reads.length > 4 ? "" : " open"}>
         <summary>👁 Reads for context — ${reads.length} file${reads.length === 1 ? "" : "s"}, not changed</summary>
         <ul>${reads
           .map(
             (s) => `
             <li class="plan-read">
               <button class="link path" data-viewfile="${esc(s.path)}" title="Open ${esc(s.path)}">${esc(s.path)}</button>
               ${s.why || s.what ? `<span class="plan-read-why">${esc(s.why || s.what)}</span>` : ""}
             </li>`
           )
           .join("")}</ul>
       </details>`
    : "";

  const list = (title, items, cls) =>
    items && items.length
      ? `<div class="plan-aside ${cls}"><h5>${title}</h5><ul>${items
          .map((x) => `<li>${esc(x)}</li>`)
          .join("")}</ul></div>`
      : "";

  box.innerHTML = `
    <div class="plan-head">
      <h4>📋 What Claude is planning</h4>
      <span class="hint">Read-only so far — nothing has been changed. Correct it in the box above and re-plan, or approve below.</span>
    </div>
    ${plan.goal ? `<p class="plan-goal">${esc(plan.goal)}</p>` : ""}
    ${changes.length
      ? `<h5 class="plan-group">✏️ Changes — ${changes.length} file${changes.length === 1 ? "" : "s"}, in order
           <span class="plan-group-hint">run one at a time, or approve them all below</span></h5>`
      : ""}
    <ol class="plan-steps">${changeRows}</ol>
    ${readsHtml}
    ${list("Deliberately not changing", plan.notTouching, "plan-keep")}
    ${list("Open questions — answer these in the instruction box", plan.openQuestions, "plan-q")}
    ${list("Warnings", plan.warnings, "plan-warn")}`;

  // One file at a time: the button carries the path, the server re-checks it
  // against this same plan, and only that path gets write permission.
  box.querySelectorAll("[data-runstep]").forEach((b) =>
    b.addEventListener("click", () => startWorkRun(staged, b.dataset.runstep))
  );
}

/**
 * Retire a step's run button once it has run. The plan then shows how far
 * through it you are, and the same file cannot be run twice by a stray click.
 */
function markStepRan(path) {
  document.querySelectorAll("[data-runstep]").forEach((b) => {
    if (b.dataset.runstep !== path) return;
    const done = document.createElement("span");
    done.className = "plan-ran";
    done.title = "Already run in this session — its diff is below";
    done.textContent = "✓ ran";
    b.replaceWith(done);
  });
}

// Attachments strip — thumbnails of what the client sent, with the processed
// (auto-cropped) variants and a "place into district folder" control. Lives
// outside #workGate so it survives the run and stays usable while reading the
// agent's report ("Files to place" section names the file + destination).
function renderWorkAttachments(staged) {
  const box = $("#workAtts");
  const files = staged.attachments || [];
  const notes = staged.attachmentNotes || [];
  if (!files.length && !notes.length) return;

  const attUrl = (name) =>
    `/api/workon/attachment?case=${encodeURIComponent(staged.caseNumber)}&name=${encodeURIComponent(name)}`;
  const dirs = staged.scope?.dirs || [];

  const rows = files.map((f, i) => {
    if (f.error) {
      return `<div class="att-row"><span class="att-name">${esc(f.name || "(attachment)")}</span>
        <span class="err-text">${esc(f.error)}</span></div>`;
    }
    if (!f.isImage) {
      return `<div class="att-row"><span class="att-name">📄 ${esc(f.name)}</span>
        <span class="muted">${esc(f.contentType)} · ${(f.bytes / 1024).toFixed(0)} KB</span>
        <a href="${attUrl(f.name)}" download="${esc(f.name)}">download</a></div>`;
    }
    const thumbName = f.croppedPng || f.name;
    const variants = [
      `<a href="${attUrl(f.name)}" target="_blank">original</a>`,
      f.croppedPng ? `<a href="${attUrl(f.croppedPng)}" target="_blank">.png</a>` : "",
      f.croppedJpg ? `<a href="${attUrl(f.croppedJpg)}" target="_blank">.jpg</a>` : "",
    ].filter(Boolean).join(" · ");
    const placer = dirs.length && f.croppedPng
      ? `<span class="att-place">
          <select class="att-variant" data-i="${i}">
            <option value="${esc(f.croppedPng)}">cropped .png</option>
            <option value="${esc(f.croppedJpg)}">cropped .jpg</option>
            <option value="${esc(f.name)}">original</option>
          </select>
          <select class="att-dir" data-i="${i}">
            ${dirs.map((d) => `<option value="${esc(d)}">${esc(d)}/</option>`).join("")}
          </select>
          <input class="att-saveas" data-i="${i}" value="${esc(f.croppedPng)}" spellcheck="false" />
          <button class="att-go" data-i="${i}">Place</button>
          <span class="att-status" data-i="${i}"></span>
        </span>`
      : "";
    return `<div class="att-row">
      <a href="${attUrl(f.name)}" target="_blank"><img class="att-thumb" src="${attUrl(thumbName)}" alt="${esc(f.name)}" loading="lazy"></a>
      <span class="att-name">${esc(f.name)}${f.probableLogo ? ' <span class="att-logo-flag">logo?</span>' : ""}</span>
      <span class="muted">${f.width ? `${f.width}×${f.height}${f.cropped ? " (auto-cropped)" : ""} · ` : ""}${variants}</span>
      ${placer}
    </div>`;
  });

  box.innerHTML = `<h4>Attachments (${files.length})</h4>
    ${rows.join("")}
    ${notes.map((n) => `<p class="hint">${esc(n)}</p>`).join("")}`;
  box.classList.remove("hidden");

  box.querySelectorAll(".att-go").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const i = btn.dataset.i;
      const status = box.querySelector(`.att-status[data-i="${i}"]`);
      const file = box.querySelector(`.att-variant[data-i="${i}"]`).value;
      const dir = box.querySelector(`.att-dir[data-i="${i}"]`).value;
      const saveAs = box.querySelector(`.att-saveas[data-i="${i}"]`).value.trim();
      btn.disabled = true;
      status.textContent = "placing…";
      status.className = "att-status";
      try {
        const r = await api("/api/workon/place", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ case: staged.caseNumber, file, dir, saveAs }),
        });
        status.textContent = `✓ ${r.placed}${r.replaced ? " (replaced existing)" : ""}`;
        status.className = "att-status ok";
      } catch (e) {
        status.textContent = e.message;
        status.className = "att-status err-text";
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Keep the default filename in step with the chosen variant until edited.
  box.querySelectorAll(".att-variant").forEach((sel) => {
    sel.addEventListener("change", () => {
      const input = box.querySelector(`.att-saveas[data-i="${sel.dataset.i}"]`);
      if (!input.dataset.touched) input.value = sel.value;
    });
  });
  box.querySelectorAll(".att-saveas").forEach((inp) => {
    inp.addEventListener("input", () => (inp.dataset.touched = "1"));
  });
}

/**
 * Hand the case to the edit-capable agent.
 *
 * `onlyPath` runs ONE step of the plan: the server re-checks the path against
 * the staged plan and grants Edit/Write on that file alone, and the ticket
 * survives so the next file can be run after it. Without it the whole plan runs
 * with the folder-wide scope, and the ticket is consumed as before.
 */
async function startWorkRun(staged, onlyPath) {
  if (work.running) return;
  const single = Boolean(onlyPath);
  work.running = true;
  work.abort = new AbortController();
  setPresetsDisabled(true);

  if (single) {
    // The gate stays: the rest of the plan is still there to run. Locked while
    // an edit-capable agent is live so a second one cannot be started.
    setGateBusy(true, "A run is in progress");
  } else {
    $("#workGate").innerHTML = "";
    $("#workGate").classList.add("hidden");
  }
  // The plan stays on screen as the reference for what was agreed, but it is
  // no longer something you can correct — say so instead of leaving stale copy.
  const planNote = $(".plan-head .hint");
  if (planNote) {
    planNote.textContent = single
      ? `Running one file: ${onlyPath} — the rest of the plan is still waiting.`
      : "Approved — this is what the run was told to do.";
  }
  const log = $("#workLog");
  const out = $("#workOut");
  // A per-file run is one of several, so clear the previous run's report and
  // tool log — the diffs below accumulate, the narration does not.
  log.innerHTML = "";
  out.innerHTML = "";
  log.classList.remove("hidden");
  out.classList.remove("hidden");
  out.classList.add("streaming");

  const tools = $(".ai-tools", $("#analysisPanel"));
  const stopBtn = document.createElement("button");
  stopBtn.id = "workStop";
  stopBtn.className = "ai-tool";
  stopBtn.textContent = "■ Stop";
  tools.prepend(stopBtn);
  stopBtn.addEventListener("click", () => work.abort?.abort());
  workStatus('<span class="spinner"></span> working…');

  // Locked in for this run — editing it now would be misleading.
  const hint = workHint();
  work.hint = hint;
  const hintBox = $("#workHint");
  if (hintBox) hintBox.disabled = true;

  let raw = "";
  try {
    const res = await fetch("/api/workon/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: staged.workId, hint, onlyPath: onlyPath || undefined }),
      signal: work.abort.signal,
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `Work run failed (${res.status})`);
    }

    await consumeSse(res.body, {
      start: (d) => workStatus('<span class="spinner"></span> reading the repo…'),
      tool: (d) => {
        log.insertAdjacentHTML(
          "beforeend",
          `<div class="tl-line"><span class="tl-name">${esc(d.name)}</span> <span class="tl-target">${esc(d.target || "")}</span></div>`
        );
        log.scrollTop = log.scrollHeight;
        workStatus(`<span class="spinner"></span> ${esc(d.name)}…`);
      },
      chunk: (d) => {
        raw += d.text;
        out.innerHTML = renderMarkdown(raw);
        out.scrollTop = out.scrollHeight;
      },
      changes: (d) => renderWorkChanges(d),
      done: (d) => {
        out.classList.remove("streaming");
        workStatus(single ? "✓ file done" : "✓ done");
        if (single) markStepRan(onlyPath);
        finishTools($("#analysisPanel"), raw, `work-${staged.caseNumber}`);
        const foot = $("#workFoot");
        const bits = [];
        if (d.totalTokens) bits.push(`${d.totalTokens.toLocaleString()} tokens`);
        if (typeof d.costUsd === "number") bits.push(`$${d.costUsd.toFixed(4)}`);
        if (d.durationMs) bits.push(`${(d.durationMs / 1000).toFixed(1)}s`);
        if (bits.length) { foot.textContent = bits.join(" · "); foot.classList.remove("hidden"); }
      },
      error: (d) => { throw new Error(d.message || "Work run error"); },
    });
  } catch (e) {
    out.classList.remove("streaming");
    if (e.name === "AbortError") {
      workStatus('<span class="muted">stopped</span>');
      $("#workChanges").classList.remove("hidden");
      $("#workChanges").innerHTML =
        '<div class="escal"><strong>Stopped mid-run.</strong> The agent may have left partial edits — check <code>git status</code> in custom-reports.</div>';
    } else {
      workStatus('<span class="err-text">failed</span>');
      out.classList.remove("hidden");
      out.innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
    }
  } finally {
    work.running = false;
    work.abort = null;
    setPresetsDisabled(false);
    $("#workStop")?.remove();
    const box = $("#workHint");
    if (box) box.disabled = false;
    // A per-file run leaves the rest of the plan runnable — including after a
    // failure, so a bad step can be retried or skipped.
    if (single) {
      setGateBusy(false);
      const note = $(".plan-head .hint");
      if (note) note.textContent = "Pick another file to run, or approve the whole plan below.";
    }
  }
}

function renderWorkChanges(d) {
  const box = $("#workChanges");
  box.classList.remove("hidden");

  // "Before this run" is measured from before the FIRST run on this case, so a
  // plan worked file by file never blames its own earlier edits on the developer.
  const pre = (d.preexistingDirty || []).length
    ? `<p class="hint">Already modified before Claude started (not the agent's work): ${d.preexistingDirty
        .map((p) => `<code>${esc(p)}</code>`)
        .join(", ")}</p>`
    : "";

  if (!(d.changes || []).length) {
    box.innerHTML = `<h4>Changes</h4><p class="hint">No files were changed by this run.</p>${pre}${
      d.error ? `<div class="ai-error">Could not read git status: ${esc(d.error)}</div>` : ""
    }`;
    return;
  }

  const blocks = d.changes
    .map(
      (ch) => `
      <details class="chg" open>
        <summary><span class="badge ${ch.kind === "deleted" ? "warn" : "ok"}">${esc(ch.kind)}</span>
          <code>${esc(ch.path)}</code>${ch.truncated ? ' <span class="muted">(diff truncated)</span>' : ""}</summary>
        <pre class="diff">${colorizeDiff(ch.diff, ch.kind)}</pre>
      </details>`
    )
    .join("");

  box.innerHTML = `
    <h4>Uncommitted changes (${d.changes.length} file${d.changes.length === 1 ? "" : "s"})</h4>
    <p class="hint">Nothing is committed. Review in VS Code / <code>git diff</code>, adjust, and finalize the commit yourself.</p>
    ${blocks}
    ${pre}`;
}

// Escape, then color diff lines. New (untracked) files arrive as raw content.
function colorizeDiff(text, kind) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  return lines
    .map((l) => {
      const e = esc(l);
      if (kind === "added" && !l.startsWith("diff ")) return `<span class="d-add">+ ${e}</span>`;
      if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index "))
        return `<span class="d-meta">${e}</span>`;
      if (l.startsWith("@@")) return `<span class="d-hunk">${e}</span>`;
      if (l.startsWith("+")) return `<span class="d-add">${e}</span>`;
      if (l.startsWith("-")) return `<span class="d-del">${e}</span>`;
      return e;
    })
    .join("\n");
}

// ===========================================================================
// My fixes — record hand-made fixes (uncommitted custom-reports changes)
// against a case number, and browse the saved records.
// ===========================================================================
const fixes = { scan: [], records: [], detail: new Map(), subject: "" };

/** One changed file as an expandable diff block; withPick adds the checkbox. */
function fixChangeBlock(ch, withPick) {
  const badge = `<span class="badge ${ch.kind === "deleted" ? "warn" : "ok"}">${esc(ch.kind)}</span>`;
  const trunc = ch.truncated ? ' <span class="muted">(diff truncated)</span>' : "";
  const pick = withPick
    ? `<input type="checkbox" class="fix-pick" data-path="${esc(ch.path)}" /> `
    : "";
  return `
    <details class="chg">
      <summary>${pick}${badge} <code>${esc(ch.path)}</code>${trunc}</summary>
      <pre class="diff">${colorizeDiff(ch.diff, ch.kind)}</pre>
    </details>`;
}

async function fixScan() {
  const st = $("#fixScanStatus");
  st.innerHTML = '<span class="spinner"></span> scanning…';
  $("#fixScanResults").innerHTML = "";
  fixes.scan = [];
  try {
    const { changes } = await api("/api/fixes/scan", { method: "POST" });
    fixes.scan = changes || [];
    st.textContent = fixes.scan.length
      ? `${fixes.scan.length} changed file${fixes.scan.length === 1 ? "" : "s"}`
      : "";
    renderFixScan();
  } catch (e) {
    st.textContent = "";
    $("#fixScanResults").innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
  }
}

function renderFixScan() {
  const box = $("#fixScanResults");
  if (!fixes.scan.length) {
    box.innerHTML = '<div class="empty">No uncommitted changes found in custom-reports.</div>';
    return;
  }
  const groups = new Map();
  for (const ch of fixes.scan) {
    if (!groups.has(ch.subrepo)) groups.set(ch.subrepo, []);
    groups.get(ch.subrepo).push(ch);
  }
  let html = `<p class="hint">Tick the files that belong to this case —
    <button class="link" id="fixPickAll">select all</button> ·
    <button class="link" id="fixPickNone">none</button></p>`;
  for (const [sub, list] of groups) {
    html += `<div class="fix-sub-head">${esc(sub)}</div>` +
      list.map((ch) => fixChangeBlock(ch, true)).join("");
  }
  box.innerHTML = html;
  // A click on the checkbox must pick, not toggle the <details>.
  $$(".fix-pick", box).forEach((cb) => cb.addEventListener("click", (e) => e.stopPropagation()));
  $("#fixPickAll").addEventListener("click", () => $$(".fix-pick", box).forEach((cb) => (cb.checked = true)));
  $("#fixPickNone").addEventListener("click", () => $$(".fix-pick", box).forEach((cb) => (cb.checked = false)));
}

async function fixSave() {
  const st = $("#fixSaveStatus");
  const caseNumber = $("#fixCase").value.trim();
  const note = $("#fixNote").value.trim();
  const paths = $$(".fix-pick").filter((cb) => cb.checked).map((cb) => cb.dataset.path);

  if (!/^[A-Za-z0-9-]{3,30}$/.test(caseNumber)) {
    st.innerHTML = '<span class="err-text">Invalid case number.</span>';
    return;
  }
  if (!note) {
    st.innerHTML = '<span class="err-text">Add a short note about the fix.</span>';
    return;
  }
  if (!paths.length) {
    st.innerHTML = '<span class="err-text">Scan and tick at least one changed file.</span>';
    return;
  }

  st.innerHTML = '<span class="spinner"></span> saving…';
  try {
    await api("/api/fixes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseNumber, note, subject: fixes.subject || undefined, paths }),
    });
    st.textContent = "saved ✓";
    fixes.subject = "";
    $("#fixNote").value = "";
    fixes.scan = [];
    $("#fixScanResults").innerHTML = "";
    $("#fixScanStatus").textContent = "";
    await loadFixList();
  } catch (e) {
    if (/working tree changed/i.test(e.message)) {
      st.innerHTML = '<span class="err-text">The working tree changed — re-scanning…</span>';
      await fixScan();
    } else {
      st.innerHTML = `<span class="err-text">${esc(e.message)}</span>`;
    }
  }
}

async function loadFixList() {
  const box = $("#fixList");
  try {
    const data = await api("/api/fixes");
    fixes.records = data.fixes || [];
    renderFixList();
  } catch (e) {
    box.innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
  }
}

function fixMatches(f, q) {
  if (!q) return true;
  const hay = [
    f.caseNumber,
    f.subject || "",
    f.note,
    ...(f.districts || []),
    ...f.files.map((x) => x.path),
  ].join("\n").toLowerCase();
  return hay.includes(q);
}

function renderFixList() {
  const box = $("#fixList");
  const q = $("#fixSearch").value.trim().toLowerCase();
  const shown = fixes.records.filter((f) => fixMatches(f, q));
  if (!shown.length) {
    box.innerHTML = `<div class="empty">${
      fixes.records.length ? "No records match your filter." : "No fixes recorded yet."
    }</div>`;
    return;
  }
  box.innerHTML = shown
    .map(
      (f) => `
      <details class="chg fix-rec" data-id="${esc(f.id)}">
        <summary class="fix-rec-meta">
          <span class="muted">${esc(fmtDate(f.createdAt))}</span>
          <span class="num">${esc(f.caseNumber)}</span>
          ${(f.districts || []).map((d) => `<span class="pill">${esc(d)}</span>`).join("")}
          <span class="fix-excerpt">${esc(f.note.slice(0, 80))}${f.note.length > 80 ? "…" : ""}</span>
          <span class="badge muted">${f.files.length} file${f.files.length === 1 ? "" : "s"}</span>
          <button class="link fix-del" data-id="${esc(f.id)}">delete</button>
        </summary>
        <div class="fix-rec-body"><div class="detail-pending"><span class="spinner"></span> loading…</div></div>
      </details>`
    )
    .join("");

  $$(".fix-del", box).forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm("Delete this fix record?")) return;
      try {
        await api("/api/fixes/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: btn.dataset.id }),
        });
        fixes.detail.delete(btn.dataset.id);
        await loadFixList();
      } catch (err) {
        alert(err.message);
      }
    })
  );

  // Full note + diffs are lazy-loaded on first expand and cached.
  $$(".fix-rec", box).forEach((det) =>
    det.addEventListener("toggle", () => { if (det.open) fillFixDetail(det); })
  );
}

async function fillFixDetail(det) {
  const id = det.dataset.id;
  const body = $(".fix-rec-body", det);
  let fix = fixes.detail.get(id);
  if (!fix) {
    try {
      ({ fix } = await api(`/api/fixes/record?id=${encodeURIComponent(id)}`));
      fixes.detail.set(id, fix);
    } catch (e) {
      body.innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
      return;
    }
  }
  body.innerHTML = `
    ${fix.subject ? `<p class="hint">${esc(fix.subject)}</p>` : ""}
    <p class="fix-note">${esc(fix.note)}</p>
    ${fix.files.map((ch) => fixChangeBlock(ch, false)).join("")}`;
}

/** Entry point from a Lookup results row (📌): prefill + jump + scan. */
function startFixRecording(c) {
  if (!c) return;
  $("#fixCase").value = c.Number || "";
  fixes.subject = c.Subject || "";
  switchTab("fixes");
  fixScan();
}

$("#fixScanBtn").addEventListener("click", fixScan);
$("#fixSaveBtn").addEventListener("click", fixSave);
$("#fixSearch").addEventListener("input", debounce(renderFixList, 150));

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
    else if (data.connection) msg += " But connection test failed: " + (data.connection.error || "").slice(0, 300);
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
    else { s.textContent = "Failed: " + (r.error || "").slice(0, 300); s.className = "status err"; }
  } catch (e) {
    s.textContent = e.message;
    s.className = "status err";
  }
}
$("#testCfgBtn").addEventListener("click", testConn);

async function browserLogin() {
  const s = $("#browserLoginStatus");
  const btn = $("#browserLoginBtn");
  btn.disabled = true;
  s.innerHTML = '<span class="spinner"></span> Opening browser…';
  s.className = "status";
  try {
    const res = await fetch("/api/config/login-popup", { method: "POST" });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    await consumeSse(res.body, {
      progress: (d) => { s.innerHTML = `<span class="spinner"></span> ${esc(d.message)}`; },
      error: (d) => { throw new Error(d.message); },
      done: (d) => {
        if (d.connection && d.connection.ok) { s.textContent = "Signed in — connection OK."; s.className = "status ok"; hideAuthBanner(); }
        else { s.textContent = "Signed in, but connection test failed: " + (d.connection?.error || "").slice(0, 300); s.className = "status err"; }
        loadConfig();
      },
    });
  } catch (e) {
    s.textContent = e.message;
    s.className = "status err";
  } finally {
    btn.disabled = false;
  }
}
$("#browserLoginBtn").addEventListener("click", browserLogin);

// ---------------------------------------------------------------------------
// Pipeline tab — case → candidate file triage (read-only)
//
// Everything rendered here derives from untrusted case text, so it all goes
// through esc(). Nothing in this tab can edit, commit, or push anything.
// ---------------------------------------------------------------------------
const pipe = { mode: "recent", running: false, abort: null, briefs: [] };

function setPipeMode(mode) {
  pipe.mode = mode;
  $$("#pipeModeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#pipeNumberField").classList.toggle("hidden", mode !== "number");
}
$$("#pipeModeSeg button").forEach((b) =>
  b.addEventListener("click", () => setPipeMode(b.dataset.mode))
);

function pipeProgress(on) { $("#pipeProgress").classList.toggle("hidden", !on); }
function setPipeProgress(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("#pipeFill").style.width = pct + "%";
  $("#pipeLabel").textContent = label || `${done} / ${total}`;
}

const CONF_DOT = { high: "●●●", medium: "●●○", low: "●○○" };

// Triage labels, spelled out for the header badges.
const NATURE_LABEL = {
  "bug-fix": "🐞 bug fix",
  addition: "➕ addition to existing",
  "new-template": "🆕 new template",
  unknown: "❔ nature unclear",
};
const RTYPE_LABEL = {
  "report-card": "📄 report card",
  transcript: "🎓 transcript",
  "progress-report": "📈 progress report",
  "honor-roll": "🏅 honor roll job",
  custom: "🧩 custom report",
  module: "⚙️ module / import",
  unknown: "❔ type unclear",
};

/**
 * One triaged case. `opts.candidates` controls the candidate-file list: the
 * triage results list keeps it (it is the only file evidence there), while the
 * work-on gate hides it — the plan card above the gate already names every
 * file, with what Claude intends to do to each, so showing both puts two
 * competing file lists on one screen.
 */
function renderBriefCard(payload, opts = {}) {
  const { candidates = true } = opts;
  const { caseNumber, brief, guesses } = payload;
  const files = brief.candidateFiles || [];
  const esc_ = esc;

  const filesHtml = files.length
    ? files
        .map(
          (f) => `
        <li class="cand ${f.shared ? "shared" : ""}">
          <span class="conf conf-${esc_(f.confidence)}" title="${esc_(f.confidence)} confidence">${
            CONF_DOT[f.confidence] || "○○○"
          }</span>
          <button class="link path" data-viewfile="${esc_(f.path)}">${esc_(f.path)}</button>
          ${f.shared ? '<span class="badge warn">shared include</span>' : ""}
          <div class="why">${esc_(f.reason)}</div>
        </li>`
        )
        .join("")
    : '<li class="cand empty">No candidate file could be verified.</li>';

  const candidatesHtml = candidates
    ? `<h4>Candidate files</h4><ul class="cands">${filesHtml}</ul>`
    : "";

  const escalHtml = (brief.escalations || []).length
    ? `<div class="escal"><strong>Needs a human because:</strong><ul>${brief.escalations
        .map((e) => `<li>${esc_(e)}</li>`)
        .join("")}</ul></div>`
    : "";

  const rejectedHtml = (brief.rejectedPaths || []).length
    ? `<div class="rejected"><strong>⚠ Dropped ${
        brief.rejectedPaths.length
      } unverifiable path(s):</strong> <code>${brief.rejectedPaths
        .map((p) => esc_(p))
        .join("</code>, <code>")}</code></div>`
    : "";

  const missingHtml = (brief.missingInfo || []).length
    ? `<div class="missing"><strong>Case doesn't say:</strong><ul>${brief.missingInfo
        .map((m) => `<li>${esc_(m)}</li>`)
        .join("")}</ul></div>`
    : "";

  const guessHtml = (guesses || []).length
    ? `<div class="guesses">${guesses
        .map(
          (g) =>
            `<span class="chip-static" title="${esc_(g.why.join(" · "))}">${esc_(
              g.code
            )} <em>${g.score}</em></span>`
        )
        .join("")}</div>`
    : "";

  return `
    <article class="card brief ${brief.needsHuman ? "needs-human" : "confident"}">
      <header class="brief-head">
        <h3>${esc_(caseNumber)}</h3>
        <span class="badge ${brief.needsHuman ? "warn" : "ok"}">${
          brief.needsHuman ? "needs review" : "confident"
        }</span>
        <span class="badge nature ${esc_(brief.caseNature || "unknown")}" title="What kind of work this case is asking for">${esc_(
          NATURE_LABEL[brief.caseNature] || NATURE_LABEL.unknown
        )}</span>
        <span class="badge rtype" title="Which kind of document this is">${esc_(
          RTYPE_LABEL[brief.reportType] || RTYPE_LABEL.unknown
        )}</span>
      </header>
      <p class="problem">${esc_(brief.problemStatement)}</p>
      ${brief.expectedSymptom ? `<p class="symptom"><strong>Symptom:</strong> ${esc_(brief.expectedSymptom)}</p>` : ""}
      ${guessHtml}
      ${candidatesHtml}
      ${escalHtml}
      ${rejectedHtml}
      ${missingHtml}
    </article>`;
}

async function viewRepoFile(path) {
  const res = await fetch("/api/repo-file?path=" + encodeURIComponent(path));
  const box = document.createElement("div");
  box.className = "lightbox filebox";
  if (!res.ok) {
    box.innerHTML = `<div class="lb-inner"><p class="err">Could not read ${esc(path)}</p></div>`;
  } else {
    const text = await res.text();
    box.innerHTML = `<div class="lb-inner filebody">
        <div class="filehead"><code>${esc(path)}</code><button class="link lb-close">close ✕</button></div>
        <pre class="filesrc">${esc(text)}</pre>
      </div>`;
  }
  box.addEventListener("click", (e) => {
    if (e.target === box || e.target.closest(".lb-close")) box.remove();
  });
  document.body.appendChild(box);
}

document.addEventListener("click", (e) => {
  const v = e.target.closest("[data-viewfile]");
  if (v) { e.preventDefault(); viewRepoFile(v.dataset.viewfile); }
});

async function runTriage() {
  if (pipe.running) return;
  const status = $("#pipeStatus");
  const results = $("#pipeResults");
  const body = {
    mode: pipe.mode,
    maxCases: Math.max(1, Math.min(+$("#pipeMax").value || 5, 25)),
    statuses: ["In progress"],
  };
  if (pipe.mode === "number") {
    body.numbers = $("#pipeNumbers").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!body.numbers.length) {
      status.textContent = "Enter at least one case number.";
      status.className = "status err";
      return;
    }
  }

  pipe.running = true;
  pipe.briefs = [];
  pipe.abort = new AbortController();
  results.innerHTML = "";
  $("#pipeRunBtn").disabled = true;
  $("#pipeStopBtn").classList.remove("hidden");
  status.innerHTML = '<span class="spinner"></span> Checking connection…';
  status.className = "status";
  pipeProgress(true);
  setPipeProgress(0, 1, "starting…");

  try {
    const res = await fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: pipe.abort.signal,
    });

    if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.error === "auth") showAuthBanner(data.message);
      throw new Error(data.message || `Request failed (${res.status})`);
    }

    let total = 0;
    await consumeSse(res.body, {
      found: (d) => {
        total = d.total;
        status.innerHTML = `<span class="spinner"></span> ${d.total} case(s) — reading detail…`;
        if (d.truncated) {
          results.insertAdjacentHTML(
            "beforeend",
            `<p class="hint">More cases matched than the run limit; showing the first ${d.total}.</p>`
          );
        }
      },
      progress: (d) => {
        if (d.phase === "detail") setPipeProgress(d.done, d.total, `reading case ${d.done}/${d.total}`);
        else if (d.phase === "index") setPipeProgress(0, 1, d.message || "indexing…");
        else if (d.phase === "triage") {
          setPipeProgress(d.done, d.total, `triaging ${d.done}/${d.total}${d.caseNumber ? " · " + d.caseNumber : ""}`);
          status.innerHTML = `<span class="spinner"></span> Triaging ${d.done}/${d.total}…`;
        }
      },
      indexed: (d) => {
        $("#pipeIndexInfo").textContent =
          `Index: ${d.files.toLocaleString()} files across ${d.districts.toLocaleString()} districts.`;
      },
      brief: (d) => {
        pipe.briefs.push(d);
        results.insertAdjacentHTML("beforeend", renderBriefCard(d));
      },
      caseError: (d) => {
        results.insertAdjacentHTML(
          "beforeend",
          `<article class="card brief needs-human">
             <header class="brief-head"><h3>${esc(d.caseNumber)}</h3>
             <span class="badge warn">triage failed</span></header>
             <p class="problem">${esc(d.message)}</p>
           </article>`
        );
      },
      error: (d) => {
        if (d.kind === "auth") showAuthBanner(d.message);
        status.textContent = d.message;
        status.className = "status err";
      },
      done: (d) => {
        const needs = pipe.briefs.filter((b) => b.brief.needsHuman).length;
        status.textContent =
          `Done — ${d.total} case(s), ${pipe.briefs.length} triaged, ${needs} need review.`;
        status.className = "status ok";
        setPipeProgress(total, total, "complete");
      },
    });
  } catch (e) {
    if (e.name !== "AbortError") {
      status.textContent = e.message;
      status.className = "status err";
    } else {
      status.textContent = "Stopped.";
      status.className = "status";
    }
  } finally {
    pipe.running = false;
    pipe.abort = null;
    $("#pipeRunBtn").disabled = false;
    $("#pipeStopBtn").classList.add("hidden");
    pipeProgress(false);
  }
}

$("#pipeRunBtn").addEventListener("click", runTriage);
$("#pipeStopBtn").addEventListener("click", () => pipe.abort?.abort());

// ===========================================================================
// Districts — group cases by SIS district code, read a district's history
// ===========================================================================
// Mirrors DISTRICT_FULL_DETAIL_CAP in server.ts — one click on "view full
// details" fetches description + timeline (3 Creatio requests) per ticket.
const DISTRICT_FULL_DETAIL_CAP = 300;

const dx = {
  loaded: false,
  building: false,
  abort: null,
  districts: [],
  noDistrict: null,
  noDistrictLabel: "",
  statuses: [],
  stats: null,
  totalCodes: 0,
  selected: null,   // currently selected code
  rows: [],         // history rows for the selected district
  openCase: null,   // index of the expanded row
  resolving: false,
  lastResult: null, // last /api/districts/history response (for re-render on view toggle)
  fullView: false,  // table vs. "view full details" page
  fullRows: null,   // rows + fetched detail, once loaded, for the full-detail page
  pendingSelect: null, // code to auto-select once the list finishes loading
};

function dxProgressShow(on) { $("#dxProgress")?.classList.toggle("hidden", !on); }
function setDxProgress(pct, label) {
  const fill = $("#dxFill");
  if (fill) {
    if (pct == null) { fill.classList.add("indeterminate"); fill.style.width = "35%"; }
    else { fill.classList.remove("indeterminate"); fill.style.width = pct + "%"; }
  }
  const lab = $("#dxLabel");
  if (lab) lab.textContent = label || "";
}

/** Load the district list (never triggers a build — see /api/districts). */
async function loadDistricts(search = "") {
  const info = $("#dxIndexInfo");
  try {
    const d = await api("/api/districts?limit=300&search=" + encodeURIComponent(search));
    dx.noDistrictLabel = d.noDistrictLabel || "";

    if (!d.built) {
      dx.loaded = false;
      const wanted = dx.pendingSelect;
      dx.pendingSelect = null;
      $("#dxBody").classList.add("hidden");
      $("#dxBuildBtn").classList.remove("hidden");
      $("#dxMoreBtn").classList.add("hidden");
      $("#dxRefreshBtn").classList.add("hidden");
      info.innerHTML =
        (wanted ? `To see the ticket history for <strong>${esc(wanted)}</strong>, build the index first. ` : "") +
        `No district index yet. Building reads case headers from ${esc(d.since.slice(0, 10))} to today ` +
        `— a few minutes the first time. It saves as it goes, so you can stop and resume.`;
      return;
    }

    dx.loaded = true;
    dx.districts = d.districts;
    dx.noDistrict = d.noDistrict;
    dx.statuses = d.statuses || [];
    dx.stats = d.stats;
    dx.totalCodes = d.totalCodes;

    $("#dxBody").classList.remove("hidden");
    $("#dxBuildBtn").classList.add("hidden");
    $("#dxRefreshBtn").classList.remove("hidden");
    $("#dxMoreBtn").classList.toggle("hidden", !!d.stats.complete);

    const s = d.stats;
    const pctAttr = s.cases ? Math.round((s.attributed / s.cases) * 100) : 0;
    info.innerHTML =
      `<strong>${s.cases.toLocaleString()}</strong> cases indexed · ` +
      `<strong>${s.attributed.toLocaleString()}</strong> (${pctAttr}%) attributed to a district · ` +
      `<strong>${s.codes.toLocaleString()}</strong> district codes known` +
      (s.complete
        ? ` · window complete back to ${esc(s.since.slice(0, 10))}`
        : ` · <span class="warn-text">partial — indexed back to ${esc(String(s.backfillCursor || "").slice(0, 10))}</span>`);

    renderDistrictList();
    buildStatusOptions();

    // Arrived here from a district chip — open that district's history now.
    if (dx.pendingSelect) {
      const code = dx.pendingSelect;
      dx.pendingSelect = null;
      await selectDistrict(code);
    }
  } catch (e) {
    info.textContent = e.message;
  }
}

function renderDistrictList() {
  const root = $("#dxList");
  const items = [];

  // The no-district bucket is pinned so unattributed cases never silently vanish.
  if (dx.noDistrict && dx.noDistrict.total) {
    items.push(dxListItem({
      code: dx.noDistrictLabel,
      label: "No district code",
      sub: "higher-ed / unattributed accounts",
      total: dx.noDistrict.total,
      open: dx.noDistrict.open,
      lastActivity: dx.noDistrict.lastActivity,
      bucket: true,
    }));
  }

  for (const d of dx.districts) {
    const first = d.accounts[0]?.name || "(no account on record)";
    const more = d.accounts.length > 1 ? ` +${d.accounts.length - 1} more` : "";
    items.push(dxListItem({
      code: d.code,
      label: d.code,
      sub: esc(first) + more,
      total: d.total,
      open: d.open,
      lastActivity: d.lastActivity,
    }));
  }

  root.innerHTML = items.join("") || '<div class="empty">No districts matched.</div>';
  $("#dxListCount").textContent =
    `Showing ${dx.districts.length.toLocaleString()} of ${dx.totalCodes.toLocaleString()} district codes.`;

  root.querySelectorAll("[data-code]").forEach((el) => {
    el.addEventListener("click", () => selectDistrict(el.dataset.code));
  });
}

function dxListItem(d) {
  const active = dx.selected === d.code ? " active" : "";
  const quiet = d.total === 0 ? " quiet" : "";
  const bucket = d.bucket ? " bucket" : "";
  return `
    <button class="dx-item${active}${quiet}${bucket}" data-code="${esc(d.code)}">
      <span class="dx-item-main">
        <span class="dx-code">${esc(d.label)}</span>
        <span class="dx-acct">${d.sub}</span>
      </span>
      <span class="dx-item-counts">
        <span class="dx-total" title="cases in window">${d.total}</span>
        ${d.open ? `<span class="dx-open" title="open / active">${d.open} open</span>` : ""}
        <span class="dx-last">${d.lastActivity ? esc(d.lastActivity.slice(0, 10)) : "—"}</span>
      </span>
    </button>`;
}

function buildStatusOptions() {
  const sel = $("#dxHistStatus");
  const keep = sel.value;
  sel.innerHTML =
    `<option value="">All statuses</option><option value="__open">Open / active only</option>` +
    dx.statuses.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sel.value = keep;
}

/**
 * Jump to a district from anywhere (a case row, the ticket overlay).
 * The tab switch kicks off its own loadDistricts, so the code is parked in
 * dx.pendingSelect and consumed there — no duplicate fetch. If an index build
 * is running, the selection lands when that build finishes.
 */
function gotoDistrict(code) {
  if (!code) return;
  dx.pendingSelect = code;
  const box = $("#dxSearch");
  if (box) box.value = code; // filter the left list down to it
  switchTab("districts");
}

async function selectDistrict(code) {
  dx.selected = code;
  dx.openCase = null;
  renderDistrictList();
  $("#dxFilters").classList.remove("hidden");
  await loadHistory();
}

async function loadHistory() {
  if (!dx.selected) return;
  const root = $("#dxHistory");
  root.innerHTML = '<div class="empty"><span class="spinner"></span> loading history…</div>';

  const statusSel = $("#dxHistStatus").value;
  const params = new URLSearchParams({ code: dx.selected, limit: "500" });
  const q = $("#dxHistQ").value.trim();
  if (q) params.set("q", q);
  // "__open" is resolved client-side from the full status list, so it tracks
  // whatever statuses the tenant actually uses rather than a hardcoded set.
  if (statusSel && statusSel !== "__open") params.set("statuses", statusSel);

  try {
    const d = await api("/api/districts/history?" + params.toString());
    let rows = d.rows;
    if (statusSel === "__open") rows = rows.filter((r) => isOpenStatusName(r.status));
    dx.rows = rows;
    dx.fullView = false;
    dx.fullRows = null;
    renderHistory(d, rows);
  } catch (e) {
    root.innerHTML = `<div class="empty err">${esc(e.message)}</div>`;
  }
}

// Mirrors the server's isOpenStatus(): terminal statuses are the closed ones,
// everything else counts as open.
const TERMINAL_STATUS_KEYS = new Set([
  "closed", "canceled", "cancelled", "canceledinvalid", "cancellednoworkdone",
  "completed", "workcomplete", "solved", "deployed",
]);
function isOpenStatusName(s) {
  return !TERMINAL_STATUS_KEYS.has(String(s || "").toLowerCase().replace(/[^a-z]/g, ""));
}

function renderHistory(d, rows) {
  dx.lastResult = d;
  const head = $("#dxHistoryHead");
  const isBucket = dx.selected === dx.noDistrictLabel;
  const meta = dx.districts.find((x) => x.code === dx.selected);
  const accounts = meta?.accounts || [];

  head.innerHTML = `
    <div class="dx-hist-title">
      <h3>${isBucket ? "Cases with no district code" : esc(dx.selected)}</h3>
      <span class="hint">${rows.length.toLocaleString()} shown of ${d.total.toLocaleString()} in window${d.truncated ? " (capped)" : ""}</span>
    </div>
    <div class="dx-hist-actions">
      <button id="dxFullBtn" class="secondary" ${rows.length ? "" : "disabled"}>${dx.fullView ? "▤ Back to table" : "▤ View full details (search all tickets)"}</button>
      <span id="dxFullStatus" class="status"></span>
    </div>
    ${accounts.length ? `<p class="dx-accounts">${accounts.map((a) => `<span class="pill">${esc(a.name)}</span>`).join("")}</p>` : ""}
    ${isBucket ? `
      <p class="hint">
        These are mostly higher-ed accounts that genuinely have no SIS district code.
        Scanning the ticket descriptions can recover a code for some of them.
        <button id="dxResolveBtn" class="secondary">Scan descriptions for a code</button>
        <span id="dxResolveStatus" class="status"></span>
      </p>` : ""}`;

  $("#dxFullBtn")?.addEventListener("click", toggleFullView);
  if (isBucket) {
    $("#dxResolveBtn")?.addEventListener("click", resolveDescriptions);
  }

  if (dx.fullView) renderFullDetailView(rows);
  else renderTableView(rows, isBucket);
}

function renderTableView(rows, isBucket) {
  const root = $("#dxHistory");
  if (!rows.length) {
    root.innerHTML = '<div class="empty">No tickets match these filters.</div>';
    return;
  }

  root.innerHTML = `
    <div class="table-wrap">
      <table class="cases dx-table">
        <thead><tr>
          <th>Number</th><th>Subject</th><th>Status</th>
          ${isBucket ? "<th>Account</th>" : "<th>Owner</th>"}
          <th>Created</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr class="case-row">
              <td class="num">${esc(r.number)}</td>
              <td>${esc(r.subject)}${srcBadge(r)}</td>
              <td><span class="st-badge ${stClass(r.status)}">${esc(r.status)}</span></td>
              <td>${esc(isBucket ? r.accountName : r.owner)}</td>
              <td>${esc(fmtDate(r.createdOn))}</td>
              <td class="row-actions">
                <button class="row-view" data-dxview="${i}" title="View ticket — full description, conversation and dates">🎫</button>
                <button class="expand-btn" data-dxexp="${i}">▸ detail</button>
              </td>
            </tr>
            <tr class="detail-row hidden" data-dxdetail="${i}">
              <td colspan="6" class="detail-cell"></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  root.querySelectorAll("[data-dxexp]").forEach((btn) => {
    btn.addEventListener("click", () => toggleHistoryDetail(+btn.dataset.dxexp, btn));
  });

  // Same full-ticket overlay as the Lookup tab. The mapped case object is kept
  // on the row so a reopened ticket reuses its already-fetched detail.
  root.querySelectorAll("[data-dxview]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const r = dx.rows[+btn.dataset.dxview];
      if (!r) return;
      r._case = r._case || {
        Id: r.id, Number: r.number, Subject: r.subject, Status: r.status,
        Owner: r.owner, Account: r.accountName || "", Contact: "", CreatedOn: r.createdOn,
      };
      openTicket(r._case);
    });
  });
}

/** Toggle between the table and the single-page "every ticket's full detail"
 *  view. The latter is what makes Ctrl+F-across-a-district possible. */
function toggleFullView() {
  if (!dx.rows.length) return;
  dx.fullView = !dx.fullView;
  renderHistory(dx.lastResult, dx.rows);
}

function renderFullDetailView(rows) {
  const root = $("#dxHistory");
  if (!rows.length) {
    root.innerHTML = '<div class="empty">No tickets match these filters.</div>';
    return;
  }
  const detailed = dx.fullRows || rows.map((r) => ({ ...r }));
  root.innerHTML = `<div class="dx-full">${detailed.map((r, i) => fullCaseHtml(r, i)).join("")}</div>`;
  if (!dx.fullRows) loadFullDetails(rows, detailed);
}

function fullCaseHtml(r, i) {
  return `
    <article class="dx-full-case">
      <header class="dx-full-head">
        <span class="num">${esc(r.number)}</span>
        <span class="subj">${esc(r.subject)}${srcBadge(r)}</span>
        <span class="st-badge ${stClass(r.status)}">${esc(r.status)}</span>
        <span class="muted">${esc(r.owner)}${r.accountName ? " · " + esc(r.accountName) : ""} · ${esc(fmtDate(r.createdOn))}</span>
      </header>
      <div class="dx-full-body" data-fullbody="${i}">${
        r.detail ? renderDetail(r, ["description", "timeline"]) : '<div class="detail-pending"><span class="spinner"></span> loading…</div>'
      }</div>
    </article>`;
}

/** Fetch description + timeline for every row in the full-detail page,
 *  patching each case's placeholder in place as its detail streams in. */
async function loadFullDetails(rows, detailed) {
  const status = $("#dxFullStatus");
  const targets = rows.slice(0, DISTRICT_FULL_DETAIL_CAP);
  if (status) { status.innerHTML = `<span class="spinner"></span> loading 0/${targets.length}…`; status.className = "status"; }

  try {
    const res = await fetch("/api/districts/full-detail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: targets.map((r) => ({
          id: r.id,
          number: r.number,
          subject: r.subject,
          createdOn: r.createdOn,
          status: r.status,
          owner: r.owner,
          accountName: r.accountName,
        })),
      }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.error === "auth") showAuthBanner(data.message);
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    let done = 0;
    await consumeSse(res.body, {
      case: (d) => {
        if (detailed[d.index]) {
          detailed[d.index].detail = d.detail;
          const cell = document.querySelector(`[data-fullbody="${d.index}"]`);
          if (cell) cell.innerHTML = renderDetail(detailed[d.index], ["description", "timeline"]);
        }
        done++;
        if (status) status.innerHTML = `<span class="spinner"></span> loading ${done}/${targets.length}…`;
      },
      error: (d) => { if (d.kind === "auth") showAuthBanner(d.message); throw new Error(d.message); },
      done: () => {},
    });
    dx.fullRows = detailed;
    if (status) {
      status.textContent = rows.length > targets.length
        ? `Loaded ${targets.length} of ${rows.length} (capped — narrow the filter to see the rest).`
        : `Loaded all ${targets.length} ticket(s). Use Ctrl+F to search.`;
      status.className = "status ok";
    }
  } catch (e) {
    if (status) { status.textContent = e.message; status.className = "status err"; }
  }
}

/** Badge an inferred code so it is never mistaken for the authoritative field. */
function srcBadge(r) {
  if (!r.code || r.source === "account") return "";
  const label = r.source === "subject" ? "code from subject" : "code from description";
  return ` <span class="badge inferred" title="District inferred from ticket text, not from the account record">${esc(r.code)} · ${label}</span>`;
}

/** Expand a row and fetch its description + timeline live, reusing /api/cases. */
async function toggleHistoryDetail(i, btn) {
  const dr = $(`[data-dxdetail="${i}"]`);
  const cell = $(".detail-cell", dr);
  const open = !dr.classList.contains("hidden");
  dr.classList.toggle("hidden", open);
  btn.textContent = open ? "▸ detail" : "▾ detail";
  if (open || cell.dataset.loaded === "1") return;

  const row = dx.rows[i];
  cell.innerHTML = '<div class="detail-pending"><span class="spinner"></span> loading…</div>';

  try {
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "number",
        numbers: [row.number],
        detail: ["summary", "description", "timeline"],
      }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.error === "auth") showAuthBanner(data.message);
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    let found = null;
    await consumeSse(res.body, {
      found: (d) => { found = d.cases[0] || null; },
      case: (d) => {
        if (!found) return;
        found.detail = d.detail;
        cell.innerHTML = renderDetail(found, ["description", "timeline"]);
        cell.dataset.loaded = "1";
      },
      error: (d) => { if (d.kind === "auth") showAuthBanner(d.message); throw new Error(d.message); },
      done: () => {
        if (cell.dataset.loaded !== "1") {
          cell.innerHTML = '<div class="empty">No detail returned for this case.</div>';
        }
      },
    });
  } catch (e) {
    cell.innerHTML = `<div class="empty err">${esc(e.message)}</div>`;
  }
}

/** On-demand description scan for the no-district bucket. */
async function resolveDescriptions() {
  if (dx.resolving) return;
  const btn = $("#dxResolveBtn");
  const status = $("#dxResolveStatus");
  const ids = dx.rows.filter((r) => !r.code).slice(0, 200).map((r) => r.id);
  if (!ids.length) {
    status.textContent = "Nothing left to scan here.";
    return;
  }

  dx.resolving = true;
  btn.disabled = true;
  status.innerHTML = `<span class="spinner"></span> scanning ${ids.length} descriptions…`;
  status.className = "status";

  try {
    const res = await fetch("/api/districts/resolve-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.error === "auth") showAuthBanner(data.message);
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    await consumeSse(res.body, {
      progress: (d) => {
        status.innerHTML = `<span class="spinner"></span> scanned ${d.done}/${d.total} · ${d.promoted} district code(s) found`;
      },
      error: (d) => { if (d.kind === "auth") showAuthBanner(d.message); throw new Error(d.message); },
      done: (d) => {
        status.textContent =
          d.promoted
            ? `Found a district code for ${d.promoted} of ${d.scanned} scanned.`
            : `No district codes found in ${d.scanned} descriptions scanned.`;
        status.className = d.promoted ? "status ok" : "status";
      },
    });
    // Refresh both panes so promoted cases move out of the bucket.
    await loadDistricts($("#dxSearch").value.trim());
    await loadHistory();
  } catch (e) {
    status.textContent = e.message;
    status.className = "status err";
  } finally {
    dx.resolving = false;
    const b = $("#dxResolveBtn");
    if (b) b.disabled = false;
  }
}

/** Build / extend / refresh the index (SSE). */
async function runDistrictBuild({ force = false, maxPages = null } = {}) {
  if (dx.building) return;
  dx.building = true;
  dx.abort = new AbortController();
  const info = $("#dxIndexInfo");
  $("#dxBuildBtn").disabled = true;
  $("#dxMoreBtn").disabled = true;
  $("#dxRefreshBtn").disabled = true;
  $("#dxStopBtn").classList.remove("hidden");
  dxProgressShow(true);
  setDxProgress(null, "starting…");

  const qs = new URLSearchParams();
  if (force) qs.set("refresh", "1");
  if (maxPages) qs.set("maxPages", String(maxPages));

  try {
    const res = await fetch("/api/districts/build?" + qs.toString(), {
      method: "POST",
      signal: dx.abort.signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.error === "auth") showAuthBanner(data.message);
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    await consumeSse(res.body, {
      start: () => setDxProgress(null, "reading district registry…"),
      progress: (d) => {
        const phase =
          d.phase === "registry" ? "district registry"
          : d.phase === "forward" ? "new cases"
          : d.phase === "backfill" ? "history"
          : "saving";
        setDxProgress(null, `${phase} · ${d.fetched.toLocaleString()} rows · ${d.message || ""}`);
      },
      error: (d) => {
        if (d.kind === "auth") showAuthBanner(d.message);
        info.innerHTML = `<span class="warn-text">${esc(d.message)}</span>` +
          (d.partial ? ` — ${d.partial.cases.toLocaleString()} cases already saved; retrying resumes from there.` : "");
      },
      done: () => setDxProgress(100, "index saved"),
    });
  } catch (e) {
    if (e.name !== "AbortError") info.textContent = e.message;
  } finally {
    dx.building = false;
    dx.abort = null;
    $("#dxBuildBtn").disabled = false;
    $("#dxMoreBtn").disabled = false;
    $("#dxRefreshBtn").disabled = false;
    $("#dxStopBtn").classList.add("hidden");
    setTimeout(() => dxProgressShow(false), 800);
    await loadDistricts($("#dxSearch").value.trim());
    if (dx.selected) await loadHistory();
  }
}

// Debounce so typing in the district search doesn't fire a request per keystroke.
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

$("#dxBuildBtn").addEventListener("click", () => runDistrictBuild({}));
$("#dxRefreshBtn").addEventListener("click", () => runDistrictBuild({}));
$("#dxMoreBtn").addEventListener("click", () => runDistrictBuild({ maxPages: 40 }));
$("#dxStopBtn").addEventListener("click", () => dx.abort?.abort());
$("#dxSearch").addEventListener("input", debounce(() => loadDistricts($("#dxSearch").value.trim()), 250));
$("#dxHistQ").addEventListener("input", debounce(loadHistory, 250));
$("#dxHistStatus").addEventListener("change", loadHistory);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    state.meta = await api("/api/meta");
    state.aiAvailable = !!state.meta.aiAvailable;
    state.workAvailable = !!state.meta.workAvailable;
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
