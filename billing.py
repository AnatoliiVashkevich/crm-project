"""billing.py - estimate + invoice math. Pure functions, no database access."""
from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")
ZERO = Decimal("0.00")


def money(x) -> Decimal:
    return Decimal(str(x or 0)).quantize(CENT, rounding=ROUND_HALF_UP)


def estimate_rate(project: dict, profile: dict) -> Decimal:
    """Hourly estimate uses the project's rate, falling back to the default rate from My Profile."""
    return money(project.get("estimate_rate")) or money(profile.get("default_hourly_rate"))


def estimate_amount(project: dict, profile: dict) -> Decimal | None:
    """None = no estimate (shown as a dash in the Estimate vs Invoice report)."""
    mode = project.get("estimate_mode")
    if mode == "fixed":
        return money(project.get("estimate_fixed"))
    if mode == "hourly":
        return (estimate_rate(project, profile) * money(project.get("estimate_hours"))).quantize(CENT, rounding=ROUND_HALF_UP)
    return None


def compute_invoice(project: dict, profile: dict, visit: dict, receipts: list[dict], is_first_invoice: bool,
                    visit_already_invoiced: bool = False) -> dict:
    """What a new invoice for this visit contains.

    - Fixed Price estimate: the fixed price is billed once, on the project's first invoice.
    - Hourly Rate estimate: actual visit hours x the estimate rate.
    - No estimate: actual visit hours x default hourly rate from My Profile.
    - Materials: billable receipts that were not invoiced yet.
    - Description: this visit's Planned Work, else the Estimate description.
    - Extra invoice for a visit that already has one: no labor and no hours (they were billed the first time),
      only the new billable receipts; the description is left empty for the user to write.
    """
    hours = ZERO if visit_already_invoiced else money(visit.get("time_spent"))
    mode = project.get("estimate_mode")
    if visit_already_invoiced:
        rate = (estimate_rate(project, profile) if mode == "hourly"
                else ZERO if mode == "fixed" else money(profile.get("default_hourly_rate")))
        labor = ZERO
    elif mode == "fixed":
        rate = ZERO
        labor = money(project.get("estimate_fixed")) if is_first_invoice else ZERO
    else:
        rate = estimate_rate(project, profile) if mode == "hourly" else money(profile.get("default_hourly_rate"))
        labor = (hours * rate).quantize(CENT, rounding=ROUND_HALF_UP)
    materials = sum((money(r.get("amount")) for r in receipts), ZERO)
    description = "" if visit_already_invoiced else (
        (visit.get("planned_work") or "").strip() or (project.get("estimate_description") or "").strip())
    return {
        "hours": hours,
        "hourly_rate": rate,
        "labor_amount": labor,
        "materials_amount": materials,
        "total": labor + materials,
        "estimate_amount": estimate_amount(project, profile),
        "description": description,
    }
