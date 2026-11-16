// app.js - tree, workspace views, inline editing, 2-tap delete
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = n => Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const STATUSES = ["Scheduled", "In Progress", "Completed", "Canceled"];
const TABS = [["visits", "Visits & Plan"], ["estimate", "Estimate"], ["receipts", "Receipts"], ["invoices", "Invoices"]];
const CATEGORIES = ["Construction", "Groceries", "Fuel", "Other"];

let tree = [], filter = "all", sel = null, projectTab = "visits", cur = null;
const expanded = new Set();

// ---------- inline editing (click text -> edit -> auto-save) ----------
function ed(entity, id, field, value, o = {}) {
  const empty = value === null || value === undefined || value === "";
  const shown = empty ? `<span class="ph">${esc(o.ph || "+ add")}</span>` : esc(value);
  const opts = o.opts ? ` data-opts="${esc(o.opts.join("|"))}"` : "";
  return `<span class="ed" data-entity="${entity}" data-id="${id}" data-field="${field}" ` +
         `data-type="${o.type || "text"}" data-value="${esc(value ?? "")}"${opts}>${shown}</span>`;
}

function paint(span, v) {
  span.innerHTML = v === "" || v == null ? `<span class="ph">+ add</span>` : esc(v);
}

function startEdit(span) {
  const { type, value, opts } = span.dataset;
  let input;
  if (type === "select") {
    input = document.createElement("select");
    opts.split("|").forEach(o => {
      const op = document.createElement("option");
      op.value = op.textContent = o;
      if (o === value) op.selected = true;
      input.appendChild(op);
    });
  } else if (type === "textarea") {
    input = document.createElement("textarea");
    input.rows = 3;
    input.value = value;
  } else {
    input = document.createElement("input");
    input.type = type;
    input.value = value;
    if (type === "number") input.step = "0.01";
  }
  input.className = "ed-input";
  span.textContent = "";
  span.appendChild(input);
  input.focus();
  if (type === "text" || type === "number") input.select();

  let done = false;
  const finish = async commit => {
    if (done) return;
    done = true;
    const v = input.value;
    if (!commit || v === value) return paint(span, value);
    try {
      await saveField(span.dataset.entity, span.dataset.id, span.dataset.field, v);
      span.dataset.value = v;
      paint(span, v);
      afterSave(span.dataset.entity, span.dataset.field);
    } catch {
      paint(span, value);
    }
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", ev => {
    if (ev.key === "Escape") finish(false);
    else if (ev.key === "Enter" && type !== "textarea") input.blur();
  });
  if (type === "select") input.addEventListener("change", () => input.blur());

  if (span.dataset.field === "street" && ["clients", "projects"].includes(span.dataset.entity)) {
    attachAddress(input, span, async a => {
      done = true;   // picking a suggestion replaces the typed text; skip the normal blur-save
      try {
        await saveFields(span.dataset.entity, span.dataset.id,
          { street: a.street, city: a.city, state: a.state, zip: a.zip });
        showWorkspace();
      } catch {
        paint(span, value);
      }
    });
  }
}

