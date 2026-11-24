import re
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Money = Annotated[Decimal, Field(ge=-999999999.99, le=999999999.99, decimal_places=2)]
CENT = Decimal("0.01")

LABELS = {
    "invoice_number": "Numéro de facture",
    "supplier": "Fournisseur",
    "invoice_date": "Date de facture",
    "currency": "Devise",
    "subtotal": "Total HT",
    "vat_amount": "TVA",
    "total": "Total TTC",
}
LINE_LABELS = {
    "description": "Description",
    "quantity": "Quantité",
    "unit_price": "Prix unitaire",
    "discount_percent": "Remise (%)",
    "amount": "Montant",
}


def field_label(loc: tuple) -> str:
    if loc[0] == "lines" and len(loc) > 2:
        return f"Ligne {loc[1] + 1} · {LINE_LABELS.get(loc[2], loc[2])}"
    return LABELS.get(loc[0], "Facture")


def french(value: Decimal) -> str:
    return f"{value:.2f}".replace(".", ",")


def parse_number(value, decimals: int, message: str) -> Decimal:
    """Read a signed French or English number such as -1 234,56 or 0.3500."""
    if not isinstance(value, str):
        raise ValueError("Saisissez la valeur sous forme de texte.")
    value = re.sub(r"\s*(?:EUR|€|%)$", "", value.strip(), flags=re.I)
    sign = -1 if value[:1] in {"-", "−"} else 1
    value = value.lstrip("-−").strip()
    if re.fullmatch(r"\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?", value):
        value = re.sub(r"\s", "", value)
    if not re.fullmatch(rf"\d{{1,9}}(?:[.,]\d{{1,{decimals}}})?", value):
        raise ValueError(message)
    return sign * Decimal(value.replace(",", "."))


class LineCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str | None
    quantity: str | None
    unit_price: str | None
    discount_percent: str | None
    amount: str | None


class Candidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    invoice_number: str | None
    supplier: str | None
    invoice_date: str | None
    currency: str | None
    subtotal: str | None
    vat_amount: str | None
    total: str | None
    lines: list[LineCandidate] = []


class LineItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: Label
    quantity: Decimal
    unit_price: Decimal
    discount_percent: Decimal = Field(default=Decimal(0), ge=0, le=100)
    amount: Money

    @field_validator("quantity", mode="before")
    @classmethod
    def parse_quantity(cls, value):
        return parse_number(value, 3, "Quantité attendue au format 12 ou 1,5.")

    @field_validator("unit_price", mode="before")
    @classmethod
    def parse_unit_price(cls, value):
        return parse_number(value, 4, "Prix unitaire attendu au format 12,50.")

    @field_validator("discount_percent", mode="before")
    @classmethod
    def parse_discount(cls, value):
        if value is None or (isinstance(value, str) and not value.strip()):
            return Decimal(0)
        return parse_number(value, 2, "Remise attendue en pourcentage, par exemple 10.")

    @field_validator("amount", mode="before")
    @classmethod
    def parse_amount(cls, value):
        return parse_number(value, 2, "Montant attendu au format 1234,56.").quantize(CENT)

    def expected_amount(self) -> Decimal:
        gross = self.quantity * self.unit_price * (1 - self.discount_percent / 100)
        return gross.quantize(CENT, rounding=ROUND_HALF_UP)


class Invoice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    invoice_number: Label
    supplier: Label
    invoice_date: date
    currency: str = Field(pattern=r"^EUR$")
    subtotal: Money
    vat_amount: Money
    total: Money
    lines: list[LineItem] = Field(default=[], max_length=500)

    @field_validator("invoice_date", mode="before")
    @classmethod
    def parse_date(cls, value):
        if isinstance(value, str) and re.fullmatch(r"\d{2}[/.-]\d{2}[/.-]\d{4}", value):
            return datetime.strptime(re.sub(r"[.-]", "/", value), "%d/%m/%Y").date()
        if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return date.fromisoformat(value)
        raise ValueError("Date attendue au format AAAA-MM-JJ ou JJ/MM/AAAA.")

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, value):
        if isinstance(value, str):
            return value.strip().upper().replace("€", "EUR")
        return value

    @field_validator("subtotal", "vat_amount", "total", mode="before")
    @classmethod
    def parse_amount(cls, value):
        return parse_number(value, 2, "Montant attendu au format 1234,56 ou 1234.56.").quantize(CENT)

    def inconsistencies(self) -> list[str]:
        notes = []
        for number, line in enumerate(self.lines, 1):
            expected = line.expected_amount()
            if abs(expected - line.amount) > CENT:
                notes.append(
                    f"Ligne {number} : quantité × prix unitaire donne {french(expected)}, "
                    f"le montant imprimé est {french(line.amount)}."
                )
        if self.lines:
            lines_total = sum((line.amount for line in self.lines), Decimal(0))
            if abs(lines_total - self.subtotal) > CENT:
                notes.append(
                    f"La somme des lignes ({french(lines_total)}) ne correspond pas "
                    f"au total HT ({french(self.subtotal)})."
                )
        if abs(self.subtotal + self.vat_amount - self.total) > CENT:
            notes.append("Le total HT et la TVA ne correspondent pas au total TTC.")
        return notes
