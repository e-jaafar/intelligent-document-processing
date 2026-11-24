const $ = (id) => document.getElementById(id);
const statuses = {
  queued: "En file",
  processing: "En cours",
  review: "À vérifier",
  approved: "Validée",
  failed: "Échec",
};
const fields = {
  invoice_number: "Numéro de facture",
  supplier: "Fournisseur",
  invoice_date: "Date de facture",
  currency: "Devise",
  subtotal: "Total HT",
  vat_amount: "TVA",
  total: "Total TTC",
};

const lineFields = {
  description: "Description",
  quantity: "Quantité",
  unit_price: "Prix unitaire",
  discount_percent: "Remise (%)",
  amount: "Montant",
};

for (const [key, title] of Object.entries(fields)) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  const source = document.createElement("small");
  input.name = key;
  input.required = true;
  input.id = key;
  source.id = `${key}-source`;
  input.setAttribute("aria-describedby", source.id);
  label.append(title, input, source);
  $("fields").append(label);
}

let selected;
let current;
let page = 1;

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body.detail;
    if (Array.isArray(detail)) {
      throw new Error(detail.map((issue) => {
        const loc = issue.loc.slice(issue.loc.indexOf("invoice") + 1);
        const field = loc[0] === "lines" && loc.length > 2
          ? `Ligne ${loc[1] + 1} · ${lineFields[loc[2]] || loc[2]}`
          : fields[loc[0]] || "Facture";
        return `${field} — ${issue.msg.replace(/^Value error, /, "")}`;
      }).join(" "));
    }
    throw new Error(detail || "La requête a échoué.");
  }
  return response.json();
}

function showPage() {
  $("page").textContent = `Page ${page} / ${current.page_count}`;
  $("previous").disabled = page === 1;
  $("next").disabled = page === current.page_count;
  $("preview").src = `/documents/${current.id}/preview/${page}`;
}

