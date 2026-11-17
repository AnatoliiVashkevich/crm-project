// ==========================================================================
// app.js — the screens and buttons of HandyCRM (runs in the browser).
//
// How it works, in one paragraph:
//   syncCRM() loads everything from the server into `state` (api.js does the fetching).
//   renderCurrentView() draws the screen for state.view as one HTML string into #workspace.
//   Buttons carry data-* attributes (data-open-task="id", data-delete-entity="visits", ...);
//   ONE click listener at the bottom of the file looks at those attributes and does the work.
//   After any change we save to the server and call syncCRM(true) to redraw with fresh data.
//
// Sections (search for the numbers):
//   0. Helpers, global state, navigation, badges & shared components
//   1. Tasks (= visits) list and task detail
//   2. Clients list and client detail
//   3. Projects list and project detail
//   4. Money screens: estimates, invoices, receipts
//   5. Employees, Income & Expense report, notifications, settings
//   6. Pop-up forms (task / client / project / estimate / expense), approvals, invoices, photos
//   7. Event listeners (click, input, change, keys) and app start
//
// Words: a database "visit" is called a "Task" on screen; estimates and invoices are both "documents".
// Roles come from the signed-in account (state.me.role). Hiding things here is only for a tidy screen:
// the server (main.py) decides what each role may really see and change.
// ==========================================================================

const $ = id => document.getElementById(id);
// Escape user text before putting it into HTML (stops names like <b> or quotes from breaking the page)
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
);
// ==========================================================================
// 0. HELPERS, GLOBAL STATE, NAVIGATION
// ==========================================================================

// Tiny helpers used everywhere
const usd = n => Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
const initials = name => String(name || "?").split(/\s+/).filter(Boolean).map(x => x[0]).join("").slice(0, 2).toUpperCase();
const todayStr = () => isoDate(new Date());   // local date (isoDate is in api.js)

const TASK_STATUSES = ["Scheduled", "In Progress", "Completed", "Canceled"];
const PRIORITIES = ["High", "Medium", "Low"];
const PHOTO_CATS = ["Before", "During", "After"];
const EXPENSE_CATEGORIES = ["Construction", "Groceries", "Fuel", "Other"];

// ---------- Global Application State ----------
const state = {
  me: null,        // the signed-in person {id, name, role, ...}
  role: "",        // "Owner" | "Manager" | "Employee" (copy of me.role)
  team: [],        // everyone on the team (names for assignees)

  view: "tasks",
  selectedId: null,
  projectTab: "overview",   // overview | tasks | documents | expenses | photos
  moneyTab: "reports",      // reports (opens first) | documents | expenses
  history: [],
  showMobileFilters: false,

  // Data from Backend
  profile: {},
  clients: [],
  projects: [],
  tasks: [],
  invoices: [],
  receipts: [],

  // Unified Task Filters & Sorting
  search: "",
  taskQuickChip: "all",
  filterStatus: "all",
  filterPriority: "all",
  filterClient: "all",
  filterProject: "all",
  filterAssignee: "all",
  clientFilter: "all",   // all | unpaid  ([ All Clients ] / [ 🔴 Unpaid Only ])
  // Money screen filters (search text comes from the search box)
  money: { type: "all", status: "all", start: "", end: "" },
  moneyMore: false,   // phone: dates & sort row of the Money filters unfolded
  // Reports: which report, which period, its filters / grouping, and whether the column picker is open
  report: { kind: "overview", preset: "month", start: "", end: "", filters: {}, group: "", showCols: false },
  // Sort order of every table: click a column title (desktop) or the Sort dropdown (phone)
  sorts: {
    tasks: { key: "date", dir: "asc" },
    clients: { key: "name", dir: "asc" },
    projects: { key: "client", dir: "asc" },
    documents: { key: "date", dir: "desc" },
    expenses: { key: "date", dir: "desc" },
  },

};
localStorage.removeItem("hcrm_timers");   // timers used to live in the browser; they are saved in the task now

let timerInterval = null;

// ---------- Role helpers ----------
const isOwner = () => state.role === "Owner";
const isManager = () => state.role === "Manager";
const isEmployee = () => state.role === "Employee";
const canApprove = () => state.role === "Owner" || state.role === "Manager";
const currentEmployee = () => state.me || { id: "", name: "" };
const approvalsOn = () => state.profile.approvals_required !== false;         // Settings switch (Owner)
const expenseThreshold = () => Number(state.profile.expense_threshold ?? 150); // Settings amount (Owner)
const activeTeam = () => state.team.filter(m => m.active);
// Status a new / edited record gets from this person (the server applies the same rule and has the last word)
const newApprovalStatus = () => (isEmployee() && approvalsOn() ? "PendingApproval" : "Approved");



// ---------- Data Sync & Reload ----------
async function syncCRM(silent = false) {
  if (!silent) {
    $("workspace").innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Syncing HandyCRM data...</p></div>`;
  }
  try {
    const data = await fetchFullCRMData();
    reportCache = {};   // data changed -> reports are recalculated when opened
    state.me = data.me;
    state.role = data.me.role;
    state.team = data.team;
    state.profile = data.profile;
    state.clients = data.clients;
    state.projects = data.projects;
    state.tasks = data.tasks;
    state.invoices = data.invoices;
    state.receipts = data.receipts;
    updateShellUI();
    renderCurrentView();
  } catch (e) {
    $("workspace").innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <h3>Could not load backend data</h3>
        <p style="margin:8px 0 16px;">${esc(e.message)}</p>
        <button class="btn btn-primary" data-action="sync">Retry Connection</button>
      </div>`;
  }
}

// ---------- Navigation & Shell Updates ----------
function navigate(view, id = null, pushHistory = true) {
  if (isEmployee() && view === "money") state.moneyTab = "expenses";   // employees: only their receipts
  if (pushHistory && (state.view !== view || !sameId(state.selectedId, id))) {
    state.history.push({ view: state.view, selectedId: state.selectedId, projectTab: state.projectTab });
  }
  state.view = view;
  state.selectedId = id;
  closeMobileDrawer();
  updateShellUI();
  renderCurrentView();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ← Back button: return to the previous screen (or the Tasks list)
function goBack() {
  const prev = state.history.pop();
  if (prev) {
    state.view = prev.view;
    state.selectedId = prev.selectedId;
    state.projectTab = prev.projectTab || "overview";
    updateShellUI();
    renderCurrentView();
  } else {
    navigate("tasks", null, false);
  }
}

// Phone menu (slide-out sidebar)
function openMobileDrawer() {
  $("sidebar")?.classList.add("open");
  if ($("drawerBackdrop")) $("drawerBackdrop").hidden = false;
}

function closeMobileDrawer() {
  $("sidebar")?.classList.remove("open");
  if ($("drawerBackdrop")) $("drawerBackdrop").hidden = true;
}

// Everything waiting for approval or rejected, for the Notifications screen and its badge
function getPendingNotifications() {
  const items = [];
  state.clients.forEach(c => {
    if (c.approval_status === "PendingApproval" || c.approval_status === "Rejected") {
      items.push({ kind: "client", id: c.id, title: `Client: ${c.name}`, status: c.approval_status, reason: c.rejection_reason, role: c.created_by_role });
    }
  });
  state.projects.forEach(p => {
    if (p.approval_status === "PendingApproval" || p.approval_status === "Rejected") {
      items.push({ kind: "project", id: p.id, title: `Project: ${p.name}`, sub: p.client_name, status: p.approval_status, reason: p.rejection_reason, role: p.created_by_role });
    }
  });
  state.tasks.forEach(t => {
    if (t.approval_status === "PendingApproval" || t.approval_status === "Rejected") {
      items.push({ kind: "task", id: t.id, title: `Task: ${t.title}`, sub: `${t.client_name} • ${t.project_name}`, status: t.approval_status, reason: t.rejection_reason, role: t.created_by_role });
    }
  });
  if (!isEmployee()) {
    state.invoices.forEach(i => {
      if (i.approval_status === "PendingApproval" || i.approval_status === "Rejected") {
        items.push({ kind: "invoice", id: i.id, title: `Invoice #${i.invoice_number} (${usd(i.total)})`, sub: `${i.client_name} • Created by Manager`, status: i.approval_status, reason: i.rejection_reason, role: i.created_by_role });
      }
    });
  }
  state.receipts.forEach(r => {
    if (r.approval_status === "PendingApproval" || r.approval_status === "Rejected") {
      items.push({ kind: "receipt", id: r.id, title: `Expense: ${r.store_clean || "Receipt"} (${usd(r.amount)})`, sub: `${r.project_name} • over the ${usd(expenseThreshold())} limit`, status: r.approval_status, reason: r.rejection_reason });
    }
  });
  return items;
}

// Redraw the frame around the workspace: user card, menu highlight, counters, role banner, back button
function updateShellUI() {
  // who is signed in
  const me = currentEmployee();
  $("activeUserName").textContent = me.name || "—";
  $("activeUserRole").textContent = state.role;
  $("userAvatar").textContent = initials(me.name);
  $("brandCompany").textContent = state.profile.company_name || "Field Service";
  $("navMoneyLabel").textContent = isEmployee() ? "My Expenses" : "Money";

  // highlight the menu item of the current screen (task-detail -> Tasks, ...)
  const baseView = { "task-detail": "tasks", "client-detail": "clients", "project-detail": "projects" }[state.view] || state.view;
  document.querySelectorAll("[data-nav]").forEach(btn => btn.classList.toggle("active", btn.dataset.nav === baseView));

  // counters: open tasks, unpaid invoices, notifications
  $("navTasksCount").textContent = state.tasks.filter(t => t.status === "Scheduled" || t.status === "In Progress").length;
  const unpaidCount = state.invoices.filter(i => !i.is_estimate && i.status === "Unpaid").length;
  $("navUnpaidBadge").hidden = unpaidCount === 0 || isEmployee();
  $("navUnpaidBadge").textContent = unpaidCount;
  const pendingCount = getPendingNotifications()
    .filter(n => isEmployee() ? n.status === "Rejected" : n.status === "PendingApproval").length;
  $("navNotifBadge").hidden = pendingCount === 0;
  $("navNotifBadge").textContent = pendingCount;

  // a one-line reminder of what this role can do
  const banner = $("roleNoticeBanner");
  if (isEmployee()) {
    banner.hidden = false;
    banner.innerHTML = `<span>👷 <strong>${esc(me.name)}:</strong> you see your own tasks and receipts.${
      approvalsOn() ? " New records and changes go to your Manager for approval." : ""}</span>`;
  } else if (isManager() && approvalsOn()) {
    banner.hidden = false;
    banner.innerHTML = `<span>📋 <strong>Manager:</strong> invoices you create need the Owner's approval before sending.</span>`;
  } else {
    banner.hidden = true;
  }

  $("topbarBackBtn").hidden = !state.view.endsWith("-detail");
}

// ---------- Reusable Badges & UI Snippets ----------
function renderStatusBadge(status) {
  const s = status || "Scheduled";
  const slug = s.toLowerCase().replace(/\s+/g, "-");
  return `<span class="badge st-${esc(slug)}"><span class="badge-dot"></span>${esc(s)}</span>`;
}

// High / Medium / Low pill
function renderPriorityBadge(prio) {
  const p = prio || "Medium";
  return `<span class="badge prio-${esc(p.toLowerCase())}">${esc(p)}</span>`;
}

// Red debt badge next to a Client / Project name: [ 🔴 $450 ] (hidden when nothing is owed, and from Employees)
function debtBadge(amount) {
  const n = Number(amount || 0);
  return n > 0 && !isEmployee() ? `<span class="debt-badge" title="Unpaid invoices">🔴 ${usd(n)}</span>` : "";
}

// ONE photo component for Visits and Receipts: preview -> full screen in 1 tap, delete in 2 taps
function renderPhotoStrip(entity, rowId, urls, { small = false } = {}) {
  return (urls || []).map(u => `
    <span class="thumb${small ? " thumb-sm" : ""}">
      <img src="${esc(u)}" alt="Photo" loading="lazy" data-lightbox="${esc(u)}">
      <button class="photo-del" title="Delete photo (tap twice)" data-del-photo="${esc(u)}"
        data-photo-entity="${entity}" data-photo-row="${esc(rowId)}">✕</button>
    </span>`).join("");
}

// First tap arms a button ("Confirm?"), second tap within 3 s does the action. Returns true while only armed.
function armOnce(el, label) {
  if (el.dataset.armed) {
    clearTimeout(el._armTimer);
    return false;
  }
  el.dataset.armed = "1";
  el.dataset.origLabel = el.innerHTML;
  el.textContent = label;
  el.classList.add("armed");
  el._armTimer = setTimeout(() => {
    delete el.dataset.armed;
    el.innerHTML = el.dataset.origLabel;
    el.classList.remove("armed");
  }, 3000);
  return true;
}

// "Pending Approval" / "Rejected" pill (nothing when approved)
// ---------- Sortable tables ----------
// Desktop: click a column title to sort, click again to reverse. Phone (no table titles): the "Sort" dropdown.
// Each table describes its columns once:  { key: [label, row => value to sort by] }
function sortTh(table, key, label) {
  const s = state.sorts[table];
  const on = s.key === key;
  return `<th class="sortable${on ? " sorted" : ""}" data-sort-table="${table}" data-sort-key="${key}" title="Sort by ${esc(label)}">
    ${esc(label)}<span class="sort-arrow">${on ? (s.dir === "asc" ? "▲" : "▼") : "↕"}</span></th>`;
}

function sortRows(list, table, columns) {
  const { key, dir } = state.sorts[table];
  const get = columns[key]?.[1];
  if (!get) return list;
  const m = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = get(a), y = get(b);
    if (typeof x === "number" && typeof y === "number") return (x - y) * m;
    return String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true, sensitivity: "base" }) * m;
  });
}

function sortSelect(table, columns) {
  const s = state.sorts[table];
  return `<select class="filter-select mobile-only sort-select" data-sort-select="${table}" aria-label="Sort">${
    Object.entries(columns).map(([k, [label]]) => ["asc", "desc"].map(d =>
      `<option value="${k}:${d}" ${s.key === k && s.dir === d ? "selected" : ""}>Sort: ${esc(label)} ${d === "asc" ? "↑" : "↓"}</option>`
    ).join("")).join("")}</select>`;
}

// One phone card (used by Clients, Projects, Money). open = data-* attribute that opens the record on tap.
function mobCard({ open = "", title, right = "", sub = "", extra = "", cls = "" }) {
  return `<div class="mob-card ${cls}" ${open}>
    <div class="mob-card-head"><div class="mob-card-title">${title}</div>${right ? `<div class="mob-card-right">${right}</div>` : ""}</div>
    ${sub ? `<div class="mob-card-sub">${sub}</div>` : ""}
    ${extra}
  </div>`;
}

function renderApprovalBadge(status) {
  if (!status || status === "Approved") return "";
  if (status === "PendingApproval") {
    return `<span class="badge badge-approval-pending">⏳ Pending Approval</span>`;
  }
  if (status === "Rejected") {
    return `<span class="badge badge-approval-rejected">⚠️ Rejected</span>`;
  }
  return "";
}

// Yellow / red banner on top of a detail screen with Approve / Reject / Resubmit buttons
function renderApprovalBanner(entityKind, item) {
  if (!item) return "";
  if (item.approval_status === "PendingApproval") {
    const actions = canApprove()
      ? `<div style="display:flex;gap:8px;">
           <button class="btn btn-sm btn-success" data-approve-kind="${entityKind}" data-approve-id="${esc(item.id)}">✓ Approve</button>
           <button class="btn btn-sm btn-danger" data-reject-kind="${entityKind}" data-reject-id="${esc(item.id)}">✕ Reject</button>
         </div>`
      : `<span>Waiting for Manager/Owner review.</span>`;
    return `<div class="alert-box alert-warning">
      <div><strong>⏳ Pending Approval:</strong> This ${esc(entityKind)} was submitted or modified by an Employee and requires approval.</div>
      ${actions}
    </div>`;
  }
  if (item.approval_status === "Rejected") {
    return `<div class="alert-box alert-danger">
      <div>
        <strong>⚠️ Submission Rejected:</strong> ${esc(item.rejection_reason || "Please review and correct this record.")}
      </div>
      <button class="btn btn-sm btn-primary" data-resubmit-kind="${entityKind}" data-resubmit-id="${esc(item.id)}">↻ Correct &amp; Resubmit</button>
    </div>`;
  }
  return "";
}

// ---------- View Router ----------
function renderCurrentView() {
  const ws = $("workspace");
  const titleEl = $("pageTitle");
  const crumbsEl = $("breadcrumbs");
  const actionsEl = $("topbarActions");
  const fab = $("mobileFab");

  // the "+ New" button (top right / round on phones) is the same on every screen; detail screens add Edit / Delete
  crumbsEl.innerHTML = "";
  actionsEl.innerHTML = "";
  if (fab) fab.hidden = false;

  switch (state.view) {
    case "task-detail":
      ws.innerHTML = renderTaskDetailView(state.selectedId);
      break;
    case "clients":
      titleEl.textContent = "Clients";
      ws.innerHTML = renderClientsView();
      break;
    case "client-detail":
      ws.innerHTML = renderClientDetailView(state.selectedId);
      break;
    case "projects":
      titleEl.textContent = "Projects";
      ws.innerHTML = renderProjectsView();
      break;
    case "project-detail":
      ws.innerHTML = renderProjectDetailView(state.selectedId);
      break;
    case "money":
      titleEl.textContent = isEmployee() ? "My Expenses" : "Money";
      ws.innerHTML = renderMoneyView();
      break;
    case "notifications":
      titleEl.textContent = "Notifications & Approvals";
      ws.innerHTML = renderNotificationsView();
      break;
    case "settings":
      titleEl.textContent = "Settings";
      ws.innerHTML = renderSettingsView();
      break;
    default:   // "tasks" - the start screen
      state.view = "tasks";
      titleEl.textContent = "Tasks";
      ws.innerHTML = renderTasksView();
  }
  hydrateFinance();
  hydrateReports();
}

// ==========================================================================
// 1. UNIFIED TASKS VIEW (Landing Page) & TASK DETAIL VIEW
// ==========================================================================

// Tasks this person may see. The server already sends Employees only their own tasks.
function getRoleFilteredTasks() {
  return state.tasks;
}

// Tasks list after quick chips, dropdown filters, search text and sorting
function getFilteredAndSortedTasks() {
  let list = getRoleFilteredTasks();
  const q = state.search.trim().toLowerCase();

  if (state.taskQuickChip === "today") {
    list = list.filter(t => t.days_diff === 0);
  } else if (state.taskQuickChip === "overdue") {
    list = list.filter(t => t.is_overdue);
  } else if (state.taskQuickChip === "pending-approval") {
    list = list.filter(t => t.approval_status !== "Approved");
  }

  if (state.filterStatus !== "all") list = list.filter(t => t.status === state.filterStatus);
  if (state.filterPriority !== "all") list = list.filter(t => t.priority === state.filterPriority);
  if (state.filterClient !== "all") list = list.filter(t => sameId(t.client_id, state.filterClient));
  if (state.filterProject !== "all") list = list.filter(t => sameId(t.project_id, state.filterProject));
  if (state.filterAssignee !== "all") list = list.filter(t => t.assigned_to === state.filterAssignee);

  if (q) {
    list = list.filter(t =>
      [t.title, t.description, t.client_name, t.project_name, t.project_address, t.assigned_name]
        .some(val => String(val || "").toLowerCase().includes(q))
    );
  }

  return sortRows(list, "tasks", TASK_COLUMNS);
}

