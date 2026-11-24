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
  input.addEventListener("focus", () => showSource(current?.extraction?.sources?.[key], title));
  label.append(title, input, source);
  $("fields").append(label);
}

let selected;
let current;
let page = 1;
let highlighted = null;
// Active review time per document, counted only while the page is visible.
const reviewTimes = new Map();
let timer = null;

function pauseTimer() {
  if (!timer) return;
  reviewTimes.set(timer.id, (reviewTimes.get(timer.id) ?? 0) + performance.now() - timer.since);
  timer = null;
}

function syncTimer() {
  const reviewing = current?.status === "review" && document.visibilityState === "visible";
  if (timer && (!reviewing || timer.id !== current.id)) pauseTimer();
  if (reviewing && !timer) timer = {id: current.id, since: performance.now()};
}

function reviewMs(id) {
  if (timer?.id === id) pauseTimer();
  const value = reviewTimes.get(id);
  syncTimer();
  return value == null ? null : Math.round(value);
}

document.addEventListener("visibilitychange", syncTimer);
const pageImages = new Map();

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

function pageUrl(number) {
  return `/documents/${current.id}/preview/${number}`;
}

function showPage() {
  $("page").textContent = `Page ${page} / ${current.page_count}`;
  $("previous").disabled = page === 1;
  $("next").disabled = page === current.page_count;
  if (!$("preview").src.endsWith(pageUrl(page))) $("preview").src = pageUrl(page);
  const box = highlighted?.page === page ? highlighted.box : null;
  $("highlight").hidden = !box;
  if (box) {
    const [left, top, right, bottom] = box;
    Object.assign($("highlight").style, {
      left: `${left * 100}%`, top: `${top * 100}%`,
      width: `${(right - left) * 100}%`, height: `${(bottom - top) * 100}%`,
    });
  }
}

function loadPage(url) {
  if (!pageImages.has(url)) {
    pageImages.set(url, new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    }));
  }
  return pageImages.get(url);
}

async function drawCrop(source, title) {
  const image = await loadPage(pageUrl(source.page));
  if (highlighted !== source) return;
  const [left, top, right, bottom] = source.box;
  const padX = 0.03, padY = Math.max((bottom - top) * 1.5, 0.01);
  const x0 = Math.max(left - padX, 0), y0 = Math.max(top - padY, 0);
  const x1 = Math.min(right + padX, 1), y1 = Math.min(bottom + padY, 1);
  const width = (x1 - x0) * image.naturalWidth, height = (y1 - y0) * image.naturalHeight;
  const canvas = $("crop");
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const context = canvas.getContext("2d");
  context.drawImage(image, x0 * image.naturalWidth, y0 * image.naturalHeight, width, height, 0, 0, width, height);
  context.strokeStyle = "#c2410c";
  context.lineWidth = Math.max(2, image.naturalWidth / 600);
  context.strokeRect((left - x0) * image.naturalWidth, (top - y0) * image.naturalHeight,
    (right - left) * image.naturalWidth, (bottom - top) * image.naturalHeight);
  $("crop-caption").textContent = `${title} · source page ${source.page} : ${source.text}`;
  $("crop-figure").hidden = false;
}

function showSource(source, title) {
  highlighted = source?.box ? source : null;
  $("crop-figure").hidden = true;
  if (!source) {
    showPage();
    return;
  }
  page = source.page;
  showPage();
  if (highlighted) drawCrop(source, title).catch(() => { $("crop-figure").hidden = true; });
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
    input.addEventListener("focus", () => {
      showSource(source, `Ligne ${row.rowIndex}`);
    });
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
    button.onclick = () => showSource(source, `Ligne ${row.rowIndex}`);
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

$("crop-close").onclick = () => { $("crop-figure").hidden = true; };
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("crop-figure").hidden = true;
});

$("add-line").onclick = () => { addLine(); summarizeLines(); };
$("subtotal").addEventListener("input", summarizeLines);

$("previous").onclick = () => { page--; showPage(); };
$("next").onclick = () => { page++; showPage(); };

function display(doc) {
  const changed = doc.id !== current?.id || doc.status !== current?.status || doc.attempt !== current?.attempt;
  if (doc.id !== current?.id) {
    page = 1;
    highlighted = null;
    pageImages.clear();
    $("crop-figure").hidden = true;
  }
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
  $("accept-label").hidden = doc.status !== "review";
  const accepted = doc.approved?.discrepancies?.length;
  if (accepted) $("status").textContent += ` · ${accepted} écart${accepted > 1 ? "s" : ""} accepté${accepted > 1 ? "s" : ""}`;
  $("duplicates").hidden = !doc.duplicates?.length;
  $("duplicate-list").replaceChildren(...(doc.duplicates ?? []).map((other) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${other.filename} (${statuses[other.status]})`;
    button.onclick = () => select(other.id);
    item.append(button);
    return item;
  }));
  syncTimer();
  $("export").hidden = doc.status !== "approved";
  $("export").href = `/documents/${doc.id}/export.csv`;
  $("export-lines").hidden = doc.status !== "approved" || !doc.approved?.lines?.length;
  $("export-lines").href = `/documents/${doc.id}/lines.csv`;
  $("lines-section").hidden = $("invoice").hidden;
  $("add-line").hidden = doc.status !== "review";
  if (!changed) return;
  $("accept").checked = false;
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

function percent(value) {
  return value == null ? "—" : `${Math.round(value * 1000) / 10} %`;
}

function seconds(value) {
  if (value == null) return "—";
  const format = (number) => number.toLocaleString("fr-FR", {maximumFractionDigits: 1});
  return value < 90 ? `${format(value)} s` : `${format(value / 60)} min`;
}

function definitions(target, entries) {
  $(target).replaceChildren(...entries.flatMap(([term, value]) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    return [dt, dd];
  }));
}

let lastMetrics;

function showGain() {
  const baseline = number($("baseline").value);
  localStorage.setItem("idp-baseline-minutes", $("baseline").value);
  const median = lastMetrics?.review_seconds.median;
  if (!baseline || median == null) {
    $("gain").textContent = "";
    return;
  }
  const change = Math.round((1 - median / (baseline * 60)) * 100);
  $("gain").textContent = change >= 0
    ? `Relecture médiane ${change} % plus courte que le processus actuel.`
    : `Relecture médiane ${-change} % plus longue que le processus actuel.`;
}

$("baseline").value = localStorage.getItem("idp-baseline-minutes") ?? "";
$("baseline").oninput = showGain;

async function refreshMetrics() {
  const metrics = await request("/metrics");
  lastMetrics = metrics;
  definitions("metrics", [
    ["Factures validées", metrics.approved],
    ["Relecture médiane", seconds(metrics.review_seconds.median)],
    ["Relecture moyenne", seconds(metrics.review_seconds.mean)],
    ["Champs justes", percent(metrics.fields_accuracy)],
    ["Lignes justes", percent(metrics.line_accuracy)],
    ["Sans correction", percent(metrics.approved_without_correction)],
    ["Écarts acceptés", metrics.accepted_discrepancies],
  ]);
  definitions("field-accuracy", Object.entries(metrics.field_accuracy).map(([key, value]) => [fields[key], percent(value)]));
  showGain();
}

async function refresh() {
  const docs = await request("/documents");
  refreshMetrics().catch(report);
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
        invoice: {
          ...Object.fromEntries(Object.keys(fields).map((key) => [key, $(key).value])),
          lines: collectLines(),
        },
        accept_discrepancies: $("accept").checked,
        review_ms: reviewMs(doc.id),
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
