"""reports.py - the data behind Money > Reports.

Rules (decided with the owner):
  * Cash basis: income counts when the client PAID (paid date). Unpaid invoices are "who owes me".
  * "Who owes me" is as of TODAY - it never hides behind the selected period.
  * Labor cost = task hours x the cost per hour of the person assigned (Settings > Team, Owner only).
    Profit = paid - materials (receipts) - labor cost.  $/hour = (paid - materials) / hours worked.
  * Estimates are never money.

Two kinds of answers:
  overview(...)  -> the 5 blocks of the Overview screen
  dataset(kind)  -> one detailed report: {"columns": [...], "groups": [...], "rows": [...]}
                    The browser filters, groups, hides columns and sorts these rows by itself.
Pure functions: plain dicts in, plain dicts out. No database.
"""
from collections import defaultdict
from datetime import date

from billing import CENT, ZERO, _in_range, latest_estimates, money, strip_meta, task_title
from meta import unpack


# =====================================================================================================
# Context: all rows, indexed once
# =====================================================================================================
def make_ctx(clients, projects, visits, documents, receipts, team) -> dict:
    return {
        "client": {c["id"]: c for c in clients},
        "project": {p["id"]: p for p in projects},
        "visit": {v["id"]: v for v in visits},
        "member": {m["id"]: m for m in team},
        "projects": projects,
        "visits": [v for v in visits if v.get("status") != "Canceled"],
        "invoices": [d for d in documents if d.get("kind", "invoice") == "invoice"],
        "estimates": latest_estimates(documents),
        "receipts": receipts,
    }


def _where(ctx, project_id) -> dict:
    """client / project names + ids for a row (used for display and for the browser's filters)."""
    p = ctx["project"].get(project_id) or {}
    c = ctx["client"].get(p.get("client_id")) or {}
    return {"client": c.get("name", ""), "client_id": c.get("id", ""), "project": p.get("name", ""), "project_id": p.get("id", "")}


def _hours(v) -> float:
    return float(money(v.get("time_spent")))


def _planned(v) -> float:
    return float(money(unpack(v.get("planned_work"))[1].get("planned_hours")))


def _cost(ctx, v) -> float:
    """Labor cost of one task: hours x cost per hour of the assigned person (0 if nobody / no cost set)."""
    m = ctx["member"].get(v.get("assigned_to")) or {}
    return float((money(v.get("time_spent")) * money(m.get("hourly_cost"))).quantize(CENT))


def _days(from_iso: str, today: str) -> int:
    try:
        return (date.fromisoformat(today[:10]) - date.fromisoformat(str(from_iso)[:10])).days
    except ValueError:
        return 0


def _bucket(days: int) -> str:
    return "0-30 days" if days <= 30 else "31-60 days" if days <= 60 else "61-90 days" if days <= 90 else "90+ days"


def col(key, label, kind="text", default=True, cost=False, align=None):
    """One column. kind: text | date | money | number | percent. cost=True -> Owner only."""
    return {"key": key, "label": label, "type": kind, "default": default, "cost": cost,
            "align": align or ("right" if kind in ("money", "number", "percent") else "left")}


