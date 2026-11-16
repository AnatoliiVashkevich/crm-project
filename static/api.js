// ==========================================================================
// api.js — Backend API Client, Photo Compression & Transparent Data Adapter
// ==========================================================================

const API_BASE = "/api";
let saveTimer;

// ---------- Save Status Indicator ----------
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
    saveTimer = setTimeout(() => {
      el.textContent = "";
      el.className = "save";
    }, 2200);
  } else {
    el.textContent = "Error: " + (msg || "Failed");
    el.className = "save error";
  }
}

// ---------- Core Fetch Wrapper ----------
async function api(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : `Request failed (${res.status})`);
  }
  return data;
}

// ---------- Auto-Save Helpers (Single or Multi-Field PATCH) ----------
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

// ---------- Browser-Side Photo Compression (WebP / JPEG <= 500 KB) ----------
const MAX_PHOTO_KB = 500;
let webpSupported = null;
const canvasToBlob = (canvas, type, q) => new Promise(res => canvas.toBlob(res, type, q));

async function compressImage(file) {
  if (webpSupported === null) {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    webpSupported = (await canvasToBlob(probe, "image/webp", 0.8))?.type === "image/webp";
  }
  const type = webpSupported ? "image/webp" : "image/jpeg";
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
  for (let i = 0; i < 6; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    blob = await canvasToBlob(canvas, type, 0.82);
    if (blob && blob.size <= MAX_PHOTO_KB * 1024) break;
    scale *= 0.85;
  }
  if (bmp.close) bmp.close();
  if (!blob) throw new Error("Could not process this photo.");
  return blob;
}

async function uploadPhoto(entity, id, blob) {
  const fd = new FormData();
  fd.append("kind", entity);
  fd.append("row_id", id);
  fd.append("file", blob, "photo." + (blob.type === "image/webp" ? "webp" : "jpg"));
  const res = await fetch(API_BASE + "/photos", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Upload failed");
  return data.image_urls;
}

// ==========================================================================
// Transparent Metadata Adapter
// Preserves extended CRM properties inside existing backend text columns so
// zero backend schema changes are required while keeping human text clean.
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
    return { text: str.trim(), meta: {} };
  }
}

function packTextAndMeta(cleanText, metaObj) {
  const text = String(cleanText ?? "").trim();
  const compactMeta = {};
  Object.entries(metaObj || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") compactMeta[k] = v;
  });
  if (!Object.keys(compactMeta).length) return text;
  return `${text}${META_DELIM}${JSON.stringify(compactMeta)}${META_END}`;
}

// ---------- Entity Normalization Helpers ----------

function normalizeClient(c, debt = 0) {
  const { text, meta } = unpackTextAndMeta(c.notes);
  const rawName = (c.name || "").trim();
  const parts = rawName.split(/\s+/);
  const firstName = meta.first_name ?? (parts[0] || "");
  const lastName = meta.last_name ?? (parts.slice(1).join(" ") || "");
  return {
    ...c,
    debt: Number(debt ?? c.debt ?? 0),
    first_name: firstName,
    last_name: lastName,
    company_name: meta.company_name || "",
    clean_notes: text,
    approval_status: meta.approval_status || "Approved", // Approved | PendingApproval | Rejected
    rejection_reason: meta.rejection_reason || "",
    created_by_role: meta.created_by_role || "Owner",
    _meta: meta,
  };
}

function normalizeProject(p, client, debt = 0) {
  const { text, meta } = unpackTextAndMeta(p.estimate_description);
  return {
    ...p,
    client_id: p.client_id ?? client?.id,
    client_name: client?.name || "Unknown Client",
    debt: Number(debt ?? p.debt ?? 0),
    clean_description: text,
    project_status: meta.project_status || "Active", // Active | Pending | Completed | Archived
    approval_status: meta.approval_status || "Approved",
    rejection_reason: meta.rejection_reason || "",
    created_by_role: meta.created_by_role || "Owner",
    documents: Array.isArray(meta.documents) ? meta.documents : [],
    _meta: meta,
  };
}

