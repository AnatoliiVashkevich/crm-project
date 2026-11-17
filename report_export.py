"""report_export.py - the Income & Expense report as a file: CSV (for Excel / your accountant) or PDF.

Same rules as the on-screen report (billing.compute_report), so the numbers always match:
    Income - paid      invoices with status Paid,   dated by their PAID date
    Income - unpaid    invoices with status Unpaid, dated by their INVOICE date
    Expenses           every receipt (billable and internal), dated by the RECEIPT date
Estimates are never money and are left out.

Pure functions: rows in, bytes out. No database.
"""
import csv
import io
from xml.sax.saxutils import escape

from billing import ZERO, _in_range, money, strip_meta


def report_rows(documents: list[dict], receipts: list[dict], projects: list[dict], clients: dict,
                start: str = "", end: str = "") -> tuple[list[dict], list[dict], dict]:
    """-> (income rows, expense rows, totals). clients = {client_id: name}."""
    project = {p["id"]: p for p in projects}
    where = lambda pid: (clients.get((project.get(pid) or {}).get("client_id"), ""), (project.get(pid) or {}).get("name", ""))

    income = []
    for d in documents:
        if d.get("kind", "invoice") != "invoice":
            continue
        paid = d["status"] == "Paid"
        date = d.get("paid_date") if paid else d.get("invoice_date")
        if not _in_range(date, start, end):
            continue
        client, proj = where(d["project_id"])
        income.append({"date": str(date or "")[:10], "number": d.get("invoice_number") or "", "client": client,
                       "project": proj, "status": "Paid" if paid else "Unpaid", "amount": money(d.get("total"))})

    expenses = []
    for r in receipts:
        if not _in_range(r.get("receipt_date"), start, end):
            continue
        client, proj = where(r["project_id"])
        expenses.append({"date": str(r.get("receipt_date") or "")[:10], "store": strip_meta(r.get("store")),
                         "category": r.get("category") or "", "client": client, "project": proj,
                         "billable": "Billable" if r.get("billable") else "Internal", "amount": money(r.get("amount"))})

    income.sort(key=lambda x: x["date"])
    expenses.sort(key=lambda x: x["date"])
    revenue = sum((x["amount"] for x in income if x["status"] == "Paid"), ZERO)
    unpaid = sum((x["amount"] for x in income if x["status"] == "Unpaid"), ZERO)
    spent = sum((x["amount"] for x in expenses), ZERO)
    totals = {"revenue": revenue, "unpaid": unpaid, "expenses": spent, "net": revenue - spent}
    return income, expenses, totals


def period_label(start: str, end: str) -> str:
    if start and end:
        return f"{start} to {end}"
    if start:
        return f"from {start}"
    if end:
        return f"until {end}"
    return "All time"


def to_csv(income: list[dict], expenses: list[dict], totals: dict, title: str) -> bytes:
    """One sheet: a 'Type' column tells income from expenses; totals at the bottom. Opens in Excel / Google Sheets."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([title])
    w.writerow([])
    w.writerow(["Type", "Date", "Invoice # / Store", "Client", "Project", "Status / Category", "Amount"])
    for x in income:
        w.writerow([f"Income ({x['status']})", x["date"], x["number"], x["client"], x["project"], x["status"], f"{x['amount']:.2f}"])
    for x in expenses:
        w.writerow([f"Expense ({x['billable']})", x["date"], x["store"], x["client"], x["project"], x["category"], f"-{x['amount']:.2f}"])
    w.writerow([])
    w.writerow(["Revenue (Paid)", "", "", "", "", "", f"{totals['revenue']:.2f}"])
    w.writerow(["Unpaid / Pending", "", "", "", "", "", f"{totals['unpaid']:.2f}"])
    w.writerow(["Total Expenses", "", "", "", "", "", f"{totals['expenses']:.2f}"])
    w.writerow(["Net Profit (Revenue - Expenses)", "", "", "", "", "", f"{totals['net']:.2f}"])
    return ("﻿" + buf.getvalue()).encode("utf-8")   # BOM so Excel reads accents correctly


def to_pdf(income: list[dict], expenses: list[dict], totals: dict, title: str, company: str) -> bytes:
    """Summary cards + an income table + an expense table."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    usd = lambda d: f"${float(d):,.2f}"
    base = getSampleStyleSheet()["Normal"]
    body = ParagraphStyle("b", parent=base, fontSize=9, leading=11)
    head = ParagraphStyle("h", parent=base, fontName="Helvetica-Bold", fontSize=16, leading=20)
    sub = ParagraphStyle("s", parent=base, fontName="Helvetica-Bold", fontSize=11, leading=14, spaceBefore=12)
    gray = colors.HexColor("#6b7280")
    P = lambda t, s=body: Paragraph(escape(str(t or "")), s)

    def table(header, rows, widths):
        t = Table([[P(h, ParagraphStyle("th", parent=body, fontName="Helvetica-Bold")) for h in header]] + rows,
                  colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 1, colors.black),
                               ("LINEBELOW", (0, 1), (-1, -1), 0.4, colors.HexColor("#d1d5db")),
                               ("ALIGN", (-1, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
        return t

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch, title=title)
    summary = Table([[P("Revenue (Paid)"), P("Unpaid / Pending"), P("Total Expenses"), P("Net Profit")],
                     [P(usd(totals["revenue"]), head), P(usd(totals["unpaid"]), head),
                      P(usd(totals["expenses"]), head), P(usd(totals["net"]), head)]],
                    colWidths=[1.8 * inch] * 4)
    summary.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.5, gray), ("INNERGRID", (0, 0), (-1, -1), 0.5, gray),
                                 ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    story = [P(company or "Income & Expense Report", head), P(title, ParagraphStyle("t", parent=body, textColor=gray)),
             Spacer(1, 12), summary]

    story.append(P(f"Income ({len(income)})", sub))
    story.append(table(["Date", "Invoice #", "Client", "Project", "Status", "Amount"],
                       [[P(x["date"]), P(x["number"]), P(x["client"]), P(x["project"]), P(x["status"]), P(usd(x["amount"]))]
                        for x in income] or [[P("No income in this period"), "", "", "", "", ""]],
                       [0.8 * inch, 0.8 * inch, 1.6 * inch, 1.9 * inch, 0.8 * inch, 1.1 * inch]))
    story.append(P(f"Expenses ({len(expenses)})", sub))
    story.append(table(["Date", "Store", "Client", "Project", "Type", "Amount"],
                       [[P(x["date"]), P(x["store"]), P(x["client"]), P(x["project"]), P(x["billable"]), P(usd(x["amount"]))]
                        for x in expenses] or [[P("No expenses in this period"), "", "", "", "", ""]],
                       [0.8 * inch, 1.3 * inch, 1.4 * inch, 1.7 * inch, 0.8 * inch, 1.0 * inch]))
    doc.build(story)
    return buf.getvalue()