// Address autocomplete: type in a street field -> suggestions fill street, city, state and ZIP at once.
function attachAddress(input, span, onPick) {
  const box = document.createElement("div");
  box.className = "addr-box";
  span.appendChild(box);
  let timer, seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 4) { box.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const list = await api("GET", `/address-search?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;   // a newer keystroke already started another search
        box.innerHTML = "";
        list.forEach(a => {
          const item = document.createElement("div");
          item.className = "addr-item";
          item.textContent = a.label;
          // mousedown + preventDefault keeps focus in the input, so blur-save doesn't fire first
          item.addEventListener("mousedown", ev => { ev.preventDefault(); onPick(a); });
          box.appendChild(item);
        });
      } catch {
        box.innerHTML = "";
      }
    }, 350);
  });
}

function afterSave(entity, field) {
  if (["clients", "projects", "visits"].includes(entity) && ["name", "visit_date", "status"].includes(field)) loadTree();
  if (entity === "invoices") loadTree();   // debt badges
  if (["name", "time_spent", "status", "labor_amount", "materials_amount",
       "estimate_fixed", "estimate_rate", "estimate_hours"].includes(field)) showWorkspace();
}

// ---------- inline delete: 1st tap arms (3 s), 2nd tap deletes ----------
function arm(btn, onConfirm) {   // 1st tap arms the button for 3 s, 2nd tap runs onConfirm
  if (btn.dataset.armed) {
    clearTimeout(btn._t);
    return onConfirm();
  }
  btn.dataset.armed = "1";
  btn.dataset.label = btn.textContent;
  btn.textContent = "Confirm Delete";
  btn.classList.add("armed");
  btn._t = setTimeout(() => {
    delete btn.dataset.armed;
    btn.textContent = btn.dataset.label;
    btn.classList.remove("armed");
  }, 3000);
}

const handleDelete = btn =>
  arm(btn, () => doDelete(btn.dataset.entity, btn.dataset.id, btn.dataset.backType, btn.dataset.backId));

async function doDelete(entity, id, backType, backId) {
  setSave("saving");
  try {
    await api("DELETE", `/${entity}/${id}`);
    setSave("saved");
  } catch (e) {
    return setSave("error", e.message);
  }
  sel = backType ? { type: backType, id: backId } : (sel && sel.id === id ? null : sel);
  await loadTree();
  await showWorkspace();
}

// ---------- navigation tree ----------
async function loadTree() {
  tree = await api("GET", "/tree");
  renderTree();
}

const badge = debt => debt > 0 ? `<span class="badge">🔴 ${usd(debt)}</span>` : "";
const isSel = (type, id) => sel && sel.type === type && sel.id === id ? "active" : "";
const caret = id => `<span class="caret" data-toggle="${id}">${expanded.has(id) ? "▼" : "▶"}</span>`;

// Date rules: Scheduled / In Progress visits dated today or later are bold;
// 0-3 days away (today included) they also get a blue frame. Completed, Canceled or past dates: neither.
function visitClass(v) {
  let cls = "st-" + v.status.toLowerCase().replace(" ", "-");
  if (v.status === "Scheduled" || v.status === "In Progress") {
    const [y, m, d] = v.visit_date.split("-").map(Number);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(y, m - 1, d) - today) / 86400000);
    if (days >= 0) cls += " vbold" + (days <= 3 ? " vsoon" : "");
  }
  return cls;
}

// Status switch in 1 tap: four buttons instead of a dropdown.
const statusChips = v => `<div class="seg">${STATUSES.map(s =>
  `<button class="seg-btn ${v.status === s ? "active" : ""}" data-status="${s}" data-id="${v.id}">${s}</button>`
).join("")}</div>`;

async function setStatus(id, status) {
  try {
    await saveField("visits", id, "status", status);
    await loadTree();
    await showWorkspace();
  } catch { /* the error is already shown in the save indicator */ }
}

function visitNode(v) {
  return `<div class="node visit ${visitClass(v)} ${isSel("visit", v.id)}" data-type="visit" data-id="${v.id}">` +
         `📅 ${esc(v.visit_date)} · ${esc(v.status)}</div>`;
}

function projectNode(p) {
  const kids = expanded.has(p.id)
    ? `<div class="children">${p.visits.map(visitNode).join("")}` +
      `<button class="add" data-add="visit" data-parent="${p.id}">+ Visit</button></div>`
    : "";
  return `<div class="node project ${isSel("project", p.id)}" data-type="project" data-id="${p.id}">` +
         `${caret(p.id)}<span class="label">📁 ${esc(p.name || "(no name)")}</span>${badge(p.debt)}</div>${kids}`;
}

function renderTree() {
  const list = filter === "unpaid" ? tree.filter(c => c.debt > 0) : tree;
  $("tree").innerHTML = list.length ? list.map(c => {
    const kids = expanded.has(c.id)
      ? `<div class="children">${c.projects.map(projectNode).join("")}` +
        `<button class="add" data-add="project" data-parent="${c.id}">+ Project</button></div>`
      : "";
    return `<div class="node client ${isSel("client", c.id)}" data-type="client" data-id="${c.id}">` +
           `${caret(c.id)}<span class="label">${esc(c.name || "(no name)")}</span>${badge(c.debt)}</div>${kids}`;
  }).join("") : `<div class="empty small">${filter === "unpaid" ? "No unpaid clients 🎉" : "No clients yet."}</div>`;
}

function toggle(id) {
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  renderTree();
}

async function select(type, id) {
  sel = { type, id };
  if (type !== "visit") expanded.add(id);
  renderTree();
  await showWorkspace();
}

async function createChild(kind, parentId) {
  setSave("saving");
  try {
    let row;
    if (kind === "client") row = await api("POST", "/clients", { name: "New Client" });
    else if (kind === "project") row = await api("POST", "/projects", { client_id: parentId, name: "New Project" });
    else row = await api("POST", "/visits", { project_id: parentId });
    setSave("saved");
    if (parentId) expanded.add(parentId);
    await loadTree();
    await select(kind, row.id);
    if (kind !== "visit") document.querySelector(`.ed[data-entity="${kind}s"][data-field="name"]`)?.click(); // jump straight into naming
  } catch (e) {
    setSave("error", e.message);
  }
}

// ---------- estimate + invoices ----------
async function setEstMode(pid, mode) {
  const p = cur.projects.find(x => x.id === pid);
  const fields = { estimate_mode: mode || null };
  if (mode === "hourly" && !Number(p.estimate_rate) && cur.default_rate) fields.estimate_rate = cur.default_rate;
  try { await saveFields("projects", pid, fields); await showWorkspace(); } catch { /* shown in indicator */ }
}

async function fillEstimate(pid) {   // Planned Work -> Estimate
  const text = cur.visits.filter(v => v.project_id === pid && v.status !== "Canceled" && (v.planned_work || "").trim())
    .map(v => v.planned_work.trim()).join("\n");
  if (!text) return alert("No Planned Work found in this project's visits yet.");
  try { await saveField("projects", pid, "estimate_description", text); await showWorkspace(); } catch { /* shown */ }
}

async function setInvStatus(id, status) {   // [ Unpaid ] <-> [ Paid ]
  try { await saveField("invoices", id, "status", status); await loadTree(); await showWorkspace(); } catch { /* shown */ }
}

async function createInvoice(visitId) {
  setSave("saving");
  try {
    await api("POST", `/visits/${visitId}/invoice`);
    setSave("saved");
    await loadTree();
    await showWorkspace();
  } catch (e) {
    setSave("error", e.message);
    alert(e.message);
  }
}

function estimateCard(p, titled) {
  const mode = p.estimate_mode || "", pid = `data-project="${p.id}"`;
  const chips = [["", "No estimate"], ["fixed", "Fixed Price"], ["hourly", "Hourly Rate"]].map(([k, label]) =>
    `<button class="seg-btn ${mode === k ? "active" : ""}" data-est-mode="${k}" ${pid}>${label}</button>`).join("");
  let fields = `<p class="muted">The estimate is optional. Without one, invoices use actual visit hours × your default rate (My Profile).</p>`;
  if (mode === "fixed") {
    fields = `<div class="grid">${row("Fixed Price ($)", ed("projects", p.id, "estimate_fixed", p.estimate_fixed, { type: "number", ph: "0.00" }))}</div>
      <p class="muted">A fixed price is billed once, on the project's first invoice.</p>`;
  } else if (mode === "hourly") {
    const total = Number(p.estimate_rate || 0) * Number(p.estimate_hours || 0);
    fields = `<div class="grid">
      ${row("Rate ($/h)", ed("projects", p.id, "estimate_rate", p.estimate_rate, { type: "number", ph: "0.00" }))}
      ${row("Est. Hours", ed("projects", p.id, "estimate_hours", p.estimate_hours, { type: "number", ph: "0" }))}
      ${row("Estimated Total", `<b>${usd(total)}</b>`)}</div>
      <p class="muted">Invoices bill actual visit hours × this rate.</p>`;
  }
  const desc = mode
    ? `<div class="grid">${row("Estimate Description", ed("projects", p.id, "estimate_description", p.estimate_description, { type: "textarea", ph: "+ describe the work" }), "wide")}</div>
       <button class="btn" data-fill-estimate ${pid}>↻ Fill from Planned Work</button>`
    : "";
  return `<div class="est-block">${titled ? `<h3>${esc(p.name || "(no name)")}</h3>` : ""}<div class="seg">${chips}</div>${fields}${desc}</div>`;
}

