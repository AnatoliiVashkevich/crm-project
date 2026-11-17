"""invoice_pdf.py - draws an estimate or invoice PDF (US Letter) with ReportLab.

Layout, top to bottom:
    [logo] My company (from My Profile)        ESTIMATE / INVOICE, No., Date, "PAID" stamp once paid
    BILL TO (client)                           JOB SITE (project + address)
    Description | Qty | Rate | Amount          <- the document's line items
    TOTAL (DUE / PAID / ESTIMATED)
    Notes, payment details, thank-you line

Gets plain dicts, returns PDF bytes. Never touches the database.
"""
import logging
import urllib.request
from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from billing import strip_meta

log = logging.getLogger("crm")

GRAY = colors.HexColor("#6b7280")
LINE = colors.HexColor("#d1d5db")
DARK = colors.HexColor("#111827")


def usd(x) -> str:
    return f"${float(x or 0):,.2f}"


def qty_text(x) -> str:
    """2.0 -> '2', 2.25 -> '2.25'."""
    return f"{float(x or 0):g}"


def load_logo(url: str, max_w=1.6 * inch, max_h=0.8 * inch):
    """My Profile logo (any public image link) scaled to fit the header. None if missing or unreachable:
    a broken logo link must never stop the document from being created."""
    if not url or not url.startswith(("http://", "https://")):
        return None
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "FieldServiceCRM/1.0"}),
                                    timeout=5) as r:
            data = BytesIO(r.read(2 * 1024 * 1024))
        w, h = ImageReader(data).getSize()
        scale = min(max_w / w, max_h / h, 1)
        data.seek(0)
        img = Image(data, width=w * scale, height=h * scale)
        img.hAlign = "LEFT"
        return img
    except Exception:
        log.warning("Logo could not be loaded for the PDF", exc_info=True)
        return None


def build_invoice_pdf(doc_row: dict, client: dict, project: dict, profile: dict, items: list[dict]) -> bytes:
    """doc_row = the invoices row (estimate or invoice); items = its line items (see billing.py)."""
    is_estimate = doc_row.get("kind") == "estimate"
    word = "ESTIMATE" if is_estimate else "INVOICE"
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter, leftMargin=0.8 * inch, rightMargin=0.8 * inch,
        topMargin=0.7 * inch, bottomMargin=0.7 * inch,
        title=f"{word.title()} {doc_row.get('invoice_number') or ''}".strip(),
    )
    base = getSampleStyleSheet()["Normal"]
    body = ParagraphStyle("body", parent=base, fontSize=10, leading=13, textColor=DARK)
    small = ParagraphStyle("small", parent=body, fontSize=9, leading=12, textColor=GRAY)
    bold = ParagraphStyle("bold", parent=body, fontName="Helvetica-Bold")
    title = ParagraphStyle("title", parent=body, fontName="Helvetica-Bold", fontSize=24, leading=28, alignment=2)
    right = ParagraphStyle("right", parent=body, alignment=2)
    right_bold = ParagraphStyle("right_bold", parent=bold, alignment=2)

    def P(text, style=body):
        """Plain text -> paragraph (user text is escaped so '<' or '&' can't break the PDF)."""
        return Paragraph(escape(str(text or "")).replace("\n", "<br/>"), style)

    def lines(*values):
        return [x for x in values if x]

    # ---- header: [logo] my company (left) | ESTIMATE/INVOICE + number/date/status (right)
    logo = load_logo(profile.get("logo_url"))
    left = ([logo, Spacer(1, 6)] if logo else [])
    left += [P(profile.get("company_name") or "Your Company", ParagraphStyle("co", parent=bold, fontSize=14, leading=18))]
    left += [P(x, small) for x in lines(profile.get("business_address"), profile.get("phone"), profile.get("email"))]
    paid = doc_row.get("status") == "Paid" and not is_estimate
    rt = [Paragraph(word, title),
          P(f"No. {doc_row.get('invoice_number') or '-'}", right_bold),
          P(f"Date: {doc_row.get('invoice_date') or ''}", right)]
    if paid:   # only a green "PAID" stamp; an unpaid invoice shows no status (the client sees "TOTAL DUE")
        status_text = f"PAID{' on ' + doc_row['paid_date'] if doc_row.get('paid_date') else ''}"
        rt.append(Paragraph(f'<font color="#16a34a"><b>{escape(status_text)}</b></font>', right))
    head = Table([[left, rt]], colWidths=[3.4 * inch, 3.5 * inch])
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))

    # ---- bill to | job site
    job_addr = ", ".join(x for x in (project.get("street"), project.get("city"),
                                     " ".join(y for y in (project.get("state"), project.get("zip")) if y)) if x)
    bill = [P("BILL TO", small), P(client.get("name"), bold)] + [P(x) for x in lines(client.get("phone"), client.get("email"))]
    job = [P("JOB SITE", small), P(project.get("name"), bold)] + ([P(job_addr)] if job_addr else [])
    parties = Table([[bill, job]], colWidths=[3.4 * inch, 3.5 * inch])
    parties.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))

    # ---- line items
    rows = [[P("Description", bold), P("Qty", right_bold), P("Rate", right_bold), P("Amount", right_bold)]]
    for it in items:
        rows.append([P(strip_meta(it.get("description")) or "-"), P(qty_text(it.get("qty")), right),
                     P(usd(it.get("rate")), right), P(usd(it.get("amount")), right)])
    if len(rows) == 1:
        rows.append([P("-"), P(""), P(""), P(usd(0), right)])
    table = Table(rows, colWidths=[3.9 * inch, 0.8 * inch, 1.0 * inch, 1.2 * inch], repeatRows=1)
    table.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), 1, DARK), ("LINEBELOW", (0, 1), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))

    label = "ESTIMATED TOTAL" if is_estimate else ("TOTAL PAID" if paid else "TOTAL DUE")
    total = Table([[P(label, right_bold),
                    P(usd(doc_row.get("total")), ParagraphStyle("t", parent=right_bold, fontSize=14, leading=18))]],
                  colWidths=[5.7 * inch, 1.2 * inch])
    total.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, 0), 1, DARK), ("TOPPADDING", (0, 0), (-1, -1), 8)]))

    story = [head, Spacer(1, 22), parties, Spacer(1, 22), table, Spacer(1, 6), total, Spacer(1, 20)]
    notes = strip_meta(doc_row.get("description"))
    if notes:
        story += [P("NOTES", small), P(notes), Spacer(1, 10)]
    if profile.get("payment_details"):
        story += [P("PAYMENT DETAILS", small), P(profile["payment_details"]), Spacer(1, 10)]
    story.append(P("This estimate is not a bill." if is_estimate else "Thank you for your business!", small))
    doc.build(story)
    return buf.getvalue()