// "09:30 AM" -> "09:30", "01:00 PM" -> "13:00" (so times sort correctly)
function time24(t) {
  const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return "99:99";
  let h = Number(m[1]) % 12 + (/pm/i.test(m[3] || "") ? 12 : 0);
  if (!m[3]) h = Number(m[1]);
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// Columns of the Tasks table: title and what each one sorts by
const TASK_COLUMNS = {
  title: ["Task & Work Address", t => t.title],
  client: ["Client", t => t.client_name],
  project: ["Project", t => t.project_name],
  date: ["Schedule / Due", t => `${t.visit_date || "9999"} ${time24(t.scheduled_time)}`],
  status: ["Status", t => TASK_STATUSES.indexOf(t.status)],
  priority: ["Priority", t => PRIORITIES.indexOf(t.priority)],
  assignee: ["Assignee", t => t.assigned_name],
  hours: ["Hours (Act / Plan)", t => t.actual_hours],
};

// Date highlighting (spec §5) - never uses the red/green payment colors' meaning:
//   upcoming Scheduled / In Progress -> bold · 3 days or less -> + blue frame · Canceled -> grey, struck through
//   overdue (date passed, still open) -> red; Completed -> plain
function taskRowClass(t) {
  if (t.status === "Canceled") return "row-canceled";
  if (t.is_overdue) return "row-overdue";
  return [t.is_upcoming && "row-upcoming", t.is_soon && "row-soon"].filter(Boolean).join(" ");
}

// Green "⏱ 23 min" badge while a task's timer runs (kept up to date by the ticker)
function timerBadge(t) {
  return t.timer_start
    ? `<span class="badge badge-timer" data-timer-start="${t.timer_start}" data-short="1">⏱ ${formatDuration(elapsedSeconds(t.timer_start))}</span>`
    : "";
}

// "Today • 09:00 AM", "Tomorrow • ...", or the date
function formatDueDateLabel(t) {
  if (!t.visit_date) return "Unscheduled";
  if (t.days_diff === 0) return `Today • ${t.scheduled_time}`;
  if (t.days_diff === 1) return `Tomorrow • ${t.scheduled_time}`;
  if (t.days_diff === -1) return `Yesterday • ${t.scheduled_time}`;
  return `${t.visit_date} • ${t.scheduled_time}`;
}

// Tasks screen: filters + desktop table + phone cards
function renderTasksView() {
  const baseTasks = getRoleFilteredTasks();
  const todayCount = baseTasks.filter(t => t.days_diff === 0).length;
  const overdueCount = baseTasks.filter(t => t.is_overdue).length;
  const pendingApprovalCount = baseTasks.filter(t => t.approval_status !== "Approved").length;

  const list = getFilteredAndSortedTasks();

  const chips = [
    ["all", `All (${baseTasks.length})`],
    ["today", `Today (${todayCount})`],
    ["overdue", `Overdue (${overdueCount})`],
    ...(pendingApprovalCount > 0 ? [["pending-approval", `Approvals (${pendingApprovalCount})`]] : []),
  ].map(([k, label]) =>
    `<button class="filter-chip ${state.taskQuickChip === k ? "active" : ""}" data-task-chip="${k}">${esc(label)}</button>`
  ).join("");

  const clientOpts = `<option value="all">All Clients</option>` + state.clients.map(c =>
    `<option value="${esc(c.id)}" ${sameId(state.filterClient, c.id) ? "selected" : ""}>${esc(c.name)}</option>`
  ).join("");

  const projectOpts = `<option value="all">All Projects</option>` + state.projects.map(p =>
    `<option value="${esc(p.id)}" ${sameId(state.filterProject, p.id) ? "selected" : ""}>${esc(p.name)}</option>`
  ).join("");

  const assigneeOpts = `<option value="all">All Employees</option>` + state.team.map(e =>
    `<option value="${esc(e.id)}" ${state.filterAssignee === e.id ? "selected" : ""}>${esc(e.name)}</option>`
  ).join("");

  const activeFiltersCount = [
    state.filterStatus !== "all",
    state.filterPriority !== "all",
    state.filterClient !== "all",
    state.filterProject !== "all",
    state.filterAssignee !== "all",
  ].filter(Boolean).length;

  const tableRows = list.map(t => {
    return `<tr class="row-clickable ${taskRowClass(t)}" data-open-task="${esc(t.id)}">
      <td>
        <div style="font-weight:600;color:var(--dark);">${esc(t.title)}</div>
        <div style="font-size:12px;color:var(--secondary);">📍 ${esc(t.project_address || "No project address")}</div>
        ${renderApprovalBadge(t.approval_status)}
      </td>
      <td><button class="crumb-link" data-open-client="${esc(t.client_id)}" onclick="event.stopPropagation()">${esc(t.client_name)}</button></td>
      <td><button class="crumb-link" data-open-project="${esc(t.project_id)}" onclick="event.stopPropagation()">${esc(t.project_name)}</button></td>
      <td>
        <div style="font-weight:${t.is_overdue || t.days_diff === 0 ? "600" : "400"};color:${t.is_overdue ? "var(--error-text)" : "inherit"};">
          ${esc(formatDueDateLabel(t))}
        </div>
        ${t.is_overdue ? `<span class="badge badge-overdue" style="margin-top:4px;">! Overdue</span>` : ""}
        ${timerBadge(t)}
      </td>
      <td>${renderStatusBadge(t.status)}</td>
      <td>${renderPriorityBadge(t.priority)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="user-avatar" style="width:28px;height:28px;font-size:11px;">
            ${esc(t.assigned_name.split(" ").map(n => n[0]).join("").slice(0, 2))}
          </span>
          <span>${esc(t.assigned_name)}</span>
        </div>
      </td>
      <td><strong>${t.actual_hours}h</strong> <span style="color:var(--secondary);">/ ${t.planned_hours}h</span></td>
    </tr>`;
  }).join("");

  const mobileCards = list.map(t => {
    const thumbImg = t.image_urls?.[0]
      ? `<img src="${esc(t.image_urls[0])}" alt="Task photo">`
      : `🔧`;
    return `<div class="mob-task-card ${taskRowClass(t)}" data-open-task="${esc(t.id)}">
      <div class="mob-task-thumb">${thumbImg}</div>
      <div class="mob-task-body">
        <div class="mob-task-header">
          <div class="mob-task-title">${esc(t.title)}</div>
          ${renderPriorityBadge(t.priority)}
        </div>
        <div class="mob-task-sub">${esc(t.client_name)} • ${esc(t.project_name)}</div>
        <div class="mob-task-addr">📍 ${esc(t.project_address || "Job site address not set")}</div>
        <div class="mob-task-footer">
          <span style="font-size:12px;font-weight:600;color:${t.is_overdue ? "var(--error-text)" : "var(--warning-text)"};">
            ${esc(formatDueDateLabel(t))}
          </span>
          <div style="display:flex;gap:6px;align-items:center;">
            ${t.is_overdue ? `<span class="badge badge-overdue">! Overdue</span>` : ""}
            ${timerBadge(t)}
            ${renderApprovalBadge(t.approval_status)}
            ${renderStatusBadge(t.status)}
          </div>
        </div>
      </div>
    </div>`;
  }).join("");

  return `
    <div class="toolbar-card">
      <!-- Mobile Search & Filter Toggle Row -->
      <div class="mobile-only" style="display:flex;gap:8px;width:100%;">
        <input
          id="mobileSearchInput"
          type="search"
          class="form-input"
          style="flex:1;padding:7px 12px;font-size:14px;"
          placeholder="🔍 Search tasks, clients, address..."
          value="${esc(state.search)}"
        >
        <button class="btn btn-sm ${state.showMobileFilters || activeFiltersCount ? "btn-primary" : ""}" data-action="toggle-mob-filters">
          ⚙️ Filters ${activeFiltersCount ? `(${activeFiltersCount})` : ""}
        </button>
      </div>

      <div class="chip-row">${chips}</div>
      ${sortSelect("tasks", TASK_COLUMNS)}

      <div class="filter-controls" style="${!state.showMobileFilters && window.innerWidth <= 768 ? "display:none;" : ""}">
        <select class="filter-select" id="fltStatus">
          <option value="all">All Statuses</option>
          ${TASK_STATUSES.map(s => `<option value="${s}" ${state.filterStatus === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        <select class="filter-select" id="fltPriority">
          <option value="all">All Priorities</option>
          ${PRIORITIES.map(p => `<option value="${p}" ${state.filterPriority === p ? "selected" : ""}>${p} Priority</option>`).join("")}
        </select>
        <select class="filter-select" id="fltClient">${clientOpts}</select>
        <select class="filter-select" id="fltProject">${projectOpts}</select>
        ${!isEmployee() ? `<select class="filter-select" id="fltAssignee">${assigneeOpts}</select>` : ""}
      </div>
    </div>

    ${list.length === 0 ? `
      <div class="data-card empty-state">
        <div class="empty-icon">☑️</div>
        <h3>No matching tasks found</h3>
        <p style="margin:6px 0 16px;">Try clearing your filters, or tap <strong>+ New → Task</strong> (a new project and client can be created in the same form).</p>
      </div>
    ` : `
      <!-- Desktop Table View -->
      <div class="data-card desktop-table-view">
        <div class="table-responsive">
          <table class="crm-table">
            <thead>
              <tr>${Object.entries(TASK_COLUMNS).map(([k, [label]]) => sortTh("tasks", k, label)).join("")}</tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Mobile Field Cards View -->
      <div class="mobile-card-list">${mobileCards}</div>
    `}
  `;
}

// ---------- Task Detail Screen ----------
function renderTaskDetailView(taskId) {
  const t = state.tasks.find(x => sameId(x.id, taskId));
  if (!t) return `<div class="empty-state">Task not found.</div>`;

  $("pageTitle").textContent = t.title;
  const tClient = state.clients.find(c => sameId(c.id, t.client_id));
  const tProject = state.projects.find(p => sameId(p.id, t.project_id));
  $("breadcrumbs").innerHTML = `
    <button class="crumb-link" data-open-client="${esc(t.client_id)}">${esc(t.client_name)}</button> ${debtBadge(tClient?.debt)} /
    <button class="crumb-link" data-open-project="${esc(t.project_id)}">${esc(t.project_name)}</button> ${debtBadge(tProject?.debt)} /
    <span>Task #${esc(String(t.id).slice(0, 8))}</span>
  `;
  $("topbarActions").innerHTML = `
    <button class="btn" data-edit-task="${esc(t.id)}">✏️ Edit</button>
    ${!isEmployee() ? `<button class="btn btn-danger" data-delete-entity="visits" data-delete-id="${esc(t.id)}" data-back-view="tasks">🗑 Delete</button>` : ""}
  `;

  // the timer lives in the task itself (server), so it shows on every device and to the Manager
  const isRunning = t.timer_start > 0;
  const clockStr = formatTimerClock(isRunning ? elapsedSeconds(t.timer_start) : 0);
  const timerOwner = isRunning && t.timer_by && !sameId(t.timer_by, currentEmployee().id)
    ? state.team.find(m => sameId(m.id, t.timer_by))?.name : "";
  const diffHours = +(t.actual_hours - t.planned_hours).toFixed(2);

  const urls = t.image_urls || [];
  const catCards = PHOTO_CATS.map(cat => {
    const catUrls = urls.filter(u => (t.photo_categories?.[u] || "Before") === cat);
    const thumbs = renderPhotoStrip("visits", t.id, catUrls);
    return `
      <div class="photo-cat-card">
        <div class="photo-cat-header">
          <span>📸 ${cat} Photos (${catUrls.length})</span>
        </div>
        <div class="photo-grid">
          ${thumbs || `<span style="font-size:12px;color:var(--muted);">No ${cat.toLowerCase()} photos yet.</span>`}
        </div>
      </div>
    `;
  }).join("");

  const commentsHtml = (t.comments || []).map(c => `
    <div style="padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--secondary);margin-bottom:4px;">
        <strong>${esc(c.author)} (${esc(c.role)})</strong>
        <span>${esc(c.date)}</span>
      </div>
      <div style="font-size:14px;">${esc(c.text)}</div>
    </div>
  `).join("");

  return `
    ${renderApprovalBanner("task", t)}
    ${t.is_overdue ? `
      <div class="alert-box alert-danger">
        <div><strong>! Overdue Task:</strong> Scheduled for ${esc(t.visit_date)}. Status remains <em>${esc(t.status)}</em> until updated.</div>
      </div>
    ` : ""}

    <div class="detail-grid">
      <div>
        <div class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">${esc(t.title)}</h2>
              <div style="font-size:13px;color:var(--secondary);margin-top:4px;">
                📍 Work Address: <strong>${esc(t.project_address || "No address on project")}</strong>
              </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              ${renderPriorityBadge(t.priority)}
              ${renderStatusBadge(t.status)}
            </div>
          </div>

          <div style="margin-bottom:18px;">
            <label style="font-size:12px;font-weight:600;color:var(--secondary);display:block;margin-bottom:6px;">UPDATE TASK STATUS</label>
            <div class="chip-row">
              ${TASK_STATUSES.map(st => `
                <button class="filter-chip ${t.status === st ? "active" : ""}" data-task-status="${st}" data-task-id="${esc(t.id)}">
                  ${esc(st)}
                </button>
              `).join("")}
            </div>
          </div>

          <div class="form-field wide" style="margin-bottom:16px;">
            <label>Instructions &amp; Scope of Work</label>
            <div style="padding:12px;background:var(--surface);border-radius:8px;border:1px solid var(--border);white-space:pre-wrap;min-height:60px;">${esc(t.description || "No detailed instructions provided.")}</div>
          </div>

          <div class="form-grid">
            <div class="form-field">
              <label>Client</label>
              <div><button class="crumb-link" data-open-client="${esc(t.client_id)}">${esc(t.client_name)}</button></div>
            </div>
            <div class="form-field">
              <label>Project</label>
              <div><button class="crumb-link" data-open-project="${esc(t.project_id)}">${esc(t.project_name)}</button></div>
            </div>
            <div class="form-field">
              <label>Scheduled Date &amp; Time</label>
              <div><strong>${esc(t.visit_date)}</strong> at ${esc(t.scheduled_time)}</div>
            </div>
            <div class="form-field">
              <label>Assigned Employee</label>
              <div>👷 <strong>${esc(t.assigned_name)}</strong></div>
            </div>
          </div>
        </div>

        <div class="section-card">
          <div class="section-header">
            <h3 class="section-title">Job Site Photos (Before / During / After)</h3>
          </div>
          <div class="photo-categories">${catCards}</div>
        </div>

        <div class="section-card">
          <div class="section-header">
            <h3 class="section-title">Field Comments &amp; Notes (${(t.comments || []).length})</h3>
          </div>
          <div>${commentsHtml || `<p style="color:var(--secondary);font-size:14px;margin-bottom:12px;">No comments logged yet.</p>`}</div>
          <div style="display:flex;gap:8px;margin-top:12px;">
            <input id="newTaskComment" class="form-input" style="flex:1;" placeholder="Add a field note or update...">
            <button class="btn btn-primary" data-add-comment="${esc(t.id)}">Post Note</button>
          </div>
        </div>
      </div>

      <div>
        <div class="section-card">
          <div class="section-header">
            <h3 class="section-title">⏱ Time Tracking</h3>
          </div>
          <div class="timer-box">
            <div class="timer-display-row">
              <div>
                <div style="font-size:12px;color:var(--secondary);font-weight:600;">LIVE TIMER${timerOwner ? ` · started by ${esc(timerOwner)}` : ""}</div>
                <div class="timer-clock ${isRunning ? "running" : ""}" ${isRunning ? `data-timer-start="${t.timer_start}"` : ""}>${clockStr}</div>
              </div>
              <div>
                ${isRunning
                  ? `<button class="btn btn-danger" data-stop-timer="${esc(t.id)}">⏹ Stop Timer</button>`
                  : `<button class="btn btn-success" data-start-timer="${esc(t.id)}">▶ Start Timer</button>`
                }
              </div>
            </div>

            <div class="hours-comparison">
              <div class="hours-metric">
                <span>Planned</span>
                <strong>${t.planned_hours}h</strong>
              </div>
              <div class="hours-metric">
                <span>Actual</span>
                <strong>${t.actual_hours}h</strong>
              </div>
              <div class="hours-metric">
                <span>Variance</span>
                <strong style="color:${diffHours === 0 ? "var(--success-text)" : "var(--warning-text)"};">
                  ${diffHours > 0 ? `+${diffHours}h` : `${diffHours}h`}
                </strong>
              </div>
            </div>

            ${t.variance_reason ? `
              <div style="font-size:13px;background:#FFFBEB;border:1px solid #FDE68A;padding:10px;border-radius:8px;color:#92400E;">
                <strong>Time Variance Reason:</strong> ${esc(t.variance_reason)}
              </div>
            ` : ""}

            <div style="padding-top:10px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px;">
              <label style="font-size:12px;font-weight:600;color:var(--secondary);">MANUAL TIME ENTRY / CORRECTION (HOURS)</label>
              <div style="display:flex;gap:8px;">
                <input id="manualHoursInput" type="number" step="0.25" min="0" class="form-input" style="flex:1;" value="${t.actual_hours}">
                <button class="btn btn-primary" data-save-hours="${esc(t.id)}">Save Hours</button>
              </div>
            </div>
          </div>
        </div>

        <div class="section-card">
          <div class="section-header">
            <h3 class="section-title">💳 Task Expenses</h3>
          </div>
          ${renderTaskReceiptsMiniList(t)}
        </div>

        ${!isEmployee() ? renderTaskDocumentsCard(t) : ""}
      </div>
    </div>
  `;
}

// Short receipt list on the task screen (right column)
function renderTaskReceiptsMiniList(task) {
  const list = state.receipts.filter(r => sameId(r.visit_id, task.id));
  if (!list.length) {
    return `<p style="font-size:13px;color:var(--secondary);">No receipts attached to this task.</p>`;
  }
  return list.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <div>
        <strong>${esc(r.store_clean || "Store")}</strong> • ${esc(r.category || "Other")}
        <div>${renderApprovalBadge(r.approval_status)}${r.invoice_id ? `<span class="badge badge-invoiced">🔒 Invoiced</span>` : ""}</div>
      </div>
      <strong>${usd(r.amount)}</strong>
    </div>
  `).join("");
}

// ==========================================================================
// 2. CLIENTS DIRECTORY & CLIENT DETAIL VIEW
// ==========================================================================

// Clients screen: [ All Clients ] / [ 🔴 Unpaid Only ] + table with debt badges
function renderClientsView() {
  const q = state.search.trim().toLowerCase();
  const unpaidOnly = state.clientFilter === "unpaid" && !isEmployee();
  const list = state.clients.filter(c =>
    (!unpaidOnly || c.debt > 0) &&
    (!q || [c.name, c.first_name, c.last_name, c.company_name, c.phone, c.email, c.street, c.city]
      .some(v => String(v || "").toLowerCase().includes(q)))
  );
  const debtors = state.clients.filter(c => c.debt > 0).length;
  const filterBar = isEmployee() ? "" : `
    <div class="chip-row">
      <button class="filter-chip ${unpaidOnly ? "" : "active"}" data-client-filter="all">All Clients</button>
      <button class="filter-chip ${unpaidOnly ? "active" : ""}" data-client-filter="unpaid">🔴 Unpaid Only (${debtors})</button>
    </div>`;

  const projCount = c => state.projects.filter(p => sameId(p.client_id, c.id)).length;
  const columns = {
    name: ["Client", c => c.name],
    phone: ["Phone", c => c.phone],
    email: ["Email", c => c.email],
    address: ["Address", c => [c.city, c.street].join(" ")],
    projects: ["Projects", c => projCount(c)],
    ...(!isEmployee() ? { debt: ["Balance", c => c.debt || 0] } : {}),
  };
  const sorted = sortRows(list, "clients", columns);
  const addr = c => [c.street, c.city, c.state, c.zip].filter(Boolean).join(", ") || "—";
  const balance = c => c.debt > 0 ? debtBadge(c.debt) : `<span class="badge st-completed">Paid</span>`;
  const empty = unpaidOnly ? "No client owes you money right now." : "No clients found.";

  const rows = sorted.map(c => `<tr class="row-clickable" data-open-client="${esc(c.id)}">
      <td>
        <div style="font-weight:600;color:var(--dark);">${esc(c.first_name)} ${esc(c.last_name)}</div>
        ${c.company_name ? `<div style="font-size:12px;color:var(--secondary);">🏢 ${esc(c.company_name)}</div>` : ""}
        ${renderApprovalBadge(c.approval_status)}
      </td>
      <td>${esc(c.phone || "—")}</td>
      <td>${esc(c.email || "—")}</td>
      <td>${esc(addr(c))}</td>
      <td>${projCount(c)}</td>
      ${!isEmployee() ? `<td>${balance(c)}</td>` : ""}
    </tr>`).join("");

  // phone: tap the card to open; phone number and email are tappable on their own
  const cards = sorted.map(c => mobCard({
    open: `data-open-client="${esc(c.id)}"`,
    title: `${esc(c.first_name)} ${esc(c.last_name)}`,
    right: isEmployee() ? "" : debtBadge(c.debt),
    sub: `${c.company_name ? `🏢 ${esc(c.company_name)}<br>` : ""}📍 ${esc(addr(c))}`,
    extra: `<div class="mob-card-row">
      ${c.phone ? `<a class="btn btn-sm" href="tel:${esc(c.phone)}" onclick="event.stopPropagation()">📞 ${esc(c.phone)}</a>` : ""}
      ${c.email ? `<a class="btn btn-sm" href="mailto:${esc(c.email)}" onclick="event.stopPropagation()">✉ Email</a>` : ""}
      <span class="inv-note">${projCount(c)} project(s)</span> ${renderApprovalBadge(c.approval_status)}</div>`,
  })).join("");

  return `
    <div class="list-tools">${filterBar}${sortSelect("clients", columns)}</div>
    <div class="data-card desktop-table-view">
      <div class="table-responsive">
        <table class="crm-table">
          <thead><tr>${Object.entries(columns).map(([k, [label]]) => sortTh("clients", k, label)).join("")}</tr></thead>
          <tbody>${rows || `<tr><td colspan="6" class="empty-state">${empty}</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    <div class="mobile-card-list">${cards || `<div class="data-card empty-state">${empty}</div>`}</div>`;
}

// One client: contact card, projects, Income & Expense, summary
function renderClientDetailView(clientId) {
  const c = state.clients.find(x => sameId(x.id, clientId));
  if (!c) return `<div class="empty-state">Client not found.</div>`;

  const clientProjects = state.projects.filter(p => sameId(p.client_id, c.id));
  const clientTasks = state.tasks.filter(t => sameId(t.client_id, c.id));

  $("pageTitle").textContent = c.name;
  $("breadcrumbs").innerHTML = `<button class="crumb-link" data-nav="clients">Clients</button> / <span>${esc(c.name)}</span> ${debtBadge(c.debt)}`;
  $("topbarActions").innerHTML = `
    <button class="btn" data-edit-client="${esc(c.id)}">✏️ Edit</button>
    ${!isEmployee() ? `<button class="btn btn-danger" data-delete-entity="clients" data-delete-id="${esc(c.id)}" data-back-view="clients">🗑 Delete</button>` : ""}
  `;

  const contactAddr = [c.street, c.city, c.state, c.zip].filter(Boolean).join(", ") || "No contact address set";

  return `
    ${renderApprovalBanner("client", c)}
    <div class="detail-grid">
      <div>
        <div class="section-card">
          <div class="section-header">
            <h2 class="section-title">Client Contact Information</h2>
          </div>
          <div class="form-grid">
            <div class="form-field"><label>First Name</label><div><strong>${esc(c.first_name || "—")}</strong></div></div>
            <div class="form-field"><label>Last Name</label><div><strong>${esc(c.last_name || "—")}</strong></div></div>
            <div class="form-field"><label>Company Name</label><div>${esc(c.company_name || "—")}</div></div>
            <div class="form-field"><label>Phone</label><div><a href="tel:${esc(c.phone)}">${esc(c.phone || "—")}</a></div></div>
            <div class="form-field"><label>Email</label><div><a href="mailto:${esc(c.email)}">${esc(c.email || "—")}</a></div></div>
            <div class="form-field wide"><label>Contact / Billing Address</label><div>📍 ${esc(contactAddr)}</div></div>
            <div class="form-field wide"><label>Client Notes</label><div>${esc(c.clean_notes || "No notes.")}</div></div>
          </div>
        </div>

        <div class="section-card">
          <div class="section-header">
            <h3 class="section-title">Client Projects (${clientProjects.length})</h3>
          </div>
          ${clientProjects.length === 0 ? `<p style="color:var(--secondary);">No projects for this client yet.</p>` : `
            <div class="table-responsive">
              <table class="crm-table">
                <thead><tr><th>Project Name</th><th>Work Address</th><th>Status</th><th>Tasks</th></tr></thead>
                <tbody>
                  ${clientProjects.map(p => {
                    const pTasks = clientTasks.filter(t => sameId(t.project_id, p.id));
                    const pAddr = [p.street, p.city, p.state, p.zip].filter(Boolean).join(", ") || "—";
                    return `<tr class="row-clickable" data-open-project="${esc(p.id)}">
                      <td><strong>${esc(p.name)}</strong> ${debtBadge(p.debt)} ${renderApprovalBadge(p.approval_status)}</td>
                      <td>📍 ${esc(pAddr)}</td>
                      <td>${renderStatusBadge(p.project_status)}</td>
                      <td>${pTasks.length} task(s)</td>
                    </tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>
          `}
        </div>

        ${!isEmployee() ? `
          <div class="section-card">
            <div class="section-header"><h3 class="section-title">Income &amp; Expense</h3></div>
            ${financeHost("client", c.id)}
          </div>
        ` : ""}
      </div>

      <div>
        <div class="section-card">
          <div class="section-header"><h3 class="section-title">Summary</h3></div>
          <div class="kpi-grid" style="grid-template-columns:1fr;">
            <div class="kpi-card">
              <div class="kpi-label">Total Projects</div>
              <div class="kpi-value">${clientProjects.length}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Total Working Hours</div>
              <div class="kpi-value">${c.total_hours || 0}h</div>
            </div>
            ${!isEmployee() ? `
              <div class="kpi-card">
                <div class="kpi-label">Unpaid Balance</div>
                <div class="kpi-value" style="color:${c.debt > 0 ? "var(--error-text)" : "var(--success-text)"};">${usd(c.debt)}</div>
              </div>
            ` : ""}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ==========================================================================
// 3. PROJECTS DIRECTORY & PROJECT DETAIL VIEW
// ==========================================================================

// Projects screen: all projects with client, address, status and hours
// task count and hours of each project (worked out once per draw)
function projectStats(p) {
  const tasks = state.tasks.filter(t => sameId(t.project_id, p.id));
  return {
    count: tasks.length,
    planned: +tasks.reduce((s, t) => s + t.planned_hours, 0).toFixed(2),
    actual: +tasks.reduce((s, t) => s + t.actual_hours, 0).toFixed(2),
  };
}

const PROJECT_COLUMNS = {
  name: ["Project", p => p.name],
  client: ["Client", p => p.client_name],
  address: ["Address", p => [p.city, p.street].join(" ")],
  status: ["Status", p => p.project_status],
  tasks: ["Tasks", p => p._stats.count],
  hours: ["Hours", p => p._stats.actual],
  debt: ["Unpaid", p => p.debt || 0],
};

function renderProjectsView() {
  const q = state.search.trim().toLowerCase();
  const columns = isEmployee() ? (({ debt, ...rest }) => rest)(PROJECT_COLUMNS) : PROJECT_COLUMNS;
  const list = sortRows(state.projects
    .filter(p => !q || [p.name, p.client_name, p.street, p.city, p.clean_description]
      .some(v => String(v || "").toLowerCase().includes(q)))
    .map(p => ({ ...p, _stats: projectStats(p) })), "projects", columns);
  const addr = p => [p.street, p.city, p.state, p.zip].filter(Boolean).join(", ") || "—";

  const rows = list.map(p => `<tr class="row-clickable" data-open-project="${esc(p.id)}">
      <td><div style="font-weight:600;color:var(--dark);">${esc(p.name)}</div>${renderApprovalBadge(p.approval_status)}</td>
      <td><button class="crumb-link" data-open-client="${esc(p.client_id)}" onclick="event.stopPropagation()">${esc(p.client_name)}</button></td>
      <td>📍 ${esc(addr(p))}</td>
      <td>${renderStatusBadge(p.project_status)}</td>
      <td>${p._stats.count}</td>
      <td><strong>${p._stats.actual}h</strong> / ${p._stats.planned}h</td>
      ${!isEmployee() ? `<td>${debtBadge(p.debt) || `<span class="inv-note">—</span>`}</td>` : ""}
    </tr>`).join("");

  const cards = list.map(p => mobCard({
    open: `data-open-project="${esc(p.id)}"`,
    title: esc(p.name),
    right: debtBadge(p.debt),
    sub: `👤 ${esc(p.client_name)}<br>📍 ${esc(addr(p))}`,
    extra: `<div class="mob-card-row">${renderStatusBadge(p.project_status)} ${renderApprovalBadge(p.approval_status)}
              <span class="inv-note">${p._stats.count} tasks · ${p._stats.actual}h / ${p._stats.planned}h</span></div>`,
  })).join("");

  return `
    <div class="mobile-only list-tools">${sortSelect("projects", columns)}</div>
    <div class="data-card desktop-table-view">
      <div class="table-responsive">
        <table class="crm-table">
          <thead><tr>${Object.entries(columns).map(([k, [label]]) => sortTh("projects", k, label)).join("")}</tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="empty-state">No projects found.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    <div class="mobile-card-list">${cards || `<div class="data-card empty-state">No projects found.</div>`}</div>`;
}

// One project: header with KPIs + tabs (Overview, Tasks, Estimate, Invoices, Expenses, Photos)
function renderProjectDetailView(projectId) {
  const p = state.projects.find(x => sameId(x.id, projectId));
  if (!p) return `<div class="empty-state">Project not found.</div>`;

  const pTasks = getRoleFilteredTasks().filter(t => sameId(t.project_id, p.id));
  const allPTasks = state.tasks.filter(t => sameId(t.project_id, p.id));
  const pInvoices = state.invoices.filter(i => sameId(i.project_id, p.id));
  const pReceipts = state.receipts.filter(r => sameId(r.project_id, p.id));

  const plannedHours = allPTasks.reduce((s, t) => s + t.planned_hours, 0);
  const actualHours = allPTasks.reduce((s, t) => s + t.actual_hours, 0);
  const completedTasks = allPTasks.filter(t => t.status === "Completed").length;
  const progressPct = allPTasks.length ? Math.round((completedTasks / allPTasks.length) * 100) : 0;

  // newest estimate (documents come newest first) vs. everything invoiced so far
  const estValue = Number(pInvoices.find(i => i.is_estimate)?.total || 0);
  const invoicedValue = pInvoices.filter(i => !i.is_estimate).reduce((s, i) => s + Number(i.total || 0), 0);

  $("pageTitle").textContent = p.name;
  $("breadcrumbs").innerHTML = `
    <button class="crumb-link" data-open-client="${esc(p.client_id)}">${esc(p.client_name)}</button>
    ${debtBadge(state.clients.find(c => sameId(c.id, p.client_id))?.debt)} /
    <span>${esc(p.name)}</span> ${debtBadge(p.debt)}
  `;
  $("topbarActions").innerHTML = `
    <button class="btn" data-edit-project="${esc(p.id)}">✏️ Edit</button>
    ${!isEmployee() ? `<button class="btn btn-danger" data-delete-entity="projects" data-delete-id="${esc(p.id)}" data-back-view="projects">🗑 Delete</button>` : ""}
  `;

  const workAddr = [p.street, p.city, p.state, p.zip].filter(Boolean).join(", ") || "No job-site work address set";

  const tabs = [
    ["overview", "Overview"],
    ["tasks", `Tasks (${pTasks.length})`],
    ...(!isEmployee() ? [["documents", `Estimates & Invoices (${pInvoices.length})`]] : []),
    ["expenses", `Expenses (${pReceipts.length})`],
    ["photos", "Photos"],
  ].map(([k, label]) =>
    `<button class="tab-btn ${state.projectTab === k ? "active" : ""}" data-proj-tab="${k}">${esc(label)}</button>`
  ).join("");

  let tabContent = "";
  if (state.projectTab === "overview") {
    tabContent = `
      <div class="section-card">
        <div class="section-header"><h3 class="section-title">Project Info</h3></div>
        <p style="margin-bottom:16px;color:var(--dark);white-space:pre-wrap;">${esc(p.clean_description || "No project description provided.")}</p>
        <div style="margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:600;margin-bottom:6px;">
            <span>Task Completion Progress (${completedTasks}/${allPTasks.length})</span>
            <span>${progressPct}%</span>
          </div>
          <div style="height:10px;background:var(--surface);border-radius:999px;overflow:hidden;border:1px solid var(--border);">
            <div style="height:100%;width:${progressPct}%;background:var(--success);"></div>
          </div>
        </div>
        <button class="btn btn-primary" data-proj-tab="tasks">View All Project Tasks →</button>
      </div>
    `;
  } else if (state.projectTab === "tasks") {
    tabContent = `
      <div class="section-card">
        <div class="section-header">
          <h3 class="section-title">Project Tasks</h3>
        </div>
        ${pTasks.length === 0 ? `<p style="color:var(--secondary);">No tasks in this project yet.</p>` : `
          <div class="table-responsive">
            <table class="crm-table">
              <thead><tr><th>Task</th><th>Schedule</th><th>Assignee</th><th>Priority</th><th>Status</th><th>Hours</th></tr></thead>
              <tbody>
                ${pTasks.map(t => `
                  <tr class="row-clickable" data-open-task="${esc(t.id)}">
                    <td><strong>${esc(t.title)}</strong> ${renderApprovalBadge(t.approval_status)}</td>
                    <td>${esc(formatDueDateLabel(t))}</td>
                    <td>${esc(t.assigned_name)}</td>
                    <td>${renderPriorityBadge(t.priority)}</td>
                    <td>${renderStatusBadge(t.status)}</td>
                    <td><strong>${t.actual_hours}h</strong> / ${t.planned_hours}h</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;
  } else if (state.projectTab === "documents" && !isEmployee()) {
    tabContent = renderDocumentsTable(pInvoices);
  } else if (state.projectTab === "expenses") {
    tabContent = renderReceiptsTableCard(pReceipts);
  } else if (state.projectTab === "photos") {
    const allPhotos = allPTasks.flatMap(t => (t.image_urls || []).map(u => ({ url: u, taskTitle: t.title })));
    tabContent = `
      <div class="section-card">
        <div class="section-header">
          <h3 class="section-title">Project Photos (${allPhotos.length})</h3>
        </div>
        <div class="photo-grid">
          ${allPhotos.map(ph => `
            <span class="thumb" title="${esc(ph.taskTitle)}">
              <img src="${esc(ph.url)}" alt="Project photo" data-lightbox="${esc(ph.url)}">
            </span>
          `).join("") || `<p style="color:var(--secondary);">No task photos uploaded for this project yet.</p>`}
        </div>
      </div>
    `;
  }

  return `
    ${renderApprovalBanner("project", p)}
    <div class="section-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
        <div>
          <h2 style="font-size:22px;font-weight:700;">${esc(p.name)} ${debtBadge(p.debt)}</h2>
          <div style="color:var(--secondary);margin-top:2px;">Client: <button class="crumb-link" data-open-client="${esc(p.client_id)}">${esc(p.client_name)}</button></div>
          <div style="font-size:14px;margin-top:6px;">📍 <strong>Work Address:</strong> ${esc(workAddr)}</div>
        </div>
        ${renderStatusBadge(p.project_status)}
      </div>

      <div class="kpi-grid" style="margin-top:18px;margin-bottom:0;">
        <div class="kpi-card">
          <div class="kpi-label">Tasks</div>
          <div class="kpi-value">${allPTasks.length}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Working Hours</div>
          <div class="kpi-value">${actualHours}h <span style="font-size:14px;color:var(--secondary);font-weight:400;">/ ${plannedHours}h plan</span></div>
        </div>
        ${!isEmployee() ? `
          <div class="kpi-card">
            <div class="kpi-label">Estimate</div>
            <div class="kpi-value">${usd(estValue)}</div>
          </div>
          <div class="kpi-card" style="background:var(--success-bg);border-color:#BBF7D0;">
            <div class="kpi-label" style="color:var(--success-text);">Invoiced</div>
            <div class="kpi-value" style="color:var(--success-text);">${usd(invoicedValue)}</div>
          </div>
        ` : ""}
      </div>
    </div>

    <div class="tabs-bar">${tabs}</div>
    ${tabContent}
  `;
}

// ==========================================================================
// 4. FINANCIAL VIEWS (Estimates, Invoices, Expenses) — Hidden from Employees
// ==========================================================================






// [ Unpaid ] <-> [ Paid ] in one tap (the server sets / clears the paid date in the business time zone)
const payToggle = i => `
  <button class="pay-toggle ${i.status === "Paid" ? "paid" : "unpaid"}" data-toggle-inv-paid="${esc(i.id)}"
    data-cur-status="${esc(i.status)}" title="Tap to mark ${i.status === "Paid" ? "Unpaid" : "Paid"}">
    ${i.status === "Paid" ? `✓ Paid${i.paid_date ? ` <small>${esc(i.paid_date)}</small>` : ""}` : "Unpaid"}
  </button>`;

// The invoice made from an estimate (or undefined)
const invoiceFromEstimate = est => state.invoices.find(i => sameId(i.estimate_id, est.id));

// Buttons of one document: Open (edit lines) · PDF · Send · Convert · delete.
// Manager invoices can't be sent until the Owner approves them (approvals switch on).
function documentActions(d) {
  const pending = !d.is_estimate && d.approval_status === "PendingApproval";
  const converted = d.is_estimate && invoiceFromEstimate(d);
  return `<div class="inv-actions">
    <button class="btn btn-sm" data-open-doc="${esc(d.id)}">Open</button>
    <button class="btn btn-sm" data-pdf="${esc(d.id)}">View</button>
    <button class="btn btn-sm" data-pdf="${esc(d.id)}" data-download="1">PDF</button>
    ${pending
      ? (isOwner() ? `<button class="btn btn-sm btn-success" data-approve-kind="invoice" data-approve-id="${esc(d.id)}">Approve</button>`
                   : `<span class="inv-note">Waiting for Owner</span>`)
      : `<button class="btn btn-sm btn-primary" data-send-invoice="${esc(d.id)}">Send</button>`}
    ${d.is_estimate && !converted ? `<button class="btn btn-sm btn-success" data-convert-estimate="${esc(d.id)}">→ Invoice</button>` : ""}
    <button class="btn btn-sm btn-danger" data-delete-entity="invoices" data-delete-id="${esc(d.id)}"
      title="Delete (receipts on it become billable again)">🗑</button>
  </div>
  ${converted ? `<div class="inv-note">Invoiced as ${esc(converted.invoice_number)}</div>` : ""}
  ${d.sent_to_client ? `<div class="inv-note">✉ Sent${d._meta.sent_date ? ` ${esc(d._meta.sent_date)}` : ""}</div>` : ""}`;
}

// Estimates & invoices table (Money tab, project tab). Unpaid invoices get the red/amber row.
const DOCUMENT_COLUMNS = {
  number: ["Document", d => d.invoice_number],
  client: ["Client / Project", d => `${d.client_name} ${d.project_name}`],
  date: ["Date", d => d.invoice_date || ""],
  total: ["Total", d => Number(d.total) || 0],
  status: ["Payment", d => (d.is_estimate ? "3" : d.status === "Unpaid" ? "1" : "2")],   // unpaid first
};

function renderDocumentsTable(input) {
  const list = sortRows(input, "documents", DOCUMENT_COLUMNS);
  const kind = d => `<span class="badge ${d.is_estimate ? "badge-estimate" : "badge-invoice"}">${d.is_estimate ? "Estimate" : "Invoice"}</span>`;
  const cards = list.map(d => mobCard({
    cls: !d.is_estimate && d.status === "Unpaid" ? "row-unpaid" : "",
    title: `${kind(d)} #${esc(d.invoice_number)}`,
    right: `<strong>${usd(d.total)}</strong>`,
    sub: `${esc(d.client_name)} · ${esc(d.project_name)} · ${esc(d.invoice_date)}`,
    extra: `<div class="mob-card-row">${d.is_estimate ? "" : payToggle(d)} ${renderApprovalBadge(d.approval_status)}</div>${documentActions(d)}`,
  })).join("");
  const empty = `Nothing yet. Tap <strong>+ New → Estimate</strong> or <strong>Invoice</strong>.`;
  return documentsTableHtml(list, empty) +
    `<div class="mobile-card-list">${cards || `<div class="data-card empty-state">${empty}</div>`}</div>`;
}

// desktop table of documents (rows already sorted)
function documentsTableHtml(list, empty) {
  const rows = list.map(d => `
    <tr class="${!d.is_estimate && d.status === "Unpaid" ? "row-unpaid" : ""}">
      <td><span class="badge ${d.is_estimate ? "badge-estimate" : "badge-invoice"}">${d.is_estimate ? "Estimate" : "Invoice"}</span>
        <div><strong>#${esc(d.invoice_number)}</strong></div></td>
      <td>${esc(d.client_name)}<div style="font-size:12px;color:var(--secondary);">${esc(d.project_name)}</div></td>
      <td>${esc(d.invoice_date)}</td>
      <td><strong>${usd(d.total)}</strong></td>
      <td>${d.is_estimate ? `<span class="inv-note">—</span>` : payToggle(d)}
        <div style="margin-top:4px;">${renderApprovalBadge(d.approval_status)}</div></td>
      <td>${documentActions(d)}</td>
    </tr>`).join("");
  return `
    <div class="data-card desktop-table-view">
      <div class="table-responsive">
        <table class="crm-table">
          <thead><tr>${Object.entries(DOCUMENT_COLUMNS).map(([k, [label]]) => sortTh("documents", k, label)).join("")}<th>Actions</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6" class="empty-state">${empty}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}

// Task screen: invoices that bill this task (read-only list + payment toggle)
function renderTaskDocumentsCard(t) {
  const list = state.invoices.filter(i => !i.is_estimate && i.visit_ids.some(v => sameId(v, t.id)));
  return `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">🧾 Invoice</h3></div>
      ${list.map(i => `
        <div class="inv-mini ${i.status === "Unpaid" ? "row-unpaid" : ""}">
          <div class="inv-mini-head">
            <div><strong>#${esc(i.invoice_number)}</strong> <span class="inv-note">${esc(i.invoice_date)}</span>
              ${renderApprovalBadge(i.approval_status)}</div>
            <strong>${usd(i.total)}</strong>
          </div>
          <div style="margin:8px 0;">${payToggle(i)}</div>
          ${documentActions(i)}
        </div>`).join("") || `<p style="font-size:13px;color:var(--secondary);">Not invoiced yet. Use <strong>+ New → Invoice</strong>.</p>`}
    </div>`;
}

// Money screen: tabs. Employees see only their own receipts.
function renderMoneyView() {
  const tabs = isEmployee() ? [["expenses", "My Expenses"]]
    : [["documents", `Estimates & Invoices (${state.invoices.length})`], ["expenses", `Expenses (${state.receipts.length})`],
       ["reports", "Reports"]];
  if (!tabs.some(([k]) => k === state.moneyTab)) state.moneyTab = tabs[0][0];
  const bar = tabs.length > 1 ? `<div class="tabs-bar">${tabs.map(([k, label]) =>
    `<button class="tab-btn ${state.moneyTab === k ? "active" : ""}" data-money-tab="${k}">${esc(label)}</button>`).join("")}</div>` : "";
  // head = tabs + filters, pinned under the top bar while the list scrolls; body = the list
  let head, body;
  if (state.moneyTab === "documents") {
    const list = filterMoney(state.invoices, "documents");
    const sum = list.filter(d => !d.is_estimate).reduce((s, d) => s + Number(d.total || 0), 0);
    const unpaid = list.filter(d => !d.is_estimate && d.status === "Unpaid").reduce((s, d) => s + Number(d.total || 0), 0);
    head = moneyToolbar("documents");
    body = renderDocumentsTable(list) +
      `<p class="money-total">${list.length} shown · invoiced <strong>${usd(sum)}</strong> · unpaid <strong style="color:var(--error-text);">${usd(unpaid)}</strong></p>`;
  } else if (state.moneyTab === "reports") {
    ({ head, body } = renderReportsScreen());
  } else {
    const list = filterMoney(state.receipts, "expenses");
    const sum = list.reduce((s, r) => s + Number(r.amount || 0), 0);
    head = moneyToolbar("expenses");
    body = renderReceiptsTableCard(list) + `<p class="money-total">${list.length} shown · total <strong>${usd(sum)}</strong></p>`;
  }
  return `<div class="sticky-head">${bar}${head}</div>${body}`;
}

// ==========================================================================
// REPORTS (Money > Reports). The server computes the rows (reports.py); everything you adjust here -
// filters, grouping, columns, sorting - happens instantly in the browser on those rows.
//   Overview: 5 blocks · Income · Expenses · Who owes me · Job profit · Team hours
// Rules: income = paid invoices by paid date; "who owes me" is as of today; profit subtracts labor cost
// (hours x each person's cost per hour, Owner only).
// ==========================================================================
const REPORT_KINDS = [["overview", "Overview"], ["income", "Income"], ["expenses", "Expenses"],
                      ["debts", "Who owes me"], ["jobs", "Job profit"], ["team", "Team hours"]];
const REPORT_PRESETS = [["month", "This month"], ["last-month", "Last month"], ["quarter", "This quarter"],
                        ["year", "This year"], ["custom", "Custom"]];
// default sort of each report table
const REPORT_SORT = { income: ["date", "desc"], expenses: ["date", "desc"], debts: ["days", "desc"],
                      jobs: ["paid", "desc"], team: ["date", "desc"] };
// columns that make no sense to add up in subtotals
const NO_SUM = new Set(["days", "days_to_pay", "per_hour", "over_pct", "estimate", "vs_estimate"]);

let reportCache = {};   // "kind|start|end" -> data from the server (cleared on every sync)

// The chosen period + the one just before it (for the ▲▼ comparison)
function reportPeriod() {
  const r = state.report, now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const range = (a, b) => ({ start: isoDate(a), end: isoDate(b) });
  let cur, prev;
  if (r.preset === "last-month") {
    cur = range(new Date(y, m - 1, 1), new Date(y, m, 0)); prev = range(new Date(y, m - 2, 1), new Date(y, m - 1, 0));
  } else if (r.preset === "quarter") {
    const q = Math.floor(m / 3) * 3;
    cur = range(new Date(y, q, 1), new Date(y, q + 3, 0)); prev = range(new Date(y, q - 3, 1), new Date(y, q, 0));
  } else if (r.preset === "year") {
    cur = range(new Date(y, 0, 1), new Date(y, 11, 31)); prev = range(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31));
  } else if (r.preset === "custom") {
    cur = { start: r.start, end: r.end };
    if (r.start && r.end) {   // the same number of days right before
      const a = new Date(r.start), b = new Date(r.end), days = Math.round((b - a) / 86400000) + 1;
      prev = range(new Date(a.getFullYear(), a.getMonth(), a.getDate() - days), new Date(a.getFullYear(), a.getMonth(), a.getDate() - 1));
    } else prev = { start: "", end: "" };
  } else {   // this month
    cur = range(new Date(y, m, 1), new Date(y, m + 1, 0)); prev = range(new Date(y, m - 1, 1), new Date(y, m, 0));
  }
  return { ...cur, prevStart: prev.start, prevEnd: prev.end };
}

const reportKey = () => { const p = reportPeriod(); return `${state.report.kind}|${p.start}|${p.end}`; };

function renderReportsScreen() {
  const r = state.report;
  const nav = REPORT_KINDS.map(([k, label]) =>
    `<button class="tab-btn ${r.kind === k ? "active" : ""}" data-report-kind="${k}">${label}</button>`).join("");
  const presets = REPORT_PRESETS.map(([k, label]) =>
    `<button class="filter-chip ${r.preset === k ? "active" : ""}" data-report-preset="${k}">${label}</button>`).join("");
  const data = reportCache[reportKey()];
  const table = data && r.kind !== "overview" ? renderReportTable(data) : null;
  const body = !data
    ? `<div data-report-host class="loading-state"><div class="spinner"></div><p>Loading report...</p></div>`
    : table ? table.body : renderOverview(data);
  // head (pinned while scrolling): report choice + period + the report's own tools
  const head = `
    <div class="tabs-bar report-nav">${nav}</div>
    <div class="toolbar-card report-period">
      <div class="chip-row period-chips">${presets}</div>
      ${r.preset === "custom" ? `<div class="fin-filter" style="margin:8px 0 0;">
        <label>From <input type="date" class="form-input" data-report-date="start" value="${esc(r.start)}"></label>
        <label>To <input type="date" class="form-input" data-report-date="end" value="${esc(r.end)}"></label></div>` : ""}
    </div>
    ${table ? table.head : ""}`;
  return { head, body };
}

// After drawing: load the report if it isn't in the cache yet, then draw again
async function hydrateReports() {
  if (!document.querySelector("[data-report-host]")) return;
  const key = reportKey(), p = reportPeriod();
  try {
    const q = new URLSearchParams({ start: p.start || "", end: p.end || "", prev_start: p.prevStart || "", prev_end: p.prevEnd || "" });
    reportCache[key] = await api("GET", `/reports/${state.report.kind}?${q}`);
  } catch (e) {
    const host = document.querySelector("[data-report-host]");
    if (host) host.innerHTML = `<p style="color:var(--error-text);">${esc(e.message)}</p>`;
    return;
  }
  if (state.view === "money" && state.moneyTab === "reports" && reportKey() === key) renderCurrentView();
}

// ---------- Overview: 5 blocks ----------
// "+12%" / "−5%" compared with the previous period
function delta(cur, prev, goodWhenUp = true) {
  if (prev === undefined || prev === null || !prev) return "";
  const pct = Math.round((cur - prev) / Math.abs(prev) * 100);
  if (!pct) return `<span class="delta">= same as before</span>`;
  const good = (pct > 0) === goodWhenUp;
  return `<span class="delta ${good ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs. previous</span>`;
}

const monthName = ym => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1).toLocaleString("en-US", { month: "short" });

function renderOverview(o) {
  const c = o.current, p = o.previous || {};
  const card = (label, value, extra, color) =>
    `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value"${color ? ` style="color:${color};"` : ""}>${value}</div><div class="kpi-sub">${extra}</div></div>`;
  const signed = n => (n < 0 ? "−" : "") + usd(Math.abs(n));
  const more = (kind, label) => `<button class="btn btn-sm" data-report-kind="${kind}">${label} →</button>`;

  // 1. making money
  const money = `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">Am I making money?</h3></div>
      <div class="kpi-grid">
        ${card("Revenue (paid)", usd(c.revenue), delta(c.revenue, p.revenue), "var(--success-text)")}
        ${card("Expenses (receipts)", usd(c.expenses), delta(c.expenses, p.expenses, false), "")}
        ${o.with_cost ? card("Labor cost", usd(c.labor), delta(c.labor, p.labor, false), "") : ""}
        ${card(o.with_cost ? "Net profit" : "Profit before labor", signed(c.net), delta(c.net, p.net),
               c.net < 0 ? "var(--error-text)" : "var(--primary)")}
      </div>
    </div>`;

  // 2. who owes me
  const maxBucket = Math.max(1, ...Object.values(o.owed.buckets));
  const owed = `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">Who owes me? <small class="inv-note">as of today</small></h3>${more("debts", "All debts")}</div>
      <div class="owed-total" style="color:${o.owed.total ? "var(--error-text)" : "var(--success-text)"};">${usd(o.owed.total)}</div>
      <div class="owed-buckets">${Object.entries(o.owed.buckets).map(([b, v]) => `
        <div class="owed-bucket"><span>${b}</span><div class="bar"><div style="width:${v / maxBucket * 100}%;"></div></div><strong>${usd(v)}</strong></div>`).join("")}</div>
      ${o.owed.debtors.slice(0, 6).map(d => `
        <div class="debtor" data-open-client="${esc(d.client_id)}"><span>${esc(d.client)}</span>
          <span class="inv-note">${d.days} days</span><strong>${usd(d.amount)}</strong></div>`).join("") ||
        `<p class="inv-note">Nobody owes you money. 🎉</p>`}
    </div>`;

  // 3. trend, 12 months
  const top = Math.max(1, ...o.trend.flatMap(t => [t.income, t.expenses]));
  const trend = `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">Last 12 months</h3>
        <span class="legend"><i class="lg-in"></i> income <i class="lg-out"></i> expenses${o.with_cost ? " + labor" : ""}</span></div>
      <div class="trend">${o.trend.map(t => `
        <div class="trend-col" title="${monthName(t.month)}: income ${usd(t.income)}, expenses ${usd(t.expenses)}">
          <div class="trend-bars"><div class="b-in" style="height:${t.income / top * 100}%;"></div><div class="b-out" style="height:${t.expenses / top * 100}%;"></div></div>
          <span>${monthName(t.month)}</span></div>`).join("")}</div>
    </div>`;

  // 4. jobs: best 5 and (if there are many) the worst 3
  const jobs = o.jobs.length > 8 ? [...o.jobs.slice(0, 5), null, ...o.jobs.slice(-3)] : o.jobs;
  const jobsTable = `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">Which jobs pay off?</h3>${more("jobs", "All jobs")}</div>
      <div class="table-responsive"><table class="crm-table">
        <thead><tr><th>Project</th><th>Paid</th><th>Materials</th><th>Hours</th>${o.with_cost ? "<th>Labor</th><th>Profit</th>" : ""}<th>$ / hour</th></tr></thead>
        <tbody>${jobs.map(j => j === null ? `<tr><td colspan="7" class="inv-note" style="text-align:center;">… lowest …</td></tr>` : `
          <tr class="row-clickable" data-open-project="${esc(j.project_id)}">
            <td><strong>${esc(j.project)}</strong><div class="inv-note">${esc(j.client)}</div></td>
            <td>${usd(j.paid)}</td><td>${usd(j.materials)}</td><td>${+j.hours.toFixed(2)}</td>
            ${o.with_cost ? `<td>${usd(j.labor_cost)}</td><td style="color:${j.profit < 0 ? "var(--error-text)" : "inherit"};"><strong>${signed(j.profit)}</strong></td>` : ""}
            <td>${j.per_hour === null ? "—" : usd(j.per_hour)}</td></tr>`).join("") ||
          `<tr><td colspan="7" class="empty-state">No paid work, receipts or hours in this period.</td></tr>`}</tbody>
      </table></div>
    </div>`;

  // 5. team
  const team = `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">Team</h3>${more("team", "Details")}</div>
      <div class="table-responsive"><table class="crm-table">
        <thead><tr><th>Employee</th><th>Tasks done</th><th>Hours (actual / planned)</th><th>Over plan</th>${o.with_cost ? "<th>Labor cost</th>" : ""}</tr></thead>
        <tbody>${o.team.map(t => `<tr><td><strong>${esc(t.employee)}</strong></td><td>${t.done}</td>
          <td>${t.actual}h / ${t.planned}h</td>
          <td style="color:${(t.over_pct || 0) > 10 ? "var(--warning-text)" : "inherit"};">${t.over_pct === null ? "—" : `${t.over_pct > 0 ? "+" : ""}${t.over_pct}%`}</td>
          ${o.with_cost ? `<td>${usd(t.labor_cost)}</td>` : ""}</tr>`).join("") ||
          `<tr><td colspan="5" class="empty-state">No hours in this period.</td></tr>`}</tbody>
      </table></div>
      ${o.with_cost && state.team.some(m => m.active && !m.hourly_cost)
        ? `<p class="inv-note" style="margin-top:8px;">Tip: set each person's cost per hour in Settings → Team for real labor cost.</p>` : ""}
    </div>`;

  return `${money}<div class="report-two">${owed}${trend}</div>${jobsTable}${team}`;
}

// ---------- Detailed report: filters · group by · columns · sortable table · totals · CSV / PDF ----------
const REPORT_FILTERS = [   // [row key with the id, label, row key with the name]
  ["client_id", "Client", "client"], ["project_id", "Project", "project"], ["member_id", "Employee", null],
  ["category", "Category", "category"], ["type", "Type", "type"], ["status", "Status", "status"], ["bucket", "Age", "bucket"],
];

function reportColumns(d) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(`hcrm_rep_cols_${d.kind}`) || "null"); } catch { saved = null; }
  return d.columns.filter(c => (saved ? saved.includes(c.key) : c.default));
}

function fmtCell(c, v) {
  if (v === null || v === undefined || v === "") return "—";
  if (c.type === "money") return usd(v);
  if (c.type === "percent") return `${v > 0 ? "+" : ""}${v}%`;
  if (c.type === "number") return String(+Number(v).toFixed(2));
  return String(v);
}

// filters -> rows; then sort; then groups with subtotals. Returns what both the screen and the files show.
function buildReport(d) {
  const r = state.report;
  const cols = reportColumns(d);
  const sortId = `rep-${d.kind}`;
  if (!state.sorts[sortId]) state.sorts[sortId] = { key: REPORT_SORT[d.kind][0], dir: REPORT_SORT[d.kind][1] };
  const q = state.search.trim().toLowerCase();
  let rows = d.rows.filter(row =>
    Object.entries(r.filters).every(([k, v]) => !v || String(row[k] ?? "") === v) &&
    (!q || Object.values(row).some(v => String(v ?? "").toLowerCase().includes(q))));
  const sortCols = Object.fromEntries(d.columns.map(c => [c.key, [c.label, row => row[c.key] ?? (c.type === "text" ? "" : -1e15)]]));
  rows = sortRows(rows, sortId, sortCols);

  const sum = list => Object.fromEntries(cols.filter(c => (c.type === "money" || c.type === "number") && !NO_SUM.has(c.key))
    .map(c => [c.key, list.reduce((s, x) => s + (Number(x[c.key]) || 0), 0)]));
  const groups = [];
  if (r.group) {
    const by = {};
    rows.forEach(x => (by[x[r.group] || "—"] ||= []).push(x));
    Object.keys(by).sort().forEach(g => groups.push({ label: g, rows: by[g], sums: sum(by[g]) }));
  }
  return { cols, rows, groups, total: sum(rows), sortCols };
}

function renderReportTable(d) {
  const r = state.report;
  const { cols, rows, groups, total } = buildReport(d);
  const sortId = `rep-${d.kind}`;

  // filter dropdowns: only those this report has values for
  const filters = REPORT_FILTERS.map(([key, label, nameKey]) => {
    const opts = new Map();
    d.rows.forEach(x => { if (x[key]) opts.set(x[key], nameKey ? x[nameKey] : (x.employee || x.entered_by || x[key])); });
    if (opts.size < 2 && !r.filters[key]) return "";
    return `<select class="filter-select" data-report-filter="${key}"><option value="">All ${label.toLowerCase()}s</option>${
      [...opts.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])))
        .map(([v, l]) => `<option value="${esc(v)}" ${r.filters[key] === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  }).join("");
  const groupSel = `<select class="filter-select" data-report-group="1"><option value="">No grouping</option>${
    d.groups.map(g => `<option value="${g.key}" ${r.group === g.key ? "selected" : ""}>Group by ${g.label.toLowerCase()}</option>`).join("")}</select>`;
  const colPicker = r.showCols ? `<div class="col-picker">${d.columns.map(c => `
    <label><input type="checkbox" data-rep-col="${c.key}" ${cols.some(x => x.key === c.key) ? "checked" : ""}> ${esc(c.label)}</label>`).join("")}
    <button class="btn btn-sm" data-rep-cols-reset="1">Default columns</button></div>` : "";

  const td = (c, x) => `<td style="text-align:${c.align};">${esc(fmtCell(c, x[c.key]))}</td>`;
  const sumRow = (sums, label, cls) => `<tr class="${cls}">${cols.map((c, i) =>
    `<td style="text-align:${c.align};">${i === 0 ? label : (c.key in sums ? esc(fmtCell(c, sums[c.key])) : "")}</td>`).join("")}</tr>`;
  const link = x => x.project_id ? `data-open-project="${esc(x.project_id)}" class="row-clickable"` : "";
  const body = groups.length
    ? groups.map(g => `<tr class="rep-group"><td colspan="${cols.length}">${esc(g.label)} <span class="inv-note">(${g.rows.length})</span></td></tr>
        ${g.rows.map(x => `<tr ${link(x)}>${cols.map(c => td(c, x)).join("")}</tr>`).join("")}
        ${sumRow(g.sums, "Subtotal", "rep-subtotal")}`).join("")
    : rows.map(x => `<tr ${link(x)}>${cols.map(c => td(c, x)).join("")}</tr>`).join("");

  // phone: one card per row (first column as title, the rest as "label: value")
  const lastMoney = [...cols].reverse().find(c => c.type === "money");   // shown big on the right of the card
  const cards = rows.map(x => mobCard({
    title: esc(fmtCell(cols[0], x[cols[0].key])),
    right: lastMoney ? `<strong>${esc(fmtCell(lastMoney, x[lastMoney.key]))}</strong>` : "",
    sub: cols.slice(1).filter(c => c !== lastMoney)
      .map(c => `${esc(c.label)}: <strong>${esc(fmtCell(c, x[c.key]))}</strong>`).join(" · "),
  })).join("");

  // head = the pinned tools (phone: filters fold behind a button); body = the table / cards
  const activeFilters = Object.values(r.filters).filter(Boolean).length + (r.group ? 1 : 0);
  const head = `
    <div class="toolbar-card report-tools">
      <div class="fin-filter" style="margin:0;">
        <input type="search" class="form-input" data-money-search="1" placeholder="🔍 Search this report..." value="${esc(state.search)}">
        <button class="btn btn-sm mobile-only ${activeFilters ? "btn-primary" : ""}" data-money-more="1">
          ⚙ Filters &amp; download${activeFilters ? ` (${activeFilters})` : ""}</button>
        <div class="money-more ${state.moneyMore ? "open" : ""}">
          ${filters}${groupSel}
          <button class="btn btn-sm" data-rep-cols-toggle="1">⚙ Columns</button>
          ${sortSelect(sortId, Object.fromEntries(cols.map(c => [c.key, [c.label]])))}
          <span class="fin-export">Download: <button class="btn btn-sm" data-rep-export="csv">CSV</button>
            <button class="btn btn-sm" data-rep-export="pdf">PDF</button></span>
        </div>
      </div>
      ${colPicker}
      ${d.as_of_today ? `<p class="inv-note" style="margin-top:8px;">Unpaid invoices as of today — the period above doesn't change this list.</p>` : ""}
    </div>`;
  return { head, body: `
    <div class="data-card desktop-table-view">
      <div class="table-responsive"><table class="crm-table report-table">
        <thead><tr>${cols.map(c => sortTh(sortId, c.key, c.label)).join("")}</tr></thead>
        <tbody>${body || `<tr><td colspan="${cols.length}" class="empty-state">Nothing in this period.</td></tr>`}</tbody>
        <tfoot>${rows.length ? sumRow(total, `Total (${rows.length})`, "rep-total") : ""}</tfoot>
      </table></div>
    </div>
    <div class="mobile-card-list">${cards || `<div class="data-card empty-state">Nothing in this period.</div>`}
      ${rows.length ? `<div class="mob-card rep-total-card">${cols.filter(c => c.key in total)
        .map(c => `<div>${esc(c.label)}: <strong>${esc(fmtCell(c, total[c.key]))}</strong></div>`).join("")}</div>` : ""}</div>` };
}

// The visible table as plain text rows (for CSV and PDF): group headers, rows, subtotals, total
function reportExportRows(d) {
  const { cols, rows, groups, total } = buildReport(d);
  const line = x => ({ kind: "row", cells: cols.map(c => fmtCell(c, x[c.key])) });
  const sums = (s, label, kind) => ({ kind, cells: cols.map((c, i) => (i === 0 ? label : c.key in s ? fmtCell(c, s[c.key]) : "")) });
  const out = groups.length
    ? groups.flatMap(g => [{ kind: "group", cells: [g.label] }, ...g.rows.map(line), sums(g.sums, "Subtotal", "subtotal")])
    : rows.map(line);
  if (rows.length) out.push(sums(total, `Total (${rows.length})`, "total"));
  return { cols, out };
}

async function exportReport(format) {
  const d = reportCache[reportKey()];
  if (!d) return;
  const { cols, out } = reportExportRows(d);
  const p = reportPeriod();
  const label = REPORT_KINDS.find(([k]) => k === d.kind)[1];
  const period = d.as_of_today ? `as of ${todayStr()}` : (p.start || p.end ? `${p.start || "…"} to ${p.end || "…"}` : "All time");
  const name = `${label.toLowerCase().replace(/\s+/g, "-")}_${p.start || "all"}_${p.end || ""}`;
  if (format === "csv") {
    const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [[`${label} report`, period], [], cols.map(c => c.label), ...out.map(r => r.cells)]
      .map(r => r.map(q).join(",")).join("\r\n");
    return saveBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `${name}.csv`);
  }
  setSave("saving");
  try {
    const res = await authedFetch("/reports/pdf", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `${label} report`, subtitle: period, columns: cols.map(c => ({ label: c.label, align: c.align })), rows: out }),
    });
    if (!res.ok) throw await failure(res);
    saveBlob(await res.blob(), `${name}.pdf`);
    setSave("saved");
  } catch (e) {
    setSave("error", e.message);
  }
}

// Filters + sort above the Money tables. tab = "documents" | "expenses"
function moneyToolbar(tab) {
  const m = state.money;
  const chip = (key, value, label) =>
    `<button class="filter-chip ${m[key] === value ? "active" : ""}" data-money-filter="${key}" data-value="${value}">${label}</button>`;
  const chips = tab === "documents"
    ? [chip("type", "all", "All"), chip("type", "invoice", "Invoices"), chip("type", "estimate", "Estimates"), `<span class="chip-gap"></span>`,
       chip("status", "all", "Any status"), chip("status", "Unpaid", "🔴 Unpaid"), chip("status", "Paid", "✓ Paid")]
    : [chip("status", "all", "All"), chip("status", "billable", "Billable"), chip("status", "internal", "Internal")];
  return `
    <div class="toolbar-card money-toolbar">
      <div class="chip-row">${chips.join("")}</div>
      <div class="fin-filter">
        <input type="search" class="form-input" data-money-search="1" placeholder="🔍 Search client, project, number, store..." value="${esc(state.search)}">
        <!-- phone: dates & sort fold away so the pinned bar stays small -->
        <button class="btn btn-sm mobile-only ${m.start || m.end ? "btn-primary" : ""}" data-money-more="1">
          📅 Dates &amp; sort${m.start || m.end ? " •" : ""}</button>
        <div class="money-more ${state.moneyMore ? "open" : ""}">
          <label>From <input type="date" class="form-input" data-money-date="start" value="${esc(m.start)}"></label>
          <label>To <input type="date" class="form-input" data-money-date="end" value="${esc(m.end)}"></label>
          ${sortSelect(tab, tab === "documents" ? DOCUMENT_COLUMNS : RECEIPT_COLUMNS)}
        </div>
        ${m.start || m.end || m.type !== "all" || m.status !== "all" || state.search
          ? `<button class="btn btn-sm" data-money-clear="1">Clear filters</button>` : ""}
      </div>
    </div>`;
}

// Apply the Money filters + search to documents or receipts (the tables sort themselves)
function filterMoney(list, tab) {
  const m = state.money;
  const q = state.search.trim().toLowerCase();
  const date = x => (tab === "documents" ? x.invoice_date : x.receipt_date) || "";
  return list.filter(x => {
    if (tab === "documents") {
      if (m.type !== "all" && x.kind !== m.type) return false;
      if (m.status !== "all" && (x.is_estimate || x.status !== m.status)) return false;
    } else if (m.status !== "all" && (m.status === "billable") !== Boolean(x.billable)) {
      return false;
    }
    if (m.start && date(x) < m.start) return false;
    if (m.end && date(x) > m.end) return false;
    return !q || [x.client_name, x.project_name, x.invoice_number, x.store_clean, x.category, x.submitted_by]
      .some(v => String(v || "").toLowerCase().includes(q));
  });
}

// Receipts table: approval, [ + Add to Invoice ] switch (locked once Invoiced), photos, delete
const RECEIPT_COLUMNS = {
  date: ["Date", r => r.receipt_date || ""],
  store: ["Store", r => r.store_clean],
  category: ["Category", r => r.category],
  project: ["Project", r => `${r.client_name} ${r.project_name}`],
  amount: ["Amount", r => Number(r.amount) || 0],
  approval: ["Approval", r => r.approval_status],
  billable: ["Billable", r => (r.invoice_id ? 2 : r.billable ? 1 : 0)],
};

function renderReceiptsTableCard(input) {
  const list = sortRows(input, "expenses", RECEIPT_COLUMNS);
  const billable = r => !isEmployee() ? (r.invoice_id
    ? `<span class="badge badge-invoiced" title="Already on an invoice. Delete that invoice to release it.">🔒 Invoiced</span>`
    : `<button class="btn btn-sm ${r.billable ? "btn-primary" : ""}" data-toggle-billable="${esc(r.id)}" data-cur-bill="${r.billable ? 1 : 0}">
         ${r.billable ? "✓ Billable" : "+ Make Billable"}</button>`) : "";
  const approval = r => `${renderApprovalBadge(r.approval_status) || `<span class="badge st-completed">Approved</span>`}
    ${r.rejection_reason ? `<div style="font-size:11px;color:var(--error-text);">${esc(r.rejection_reason)}</div>` : ""}`;
  const actions = r => `${r.approval_status === "PendingApproval" && canApprove() ? `
      <button class="btn btn-sm btn-success" data-approve-kind="receipt" data-approve-id="${esc(r.id)}">✓</button>
      <button class="btn btn-sm btn-danger" data-reject-kind="receipt" data-reject-id="${esc(r.id)}">✕</button>` : ""}
    ${!isEmployee() ? `<button class="btn btn-sm btn-danger" data-delete-entity="receipts" data-delete-id="${esc(r.id)}">🗑</button>` : ""}`;
  const photos = r => renderPhotoStrip("receipts", r.id, r.image_urls, { small: true });

  const rows = list.map(r => `
    <tr>
      <td>${esc(r.receipt_date || "—")}</td>
      <td><strong>${esc(r.store_clean || "Vendor")}</strong>${r.submitted_by ? `<div class="inv-note">by ${esc(r.submitted_by)}</div>` : ""}</td>
      <td>${esc(r.category || "—")}</td>
      <td>${esc(r.project_name)}<div class="inv-note">${esc(r.client_name)}</div></td>
      <td><strong>${usd(r.amount)}</strong></td>
      <td>${approval(r)}</td>
      ${!isEmployee() ? `<td>${billable(r)}</td>` : ""}
      <td><div class="photo-grid">${photos(r) || `<span class="inv-note">—</span>`}</div></td>
      <td><div class="inv-actions">${actions(r)}</div></td>
    </tr>`).join("");

  const cards = list.map(r => mobCard({
    title: esc(r.store_clean || "Receipt"),
    right: `<strong>${usd(r.amount)}</strong>`,
    sub: `${esc(r.receipt_date || "")} · ${esc(r.project_name)} · ${esc(r.client_name)}`,
    extra: `<div class="mob-card-row">${approval(r)} ${billable(r)}</div>
            ${photos(r) ? `<div class="photo-grid">${photos(r)}</div>` : ""}
            <div class="inv-actions">${actions(r)}</div>`,
  })).join("");

  const empty = `No receipts yet. Use <strong>+ New → Receipt</strong>.`;
  return `
    <div class="data-card desktop-table-view">
      <div class="table-responsive">
        <table class="crm-table">
          <thead><tr>
            ${["date", "store", "category", "project", "amount", "approval"].map(k => sortTh("expenses", k, RECEIPT_COLUMNS[k][0])).join("")}
            ${!isEmployee() ? sortTh("expenses", "billable", "Billable") : ""}
            <th>Photo</th><th></th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="9" class="empty-state">${empty}</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    <div class="mobile-card-list">${cards || `<div class="data-card empty-state">${empty}</div>`}</div>`;
}


// ==========================================================================
// 5. EMPLOYEES, REPORTS, NOTIFICATIONS & SETTINGS VIEWS
// ==========================================================================


// ==========================================================================
// Income & Expense report (all numbers come from the server: GET /api/report)
// ==========================================================================
let finRange = { start: "", end: "" };   // empty = all time; kept while you move between screens

// Ask the server for the Income & Expense numbers of one scope in the chosen date range
const loadReport = (scope, ref) =>
  api("GET", `/report?${new URLSearchParams({ scope, ref, start: finRange.start, end: finRange.end })}`);

// A placeholder that hydrateFinance() fills in after the screen is drawn.
const financeHost = (scope, ref = "") =>
  `<div data-fin-host data-scope="${scope}" data-ref="${esc(ref)}"><div class="loading-state"><div class="spinner"></div><p>Loading numbers...</p></div></div>`;

// Fill every "Loading numbers..." placeholder on the screen with its report
async function hydrateFinance() {
  for (const host of document.querySelectorAll("[data-fin-host]")) {
    try {
      host.innerHTML = financePanel(await loadReport(host.dataset.scope, host.dataset.ref), host.dataset.scope, host.dataset.ref);
    } catch (e) {
      host.innerHTML = `<p style="color:var(--error-text);">${esc(e.message)}</p>`;
    }
  }
}

// Date range for the "All time / This month / This year" chips
function finPresetRange(kind) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  if (kind === "month") return { start: isoDate(new Date(y, m, 1)), end: isoDate(new Date(y, m + 1, 0)) };
  if (kind === "year") return { start: `${y}-01-01`, end: `${y}-12-31` };
  return { start: "", end: "" };
}

// The 5 report cards (Revenue, Unpaid, Expenses, Net Profit, Estimate vs Invoice) + date filter
function financePanel(r, scope = "all", ref = "") {
  const chips = [["all", "All time"], ["month", "This month"], ["year", "This year"]].map(([k, label]) => {
    const p = finPresetRange(k);
    return `<button class="filter-chip ${p.start === finRange.start && p.end === finRange.end ? "active" : ""}" data-fin-preset="${k}">${label}</button>`;
  }).join("");
  const ev = r.estimate_vs_invoice;
  const sign = n => (n > 0 ? "+" : n < 0 ? "−" : "") + usd(Math.abs(n));
  const card = (label, value, sub, color) =>
    `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value"${color ? ` style="color:${color};"` : ""}>${value}</div><div class="kpi-sub">${sub}</div></div>`;
  const table = ev ? `<div class="table-responsive" style="margin-top:14px;"><table class="crm-table">
      <thead><tr><th>Project</th><th>Estimate</th><th>Invoiced</th><th>Difference</th></tr></thead><tbody>${
        ev.rows.map(x => `<tr><td>${esc(x.project)}</td><td>${usd(x.estimate)}</td><td>${usd(x.invoiced)}</td><td>${sign(x.diff)}</td></tr>`).join("")
      }</tbody></table></div>` : "";
  return `<div class="fin-filter">${chips}
      <label>From <input type="date" id="finStart" class="form-input" value="${esc(finRange.start)}"></label>
      <label>To <input type="date" id="finEnd" class="form-input" value="${esc(finRange.end)}"></label>
      <span class="fin-export">Download:
        <button class="btn btn-sm" data-export="csv" data-scope="${esc(scope)}" data-ref="${esc(ref)}">CSV</button>
        <button class="btn btn-sm" data-export="pdf" data-scope="${esc(scope)}" data-ref="${esc(ref)}">PDF</button></span></div>
    <div class="kpi-grid">
      ${card("Revenue (Paid)", usd(r.revenue), "Paid invoices, by paid date", "var(--success-text)")}
      ${card("Unpaid / Pending", usd(r.unpaid), "Unpaid invoices, by invoice date", "var(--error-text)")}
      ${card("Total Expenses", usd(r.expenses), `Billable ${usd(r.expenses_billable)} · internal ${usd(r.expenses_internal)}`, "")}
      ${card("Net Profit", (r.net < 0 ? "−" : "") + usd(Math.abs(r.net)), "Revenue (Paid) − Total Expenses", r.net < 0 ? "var(--error-text)" : "var(--primary)")}
      ${card("Estimate vs. Invoice", ev ? sign(ev.diff) : "—",
        ev ? (ev.diff > 0 ? "invoiced over the estimate" : ev.diff < 0 ? "invoiced under the estimate" : "right on the estimate")
           : "no project with an estimate in this period", "")}
    </div>${table}`;
}