# =====================================================================================================
# The detailed reports
# =====================================================================================================
COLUMNS = {
    "income": [
        col("date", "Paid on", "date"), col("number", "Invoice #"), col("client", "Client"), col("project", "Project"),
        col("invoice_date", "Invoice date", "date", False), col("days_to_pay", "Days to pay", "number", False),
        col("labor", "Labor", "money", False), col("materials", "Materials", "money", False), col("amount", "Amount", "money"),
    ],
    "expenses": [
        col("date", "Date", "date"), col("store", "Store"), col("category", "Category"), col("client", "Client"),
        col("project", "Project"), col("task", "Task", default=False), col("entered_by", "Entered by", default=False),
        col("type", "Type"), col("invoiced", "On invoice", default=False), col("amount", "Amount", "money"),
    ],
    "debts": [
        col("client", "Client"), col("number", "Invoice #"), col("project", "Project"), col("invoice_date", "Invoice date", "date"),
        col("days", "Days unpaid", "number"), col("bucket", "Age"), col("amount", "Amount", "money"),
    ],
    "jobs": [
        col("project", "Project"), col("client", "Client"), col("paid", "Paid", "money"),
        col("invoiced", "Invoiced", "money", False), col("materials", "Materials", "money"), col("hours", "Hours", "number"),
        col("labor_cost", "Labor cost", "money", cost=True), col("profit", "Profit", "money", cost=True),
        col("per_hour", "$ / hour", "money"), col("estimate", "Estimate", "money", False),
        col("vs_estimate", "Invoiced vs. estimate", "money", False),
    ],
    "team": [
        col("date", "Date", "date"), col("employee", "Employee"), col("client", "Client"), col("project", "Project"),
        col("task", "Task"), col("status", "Status", default=False), col("planned", "Planned h", "number"),
        col("actual", "Actual h", "number"), col("diff", "Difference h", "number"), col("over_pct", "Over plan", "percent", False),
        col("labor_cost", "Labor cost", "money", False, cost=True),
    ],
}

# what each report can be grouped by (the browser adds subtotals per group)
GROUPS = {
    "income": [("month", "Month"), ("client", "Client"), ("project", "Project")],
    "expenses": [("month", "Month"), ("client", "Client"), ("project", "Project"), ("category", "Category"),
                 ("entered_by", "Entered by"), ("type", "Type")],
    "debts": [("client", "Client"), ("bucket", "Age")],
    "jobs": [("client", "Client")],
    "team": [("employee", "Employee"), ("month", "Month"), ("client", "Client"), ("project", "Project")],
}


def _income_rows(ctx, start, end, today):
    rows = []
    for d in ctx["invoices"]:
        if d["status"] != "Paid" or not _in_range(d.get("paid_date"), start, end):
            continue
        rows.append({**_where(ctx, d["project_id"]), "date": str(d.get("paid_date") or "")[:10],
                     "month": str(d.get("paid_date") or "")[:7], "number": d.get("invoice_number") or "",
                     "invoice_date": str(d.get("invoice_date") or "")[:10],
                     "days_to_pay": _days(d.get("invoice_date"), d.get("paid_date") or today),
                     "labor": float(money(d.get("labor_amount"))), "materials": float(money(d.get("materials_amount"))),
                     "amount": float(money(d.get("total")))})
    return rows


def _expense_rows(ctx, start, end, today):
    rows = []
    for r in ctx["receipts"]:
        if not _in_range(r.get("receipt_date"), start, end):
            continue
        v = ctx["visit"].get(r.get("visit_id")) or {}
        who = ctx["member"].get(r.get("created_by")) or {}
        rows.append({**_where(ctx, r["project_id"]), "date": str(r.get("receipt_date") or "")[:10],
                     "month": str(r.get("receipt_date") or "")[:7], "store": strip_meta(r.get("store")),
                     "category": r.get("category") or "", "task": task_title(v) if v else "",
                     "entered_by": who.get("name", ""), "member_id": who.get("id", ""),
                     "type": "Billable" if r.get("billable") else "Internal",
                     "invoiced": "Yes" if r.get("invoice_id") else "No", "amount": float(money(r.get("amount")))})
    return rows


def _debt_rows(ctx, start, end, today):
    """Unpaid invoices AS OF TODAY - the period is ignored on purpose."""
    rows = []
    for d in ctx["invoices"]:
        if d["status"] != "Unpaid":
            continue
        days = max(0, _days(d.get("invoice_date"), today))
        rows.append({**_where(ctx, d["project_id"]), "number": d.get("invoice_number") or "",
                     "invoice_date": str(d.get("invoice_date") or "")[:10], "days": days, "bucket": _bucket(days),
                     "amount": float(money(d.get("total")))})
    return rows


