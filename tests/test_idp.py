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
        "currency": "EUR", "subtotal": "1000,00", "vat_amount": "210,00", "total": "1210,00", "lines": [],
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


def approve(client, doc, invoice):
    return client.post(f"/documents/{doc['id']}/approve", json={"attempt": doc["attempt"], "invoice": invoice})


def csv_rows(client, doc, name):
    response = client.get(f"/documents/{doc['id']}/{name}")
    assert response.status_code == 200, response.text
    return list(csv.reader(io.StringIO(response.text)))


def test_line_table_across_pages(client):
    doc = extracted(client, "facture-lignes-2-pages.pdf")
    assert doc["notes"] == []
    fields = doc["extraction"]["fields"]
    lines, sources = fields["lines"], doc["extraction"]["sources"]["lines"]
    assert len(lines) == 46
    assert not any(line["description"].lower().startswith(("report", "a reporter")) for line in lines)
    assert lines[3] == {
        "description": "Cheville nylon 8 mm - lot 4", "quantity": "26", "unit_price": "0,09",
        "discount_percent": "10", "amount": "2,11",
    }
    assert sources[33]["page"] == 1 and sources[34]["page"] == 2
    assert lines[34]["description"] == "Equerre acier 60 mm - lot 35"
    assert fields["subtotal"] == "4 572,86"

    assert approve(client, doc, fields).status_code == 200
    rows = csv_rows(client, doc, "lines.csv")
    assert rows[0] == ["Numéro de facture", "Ligne", "Description", "Quantité", "Prix unitaire", "Remise (%)", "Montant"]
    assert len(rows) == 47
    assert rows[4] == ["DEMO-004", "4", "Cheville nylon 8 mm - lot 4", "26", "0.09", "10", "2.11"]
    assert csv_rows(client, doc, "export.csv")[1][4:] == ["4572.86", "960.30", "5533.16"]


def test_line_amount_mismatch_is_flagged(client):
    doc = extracted(client, "facture-ecart-ligne.pdf")
    assert doc["notes"] == ["Ligne 1 : quantité × prix unitaire donne 50,40, le montant imprimé est 54,40."]
    fields = doc["extraction"]["fields"]
    response = approve(client, doc, fields)
    assert response.status_code == 422 and "Ligne 1" in response.text

    fields["lines"][0]["amount"] = "50,40"
    response = approve(client, doc, fields)
    assert response.status_code == 422 and "somme des lignes (138,09)" in response.text

    fields.update(subtotal="138,09", vat_amount="29,00", total="167,09")
    fields["lines"][1]["quantity"] = "huit"
    response = approve(client, doc, fields)
    assert response.status_code == 422 and "quantity" in response.text
    fields["lines"][1]["quantity"] = "8"
    assert approve(client, doc, fields).status_code == 200
    assert csv_rows(client, doc, "lines.csv")[1][-1] == "50.40"


def test_credit_note_keeps_negative_amounts(client):
    doc = extracted(client, "avoir.pdf")
    assert doc["notes"] == []
    fields = doc["extraction"]["fields"]
    assert fields["invoice_number"] == "AV-001"
    assert [line["quantity"] for line in fields["lines"]] == ["-100", "-2"]
    assert approve(client, doc, fields).status_code == 200
    assert csv_rows(client, doc, "export.csv")[1] == [
        "AV-001", "Atelier Exemple SRL", "2026-11-20", "EUR", "-43.40", "-9.11", "-52.51",
    ]
    assert [row[-1] for row in csv_rows(client, doc, "lines.csv")[1:]] == ["-35.00", "-8.40"]


def test_line_errors_name_the_line(client):
    from pydantic import ValidationError

    from app.invoice import Invoice, field_label

    try:
        Invoice.model_validate({
            "invoice_number": "X", "supplier": "Y", "invoice_date": "2026-11-20", "currency": "EUR",
            "subtotal": "1", "vat_amount": "0", "total": "1",
            "lines": [{"description": "Z", "quantity": "1", "unit_price": "x", "amount": "1"}],
        })
    except ValidationError as exc:
        assert field_label(exc.errors()[0]["loc"]) == "Ligne 1 · Prix unitaire"
    else:
        raise AssertionError("ValidationError attendue")


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
