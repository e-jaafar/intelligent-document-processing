import csv
import hashlib
import io
from contextlib import asynccontextmanager
from pathlib import Path
from statistics import mean, median
from time import time
from uuid import uuid4

import pypdfium2 as pdfium
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError

from .db import Document, Session, ensure_schema
from .extraction import MAX_BYTES, inspect_upload, preview
from .invoice import LABELS, LINE_LABELS, Invoice, LineItem
from .tasks import STALE_AFTER_SECONDS, enqueue

STATIC = Path(__file__).with_name("static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_schema()
    yield


app = FastAPI(title="Factures · IDP", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def restrict_upload(request: Request, call_next):
    if request.method == "POST" and request.url.path == "/documents":
        length = request.headers.get("content-length", "")
        if not length.isdecimal() or len(length) > 10:
            return JSONResponse({"detail": "Taille de la requête requise."}, 411)
        if int(length) > MAX_BYTES + 65536:
            return JSONResponse({"detail": "Le fichier dépasse 10 Mio."}, 413)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/", include_in_schema=False)
def home():
    return FileResponse(STATIC / "index.html")


def get_document(document_id: str) -> Document:
    with Session() as db:
        document = db.get(Document, document_id)
        if document is None:
            raise HTTPException(404, "Document introuvable.")
        return document


@app.post("/documents", status_code=202)
def upload(file: UploadFile):
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Le fichier dépasse 10 Mio.")
    sha256 = hashlib.sha256(data).hexdigest()
    with Session() as db:
        if existing := db.scalar(select(Document).where(Document.sha256 == sha256)):
            return {**existing.detail(), "duplicate": True}
        try:
            media_type, pages = inspect_upload(data)
        except (OSError, ValueError, pdfium.PdfiumError, Image.DecompressionBombError) as exc:
            detail = str(exc) if isinstance(exc, ValueError) else "Utilisez un PDF lisible, un JPEG ou un PNG."
            raise HTTPException(422, detail) from exc
        name = Path((file.filename or "document").replace("\\", "/")).name[:255] or "document"
        document = Document(
            id=uuid4().hex, sha256=sha256, filename=name, media_type=media_type,
            page_count=pages, updated_at=int(time()),
        )
        document.path.write_bytes(data)
        db.add(document)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            document.path.unlink()
            if existing := db.scalar(select(Document).where(Document.sha256 == sha256)):
                return {**existing.detail(), "duplicate": True}
            raise
    enqueue(document.id, document.attempt)
    return {**get_document(document.id).detail(), "duplicate": False}


@app.get("/documents")
def documents():
    with Session() as db:
        return [
            document.summary()
            for document in db.scalars(select(Document).order_by(Document.updated_at.desc()).limit(100))
        ]


def duplicates(document: Document) -> list[dict]:
    """Other documents for the same supplier and invoice number, such as a second scan."""
    keys = {key for key in (document.invoice_key, document.approved_key) if key}
    if not keys:
        return []
    with Session() as db:
        others = db.scalars(
            select(Document)
            .where(Document.id != document.id, or_(Document.invoice_key.in_(keys), Document.approved_key.in_(keys)))
            .order_by(Document.updated_at.desc())
            .limit(10)
        )
        return [other.summary() for other in others]


@app.get("/documents/{document_id}")
def detail(document_id: str):
    document = get_document(document_id)
    return {
        **document.detail(),
        "duplicates": duplicates(document),
        "can_retry": document.status == "failed" or (
            document.status in {"queued", "processing"}
            and document.updated_at <= int(time()) - STALE_AFTER_SECONDS
        ),
    }


@app.get("/documents/{document_id}/preview/{page}")
def document_preview(document_id: str, page: int):
    document = get_document(document_id)
    if not 1 <= page <= document.page_count:
        raise HTTPException(404, "Page introuvable.")
    try:
        png = preview(document.path, document.media_type, page)
    except (OSError, ValueError, pdfium.PdfiumError) as exc:
        raise HTTPException(422, "Impossible d’afficher cette page.") from exc
    return Response(png, media_type="image/png")


@app.post("/documents/{document_id}/retry", status_code=202)
def retry(document_id: str):
    document = get_document(document_id)
    with Session.begin() as db:
        result = db.execute(
            update(Document)
            .where(
                Document.id == document_id,
                Document.attempt == document.attempt,
                (Document.status == "failed") | (
                    Document.status.in_(["queued", "processing"])
                    & (Document.updated_at <= int(time()) - STALE_AFTER_SECONDS)
                ),
            )
            .values(status="queued", attempt=uuid4().hex, notes=[], updated_at=int(time()))
            .returning(Document.attempt)
        )
        attempt = result.scalar_one_or_none()
        if attempt is None:
            raise HTTPException(409, "Le document ne peut pas être relancé actuellement.")
    enqueue(document_id, attempt)
    return get_document(document_id).detail()


class Review(BaseModel):
    attempt: str
    invoice: Invoice
    # The bookkeeper confirms that the differences are printed on the original invoice.
    accept_discrepancies: bool = False
    review_ms: int | None = Field(default=None, ge=0, le=86_400_000)


def already_approved(key: str | None, document_id: str) -> Document | None:
    if key is None:
        return None
    with Session() as db:
        return db.scalar(select(Document).where(Document.approved_key == key, Document.id != document_id))


@app.post("/documents/{document_id}/approve")
def approve(document_id: str, review: Review):
    document = get_document(document_id)
    invoice = review.invoice
    notes = invoice.inconsistencies()
    if notes and not review.accept_discrepancies:
        raise HTTPException(422, " ".join(notes))
    duplicate_message = "Cette facture du même fournisseur a déjà été validée : {}."
    if other := already_approved(invoice.key, document_id):
        raise HTTPException(409, duplicate_message.format(other.filename))
    extracted = (document.extraction or {}).get("fields", {})
    try:
        with Session.begin() as db:
            result = db.execute(
                update(Document)
                .where(Document.id == document_id, Document.attempt == review.attempt, Document.status == "review")
                .values(
                    approved={**invoice.model_dump(mode="json"), "discrepancies": notes},
                    status="approved", approved_key=invoice.key, invoice_key=invoice.key,
                    review_ms=review.review_ms, corrections=invoice.corrections(extracted),
                    updated_at=int(time()),
                )
            )
            if result.rowcount != 1:
                raise HTTPException(409, "La facture a changé. Rechargez-la avant de poursuivre.")
    except IntegrityError as exc:
        other = already_approved(invoice.key, document_id)
        raise HTTPException(409, duplicate_message.format(other.filename if other else "autre document")) from exc
    return get_document(document_id).detail()


def csv_text(value: str) -> str:
    return "'" + value if value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else value


def approved_document(document_id: str) -> Document:
    document = get_document(document_id)
    if document.status != "approved":
        raise HTTPException(409, "Validez la facture avant de l’exporter.")
    return document


def csv_response(rows: list[list], filename: str) -> Response:
    output = io.StringIO(newline="")
    csv.writer(output).writerows(rows)
    return Response(
        output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/documents/{document_id}/export.csv")
def export(document_id: str):
    document = approved_document(document_id)
    values = document.approved
    return csv_response([
        [*LABELS.values(), "Écarts acceptés"],
        [
            *(csv_text(values[field]) if field in {"invoice_number", "supplier"} else values[field] for field in LABELS),
            csv_text(" ".join(values.get("discrepancies", []))),
        ],
    ], f"invoice-{document.id}.csv")


@app.get("/documents/{document_id}/lines.csv")
def export_lines(document_id: str):
    document = approved_document(document_id)
    values = document.approved
    rows = [[LABELS["invoice_number"], "Ligne", *LINE_LABELS.values(), "Montant calculé"]]
    for number, line in enumerate(values.get("lines", []), 1):
        rows.append([
            csv_text(values["invoice_number"]), number, csv_text(line["description"]),
            line["quantity"], line["unit_price"], line["discount_percent"], line["amount"],
            f"{LineItem.model_validate(line).expected_amount():.2f}",
        ])
    return csv_response(rows, f"invoice-{document.id}-lines.csv")


def approved_documents() -> list[Document]:
    with Session() as db:
        return list(db.scalars(
            select(Document).where(Document.status == "approved").order_by(Document.updated_at)
        ))


@app.get("/metrics")
def metrics():
    """Review time and extraction accuracy, measured on approved invoices."""
    documents = [document for document in approved_documents() if document.corrections]
    review = [document.review_ms for document in documents if document.review_ms is not None]
    extraction = [document.duration_ms for document in documents if document.duration_ms is not None]
    fields = {
        field: sum(field not in document.corrections["fields"] for document in documents)
        for field in LABELS
    }
    lines = [document.corrections["lines"] for document in documents]
    approved_lines = sum(line["approved"] for line in lines)
    untouched = [
        document for document in documents
        if not document.corrections["fields"]
        and document.corrections["lines"]["unchanged"]
        == document.corrections["lines"]["approved"] == document.corrections["lines"]["extracted"]
    ]
    ratio = (lambda part, whole: round(part / whole, 4) if whole else None)
    return {
        "approved": len(documents),
        "review_seconds": {
            "count": len(review),
            "median": round(median(review) / 1000, 1) if review else None,
            "mean": round(mean(review) / 1000, 1) if review else None,
            "total": round(sum(review) / 1000, 1),
        },
        "extraction_ms_median": round(median(extraction)) if extraction else None,
        "field_accuracy": {field: ratio(correct, len(documents)) for field, correct in fields.items()},
        "fields_accuracy": ratio(sum(fields.values()), len(documents) * len(LABELS)),
        "line_accuracy": ratio(sum(line["unchanged"] for line in lines), approved_lines),
        "lines": {
            "extracted": sum(line["extracted"] for line in lines),
            "approved": approved_lines,
            "unchanged": sum(line["unchanged"] for line in lines),
        },
        "approved_without_correction": ratio(len(untouched), len(documents)),
        "accepted_discrepancies": sum(bool(document.approved.get("discrepancies")) for document in documents),
    }


@app.get("/metrics.csv")
def metrics_csv():
    rows = [[
        "Fichier", "Numéro de facture", "Méthode", "Extraction (ms)", "Relecture (s)", "Champs corrigés",
        "Lignes extraites", "Lignes validées", "Lignes inchangées", "Écarts acceptés",
    ]]
    for document in approved_documents():
        corrections = document.corrections or {"fields": [], "lines": {}}
        rows.append([
            csv_text(document.filename), csv_text(document.approved["invoice_number"]), document.method,
            document.duration_ms, "" if document.review_ms is None else round(document.review_ms / 1000, 1),
            " ".join(LABELS[field] for field in corrections["fields"]),
            *(corrections["lines"].get(key, "") for key in ("extracted", "approved", "unchanged")),
            len(document.approved.get("discrepancies", [])),
        ])
    return csv_response(rows, "review-metrics.csv")