def _team_rows(ctx, start, end, today):
    rows = []
    for v in ctx["visits"]:
        if not _in_range(v.get("visit_date"), start, end):
            continue
        planned, actual = _planned(v), _hours(v)
        if not planned and not actual:
            continue
        m = ctx["member"].get(v.get("assigned_to")) or {}
        rows.append({**_where(ctx, v["project_id"]), "date": str(v.get("visit_date") or "")[:10],
                     "month": str(v.get("visit_date") or "")[:7], "employee": m.get("name", "Unassigned"),
                     "member_id": m.get("id", ""), "task": task_title(v), "status": v.get("status", ""),
                     "planned": planned, "actual": actual, "diff": round(actual - planned, 2),
                     "over_pct": round((actual - planned) / planned * 100, 1) if planned else None,
                     "labor_cost": _cost(ctx, v)})
    return rows


def _job_rows(ctx, start, end, today):
    """One row per project with any money or hours in the period. Paid / materials / hours / labor are
    counted inside the period; 'Invoiced vs. estimate' compares ALL invoices of the job with its estimate."""
    agg = defaultdict(lambda: {"paid": ZERO, "invoiced": ZERO, "materials": ZERO, "hours": ZERO, "labor": ZERO, "all_invoiced": ZERO})
    for d in ctx["invoices"]:
        a = agg[d["project_id"]]
        a["all_invoiced"] += money(d.get("total"))
        if d["status"] == "Paid" and _in_range(d.get("paid_date"), start, end):
            a["paid"] += money(d.get("total"))
        if _in_range(d.get("invoice_date"), start, end):
            a["invoiced"] += money(d.get("total"))
    for r in ctx["receipts"]:
        if _in_range(r.get("receipt_date"), start, end):
            agg[r["project_id"]]["materials"] += money(r.get("amount"))
    for v in ctx["visits"]:
        if _in_range(v.get("visit_date"), start, end):
            agg[v["project_id"]]["hours"] += money(v.get("time_spent"))
            agg[v["project_id"]]["labor"] += money(_cost(ctx, v))

    rows = []
    for pid, a in agg.items():
        if pid not in ctx["project"] or not (a["paid"] or a["invoiced"] or a["materials"] or a["hours"]):
            continue
        est = ctx["estimates"].get(pid)
        est_total = money(est["total"]) if est else None
        hours = float(a["hours"])
        rows.append({**_where(ctx, pid), "paid": float(a["paid"]), "invoiced": float(a["invoiced"]),
                     "materials": float(a["materials"]), "hours": hours, "labor_cost": float(a["labor"]),
                     "profit": float(a["paid"] - a["materials"] - a["labor"]),
                     "per_hour": round(float(a["paid"] - a["materials"]) / hours, 2) if hours else None,
                     "estimate": float(est_total) if est_total is not None else None,
                     "vs_estimate": float(a["all_invoiced"] - est_total) if est_total else None})
    return rows


BUILDERS = {"income": _income_rows, "expenses": _expense_rows, "debts": _debt_rows, "jobs": _job_rows, "team": _team_rows}


def dataset(kind: str, ctx: dict, start: str, end: str, today: str, with_cost: bool) -> dict:
    """One detailed report. Without with_cost (not the Owner) the labor cost / profit columns are removed."""
    columns = [c for c in COLUMNS[kind] if with_cost or not c["cost"]]
    rows = BUILDERS[kind](ctx, start, end, today)
    if not with_cost:
        hidden = {c["key"] for c in COLUMNS[kind] if c["cost"]}
        rows = [{k: v for k, v in r.items() if k not in hidden} for r in rows]
    return {"kind": kind, "columns": columns, "groups": [{"key": k, "label": l} for k, l in GROUPS[kind]],
            "rows": rows, "as_of_today": kind == "debts"}


# =====================================================================================================
# Overview: the 5 blocks
# =====================================================================================================
def _add_months(ym: tuple[int, int], n: int) -> tuple[int, int]:
    y, m = ym
    m += n
    while m > 12:
        y, m = y + 1, m - 12
    while m < 1:
        y, m = y - 1, m + 12
    return y, m