const estimatePanel = d => d.projects.length
  ? d.projects.map(p => estimateCard(p, d.projects.length > 1)).join("")
  : `<p class="muted">Add a project first.</p>`;

const invStatus = i => `<div class="seg">${["Unpaid", "Paid"].map(s =>
  `<button class="seg-btn inv-${s.toLowerCase()} ${i.status === s ? "active" : ""}" data-inv-status="${s}" data-id="${i.id}">${s}</button>`
).join("")}</div>`;

// "+ Create Invoice" for project / client pages: the invoice is created from the chosen visit (default: latest).
function invoiceCreator(visits, names = null) {
  const active = visits.filter(v => v.status !== "Canceled");
  if (!active.length) return `<p class="muted">Add a visit first: every invoice is created from a visit.</p>`;
  const latest = active[active.length - 1];   // visits arrive sorted by date
  const opts = active.map(v => `<option value="${v.id}" ${v === latest ? "selected" : ""}>` +
    `${esc((names ? names[v.project_id] + " · " : "") + v.visit_date + " · " + v.status)}</option>`).join("");
  return `<div class="creator">For visit: <select id="invVisitPick">${opts}</select>
    <button class="btn green" data-create-invoice-pick>+ Create Invoice</button></div>`;
}

function invoiceTable(list, visits = [], names = null) {
  if (!list.length) return `<div class="empty small">No invoices yet.</div>`;
  const vdate = id => {
    const v = visits.find(x => x.id === id);
    return v ? (names ? names[v.project_id] + " · " : "") + v.visit_date : "";
  };
  const rows = list.map(i => `<tr>
    <td>${esc(i.invoice_number)}</td>
    <td>${ed("invoices", i.id, "invoice_date", i.invoice_date, { type: "date" })}</td>
    ${visits.length ? `<td>${esc(vdate(i.visit_id))}</td>` : ""}
    <td>${ed("invoices", i.id, "description", i.description, { type: "textarea", ph: "+ add description" })}</td>
    <td>${ed("invoices", i.id, "labor_amount", i.labor_amount, { type: "number" })}</td>
    <td>${ed("invoices", i.id, "materials_amount", i.materials_amount, { type: "number" })}</td>
    <td><b>${usd(i.total)}</b></td>
    <td>${invStatus(i)}${i.status === "Paid" ? `<div class="muted">Paid on ${ed("invoices", i.id, "paid_date", i.paid_date, { type: "date" })}</div>` : ""}</td>
    <td class="act"><a class="btn" href="/api/invoices/${i.id}/pdf" target="_blank">View</a>
      <a class="btn" href="/api/invoices/${i.id}/pdf?download=1">Download PDF</a>
      <button class="del-btn" title="Delete invoice" data-entity="invoices" data-id="${i.id}">🗑</button></td></tr>`).join("");
  return `<table><thead><tr><th>#</th><th>Date</th>${visits.length ? "<th>Visit</th>" : ""}<th>Description</th>
    <th>Labor $</th><th>Materials $</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- photos (visits + receipts share one mechanism) ----------
const photoStrip = (entity, row) => `<div class="photos">${(row.image_urls || []).map(u =>
  `<span class="thumb"><img src="${esc(u)}" alt="photo" data-lightbox="${esc(u)}">` +
  `<button class="photo-del" title="Delete photo" data-photo-del="${esc(u)}" data-entity="${entity}" data-id="${row.id}">✕</button></span>`
).join("")}<button class="btn" title="Add photos" data-photo-add data-entity="${entity}" data-id="${row.id}">📷 +</button></div>`;

function openLightbox(url) {   // full screen in 1 tap; tap again (or Esc) to close
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${esc(url)}" alt="photo">`;
  box.addEventListener("click", () => box.remove());
  document.body.appendChild(box);
}
document.addEventListener("keydown", e => { if (e.key === "Escape") document.querySelector(".lightbox")?.remove(); });