// Notifications screen: approval queue and rejected items
function renderNotificationsView() {
  const items = getPendingNotifications();
  if (!items.length) {
    return `<div class="data-card empty-state">
      <div class="empty-icon">🎉</div>
      <h3>All caught up!</h3>
      <p>There are no pending approvals or rejected submissions right now.</p>
    </div>`;
  }

  return `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">Approval Queue &amp; Status Alerts (${items.length})</h3></div>
      ${items.map(item => `
        <div class="alert-box ${item.status === "Rejected" ? "alert-danger" : "alert-warning"}">
          <div>
            <strong>${esc(item.title)}</strong>
            ${item.sub ? `<div style="font-size:13px;">${esc(item.sub)}</div>` : ""}
            ${item.reason ? `<div style="font-size:13px;margin-top:4px;"><strong>Rejection Reason:</strong> ${esc(item.reason)}</div>` : ""}
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            ${renderApprovalBadge(item.status)}
            ${item.status === "PendingApproval" && canApprove() && (item.kind !== "invoice" || isOwner()) ? `
              <button class="btn btn-sm btn-success" data-approve-kind="${item.kind}" data-approve-id="${esc(item.id)}">✓ Approve</button>
              <button class="btn btn-sm btn-danger" data-reject-kind="${item.kind}" data-reject-id="${esc(item.id)}">✕ Reject</button>
            ` : ""}
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

// Settings: My account (everyone) · Company profile + Rules (Owner edits) · Team (Owner manages, Manager views)
function renderSettingsView() {
  const p = state.profile || {};
  const lock = isOwner() ? "" : "disabled";   // only the Owner changes company settings (server enforces it too)
  const field = (id, label, value, extra = "", wide = false) => `
    <div class="form-field${wide ? " wide" : ""}"><label>${label}</label>
      <input id="${id}" class="form-input" value="${esc(value ?? "")}" ${extra} ${lock}></div>`;

  const account = `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">My Account</h3></div>
      <p style="margin-bottom:12px;">Signed in as <strong>${esc(state.me.name)}</strong> (${esc(state.role)}) · ${esc(state.me.email || "")}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input id="setNewPassword" type="password" class="form-input" style="flex:1;min-width:200px;" placeholder="New password (8+ characters)" autocomplete="new-password">
        <button class="btn" data-action="change-password">Change Password</button>
        <button class="btn btn-danger" data-action="sign-out">Sign Out</button>
      </div>
    </div>`;

  if (isEmployee()) return account;

  const company = `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">Company Profile (printed on estimates &amp; invoices)</h3></div>
      <div class="form-grid">
        ${field("setCompany", "Company / LLC Name", p.company_name)}
        ${field("setPhone", "Phone", p.phone)}
        ${field("setEmail", "Email", p.email)}
        ${field("setRate", "Default Hourly Rate ($/hr)", Number(p.default_hourly_rate || 0), 'type="number" step="1" min="0"')}
        ${field("setAddress", "Business Address", p.business_address, "", true)}
        <div class="form-field wide">
          <label>Logo (link to an image)</label>
          <div style="display:flex;gap:10px;align-items:center;">
            <input id="setLogo" class="form-input" style="flex:1;" placeholder="https://..." value="${esc(p.logo_url || "")}" ${lock}>
            ${p.logo_url ? `<img src="${esc(p.logo_url)}" alt="Logo" style="height:36px;max-width:120px;object-fit:contain;">` : ""}
          </div>
        </div>
        <div class="form-field wide">
          <label>Payment Instructions</label>
          <textarea id="setPayment" class="form-textarea" rows="2" ${lock}>${esc(p.payment_details || "")}</textarea>
        </div>
      </div>
    </div>`;

  const rules = `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">Approval Rules</h3></div>
      <label class="switch-row">
        <input type="checkbox" id="setApprovals" ${approvalsOn() ? "checked" : ""} ${lock}>
        <span><strong>Employee changes need approval</strong><br>
          <small>On: new or edited clients, projects and tasks from Employees, receipts above the limit below and
          Manager invoices wait for approval. Off: everything is saved as approved (good for very small teams).</small></span>
      </label>
      <div class="form-grid" style="margin-top:12px;">
        ${field("setExpThreshold", "Employee receipts above this amount need approval ($)", expenseThreshold(), 'type="number" step="10" min="0"')}
      </div>
      ${isOwner() ? `<div style="margin-top:18px;"><button class="btn btn-primary" data-action="save-settings">Save Company &amp; Rules</button></div>` : ""}
    </div>`;

  return account + company + rules + renderTeamSection();
}

// Team table inside Settings. Owner: change role, deactivate, new temporary password. Manager: read only.
function renderTeamSection() {
  const rows = state.team.map(m => {
    const tasks = state.tasks.filter(t => sameId(t.assigned_to, m.id));
    const open = tasks.filter(t => t.status === "Scheduled" || t.status === "In Progress").length;
    const hours = +tasks.reduce((s, t) => s + t.actual_hours, 0).toFixed(2);
    const self = sameId(m.id, state.me.id);
    const role = isOwner() && !self
      ? `<select class="form-select" data-team-role="${esc(m.id)}">${["Owner", "Manager", "Employee"].map(r =>
          `<option ${m.role === r ? "selected" : ""}>${r}</option>`).join("")}</select>`
      : esc(m.role);
    return `<tr class="${m.active ? "" : "row-canceled"}">
      <td><strong>${esc(m.name)}</strong>${self ? " (you)" : ""}<div style="font-size:12px;color:var(--secondary);">${esc(m.specialty || "")}</div></td>
      <td>${role}</td>
      <td>${esc(m.email || "")}<div style="font-size:12px;color:var(--secondary);">${esc(m.phone || "")}</div></td>
      <td>${open} open · ${hours}h</td>
      ${isOwner() ? `<td><input type="number" min="0" step="0.5" class="form-input cost-input" data-team-cost="${esc(m.id)}"
        value="${Number(m.hourly_cost || 0)}" title="What one hour of this person costs you"></td>` : ""}
      <td>${isOwner() && !self ? `<div class="inv-actions">
        <button class="btn btn-sm" data-team-active="${esc(m.id)}" data-active="${m.active ? 1 : 0}">${m.active ? "Deactivate" : "Activate"}</button>
        <button class="btn btn-sm" data-team-reset="${esc(m.id)}">New Password</button></div>` : ""}</td>
    </tr>`;
  }).join("");
  return `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">Team (${state.team.length})</h3></div>
      ${isOwner() ? `<p style="font-size:13px;color:var(--secondary);margin-bottom:10px;">Add people with <strong>+ New → Team member</strong>.</p>` : ""}
      <div class="table-responsive">
        <table class="crm-table">
          <thead><tr><th>Name</th><th>Role</th><th>Contact</th><th>Tasks</th>${isOwner() ? "<th>Cost / hour ($)</th>" : ""}<th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ==========================================================================
// 6. MODALS, ALL-IN-ONE TASK/PROJECT/CLIENT CREATION & APPROVALS
// ==========================================================================

// Shared pop-up window: title, body HTML, footer buttons
function openModal(title, bodyHtml, footerHtml) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = bodyHtml;
  $("modalFooter").innerHTML = footerHtml;
  $("modalOverlay").hidden = false;
}

function closeModal() {
  $("modalOverlay").hidden = true;
}

// ---------- Task Create / Edit Modal (Supports Inline New Project + New Client!) ----------
function showTaskModal(existingTask = null, defaultProjectId = null) {
  const isEdit = Boolean(existingTask);
  const hasProjects = state.projects.length > 0;
  const hasClients = state.clients.length > 0;
  const projId = existingTask?.project_id || defaultProjectId || state.projects[0]?.id || "__new__";

  const projOpts = state.projects.map(p =>
    `<option value="${esc(p.id)}" ${sameId(p.id, projId) ? "selected" : ""}>${esc(p.client_name)} — ${esc(p.name)}</option>`
  ).join("");

  const clientOpts = state.clients.map(c =>
    `<option value="${esc(c.id)}">${esc(c.name)}</option>`
  ).join("");

  // who does it: any active team member (Employees always do their own tasks)
  const assignee = existingTask ? existingTask.assigned_to : (isEmployee() ? currentEmployee().id : "");
  const empOpts = `<option value="">— Unassigned —</option>` + activeTeam().map(e =>
    `<option value="${esc(e.id)}" ${sameId(assignee, e.id) ? "selected" : ""}>${esc(e.name)} (${esc(e.role)})</option>`
  ).join("");

  openModal(
    isEdit ? `Edit Task — ${existingTask.title}` : "Create New Task",
    `<div class="form-grid">
      <div class="form-field wide">
        <label>Task Title *</label>
        <input id="mTaskTitle" class="form-input" placeholder="e.g., Install kitchen sink faucet" value="${esc(existingTask?.title || "")}">
      </div>

      <div class="form-field wide">
        <label>Project *</label>
        <select id="mTaskProject" class="form-select" ${isEdit ? "disabled" : ""}>
          ${projOpts}
          ${!isEdit ? `<option value="__new__" ${!hasProjects ? "selected" : ""}>➕ Create New Project...</option>` : ""}
        </select>
      </div>

      <!-- Inline Project & Client Creation Box (No need to leave the Task modal!) -->
      <div id="inlineNewProjectWrap" class="inline-create-box form-field wide" ${!isEdit && !hasProjects ? "" : "hidden"}>
        <div class="inline-create-title">📁 New Project Setup</div>
        <div class="form-grid">
          <div class="form-field wide">
            <label>New Project Name *</label>
            <input id="mInlineProjName" class="form-input" placeholder="e.g., House Renovation / Inspection">
          </div>
          <div class="form-field wide">
            <label>Project Work Street Address</label>
            <input id="mInlineProjStreet" class="form-input" placeholder="Job site street address...">
            <div id="mInlineProjAddrBox" class="addr-box"></div>
          </div>
          <div class="form-field"><label>City</label><input id="mInlineProjCity" class="form-input" placeholder="Boca Raton"></div>
          <div class="form-field"><label>State</label><input id="mInlineProjState" class="form-input" value="FL"></div>
          <div class="form-field"><label>ZIP</label><input id="mInlineProjZip" class="form-input" placeholder="33432"></div>

          <div class="form-field wide">
            <label>Client for this Project *</label>
            <select id="mTaskInlineClient" class="form-select">
              ${clientOpts}
              <option value="__new__" ${!hasClients ? "selected" : ""}>➕ Create New Client...</option>
            </select>
          </div>
        </div>

        <!-- Nested Inline Client Creation -->
        <div id="inlineNewClientWrap" class="inline-create-box" style="background:#FFFFFF;" ${!hasClients ? "" : "hidden"}>
          <div class="inline-create-title">👤 New Client Details</div>
          <div class="form-grid">
            <div class="form-field"><label>First Name *</label><input id="mInlineCliFirst" class="form-input" placeholder="John"></div>
            <div class="form-field"><label>Last Name</label><input id="mInlineCliLast" class="form-input" placeholder="Smith"></div>
            <div class="form-field"><label>Phone</label><input id="mInlineCliPhone" class="form-input" placeholder="(561) 555-0100"></div>
            <div class="form-field"><label>Email</label><input id="mInlineCliEmail" type="email" class="form-input" placeholder="client@email.com"></div>
          </div>
        </div>
      </div>

      <div class="form-field">
        <label>Assigned Employee *</label>
        <select id="mTaskAssignee" class="form-select" ${isEmployee() ? "disabled" : ""}>${empOpts}</select>
      </div>
      <div class="form-field">
        <label>Priority</label>
        <select id="mTaskPriority" class="form-select">
          ${PRIORITIES.map(p => `<option value="${p}" ${existingTask?.priority === p ? "selected" : ""}>${p}</option>`).join("")}
        </select>
      </div>
      <div class="form-field">
        <label>Scheduled Date</label>
        <input id="mTaskDate" type="date" class="form-input" value="${esc(existingTask?.visit_date || todayStr())}">
      </div>
      <div class="form-field">
        <label>Scheduled Time</label>
        <input id="mTaskTime" type="text" class="form-input" placeholder="09:00 AM" value="${esc(existingTask?.scheduled_time || "09:00 AM")}">
      </div>
      <div class="form-field">
        <label>Planned Time (Hours)</label>
        <input id="mTaskPlannedH" type="number" step="0.25" min="0.25" class="form-input" value="${existingTask?.planned_hours ?? 2}">
      </div>
      <div class="form-field wide">
        <label>Detailed Instructions / Notes</label>
        <textarea id="mTaskDesc" class="form-textarea" rows="3" placeholder="Tools needed, customer gate code, scope details...">${esc(existingTask?.description || "")}</textarea>
      </div>
    </div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-submit-task="${existingTask ? esc(existingTask.id) : ""}">${isEdit ? (isEmployee() ? "Submit Edit for Approval" : "Save Changes") : (isEmployee() ? "Submit Task for Approval" : "Create Task")}</button>`
  );

  wireModalAddressAutocomplete("mInlineProjStreet", "mInlineProjAddrBox", "mInlineProjCity", "mInlineProjState", "mInlineProjZip");
}

// Save the task form. May first create a new client and/or project typed into the same form.
async function handleSaveTaskModal(taskId) {
  const title = $("mTaskTitle")?.value.trim() || "Service Task";
  let projectId = $("mTaskProject")?.value;
  const assignedTo = isEmployee() ? currentEmployee().id : ($("mTaskAssignee")?.value || "");
  const priority = $("mTaskPriority")?.value || "Medium";
  const visitDate = $("mTaskDate")?.value || todayStr();
  const scheduledTime = $("mTaskTime")?.value.trim() || "09:00 AM";
  const plannedHours = Number($("mTaskPlannedH")?.value || 2);
  const description = $("mTaskDesc")?.value.trim() || "";

  const existing = taskId ? state.tasks.find(t => sameId(t.id, taskId)) : null;
  const approvalStatus = newApprovalStatus();   // employee changes wait for approval (when approvals are on)
  let newProjectVisitId = null;

  setSave("saving");
  try {
    // 1. If user chose "➕ Create New Project..." inside the Task modal:
    if (!existing && projectId === "__new__") {
      const newProjName = $("mInlineProjName")?.value.trim();
      if (!newProjName) {
        return alert("Please enter a New Project Name.");
      }

      let clientId = $("mTaskInlineClient")?.value;
      // 1a. If user also chose "➕ Create New Client..." inside the Project box:
      if (clientId === "__new__") {
        const first = $("mInlineCliFirst")?.value.trim() || "New";
        const last = $("mInlineCliLast")?.value.trim() || "";
        const fullName = [first, last].filter(Boolean).join(" ");
        const phone = $("mInlineCliPhone")?.value.trim() || "";
        const email = $("mInlineCliEmail")?.value.trim() || "";

        const createdClient = await api("POST", "/clients", { name: fullName });
        clientId = createdClient.id;
        const cliMeta = {
          first_name: first,
          last_name: last,
          approval_status: approvalStatus,
          created_by_role: state.role,
        };
        await saveFields("clients", clientId, {
          name: fullName,
          phone,
          email,
          notes: packTextAndMeta("", cliMeta),
        });
      }

      if (!clientId) {
        return alert("Please select or create a Client for the new project.");
      }

      const createdProj = await api("POST", "/projects", { client_id: clientId, name: newProjName });
      projectId = createdProj.id;
      newProjectVisitId = createdProj.first_visit_id;   // the server already made the project's first visit
      const projMeta = {
        project_status: "Active",
        approval_status: approvalStatus,
        created_by_role: state.role,
      };
      await saveFields("projects", projectId, {
        name: newProjName,
        street: $("mInlineProjStreet")?.value.trim() || "",
        city: $("mInlineProjCity")?.value.trim() || "",
        state: $("mInlineProjState")?.value.trim() || "FL",
        zip: $("mInlineProjZip")?.value.trim() || "",
        estimate_description: packTextAndMeta("", projMeta),
      });
    }

    if (!existing && (!projectId || projectId === "__new__")) {
      return alert("Please select or create a Project.");
    }

    const meta = {
      ...(existing?._meta || {}),
      title,
      description,
      assigned_to: undefined,     // old versions kept the assignee here; it is a real column now
      assigned_name: undefined,
      priority,
      scheduled_time: scheduledTime,
      planned_hours: plannedHours,
      approval_status: approvalStatus,
      rejection_reason: "",
      created_by_role: existing?.created_by_role || state.role,
    };

    const packedWork = packTextAndMeta(`${title}\n${description}`, meta);

    closeModal();
    // 2. Which visit row gets the task: the edited one, the new project's first visit, or a brand-new visit
    let targetId = taskId || newProjectVisitId;
    if (!targetId) {
      const created = await api("POST", "/visits", { project_id: projectId });
      targetId = created.id;
    }
    await saveFields("visits", targetId, {
      visit_date: visitDate,
      planned_work: packedWork,
      ...(isEmployee() ? {} : { assigned_to: assignedTo }),   // employees can't reassign (server forces it too)
    });
    await syncCRM(true);
    navigate("task-detail", targetId);
  } catch (e) {
    setSave("error", e.message);
    alert("Error saving task: " + e.message);
  }
}

// ---------- Task Status & Mandatory Time Variance Check ----------
async function handleTaskStatusUpdate(taskId, newStatus) {
  const t = state.tasks.find(x => sameId(x.id, taskId));
  if (!t) return;

  // completing a task with a running timer: first review & save the timer's time, then complete
  if (newStatus === "Completed" && t.timer_start) return stopTaskTimer(t.id, true);

  const latestTask = state.tasks.find(x => sameId(x.id, taskId)) || t;

  // planned hours were set and actual differs -> an explanation is required before completing
  if (newStatus === "Completed" && latestTask.planned_hours > 0 &&
      Number(latestTask.actual_hours) !== Number(latestTask.planned_hours)) {
    openModal(
      "Planned vs. Actual Time Variance",
      `<div class="alert-box alert-warning">
        <div>Planned Time: <strong>${latestTask.planned_hours}h</strong> • Actual Time: <strong>${latestTask.actual_hours}h</strong></div>
      </div>
      <div class="form-field wide">
        <label>Mandatory Explanation for Time Difference *</label>
        <textarea id="mVarianceReason" class="form-textarea" rows="3" placeholder="Explain why actual hours differed from the planned hours...">${esc(latestTask.variance_reason || "")}</textarea>
      </div>`,
      `<button class="btn" onclick="closeModal()">Cancel</button>
       <button class="btn btn-success" data-confirm-complete="${esc(latestTask.id)}">Confirm &amp; Complete Task</button>`
    );
    return;
  }

  await saveField("visits", t.id, "status", newStatus);
  await syncCRM(true);
}

// "Confirm & Complete" in the time-difference pop-up: store the reason and mark Completed
async function confirmTaskCompleteWithReason(taskId) {
  const reason = $("mVarianceReason")?.value.trim();
  if (!reason) {
    alert("An explanation is required when actual working time differs from planned time.");
    return;
  }
  const t = state.tasks.find(x => sameId(x.id, taskId));
  if (!t) return;

  const meta = { ...t._meta, variance_reason: reason };
  const packedWork = packTextAndMeta(`${t.title}\n${t.description}`, meta);

  closeModal();
  await saveFields("visits", t.id, {
    status: "Completed",
    planned_work: packedWork,
  });
  await syncCRM(true);
}

// ==========================================================================
// TIMER
// The start time is saved inside the task (meta: timer_start = ms, timer_by = who started it), so the timer
// keeps running when you close the app, switch devices, and the Manager sees it. One timer per person.
// Stopping opens a short "review the time" window; nothing is added until you confirm.
// ==========================================================================
const elapsedSeconds = startMs => Math.max(0, Math.floor((Date.now() - Number(startMs)) / 1000));

function formatTimerClock(totalSeconds) {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return [hrs, mins, secs].map(n => String(n).padStart(2, "0")).join(":");
}

// "1 h 23 min"
function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600), m = Math.floor((totalSeconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

// Save the task's meta with timer fields changed (+ any other fields, e.g. status / time_spent)
function saveTimerMeta(t, timerFields, extra = {}) {
  return saveFields("visits", t.id, {
    planned_work: packTextAndMeta(`${t.title}\n${t.description}`, { ...t._meta, ...timerFields }),
    ...extra,
  });
}

// ▶ Start: one timer per person; a Scheduled task becomes In Progress
async function startTaskTimer(taskId) {
  const t = state.tasks.find(x => sameId(x.id, taskId));
  if (!t) return;
  const mine = state.tasks.find(x => x.timer_start && sameId(x.timer_by, currentEmployee().id));
  if (mine) return alert(`Your timer is still running on "${mine.title}". Stop it there first.`);
  try {
    await saveTimerMeta(t, { timer_start: Date.now(), timer_by: currentEmployee().id },
      t.status === "Scheduled" ? { status: "In Progress" } : {});
  } finally {
    await syncCRM(true);
  }
}

// ⏹ Stop: show the time worked and let the person correct it before it is added to Time Spent.
// complete = true when the user tapped "Completed" while the timer was running.
function stopTaskTimer(taskId, complete = false) {
  const t = state.tasks.find(x => sameId(x.id, taskId));
  if (!t?.timer_start) return;
  const sec = elapsedSeconds(t.timer_start);
  const hours = Math.round(sec / 36) / 100;   // to 0.01 h (about half a minute), no minimum
  openModal(
    "Stop Timer — Review Time",
    `<p>Started ${esc(new Date(t.timer_start).toLocaleString())} · worked <strong>${formatDuration(sec)}</strong>.</p>
     <div class="form-field wide" style="margin-top:12px;">
       <label>Hours to add (change if needed)</label>
       <input id="mTimerHours" type="number" step="0.05" min="0" class="form-input" value="${hours}">
       <small style="color:var(--secondary);">Time Spent now: ${t.actual_hours} h</small>
     </div>`,
    `<button class="btn" onclick="closeModal()">Keep Running</button>
     <button class="btn btn-danger" data-timer-discard="${esc(t.id)}">Discard</button>
     <button class="btn btn-primary" data-timer-save="${esc(t.id)}" data-complete="${complete ? 1 : 0}">Save${complete ? " & Complete" : ""}</button>`
  );
}

// Save the reviewed hours (or discard them) and clear the timer
async function finishTimer(taskId, add, complete) {
  const t = state.tasks.find(x => sameId(x.id, taskId));
  if (!t) return;
  const hours = add ? Math.max(0, Number($("mTimerHours")?.value || 0)) : 0;
  closeModal();
  try {
    await saveTimerMeta(t, { timer_start: undefined, timer_by: undefined },
      hours ? { time_spent: +(t.actual_hours + hours).toFixed(2) } : {});
    await syncCRM(true);
    if (complete) await handleTaskStatusUpdate(taskId, "Completed");   // now with the timer's time included
  } catch (e) {
    alert(e.message);
    await syncCRM(true);
  }
}

// Once a second: update every running clock on screen (task screen + ⏱ badges in the list)
function startGlobalTimerTicker() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    document.querySelectorAll("[data-timer-start]").forEach(el => {
      const sec = elapsedSeconds(el.dataset.timerStart);
      el.textContent = el.dataset.short ? `⏱ ${formatDuration(sec)}` : formatTimerClock(sec);
    });
  }, 1000);
}

// ---------- Client Create / Edit Modal ----------
function showClientModal(existingClient = null) {
  const isEdit = Boolean(existingClient);
  openModal(
    isEdit ? `Edit Client — ${existingClient.name}` : "Add New Client",
    `<div class="form-grid">
      <div class="form-field">
        <label>First Name *</label>
        <input id="mCliFirst" class="form-input" value="${esc(existingClient?.first_name || "")}">
      </div>
      <div class="form-field">
        <label>Last Name *</label>
        <input id="mCliLast" class="form-input" value="${esc(existingClient?.last_name || "")}">
      </div>
      <div class="form-field wide">
        <label>Company Name</label>
        <input id="mCliCompany" class="form-input" value="${esc(existingClient?.company_name || "")}">
      </div>
      <div class="form-field">
        <label>Phone</label>
        <input id="mCliPhone" class="form-input" value="${esc(existingClient?.phone || "")}">
      </div>
      <div class="form-field">
        <label>Email</label>
        <input id="mCliEmail" type="email" class="form-input" value="${esc(existingClient?.email || "")}">
      </div>
      <div class="form-field wide">
        <label>Contact Street Address</label>
        <input id="mCliStreet" class="form-input" placeholder="Start typing address..." value="${esc(existingClient?.street || "")}">
        <div id="mCliAddrBox" class="addr-box"></div>
      </div>
      <div class="form-field"><label>City</label><input id="mCliCity" class="form-input" value="${esc(existingClient?.city || "")}"></div>
      <div class="form-field"><label>State</label><input id="mCliState" class="form-input" value="${esc(existingClient?.state || "FL")}"></div>
      <div class="form-field"><label>ZIP Code</label><input id="mCliZip" class="form-input" value="${esc(existingClient?.zip || "")}"></div>
      <div class="form-field wide">
        <label>Notes</label>
        <textarea id="mCliNotes" class="form-textarea" rows="2">${esc(existingClient?.clean_notes || "")}</textarea>
      </div>
    </div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-submit-client="${existingClient ? esc(existingClient.id) : ""}">${isEdit ? "Save Client" : (isEmployee() ? "Submit for Approval" : "Create Client")}</button>`
  );

  wireModalAddressAutocomplete("mCliStreet", "mCliAddrBox", "mCliCity", "mCliState", "mCliZip");
}

// Save the client form (new or edit)
async function handleSaveClientModal(clientId) {
  const first = $("mCliFirst").value.trim() || "New";
  const last = $("mCliLast").value.trim();
  const fullName = [first, last].filter(Boolean).join(" ");
  const company = $("mCliCompany").value.trim();
  const phone = $("mCliPhone").value.trim();
  const email = $("mCliEmail").value.trim();
  const street = $("mCliStreet").value.trim();
  const city = $("mCliCity").value.trim();
  const stateCode = $("mCliState").value.trim();
  const zip = $("mCliZip").value.trim();
  const cleanNotes = $("mCliNotes").value.trim();

  const existing = clientId ? state.clients.find(c => sameId(c.id, clientId)) : null;
  const meta = {
    ...(existing?._meta || {}),
    first_name: first,
    last_name: last,
    company_name: company,
    approval_status: newApprovalStatus(),
    rejection_reason: "",
    created_by_role: existing?.created_by_role || state.role,
  };

  closeModal();
  setSave("saving");
  try {
    let targetId = clientId;
    if (!existing) {
      const created = await api("POST", "/clients", { name: fullName });
      targetId = created.id;
    }
    await saveFields("clients", targetId, {
      name: fullName,
      phone,
      email,
      street,
      city,
      state: stateCode,
      zip,
      notes: packTextAndMeta(cleanNotes, meta),
    });
    await syncCRM(true);
    navigate("client-detail", targetId);
  } catch (e) {
    setSave("error", e.message);
    alert("Error saving client: " + e.message);
  }
}

// ---------- Project Create / Edit Modal (Also Supports Inline New Client!) ----------
function showProjectModal(existingProject = null, defaultClientId = null) {
  const isEdit = Boolean(existingProject);
  const hasClients = state.clients.length > 0;
  const cliId = existingProject?.client_id || defaultClientId || state.clients[0]?.id || "__new__";

  const clientOpts = state.clients.map(c =>
    `<option value="${esc(c.id)}" ${sameId(c.id, cliId) ? "selected" : ""}>${esc(c.name)}</option>`
  ).join("");

  openModal(
    isEdit ? `Edit Project — ${existingProject.name}` : "Create New Project",
    `<div class="form-grid">
      <div class="form-field wide">
        <label>Project Name *</label>
        <input id="mProjName" class="form-input" placeholder="e.g., Kitchen & Bath Remodel" value="${esc(existingProject?.name || "")}">
      </div>
      <div class="form-field">
        <label>Client *</label>
        <select id="mProjClient" class="form-select" ${isEdit ? "disabled" : ""}>
          ${clientOpts}
          ${!isEdit ? `<option value="__new__" ${!hasClients ? "selected" : ""}>➕ Create New Client...</option>` : ""}
        </select>
      </div>
      <div class="form-field">
        <label>Project Status</label>
        <select id="mProjStatus" class="form-select">
          ${["Active", "Pending", "Completed"].map(s => `<option value="${s}" ${existingProject?.project_status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>

      <!-- Inline New Client Box inside Project Modal -->
      <div id="mProjNewClientBox" class="inline-create-box form-field wide" ${!isEdit && !hasClients ? "" : "hidden"}>
        <div class="inline-create-title">👤 New Client Details</div>
        <div class="form-grid">
          <div class="form-field"><label>First Name *</label><input id="mProjCliFirst" class="form-input" placeholder="John"></div>
          <div class="form-field"><label>Last Name</label><input id="mProjCliLast" class="form-input" placeholder="Smith"></div>
          <div class="form-field"><label>Phone</label><input id="mProjCliPhone" class="form-input" placeholder="(561) 555-0100"></div>
          <div class="form-field"><label>Email</label><input id="mProjCliEmail" type="email" class="form-input" placeholder="client@email.com"></div>
        </div>
      </div>

      <div class="form-field wide">
        <label>Job-Site Work Street Address (Separate from Client Address)</label>
        <input id="mProjStreet" class="form-input" placeholder="Start typing work address..." value="${esc(existingProject?.street || "")}">
        <div id="mProjAddrBox" class="addr-box"></div>
      </div>
      <div class="form-field"><label>City</label><input id="mProjCity" class="form-input" value="${esc(existingProject?.city || "")}"></div>
      <div class="form-field"><label>State</label><input id="mProjState" class="form-input" value="${esc(existingProject?.state || "FL")}"></div>
      <div class="form-field"><label>ZIP Code</label><input id="mProjZip" class="form-input" value="${esc(existingProject?.zip || "")}"></div>
      <div class="form-field wide">
        <label>Project Description &amp; Scope</label>
        <textarea id="mProjDesc" class="form-textarea" rows="3">${esc(existingProject?.clean_description || "")}</textarea>
      </div>
    </div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-submit-project="${existingProject ? esc(existingProject.id) : ""}">${isEdit ? "Save Project" : (isEmployee() ? "Submit for Approval" : "Create Project")}</button>`
  );

  wireModalAddressAutocomplete("mProjStreet", "mProjAddrBox", "mProjCity", "mProjState", "mProjZip");
}

// Save the project form (new or edit). May first create a new client.
async function handleSaveProjectModal(projectId) {
  const name = $("mProjName")?.value.trim() || "New Project";
  let clientId = $("mProjClient")?.value;
  const projectStatus = $("mProjStatus")?.value || "Active";
  const street = $("mProjStreet")?.value.trim() || "";
  const city = $("mProjCity")?.value.trim() || "";
  const stateCode = $("mProjState")?.value.trim() || "FL";
  const zip = $("mProjZip")?.value.trim() || "";
  const desc = $("mProjDesc")?.value.trim() || "";

  const existing = projectId ? state.projects.find(p => sameId(p.id, projectId)) : null;
  const approvalStatus = newApprovalStatus();

  setSave("saving");
  try {
    if (!existing && clientId === "__new__") {
      const first = $("mProjCliFirst")?.value.trim() || "New";
      const last = $("mProjCliLast")?.value.trim() || "";
      const fullName = [first, last].filter(Boolean).join(" ");
      const createdCli = await api("POST", "/clients", { name: fullName });
      clientId = createdCli.id;
      await saveFields("clients", clientId, {
        name: fullName,
        phone: $("mProjCliPhone")?.value.trim() || "",
        email: $("mProjCliEmail")?.value.trim() || "",
        notes: packTextAndMeta("", { first_name: first, last_name: last, approval_status: approvalStatus, created_by_role: state.role }),
      });
    }

    if (!existing && (!clientId || clientId === "__new__")) {
      return alert("Please select or create a Client.");
    }

    const meta = {
      ...(existing?._meta || {}),
      project_status: projectStatus,
      approval_status: approvalStatus,
      rejection_reason: "",
      created_by_role: existing?.created_by_role || state.role,
    };

    closeModal();
    let targetId = projectId;
    if (!existing) {
      // Pass clientId directly without Number() conversion so UUID strings work cleanly
      const created = await api("POST", "/projects", { client_id: clientId, name });
      targetId = created.id;
    }
    await saveFields("projects", targetId, {
      name,
      street,
      city,
      state: stateCode,
      zip,
      estimate_description: packTextAndMeta(desc, meta),
    });
    await syncCRM(true);
    navigate("project-detail", targetId);
  } catch (e) {
    setSave("error", e.message);
    alert("Error saving project: " + e.message);
  }
}

// ---------- Address Autocomplete Wiring ----------
function wireModalAddressAutocomplete(streetId, boxId, cityId, stateId, zipId) {
  const input = $(streetId);
  const box = $(boxId);
  if (!input || !box) return;
  let timer, seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 4) { box.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const list = await api("GET", `/address-search?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;
        box.innerHTML = "";
        list.forEach(a => {
          const item = document.createElement("div");
          item.className = "addr-item";
          item.textContent = a.label;
          item.addEventListener("mousedown", ev => {
            ev.preventDefault();
            input.value = a.street || "";
            if ($(cityId)) $(cityId).value = a.city || "";
            if ($(stateId)) $(stateId).value = a.state || "";
            if ($(zipId)) $(zipId).value = a.zip || "";
            box.innerHTML = "";
          });
          box.appendChild(item);
        });
      } catch {
        box.innerHTML = "";
      }
    }, 320);
  });
}

// ==========================================================================
// THE "+ New" MENU - the only place where things are created.
// It looks at the screen you are on, so the form opens with the client / project / task already chosen.
// ==========================================================================
function currentContext() {
  const id = state.selectedId;
  if (state.view === "task-detail") {
    const t = state.tasks.find(x => sameId(x.id, id));
    return { taskId: t?.id, projectId: t?.project_id, clientId: t?.client_id };
  }
  if (state.view === "project-detail") {
    const p = state.projects.find(x => sameId(x.id, id));
    return { projectId: p?.id, clientId: p?.client_id };
  }
  if (state.view === "client-detail") return { clientId: id };
  return {};
}

function showNewMenu() {
  const items = [
    ["task", "☑️", "Task"], ["client", "👥", "Client"], ["project", "📁", "Project"],
    ["receipt", "💳", "Receipt"], ["photo", "📸", "Photo"],
    ...(!isEmployee() ? [["estimate", "📋", "Estimate"], ["invoice", "🧾", "Invoice"]] : []),
    ...(isOwner() ? [["member", "👷", "Team member"]] : []),
  ];
  openModal("Create New", `<div class="new-menu">${items.map(([k, icon, label]) =>
    `<button class="new-menu-item" data-new="${k}"><span>${icon}</span>${label}</button>`).join("")}</div>`, "");
}

function handleNewChoice(kind) {
  const ctx = currentContext();
  if (kind === "task") return showTaskModal(null, ctx.projectId);
  if (kind === "client") return showClientModal();
  if (kind === "project") return showProjectModal(null, ctx.clientId);
  if (kind === "receipt") return showExpenseModal(ctx);
  if (kind === "photo") return showPhotoModal(ctx);
  if (kind === "estimate" || kind === "invoice") return showDocumentModal(kind, ctx);
  if (kind === "member") return showMemberModal();
}

// One dropdown for "where does this belong": every project, and its tasks under it.
// Values: "p:<project id>" or "t:<task id>". withProjectOnly=false hides the plain project rows.
function targetOptions(ctx, withProjectOnly = true) {
  const selected = ctx.taskId ? `t:${ctx.taskId}` : ctx.projectId ? `p:${ctx.projectId}` : "";
  return state.projects.map(p => {
    const tasks = state.tasks.filter(t => sameId(t.project_id, p.id) && t.status !== "Canceled");
    if (!withProjectOnly && !tasks.length) return "";
    const opt = (v, label) => `<option value="${v}" ${v === selected ? "selected" : ""}>${esc(label)}</option>`;
    return `<optgroup label="${esc(p.client_name)} — ${esc(p.name)}">
      ${withProjectOnly ? opt(`p:${p.id}`, `${p.name} (whole project)`) : ""}
      ${tasks.map(t => opt(`t:${t.id}`, `Task: ${t.title} (${t.visit_date})`)).join("")}
    </optgroup>`;
  }).join("");
}

// "p:..." / "t:..." -> {projectId, taskId}
function parseTarget(value) {
  const [type, id] = String(value || "").split(":");
  if (type === "t") {
    const t = state.tasks.find(x => sameId(x.id, id));
    return { taskId: t?.id || null, projectId: t?.project_id || null };
  }
  return { taskId: null, projectId: id || null };
}

// Compress and upload the files chosen in a form's photo input
async function uploadChosenPhotos(input, entity, rowId) {
  let urls = [];
  for (const f of [...(input?.files || [])]) urls = await uploadPhoto(entity, rowId, await compressImage(f));
  return urls;
}

// ---------- Receipt form (project required, task optional, photo optional) ----------
function showExpenseModal(ctx = {}) {
  if (!state.projects.length) return alert("Create a project first (+ New → Project).");
  openModal(
    "New Receipt",
    `<div class="form-grid">
      <div class="form-field wide">
        <label>Project / Task *</label>
        <select id="mExpTarget" class="form-select">${targetOptions(ctx)}</select>
      </div>
      <div class="form-field">
        <label>Store / Vendor *</label>
        <input id="mExpStore" class="form-input" placeholder="e.g., Home Depot">
      </div>
      <div class="form-field">
        <label>Category</label>
        <select id="mExpCat" class="form-select">
          ${EXPENSE_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join("")}
        </select>
      </div>
      <div class="form-field">
        <label>Amount ($) *</label>
        <input id="mExpAmount" type="number" step="0.01" min="0" class="form-input" placeholder="0.00">
      </div>
      <div class="form-field">
        <label>Receipt Date</label>
        <input id="mExpDate" type="date" class="form-input" value="${todayStr()}">
      </div>
      <div class="form-field wide">
        <label>Receipt photo</label>
        <input id="mExpPhoto" type="file" accept="image/*" class="form-input">
      </div>
    </div>
    ${isEmployee() && approvalsOn() ? `<p style="font-size:12px;color:var(--secondary);">Receipts above <strong>${usd(expenseThreshold())}</strong> need approval.</p>` : ""}`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-submit-expense="1">Save Receipt</button>`
  );
}

// Save the receipt form (+ its photo)
async function handleSaveExpenseModal() {
  const { projectId, taskId } = parseTarget($("mExpTarget").value);
  const store = $("mExpStore").value.trim() || "Supply Store";
  const category = $("mExpCat").value;
  const amount = Number($("mExpAmount").value || 0);
  const receiptDate = $("mExpDate").value || todayStr();
  const photoInput = $("mExpPhoto");
  if (!projectId) return alert("Please choose the project this receipt belongs to.");
  if (!(amount > 0)) return alert("Please enter the receipt amount.");

  // approval status: the server decides from the Owner's limit; this is only a first guess
  const meta = { approval_status: isEmployee() && approvalsOn() && amount > expenseThreshold() ? "PendingApproval" : "Approved" };

  setSave("saving");
  try {
    // new receipts start as Billable ([ + Add to Invoice ] on)
    const created = await api("POST", "/receipts", {
      project_id: projectId, visit_id: taskId,
      store: packTextAndMeta(store, meta), category, amount, receipt_date: receiptDate, billable: true,
    });
    await uploadChosenPhotos(photoInput, "receipts", created.id);   // read the file before the form closes
    closeModal();
    setSave("saved");
    await syncCRM(true);
  } catch (e) {
    setSave("error", e.message);
    alert("Error saving receipt: " + e.message);
  }
}

// ---------- Photo form: to a task (Before / During / After) or to a receipt ----------
function showPhotoModal(ctx = {}) {
  const receipts = state.receipts.map(r =>
    `<option value="r:${esc(r.id)}">${esc(r.store_clean || "Receipt")} · ${usd(r.amount)} · ${esc(r.receipt_date || "")}</option>`).join("");
  const targets = targetOptions(ctx, false) + (receipts ? `<optgroup label="Receipts">${receipts}</optgroup>` : "");
  if (!targets.trim()) return alert("Create a task first (+ New → Task).");
  openModal(
    "Add Photos",
    `<div class="form-grid">
      <div class="form-field wide">
        <label>Add to *</label>
        <select id="mPhotoTarget" class="form-select">${targets}</select>
      </div>
      <div class="form-field wide">
        <label>Stage (for task photos)</label>
        <div class="chip-row">${PHOTO_CATS.map((c, i) =>
          `<label class="filter-chip"><input type="radio" name="mPhotoCat" value="${c}" ${i === 0 ? "checked" : ""}> ${c}</label>`).join("")}</div>
      </div>
      <div class="form-field wide">
        <label>Photos *</label>
        <input id="mPhotoFiles" type="file" accept="image/*" multiple class="form-input">
        <small style="color:var(--secondary);">Photos are made smaller on this device before upload (about 300 KB each).</small>
      </div>
    </div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-submit-photos="1">Upload</button>`
  );
}

async function handleSavePhotos(btn) {
  const target = $("mPhotoTarget").value;
  const input = $("mPhotoFiles");
  if (!input.files.length) return alert("Please choose at least one photo.");
  const category = document.querySelector('input[name="mPhotoCat"]:checked')?.value || "Before";
  btn.disabled = true;
  btn.textContent = "Uploading...";
  setSave("saving");
  try {
    if (target.startsWith("r:")) {
      await uploadChosenPhotos(input, "receipts", target.slice(2));
    } else {
      const { taskId } = parseTarget(target);
      const urls = await uploadChosenPhotos(input, "visits", taskId);
      const t = state.tasks.find(x => sameId(x.id, taskId));
      const cats = { ...(t.photo_categories || {}) };
      urls.forEach(u => { if (!cats[u]) cats[u] = category; });   // tag the new photos with their stage
      await saveField("visits", t.id, "planned_work",
        packTextAndMeta(`${t.title}\n${t.description}`, { ...t._meta, photo_categories: cats }));
    }
    closeModal();
    setSave("saved");
    await syncCRM(true);
  } catch (e) {
    setSave("error", e.message);
    btn.disabled = false;
    btn.textContent = "Upload";
  }
}

// ---------- New estimate / invoice: pick the project, the server fills the lines ----------
function showDocumentModal(kind, ctx = {}) {
  if (!state.projects.length) return alert("Create a project first (+ New → Project).");
  const isInv = kind === "invoice";
  openModal(
    isInv ? "New Invoice" : "New Estimate",
    `<div class="form-field wide">
      <label>Project *</label>
      <select id="mDocProject" class="form-select">${state.projects.map(p =>
        `<option value="${esc(p.id)}" ${sameId(p.id, ctx.projectId) ? "selected" : ""}>${esc(p.client_name)} — ${esc(p.name)}</option>`).join("")}</select>
    </div>
    <p style="font-size:13px;color:var(--secondary);margin-top:10px;">${isInv
      ? "Filled in for you: the project's estimate (first invoice), otherwise its completed tasks that are not billed yet, plus billable receipts. You can change every line next."
      : "Filled in for you from the project's planned tasks (planned hours × your hourly rate). You can change every line next."}</p>
    ${isInv && isManager() && approvalsOn() ? `<div class="alert-box alert-info" style="margin-top:10px;">Your invoice goes to the Owner for approval before it can be sent.</div>` : ""}`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-submit-doc="${kind}" data-task="${esc(ctx.taskId || "")}">Create</button>`
  );
}

async function createDocument(body) {
  setSave("saving");
  try {
    const doc = await api("POST", "/documents", body);
    setSave("saved");
    await syncCRM(true);
    openDocumentEditor(doc.id);   // straight into the line editor
  } catch (e) {
    setSave("error", e.message);
    alert(e.message);
  }
}

// ---------- Line editor for an estimate / invoice ----------
let editorLines = [];   // the lines while the editor is open

function openDocumentEditor(id) {
  const d = state.invoices.find(x => sameId(x.id, id));
  if (!d) return;
  editorLines = d.line_items.map(l => ({ ...l }));
  if (!editorLines.length) editorLines.push({ description: "", qty: 1, rate: 0, type: "labor" });
  openModal(
    `${d.is_estimate ? "Estimate" : "Invoice"} #${d.invoice_number} — ${d.client_name} / ${d.project_name}`,
    `<div id="docEditor" data-doc="${esc(d.id)}">
      <div class="form-grid" style="margin-bottom:12px;">
        <div class="form-field"><label>Date</label><input id="mDocDate" type="date" class="form-input" value="${esc(d.invoice_date)}"></div>
      </div>
      <div id="docLines">${renderEditorLines()}</div>
      <button class="btn btn-sm" data-add-line="1" style="margin-top:8px;">+ Add line</button>
      <div class="form-field wide" style="margin-top:14px;">
        <label>Notes (printed on the PDF)</label>
        <textarea id="mDocNotes" class="form-textarea" rows="2">${esc(d.clean_description)}</textarea>
      </div>
    </div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-save-doc="${esc(d.id)}">Save</button>`
  );
}

// The editable rows + total (redrawn when a line is added or removed)
function renderEditorLines() {
  const total = editorLines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);
  return `<div class="table-responsive"><table class="crm-table line-editor">
    <thead><tr><th>Description</th><th>Qty / Hours</th><th>Rate ($)</th><th>Amount</th><th></th></tr></thead>
    <tbody>${editorLines.map((l, i) => `
      <tr>
        <td><input class="form-input" data-line="${i}" data-key="description" value="${esc(l.description)}" placeholder="Work or material"></td>
        <td><input class="form-input" type="number" step="0.25" data-line="${i}" data-key="qty" value="${esc(l.qty)}"></td>
        <td><input class="form-input" type="number" step="0.01" data-line="${i}" data-key="rate" value="${esc(l.rate)}"></td>
        <td class="line-amount" data-amount="${i}">${usd((Number(l.qty) || 0) * (Number(l.rate) || 0))}</td>
        <td><button class="btn btn-sm btn-danger" data-remove-line="${i}" title="Remove line">✕</button></td>
      </tr>`).join("")}</tbody>
    <tfoot><tr><td colspan="3" style="text-align:right;"><strong>Total</strong></td><td id="docTotal"><strong>${usd(total)}</strong></td><td></td></tr></tfoot>
  </table></div>`;
}

async function saveDocument(id) {
  const d = state.invoices.find(x => sameId(x.id, id));
  setSave("saving");
  try {
    await saveFields("invoices", id, {
      line_items: editorLines,
      invoice_date: $("mDocDate").value || d.invoice_date,
      description: packTextAndMeta($("mDocNotes").value, d._meta),
    });
    closeModal();
    await syncCRM(true);
  } catch (e) {
    alert(e.message);
  }
}

// Save a file we got from the server (Blob) under a name
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Income & Expense report as CSV (Excel) or PDF, for the same scope and period as the cards on screen
async function downloadReport(format, scope, ref) {
  setSave("saving");
  try {
    const q = new URLSearchParams({ format, scope, ref, start: finRange.start, end: finRange.end });
    saveBlob(await apiBlob(`/report/export?${q}`), `income-expense_${finRange.start || "all"}_${finRange.end || "time"}.${format}`);
    setSave("saved");
  } catch (e) {
    setSave("error", e.message);
  }
}

// View (new tab) or download a PDF. Plain links can't carry the login, so the file is fetched first.
async function openPdf(id, download) {
  const d = state.invoices.find(x => sameId(x.id, id));
  const tab = download ? null : window.open("", "_blank");   // opened now, or the browser blocks it as a pop-up
  try {
    const url = URL.createObjectURL(await apiBlob(`/invoices/${encodeURIComponent(id)}/pdf`));
    if (download) {
      const a = Object.assign(document.createElement("a"), { href: url, download: `${d?.invoice_number || "document"}.pdf` });
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else if (tab) {
      tab.location.href = url;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    tab?.close();
    setSave("error", e.message);
  }
}

// ---------- Team member form (Owner) -> shows the temporary password once ----------
function showMemberModal() {
  openModal(
    "Add Team Member",
    `<div class="form-grid">
      <div class="form-field wide"><label>Full Name *</label><input id="mEmpName" class="form-input" placeholder="e.g., Jordan Taylor"></div>
      <div class="form-field"><label>Email (their login) *</label><input id="mEmpEmail" type="email" class="form-input"></div>
      <div class="form-field"><label>Role</label><select id="mEmpRole" class="form-select">
        <option>Employee</option><option>Manager</option><option>Owner</option></select></div>
      <div class="form-field"><label>Phone</label><input id="mEmpPhone" class="form-input"></div>
      <div class="form-field"><label>Specialty</label><input id="mEmpSpec" class="form-input" placeholder="Plumbing, Electrical..."></div>
    </div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-submit-member="1">Add &amp; Create Login</button>`
  );
}

async function handleSaveMember() {
  try {
    const res = await api("POST", "/team", {
      name: $("mEmpName").value, email: $("mEmpEmail").value, role: $("mEmpRole").value,
      phone: $("mEmpPhone").value, specialty: $("mEmpSpec").value,
    });
    await syncCRM(true);
    showTempPassword(res.member.name, res.member.email, res.temp_password);
  } catch (e) {
    alert(e.message);
  }
}

function showTempPassword(name, email, password) {
  openModal(
    "Login Created",
    `<p>Give these to <strong>${esc(name)}</strong>. They can change the password in Settings after signing in.</p>
     <div class="temp-password"><div>Email: <strong>${esc(email || "")}</strong></div><div>Password: <strong>${esc(password)}</strong></div></div>
     <p style="font-size:12px;color:var(--secondary);">This password is shown only once.</p>`,
    `<button class="btn btn-primary" onclick="closeModal()">Done</button>`
  );
}


// Send: on phones the share sheet gets the real PDF file (Mail, Messages, WhatsApp...).
// On desktop the PDF is downloaded and an email to the client opens, ready for the attachment.
async function sendInvoice(id) {
  const inv = state.invoices.find(x => sameId(x.id, id));
  if (!inv) return;
  const client = state.clients.find(c => sameId(c.id, inv.client_id)) || {};
  const company = state.profile.company_name || "";
  const word = inv.is_estimate ? "estimate" : "invoice";
  const subject = `${inv.is_estimate ? "Estimate" : "Invoice"} ${inv.invoice_number}${company ? ` from ${company}` : ""}`;
  const body = [
    `Hello ${client.first_name || client.name || ""},`.trim(), "",
    `Please find attached ${word} ${inv.invoice_number} for ${inv.project_name}.`,
    `${inv.is_estimate ? "Estimated total" : "Amount due"}: ${usd(inv.total)}.`,
    ...(state.profile.payment_details ? ["", `Payment options: ${state.profile.payment_details}`] : []),
    "", "Thank you,", company,
  ].join("\n");
  const fileName = `${inv.invoice_number || "invoice"}.pdf`;

  try {
    const pdf = await apiBlob(`/invoices/${encodeURIComponent(id)}/pdf`);
    const file = new File([pdf], fileName, { type: "application/pdf" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: subject, text: body });
    } else {
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: fileName });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      location.href = `mailto:${encodeURIComponent(client.email || "")}?subject=${encodeURIComponent(subject)}&body=${
        encodeURIComponent(body + "\n\n(" + fileName + " attached)")}`;
    }
  } catch (e) {
    if (e.name === "AbortError") return;   // share sheet closed: nothing was sent
    setSave("error", e.message);
    return;
  }
  const meta = { ...inv._meta, sent_to_client: true, sent_date: isoDate(new Date()) };
  await saveField("invoices", inv.id, "description", packTextAndMeta(inv.clean_description, meta));
  await syncCRM(true);
}

