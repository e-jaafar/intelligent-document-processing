import re
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Money = Annotated[Decimal, Field(ge=0, le=999999999.99, decimal_places=2)]

LABELS = {
    "invoice_number": "Numéro de facture",
    "supplier": "Fournisseur",
    "invoice_date": "Date de facture",
    "currency": "Devise",
    "subtotal": "Total HT",
    "vat_amount": "TVA",
    "total": "Total TTC",
}


class Candidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    invoice_number: str | None
    supplier: str | None
    invoice_date: str | None
    currency: str | None
    subtotal: str | None
    vat_amount: str | None
    total: str | None


class Invoice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    invoice_number: Label
    supplier: Label
    invoice_date: date
    currency: str = Field(pattern=r"^EUR$")
    subtotal: Money
    vat_amount: Money
    total: Money

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
        if not isinstance(value, str):
            raise ValueError("Saisissez le montant sous forme de texte.")
        value = re.sub(r"\s*(?:EUR|€)$", "", value.strip(), flags=re.I)
        if re.fullmatch(r"\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?", value):
            value = re.sub(r"\s", "", value)
        if not re.fullmatch(r"\d{1,9}(?:[.,]\d{1,2})?", value):
            raise ValueError("Montant attendu au format 1234,56 ou 1234.56.")
        return Decimal(value.replace(",", ".")).quantize(Decimal("0.01"))

    def inconsistencies(self) -> list[str]:
        if abs(self.subtotal + self.vat_amount - self.total) > Decimal("0.01"):
            return ["Le total HT et la TVA ne correspondent pas au total TTC."]
        return []
