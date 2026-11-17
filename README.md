# HandyCRM — Field Service CRM

Clients → Projects → Visits, with estimates, receipts, invoices (PDF), photos and an Income & Expense report.
Python (FastAPI) backend, plain HTML/CSS/JS frontend, Supabase for the database and photo storage.

## Run it

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env          # then put your Supabase URL + SECRET key in .env
python check_storage.py         # optional: checks the key and that photo uploads work
uvicorn main:app --reload       # open http://localhost:8000
```

First time only:
1. Run `schema.sql` in Supabase → SQL Editor (safe to run again after every update).
2. Create a **public** Storage bucket named `crm-photos`.
3. Open the app: the first screen creates the **Owner** account. Add your team in **+ New → Team member**
   (each person gets a temporary password to change in Settings).

## Test it

```powershell
pip install -r requirements-dev.txt
python -m pytest
```

The tests use a fake database: no keys or internet needed.

## Where things are

| File | What it does |
| --- | --- |
| `main.py` | Every `/api/...` route. Decides who may do what, checks what the browser sends, calls the modules below. |
| `auth.py` | Sign-in, "who is calling?" (`current_member`), roles, Team endpoints. |
| `database.py` | The only file that talks to Supabase (table rows + photo files). |
| `billing.py` | All money math: line items, new estimates/invoices, Income & Expense report. Pure functions. |
| `meta.py` | Reads/writes the hidden extra fields inside text columns (approval status, task title…). |
| `invoice_pdf.py` | Draws the estimate / invoice PDF. |
| `report_export.py` | The Income & Expense report as a CSV or PDF file. |
| `sql/` | `reset_data.sql` (delete all clients/projects/tasks/money) and `seed_test_data.sql` (fictional test data). |
| `schema.sql` | The database tables. Safe to run again. |
| `check_storage.py` | Troubleshooting: which Supabase key is used, can photos be uploaded. |
| `static/index.html` | Page frame: sidebar, top bar, workspace, pop-up window. |
| `static/api.js` | Server calls, auto-save, photo compression, turning rows into screen objects. |
| `static/app.js` | All screens and buttons (sections 0–7 are listed at the top of the file). |
| `static/styles.css` | Look and feel. |
| `tests/` | `test_billing.py` (money math), `test_api.py` (API rules). |
| `Instructions/project-req.txt` | The product specification. |

## Things to know

* **One request loads everything:** the browser calls `GET /api/bootstrap` and keeps the data in memory;
  after every change it saves (PATCH) and reloads.
* **Hidden extra fields:** task title, priority, assignee, approval status, comments… are stored as JSON at the
  end of an existing text column, after `<!--HCRM:`. The PDF and documents strip it. Explained in `static/api.js`.
* **Logins and roles:** email + password through Supabase Auth; people are in the `team_members` table.
  The server enforces the roles: Employees only receive their own tasks and receipts and never any money data;
  only the Owner changes settings and the team; Manager invoices wait for the Owner (when approvals are on).
* **One "+ New" button** (top right, round `+` on phones) creates everything: task, client, project, receipt,
  photo, estimate, invoice, team member. It pre-fills the client / project / task of the screen you are on.
* **Estimates and invoices are one document type** with line items (table `invoices`, column `kind`).
  A new estimate lists the project's planned tasks; "→ Invoice" turns it into an invoice. A new invoice starts
  from the estimate (first invoice) or from completed tasks nobody billed yet, plus billable receipts.
  Receipts on an invoice are locked ("Invoiced"); removing their line or deleting the invoice releases them.
* **Approvals** can be switched off in Settings (for very small teams).
* **Timer:** the start time is saved in the task (works across devices, the Manager sees it, one timer per person).
  Stopping opens a "review the time" window before anything is added to Time Spent.
* **Reports (Money → Reports, `reports.py`):** Overview (making money vs. previous period, who owes me as of today,
  12-month trend, job profit with $/hour, team hours) + detailed reports Income, Expenses, Who owes me, Job profit,
  Team hours. Each one: period, filters, group by, ⚙ columns (remembered), sortable titles, totals, CSV / PDF of
  exactly what is shown. Cash basis; profit subtracts labor = hours × each person's cost per hour (Settings → Team,
  Owner only — Managers see reports without cost and profit).
* **Income & Expense export:** the CSV / PDF buttons in the report panel (Money → Reports, or a client) download
  every income and expense line with totals, for the same period and scope (`report_export.py`).