// ---------- Approvals (Owner / Manager review what Employees submit; Owner reviews Manager invoices) ----------
// Where each kind keeps its approval status: table, text column holding the meta, and that column's human text.
const APPROVAL_TARGETS = {
  task:    { list: () => state.tasks,    table: "visits",   column: "planned_work",         text: r => `${r.title}
${r.description}` },
  client:  { list: () => state.clients,  table: "clients",  column: "notes",                text: r => r.clean_notes },
  project: { list: () => state.projects, table: "projects", column: "estimate_description", text: r => r.clean_description },
  invoice: { list: () => state.invoices, table: "invoices", column: "description",          text: r => r.clean_description },
  receipt: { list: () => state.receipts, table: "receipts", column: "store",                text: r => r.store_clean },
};

// status = "Approved" | "Rejected"; reason is shown to the employee on a rejection
async function setApproval(kind, id, status, reason = "") {
  const target = APPROVAL_TARGETS[kind];
  const row = target?.list().find(x => sameId(x.id, id));
  if (!row) return;
  const meta = { ...row._meta, approval_status: status, rejection_reason: reason };
  await saveField(target.table, row.id, target.column, packTextAndMeta(target.text(row), meta));
  await syncCRM(true);
}

const handleApproveRecord = (kind, id) => setApproval(kind, id, "Approved");