function normalizeTask(v, project, client) {
  const { text, meta } = unpackTextAndMeta(v.planned_work);
  const lines = text.split("\n");
  const defaultTitle = lines[0]?.trim() || `Task #${v.id}`;
  const defaultDesc = lines.slice(1).join("\n").trim();

  // Check if overdue: visit_date < today AND status not in [Completed, Canceled]
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let isOverdue = false;
  let daysDiff = 0;
  if (v.visit_date) {
    const [y, m, d] = v.visit_date.split("-").map(Number);
    const vDate = new Date(y, m - 1, d);
    daysDiff = Math.round((vDate - today) / 86400000);
    if (daysDiff < 0 && !["Completed", "Canceled"].includes(v.status)) {
      isOverdue = true;
    }
  }

  return {
    ...v,
    project_id: v.project_id ?? project?.id,
    project_name: project?.name || "Unassigned Project",
    project_address: [project?.street, project?.city, project?.state, project?.zip].filter(Boolean).join(", "),
    client_id: client?.id,
    client_name: client?.name || "Unknown Client",
    title: meta.title || defaultTitle,
    description: meta.description !== undefined ? meta.description : defaultDesc,
    assigned_to: meta.assigned_to || "emp-1",
    assigned_name: meta.assigned_name || "Alex Rivera",
    scheduled_time: meta.scheduled_time || "09:00 AM",
    priority: meta.priority || "Medium", // Low | Medium | High
    planned_hours: Number(meta.planned_hours ?? 2),
    actual_hours: Number(v.time_spent ?? 0),
    variance_reason: meta.variance_reason || "",
    comments: Array.isArray(meta.comments) ? meta.comments : [],
    photo_categories: meta.photo_categories || {}, // { [url]: "Before" | "During" | "After" }
    approval_status: meta.approval_status || "Approved", // Approved | PendingApproval | Rejected
    rejection_reason: meta.rejection_reason || "",
    created_by_role: meta.created_by_role || "Owner",
    is_overdue: isOverdue,
    days_diff: daysDiff,
    _meta: meta,
  };
}

function normalizeInvoice(inv, project, client, visits = []) {
  const { text, meta } = unpackTextAndMeta(inv.description);
  const visit = visits.find(x => x.id === inv.visit_id);
  return {
    ...inv,
    project_id: project?.id ?? visit?.project_id,
    project_name: project?.name || "Project",
    client_id: client?.id,
    client_name: client?.name || "Client",
    visit_date: visit?.visit_date || inv.invoice_date || "",
    clean_description: text,
    approval_status: meta.approval_status || "Approved", // Owner approval required if created by Manager
    rejection_reason: meta.rejection_reason || "",
    created_by_role: meta.created_by_role || "Owner",
    sent_to_client: Boolean(meta.sent_to_client),
    _meta: meta,
  };
}

function normalizeReceipt(r, project, client, visits = [], threshold = 150) {
  const visit = visits.find(x => x.id === r.visit_id);
  const { text, meta } = unpackTextAndMeta(r.store);
  const amount = Number(r.amount || 0);
  const needsApproval = amount > threshold;
  return {
    ...r,
    store_clean: text || r.store || "",
    project_id: r.project_id ?? project?.id,
    project_name: project?.name || "Project",
    client_id: client?.id,
    client_name: client?.name || "Client",
    visit_date: visit?.visit_date || r.receipt_date || "",
    submitted_by: meta.submitted_by || "Alex Rivera",
    notes: meta.notes || "",
    approval_status: meta.approval_status || (needsApproval ? "PendingApproval" : "Approved"),
    rejection_reason: meta.rejection_reason || "",
    _meta: meta,
  };
}

// ---------- Full CRM Data Loader ----------
async function fetchFullCRMData(expenseThreshold = 150) {
  const [tree, profile] = await Promise.all([
    api("GET", "/tree"),
    api("GET", "/profile").catch(() => ({
      company_name: "HandyCRM LLC",
      phone: "",
      email: "",
      business_address: "",
      payment_details: "Zelle",
      default_hourly_rate: 85,
    })),
  ]);

  // Fetch full scope for every client in parallel so Tasks, Projects, Estimates, Invoices & Receipts are complete
  const scopes = await Promise.all(
    (tree || []).map(c =>
      api("GET", `/scope/client/${c.id}`)
        .then(scope => ({ treeClient: c, scope }))
        .catch(() => null)
    )
  );

  const clients = [];
  const projects = [];
  const tasks = [];
  const invoices = [];
  const receipts = [];

  for (const item of scopes) {
    if (!item || !item.scope) continue;
    const { treeClient, scope } = item;
    const normClient = normalizeClient(scope.client, treeClient.debt);
    normClient.total_hours = Number(scope.total_hours || 0);
    clients.push(normClient);

    const projMap = {};
    for (const p of scope.projects || []) {
      const treeProj = (treeClient.projects || []).find(tp => tp.id === p.id);
      const normProj = normalizeProject(p, normClient, treeProj?.debt ?? 0);
      projects.push(normProj);
      projMap[p.id] = normProj;
    }

    for (const v of scope.visits || []) {
      const parentProj = projMap[v.project_id] || scope.projects?.[0];
      const normTask = normalizeTask(v, parentProj, normClient);
      tasks.push(normTask);
    }

    for (const inv of scope.invoices || []) {
      const visit = (scope.visits || []).find(v => v.id === inv.visit_id);
      const parentProj = projMap[visit?.project_id] || scope.projects?.[0];
      invoices.push(normalizeInvoice(inv, parentProj, normClient, scope.visits || []));
    }

    for (const rec of scope.receipts || []) {
      const parentProj = projMap[rec.project_id] || scope.projects?.[0];
      receipts.push(normalizeReceipt(rec, parentProj, normClient, scope.visits || [], expenseThreshold));
    }
  }

  return {
    profile,
    clients,
    projects,
    tasks,
    invoices,
    receipts,
  };
}