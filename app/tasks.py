import logging
import os
import subprocess
from time import time

from celery import Celery
from pydantic import ValidationError
from sqlalchemy import update

from .db import Document, Session
from .extraction import extract
from .invoice import LABELS, Invoice

logger = logging.getLogger(__name__)
celery = Celery("idp", broker=os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0"))
celery.conf.update(
    task_ignore_result=True,
    task_always_eager=os.getenv("CELERY_EAGER") == "1",
    task_publish_retry=False,
    broker_connection_timeout=3,
    broker_transport_options={"socket_connect_timeout": 3, "socket_timeout": 3, "max_retries": 0},
    task_acks_late=True,
    task_time_limit=240,
)
STALE_AFTER_SECONDS = 300


@celery.task
def process_document(document_id: str, attempt: str) -> None:
    started = time()
    with Session.begin() as db:
        claim = db.execute(
            update(Document)
            .where(Document.id == document_id, Document.attempt == attempt, Document.status == "queued")
            .values(status="processing", updated_at=int(started))
        )
        if claim.rowcount != 1:
            return
        document = db.get(Document, document_id)

    result = {"status": "review", "notes": []}
    try:
        candidate, sources, method, tokens = extract(document.path, document.media_type)
        fields = candidate.model_dump()
        try:
            result["notes"] = Invoice.model_validate(fields).inconsistencies()
        except ValidationError as exc:
            result["notes"] = [f"{LABELS[error['loc'][0]]} à vérifier." for error in exc.errors()]
        result.update(extraction={"fields": fields, "sources": sources}, method=method, model_tokens=tokens)
    except Exception as exc:
        logger.warning("Extraction %s en échec (%s)", document_id, type(exc).__name__)
        message = "Extraction impossible. Vérifiez le fichier et la configuration du worker."
        if isinstance(exc, subprocess.TimeoutExpired):
            message = "L’OCR a dépassé le délai par page."
        result = {"status": "failed", "notes": [message]}

    with Session.begin() as db:
        db.execute(
            update(Document)
            .where(Document.id == document_id, Document.attempt == attempt, Document.status == "processing")
            .values(**result, updated_at=int(time()), duration_ms=round((time() - started) * 1000))
        )


def enqueue(document_id: str, attempt: str) -> None:
    try:
        process_document.delay(document_id, attempt)
    except Exception as exc:
        logger.warning("Publication %s en échec (%s)", document_id, type(exc).__name__)
        with Session.begin() as db:
            db.execute(
                update(Document)
                .where(Document.id == document_id, Document.attempt == attempt, Document.status == "queued")
                .values(status="failed", notes=["La file de traitement est indisponible. Relancez le document."])
            )