let photoTarget = null;
const photoInput = document.createElement("input");
photoInput.type = "file";
photoInput.accept = "image/*";
photoInput.multiple = true;
photoInput.hidden = true;
document.body.appendChild(photoInput);
photoInput.addEventListener("change", async () => {
  const files = [...photoInput.files];
  photoInput.value = "";
  if (!photoTarget || !files.length) return;
  setSave("saving");
  try {
    for (const f of files) await uploadPhoto(photoTarget.entity, photoTarget.id, await compressImage(f));
    setSave("saved");
    await showWorkspace();
  } catch (e) {
    setSave("error", e.message);
  }
});

async function removePhoto(entity, id, url) {   // the backend also deletes the file from Storage
  const row = (entity === "visits" ? cur.visits : cur.receipts).find(r => r.id === id);
  if (!row) return;
  try {
    await saveField(entity, id, "image_urls", (row.image_urls || []).filter(u => u !== url));
    await showWorkspace();
  } catch { /* shown in indicator */ }
}

// ---------- receipts ----------
async function createReceipt(visitId) {
  const v = cur.visits.find(x => x.id === visitId);
  if (!v) return;
  setSave("saving");
  try {
    await api("POST", "/receipts", { project_id: v.project_id, visit_id: v.id });
    setSave("saved");
    await showWorkspace();
  } catch (e) {
    setSave("error", e.message);
  }
}