def _money_block(ctx, start, end, with_cost) -> dict:
    revenue = sum((money(d["total"]) for d in ctx["invoices"]
                   if d["status"] == "Paid" and _in_range(d.get("paid_date"), start, end)), ZERO)
    expenses = sum((money(r.get("amount")) for r in ctx["receipts"] if _in_range(r.get("receipt_date"), start, end)), ZERO)
    labor = sum((money(_cost(ctx, v)) for v in ctx["visits"] if _in_range(v.get("visit_date"), start, end)), ZERO) \
        if with_cost else ZERO
    out = {"revenue": float(revenue), "expenses": float(expenses), "net": float(revenue - expenses - labor)}
    if with_cost:
        out["labor"] = float(labor)
    return out


def overview(ctx: dict, start: str, end: str, prev_start: str, prev_end: str, today: str, with_cost: bool) -> dict:
    # 2. who owes me (as of today)
    debts = _debt_rows(ctx, "", "", today)
    buckets = {b: 0.0 for b in ("0-30 days", "31-60 days", "61-90 days", "90+ days")}
    per_client = defaultdict(lambda: {"amount": 0.0, "days": 0, "client_id": ""})
    for d in debts:
        buckets[d["bucket"]] += d["amount"]
        c = per_client[d["client"]]
        c["amount"] += d["amount"]
        c["days"] = max(c["days"], d["days"])
        c["client_id"] = d["client_id"]
    debtors = sorted(({"client": k, **v} for k, v in per_client.items()), key=lambda x: -x["amount"])

    # 3. 12 months ending with the month of the period end (or this month)
    last = (end or today)[:7]
    y, m = int(last[:4]), int(last[5:7])
    months = [_add_months((y, m), -i) for i in range(11, -1, -1)]
    trend = []
    for (yy, mm) in months:
        key = f"{yy}-{mm:02d}"
        first = f"{key}-01"
        nxt = _add_months((yy, mm), 1)
        last_day = date(nxt[0], nxt[1], 1).toordinal() - 1
        block = _money_block(ctx, first, date.fromordinal(last_day).isoformat(), with_cost)
        trend.append({"month": key, "income": block["revenue"], "expenses": block["expenses"] + block.get("labor", 0)})

    # 4. jobs and 5. team, for the period
    jobs = sorted(_job_rows(ctx, start, end, today), key=lambda r: -(r["profit"] if with_cost else r["paid"] - r["materials"]))
    team = defaultdict(lambda: {"done": 0, "planned": 0.0, "actual": 0.0, "labor_cost": 0.0, "member_id": ""})
    for r in _team_rows(ctx, start, end, today):
        t = team[r["employee"]]
        t["done"] += r["status"] == "Completed"
        t["planned"] += r["planned"]
        t["actual"] += r["actual"]
        t["labor_cost"] += r["labor_cost"]
        t["member_id"] = r["member_id"]
    team_rows = []
    for name, t in sorted(team.items()):
        row = {"employee": name, "member_id": t["member_id"], "done": t["done"], "planned": round(t["planned"], 2),
               "actual": round(t["actual"], 2),
               "over_pct": round((t["actual"] - t["planned"]) / t["planned"] * 100, 1) if t["planned"] else None}
        if with_cost:
            row["labor_cost"] = round(t["labor_cost"], 2)
        team_rows.append(row)
    if not with_cost:
        jobs = [{k: v for k, v in j.items() if k not in ("labor_cost", "profit")} for j in jobs]

    return {
        "current": _money_block(ctx, start, end, with_cost),
        "previous": _money_block(ctx, prev_start, prev_end, with_cost) if (prev_start or prev_end) else None,
        "owed": {"total": round(sum(buckets.values()), 2), "buckets": buckets, "debtors": debtors},
        "trend": trend,
        "jobs": jobs,
        "team": team_rows,
        "with_cost": with_cost,
    }
