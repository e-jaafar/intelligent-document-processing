from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent


def lines(number, total):
    return [
        "FACTURE FOURNISSEUR",
        f"Numero de facture : {number}",
        "Fournisseur : Atelier Exemple SRL",
        "Date de facture : 12/11/2026",
        "Devise : EUR",
        "Total HT : 1000,00",
        "Montant de TVA : 210,00",
        f"Total TTC : {total}",
    ]


def make_pdf(name, number, total):
    pdf = canvas.Canvas(str(HERE / name), invariant=1)
    pdf.setFont("Helvetica", 18)
    for index, line in enumerate(lines(number, total)):
        pdf.drawString(55, 760 - index * 39, line)
    pdf.save()


if __name__ == "__main__":
    make_pdf("facture-native.pdf", "DEMO-001", "1210,00")
    make_pdf("facture-a-corriger.pdf", "DEMO-003", "1200,00")
    scan = Image.new("RGB", (1300, 850), "white")
    draw = ImageDraw.Draw(scan)
    font = ImageFont.load_default(size=42)
    for index, line in enumerate(lines("DEMO-002", "1210,00")):
        draw.text((75, 65 + index * 85), line, fill="black", font=font)
    scan.save(HERE / "facture-scanee.png")
    scan.save(HERE / "facture-scanee.pdf", resolution=150, title="Facture scannee synthetique",
              creationDate="D:20261112000000Z", modDate="D:20261112000000Z")