async function toggleBillable(id, wasOn) {   // [ + Add to Invoice ] in 1 tap
  try { await saveField("receipts", id, "billable", !wasOn); await showWorkspace(); } catch { /* shown */ }
}

const billToggle = (r, invoices) => {
  if (r.invoice_id) {   // already billed: locked so it can't be invoiced twice
    const inv = invoices.find(i => i.id === r.invoice_id);
    return `<span class="inv-lock">Invoiced ✓ ${esc(inv ? inv.invoice_number : "")}</span>`;
  }
  return `<button class="bill-toggle ${r.billable ? "on" : ""}" data-rec-billable="${r.id}" data-on="${r.billable ? 1 : 0}">` +
         `${r.billable ? "✓ In Invoice" : "+ Add to Invoice"}</button>`;
};

function receiptsTable(d, names) {
  if (!d.receipts.length) return `<div class="empty small">No receipts yet.</div>`;
  const vlabel = id => {
    const v = d.visits.find(x => x.id === id);
    return v ? (names ? names[v.project_id] + " · " : "") + v.visit_date : "—";
  };
  const rows = d.receipts.map(r => `<tr>
    <td>${esc(vlabel(r.visit_id))}</td>
    <td>${ed("receipts", r.id, "receipt_date", r.receipt_date, { type: "date" })}</td>
    <td>${ed("receipts", r.id, "store", r.store, { ph: "+ store" })}</td>
    <td>${ed("receipts", r.id, "category", r.category, { type: "select", opts: ["", ...CATEGORIES], ph: "+ category" })}</td>
    <td>${ed("receipts", r.id, "amount", r.amount, { type: "number", ph: "0.00" })}</td>
    <td>${billToggle(r, d.invoices)}</td>
    <td>${photoStrip("receipts", r)}</td>
    <td class="act"><button class="del-btn" title="Delete receipt" data-entity="receipts" data-id="${r.id}">🗑</button></td></tr>`).join("");
  return `<table><thead><tr><th>Visit</th><th>Date</th><th>Store</th><th>Category</th><th>Amount $</th>
    <th>Invoice</th><th>Photo</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function receiptCreator(visits, names = null) {
  if (!visits.length) return `<p class="muted">Add a visit first: every receipt belongs to a visit.</p>`;
  const latest = visits[visits.length - 1];
  const opts = visits.map(v => `<option value="${v.id}" ${v === latest ? "selected" : ""}>` +
    `${esc((names ? names[v.project_id] + " · " : "") + v.visit_date + " · " + v.status)}</option>`).join("");
  return `<div class="creator">For visit: <select id="recVisitPick">${opts}</select>
    <button class="btn green" data-create-receipt-pick>+ Receipt</button></div>`;
}

// ---------- workspace views ----------
const row = (label, html, cls = "") => `<div class="field ${cls}"><label>${label}</label><div>${html}</div></div>`;

function viewProfile(p) {
  $("crumbs").textContent = "My Profile";
  return `<h2>My Profile</h2><div class="grid">
    ${row("Company / LLC Name", ed("profile", 1, "company_name", p.company_name))}
    ${row("Phone", ed("profile", 1, "phone", p.phone))}
    ${row("Email", ed("profile", 1, "email", p.email))}
    ${row("Business Address", ed("profile", 1, "business_address", p.business_address))}
    ${row("Payment Details", ed("profile", 1, "payment_details", p.payment_details, { type: "textarea" }))}
    ${row("Default Hourly Rate ($)", ed("profile", 1, "default_hourly_rate", p.default_hourly_rate, { type: "number", ph: "0" }))}
  </div><p class="muted">Used in the header of every Estimate and Invoice.</p>`;
}

// One visits table for every level. names = {projectId: name} adds a Project column (client level).
function visitsTable(visits, o = {}) {
  const rows = visits.map(v => `<tr class="${visitClass(v)}">
      ${o.names ? `<td><button class="link" data-open="project" data-id="${v.project_id}">${esc(o.names[v.project_id])}</button></td>` : ""}
      <td>${ed("visits", v.id, "visit_date", v.visit_date, { type: "date" })}</td>
      <td>${statusChips(v)}</td>
      <td>${ed("visits", v.id, "time_spent", v.time_spent, { type: "number", ph: "0" })}</td>
      <td>${ed("visits", v.id, "planned_work", v.planned_work, { type: "textarea", ph: "+ add plan" })}</td>
      <td>${photoStrip("visits", v)}</td>
      <td class="act">${o.single ? "" : `<button class="btn" data-open="visit" data-id="${v.id}">Open</button>
        <button class="del-btn" title="Delete visit" data-entity="visits" data-id="${v.id}">🗑</button>`}</td></tr>`).join("");
  const add = o.addTo
    ? `<button class="btn green" data-add="visit" data-parent="${o.addTo}">+ Visit</button>`
    : (o.projectOptions
        ? `<select id="addVisitProject">${o.projectOptions}</select> <button class="btn green" data-add-visit-pick>+ Visit</button>`
        : `<span class="muted">Add a project first.</span>`);
  return `<table><thead><tr>${o.names ? "<th>Project</th>" : ""}<th>Date</th><th>Status</th><th>Hours</th><th>Planned Work</th><th>Photos</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="${o.names ? 7 : 6}" class="muted">No visits yet.</td></tr>`}</tbody></table>${add}`;
}

