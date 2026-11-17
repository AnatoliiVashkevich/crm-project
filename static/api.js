// ==========================================================================
// api.js — everything that talks to the server, plus photo compression.
//
//   api()               one fetch wrapper for every /api/... call (throws readable errors)
//   saveFields()        auto-save: PATCH only the changed fields + "Saving... -> Saved ✓"
//   compressImage()     photos are shrunk in the browser BEFORE upload (1920px, WebP/JPEG 80–85%, <= 500 KB)
//   uploadPhoto()       sends one compressed photo to Supabase Storage via the server
//   getSession() ...    the login tokens; authedFetch() adds them to every request and renews them
//   pack/unpackTextAndMeta()  hidden extra fields stored inside existing text columns (see below)
//   normalize*()        turn raw database rows into the objects the screens use
//   fetchFullCRMData()  loads everything you may see in ONE request (GET /api/bootstrap)
//
// Loaded before app.js (see index.html), so app.js can use all of these.
// ==========================================================================

const API_BASE = "/api";
let saveTimer;

// ---------- "Saving..." -> "Saved ✓" indicator in the top bar ----------
function setSave(state, msg) {
  const el = document.getElementById("saveState");
  if (!el) return;
  clearTimeout(saveTimer);
  if (state === "saving") {
    el.textContent = "Saving...";
    el.className = "save saving";
  } else if (state === "saved") {
    el.textContent = "Saved ✓";
    el.className = "save saved";
    saveTimer = setTimeout(() => {   // fade away after 2 s
      el.textContent = "";
      el.className = "save";
    }, 2200);
  } else {
    el.textContent = "Error: " + (msg || "Failed");
    el.className = "save error";
  }
}

// ==========================================================================
// Login session
// After signing in the server gives two tokens; we keep them in this browser:
//   access_token  -> sent with every request ("Authorization: Bearer ..."), valid about 1 hour
//   refresh_token -> swapped for a new access token when the old one expires (no new sign-in needed)
// ==========================================================================
const SESSION_KEY = "hcrm_session";

function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function setSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }

let refreshing = null;   // one refresh at a time, even if several requests expire together
async function refreshSession() {
  const s = getSession();
  if (!s?.refresh_token) return false;
  refreshing ||= fetch(API_BASE + "/auth/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  }).then(async r => {
    if (!r.ok) return false;
    setSession(await r.json());
    return true;
  }).catch(() => false).finally(() => { refreshing = null; });
  return refreshing;
}

// fetch() + the login token. On "401 expired" it renews the session once and retries;
// if that fails too, the sign-in screen is shown (showSignIn lives in app.js).
async function authedFetch(path, options = {}, retry = true) {
  const s = getSession();
  const headers = { ...(options.headers || {}), ...(s ? { Authorization: `Bearer ${s.access_token}` } : {}) };
  const res = await fetch(API_BASE + path, { ...options, headers });
  if (res.status === 401 && retry && await refreshSession()) return authedFetch(path, options, false);
  if (res.status === 401 && !path.startsWith("/auth/")) {
    clearSession();
    if (typeof showSignIn === "function") showSignIn("Please sign in again.");
  }
  return res;
}

// Turn a failed response into a readable Error ({"detail": "..."} from the server)
async function failure(res) {
  const data = await res.json().catch(() => ({}));
  return new Error(typeof data.detail === "string" ? data.detail : `Request failed (${res.status})`);
}

// ---------- One wrapper for all JSON calls ----------
async function api(method, path, body) {
  const res = await authedFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return res.json().catch(() => ({}));
}

// A file from the server (PDFs). Links can't carry the login token, so we download with fetch.
async function apiBlob(path) {
  const res = await authedFetch(path);
  if (!res.ok) throw await failure(res);
  return res.blob();
}

// ---------- Auto-save: PATCH only the fields that changed ----------
async function saveFields(entity, id, fields) {
  setSave("saving");
  try {
    const path = entity === "profile" ? "/profile" : `/${entity}/${id}`;
    const row = await api("PATCH", path, fields);
    setSave("saved");
    return row;
  } catch (e) {
    setSave("error", e.message);
    throw e;
  }
}

const saveField = (entity, id, field, value) => saveFields(entity, id, { [field]: value });

// ==========================================================================
// Photo compression (runs in the browser, before anything goes over the network)
//   * long side at most 1920px (Full HD)
//   * WebP (or JPEG on old Safari) at quality 85%, then 80%
//   * only if still > 500 KB, the picture is made smaller step by step
// Result: usually 250–450 KB with small receipt text still readable.
// ==========================================================================
const MAX_PHOTO_KB = 500;
let webpSupported = null;   // checked once, on the first photo
const canvasToBlob = (canvas, type, q) => new Promise(res => canvas.toBlob(res, type, q));

