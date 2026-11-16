// ==========================================================================
// app.js — HandyCRM Complete Frontend Application Logic & Workflows
// ==========================================================================

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
);
const usd = n => Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

const TASK_STATUSES = ["Scheduled", "In Progress", "Completed", "Canceled"];
const PRIORITIES = ["High", "Medium", "Low"];
const PHOTO_CATS = ["Before", "During", "After"];
const EXPENSE_CATEGORIES = ["Construction", "Groceries", "Fuel", "Other"];

const DEFAULT_EMPLOYEES = [
  { id: "emp-1", name: "Alex Rivera", role: "Lead Technician", phone: "(561) 555-0142", email: "alex@handycrm.com", active: true, specialty: "Plumbing & Remodel" },
  { id: "emp-2", name: "Marco Silva", role: "Field Technician", phone: "(561) 555-0188", email: "marco@handycrm.com", active: true, specialty: "Electrical & Carpentry" },
  { id: "emp-3", name: "David Chen", role: "Finish Carpenter", phone: "(561) 555-0194", email: "david@handycrm.com", active: true, specialty: "Doors, Tile & Trim" },
];

// ---------- Global Application State ----------
const state = {
  role: localStorage.getItem("hcrm_role") || "Owner", // Owner | Manager | Employee
  activeEmployeeId: localStorage.getItem("hcrm_emp_id") || "emp-1",
  expenseThreshold: Number(localStorage.getItem("hcrm_exp_threshold") || 150),
  employees: JSON.parse(localStorage.getItem("hcrm_employees") || "null") || DEFAULT_EMPLOYEES,

  view: "tasks",
  selectedId: null,
  projectTab: "overview",
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
  sortBy: "date-asc",

  // Live Active Timers: { [taskId]: startTimestampMs }
  timers: JSON.parse(localStorage.getItem("hcrm_timers") || "{}"),
};

let timerInterval = null;
let photoUploadContext = null;

// ---------- Role & Employee Helpers ----------
const isOwner = () => state.role === "Owner";
const isManager = () => state.role === "Manager";
const isEmployee = () => state.role === "Employee";
const canApprove = () => state.role === "Owner" || state.role === "Manager";
const currentEmployee = () => state.employees.find(e => e.id === state.activeEmployeeId) || state.employees[0];

function saveEmployees() {
  localStorage.setItem("hcrm_employees", JSON.stringify(state.employees));
}

function saveTimers() {
  localStorage.setItem("hcrm_timers", JSON.stringify(state.timers));
}