// Collapsible info cards: open at their own level, collapsed (one-line summary) deeper down.
function clientCard(c, open) {
  const f = (label, field, o) => row(label, ed("clients", c.id, field, c[field], o));
  const addr = ["street", "city", "state", "zip"].map(k => ed("clients", c.id, k, c[k], { ph: "+ " + k })).join(", ");
  const brief = [c.phone, c.email].filter(Boolean).join(" · ") || "no contact info";
  return `<details class="card" ${open ? "open" : ""}><summary><b>Client</b> · ${esc(c.name)} · ${esc(brief)}</summary>
    <div class="grid">${f("Name", "name", { ph: "+ add name" })}${f("Phone", "phone")}${f("Email", "email")}
    ${row("Address", addr, "wide")}${f("Notes", "notes", { type: "textarea" })}</div></details>`;
}

function projectCard(p, open) {
  const addr = ["street", "city", "state", "zip"].map(k => ed("projects", p.id, k, p[k], { ph: "+ " + k })).join(", ");
  const loc = [p.street, p.city].filter(Boolean).join(", ");
  return `<details class="card" ${open ? "open" : ""}><summary><b>Project</b> · ${esc(p.name)}${loc ? " · " + esc(loc) : ""}</summary>
    <div class="grid">${row("Project Name", ed("projects", p.id, "name", p.name, { ph: "+ add name" }))}
    ${row("Job-site Address", addr, "wide")}</div></details>`;
}

// THE workspace: identical layout at client, project and visit level. Only the scope of the data changes:
// client = all its visits | project = that project's visits | visit = just that visit.
function viewScope(d) {
  const level = sel.type, c = d.client, multi = level === "client";
  const p = multi ? null : d.projects[0];
  const v = level === "visit" ? d.visits[0] : null;
  const names = Object.fromEntries(d.projects.map(x => [x.id, x.name]));
  const nm = multi ? names : null;
  const link = (type, id, text) => `<button class="link" data-open="${type}" data-id="${id}">${esc(text || "(no name)")}</button>`;
  $("crumbs").textContent = [c.name, p && p.name, v && v.visit_date].filter(Boolean).join(" / ");

  const title = multi ? esc(c.name || "(no name)")
    : level === "project" ? `${link("client", c.id, c.name)} / ${esc(p.name || "(no name)")}`
    : `${link("client", c.id, c.name)} / ${link("project", p.id, p.name)} / Visit ${esc(v.visit_date)}`;
  const summary = `⏱ Total hours: <b>${d.total_hours}</b> · ${d.visits.length} visit(s)` + (multi
    ? ` · ${d.projects.length} project(s) · <button class="btn green" data-add="project" data-parent="${c.id}">+ Project</button>` : "");

  const projectOptions = d.projects.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  const tabs = TABS.map(([k, label]) =>
    `<button class="tab ${projectTab === k ? "active" : ""}" data-tab="${k}">${label}</button>`).join("");
  const body = projectTab === "visits"
      ? visitsTable(d.visits, { names: nm, addTo: multi ? null : p.id, projectOptions: multi ? projectOptions : null, single: !!v })
    : projectTab === "estimate" ? estimatePanel(d)
    : projectTab === "invoices" ? invoiceTable(d.invoices, d.visits, nm) + invoiceCreator(d.visits, nm)
    : receiptsTable(d, nm) + receiptCreator(d.visits, nm);

  const target = multi ? { entity: "clients", id: c.id, label: "Client", back: null }
    : level === "project" ? { entity: "projects", id: p.id, label: "Project", back: ["client", c.id] }
    : { entity: "visits", id: v.id, label: "Visit", back: ["project", p.id] };
  const back = target.back ? ` data-back-type="${target.back[0]}" data-back-id="${target.back[1]}"` : "";

  return `<h2>${title} ${badge(d.debt)}</h2><div class="muted">${summary}</div>
    ${clientCard(c, multi)}${p ? projectCard(p, level === "project") : ""}
    <div class="tabs">${tabs}</div>${body}
    <div class="actions"><button class="del-btn" data-entity="${target.entity}" data-id="${target.id}"${back}>🗑 Delete ${target.label}</button></div>`;
}