async function compressImage(file) {
  if (webpSupported === null) {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    webpSupported = (await canvasToBlob(probe, "image/webp", 0.8))?.type === "image/webp";
  }
  const type = webpSupported ? "image/webp" : "image/jpeg";

  // decode the photo (respecting the phone's rotation)
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      bmp = await createImageBitmap(file);
    } catch {
      throw new Error("This photo format is not supported.");
    }
  }

  let scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
  let blob;
  const fits = b => b && b.size <= MAX_PHOTO_KB * 1024;
  for (let i = 0; i < 6 && !fits(blob); i++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";   // transparent PNG screenshots would turn black in JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.8]) {
      blob = await canvasToBlob(canvas, type, q);
      if (fits(blob)) break;
    }
    scale *= 0.85;   // still too big: 15% smaller and try again
  }
  if (bmp.close) bmp.close();
  if (!blob) throw new Error("Could not process this photo.");
  return blob;
}

// Upload one compressed photo. entity = "visits" | "receipts". Returns the row's full list of photo links.
async function uploadPhoto(entity, id, blob) {
  const fd = new FormData();
  fd.append("kind", entity);
  fd.append("row_id", id);
  fd.append("file", blob, "photo." + (blob.type === "image/webp" ? "webp" : "jpg"));
  const res = await authedFetch("/photos", { method: "POST", body: fd });
  if (!res.ok) throw await failure(res);
  return (await res.json()).image_urls;
}

// ==========================================================================
// Hidden extra fields ("meta")
// The interface has more fields than the database (task title, priority, assignee, approval status,
// comments...). They are kept as JSON at the end of an existing text column, after a marker:
//     "Fix kitchen sink\n<!--HCRM:{"priority":"High"}-->"
// The server (billing.strip_meta) removes the tail before anything goes on a PDF.
// Where each entity keeps its meta:
//     clients.notes · projects.estimate_description · visits.planned_work · receipts.store · invoices.description
// ==========================================================================
const META_DELIM = "\n<!--HCRM:";
const META_END = "-->";

function unpackTextAndMeta(rawText) {
  const str = String(rawText ?? "");
  const idx = str.indexOf(META_DELIM);
  if (idx === -1) return { text: str.trim(), meta: {} };
  const text = str.slice(0, idx).trim();
  const jsonPart = str.slice(idx + META_DELIM.length);
  const endIdx = jsonPart.lastIndexOf(META_END);
  const rawJson = endIdx !== -1 ? jsonPart.slice(0, endIdx) : jsonPart;
  try {
    return { text, meta: JSON.parse(rawJson) || {} };
  } catch {
    return { text, meta: {} };   // broken tail: keep the human text, drop the garbage
  }
}

function packTextAndMeta(cleanText, metaObj) {
  const text = String(cleanText ?? "").trim();
  const compactMeta = {};
  Object.entries(metaObj || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") compactMeta[k] = v;   // empty values are not stored
  });
  if (!Object.keys(compactMeta).length) return text;
  return `${text}${META_DELIM}${JSON.stringify(compactMeta)}${META_END}`;
}

// ==========================================================================
// Normalizers: raw database row -> object used by the screens (adds names, meta fields, flags)
// ==========================================================================

// Today's date as YYYY-MM-DD in the browser's local time (toISOString() would give UTC = tomorrow at night)
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const joinAddress = x => [x?.street, x?.city, x?.state, x?.zip].filter(Boolean).join(", ");

function normalizeClient(c, debt = 0) {
  const { text, meta } = unpackTextAndMeta(c.notes);
  const parts = (c.name || "").trim().split(/\s+/);
  return {
    ...c,
    debt: Number(debt || 0),                                   // sum of Unpaid invoices
    first_name: meta.first_name ?? (parts[0] || ""),
    last_name: meta.last_name ?? (parts.slice(1).join(" ") || ""),
    company_name: meta.company_name || "",
    clean_notes: text,
    approval_status: meta.approval_status || "Approved",      // Approved | PendingApproval | Rejected
    rejection_reason: meta.rejection_reason || "",
    created_by_role: meta.created_by_role || "Owner",
    _meta: meta,
  };
}

function normalizeProject(p, client, debt = 0) {
  const { text, meta } = unpackTextAndMeta(p.estimate_description);
  return {
    ...p,
    client_name: client?.name || "Unknown Client",
    debt: Number(debt || 0),
    clean_description: text,
    project_status: meta.project_status || "Active",          // Active | Pending | Completed
    approval_status: meta.approval_status || "Approved",
    rejection_reason: meta.rejection_reason || "",
    created_by_role: meta.created_by_role || "Owner",
    _meta: meta,
  };
}