function number(value) {
  const text = String(value ?? "").trim().replace(/[\s\u00a0\u202f€%]/g, "").replace("−", "-").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

function money(value) {
  return value.toLocaleString("fr-FR", {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

function checkLine(row) {
  const [quantity, unitPrice, discount, amount] = ["quantity", "unit_price", "discount_percent", "amount"]
    .map((key) => number(row.querySelector(`[name="${key}"]`).value));
  const computed = row.querySelector(".computed");
  if (quantity == null || unitPrice == null || amount == null) {
    computed.textContent = "—";
    row.dataset.mismatch = "false";
    return null;
  }
  const raw = quantity * unitPrice * (1 - (discount ?? 0) / 100);
  const expected = Math.sign(raw) * Math.round(Math.abs(raw) * 100 + 1e-7) / 100;
  computed.textContent = money(expected);
  row.dataset.mismatch = String(Math.abs(expected - amount) > 0.0100001);
  return amount;
}

function summarizeLines() {
  const rows = [...$("lines").rows];
  const amounts = rows.map(checkLine);
  const mismatches = rows.filter((row) => row.dataset.mismatch === "true").length;
  const sum = amounts.reduce((total, amount) => total + (amount ?? 0), 0);
  const parts = [`${rows.length} ligne${rows.length > 1 ? "s" : ""}`, `somme ${money(sum)}`];
  const subtotal = number($("subtotal").value);
  if (rows.length && subtotal != null && Math.abs(sum - subtotal) > 0.0100001) parts.push("différente du total HT");
  if (mismatches) parts.push(`${mismatches} écart${mismatches > 1 ? "s" : ""} quantité × prix`);
  $("lines-summary").textContent = rows.length ? parts.join(" · ") : "Aucune ligne extraite.";
}

function addLine(line = {}, source = null, readOnly = false) {
  const row = document.createElement("tr");
  const index = document.createElement("td");
  row.append(index);
  for (const key of Object.keys(lineFields)) {
    const cell = document.createElement("td");
    const input = document.createElement("input");
    input.name = key;
    input.value = line[key] ?? "";
    input.readOnly = readOnly;
    input.required = key !== "discount_percent";
    input.setAttribute("aria-label", lineFields[key]);
    input.oninput = summarizeLines;
    if (key !== "description") cell.className = "number";
    cell.append(input);
    row.append(cell);
  }
  const computed = document.createElement("td");
  computed.className = "number computed";
  const sourceCell = document.createElement("td");
  if (source) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = `p. ${source.page}`;
    button.title = source.text;
    button.setAttribute("aria-label", `Afficher la page ${source.page} : ${source.text}`);
    button.onclick = () => { page = source.page; showPage(); };
    sourceCell.append(button);
  }
  const actions = document.createElement("td");
  if (!readOnly) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Retirer";
    remove.onclick = () => { row.remove(); renumber(); summarizeLines(); };
    actions.append(remove);
  }
  row.append(computed, sourceCell, actions);
  $("lines").append(row);
  renumber();
}

function renumber() {
  [...$("lines").rows].forEach((row, index) => { row.cells[0].textContent = index + 1; });
}

function collectLines() {
  return [...$("lines").rows].map((row) => Object.fromEntries(
    Object.keys(lineFields).map((key) => [key, row.querySelector(`[name="${key}"]`).value]),
  ));
}

$("add-line").onclick = () => { addLine(); summarizeLines(); };
$("subtotal").addEventListener("input", summarizeLines);

$("previous").onclick = () => { page--; showPage(); };
$("next").onclick = () => { page++; showPage(); };

function display(doc) {
  const changed = doc.id !== current?.id || doc.status !== current?.status || doc.attempt !== current?.attempt;
  if (doc.id !== current?.id) page = 1;
  current = doc;
  $("empty").hidden = true;
  $("detail").hidden = false;
  $("filename").textContent = doc.filename;
  const stats = [statuses[doc.status], doc.method, doc.duration_ms == null ? "" : `${doc.duration_ms} ms`];
  if (doc.model_tokens != null) stats.push(`${doc.model_tokens} tokens`);
  $("status").textContent = stats.filter(Boolean).join(" · ");
  $("retry").hidden = !doc.can_retry && doc.status !== "failed";
  $("invoice").hidden = !["review", "approved"].includes(doc.status);
  $("approve").hidden = doc.status !== "review";
  $("export").hidden = doc.status !== "approved";
  $("export").href = `/documents/${doc.id}/export.csv`;
  $("export-lines").hidden = doc.status !== "approved" || !doc.approved?.lines?.length;
  $("export-lines").href = `/documents/${doc.id}/lines.csv`;
  $("lines-section").hidden = $("invoice").hidden;
  $("add-line").hidden = doc.status !== "review";
  if (!changed) return;
  $("notes").replaceChildren(...doc.notes.map((message) => {
    const li = document.createElement("li");
    li.textContent = message;
    return li;
  }));
  for (const key of Object.keys(fields)) {
    $(key).value = doc.approved?.[key] ?? doc.extraction?.fields[key] ?? "";
    $(key).readOnly = doc.status === "approved";
    const source = doc.extraction?.sources[key];
    $(`${key}-source`).textContent = source ? `Page ${source.page} · ${source.text}` : "";
  }
  $("lines").replaceChildren();
  const lines = doc.approved?.lines ?? doc.extraction?.fields.lines ?? [];
  const sources = doc.approved ? [] : doc.extraction?.sources.lines ?? [];
  lines.forEach((line, index) => addLine(line, sources[index], doc.status === "approved"));
  summarizeLines();
  showPage();
}

async function refresh() {
  const docs = await request("/documents");
  $("documents").replaceChildren(...docs.map((doc) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const status = document.createElement("small");
    button.type = "button";
    button.setAttribute("aria-current", String(selected === doc.id));
    status.textContent = statuses[doc.status];
    button.append(doc.filename, status);
    button.onclick = () => select(doc.id);
    item.append(button);
    return item;
  }));
  if (selected) {
    const id = selected;
    const doc = await request(`/documents/${id}`);
    if (selected === id) display(doc);
  }
}

function report(error) {
  $("notice").textContent = error.message;
}

async function select(id) {
  selected = id;
  $("notice").textContent = "";
  await refresh().catch(report);
}

$("upload").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("notice").textContent = "";
  try {
    const doc = await request("/documents", {method: "POST", body: new FormData(event.target)});
    event.target.reset();
    await select(doc.id);
    if (doc.duplicate) $("notice").textContent = "Ce fichier avait déjà été importé.";
  } catch (error) {
    report(error);
  } finally {
    button.disabled = false;
  }
};

$("invoice").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const doc = current;
  button.disabled = true;
  $("notice").textContent = "";
  try {
    await request(`/documents/${doc.id}/approve`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        attempt: doc.attempt,
        invoice: {...Object.fromEntries(new FormData(event.target)), lines: collectLines()},
      }),
    });
    await refresh();
  } catch (error) {
    report(error);
  } finally {
    button.disabled = false;
  }
};

$("retry").onclick = async () => {
  $("retry").disabled = true;
  $("notice").textContent = "";
  try {
    await request(`/documents/${current.id}/retry`, {method: "POST"});
    await refresh();
  } catch (error) {
    report(error);
  } finally {
    $("retry").disabled = false;
  }
};

refresh().catch(report);
setInterval(() => {
  if (current && ["queued", "processing"].includes(current.status)) refresh().catch(report);
}, 2000);
