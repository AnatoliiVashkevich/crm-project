// app.js - Application Initialization & Event Listeners
document.addEventListener('DOMContentLoaded', async () => {
    console.log("CRM Initialized");
    
    // Example: Bind tab switching logic
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
            e.target.classList.add('active');
            const targetTab = document.getElementById(e.target.dataset.target);
            if (targetTab) targetTab.classList.add('active');
        });
    });

    // Load initial data from Supabase via FastAPI
    // const clients = await API.getClients();
    // renderClientsTree(clients);
});


    const API_BASE = "http://127.0.0.1:8000/api";
    let allClients = [];
    let expandedClientIds = new Set();
    let currentClient = null;
    let currentProject = null;
    let currentTransactions = [];
    let modalTargetClient = null;

    // --- BUSINESS PROFILE MANAGEMENT (LOCAL STORAGE) ---
    const defaultProfile = {
        role: "Service Provider",
        company: "Anatolii Vashkevich LLC",
        address: "Boca Raton, FL",
        contact: "handyman33432@gmail.com",
        payment: "Payment via Zelle: Anatolii Vashkevich LLC"
    };

    function getBusinessProfile() {
        const saved = localStorage.getItem("crm_business_profile");
        if (saved) {
            try { return { ...defaultProfile, ...JSON.parse(saved) }; } catch (e) {}
        }
        return defaultProfile;
    }

    function openProfileModal() {
        const p = getBusinessProfile();
        document.getElementById('profRole').value = p.role;
        document.getElementById('profCompany').value = p.company;
        document.getElementById('profAddress').value = p.address;
        document.getElementById('profContact').value = p.contact;
        document.getElementById('profPayment').value = p.payment;
        document.getElementById('profileModal').style.display = 'flex';
    }

    function saveBusinessProfile() {
        const updated = {
            role: document.getElementById('profRole').value.trim() || "Service Provider",
            company: document.getElementById('profCompany').value.trim() || "Anatolii Vashkevich LLC",
            address: document.getElementById('profAddress').value.trim(),
            contact: document.getElementById('profContact').value.trim(),
            payment: document.getElementById('profPayment').value.trim()
        };
        localStorage.setItem("crm_business_profile", JSON.stringify(updated));
        document.getElementById('profileModal').style.display = 'none';
        renderBusinessHeaders();
    }

    function renderBusinessHeaders() {
        const p = getBusinessProfile();
        const contactLine = [p.address, p.contact].filter(Boolean).join(" | ");
        document.getElementById('estMyRole').innerText = p.role + ":";
        document.getElementById('estMyCompany').innerText = p.company;
        document.getElementById('estMyContact').innerText = contactLine;

        document.getElementById('invMyRole').innerText = p.role + ":";
        document.getElementById('invMyCompany').innerText = p.company;
        document.getElementById('invMyContact').innerText = contactLine;
        document.getElementById('invMyPayment').innerText = p.payment;
    }

    // Debt is calculated by the backend (invoice/estimate total vs. payments).
    function isProjectDebt(p) {
        return p.is_debt === true;
    }

    async function postJSON(url, body) {
        const res = await fetch(`${API_BASE}${url}`, {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: body ? JSON.stringify(body) : undefined
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { alert(data.detail || "Request failed."); return null; }
        return data;
    }

    // Copy only the backend-derived money fields so unsaved local edits are not overwritten.
    function applyBalance(p) {
        ['total_due', 'total_paid', 'balance_due', 'is_debt', 'payment_status', 'actual_amount']
            .forEach(k => { currentProject[k] = p[k]; });
    }

    // Invoice numbers are assigned by the server (sequential, never random).
    async function ensureInvoiceNumber() {
        if (!currentProject.invoice_number) {
            const data = await postJSON(`/projects/${currentProject.id}/invoice-number`);
            if (data) currentProject.invoice_number = data.invoice_number;
        }
        if (!currentProject.invoice_data || typeof currentProject.invoice_data !== 'object') {
            currentProject.invoice_data = { items: [] };
        }
        if (currentProject.invoice_number) currentProject.invoice_data.invoice_number = currentProject.invoice_number;
        return currentProject.invoice_number;
    }

    async function addPaymentPrompt() {
        const val = prompt("Payment received ($):", "");
        if (val === null || val.trim() === "") return;
        const amount = Number(val);
        if (!(amount > 0)) return alert("Enter an amount greater than 0.");
        const data = await postJSON(`/projects/${currentProject.id}/payments`, { amount, method: "manual" });
        if (!data) return;
        applyBalance(data.project);
        await loadClientsTree();
        renderWorkspaceUI();
    }

    // --- 1. CLIENTS & PROJECTS TREE ---
    async function loadClientsTree() {
        const tree = document.getElementById('clientsTree');
        const prevScroll = tree.scrollTop;

        const res = await fetch(`${API_BASE}/clients`);
        allClients = await res.json();

        tree.innerHTML = '';

        allClients.forEach(client => {
            const isExp = expandedClientIds.has(client.id);
            const block = document.createElement('div');
            block.className = `client-block ${isExp ? 'expanded' : ''}`;

            const header = document.createElement('div');
            header.className = 'client-row';
            header.innerHTML = `
                <span>${isExp ? '▼' : '▶'} ${client.name} <small style="color:#6b7280; font-weight:normal;">(${client.projects.length})</small></span>
                <span class="status-dot ${client.has_debt ? 'dot-red' : 'dot-green'}" title="${client.has_debt ? 'Unpaid balance' : 'All paid'}"></span>
            `;
            header.onclick = () => {
                if (expandedClientIds.has(client.id)) expandedClientIds.delete(client.id);
                else expandedClientIds.add(client.id);
                loadClientsTree();
            };

            const sublist = document.createElement('div');
            sublist.className = 'projects-sublist';

            const addBtn = document.createElement('button');
            addBtn.className = 'add-proj-inline';
            addBtn.innerText = '+ New Visit / Project';
            addBtn.onclick = (e) => {
                e.stopPropagation();
                openProjectModalForClient(client);
            };
            sublist.appendChild(addBtn);

            client.projects.forEach(proj => {
                const pItem = document.createElement('div');
                const isActive = currentProject && currentProject.id === proj.id;
                pItem.className = `project-item ${isActive ? 'active' : ''}`;
                const debt = isProjectDebt(proj);
                pItem.innerHTML = `
                    <span>📄 ${proj.name}</span>
                    <span class="status-dot ${debt ? 'dot-red' : 'dot-green'}"></span>
                `;
                pItem.onclick = (e) => {
                    e.stopPropagation();
                    openProjectWorkspace(client.id, proj.id);
                };
                sublist.appendChild(pItem);
            });

            block.appendChild(header);
            block.appendChild(sublist);
            tree.appendChild(block);
        });

        tree.scrollTop = prevScroll;
    }

    // --- 2. CREATE CLIENT & PROJECT ---
    function openClientModal() {
        document.getElementById('cName').value = '';
        document.getElementById('cPhone').value = '';
        document.getElementById('cComment').value = '';
        document.getElementById('clientModal').style.display = 'flex';
    }

    async function saveNewClient() {
        const name = document.getElementById('cName').value.trim();
        if (!name) return alert("Please enter a client name.");
        const res = await fetch(`${API_BASE}/clients`, {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                name,
                phone: document.getElementById('cPhone').value.trim() || null,
                comment: document.getElementById('cComment').value.trim() || null
            })
        });
        const newClient = await res.json();
        document.getElementById('clientModal').style.display = 'none';
        expandedClientIds.add(newClient.id);
        await loadClientsTree();
        const found = allClients.find(c => c.id === newClient.id);
        if (found) openProjectModalForClient(found);
    }

    function openProjectModalForClient(client) {
        modalTargetClient = client;
        const nextNum = (client.projects ? client.projects.length : 0) + 1;
        document.getElementById('pName').value = `Visit ${nextNum}`;

        const dl = document.getElementById('addressHistory');
        dl.innerHTML = '';
        (client.known_addresses || []).forEach(addr => {
            const opt = document.createElement('option');
            opt.value = addr;
            dl.appendChild(opt);
        });
        document.getElementById('pAddress').value = (client.known_addresses && client.known_addresses.length > 0) ? client.known_addresses[0] : '';
        document.getElementById('projectModal').style.display = 'flex';
    }

    async function saveNewProject() {
        const name = document.getElementById('pName').value.trim();
        if (!name || !modalTargetClient) return;
        const res = await fetch(`${API_BASE}/projects`, {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                client_id: modalTargetClient.id,
                name,
                address: document.getElementById('pAddress').value.trim() || null
            })
        });
        const newProj = await res.json();
        document.getElementById('projectModal').style.display = 'none';
        expandedClientIds.add(modalTargetClient.id);
        await loadClientsTree();
        openProjectWorkspace(modalTargetClient.id, newProj.id);
    }

    // --- 3. OPEN PROJECT WORKSPACE ---
    async function openProjectWorkspace(clientId, projectId) {
        document.getElementById('workspaceLock').style.display = 'none';
        const res = await fetch(`${API_BASE}/project-workspace/${clientId}/${projectId}`);
        const data = await res.json();

        currentClient = data.client;
        currentProject = data.project;
        currentTransactions = data.transactions || [];

        if (!Array.isArray(currentProject.work_plan)) currentProject.work_plan = [];
        if (!Array.isArray(currentProject.estimate_items)) currentProject.estimate_items = [];
        if (!currentProject.invoice_data || typeof currentProject.invoice_data !== 'object') {
            currentProject.invoice_data = {};
        }
        if (!Array.isArray(currentProject.invoice_data.items)) {
            currentProject.invoice_data.items = [];
        }

        await loadClientsTree();
        renderWorkspaceUI();

        const msgDiv = document.getElementById('messages');
        msgDiv.innerHTML = '';
        (data.messages || []).forEach(m => {
            if (m.content.startsWith("__INIT_PROJECT__")) return;
            let parsedJson = null;
            if (m.raw_json) {
                try { parsedJson = JSON.parse(m.raw_json); } catch(e){}
            }
            addChatBubble(m.content, m.role === 'user' ? 'user' : 'ai', parsedJson);
        });

        // The workspace loads without the AI; request the first summary afterwards.
        if (data.needs_greeting) {
            try {
                const gRes = await fetch(`${API_BASE}/project-greeting/${clientId}/${projectId}`, { method: "POST" });
                const g = await gRes.json();
                if (gRes.ok && g.reply_message && currentProject && currentProject.id === projectId) {
                    addChatBubble(g.reply_message, 'ai', g);
                }
            } catch (e) { console.warn("AI greeting unavailable", e); }
        }
    }

    function renderWorkspaceUI() {
        renderBusinessHeaders();

        document.getElementById('uiClientName').innerText = currentClient.name;
        document.getElementById('uiProjectName').innerText = currentProject.name;
        
        document.getElementById('uiProjectAddress').innerHTML = currentProject.address ? currentProject.address : '<span class="missing-val">+ add address</span>';
        document.getElementById('uiClientPhone').innerHTML = currentClient.phone ? currentClient.phone : '<span class="missing-val">+ add phone</span>';
        document.getElementById('uiClientComment').innerHTML = currentClient.comment ? currentClient.comment : '<span class="missing-val">+ add note</span>';
        document.getElementById('uiProjectScope').innerHTML = currentProject.scope_description ? currentProject.scope_description : '<span class="missing-val">+ add scope</span>';

        const est = Number(currentProject.estimated_amount || 0);
        const act = Number(currentProject.actual_amount || 0);
        const expTotal = currentTransactions.reduce((acc, t) => acc + Number(t.amount || 0), 0);

        document.getElementById('uiEstimated').innerText = `$${est.toFixed(2)}`;
        document.getElementById('uiActual').innerText = `$${act.toFixed(2)}`;
        document.getElementById('uiExpensesTotal').innerText = `$${expTotal.toFixed(2)}`;

        const debt = isProjectDebt(currentProject);
        const badge = document.getElementById('uiStatusBadge');
        badge.className = `badge ${debt ? 'badge-red' : 'badge-green'}`;
        badge.innerText = debt ? '🔴 UNPAID (DEBT)' : '🟢 PAID';

        const foundClientInTree = allClients.find(c => c.id === currentClient.id);
        const cBadge = document.getElementById('uiClientDebtBadge');
        if (foundClientInTree) {
            cBadge.className = `badge ${foundClientInTree.has_debt ? 'badge-red' : 'badge-green'}`;
            cBadge.innerText = foundClientInTree.has_debt ? '🔴 Client: Unpaid' : '🟢 Client: Clear';
        }

        // Populate Client Info in Estimate & Invoice Headers
        document.getElementById('estClientName').innerText = currentClient.name;
        document.getElementById('estProjectAddress').innerText = currentProject.address || 'Not specified';
        document.getElementById('estClientPhone').innerText = currentClient.phone || 'Not specified';

        document.getElementById('invClientName').innerText = currentClient.name;
        document.getElementById('invProjectAddress').innerText = currentProject.address || 'Not specified';
        document.getElementById('invClientPhone').innerText = currentClient.phone || 'Not specified';

        renderWorkPlanTable();
        renderEstimateTable();
        renderInvoiceTab();
        renderExpensesTable();
    }

    function switchTab(tabName) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(`tabBtn-${tabName}`).classList.add('active');
        document.getElementById(`tab-${tabName}`).classList.add('active');
    }

    // --- 4. TAB 1: WORK PLAN (WITH DEDICATED TASK MODAL FORM) ---
    function renderWorkPlanTable() {
        const tbody = document.getElementById('workPlanBody');
        tbody.innerHTML = '';
        if (currentProject.work_plan.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="color:#6b7280; text-align:center; padding:16px;">No tasks in the work plan yet. Click <b>"+ Add Task (Form)"</b> above to create one.</td></tr>`;
            return;
        }
        currentProject.work_plan.forEach((item, idx) => {
            const price = Number(item.price || 0);
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><input type="checkbox" ${item.done ? 'checked' : ''} onchange="togglePlanTask(${idx}, this.checked)" style="width:17px; height:17px;"></td>
                <td style="${item.done ? 'text-decoration:line-through; color:#9ca3af;' : 'font-weight:600;'}">${item.task || ''}</td>
                <td style="color:#4b5563; font-size:12px;">${item.details || '—'}</td>
                <td style="font-weight:600;">${price > 0 ? '$' + price.toFixed(2) : '—'}</td>
                <td>
                    <button class="btn btn-gray" style="padding:3px 7px; font-size:11px;" onclick="openTaskModal(${idx})">Edit</button>
                    <button class="btn btn-red" onclick="removePlanTask(${idx})">✕</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    function openTaskModal(editIdx = -1) {
        if (!currentProject) return alert("Please select a project first.");
        document.getElementById('taskEditIndex').value = editIdx;
        if (editIdx >= 0 && currentProject.work_plan[editIdx]) {
            const t = currentProject.work_plan[editIdx];
            document.getElementById('taskModalTitle').innerText = "✏️ Edit Work Plan Task";
            document.getElementById('taskTitleInput').value = t.task || '';
            document.getElementById('taskDetailsInput').value = t.details || '';
            document.getElementById('taskPriceInput').value = t.price || '';
        } else {
            document.getElementById('taskModalTitle').innerText = "📋 Add Task to Work Plan";
            document.getElementById('taskTitleInput').value = '';
            document.getElementById('taskDetailsInput').value = '';
            document.getElementById('taskPriceInput').value = '';
        }
        document.getElementById('taskModal').style.display = 'flex';
        setTimeout(() => document.getElementById('taskTitleInput').focus(), 50);
    }

    async function saveTaskFromModal() {
        const title = document.getElementById('taskTitleInput').value.trim();
        if (!title) return alert("Please enter a Task Name.");
        const details = document.getElementById('taskDetailsInput').value.trim();
        const price = Number(document.getElementById('taskPriceInput').value || 0);
        const editIdx = parseInt(document.getElementById('taskEditIndex').value, 10);

        if (editIdx >= 0) {
            currentProject.work_plan[editIdx] = {
                ...currentProject.work_plan[editIdx],
                task: title,
                details: details,
                price: price
            };
        } else {
            currentProject.work_plan.push({
                task: title,
                details: details,
                price: price,
                done: false
            });
        }

        document.getElementById('taskModal').style.display = 'none';
        await saveProjectUpdates({ work_plan: currentProject.work_plan });
    }

    async function togglePlanTask(idx, checked) {
        currentProject.work_plan[idx].done = checked;
        await saveProjectUpdates({ work_plan: currentProject.work_plan });
    }

    async function removePlanTask(idx) {
        currentProject.work_plan.splice(idx, 1);
        await saveProjectUpdates({ work_plan: currentProject.work_plan });
    }

    // --- 5. TAB 2: ESTIMATE ---
    function renderEstimateTable() {
        const tbody = document.getElementById('estimateBody');
        tbody.innerHTML = '';
        let grandTotal = 0;

        if (currentProject.estimate_items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="color:#6b7280; text-align:center; padding:14px;">Estimate is empty. Click <b>"🔄 Import Tasks from Work Plan"</b> or <b>"+ Add Line Item"</b>.</td></tr>`;
        }

        currentProject.estimate_items.forEach((row, idx) => {
            const qty = Number(row.qty || 1);
            const price = Number(row.price || 0);
            const rowTotal = qty * price;
            grandTotal += rowTotal;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><input type="text" value="${row.description || ''}" onchange="updateEstRow(${idx}, 'description', this.value)"></td>
                <td><input type="number" step="1" value="${qty}" onchange="updateEstRow(${idx}, 'qty', this.value)"></td>
                <td><input type="number" step="0.01" value="${price}" onchange="updateEstRow(${idx}, 'price', this.value)"></td>
                <td style="font-weight:700;">$${rowTotal.toFixed(2)}</td>
                <td class="no-print"><button class="btn btn-red" onclick="removeEstRow(${idx})">✕</button></td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('estimateGrandTotal').innerText = `$${grandTotal.toFixed(2)}`;
    }

    function pullFromWorkPlan(switchToEstimateTab = false) {
        if (currentProject.work_plan.length === 0) {
            return alert("Work Plan is empty! Please add tasks in Tab 1 first.");
        }
        const existingNames = new Set(currentProject.estimate_items.map(i => i.description));
        currentProject.work_plan.forEach(t => {
            const fullDesc = t.details ? `${t.task} (${t.details})` : t.task;
            if (!existingNames.has(fullDesc) && !existingNames.has(t.task)) {
                currentProject.estimate_items.push({
                    description: fullDesc,
                    qty: 1,
                    price: Number(t.price || 0)
                });
            }
        });
        renderEstimateTable();
        if (switchToEstimateTab) switchTab('estimate');
    }

    function addEstimateRow() {
        currentProject.estimate_items.push({ description: "", qty: 1, price: 0 });
        renderEstimateTable();
    }

    function updateEstRow(idx, field, val) {
        currentProject.estimate_items[idx][field] = field === 'description' ? val : Number(val);
        renderEstimateTable();
    }

    function removeEstRow(idx) {
        currentProject.estimate_items.splice(idx, 1);
        renderEstimateTable();
    }

    async function saveEstimateToDB() {
        const total = currentProject.estimate_items.reduce((acc, r) => acc + (Number(r.qty || 1) * Number(r.price || 0)), 0);
        await saveProjectUpdates({
            estimate_items: currentProject.estimate_items,
            estimated_amount: total
        });
        alert(`Estimate saved! Project Estimate Total updated to $${total.toFixed(2)}.`);
    }

    async function convertEstimateToInvoice() {
        if (currentProject.estimate_items.length === 0) {
            return alert("Estimate has no line items yet.");
        }
        const total = currentProject.estimate_items.reduce((acc, r) => acc + (Number(r.qty || 1) * Number(r.price || 0)), 0);
        await ensureInvoiceNumber();
        currentProject.invoice_data = {
            invoice_number: currentProject.invoice_number,
            invoice_date: currentProject.invoice_data?.invoice_date || new Date().toISOString().slice(0, 10),
            notes: currentProject.invoice_data?.notes || "Thank you for your business! Payment due upon receipt.",
            items: JSON.parse(JSON.stringify(currentProject.estimate_items))
        };
        await saveProjectUpdates({
            estimate_items: currentProject.estimate_items,
            estimated_amount: total,
            invoice_data: currentProject.invoice_data
        });
        switchTab('invoice');
    }

    // --- 6. TAB 3: INVOICE ---
    function renderInvoiceTab() {
        const inv = currentProject.invoice_data || {};
        document.getElementById('invNumber').value = currentProject.invoice_number || inv.invoice_number || '';
        document.getElementById('invDate').value = inv.invoice_date || new Date().toISOString().slice(0, 10);
        document.getElementById('invNotes').value = inv.notes || "Thank you for your business!";

        const items = Array.isArray(inv.items) ? inv.items : [];
        const tbody = document.getElementById('invoiceBody');
        tbody.innerHTML = '';
        let grandTotal = 0;

        if (items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="color:#6b7280; text-align:center; padding:14px;">Invoice is empty. Click <b>"🔄 Pull Items from Estimate"</b> above.</td></tr>`;
        }

        items.forEach((row, idx) => {
            const qty = Number(row.qty || 1);
            const price = Number(row.price || 0);
            const rowTotal = qty * price;
            grandTotal += rowTotal;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><input type="text" value="${row.description || ''}" onchange="updateInvRow(${idx}, 'description', this.value)"></td>
                <td><input type="number" step="1" value="${qty}" onchange="updateInvRow(${idx}, 'qty', this.value)"></td>
                <td><input type="number" step="0.01" value="${price}" onchange="updateInvRow(${idx}, 'price', this.value)"></td>
                <td style="font-weight:700;">$${rowTotal.toFixed(2)}</td>
                <td class="no-print"><button class="btn btn-red" onclick="removeInvRow(${idx})">✕</button></td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('invoiceGrandTotal').innerText = `$${grandTotal.toFixed(2)}`;
    }

    function updateInvoiceMeta() {
        if (!currentProject.invoice_data) currentProject.invoice_data = { items: [] };
        currentProject.invoice_data.invoice_date = document.getElementById('invDate').value;
        currentProject.invoice_data.notes = document.getElementById('invNotes').value;
    }

    function pullFromEstimateToInvoice() {
        if (currentProject.estimate_items.length === 0) {
            return alert("Estimate is empty! Add items in the Estimate tab first.");
        }
        updateInvoiceMeta();
        currentProject.invoice_data.items = JSON.parse(JSON.stringify(currentProject.estimate_items));
        renderInvoiceTab();
    }

    function addInvoiceRow() {
        updateInvoiceMeta();
        if (!Array.isArray(currentProject.invoice_data.items)) currentProject.invoice_data.items = [];
        currentProject.invoice_data.items.push({ description: "", qty: 1, price: 0 });
        renderInvoiceTab();
    }

    function updateInvRow(idx, field, val) {
        currentProject.invoice_data.items[idx][field] = field === 'description' ? val : Number(val);
        renderInvoiceTab();
    }

    function removeInvRow(idx) {
        currentProject.invoice_data.items.splice(idx, 1);
        renderInvoiceTab();
    }

    async function saveInvoiceToDB() {
        updateInvoiceMeta();
        await ensureInvoiceNumber();
        const items = currentProject.invoice_data.items || [];
        const total = items.reduce((acc, r) => acc + (Number(r.qty || 1) * Number(r.price || 0)), 0);
        await saveProjectUpdates({
            invoice_data: currentProject.invoice_data,
            estimated_amount: total > 0 ? total : currentProject.estimated_amount
        });
        alert(`Invoice saved! Total Due: $${total.toFixed(2)}`);
    }

    async function markInvoicePaid() {
        updateInvoiceMeta();
        await ensureInvoiceNumber();
        await saveProjectUpdates({ invoice_data: currentProject.invoice_data });
        const data = await postJSON(`/projects/${currentProject.id}/mark-paid`);
        if (!data) return;
        applyBalance(data.project);
        await loadClientsTree();
        renderWorkspaceUI();
        alert("Invoice marked as PAID. Status is now 🟢 PAID.");
    }

    // --- 7. TAB 4: EXPENSES & RECEIPTS (AI SCANNER) ---
    function renderExpensesTable() {
        const tbody = document.getElementById('expensesBody');
        tbody.innerHTML = '';
        if (currentTransactions.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="color:#6b7280; text-align:center; padding:14px;">No receipts attached yet. Click <b>"📷 Scan / Upload Receipt"</b> above.</td></tr>`;
            return;
        }

        currentTransactions.forEach(tx => {
            const itemsList = Array.isArray(tx.items) && tx.items.length > 0
                ? tx.items.map(i => `• ${i.name} (${i.qty} x $${i.price}) = <b>$${i.total}</b>`).join('<br>')
                : (tx.description || '—');

            const cat = tx.category || 'Other';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${(tx.date_purchased || '').slice(0, 10)}</td>
                <td style="font-weight:600;">${tx.vendor || 'Receipt'}</td>
                <td><span class="cat-tag cat-${cat}">${cat}</span></td>
                <td style="font-size:12px; line-height:1.4;">${itemsList}</td>
                <td style="font-weight:700; color:#b45309;">$${Number(tx.amount || 0).toFixed(2)}</td>
                <td><button class="btn btn-red" onclick="deleteReceipt('${tx.id}')">✕</button></td>
            `;
            tbody.appendChild(tr);
        });
    }

    async function uploadAndScanReceipt(inputEl) {
        const file = inputEl.files[0];
        if (!file || !currentProject) return;

        const btn = document.getElementById('scanBtn');
        btn.innerText = "⏳ Scanning Receipt with AI...";
        btn.disabled = true;

        const formData = new FormData();
        formData.append("receipt_file", file);
        formData.append("client_id", currentClient.id);

        try {
            const res = await fetch(`${API_BASE}/projects/${currentProject.id}/scan-receipt`, {
                method: "POST", body: formData
            });
            const newTx = await res.json();
            currentTransactions.unshift(newTx);
            renderWorkspaceUI();
        } catch (e) {
            alert("Error scanning receipt.");
        } finally {
            btn.innerText = "📷 Scan / Upload Receipt";
            btn.disabled = false;
            inputEl.value = '';
        }
    }

    async function deleteReceipt(txId) {
        await fetch(`${API_BASE}/transactions/${txId}`, { method: "DELETE" });
        currentTransactions = currentTransactions.filter(t => t.id !== txId);
        renderWorkspaceUI();
    }

    // --- 8. MANUAL UPDATES & ERROR HANDLING ---
    async function saveProjectUpdates(updatesObj) {
        try {
            const res = await fetch(`${API_BASE}/projects/${currentProject.id}`, {
                method: "PUT", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({ updates: updatesObj })
            });
            const data = await res.json();
            if (!res.ok) {
                alert(data.detail || "Failed to save project update. Make sure you ran the SQL script in Supabase.");
                return;
            }
            if (data && data.id) currentProject = data;
            await loadClientsTree();
            renderWorkspaceUI();
        } catch (err) {
            alert("Connection error while saving project updates.");
        }
    }

    async function editProjectField(field, label, isNumber = false) {
        const val = prompt(label + ":", currentProject[field] ?? '');
        if (val === null) return;
        await saveProjectUpdates({ [field]: isNumber ? Number(val) : val });
    }

    async function editClientField(field, label) {
        const val = prompt(label + ":", currentClient[field] ?? '');
        if (val === null) return;
        const res = await fetch(`${API_BASE}/clients/${currentClient.id}`, {
            method: "PUT", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ updates: { [field]: val } })
        });
        const updated = await res.json();
        if (updated && updated.id) currentClient = updated;
        renderWorkspaceUI();
    }

    async function togglePaymentStatus() {
        if (!isProjectDebt(currentProject)) {
            return alert("Status is calculated automatically from payments vs. the invoice/estimate total.");
        }
        const data = await postJSON(`/projects/${currentProject.id}/mark-paid`);
        if (!data) return;
        applyBalance(data.project);
        await loadClientsTree();
        renderWorkspaceUI();
    }

    async function markAllClientProjectsPaid() {
        const data = await postJSON(`/clients/${currentClient.id}/mark-all-paid`);
        if (!data) return;
        await openProjectWorkspace(currentClient.id, currentProject.id);
    }

    // --- 9. AI ASSISTANT CHAT (VOICE + JSON VIEW) ---
    function addChatBubble(text, sender, debugData = null) {
        const wrapper = document.createElement('div');
        wrapper.className = `msg-wrapper ${sender === 'user' ? 'user-wrapper' : 'ai-wrapper'}`;

        const div = document.createElement('div');
        div.className = `msg ${sender === 'user' ? 'user-msg' : 'ai-msg'}`;
        div.innerText = text;
        wrapper.appendChild(div);

        if (debugData && sender === 'ai') {
            const btn = document.createElement('button');
            btn.className = 'debug-btn';
            btn.innerText = '{ } View JSON';
            const pre = document.createElement('pre');
            pre.className = 'debug-pre';
            pre.textContent = JSON.stringify(debugData, null, 2);
            btn.onclick = () => { pre.style.display = pre.style.display === 'none' ? 'block' : 'none'; };
            wrapper.appendChild(btn);
            wrapper.appendChild(pre);
        }

        const container = document.getElementById('messages');
        container.appendChild(wrapper);
        container.scrollTop = container.scrollHeight;
    }

    function applyAIResponseUpdates(data) {
        if (data.updated_client) currentClient = data.updated_client;
        if (data.updated_project) {
            currentProject = data.updated_project;
            if (!Array.isArray(currentProject.work_plan)) currentProject.work_plan = [];
            if (!Array.isArray(currentProject.estimate_items)) currentProject.estimate_items = [];
            if (!currentProject.invoice_data) currentProject.invoice_data = { items: [] };
        }
        if (data.updated_transactions) currentTransactions = data.updated_transactions;
        loadClientsTree().then(() => renderWorkspaceUI());
    }

    async function sendChatText() {
        const inp = document.getElementById('textInput');
        const text = inp.value.trim();
        if (!text || !currentProject) return;
        addChatBubble(text, 'user');
        inp.value = '';

        const res = await fetch(`${API_BASE}/text-command`, {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ text, client_id: currentClient.id, project_id: currentProject.id })
        });
        const data = await res.json();
        applyAIResponseUpdates(data);
        addChatBubble(data.reply_message, 'ai', data);
    }

    async function recheckWithAI() {
        if (!currentProject) return;
        const res = await fetch(`${API_BASE}/project-chat/recheck`, {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ text: "__INIT_PROJECT__", client_id: currentClient.id, project_id: currentProject.id })
        });
        const data = await res.json();
        addChatBubble(data.reply_message, 'ai', data);
    }

    document.getElementById('sendBtn').onclick = sendChatText;
    document.getElementById('textInput').onkeypress = e => { if (e.key === 'Enter') sendChatText(); };

    let mediaRecorder, audioChunks = [], isRecording = false;
    const micBtn = document.getElementById('micBtn');

    micBtn.addEventListener('click', async () => {
        if (!currentProject) return alert("Please open a project on the left first!");
        if (!isRecording) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
                mediaRecorder.onstop = async () => {
                    const blob = new Blob(audioChunks, { type: 'audio/webm' });
                    audioChunks = [];
                    const formData = new FormData();
                    formData.append("audio_file", blob, "voice.webm");
                    formData.append("client_id", currentClient.id);
                    formData.append("project_id", currentProject.id);

                    const res = await fetch(`${API_BASE}/voice-command`, { method: "POST", body: formData });
                    const data = await res.json();
                    if (data.user_text) addChatBubble(data.user_text + " 🎤", 'user');
                    applyAIResponseUpdates(data);
                    addChatBubble(data.reply_message, 'ai', data);
                };
                mediaRecorder.start();
                isRecording = true;
                micBtn.classList.add('recording');
            } catch (err) {
                alert("Microphone access is required!");
            }
        } else {
            mediaRecorder.stop();
            isRecording = false;
            micBtn.classList.remove('recording');
            mediaRecorder.stream.getTracks().forEach(t => t.stop());
        }
    });

    renderBusinessHeaders();
    loadClientsTree();