// A visit is shown as a "Task" in the interface. teamById = {member id: member} for the assignee's name.
function normalizeTask(v, project, client, teamById = {}) {
  const { text, meta } = unpackTextAndMeta(v.planned_work);
  const lines = text.split("\n");   // without meta: first line = title, the rest = description

  // days until the visit (0 = today, negative = past), counted in local calendar days
  let daysDiff = 0;
  if (v.visit_date) {
    const [y, m, d] = v.visit_date.split("-").map(Number);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    daysDiff = Math.round((new Date(y, m - 1, d) - today) / 86400000);
  }
  const open = v.status === "Scheduled" || v.status === "In Progress";

  return {
    ...v,
    project_name: project?.name || "Unassigned Project",
    project_address: joinAddress(project),
    client_id: client?.id,
    client_name: client?.name || "Unknown Client",
    title: meta.title || lines[0]?.trim() || "Untitled visit",
    description: meta.description !== undefined ? meta.description : lines.slice(1).join("\n").trim(),
    assigned_to: v.assigned_to || "",                         // a team member id (column), or "" = nobody
    assigned_name: teamById[v.assigned_to]?.name || "Unassigned",
    scheduled_time: meta.scheduled_time || "09:00 AM",
    priority: meta.priority || "Medium",                      // Low | Medium | High
    planned_hours: Number(meta.planned_hours ?? 0),
    actual_hours: Number(v.time_spent ?? 0),
    variance_reason: meta.variance_reason || "",
    timer_start: Number(meta.timer_start) || 0,               // running timer: start time in ms (0 = stopped)
    timer_by: meta.timer_by || "",                            // who started it
    comments: Array.isArray(meta.comments) ? meta.comments : [],
    photo_categories: meta.photo_categories || {},            // { [photo url]: "Before" | "During" | "After" }
    approval_status: meta.approval_status || "Approved",
    rejection_reason: meta.rejection_reason || "",
    created_by_role: meta.created_by_role || "Owner",
    days_diff: daysDiff,
    is_overdue: open && Boolean(v.visit_date) && daysDiff < 0,
    is_upcoming: open && daysDiff >= 0,                       // spec: bold until the visit date
    is_soon: open && daysDiff >= 0 && daysDiff <= 3,          // spec: + blue frame when 3 days or less
    _meta: meta,
  };
}

// Estimates and invoices are one kind of document (kind = "estimate" | "invoice") with line items.
function normalizeInvoice(inv, project, client) {
  const { text, meta } = unpackTextAndMeta(inv.description);
  return {
    ...inv,
    kind: inv.kind || "invoice",
    is_estimate: inv.kind === "estimate",
    line_items: Array.isArray(inv.line_items) ? inv.line_items : [],
    visit_ids: inv.visit_ids?.length ? inv.visit_ids : (inv.visit_id ? [inv.visit_id] : []),   // tasks it bills
    project_name: project?.name || "Project",
    client_name: client?.name || "Client",
    clean_description: text,                                  // notes printed on the PDF
    approval_status: meta.approval_status || "Approved",      // Manager-created invoices wait for the Owner
    rejection_reason: meta.rejection_reason || "",
    created_by_role: meta.created_by_role || "Owner",
    sent_to_client: Boolean(meta.sent_to_client),
    _meta: meta,
  };
}

function normalizeReceipt(r, project, client, visit, threshold = 150, teamById = {}) {
  const { text, meta } = unpackTextAndMeta(r.store);
  return {
    ...r,
    store_clean: text,
    project_name: project?.name || "Project",
    client_id: client?.id,
    client_name: client?.name || "Client",
    task_title: visit?.title || "",
    visit_date: visit?.visit_date || r.receipt_date || "",
    submitted_by: teamById[r.created_by]?.name || meta.submitted_by || "",
    // older receipts without meta: anything above the threshold still asks for approval
    approval_status: meta.approval_status || (Number(r.amount || 0) > threshold ? "PendingApproval" : "Approved"),
    rejection_reason: meta.rejection_reason || "",
    _meta: meta,
  };
}

// ==========================================================================
// Load everything in ONE request and link rows together (client -> project -> visit -> invoice/receipt)
// ==========================================================================
async function fetchFullCRMData() {
  const data = await api("GET", "/bootstrap");
  const byId = list => Object.fromEntries(list.map(x => [x.id, x]));
  const teamById = byId(data.team);
  const threshold = Number(data.profile.expense_threshold ?? 150);

  const clients = data.clients.map(c => normalizeClient(c, data.client_debt[c.id]));
  const clientById = byId(clients);

  const projects = data.projects.map(p => normalizeProject(p, clientById[p.client_id], data.project_debt[p.id]));
  const projectById = byId(projects);

  const tasks = data.visits.map(v => {
    const p = projectById[v.project_id];
    return normalizeTask(v, p, clientById[p?.client_id], teamById);
  });
  const visitById = byId(tasks);

  const invoices = data.invoices.map(i => normalizeInvoice(i, projectById[i.project_id], clientById[i.client_id]));

  const receipts = data.receipts.map(r => {
    const p = projectById[r.project_id];
    return normalizeReceipt(r, p, clientById[p?.client_id], visitById[r.visit_id], threshold, teamById);
  });

  // total working hours per client (Canceled visits don't count)
  for (const c of clients) {
    c.total_hours = +tasks.filter(t => sameId(t.client_id, c.id) && t.status !== "Canceled")
      .reduce((s, t) => s + t.actual_hours, 0).toFixed(2);
  }

  return { me: data.me, team: data.team, profile: data.profile, clients, projects, tasks, invoices, receipts };
}
