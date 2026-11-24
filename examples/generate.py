from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent
CENT = Decimal("0.01")
SUPPLIER = "Atelier Exemple SRL"


def lines(number, total):
    return [
        "FACTURE FOURNISSEUR",
        f"Numero de facture : {number}",
        f"Fournisseur : {SUPPLIER}",
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


def money(value: Decimal) -> str:
    sign = "-" if value < 0 else ""
    whole, cents = f"{abs(value):.2f}".split(".")
    return f"{sign}{int(whole):,}".replace(",", " ") + "," + cents


def qty(value: Decimal) -> str:
    return f"{value:f}".replace(".", ",")


def line_amount(quantity, unit_price, discount):
    return (quantity * unit_price * (1 - discount / 100)).quantize(CENT, rounding=ROUND_HALF_UP)


# Columns of the supplier's line table, in points from the left edge.
COLUMNS = {"description": 55, "quantity": 330, "unit_price": 400, "discount": 470, "amount": 545}


def draw_header(pdf, title, number_label, number, date, page, pages):
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawString(55, 790, title)
    pdf.setFont("Helvetica", 11)
    pdf.drawRightString(545, 790, f"Page {page} / {pages}")
    if page == 1:
        for index, text in enumerate([
            f"{number_label} : {number}",
            f"Fournisseur : {SUPPLIER}",
            f"Date de facture : {date}",
            "Devise : EUR",
        ]):
            pdf.drawString(55, 760 - index * 17, text)
        return 670
    pdf.drawString(55, 760, f"{number_label} : {number} (suite)")
    return 730


def draw_table_header(pdf, y):
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(COLUMNS["description"], y, "Description")
    pdf.drawRightString(COLUMNS["quantity"], y, "Qte")
    pdf.drawRightString(COLUMNS["unit_price"], y, "Prix unitaire")
    pdf.drawRightString(COLUMNS["discount"], y, "Remise")
    pdf.drawRightString(COLUMNS["amount"], y, "Montant HT")
    pdf.line(55, y - 4, 545, y - 4)
    pdf.setFont("Helvetica", 10)
    return y - 18


def make_line_invoice(name, title, number_label, number, items, rows_per_page=34, printed=None):
    """Draw a supplier invoice whose line table may continue on following pages.

    `printed` overrides the amount printed on some lines, to reproduce supplier errors.
    """
    printed = printed or {}
    amounts = [printed.get(i, line_amount(q, u, d)) for i, (_, q, u, d) in enumerate(items)]
    subtotal = sum(amounts, Decimal(0))
    vat = (subtotal * Decimal("0.21")).quantize(CENT, rounding=ROUND_HALF_UP)
    chunks = [list(range(i, min(i + rows_per_page, len(items)))) for i in range(0, len(items), rows_per_page)]
    pdf = canvas.Canvas(str(HERE / name), invariant=1)
    carried = Decimal(0)
    for page, chunk in enumerate(chunks, 1):
        y = draw_header(pdf, title, number_label, number, "20/11/2026", page, len(chunks))
        y = draw_table_header(pdf, y)
        if page > 1:
            pdf.drawString(COLUMNS["description"], y, "Report")
            pdf.drawRightString(COLUMNS["amount"], y, money(carried))
            y -= 16
        for index in chunk:
            description, quantity, unit_price, discount = items[index]
            pdf.drawString(COLUMNS["description"], y, description)
            pdf.drawRightString(COLUMNS["quantity"], y, qty(quantity))
            pdf.drawRightString(COLUMNS["unit_price"], y, money(unit_price))
            pdf.drawRightString(COLUMNS["discount"], y, f"{qty(discount)} %" if discount else "")
            pdf.drawRightString(COLUMNS["amount"], y, money(amounts[index]))
            carried += amounts[index]
            y -= 16
        if page < len(chunks):
            pdf.line(55, y + 10, 545, y + 10)
            pdf.drawString(COLUMNS["description"], y - 4, "A reporter")
            pdf.drawRightString(COLUMNS["amount"], y - 4, money(carried))
            pdf.showPage()
            continue
        pdf.line(55, y + 10, 545, y + 10)
        pdf.setFont("Helvetica", 11)
        for offset, text in enumerate([
            f"Total HT : {money(subtotal)}",
            f"Montant de TVA : {money(vat)}",
            f"Total TTC : {money(subtotal + vat)}",
        ]):
            pdf.drawString(330, y - 16 - offset * 17, text)
        pdf.showPage()
    pdf.save()


def catalogue():
    products = [
        ("Vis inox M6 x 20", "0.35"), ("Ecrou inox M6", "0.12"), ("Rondelle plate M6", "0.05"),
        ("Cheville nylon 8 mm", "0.09"), ("Equerre acier 60 mm", "1.85"), ("Charniere laiton", "4.20"),
        ("Joint silicone 310 ml", "6.90"), ("Colle bois 750 g", "11.40"), ("Foret beton 8 mm", "3.75"),
        ("Disque a tronconner 125", "2.60"),
    ]
    items = []
    for index in range(46):
        description, price = products[index % len(products)]
        quantity = Decimal(5 + (index * 7) % 60)
        discount = Decimal(10) if index in {3, 27} else Decimal(0)
        items.append((f"{description} - lot {index + 1}", quantity, Decimal(price), discount))
    return items


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

    # Table that crosses two pages, with two discounted lines.
    make_line_invoice("facture-lignes-2-pages.pdf", "FACTURE", "Numero de facture", "DEMO-004", catalogue())
    # One line where the printed amount does not match quantity x unit price.
    make_line_invoice("facture-ecart-ligne.pdf", "FACTURE", "Numero de facture", "DEMO-005", [
        ("Charniere laiton", Decimal(12), Decimal("4.20"), Decimal(0)),
        ("Joint silicone 310 ml", Decimal(8), Decimal("6.90"), Decimal(0)),
        ("Colle bois 750 g", Decimal(3), Decimal("11.40"), Decimal(5)),
    ], printed={0: Decimal("54.40")})
    # Credit note for returned goods: quantities and amounts are negative.
    make_line_invoice("avoir.pdf", "AVOIR", "Numero d'avoir", "AV-001", [
        ("Retour vis inox M6 x 20", Decimal(-100), Decimal("0.35"), Decimal(0)),
        ("Retour charniere laiton", Decimal(-2), Decimal("4.20"), Decimal(0)),
    ])
