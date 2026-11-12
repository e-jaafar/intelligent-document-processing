import csv
import hashlib
import io
from contextlib import asynccontextmanager
from pathlib import Path
from time import time
from uuid import uuid4

import pypdfium2 as pdfium
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from .db import Base, Document, Session, engine
from .extraction import MAX_BYTES, inspect_upload, preview
from .invoice import LABELS, Invoice
from .tasks import STALE_AFTER_SECONDS, enqueue

STATIC = Path(__file__).with_name("static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
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


@app.get("/documents/{document_id}")
def detail(document_id: str):
    document = get_document(document_id)
    return {
        **document.detail(),
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


@app.post("/documents/{document_id}/approve")
def approve(document_id: str, review: Review):
    get_document(document_id)
    notes = review.invoice.inconsistencies()
    if notes:
        raise HTTPException(422, notes[0])
    with Session.begin() as db:
        result = db.execute(
            update(Document)
            .where(Document.id == document_id, Document.attempt == review.attempt, Document.status == "review")
            .values(approved=review.invoice.model_dump(mode="json"), status="approved", updated_at=int(time()))
        )
        if result.rowcount != 1:
            raise HTTPException(409, "La facture a changé. Rechargez-la avant de poursuivre.")
    return get_document(document_id).detail()


def csv_text(value: str) -> str:
    return "'" + value if value.lstrip().startswith(("=", "+", "-", "@")) else value


@app.get("/documents/{document_id}/export.csv")
def export(document_id: str):
    document = get_document(document_id)
    if document.status != "approved":
        raise HTTPException(409, "Validez la facture avant de l’exporter.")
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(LABELS.values())
    values = document.approved
    writer.writerow([
        csv_text(values[field]) if field in {"invoice_number", "supplier"} else values[field]
        for field in LABELS
    ])
    return Response(
        output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="invoice-{document.id}.csv"'},
    )
