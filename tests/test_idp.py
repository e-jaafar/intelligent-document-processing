import csv
import io
import os
from pathlib import Path
from time import monotonic, sleep

import httpx
import pytest
from fastapi.testclient import TestClient

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
LIVE_URL = os.getenv("IDP_TEST_URL")


@pytest.fixture(scope="session")
def client(tmp_path_factory):
    if LIVE_URL:
        with httpx.Client(base_url=LIVE_URL, timeout=15) as live:
            yield live
        return
    with pytest.MonkeyPatch.context() as env:
        env.setenv("DATA_DIR", str(tmp_path_factory.mktemp("documents")))
        env.delenv("DATABASE_URL", raising=False)
        env.setenv("CELERY_EAGER", "1")
        env.delenv("OPENAI_MODEL", raising=False)
        env.setenv("OCR_LANG", "eng")
        from app.main import app

        with TestClient(app) as local:
            yield local


def upload(client, filename):
    response = client.post("/documents", files={"file": (filename, (EXAMPLES / filename).read_bytes())})
    assert response.status_code == 202, response.text
    return response.json()


def extracted(client, filename):
    data = upload(client, filename)
    deadline = monotonic() + 25
    while data["status"] in {"queued", "processing"} and monotonic() < deadline:
        sleep(0.2)
        data = client.get(f"/documents/{data['id']}").json()
    assert data["status"] == "review", data
    return data


@pytest.mark.parametrize(("filename", "method", "number"), [
    ("facture-native.pdf", "pdf-texte", "DEMO-001"),
    ("facture-scanee.pdf", "ocr", "DEMO-002"),
    ("facture-scanee.png", "ocr", "DEMO-002"),
])
def test_import_review_export(client, filename, method, number):
    doc = extracted(client, filename)
    route = f"/documents/{doc['id']}"
    assert doc["method"] == method
    assert doc["notes"] == []
    fields = doc["extraction"]["fields"]
    assert fields == {
        "invoice_number": number, "supplier": "Atelier Exemple SRL", "invoice_date": "12/11/2026",
        "currency": "EUR", "subtotal": "1000,00", "vat_amount": "210,00", "total": "1210,00",
    }
    assert doc["extraction"]["sources"]["total"]["page"] == 1
    assert client.get(f"{route}/preview/1").content.startswith(b"\x89PNG")
    assert client.get(f"{route}/preview/2").status_code == 404
    assert client.get(f"{route}/export.csv").status_code == 409

    review = {"attempt": doc["attempt"], "invoice": fields}
    response = client.post(f"{route}/approve", json=review)
    assert response.status_code == 200, response.text
    assert client.post(f"{route}/approve", json=review).status_code == 409

    response = client.get(f"{route}/export.csv")
    assert response.status_code == 200
    header, row = csv.reader(io.StringIO(response.text))
    assert header == ["Numéro de facture", "Fournisseur", "Date de facture", "Devise", "Total HT", "TVA", "Total TTC"]
    assert row == [
        number, "Atelier Exemple SRL", "2026-11-12", "EUR", "1000.00", "210.00", "1210.00",
    ]
    assert client.get(f"{route}/export.csv").content == response.content
    duplicate = upload(client, filename)
    assert duplicate["duplicate"] and duplicate["id"] == doc["id"]


def test_inconsistent_total_requires_correction(client):
    doc = extracted(client, "facture-a-corriger.pdf")
    assert "total TTC" in doc["notes"][0]
    route = f"/documents/{doc['id']}"
    fields = doc["extraction"]["fields"]
    review = {"attempt": doc["attempt"], "invoice": fields}
    assert client.post(f"{route}/approve", json=review).status_code == 422
    fields["vat_amount"] = None
    assert client.post(f"{route}/approve", json=review).status_code == 422
    fields.update(vat_amount="210.00", total="1 210,00", supplier="=1+1")
    assert client.post(f"{route}/approve", json=review).status_code == 200
    assert "'=1+1" in client.get(f"{route}/export.csv").text


def test_reject_invalid_and_oversized_uploads(client):
    assert client.post("/documents", files={"file": ("fake.pdf", b"not a pdf")}).status_code == 422
    assert client.post("/documents", files={"file": ("large.png", b"0" * (10 * 1024**2 + 1))}).status_code == 413


def test_home(client):
    assert "Importer une facture" in client.get("/").text
    assert client.get("/static/app.js").status_code == 200


@pytest.mark.skipif(bool(LIVE_URL), reason="Injecte un échec OCR dans le processus de test")
def test_failed_processing_can_retry(client, monkeypatch):
    from PIL import Image

    from app import tasks

    content = io.BytesIO()
    Image.new("RGB", (20, 20), "white").save(content, "PNG")

    def broken_extractor(*args):
        raise RuntimeError("Erreur simulée")

    with monkeypatch.context() as patch:
        patch.setattr(tasks, "extract", broken_extractor)
        response = client.post("/documents", files={"file": ("test.png", content.getvalue())})
    doc = response.json()
    assert doc["status"] == "failed"
    response = client.post(f"/documents/{doc['id']}/retry")
    assert response.status_code == 202
    new_doc = response.json()
    assert new_doc["attempt"] != doc["attempt"]
    assert new_doc["status"] == "review"
    assert new_doc["notes"]
    tasks.process_document(doc["id"], doc["attempt"])
    assert client.get(f"/documents/{doc['id']}").json()["attempt"] == new_doc["attempt"]