// ---------- Data Sync & Reload ----------
async function syncCRM(silent = false) {
  if (!silent) {
    $("workspace").innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Syncing HandyCRM data...</p></div>`;
  }
  try {
    const data = await fetchFullCRMData(state.expenseThreshold);
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
  if (isEmployee() && ["estimates", "invoices", "reports", "employees"].includes(view)) {
    view = "tasks";
  }
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

function openMobileDrawer() {
  $("sidebar")?.classList.add("open");
  if ($("drawerBackdrop")) $("drawerBackdrop").hidden = false;
}

function closeMobileDrawer() {
  $("sidebar")?.classList.remove("open");
  if ($("drawerBackdrop")) $("drawerBackdrop").hidden = true;
}

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
      items.push({ kind: "receipt", id: r.id, title: `Expense: ${r.store_clean || "Receipt"} (${usd(r.amount)})`, sub: `${r.project_name} • Exceeds $${state.expenseThreshold} threshold`, status: r.approval_status, reason: r.rejection_reason });
    }
  });
  return items;
}

function updateShellUI() {
  const roleSel = $("roleSwitcher");
  if (roleSel) roleSel.value = state.role;

  const personaBar = $("employeePersonaBar");
  const empSelect = $("activeEmployeeSelect");
  if (personaBar && empSelect) {
    personaBar.hidden = !isEmployee();
    empSelect.innerHTML = state.employees.filter(e => e.active).map(e =>
      `<option value="${esc(e.id)}" ${e.id === state.activeEmployeeId ? "selected" : ""}>${esc(e.name)}</option>`
    ).join("");
  }

  const userNameEl = $("activeUserName");
  const avatarEl = $("userAvatar");
  if (isEmployee()) {
    const emp = currentEmployee();
    if (userNameEl) userNameEl.textContent = emp.name;
    if (avatarEl) avatarEl.textContent = emp.name.split(" ").map(x => x[0]).join("").slice(0, 2);
  } else if (isManager()) {
    if (userNameEl) userNameEl.textContent = "Alex Johnson (Mgr)";
    if (avatarEl) avatarEl.textContent = "AJ";
  } else {
    if (userNameEl) userNameEl.textContent = state.profile.company_name || "Anatolii V. (Owner)";
    if (avatarEl) avatarEl.textContent = "AV";
  }

  document.querySelectorAll("[data-role-hide]").forEach(el => {
    const hideFor = el.dataset.roleHide.split(",");
    el.hidden = hideFor.includes(state.role);
  });

  const baseView = state.view.replace("-detail", "s").replace("tasks", "tasks");
  document.querySelectorAll("[data-nav]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.nav === baseView || btn.dataset.nav === state.view);
  });

  const visibleTasks = getRoleFilteredTasks();
  if ($("navTasksCount")) $("navTasksCount").textContent = visibleTasks.filter(t => t.status !== "Completed" && t.status !== "Canceled").length;

  const unpaidCount = state.invoices.filter(i => i.status === "Unpaid").length;
  const unpaidBadge = $("navUnpaidBadge");
  if (unpaidBadge) {
    unpaidBadge.hidden = unpaidCount === 0 || isEmployee();
    unpaidBadge.textContent = unpaidCount;
  }

  const notifs = getPendingNotifications();
  const pendingCount = notifs.filter(n => isEmployee() ? n.status === "Rejected" : n.status === "PendingApproval").length;
  const notifBadge = $("navNotifBadge");
  if (notifBadge) {
    notifBadge.hidden = pendingCount === 0;
    notifBadge.textContent = pendingCount;
  }

  const banner = $("roleNoticeBanner");
  if (banner) {
    if (isEmployee()) {
      banner.hidden = false;
      banner.innerHTML = `<span>👷 <strong>Employee Field Mode (${esc(currentEmployee().name)}):</strong> Financial data is hidden. New records or edits to approved tasks are submitted for Manager approval.</span>`;
    } else if (isManager()) {
      banner.hidden = false;
      banner.innerHTML = `<span>📋 <strong>Manager Mode:</strong> You can assign tasks and approve employee submissions. Invoices you create require Owner approval before sending.</span>`;
    } else {
      banner.hidden = true;
    }
  }

  const isDetail = state.view.endsWith("-detail");
  if ($("topbarBackBtn")) $("topbarBackBtn").hidden = !isDetail;
}

// ---------- Reusable Badges & UI Snippets ----------
function renderStatusBadge(status) {
  const s = status || "Scheduled";
  const slug = s.toLowerCase().replace(/\s+/g, "-");
  return `<span class="badge st-${esc(slug)}"><span class="badge-dot"></span>${esc(s)}</span>`;
}

function renderPriorityBadge(prio) {
  const p = prio || "Medium";
  return `<span class="badge prio-${esc(p.toLowerCase())}">${esc(p)}</span>`;
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

  crumbsEl.innerHTML = "";
  actionsEl.innerHTML = "";
  if (fab) fab.hidden = false;

  switch (state.view) {
    case "tasks":
      titleEl.textContent = "Tasks";
      actionsEl.innerHTML = `<button class="btn btn-primary" data-action="new-task">+ New Task</button>`;
      ws.innerHTML = renderTasksView();
      break;
    case "task-detail":
      ws.innerHTML = renderTaskDetailView(state.selectedId);
      if (fab) fab.hidden = true;
      break;
    case "clients":
      titleEl.textContent = "Clients";
      actionsEl.innerHTML = `<button class="btn btn-primary" data-action="new-client">+ New Client</button>`;
      ws.innerHTML = renderClientsView();
      break;
    case "client-detail":
      ws.innerHTML = renderClientDetailView(state.selectedId);
      if (fab) fab.hidden = true;
      break;
    case "projects":
      titleEl.textContent = "Projects";
      actionsEl.innerHTML = `<button class="btn btn-primary" data-action="new-project">+ New Project</button>`;
      ws.innerHTML = renderProjectsView();
      break;
    case "project-detail":
      ws.innerHTML = renderProjectDetailView(state.selectedId);
      if (fab) fab.hidden = true;
      break;
    case "employees":
      titleEl.textContent = "Employees";
      actionsEl.innerHTML = `<button class="btn btn-primary" data-action="new-employee">+ Add Employee</button>`;
      ws.innerHTML = renderEmployeesView();
      break;
    case "estimates":
      titleEl.textContent = "Estimates";
      actionsEl.innerHTML = `<button class="btn btn-primary" data-action="new-estimate">+ Create Estimate</button>`;
      ws.innerHTML = renderEstimatesView();
      break;
    case "invoices":
      titleEl.textContent = "Invoices";
      actionsEl.innerHTML = `<button class="btn btn-primary" data-action="new-invoice">+ Create Invoice</button>`;
      ws.innerHTML = renderInvoicesView();
      break;
    case "expenses":
      titleEl.textContent = "Expenses & Receipts";
      actionsEl.innerHTML = `<button class="btn btn-primary" data-action="new-expense">+ Add Expense</button>`;
      ws.innerHTML = renderExpensesView();
      break;
    case "reports":
      titleEl.textContent = "Financial & Hours Reports";
      ws.innerHTML = renderReportsView();
      if (fab) fab.hidden = true;
      break;
    case "notifications":
      titleEl.textContent = "Notifications & Approvals";
      ws.innerHTML = renderNotificationsView();
      if (fab) fab.hidden = true;
      break;
    case "settings":
      titleEl.textContent = "Settings & Company Profile";
      ws.innerHTML = renderSettingsView();
      if (fab) fab.hidden = true;
      break;
    default:
      titleEl.textContent = "Tasks";
      ws.innerHTML = renderTasksView();
  }
}

// ==========================================================================
// 1. UNIFIED TASKS VIEW (Landing Page) & TASK DETAIL VIEW
// ==========================================================================

function getRoleFilteredTasks() {
  if (isEmployee()) {
    const emp = currentEmployee();
    return state.tasks.filter(t => t.assigned_to === emp.id || t.assigned_name === emp.name);
  }
  return state.tasks;
}

function getFilteredAndSortedTasks() {
  let list = getRoleFilteredTasks();
  const q = state.search.trim().toLowerCase();

  if (state.taskQuickChip === "today") {
    list = list.filter(t => t.days_diff === 0);
  } else if (state.taskQuickChip === "overdue") {
    list = list.filter(t => t.is_overdue);
  } else if (state.taskQuickChip === "completed") {
    list = list.filter(t => t.status === "Completed");
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

  const prioRank = { High: 1, Medium: 2, Low: 3 };
  list = [...list].sort((a, b) => {
    if (state.sortBy === "date-desc") return (b.visit_date || "").localeCompare(a.visit_date || "");
    if (state.sortBy === "priority") return (prioRank[a.priority] || 2) - (prioRank[b.priority] || 2);
    if (state.sortBy === "status") return (a.status || "").localeCompare(b.status || "");
    return (a.visit_date || "").localeCompare(b.visit_date || "");
  });

  return list;
}

function formatDueDateLabel(t) {
  if (!t.visit_date) return "Unscheduled";
  if (t.days_diff === 0) return `Today • ${t.scheduled_time}`;
  if (t.days_diff === 1) return `Tomorrow • ${t.scheduled_time}`;
  if (t.days_diff === -1) return `Yesterday • ${t.scheduled_time}`;
  return `${t.visit_date} • ${t.scheduled_time}`;
}

function renderTasksView() {
  const baseTasks = getRoleFilteredTasks();
  const todayCount = baseTasks.filter(t => t.days_diff === 0).length;
  const overdueCount = baseTasks.filter(t => t.is_overdue).length;
  const completedCount = baseTasks.filter(t => t.status === "Completed").length;
  const pendingApprovalCount = baseTasks.filter(t => t.approval_status !== "Approved").length;

  const list = getFilteredAndSortedTasks();

  const chips = [
    ["all", `All (${baseTasks.length})`],
    ["today", `Today (${todayCount})`],
    ["overdue", `Overdue (${overdueCount})`],
    ["completed", `Completed (${completedCount})`],
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

  const assigneeOpts = `<option value="all">All Employees</option>` + state.employees.map(e =>
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
    const rowCls = t.is_overdue ? "row-clickable row-overdue" : (t.days_diff >= 0 && t.days_diff <= 3 && t.status !== "Completed" ? "row-clickable row-soon" : "row-clickable");
    return `<tr class="${rowCls}" data-open-task="${esc(t.id)}">
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
    return `<div class="mob-task-card ${t.is_overdue ? "row-overdue" : ""}" data-open-task="${esc(t.id)}">
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
        <select class="filter-select" id="fltSort">
          <option value="date-asc" ${state.sortBy === "date-asc" ? "selected" : ""}>Sort: Due Date ↑</option>
          <option value="date-desc" ${state.sortBy === "date-desc" ? "selected" : ""}>Sort: Due Date ↓</option>
          <option value="priority" ${state.sortBy === "priority" ? "selected" : ""}>Sort: Priority</option>
          <option value="status" ${state.sortBy === "status" ? "selected" : ""}>Sort: Status</option>
        </select>
      </div>
    </div>

    ${list.length === 0 ? `
      <div class="data-card empty-state">
        <div class="empty-icon">☑️</div>
        <h3>No matching tasks found</h3>
        <p style="margin:6px 0 16px;">Try clearing your filters or create a new task (you can also create a new Project &amp; Client inside the task form).</p>
        <button class="btn btn-primary" data-action="new-task">+ Create New Task</button>
      </div>
    ` : `
      <!-- Desktop Table View -->
      <div class="data-card desktop-table-view">
        <div class="table-responsive">
          <table class="crm-table">
            <thead>
              <tr>
                <th>Task &amp; Work Address</th>
                <th>Client</th>
                <th>Project</th>
                <th>Schedule / Due</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Assignee</th>
                <th>Hours (Act/Plan)</th>
              </tr>
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
  $("breadcrumbs").innerHTML = `
    <button class="crumb-link" data-open-client="${esc(t.client_id)}">${esc(t.client_name)}</button> /
    <button class="crumb-link" data-open-project="${esc(t.project_id)}">${esc(t.project_name)}</button> /
    <span>Task #${esc(String(t.id).slice(0, 8))}</span>
  `;
  $("topbarActions").innerHTML = `
    <button class="btn" data-edit-task="${esc(t.id)}">✏️ Edit</button>
    ${!isEmployee() ? `<button class="btn btn-danger" data-delete-entity="visits" data-delete-id="${esc(t.id)}" data-back-view="tasks">🗑 Delete</button>` : ""}
  `;

  const isRunning = Boolean(state.timers[t.id]);
  const elapsedSec = isRunning ? Math.max(0, Math.floor((Date.now() - state.timers[t.id]) / 1000)) : 0;
  const clockStr = formatTimerClock(elapsedSec);
  const diffHours = +(t.actual_hours - t.planned_hours).toFixed(2);

  const urls = t.image_urls || [];
  const catCards = PHOTO_CATS.map(cat => {
    const catUrls = urls.filter(u => (t.photo_categories?.[u] || "Before") === cat);
    const thumbs = catUrls.map(u => `
      <span class="thumb">
        <img src="${esc(u)}" alt="${cat} photo" data-lightbox="${esc(u)}">
        <button class="photo-del" title="Remove photo" data-del-task-photo="${esc(u)}" data-task-id="${esc(t.id)}">✕</button>
      </span>
    `).join("");
    return `
      <div class="photo-cat-card">
        <div class="photo-cat-header">
          <span>📸 ${cat} Photos (${catUrls.length})</span>
          <button class="btn btn-sm" data-upload-cat="${cat}" data-task-id="${esc(t.id)}">+ Upload</button>
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
                <div style="font-size:12px;color:var(--secondary);font-weight:600;">LIVE TIMER</div>
                <div id="liveTimerDisplay" class="timer-clock ${isRunning ? "running" : ""}" data-timer-task="${esc(t.id)}">${clockStr}</div>
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
            <button class="btn btn-sm btn-primary" data-add-task-expense="${esc(t.id)}">+ Receipt</button>
          </div>
          ${renderTaskReceiptsMiniList(t)}
        </div>
      </div>
    </div>
  `;
}

function renderTaskReceiptsMiniList(task) {
  const list = state.receipts.filter(r => sameId(r.visit_id, task.id));
  if (!list.length) {
    return `<p style="font-size:13px;color:var(--secondary);">No receipts attached to this task.</p>`;
  }
  return list.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <div>
        <strong>${esc(r.store_clean || "Store")}</strong> • ${esc(r.category || "Other")}
        <div>${renderApprovalBadge(r.approval_status)}</div>
      </div>
      <strong>${usd(r.amount)}</strong>
    </div>
  `).join("");
}

// ==========================================================================
// 2. CLIENTS DIRECTORY & CLIENT DETAIL VIEW
// ==========================================================================

function renderClientsView() {
  const q = state.search.trim().toLowerCase();
  const list = state.clients.filter(c =>
    !q || [c.name, c.first_name, c.last_name, c.company_name, c.phone, c.email, c.street, c.city]
      .some(v => String(v || "").toLowerCase().includes(q))
  );

  const rows = list.map(c => {
    const projCount = state.projects.filter(p => sameId(p.client_id, c.id)).length;
    const addr = [c.street, c.city, c.state, c.zip].filter(Boolean).join(", ") || "—";
    return `<tr class="row-clickable" data-open-client="${esc(c.id)}">
      <td>
        <div style="font-weight:600;color:var(--dark);">${esc(c.first_name)} ${esc(c.last_name)}</div>
        ${c.company_name ? `<div style="font-size:12px;color:var(--secondary);">🏢 ${esc(c.company_name)}</div>` : ""}
        ${renderApprovalBadge(c.approval_status)}
      </td>
      <td>${esc(c.phone || "—")}</td>
      <td>${esc(c.email || "—")}</td>
      <td>${esc(addr)}</td>
      <td><strong>${projCount}</strong> project(s)</td>
      ${!isEmployee() ? `<td>${c.debt > 0 ? `<span class="badge badge-overdue">Unpaid: ${usd(c.debt)}</span>` : `<span class="badge st-completed">Paid</span>`}</td>` : ""}
    </tr>`;
  }).join("");

  return `
    <div class="data-card">
      <div class="table-responsive">
        <table class="crm-table">
          <thead>
            <tr>
              <th>Client / Company</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Contact Address</th>
              <th>Projects</th>
              ${!isEmployee() ? `<th>Balance</th>` : ""}
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="6" class="empty-state">No clients found.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderClientDetailView(clientId) {
  const c = state.clients.find(x => sameId(x.id, clientId));
  if (!c) return `<div class="empty-state">Client not found.</div>`;

  const clientProjects = state.projects.filter(p => sameId(p.client_id, c.id));
  const clientTasks = state.tasks.filter(t => sameId(t.client_id, c.id));

  $("pageTitle").textContent = c.name;
  $("breadcrumbs").innerHTML = `<button class="crumb-link" data-nav="clients">Clients</button> / <span>${esc(c.name)}</span>`;
  $("topbarActions").innerHTML = `
    <button class="btn" data-edit-client="${esc(c.id)}">✏️ Edit</button>
    <button class="btn btn-primary" data-new-project-for="${esc(c.id)}">+ New Project</button>
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
            <button class="btn btn-sm btn-primary" data-new-project-for="${esc(c.id)}">+ Add Project</button>
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
                      <td><strong>${esc(p.name)}</strong> ${renderApprovalBadge(p.approval_status)}</td>
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

function renderProjectsView() {
  const q = state.search.trim().toLowerCase();
  const list = state.projects.filter(p =>
    !q || [p.name, p.client_name, p.street, p.city, p.clean_description]
      .some(v => String(v || "").toLowerCase().includes(q))
  );

  const rows = list.map(p => {
    const pTasks = state.tasks.filter(t => sameId(t.project_id, p.id));
    const plannedH = pTasks.reduce((s, t) => s + t.planned_hours, 0);
    const actualH = pTasks.reduce((s, t) => s + t.actual_hours, 0);
    const workAddr = [p.street, p.city, p.state, p.zip].filter(Boolean).join(", ") || "—";
    return `<tr class="row-clickable" data-open-project="${esc(p.id)}">
      <td>
        <div style="font-weight:600;color:var(--dark);">${esc(p.name)}</div>
        ${renderApprovalBadge(p.approval_status)}
      </td>
      <td><button class="crumb-link" data-open-client="${esc(p.client_id)}" onclick="event.stopPropagation()">${esc(p.client_name)}</button></td>
      <td>📍 ${esc(workAddr)}</td>
      <td>${renderStatusBadge(p.project_status)}</td>
      <td>${pTasks.length} tasks</td>
      <td><strong>${actualH}h</strong> / ${plannedH}h</td>
    </tr>`;
  }).join("");

  return `
    <div class="data-card">
      <div class="table-responsive">
        <table class="crm-table">
          <thead>
            <tr>
              <th>Project Name</th>
              <th>Client</th>
              <th>Work Address</th>
              <th>Status</th>
              <th>Tasks</th>
              <th>Hours (Actual / Planned)</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="6" class="empty-state">No projects found.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

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

  const estValue = p.estimate_mode === "fixed"
    ? Number(p.estimate_fixed || 0)
    : p.estimate_mode === "hourly"
      ? Number(p.estimate_rate || 0) * Number(p.estimate_hours || 0)
      : 0;
  const invoicedValue = pInvoices.reduce((s, i) => s + Number(i.total || 0), 0);

  $("pageTitle").textContent = p.name;
  $("breadcrumbs").innerHTML = `
    <button class="crumb-link" data-open-client="${esc(p.client_id)}">${esc(p.client_name)}</button> /
    <span>${esc(p.name)}</span>
  `;
  $("topbarActions").innerHTML = `
    <button class="btn" data-edit-project="${esc(p.id)}">✏️ Edit</button>
    <button class="btn btn-primary" data-new-task-for="${esc(p.id)}">+ Add Task</button>
    ${!isEmployee() ? `<button class="btn btn-danger" data-delete-entity="projects" data-delete-id="${esc(p.id)}" data-back-view="projects">🗑 Delete</button>` : ""}
  `;

  const workAddr = [p.street, p.city, p.state, p.zip].filter(Boolean).join(", ") || "No job-site work address set";

  const tabs = [
    ["overview", "Overview"],
    ["tasks", `Tasks (${pTasks.length})`],
    ...(!isEmployee() ? [
      ["estimates", "Estimate"],
      ["invoices", `Invoices (${pInvoices.length})`],
    ] : []),
    ["expenses", `Expenses (${pReceipts.length})`],
    ["documents", "Photos & Documents"],
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
          <button class="btn btn-sm btn-primary" data-new-task-for="${esc(p.id)}">+ New Task</button>
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
  } else if (state.projectTab === "estimates" && !isEmployee()) {
    tabContent = renderEstimateDocumentCard(p);
  } else if (state.projectTab === "invoices" && !isEmployee()) {
    tabContent = renderInvoicesTableCard(pInvoices, p.id);
  } else if (state.projectTab === "expenses") {
    tabContent = renderReceiptsTableCard(pReceipts, p.id);
  } else if (state.projectTab === "documents") {
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
          <h2 style="font-size:22px;font-weight:700;">${esc(p.name)}</h2>
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

function renderEstimateDocumentCard(p) {
  const mode = p.estimate_mode || "";
  const hasEstimate = mode === "fixed" || mode === "hourly";
  const rate = Number(p.estimate_rate || state.profile.default_hourly_rate || 85);
  const hours = Number(p.estimate_hours || 0);
  const total = mode === "fixed"
    ? Number(p.estimate_fixed || 0)
    : mode === "hourly"
      ? rate * hours
      : 0;

  const workAddr = [p.street, p.city, p.state, p.zip].filter(Boolean).join(", ") || "Job site address not set";
  const paymentInstructions = state.profile.payment_details || "Zelle / Check / Cash upon completion";
  const companyName = state.profile.company_name || "HandyCRM Services";

  return `
    <div class="est-doc-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <h3 style="font-size:18px;font-weight:700;color:var(--dark);">${esc(p.name)}</h3>
            <span class="badge ${hasEstimate ? "st-in-progress" : "st-scheduled"}">
              ${mode === "fixed" ? "Fixed Price Estimate" : mode === "hourly" ? `Hourly Estimate (${usd(rate)}/hr × ${hours}h)` : "Standard Rate (No Custom Estimate)"}
            </span>
          </div>
          <div style="font-size:13px;color:var(--secondary);margin-top:4px;">
            Client: <button class="crumb-link" data-open-client="${esc(p.client_id)}">${esc(p.client_name)}</button> • 📍 ${esc(workAddr)}
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div style="text-align:right;">
            <div style="font-size:11px;color:var(--secondary);text-transform:uppercase;font-weight:600;">Estimated Total</div>
            <div style="font-size:20px;font-weight:700;color:var(--primary);">${usd(total)}</div>
          </div>
          <button class="btn btn-sm btn-primary" data-edit-estimate="${esc(p.id)}">
            ${hasEstimate ? "✏️ Edit Estimate" : "+ Create Estimate"}
          </button>
        </div>
      </div>

      <div class="est-doc-body">
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <label style="font-size:12px;font-weight:700;color:var(--secondary);text-transform:uppercase;">Estimate Scope &amp; Description</label>
            <button class="btn btn-sm" data-fill-est-from-tasks="${esc(p.id)}">↻ Fill from Tasks</button>
          </div>
          <div style="padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:14px;white-space:pre-wrap;min-height:68px;color:var(--dark);">${esc(p.clean_description || "No scope description written yet. Click 'Edit Estimate' or 'Fill from Tasks' to add work details.")}</div>
        </div>

        <div class="est-payment-box">
          <div style="font-size:11px;font-weight:700;color:var(--secondary);text-transform:uppercase;margin-bottom:6px;">
            Prepared By &amp; Payment Terms
          </div>
          <div style="font-weight:600;color:var(--dark);margin-bottom:4px;">${esc(companyName)}</div>
          ${state.profile.phone ? `<div style="font-size:12px;color:var(--secondary);">📞 ${esc(state.profile.phone)}</div>` : ""}
          <div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);font-size:13px;">
            <strong>Accepted Payment Options:</strong>
            <div style="color:var(--secondary);margin-top:2px;white-space:pre-wrap;">${esc(paymentInstructions)}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderEstimatesView() {
  if (!state.projects.length) {
    return `
      <div class="data-card empty-state">
        <div class="empty-icon">📋</div>
        <h3>No project estimates yet</h3>
        <p style="margin:6px 0 16px;">Create a new estimate to define scope of work, pricing, and payment terms.</p>
        <button class="btn btn-primary" data-action="new-estimate">+ Create First Estimate</button>
      </div>
    `;
  }
  return state.projects.map(p => renderEstimateDocumentCard(p)).join("");
}

function showEstimateModal(projectId = null) {
  const p = projectId ? state.projects.find(x => sameId(x.id, projectId)) : state.projects[0];
  const mode = p?.estimate_mode || "fixed";
  const defaultRate = Number(p?.estimate_rate || state.profile.default_hourly_rate || 85);

  const projOpts = state.projects.map(proj =>
    `<option value="${esc(proj.id)}" ${sameId(proj.id, p?.id) ? "selected" : ""}>${esc(proj.client_name)} — ${esc(proj.name)}</option>`
  ).join("");

  const clientOpts = state.clients.map(c =>
    `<option value="${esc(c.id)}">${esc(c.name)}</option>`
  ).join("");

  openModal(
    p ? `Estimate — ${p.name}` : "Create Project Estimate",
    `<div class="form-grid">
      <div class="form-field wide">
        <label>Select Project *</label>
        <select id="mEstProjectSelect" class="form-select">
          ${projOpts}
          <option value="__new__" ${!state.projects.length ? "selected" : ""}>➕ Create New Project for this Estimate...</option>
        </select>
      </div>

      <!-- Inline New Project Creation inside Estimate Modal -->
      <div id="mEstNewProjBox" class="inline-create-box form-field wide" ${state.projects.length ? "hidden" : ""}>
        <div class="inline-create-title">📁 New Project Details</div>
        <div class="form-grid">
          <div class="form-field">
            <label>Client *</label>
            <select id="mEstClientSelect" class="form-select">
              ${clientOpts}
              <option value="__new__" ${!state.clients.length ? "selected" : ""}>➕ Create New Client...</option>
            </select>
          </div>
          <div class="form-field">
            <label>New Project Name *</label>
            <input id="mEstNewProjName" class="form-input" placeholder="e.g., Bathroom Tile & Vanity">
          </div>
          <div id="mEstNewCliBox" class="form-field wide" ${state.clients.length ? "hidden" : ""}>
            <label>New Client Full Name &amp; Phone *</label>
            <div style="display:flex;gap:8px;">
              <input id="mEstNewCliName" class="form-input" style="flex:1;" placeholder="Client Full Name">
              <input id="mEstNewCliPhone" class="form-input" style="flex:1;" placeholder="Phone Number">
            </div>
          </div>
        </div>
      </div>

      <div class="form-field wide">
        <label>Estimate Pricing Type *</label>
        <select id="mEstMode" class="form-select">
          <option value="fixed" ${mode === "fixed" ? "selected" : ""}>Fixed Price (Flat Project Fee)</option>
          <option value="hourly" ${mode === "hourly" ? "selected" : ""}>Hourly Rate × Estimated Hours</option>
          <option value="" ${!mode ? "selected" : ""}>No Fixed Estimate (Bill Actual Task Hours)</option>
        </select>
      </div>

      <div id="mEstFixedRow" class="form-field wide" ${mode === "fixed" ? "" : "hidden"}>
        <label>Fixed Project Price ($)</label>
        <input id="mEstFixedVal" type="number" step="0.01" min="0" class="form-input" value="${Number(p?.estimate_fixed || 0)}">
      </div>

      <div id="mEstHourlyRow" class="form-grid form-field wide" ${mode === "hourly" ? "" : "hidden"}>
        <div class="form-field">
          <label>Hourly Rate ($/hr)</label>
          <input id="mEstRateVal" type="number" step="0.01" min="0" class="form-input" value="${defaultRate}">
        </div>
        <div class="form-field">
          <label>Estimated Hours</label>
          <input id="mEstHoursVal" type="number" step="0.5" min="0" class="form-input" value="${Number(p?.estimate_hours || 4)}">
        </div>
      </div>

      <div class="form-field wide">
        <label>Estimate Scope of Work &amp; Description *</label>
        <textarea id="mEstDescription" class="form-textarea" rows="4" placeholder="Itemize the work included in this estimate, materials covered, and any exclusions...">${esc(p?.clean_description || "")}</textarea>
      </div>

      <div class="form-field wide">
        <label>Payment Options &amp; Terms (Shown on Estimate &amp; Invoices)</label>
        <textarea id="mEstPaymentTerms" class="form-textarea" rows="2" placeholder="e.g., Zelle to handyman33432@gmail.com, Check, or Cash">${esc(state.profile.payment_details || "Zelle / Check")}</textarea>
      </div>
    </div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-submit-estimate="1">Save Estimate</button>`
  );
}

async function handleSaveEstimateModal() {
  let projId = $("mEstProjectSelect")?.value;
  const mode = $("mEstMode")?.value || null;
  const fixedVal = Number($("mEstFixedVal")?.value || 0);
  const rateVal = Number($("mEstRateVal")?.value || state.profile.default_hourly_rate || 85);
  const hoursVal = Number($("mEstHoursVal")?.value || 0);
  const desc = $("mEstDescription")?.value.trim() || "";
  const paymentTerms = $("mEstPaymentTerms")?.value.trim() || "";

  closeModal();
  setSave("saving");
  try {
    // Save updated payment terms to profile if changed
    if (paymentTerms && paymentTerms !== state.profile.payment_details) {
      await saveField("profile", 1, "payment_details", paymentTerms);
    }

    // Create Client + Project inline if user chose "__new__"
    if (projId === "__new__") {
      let clientId = $("mEstClientSelect")?.value;
      if (clientId === "__new__") {
        const cliName = $("mEstNewCliName")?.value.trim() || "New Client";
        const cliPhone = $("mEstNewCliPhone")?.value.trim() || "";
        const newCli = await api("POST", "/clients", { name: cliName });
        clientId = newCli.id;
        if (cliPhone) await saveField("clients", clientId, "phone", cliPhone);
      }
      const projName = $("mEstNewProjName")?.value.trim() || "New Project";
      const newProj = await api("POST", "/projects", { client_id: clientId, name: projName });
      projId = newProj.id;
    }

    const existingProj = state.projects.find(x => sameId(x.id, projId));
    const meta = {
      ...(existingProj?._meta || {}),
      project_status: existingProj?.project_status || "Active",
      approval_status: existingProj?.approval_status || "Approved",
    };

    await saveFields("projects", projId, {
      estimate_mode: mode,
      estimate_fixed: fixedVal,
      estimate_rate: rateVal,
      estimate_hours: hoursVal,
      estimate_description: packTextAndMeta(desc, meta),
    });

    await syncCRM(true);
    navigate("estimates");
  } catch (e) {
    setSave("error", e.message);
    alert(e.message);
  }
}

async function handleFillEstimateFromTasks(projectId) {
  const p = state.projects.find(x => sameId(x.id, projectId));
  if (!p) return;
  const pTasks = state.tasks.filter(t => sameId(t.project_id, p.id) && t.status !== "Canceled");
  if (!pTasks.length) {
    return alert("No active tasks found in this project yet.");
  }
  const lines = pTasks.map(t => `• ${t.title}${t.description ? ": " + t.description : ""} (${t.planned_hours}h)`).join("\n");
  const packed = packTextAndMeta(lines, p._meta || {});
  await saveField("projects", p.id, "estimate_description", packed);
  await syncCRM(true);
}

function renderInvoicesTableCard(list) {
  const rows = list.map(i => {
    const needsOwnerApproval = i.approval_status === "PendingApproval";
    return `<tr>
      <td><strong>#${esc(i.invoice_number)}</strong></td>
      <td>${esc(i.client_name)}</td>
      <td>${esc(i.project_name)}</td>
      <td>${esc(i.invoice_date)}</td>
      <td>${usd(i.labor_amount)}</td>
      <td>${usd(i.materials_amount)}</td>
      <td><strong>${usd(i.total)}</strong></td>
      <td>
        ${renderStatusBadge(i.status === "Paid" ? "Completed" : "Pending")}
        <div style="margin-top:4px;">${renderApprovalBadge(i.approval_status)}</div>
      </td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm" data-toggle-inv-paid="${esc(i.id)}" data-cur-status="${esc(i.status)}">
            ${i.status === "Paid" ? "Mark Unpaid" : "✓ Mark Paid"}
          </button>
          ${needsOwnerApproval && isOwner() ? `
            <button class="btn btn-sm btn-success" data-approve-kind="invoice" data-approve-id="${esc(i.id)}">Approve to Send</button>
          ` : ""}
          ${!needsOwnerApproval ? `
            <a class="btn btn-sm" href="/api/invoices/${esc(i.id)}/pdf" target="_blank">PDF</a>
          ` : `<span style="font-size:11px;color:var(--warning-text);">Awaiting Owner Approval</span>`}
          <button class="btn btn-sm btn-danger" data-delete-entity="invoices" data-delete-id="${esc(i.id)}">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  return `
    <div class="data-card">
      <div class="table-responsive">
        <table class="crm-table">
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Client</th>
              <th>Project</th>
              <th>Date</th>
              <th>Labor</th>
              <th>Materials</th>
              <th>Total</th>
              <th>Payment / Approval</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="9" class="empty-state">No invoices generated yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderInvoicesView() {
  return renderInvoicesTableCard(state.invoices);
}

function renderReceiptsTableCard(list) {
  const rows = list.map(r => `
    <tr>
      <td>${esc(r.receipt_date || r.visit_date || "—")}</td>
      <td><strong>${esc(r.store_clean || "Vendor")}</strong></td>
      <td>${esc(r.category || "Construction")}</td>
      <td>${esc(r.project_name)}</td>
      <td><strong>${usd(r.amount)}</strong></td>
      <td>
        ${renderApprovalBadge(r.approval_status) || `<span class="badge st-completed">Approved</span>`}
        ${r.rejection_reason ? `<div style="font-size:11px;color:var(--error-text);">${esc(r.rejection_reason)}</div>` : ""}
      </td>
      ${!isEmployee() ? `
        <td>
          <button class="btn btn-sm ${r.billable ? "btn-primary" : ""}" data-toggle-billable="${esc(r.id)}" data-cur-bill="${r.billable ? 1 : 0}">
            ${r.billable ? "✓ Billable on Invoice" : "+ Make Billable"}
          </button>
        </td>
      ` : ""}
      <td>
        <div class="photo-grid">
          ${(r.image_urls || []).map(u => `<span class="thumb" style="width:40px;height:40px;"><img src="${esc(u)}" data-lightbox="${esc(u)}"></span>`).join("")}
          <button class="btn btn-sm" data-upload-receipt="${esc(r.id)}">📷+</button>
        </div>
      </td>
      <td>
        <div style="display:flex;gap:6px;">
          ${r.approval_status === "PendingApproval" && canApprove() ? `
            <button class="btn btn-sm btn-success" data-approve-kind="receipt" data-approve-id="${esc(r.id)}">✓</button>
            <button class="btn btn-sm btn-danger" data-reject-kind="receipt" data-reject-id="${esc(r.id)}">✕</button>
          ` : ""}
          ${!isEmployee() ? `<button class="btn btn-sm btn-danger" data-delete-entity="receipts" data-delete-id="${esc(r.id)}">🗑</button>` : ""}
        </div>
      </td>
    </tr>
  `).join("");

  return `
    <div class="data-card">
      <div class="table-responsive">
        <table class="crm-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Store / Vendor</th>
              <th>Category</th>
              <th>Project</th>
              <th>Amount</th>
              <th>Approval Status (>${usd(state.expenseThreshold)})</th>
              ${!isEmployee() ? `<th>Billable</th>` : ""}
              <th>Receipt Photo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="9" class="empty-state">No expenses or receipts recorded yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderExpensesView() {
  return renderReceiptsTableCard(state.receipts);
}

// ==========================================================================
// 5. EMPLOYEES, REPORTS, NOTIFICATIONS & SETTINGS VIEWS
// ==========================================================================

function renderEmployeesView() {
  const rows = state.employees.map(e => {
    const empTasks = state.tasks.filter(t => t.assigned_to === e.id || t.assigned_name === e.name);
    const activeCount = empTasks.filter(t => t.status !== "Completed" && t.status !== "Canceled").length;
    const completedCount = empTasks.filter(t => t.status === "Completed").length;
    const totalHours = empTasks.reduce((s, t) => s + t.actual_hours, 0);
    return `<tr>
      <td><strong>${esc(e.name)}</strong><div style="font-size:12px;color:var(--secondary);">${esc(e.specialty || "")}</div></td>
      <td>${esc(e.role)}</td>
      <td>${esc(e.phone)}</td>
      <td>${esc(e.email)}</td>
      <td><span class="badge ${e.active ? "st-completed" : "st-canceled"}">${e.active ? "Active" : "Inactive"}</span></td>
      <td><strong>${activeCount}</strong> open / ${completedCount} done</td>
      <td><strong>${totalHours}h</strong> logged</td>
    </tr>`;
  }).join("");

  return `
    <div class="data-card">
      <div class="table-responsive">
        <table class="crm-table">
          <thead>
            <tr><th>Employee</th><th>Role</th><th>Phone</th><th>Email</th><th>Status</th><th>Assigned Tasks</th><th>Hours Logged</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderReportsView() {
  const totalInvoiced = state.invoices.reduce((s, i) => s + Number(i.total || 0), 0);
  const totalPaid = state.invoices.filter(i => i.status === "Paid").reduce((s, i) => s + Number(i.total || 0), 0);
  const totalUnpaid = totalInvoiced - totalPaid;
  const totalExpenses = state.receipts.reduce((s, r) => s + Number(r.amount || 0), 0);
  const netProfit = totalPaid - totalExpenses;
  const totalActualH = state.tasks.reduce((s, t) => s + t.actual_hours, 0);
  const totalPlannedH = state.tasks.reduce((s, t) => s + t.planned_hours, 0);

  return `
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Total Invoiced</div><div class="kpi-value">${usd(totalInvoiced)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Collected Payments</div><div class="kpi-value" style="color:var(--success-text);">${usd(totalPaid)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Outstanding Unpaid</div><div class="kpi-value" style="color:var(--error-text);">${usd(totalUnpaid)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Material Expenses</div><div class="kpi-value">${usd(totalExpenses)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Net Collected Profit</div><div class="kpi-value" style="color:var(--primary);">${usd(netProfit)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Hours (Act / Plan)</div><div class="kpi-value">${totalActualH}h / ${totalPlannedH}h</div></div>
    </div>
  `;
}

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

function renderSettingsView() {
  const p = state.profile || {};
  return `
    <div class="section-card">
      <div class="section-header"><h3 class="section-title">Company Profile &amp; Invoice Header</h3></div>
      <div class="form-grid">
        <div class="form-field">
          <label>Company / LLC Name</label>
          <input id="setCompany" class="form-input" value="${esc(p.company_name || "")}" ${isEmployee() ? "disabled" : ""}>
        </div>
        <div class="form-field">
          <label>Phone</label>
          <input id="setPhone" class="form-input" value="${esc(p.phone || "")}" ${isEmployee() ? "disabled" : ""}>
        </div>
        <div class="form-field">
          <label>Email</label>
          <input id="setEmail" class="form-input" value="${esc(p.email || "")}" ${isEmployee() ? "disabled" : ""}>
        </div>
        <div class="form-field">
          <label>Default Hourly Rate ($/hr)</label>
          <input id="setRate" type="number" step="1" class="form-input" value="${Number(p.default_hourly_rate || 85)}" ${isEmployee() ? "disabled" : ""}>
        </div>
        <div class="form-field wide">
          <label>Business Address</label>
          <input id="setAddress" class="form-input" value="${esc(p.business_address || "")}" ${isEmployee() ? "disabled" : ""}>
        </div>
        <div class="form-field wide">
          <label>Payment Instructions (Shown inside Estimates &amp; Invoices)</label>
          <textarea id="setPayment" class="form-textarea" rows="2" ${isEmployee() ? "disabled" : ""}>${esc(p.payment_details || "")}</textarea>
        </div>
        <div class="form-field">
          <label>Employee Expense Approval Threshold ($)</label>
          <input id="setExpThreshold" type="number" step="10" class="form-input" value="${state.expenseThreshold}" ${isEmployee() ? "disabled" : ""}>
        </div>
      </div>
      ${!isEmployee() ? `
        <div style="margin-top:18px;">
          <button class="btn btn-primary" data-action="save-settings">Save Profile &amp; Settings</button>
        </div>
      ` : ""}
    </div>
  `;
}

// ==========================================================================
// 6. MODALS, ALL-IN-ONE TASK/PROJECT/CLIENT CREATION & APPROVALS
// ==========================================================================

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
  const todayStr = new Date().toISOString().slice(0, 10);

  const projOpts = state.projects.map(p =>
    `<option value="${esc(p.id)}" ${sameId(p.id, projId) ? "selected" : ""}>${esc(p.client_name)} — ${esc(p.name)}</option>`
  ).join("");

  const clientOpts = state.clients.map(c =>
    `<option value="${esc(c.id)}">${esc(c.name)}</option>`
  ).join("");

  const empOpts = state.employees.filter(e => e.active).map(e =>
    `<option value="${esc(e.id)}" ${existingTask?.assigned_to === e.id ? "selected" : ""}>${esc(e.name)} (${esc(e.role)})</option>`
  ).join("");

  openModal(
    isEdit ? `Edit Task #${existingTask.id}` : "Create New Task",
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
        <input id="mTaskDate" type="date" class="form-input" value="${esc(existingTask?.visit_date || todayStr)}">
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

async function handleSaveTaskModal(taskId) {
  const title = $("mTaskTitle")?.value.trim() || "Service Task";
  let projectId = $("mTaskProject")?.value;
  const empId = isEmployee() ? state.activeEmployeeId : $("mTaskAssignee")?.value;
  const empObj = state.employees.find(e => e.id === empId) || state.employees[0];
  const priority = $("mTaskPriority")?.value || "Medium";
  const visitDate = $("mTaskDate")?.value || new Date().toISOString().slice(0, 10);
  const scheduledTime = $("mTaskTime")?.value.trim() || "09:00 AM";
  const plannedHours = Number($("mTaskPlannedH")?.value || 2);
  const description = $("mTaskDesc")?.value.trim() || "";

  const existing = taskId ? state.tasks.find(t => sameId(t.id, taskId)) : null;
  const approvalStatus = isEmployee() ? "PendingApproval" : "Approved";

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
      assigned_to: empObj.id,
      assigned_name: empObj.name,
      priority,
      scheduled_time: scheduledTime,
      planned_hours: plannedHours,
      approval_status: approvalStatus,
      rejection_reason: "",
      created_by_role: existing?.created_by_role || state.role,
    };

    const packedWork = packTextAndMeta(`${title}\n${description}`, meta);

    closeModal();
    let targetId = taskId;
    if (!existing) {
      // Pass projectId directly (preserving string/UUID or number from backend)
      const created = await api("POST", "/visits", { project_id: projectId });
      targetId = created.id;
    }
    await saveFields("visits", targetId, {
      visit_date: visitDate,
      planned_work: packedWork,
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

  if (newStatus === "Completed" && state.timers[t.id]) {
    await stopTaskTimer(t.id, false);
  }

  const latestTask = state.tasks.find(x => sameId(x.id, taskId)) || t;

  if (newStatus === "Completed" && Number(latestTask.actual_hours) !== Number(latestTask.planned_hours)) {
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

// ---------- Live Stopwatch Timer ----------
function formatTimerClock(totalSeconds) {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return [hrs, mins, secs].map(n => String(n).padStart(2, "0")).join(":");
}

async function startTaskTimer(taskId) {
  state.timers[taskId] = Date.now();
  saveTimers();
  const t = state.tasks.find(x => sameId(x.id, taskId));
  if (t && t.status === "Scheduled") {
    await saveField("visits", taskId, "status", "In Progress");
  }
  await syncCRM(true);
}

async function stopTaskTimer(taskId, reload = true) {
  const startMs = state.timers[taskId];
  if (!startMs) return;
  const elapsedHours = Math.max(0.25, +((Date.now() - startMs) / 3600000).toFixed(2));
  delete state.timers[taskId];
  saveTimers();

  const t = state.tasks.find(x => sameId(x.id, taskId));
  const updatedHours = +((Number(t?.actual_hours || 0)) + elapsedHours).toFixed(2);
  await saveField("visits", taskId, "time_spent", updatedHours);
  if (reload) await syncCRM(true);
}

function startGlobalTimerTicker() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const el = $("liveTimerDisplay");
    if (!el) return;
    const tid = el.dataset.timerTask;
    if (tid && state.timers[tid]) {
      const sec = Math.max(0, Math.floor((Date.now() - state.timers[tid]) / 1000));
      el.textContent = formatTimerClock(sec);
    }
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
    approval_status: isEmployee() ? "PendingApproval" : "Approved",
    rejection_reason: "",
    created_by_role: existing?.created_by_role || state.role,
  };

  closeModal();
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
  const approvalStatus = isEmployee() ? "PendingApproval" : "Approved";

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

// ---------- Expense & Invoice Creation Modals ----------
function showExpenseModal(defaultTaskId = null) {
  const tasks = state.tasks;
  if (!tasks.length) {
    alert("Create a project and task first so the expense can be linked.");
    return;
  }
  const taskId = defaultTaskId || tasks[tasks.length - 1].id;
  const opts = tasks.map(t =>
    `<option value="${esc(t.id)}" ${sameId(t.id, taskId) ? "selected" : ""}>${esc(t.project_name)} — ${esc(t.title)} (${esc(t.visit_date)})</option>`
  ).join("");

  openModal(
    "Submit Expense / Receipt",
    `<div class="form-grid">
      <div class="form-field wide">
        <label>Linked Task &amp; Project *</label>
        <select id="mExpTask" class="form-select">${opts}</select>
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
        <input id="mExpDate" type="date" class="form-input" value="${new Date().toISOString().slice(0, 10)}">
      </div>
    </div>
    <p style="font-size:12px;color:var(--secondary);">Note: Employee expenses above <strong>${usd(state.expenseThreshold)}</strong> automatically require Manager/Owner approval.</p>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-submit-expense="1">Save Expense</button>`
  );
}

async function handleSaveExpenseModal() {
  const visitId = $("mExpTask").value;
  const task = state.tasks.find(t => sameId(t.id, visitId));
  const store = $("mExpStore").value.trim() || "Supply Store";
  const category = $("mExpCat").value;
  const amount = Number($("mExpAmount").value || 0);
  const receiptDate = $("mExpDate").value;

  const needsApproval = isEmployee() && amount > state.expenseThreshold;
  const meta = {
    submitted_by: isEmployee() ? currentEmployee().name : state.role,
    approval_status: needsApproval ? "PendingApproval" : "Approved",
  };

  closeModal();
  const created = await api("POST", "/receipts", { project_id: task.project_id, visit_id: task.id });
  await saveFields("receipts", created.id, {
    store: packTextAndMeta(store, meta),
    category,
    amount,
    receipt_date: receiptDate,
    billable: true,
  });
  await syncCRM(true);
}

function showInvoiceModal() {
  const activeTasks = state.tasks.filter(t => t.status !== "Canceled");
  if (!activeTasks.length) {
    alert("Create a project task first to generate an invoice.");
    return;
  }
  const opts = activeTasks.map(t =>
    `<option value="${esc(t.id)}">${esc(t.client_name)} — ${esc(t.project_name)} • ${esc(t.title)} (${esc(t.visit_date)})</option>`
  ).join("");

  openModal(
    "Create Invoice from Project Task",
    `<div class="form-field wide">
      <label>Select Task / Visit to Bill</label>
      <select id="mInvVisit" class="form-select">${opts}</select>
    </div>
    ${isManager() ? `<div class="alert-box alert-info" style="margin-top:10px;">Manager-created invoices are marked <strong>Pending Owner Approval</strong> before they can be sent to the client.</div>` : ""}`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-primary" data-submit-invoice="1">Generate Invoice</button>`
  );
}

async function handleCreateInvoiceModal() {
  const visitId = $("mInvVisit").value;
  closeModal();
  setSave("saving");
  try {
    const inv = await api("POST", `/visits/${visitId}/invoice`);
    if (isManager() && inv?.id) {
      const meta = { approval_status: "PendingApproval", created_by_role: "Manager" };
      await saveField("invoices", inv.id, "description", packTextAndMeta(inv.description || "", meta));
    }
    setSave("saved");
    await syncCRM(true);
    navigate("invoices");
  } catch (e) {
    setSave("error", e.message);
    alert(e.message);
  }
}

// ---------- Approval & Rejection Handlers ----------
async function handleApproveRecord(kind, id) {
  if (kind === "task") {
    const t = state.tasks.find(x => sameId(x.id, id));
    if (!t) return;
    const meta = { ...t._meta, approval_status: "Approved", rejection_reason: "" };
    await saveField("visits", t.id, "planned_work", packTextAndMeta(`${t.title}\n${t.description}`, meta));
  } else if (kind === "client") {
    const c = state.clients.find(x => sameId(x.id, id));
    if (!c) return;
    const meta = { ...c._meta, approval_status: "Approved", rejection_reason: "" };
    await saveField("clients", c.id, "notes", packTextAndMeta(c.clean_notes, meta));
  } else if (kind === "project") {
    const p = state.projects.find(x => sameId(x.id, id));
    if (!p) return;
    const meta = { ...p._meta, approval_status: "Approved", rejection_reason: "" };
    await saveField("projects", p.id, "estimate_description", packTextAndMeta(p.clean_description, meta));
  } else if (kind === "invoice") {
    const i = state.invoices.find(x => sameId(x.id, id));
    if (!i) return;
    const meta = { ...i._meta, approval_status: "Approved", rejection_reason: "" };
    await saveField("invoices", i.id, "description", packTextAndMeta(i.clean_description, meta));
  } else if (kind === "receipt") {
    const r = state.receipts.find(x => sameId(x.id, id));
    if (!r) return;
    const meta = { ...r._meta, approval_status: "Approved", rejection_reason: "" };
    await saveField("receipts", r.id, "store", packTextAndMeta(r.store_clean, meta));
  }
  await syncCRM(true);
}

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

async function confirmRejectRecord(kind, id) {
  const reason = $("mRejectReason")?.value.trim();
  if (!reason) {
    alert("A rejection reason is mandatory.");
    return;
  }
  closeModal();
  if (kind === "task") {
    const t = state.tasks.find(x => sameId(x.id, id));
    const meta = { ...t._meta, approval_status: "Rejected", rejection_reason: reason };
    await saveField("visits", t.id, "planned_work", packTextAndMeta(`${t.title}\n${t.description}`, meta));
  } else if (kind === "client") {
    const c = state.clients.find(x => sameId(x.id, id));
    const meta = { ...c._meta, approval_status: "Rejected", rejection_reason: reason };
    await saveField("clients", c.id, "notes", packTextAndMeta(c.clean_notes, meta));
  } else if (kind === "project") {
    const p = state.projects.find(x => sameId(x.id, id));
    const meta = { ...p._meta, approval_status: "Rejected", rejection_reason: reason };
    await saveField("projects", p.id, "estimate_description", packTextAndMeta(p.clean_description, meta));
  } else if (kind === "receipt") {
    const r = state.receipts.find(x => sameId(x.id, id));
    const meta = { ...r._meta, approval_status: "Rejected", rejection_reason: reason };
    await saveField("receipts", r.id, "store", packTextAndMeta(r.store_clean, meta));
  }
  await syncCRM(true);
}

// ---------- Photo Upload & Lightbox ----------
function openLightbox(url) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${esc(url)}" alt="Full size photo">`;
  box.addEventListener("click", () => box.remove());
  document.body.appendChild(box);
}

$("photoFileInput")?.addEventListener("change", async ev => {
  const files = [...(ev.target.files || [])];
  ev.target.value = "";
  if (!photoUploadContext || !files.length) return;

  setSave("saving");
  try {
    let latestUrls = [];
    for (const f of files) {
      const compressed = await compressImage(f);
      latestUrls = await uploadPhoto(photoUploadContext.entity, photoUploadContext.id, compressed);
    }
    if (photoUploadContext.entity === "visits" && photoUploadContext.category) {
      const t = state.tasks.find(x => sameId(x.id, photoUploadContext.id));
      if (t) {
        const catMap = { ...(t.photo_categories || {}) };
        (latestUrls || []).forEach(u => {
          if (!catMap[u]) catMap[u] = photoUploadContext.category;
        });
        const meta = { ...t._meta, photo_categories: catMap };
        await saveField("visits", t.id, "planned_work", packTextAndMeta(`${t.title}\n${t.description}`, meta));
      }
    }
    setSave("saved");
    await syncCRM(true);
  } catch (e) {
    setSave("error", e.message);
  }
});

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

  // Task Quick Filter Chips & Project Tabs
  if ((el = t.closest("[data-task-chip]"))) {
    state.taskQuickChip = el.dataset.taskChip;
    return renderCurrentView();
  }
  if ((el = t.closest("[data-proj-tab]"))) {
    state.projectTab = el.dataset.projTab;
    return renderCurrentView();
  }

  // Primary Actions & Modals
  if (t.closest('[data-action="new-task"]') || (t.closest("#mobileFab") && state.view === "tasks")) return showTaskModal();
  if ((el = t.closest("[data-new-task-for]"))) return showTaskModal(null, el.dataset.newTaskFor);
  if ((el = t.closest("[data-edit-task]"))) return showTaskModal(state.tasks.find(x => sameId(x.id, el.dataset.editTask)));
  if ((el = t.closest("[data-submit-task]"))) return handleSaveTaskModal(el.dataset.submitTask);

  if (t.closest('[data-action="new-client"]') || (t.closest("#mobileFab") && state.view === "clients")) return showClientModal();
  if ((el = t.closest("[data-edit-client]"))) return showClientModal(state.clients.find(x => sameId(x.id, el.dataset.editClient)));
  if ((el = t.closest("[data-submit-client]"))) return handleSaveClientModal(el.dataset.submitClient);

  if (t.closest('[data-action="new-project"]') || (t.closest("#mobileFab") && state.view === "projects")) return showProjectModal();
  if ((el = t.closest("[data-new-project-for]"))) return showProjectModal(null, el.dataset.newProjectFor);
  if ((el = t.closest("[data-edit-project]"))) return showProjectModal(state.projects.find(x => sameId(x.id, el.dataset.editProject)));
  if ((el = t.closest("[data-submit-project]"))) return handleSaveProjectModal(el.dataset.submitProject);

  // Estimates Modal & Auto-Fill
  if (t.closest('[data-action="new-estimate"]') || (t.closest("#mobileFab") && state.view === "estimates")) return showEstimateModal();
  if ((el = t.closest("[data-edit-estimate]"))) return showEstimateModal(el.dataset.editEstimate);
  if (t.closest("[data-submit-estimate]")) return handleSaveEstimateModal();
  if ((el = t.closest("[data-fill-est-from-tasks]"))) return handleFillEstimateFromTasks(el.dataset.fillEstFromTasks);

  if (t.closest('[data-action="new-expense"]') || (t.closest("#mobileFab") && state.view === "expenses")) return showExpenseModal();
  if ((el = t.closest("[data-add-task-expense]"))) return showExpenseModal(el.dataset.addTaskExpense);
  if (t.closest("[data-submit-expense]")) return handleSaveExpenseModal();

  if (t.closest('[data-action="new-invoice"]')) return showInvoiceModal();
  if (t.closest("[data-submit-invoice]")) return handleCreateInvoiceModal();

  // Task Status, Timer & Manual Hours
  if ((el = t.closest("[data-task-status]"))) return handleTaskStatusUpdate(el.dataset.taskId, el.dataset.taskStatus);
  if ((el = t.closest("[data-confirm-complete]"))) return confirmTaskCompleteWithReason(el.dataset.confirmComplete);
  if ((el = t.closest("[data-start-timer]"))) return startTaskTimer(el.dataset.startTimer);
  if ((el = t.closest("[data-stop-timer]"))) return stopTaskTimer(el.dataset.stopTimer);
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
    const author = isEmployee() ? currentEmployee().name : (isManager() ? "Alex Johnson" : "Owner");
    const comments = [...(task.comments || []), { author, role: state.role, text, date: new Date().toLocaleString() }];
    const meta = { ...task._meta, comments };
    await saveField("visits", task.id, "planned_work", packTextAndMeta(`${task.title}\n${task.description}`, meta));
    return syncCRM(true);
  }

  // Photos & Lightbox
  if ((el = t.closest("[data-lightbox]"))) return openLightbox(el.dataset.lightbox);
  if ((el = t.closest("[data-upload-cat]"))) {
    photoUploadContext = { entity: "visits", id: el.dataset.taskId, category: el.dataset.uploadCat };
    return $("photoFileInput")?.click();
  }
  if ((el = t.closest("[data-upload-receipt]"))) {
    photoUploadContext = { entity: "receipts", id: el.dataset.uploadReceipt, category: null };
    return $("photoFileInput")?.click();
  }
  if ((el = t.closest("[data-del-task-photo]"))) {
    const task = state.tasks.find(x => sameId(x.id, el.dataset.taskId));
    if (!task) return;
    const nextUrls = (task.image_urls || []).filter(u => u !== el.dataset.delTaskPhoto);
    await saveField("visits", task.id, "image_urls", nextUrls);
    return syncCRM(true);
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
    const next = el.dataset.curStatus === "Paid" ? "Unpaid" : "Paid";
    await saveFields("invoices", el.dataset.toggleInvPaid, {
      status: next,
      paid_date: next === "Paid" ? new Date().toISOString().slice(0, 10) : null,
    });
    return syncCRM(true);
  }
  if ((el = t.closest("[data-toggle-billable]"))) {
    const wasOn = el.dataset.curBill === "1";
    await saveField("receipts", el.dataset.toggleBillable, "billable", !wasOn);
    return syncCRM(true);
  }

  // Settings Save
  if (t.closest('[data-action="save-settings"]')) {
    state.expenseThreshold = Number($("setExpThreshold")?.value || 150);
    localStorage.setItem("hcrm_exp_threshold", String(state.expenseThreshold));
    await saveFields("profile", 1, {
      company_name: $("setCompany")?.value.trim(),
      phone: $("setPhone")?.value.trim(),
      email: $("setEmail")?.value.trim(),
      default_hourly_rate: Number($("setRate")?.value || 85),
      business_address: $("setAddress")?.value.trim(),
      payment_details: $("setPayment")?.value.trim(),
    });
    return syncCRM(true);
  }

  // 2-Tap Delete Confirmation
  if ((el = t.closest("[data-delete-entity]"))) {
    if (!el.dataset.armed) {
      el.dataset.armed = "1";
      el.dataset.origLabel = el.innerHTML;
      el.textContent = "Confirm Delete?";
      el.classList.add("armed");
      el._armTimer = setTimeout(() => {
        delete el.dataset.armed;
        el.innerHTML = el.dataset.origLabel;
        el.classList.remove("armed");
      }, 3000);
      return;
    }
    clearTimeout(el._armTimer);
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

  // Add Employee Modal
  if (t.closest('[data-action="new-employee"]')) {
    openModal(
      "Add Team Member",
      `<div class="form-grid">
        <div class="form-field wide">
          <label>Full Name *</label>
          <input id="mEmpName" class="form-input" placeholder="e.g., Jordan Taylor">
        </div>
        <div class="form-field">
          <label>Role Title</label>
          <input id="mEmpRole" class="form-input" value="Field Technician">
        </div>
        <div class="form-field">
          <label>Specialty</label>
          <input id="mEmpSpec" class="form-input" placeholder="Plumbing, Electrical, etc.">
        </div>
        <div class="form-field">
          <label>Phone</label>
          <input id="mEmpPhone" class="form-input" placeholder="(561) 555-0199">
        </div>
        <div class="form-field">
          <label>Email</label>
          <input id="mEmpEmail" type="email" class="form-input" placeholder="tech@handycrm.com">
        </div>
      </div>`,
      `<button class="btn" onclick="closeModal()">Cancel</button>
       <button class="btn btn-primary" data-submit-employee="1">Add Employee</button>`
    );
    return;
  }

  if (t.closest("[data-submit-employee]")) {
    const name = $("mEmpName")?.value.trim();
    if (!name) return alert("Employee name is required.");
    state.employees.push({
      id: "emp-" + Date.now(),
      name,
      role: $("mEmpRole")?.value.trim() || "Field Technician",
      specialty: $("mEmpSpec")?.value.trim() || "General Maintenance",
      phone: $("mEmpPhone")?.value.trim() || "—",
      email: $("mEmpEmail")?.value.trim() || "—",
      active: true,
    });
    saveEmployees();
    closeModal();
    updateShellUI();
    renderCurrentView();
    return;
  }
});

// ---------- Global Input & Filter Change Listeners ----------
document.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "globalSearchInput" || t.id === "mobileSearchInput") {
    state.search = t.value;
    if (t.id === "globalSearchInput" && $("mobileSearchInput")) $("mobileSearchInput").value = t.value;
    if (t.id === "mobileSearchInput" && $("globalSearchInput")) $("globalSearchInput").value = t.value;
    renderCurrentView();
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
  if (t.id === "mEstProjectSelect") {
    const isNew = t.value === "__new__";
    if ($("mEstNewProjBox")) $("mEstNewProjBox").hidden = !isNew;
    if (!isNew) {
      const p = state.projects.find(x => sameId(x.id, t.value));
      if (p) {
        if ($("mEstMode")) $("mEstMode").value = p.estimate_mode || "fixed";
        if ($("mEstFixedVal")) $("mEstFixedVal").value = Number(p.estimate_fixed || 0);
        if ($("mEstRateVal")) $("mEstRateVal").value = Number(p.estimate_rate || state.profile.default_hourly_rate || 85);
        if ($("mEstHoursVal")) $("mEstHoursVal").value = Number(p.estimate_hours || 4);
        if ($("mEstDescription")) $("mEstDescription").value = p.clean_description || "";
        if ($("mEstFixedRow")) $("mEstFixedRow").hidden = ($("mEstMode").value !== "fixed");
        if ($("mEstHourlyRow")) $("mEstHourlyRow").hidden = ($("mEstMode").value !== "hourly");
      }
    }
    return;
  }
  if (t.id === "mEstClientSelect") {
    if ($("mEstNewCliBox")) $("mEstNewCliBox").hidden = t.value !== "__new__";
    return;
  }
  if (t.id === "mEstMode") {
    if ($("mEstFixedRow")) $("mEstFixedRow").hidden = t.value !== "fixed";
    if ($("mEstHourlyRow")) $("mEstHourlyRow").hidden = t.value !== "hourly";
    return;
  }

  // Role & Persona Switchers
  if (t.id === "roleSwitcher") {
    state.role = t.value;
    localStorage.setItem("hcrm_role", state.role);
    if (isEmployee() && ["estimates", "invoices", "reports", "employees"].includes(state.view)) {
      state.view = "tasks";
    }
    updateShellUI();
    renderCurrentView();
    return;
  }

  if (t.id === "activeEmployeeSelect") {
    state.activeEmployeeId = t.value;
    localStorage.setItem("hcrm_emp_id", state.activeEmployeeId);
    updateShellUI();
    renderCurrentView();
    return;
  }

  // Unified Task List Dropdown Filters
  if (t.id === "fltStatus") { state.filterStatus = t.value; return renderCurrentView(); }
  if (t.id === "fltPriority") { state.filterPriority = t.value; return renderCurrentView(); }
  if (t.id === "fltClient") { state.filterClient = t.value; return renderCurrentView(); }
  if (t.id === "fltProject") { state.filterProject = t.value; return renderCurrentView(); }
  if (t.id === "fltAssignee") { state.filterAssignee = t.value; return renderCurrentView(); }
  if (t.id === "fltSort") { state.sortBy = t.value; return renderCurrentView(); }
});

// Close Lightbox or Modal on Escape
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    document.querySelector(".lightbox")?.remove();
    closeModal();
  }
});

// ---------- Boot Application ----------
startGlobalTimerTicker();
syncCRM();