def table_pdf(title: str, subtitle: str, company: str, columns: list[dict], rows: list[dict]) -> bytes:
    """Any report table, exactly as the browser shows it (chosen columns, groups, subtotals, total).
    columns = [{"label", "align": "left"|"right"}]; rows = [{"cells": [text...], "kind": "row"|"group"|"subtotal"|"total"}].
    Many columns -> landscape page."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    columns = columns[:20]
    page = landscape(letter) if len(columns) > 6 else letter
    base = getSampleStyleSheet()["Normal"]
    body = ParagraphStyle("b", parent=base, fontSize=8 if len(columns) > 8 else 9, leading=11)
    bold = ParagraphStyle("bb", parent=body, fontName="Helvetica-Bold")
    styles = {(a, b): ParagraphStyle(f"{a}{b}", parent=bold if b else body, alignment=2 if a == "right" else 0)
              for a in ("left", "right") for b in (False, True)}
    cell = lambda text, align, strong=False: Paragraph(escape(str(text if text is not None else "")),
                                                       styles[(align if align == "right" else "left", strong)])

    data = [[cell(c.get("label"), c.get("align"), True) for c in columns]]
    style = [("LINEBELOW", (0, 0), (-1, 0), 1, colors.black), ("VALIGN", (0, 0), (-1, -1), "TOP")]
    for i, r in enumerate(rows[:5000], start=1):
        kind = r.get("kind", "row")
        cells = (list(r.get("cells") or []) + [""] * len(columns))[:len(columns)]
        data.append([cell(v, columns[j].get("align"), kind != "row") for j, v in enumerate(cells)])
        if kind == "group":
            style += [("BACKGROUND", (0, i), (-1, i), colors.HexColor("#eef2ff")), ("SPAN", (0, i), (-1, i))]
        elif kind == "subtotal":
            style += [("LINEABOVE", (0, i), (-1, i), 0.5, colors.HexColor("#9ca3af"))]
        elif kind == "total":
            style += [("LINEABOVE", (0, i), (-1, i), 1.2, colors.black)]
        else:
            style += [("LINEBELOW", (0, i), (-1, i), 0.3, colors.HexColor("#e5e7eb"))]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=page, leftMargin=0.5 * inch, rightMargin=0.5 * inch,
                            topMargin=0.5 * inch, bottomMargin=0.5 * inch, title=title)
    table = Table(data, repeatRows=1, colWidths=[doc.width / max(1, len(columns))] * len(columns))
    table.setStyle(TableStyle(style))
    gray = ParagraphStyle("g", parent=body, textColor=colors.HexColor("#6b7280"))
    head = ParagraphStyle("h", parent=base, fontName="Helvetica-Bold", fontSize=15, leading=19)
    doc.build([Paragraph(escape(company or title), head), Paragraph(escape(title if company else ""), bold),
               Paragraph(escape(subtitle or ""), gray), Spacer(1, 10), table])
    return buf.getvalue()