async function showWorkspace() {
  const ws = $("workspace");
  try {
    if (!sel) {
      $("crumbs").textContent = "";
      ws.innerHTML = `<div class="empty">Select or create a client on the left.</div>`;
    } else if (sel.type === "profile") ws.innerHTML = viewProfile(await api("GET", "/profile"));
    else if (sel.type === "report") {
      $("crumbs").textContent = "Income & Expense Report";
      ws.innerHTML = `<div class="empty">Income &amp; Expense Report — coming in Step 7.</div>`;
    } else {
      cur = await api("GET", `/scope/${sel.type}/${sel.id}`);
      ws.innerHTML = viewScope(cur);
    }
  } catch (e) {
    ws.innerHTML = `<div class="empty error">${esc(e.message)}</div>`;
  }
}

// ---------- one delegated click handler for the whole page ----------
document.addEventListener("click", e => {
  const t = e.target;
  let el;
  if ((el = t.closest(".ed"))) { if (!el.querySelector(".ed-input")) startEdit(el); return; }
  if ((el = t.closest("[data-status]"))) return setStatus(el.dataset.id, el.dataset.status);
  if ((el = t.closest("[data-lightbox]"))) return openLightbox(el.dataset.lightbox);
  if ((el = t.closest("[data-photo-del]"))) return arm(el, () => removePhoto(el.dataset.entity, el.dataset.id, el.dataset.photoDel));
  if ((el = t.closest("[data-photo-add]"))) { photoTarget = { entity: el.dataset.entity, id: el.dataset.id }; return photoInput.click(); }
  if ((el = t.closest("[data-rec-billable]"))) return toggleBillable(el.dataset.recBillable, el.dataset.on === "1");
  if (t.closest("[data-create-receipt-pick]")) return createReceipt($("recVisitPick").value);
  if ((el = t.closest("[data-inv-status]"))) return setInvStatus(el.dataset.id, el.dataset.invStatus);
  if ((el = t.closest("[data-est-mode]"))) return setEstMode(el.dataset.project, el.dataset.estMode);
  if ((el = t.closest("[data-fill-estimate]"))) return fillEstimate(el.dataset.project);
  if (t.closest("[data-create-invoice-pick]")) return createInvoice($("invVisitPick").value);
  if (t.closest("[data-add-visit-pick]")) return createChild("visit", $("addVisitProject").value);
  if ((el = t.closest(".del-btn"))) return handleDelete(el);
  if ((el = t.closest("[data-add]"))) return createChild(el.dataset.add, el.dataset.parent);
  if ((el = t.closest("[data-open]"))) return select(el.dataset.open, el.dataset.id);
  if ((el = t.closest("[data-toggle]"))) return toggle(el.dataset.toggle);
  if ((el = t.closest("[data-tab]"))) { projectTab = el.dataset.tab; return showWorkspace(); }
  if ((el = t.closest("[data-filter]"))) {
    filter = el.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(b => b.classList.toggle("active", b === el));
    return renderTree();
  }
  if ((el = t.closest("[data-view]"))) { sel = { type: el.dataset.view }; renderTree(); return showWorkspace(); }
  if ((el = t.closest(".node"))) return select(el.dataset.type, el.dataset.id);
});

loadTree().then(showWorkspace).catch(e => {
  $("tree").innerHTML = `<div class="empty small error">${esc(e.message)}</div>`;
});
