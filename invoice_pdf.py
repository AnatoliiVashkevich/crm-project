"""invoice_pdf.py - builds the invoice PDF. Pure function, no database access."""
from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

GRAY = colors.HexColor("#6b7280")
LINE = colors.HexColor("#d1d5db")
DARK = colors.HexColor("#111827")


def usd(x) -> str:
    return f"${float(x or 0):,.2f}"


def build_invoice_pdf(invoice: dict, client: dict, project: dict, profile: dict, receipts: list[dict]) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter, leftMargin=0.8 * inch, rightMargin=0.8 * inch,
        topMargin=0.7 * inch, bottomMargin=0.7 * inch,
        title=f"Invoice {invoice.get('invoice_number') or ''}".strip(),
    )
    base = getSampleStyleSheet()["Normal"]
    body = ParagraphStyle("body", parent=base, fontSize=10, leading=13, textColor=DARK)
    small = ParagraphStyle("small", parent=body, fontSize=9, leading=12, textColor=GRAY)
    bold = ParagraphStyle("bold", parent=body, fontName="Helvetica-Bold")
    title = ParagraphStyle("title", parent=body, fontName="Helvetica-Bold", fontSize=24, leading=28, alignment=2)
    right = ParagraphStyle("right", parent=body, alignment=2)
    right_bold = ParagraphStyle("right_bold", parent=bold, alignment=2)

    def P(text, style=body):
        return Paragraph(escape(str(text or "")).replace("\n", "<br/>"), style)

    def lines(*items):
        return [x for x in items if x]

    # ---- header: my company (left) | INVOICE + number/date/status (right)
    company = lines(profile.get("business_address"), profile.get("phone"), profile.get("email"))
    left = [P(profile.get("company_name") or "Your Company", ParagraphStyle("co", parent=bold, fontSize=14, leading=18))]
    left += [P(x, small) for x in company]
    paid = invoice.get("status") == "Paid"
    status_text = f"PAID{' on ' + invoice['paid_date'] if invoice.get('paid_date') else ''}" if paid else ""
    status_color = "#16a34a" if paid else "#dc2626"
    rt = [Paragraph("INVOICE", title),
          P(f"No. {invoice.get('invoice_number') or '-'}", right_bold),
          P(f"Date: {invoice.get('invoice_date') or ''}", right),
          Paragraph(f'<font color="{status_color}"><b>{escape(status_text)}</b></font>', right)]
    head = Table([[left, rt]], colWidths=[3.4 * inch, 3.5 * inch])
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))

    # ---- bill to
    job_addr = ", ".join(x for x in (project.get("street"), project.get("city"),
                                     " ".join(y for y in (project.get("state"), project.get("zip")) if y)) if x)
    bill = [P("BILL TO", small), P(client.get("name"), bold)]
    bill += [P(x) for x in lines(client.get("phone"), client.get("email"))]
    job = [P("JOB SITE", small), P(project.get("name"), bold)]
    if job_addr:
        job.append(P(job_addr))
    parties = Table([[bill, job]], colWidths=[3.4 * inch, 3.5 * inch])
    parties.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))

    # ---- line items
    hours, rate = float(invoice.get("hours") or 0), float(invoice.get("hourly_rate") or 0)
    labor, materials = float(invoice.get("labor_amount") or 0), float(invoice.get("materials_amount") or 0)
    rows = [[P("Description", bold), P("Hours", right_bold), P("Rate", right_bold), P("Amount", right_bold)]]
    desc = (invoice.get("description") or "").strip()
    if desc or labor:
        rows.append([P(desc or "Labor"), P(f"{hours:g}" if rate else "", right),
                     P(usd(rate) if rate else "", right), P(usd(labor), right)])
    if materials or receipts:
        stores = ", ".join(dict.fromkeys(r.get("store") for r in receipts if r.get("store")))
        rows.append([P("Materials" + (f": {stores}" if stores else "")), P("", right), P("", right), P(usd(materials), right)])
    if len(rows) == 1:
        rows.append([P("-"), P(""), P(""), P(usd(0), right)])
    items = Table(rows, colWidths=[3.9 * inch, 0.8 * inch, 1.0 * inch, 1.2 * inch], repeatRows=1)
    items.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), 1, DARK), ("LINEBELOW", (0, 1), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))

    total = Table([[P("TOTAL DUE" if not paid else "TOTAL PAID", right_bold),
                    P(usd(invoice.get("total")), ParagraphStyle("t", parent=right_bold, fontSize=14, leading=18))]],
                  colWidths=[5.7 * inch, 1.2 * inch])
    total.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, 0), 1, DARK), ("TOPPADDING", (0, 0), (-1, -1), 8)]))

    story = [head, Spacer(1, 22), parties, Spacer(1, 22), items, Spacer(1, 6), total, Spacer(1, 26)]
    if profile.get("payment_details"):
        story += [P("PAYMENT DETAILS", small), P(profile["payment_details"]), Spacer(1, 10)]
    story.append(P("Thank you for your business!", small))
    doc.build(story)
    return buf.getvalue()