// Reject button: ask for the reason first
function promptRejectRecord(kind, id) {
  openModal(
    `Reject ${kind.toUpperCase()} Submission`,
    `<div class="form-field wide">
      <label>Mandatory Rejection Reason *</label>
      <textarea id="mRejectReason" class="form-textarea" rows="3" placeholder="Explain what the employee needs to fix..."></textarea>
    </div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-danger" data-confirm-reject-kind="${kind}" data-confirm-reject-id="${esc(id)}">Confirm Rejection</button>`
  );
}

// Confirm Rejection: the reason is required
async function confirmRejectRecord(kind, id) {
  const reason = $("mRejectReason")?.value.trim();
  if (!reason) {
    alert("A rejection reason is mandatory.");
    return;
  }
  closeModal();
  await setApproval(kind, id, "Rejected", reason);
}

// ---------- Photo Upload & Lightbox ----------
function openLightbox(url) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${esc(url)}" alt="Full size photo">`;
  box.addEventListener("click", () => box.remove());
  document.body.appendChild(box);
}


// ==========================================================================
// 7. GLOBAL DELEGATED EVENT LISTENERS
// ==========================================================================

document.addEventListener("click", async e => {
  const t = e.target;
  let el;

  // Navigation
  if ((el = t.closest("[data-nav]"))) return navigate(el.dataset.nav);
  if (t.closest("#openDrawerBtn") || t.closest("#mobMoreBtn")) return openMobileDrawer();
  if (t.closest("#closeDrawerBtn") || t.closest("#drawerBackdrop")) return closeMobileDrawer();
  if (t.closest("#topbarBackBtn")) return goBack();
  if (t.closest("#refreshDataBtn") || t.closest('[data-action="sync"]')) return syncCRM();
  if (t.closest("#modalCloseBtn")) return closeModal();

  if (t.closest('[data-action="toggle-mob-filters"]')) {
    state.showMobileFilters = !state.showMobileFilters;
    return renderCurrentView();
  }

  // Entity Opening
  if ((el = t.closest("[data-open-task]"))) return navigate("task-detail", el.dataset.openTask);
  if ((el = t.closest("[data-open-client]"))) return navigate("client-detail", el.dataset.openClient);
  if ((el = t.closest("[data-open-project]"))) return navigate("project-detail", el.dataset.openProject);

  // Income & Expense period presets
  if ((el = t.closest("[data-fin-preset]"))) {
    finRange = finPresetRange(el.dataset.finPreset);
    return hydrateFinance();
  }

  // Task Quick Filter Chips & Project Tabs
  if ((el = t.closest("[data-task-chip]"))) {
    state.taskQuickChip = el.dataset.taskChip;
    return renderCurrentView();
  }
  if ((el = t.closest("[data-proj-tab]"))) {
    state.projectTab = el.dataset.projTab;
    return renderCurrentView();
  }
  if ((el = t.closest("[data-money-tab]"))) {
    state.moneyTab = el.dataset.moneyTab;
    state.money.status = "all";   // "Unpaid" means nothing for receipts, "Billable" nothing for invoices
    return renderCurrentView();
  }
  // Reports: which report, which period, columns, download
  if ((el = t.closest("[data-report-kind]"))) {
    state.view = "money";
    state.moneyTab = "reports";
    state.report = { ...state.report, kind: el.dataset.reportKind, filters: {}, group: "", showCols: false };
    return renderCurrentView();
  }
  if ((el = t.closest("[data-report-preset]"))) {
    state.report.preset = el.dataset.reportPreset;
    return renderCurrentView();
  }
  if (t.closest("[data-rep-cols-toggle]")) {
    state.report.showCols = !state.report.showCols;
    return renderCurrentView();
  }
  if (t.closest("[data-rep-cols-reset]")) {
    localStorage.removeItem(`hcrm_rep_cols_${state.report.kind}`);
    return renderCurrentView();
  }
  if ((el = t.closest("[data-rep-export]"))) return exportReport(el.dataset.repExport);

  // column title clicked: sort by it; the same column again reverses the order
  if ((el = t.closest("[data-sort-table]"))) {
    const s = state.sorts[el.dataset.sortTable];
    state.sorts[el.dataset.sortTable] = s.key === el.dataset.sortKey
      ? { key: s.key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key: el.dataset.sortKey, dir: "asc" };
    return renderCurrentView();
  }
  if ((el = t.closest("[data-money-filter]"))) {
    state.money[el.dataset.moneyFilter] = el.dataset.value;
    return renderCurrentView();
  }
  if (t.closest("[data-money-more]")) {   // phone: show / hide the dates & sort row
    state.moneyMore = !state.moneyMore;
    return renderCurrentView();
  }
  if (t.closest("[data-money-clear]")) {
    state.money = { type: "all", status: "all", start: "", end: "" };
    state.search = "";
    $("globalSearchInput").value = "";
    return renderCurrentView();
  }

  // THE "+ New" button and its menu
  if (t.closest('[data-action="new"]')) return showNewMenu();
  if ((el = t.closest("[data-new]"))) return handleNewChoice(el.dataset.new);

  // Edit / save forms
  if ((el = t.closest("[data-edit-task]"))) return showTaskModal(state.tasks.find(x => sameId(x.id, el.dataset.editTask)));
  if ((el = t.closest("[data-submit-task]"))) return handleSaveTaskModal(el.dataset.submitTask);
  if ((el = t.closest("[data-edit-client]"))) return showClientModal(state.clients.find(x => sameId(x.id, el.dataset.editClient)));
  if ((el = t.closest("[data-submit-client]"))) return handleSaveClientModal(el.dataset.submitClient);
  if ((el = t.closest("[data-edit-project]"))) return showProjectModal(state.projects.find(x => sameId(x.id, el.dataset.editProject)));
  if ((el = t.closest("[data-submit-project]"))) return handleSaveProjectModal(el.dataset.submitProject);
  if ((el = t.closest("[data-submit-photos]"))) return handleSavePhotos(el);
  if (t.closest("[data-submit-member]")) return handleSaveMember();

  // Estimates & invoices: create, edit lines, PDF, convert
  if ((el = t.closest("[data-submit-doc]"))) {
    const body = { kind: el.dataset.submitDoc, project_id: $("mDocProject").value, visit_id: el.dataset.task || null };
    closeModal();
    return createDocument(body);
  }
  if ((el = t.closest("[data-convert-estimate]"))) {
    const est = state.invoices.find(x => sameId(x.id, el.dataset.convertEstimate));
    return createDocument({ kind: "invoice", project_id: est.project_id, from_estimate: est.id });
  }
  if ((el = t.closest("[data-open-doc]"))) return openDocumentEditor(el.dataset.openDoc);
  if ((el = t.closest("[data-save-doc]"))) return saveDocument(el.dataset.saveDoc);
  if (t.closest("[data-add-line]")) {
    editorLines.push({ description: "", qty: 1, rate: Number(state.profile.default_hourly_rate || 0), type: "labor" });
    $("docLines").innerHTML = renderEditorLines();
    return;
  }
  if ((el = t.closest("[data-remove-line]"))) {
    editorLines.splice(Number(el.dataset.removeLine), 1);
    $("docLines").innerHTML = renderEditorLines();
    return;
  }
  if ((el = t.closest("[data-pdf]"))) return openPdf(el.dataset.pdf, el.dataset.download === "1");
  if ((el = t.closest("[data-export]"))) return downloadReport(el.dataset.export, el.dataset.scope, el.dataset.ref);

  // My account
  if (t.closest('[data-action="sign-out"]')) return signOut();
  if (t.closest('[data-action="change-password"]')) {
    try {
      await api("POST", "/auth/password", { password: $("setNewPassword").value });
      $("setNewPassword").value = "";
      setSave("saved");
      alert("Password changed.");
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  // Team (Owner)
  if ((el = t.closest("[data-team-active]"))) {
    try {
      await api("PATCH", `/team/${el.dataset.teamActive}`, { active: el.dataset.active !== "1" });
      await syncCRM(true);
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if ((el = t.closest("[data-team-reset]"))) {
    if (armOnce(el, "Sure?")) return;
    const m = state.team.find(x => sameId(x.id, el.dataset.teamReset));
    try {
      const res = await api("POST", `/team/${m.id}/reset-password`);
      showTempPassword(m.name, m.email, res.temp_password);
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (t.closest("[data-submit-expense]")) return handleSaveExpenseModal();
  if ((el = t.closest("[data-send-invoice]"))) return sendInvoice(el.dataset.sendInvoice);
  if ((el = t.closest("[data-client-filter]"))) {
    state.clientFilter = el.dataset.clientFilter;
    return renderCurrentView();
  }

  // Task Status, Timer & Manual Hours
  if ((el = t.closest("[data-task-status]"))) return handleTaskStatusUpdate(el.dataset.taskId, el.dataset.taskStatus);
  if ((el = t.closest("[data-confirm-complete]"))) return confirmTaskCompleteWithReason(el.dataset.confirmComplete);
  if ((el = t.closest("[data-start-timer]"))) return startTaskTimer(el.dataset.startTimer);
  if ((el = t.closest("[data-stop-timer]"))) return stopTaskTimer(el.dataset.stopTimer);
  if ((el = t.closest("[data-timer-save]"))) return finishTimer(el.dataset.timerSave, true, el.dataset.complete === "1");
  if ((el = t.closest("[data-timer-discard]"))) {
    if (armOnce(el, "Discard time?")) return;
    return finishTimer(el.dataset.timerDiscard, false, false);
  }
  if ((el = t.closest("[data-save-hours]"))) {
    const val = Number($("manualHoursInput")?.value || 0);
    await saveField("visits", el.dataset.saveHours, "time_spent", val);
    return syncCRM(true);
  }

  // Comments
  if ((el = t.closest("[data-add-comment]"))) {
    const text = $("newTaskComment")?.value.trim();
    if (!text) return;
    const task = state.tasks.find(x => sameId(x.id, el.dataset.addComment));
    if (!task) return;
    const author = currentEmployee().name || state.role;
    const comments = [...(task.comments || []), { author, role: state.role, text, date: new Date().toLocaleString() }];
    const meta = { ...task._meta, comments };
    await saveField("visits", task.id, "planned_work", packTextAndMeta(`${task.title}\n${task.description}`, meta));
    return syncCRM(true);
  }

  // Photos & Lightbox
  if ((el = t.closest("[data-lightbox]"))) return openLightbox(el.dataset.lightbox);
  if ((el = t.closest("[data-del-photo]"))) {   // 2 taps; the server also removes the file from Supabase Storage
    if (armOnce(el, "Delete?")) return;
    const entity = el.dataset.photoEntity;
    const url = el.dataset.delPhoto;
    const row = (entity === "visits" ? state.tasks : state.receipts).find(x => sameId(x.id, el.dataset.photoRow));
    if (!row) return;
    const fields = { image_urls: (row.image_urls || []).filter(u => u !== url) };
    if (entity === "visits" && row.photo_categories?.[url]) {   // drop the Before/During/After tag too
      const { [url]: _gone, ...cats } = row.photo_categories;
      fields.planned_work = packTextAndMeta(`${row.title}\n${row.description}`, { ...row._meta, photo_categories: cats });
    }
    try {
      await saveFields(entity, row.id, fields);
    } finally {
      await syncCRM(true);
    }
    return;
  }

  // Approvals & Rejections
  if ((el = t.closest("[data-approve-kind]"))) return handleApproveRecord(el.dataset.approveKind, el.dataset.approveId);
  if ((el = t.closest("[data-reject-kind]"))) return promptRejectRecord(el.dataset.rejectKind, el.dataset.rejectId);
  if ((el = t.closest("[data-confirm-reject-kind]"))) return confirmRejectRecord(el.dataset.confirmRejectKind, el.dataset.confirmRejectId);
  if ((el = t.closest("[data-resubmit-kind]"))) {
    const kind = el.dataset.resubmitKind;
    const id = el.dataset.resubmitId;
    if (kind === "task") return showTaskModal(state.tasks.find(x => sameId(x.id, id)));
    if (kind === "client") return showClientModal(state.clients.find(x => sameId(x.id, id)));
    if (kind === "project") return showProjectModal(state.projects.find(x => sameId(x.id, id)));
  }

  // Invoices & Billable Toggles
  if ((el = t.closest("[data-toggle-inv-paid]"))) {
    el.disabled = true;
    const next = el.dataset.curStatus === "Paid" ? "Unpaid" : "Paid";
    try {
      await saveField("invoices", el.dataset.toggleInvPaid, "status", next);   // server stamps / clears paid_date
    } finally {
      await syncCRM(true);
    }
    return;
  }
  if ((el = t.closest("[data-toggle-billable]"))) {
    const wasOn = el.dataset.curBill === "1";
    await saveField("receipts", el.dataset.toggleBillable, "billable", !wasOn);
    return syncCRM(true);
  }

  // Settings Save (Owner): company profile + approval rules
  if (t.closest('[data-action="save-settings"]')) {
    await saveFields("profile", 1, {
      company_name: $("setCompany")?.value.trim(),
      phone: $("setPhone")?.value.trim(),
      email: $("setEmail")?.value.trim(),
      default_hourly_rate: Number($("setRate")?.value || 0),
      business_address: $("setAddress")?.value.trim(),
      logo_url: $("setLogo")?.value.trim(),
      payment_details: $("setPayment")?.value.trim(),
      approvals_required: $("setApprovals").checked,
      expense_threshold: Number($("setExpThreshold")?.value || 0),
    });
    return syncCRM(true);
  }

  // 2-Tap Delete Confirmation
  if ((el = t.closest("[data-delete-entity]"))) {
    if (armOnce(el, "Confirm Delete?")) return;
    const entity = el.dataset.deleteEntity;
    const id = el.dataset.deleteId;
    const backView = el.dataset.backView;
    try {
      setSave("saving");
      await api("DELETE", `/${entity}/${id}`);
      setSave("saved");
      await syncCRM(true);
      if (backView) navigate(backView, null, false);
    } catch (err) {
      setSave("error", err.message);
    }
    return;
  }
});

// ---------- Global Input & Filter Change Listeners ----------
// Search box (top bar on desktop, inside the Tasks screen on phones). Only list screens are filtered.
document.addEventListener("input", e => {
  const t = e.target;
  const inScreen = t.id === "mobileSearchInput" || t.dataset.moneySearch;   // search boxes drawn inside the screen
  if (t.id === "globalSearchInput" || inScreen) {
    state.search = t.value;
    if (inScreen && $("globalSearchInput")) $("globalSearchInput").value = t.value;
    if (!["tasks", "clients", "projects", "money"].includes(state.view)) return;
    const caret = t.selectionStart;
    renderCurrentView();
    // a search box inside the redrawn screen gets its focus and cursor position back
    const again = t.id === "mobileSearchInput" ? $("mobileSearchInput") : document.querySelector("[data-money-search]");
    if (inScreen && again) {
      again.focus();
      again.setSelectionRange(caret, caret);
    }
    return;
  }

  // Line editor: keep the lines in memory and update that row's amount + the total while typing
  if (t.dataset.line !== undefined) {
    const line = editorLines[Number(t.dataset.line)];
    line[t.dataset.key] = t.dataset.key === "description" ? t.value : Number(t.value || 0);
    $("docEditor").querySelector(`[data-amount="${t.dataset.line}"]`).textContent = usd(line.qty * line.rate);
    $("docTotal").innerHTML = `<strong>${usd(editorLines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0))}</strong>`;
  }
});

document.addEventListener("change", async e => {
  const t = e.target;

  // Dynamic Inline Toggles inside Modals
  if (t.id === "mTaskProject") {
    const wrap = $("inlineNewProjectWrap");
    if (wrap) wrap.hidden = t.value !== "__new__";
    return;
  }
  if (t.id === "mTaskInlineClient") {
    const wrap = $("inlineNewClientWrap");
    if (wrap) wrap.hidden = t.value !== "__new__";
    return;
  }
  if (t.id === "mProjClient") {
    const wrap = $("mProjNewClientBox");
    if (wrap) wrap.hidden = t.value !== "__new__";
    return;
  }
  // Income & Expense: custom date range
  if (t.id === "finStart" || t.id === "finEnd") {
    finRange = { start: $("finStart").value, end: $("finEnd").value };
    return hydrateFinance();
  }

  // Money filters: date range and sort order
  if (t.dataset.moneyDate) {
    state.money[t.dataset.moneyDate] = t.value;
    return renderCurrentView();
  }
  // Reports: custom dates, filters, grouping, column checkboxes (the column choice is remembered in this browser)
  if (t.dataset.reportDate) {
    state.report[t.dataset.reportDate] = t.value;
    return renderCurrentView();
  }
  if (t.dataset.reportFilter) {
    state.report.filters[t.dataset.reportFilter] = t.value;
    return renderCurrentView();
  }
  if (t.dataset.reportGroup) {
    state.report.group = t.value;
    return renderCurrentView();
  }
  if (t.dataset.repCol) {
    const keys = [...document.querySelectorAll("[data-rep-col]")].filter(x => x.checked).map(x => x.dataset.repCol);
    if (!keys.length) return renderCurrentView();   // at least one column stays
    localStorage.setItem(`hcrm_rep_cols_${state.report.kind}`, JSON.stringify(keys));
    return renderCurrentView();
  }

  // Team: Owner sets someone's cost per hour (used for labor cost in Reports)
  if (t.dataset.teamCost) {
    try {
      await api("PATCH", `/team/${t.dataset.teamCost}`, { hourly_cost: Number(t.value || 0) });
      setSave("saved");
    } catch (err) {
      alert(err.message);
    }
    return syncCRM(true);
  }

  // phone "Sort" dropdown: value = "column:asc|desc"
  if (t.dataset.sortSelect) {
    const [key, dir] = t.value.split(":");
    state.sorts[t.dataset.sortSelect] = { key, dir };
    return renderCurrentView();
  }

  // Team: Owner changes someone's role
  if (t.dataset.teamRole) {
    try {
      await api("PATCH", `/team/${t.dataset.teamRole}`, { role: t.value });
      setSave("saved");
    } catch (err) {
      alert(err.message);
    }
    return syncCRM(true);
  }

  // Unified Task List Dropdown Filters
  if (t.id === "fltStatus") { state.filterStatus = t.value; return renderCurrentView(); }
  if (t.id === "fltPriority") { state.filterPriority = t.value; return renderCurrentView(); }
  if (t.id === "fltClient") { state.filterClient = t.value; return renderCurrentView(); }
  if (t.id === "fltProject") { state.filterProject = t.value; return renderCurrentView(); }
  if (t.id === "fltAssignee") { state.filterAssignee = t.value; return renderCurrentView(); }
});

// Close Lightbox or Modal on Escape
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    document.querySelector(".lightbox")?.remove();
    closeModal();
  }
});

// Safety net: any failed save that a button didn't handle itself shows up in the "Error: ..." indicator
window.addEventListener("unhandledrejection", e => setSave("error", e.reason?.message || String(e.reason)));

// ==========================================================================
// SIGN-IN (shown instead of the app when nobody is signed in)
// ==========================================================================

// mode "login" or "setup" (very first start: create the Owner account)
function renderAuthScreen(mode, message = "") {
  $("appShell").hidden = true;
  closeModal();
  const setup = mode === "setup";
  $("authScreen").hidden = false;
  $("authScreen").innerHTML = `
    <form class="auth-card" id="authForm" data-mode="${mode}">
      <div class="auth-brand">Handy<span class="brand-accent">CRM</span></div>
      <h2>${setup ? "Welcome! Create the Owner account" : "Sign in"}</h2>
      ${setup ? `<p class="auth-hint">This is the first start. You become the Owner and can add your team later.</p>` : ""}
      ${message ? `<div class="alert-box alert-warning">${esc(message)}</div>` : ""}
      ${setup ? `<label>Your name<input id="authName" class="form-input" autocomplete="name" required></label>` : ""}
      <label>Email<input id="authEmail" type="email" class="form-input" autocomplete="username" required></label>
      <label>Password<input id="authPassword" type="password" class="form-input"
        autocomplete="${setup ? "new-password" : "current-password"}" minlength="${setup ? 8 : 1}" required></label>
      <button class="btn btn-primary" type="submit" id="authSubmit">${setup ? "Create Account" : "Sign In"}</button>
      ${setup ? "" : `<p class="auth-hint">Forgot your password? Ask the Owner for a new one (Settings → Team).</p>`}
    </form>`;
  $("authEmail").focus();
}

// called by api.js when the session is gone
function showSignIn(message = "") {
  renderAuthScreen("login", message);
}

document.addEventListener("submit", async e => {
  if (e.target.id !== "authForm") return;
  e.preventDefault();
  const setup = e.target.dataset.mode === "setup";
  const btn = $("authSubmit");
  btn.disabled = true;
  try {
    const body = { email: $("authEmail").value, password: $("authPassword").value };
    if (setup) body.name = $("authName").value;
    const res = await fetch(`${API_BASE}/auth/${setup ? "setup" : "login"}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw await failure(res);
    setSession(await res.json());
    showApp();
  } catch (err) {
    renderAuthScreen(setup ? "setup" : "login", err.message);
  }
});

function showApp() {
  $("authScreen").hidden = true;
  $("appShell").hidden = false;
  state.view = "tasks";
  state.history = [];
  syncCRM();
}

function signOut() {
  clearSession();
  state.me = null;
  renderAuthScreen("login");
}

// ---------- Start the app: signed in -> load data; otherwise sign-in (or first-time setup) ----------
async function startApp() {
  startGlobalTimerTicker();
  if (getSession()) return showApp();
  try {
    const res = await fetch(`${API_BASE}/auth/status`);
    if (!res.ok) throw await failure(res);
    renderAuthScreen((await res.json()).needs_setup ? "setup" : "login");
  } catch (err) {
    renderAuthScreen("login", err.message);
  }
}

startApp();