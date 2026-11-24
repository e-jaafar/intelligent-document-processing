const $ = (id) => document.getElementById(id);
const statuses = {
  queued: "En file",
  processing: "Lecture en cours",
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
const identityFields = ["supplier", "invoice_number", "invoice_date", "currency"];
const lineFields = {
  description: "Description",
  quantity: "Quantité",
  unit_price: "Prix unitaire",
  discount_percent: "Remise (%)",
  amount: "Montant",
};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$("shortcut").textContent = isMac ? "⌘ ↵" : "Ctrl ↵";

let selected;
let current;
let view = "documents";
let page = 1;
let highlighted = null;
let lastMetrics;
const pageImages = new Map();

/* Header fields */

for (const key of [...identityFields, "subtotal", "vat_amount", "total"]) {
  const title = fields[key];
  const wrapper = document.createElement("div");
  const head = document.createElement("div");
  const label = document.createElement("label");
  const input = document.createElement("input");
  const source = document.createElement("button");
  wrapper.className = key === "supplier" ? "field field-wide" : "field";
  head.className = "field-head";
  label.className = "field-label";
  label.htmlFor = key;
  label.textContent = title;
  input.id = key;
  input.name = key;
  input.autocomplete = "off";
  input.spellcheck = false;
  if (["subtotal", "vat_amount", "total"].includes(key)) input.inputMode = "decimal";
  source.type = "button";
  source.className = "source";
  source.id = `${key}-source`;
  source.hidden = true;
  source.onclick = () => showSource(current?.extraction?.sources?.[key], title, source);
  input.addEventListener("focus", () => showSource(current?.extraction?.sources?.[key], title, input));
  input.addEventListener("input", updateChecks);
  head.append(label, source);
  wrapper.append(head, input);
  $(identityFields.includes(key) ? "fields-identity" : "fields-amounts").append(wrapper);
}

/* Review timer: active time per document, counted only while the page is visible. */

const reviewTimes = new Map();
let timer = null;

function pauseTimer() {
  if (!timer) return;
  reviewTimes.set(timer.id, (reviewTimes.get(timer.id) ?? 0) + performance.now() - timer.since);
  timer = null;
}

function syncTimer() {
  const reviewing = view === "documents" && current?.status === "review" && document.visibilityState === "visible";
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

/* Requests and messages */

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
        return `${field} : ${issue.msg.replace(/^Value error, /, "")}`;
      }).join(" "));
    }
    throw new Error(detail || "La requête a échoué. Vérifiez que le serveur est démarré.");
  }
  return response.json();
}

function notify(message, kind = "error") {
  $("notice").textContent = message;
  $("notice").className = kind === "info" ? "info" : "";
}

function report(error) {
  notify(error.message);
}

/* Numbers */

function number(value) {
  const text = String(value ?? "").trim().replace(/[\s  €%]/g, "").replace("−", "-").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

function money(value) {
  return value.toLocaleString("fr-FR", {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

// Approved values are stored normalized (2026-11-20, 142.09); show them as a French bookkeeper writes them.
function frenchValue(key, value) {
  if (value == null) return "";
  if (key === "invoice_date") return String(value).replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3/$2/$1");
  if (["subtotal", "vat_amount", "total", "amount"].includes(key)) return money(Number(value));
  if (["quantity", "unit_price", "discount_percent"].includes(key)) {
    return key === "discount_percent" && Number(value) === 0 ? "" : String(value).replace(".", ",");
  }
  return String(value);
}

function differs(a, b) {
  return Math.abs(a - b) > 0.0100001;
}

/* Page preview and source zones */

function pageUrl(number) {
  return `/documents/${current.id}/preview/${number}`;
}

function showPage() {
  $("page").textContent = `Page ${page} sur ${current.page_count}`;
  $("previous").disabled = page === 1;
  $("next").disabled = page === current.page_count;
  if (!$("preview").src.endsWith(pageUrl(page))) {
    $("preview").dataset.loading = "";
    $("preview").src = pageUrl(page);
  }
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
  const padX = 0.02, padY = Math.max((bottom - top) * 2.2, 0.015);
  const x0 = Math.max(left - padX, 0), y0 = Math.max(top - padY, 0);
  const x1 = Math.min(right + padX, 1), y1 = Math.min(bottom + padY, 1);
  const width = (x1 - x0) * image.naturalWidth, height = (y1 - y0) * image.naturalHeight;
  const canvas = $("crop");
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const context = canvas.getContext("2d");
  context.drawImage(image, x0 * image.naturalWidth, y0 * image.naturalHeight, width, height, 0, 0, width, height);
  context.strokeStyle = "#9a4310";
  context.lineWidth = Math.max(2, image.naturalWidth / 700);
  context.strokeRect((left - x0) * image.naturalWidth, (top - y0) * image.naturalHeight,
    (right - left) * image.naturalWidth, (bottom - top) * image.naturalHeight);
  $("crop-caption").textContent = `${title} · page ${source.page} · « ${source.text} »`;
  $("crop-figure").hidden = false;
}

function closeCrop() {
  $("crop-figure").hidden = true;
  highlighted = null;
  document.querySelectorAll(".source[aria-pressed='true']").forEach((button) => button.setAttribute("aria-pressed", "false"));
  if (current) showPage();
}

function placeCrop(anchor) {
  const rect = anchor?.getBoundingClientRect();
  const below = !rect || rect.top + rect.height / 2 < innerHeight / 2;
  $("crop-figure").dataset.place = below ? "bottom" : "top";
}

function showSource(source, title, anchor) {
  placeCrop(anchor);
  document.querySelectorAll(".source[aria-pressed='true']").forEach((button) => button.setAttribute("aria-pressed", "false"));
  highlighted = source?.box ? source : null;
  $("crop-figure").hidden = true;
  if (!source) {
    showPage();
    return;
  }
  for (const button of document.querySelectorAll(".source")) {
    if (button.source === source) button.setAttribute("aria-pressed", "true");
  }
  page = source.page;
  showPage();
  if (highlighted) drawCrop(source, title).catch(() => { $("crop-figure").hidden = true; });
}

$("crop-close").onclick = closeCrop;
$("preview").onload = () => delete $("preview").dataset.loading;
$("previous").onclick = () => { page--; showPage(); };
$("next").onclick = () => { page++; showPage(); };

/* Checks, recomputed as the bookkeeper types */

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
  row.dataset.mismatch = String(differs(expected, amount));
  return amount;
}

function updateChecks() {
  const rows = [...$("lines").querySelectorAll("tr:not(.lines-empty)")];
  const amounts = rows.map(checkLine);
  const mismatches = rows.filter((row) => row.dataset.mismatch === "true").length;
  const sum = amounts.reduce((total, amount) => total + (amount ?? 0), 0);
  const subtotal = number($("subtotal").value);
  const vat = number($("vat_amount").value);
  const total = number($("total").value);
  const sumDiffers = rows.length > 0 && subtotal != null && differs(sum, subtotal);

  const summary = $("lines-summary");
  summary.replaceChildren();
  if (!rows.length) {
    summary.textContent = "Aucune ligne extraite. Ajoutez-les si l’export des lignes est utile.";
  } else {
    const parts = [`${rows.length} ligne${rows.length > 1 ? "s" : ""}`, `somme ${money(sum)}`];
    summary.append(parts.join(" · "));
    const warnings = [];
    if (sumDiffers) warnings.push(`écart de ${money(sum - subtotal)} avec le total HT`);
    if (mismatches) warnings.push(`${mismatches} ligne${mismatches > 1 ? "s" : ""} où quantité × prix ≠ montant`);
    if (warnings.length) {
      const warn = document.createElement("span");
      warn.className = "warn";
      warn.textContent = ` · ${warnings.join(" · ")}`;
      summary.append(warn);
    }
  }

  const check = $("totals-check");
  let totalsDiffer = false;
  if (subtotal == null || vat == null || total == null) {
    check.textContent = "Saisissez les trois montants pour vérifier HT + TVA = TTC.";
    check.dataset.state = "";
  } else {
    totalsDiffer = differs(subtotal + vat, total);
    check.textContent = totalsDiffer
      ? `HT + TVA = ${money(subtotal + vat)}, écart de ${money(total - subtotal - vat)} avec le TTC`
      : `HT + TVA = TTC (${money(total)})`;
    check.dataset.state = totalsDiffer ? "error" : "ok";
  }

  const problems = mismatches + Number(sumDiffers) + Number(totalsDiffer);
  const reviewing = current?.status === "review";
  $("accept-label").hidden = !reviewing || (!problems && !current?.notes.length);
  const state = $("action-state");
  if (!reviewing) return;
  state.dataset.state = problems ? "error" : "";
  state.textContent = problems
    ? `${problems} écart${problems > 1 ? "s" : ""} à corriger ou à confirmer`
    : "Contrôles de calcul conformes";
}

/* Line table */

function makeSourceButton(source, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "source";
  button.textContent = `p. ${source.page}`;
  button.title = source.text;
  button.source = source;
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-label", `${title} : voir la zone source, page ${source.page}`);
  button.onclick = () => showSource(source, title, button);
  return button;
}

function addLine(line = {}, source = null, readOnly = false) {
  $("lines").querySelector(".lines-empty")?.remove();
  const row = document.createElement("tr");
  const index = document.createElement("td");
  row.append(index);
  const title = () => `Ligne ${row.rowIndex}`;
  for (const key of Object.keys(lineFields)) {
    const cell = document.createElement("td");
    const input = document.createElement("input");
    input.name = key;
    input.value = line[key] ?? "";
    input.readOnly = readOnly;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", lineFields[key]);
    input.oninput = updateChecks;
    input.addEventListener("focus", () => { if (source) showSource(source, title(), input); });
    if (key !== "description") {
      cell.className = "num";
      input.inputMode = "decimal";
    }
    cell.append(input);
    row.append(cell);
  }
  const computed = document.createElement("td");
  computed.className = "num computed";
  const sourceCell = document.createElement("td");
  if (source) sourceCell.append(makeSourceButton(source, `Ligne ${$("lines").rows.length + 1}`));
  const actions = document.createElement("td");
  if (!readOnly) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.setAttribute("aria-label", "Retirer la ligne");
    remove.title = "Retirer la ligne";
    remove.innerHTML = '<svg aria-hidden="true" viewBox="0 0 20 20"><path d="m6 6 8 8M14 6l-8 8"/></svg>';
    remove.onclick = () => { row.remove(); renumber(); updateChecks(); };
    actions.append(remove);
  }
  row.append(computed, sourceCell, actions);
  $("lines").append(row);
  renumber();
  return row;
}

function renumber() {
  [...$("lines").querySelectorAll("tr:not(.lines-empty)")].forEach((row, index) => { row.cells[0].textContent = index + 1; });
}

function collectLines() {
  return [...$("lines").querySelectorAll("tr:not(.lines-empty)")].map((row) => Object.fromEntries(
    Object.keys(lineFields).map((key) => [key, row.querySelector(`[name="${key}"]`).value]),
  ));
}

$("add-line").onclick = () => {
  const row = addLine();
  updateChecks();
  row.querySelector("input[name='description']").focus();
};

/* Document view */

function setView(next) {
  view = next;
  $("show-metrics").setAttribute("aria-pressed", String(view === "metrics"));
  $("metrics-view").hidden = view !== "metrics";
  $("detail").hidden = view !== "documents" || !current;
  $("empty").hidden = view !== "documents" || Boolean(current);
  if (view === "metrics") closeCrop();
  refresh().catch(report);
  syncTimer();
}

function display(doc) {
  const changed = doc.id !== current?.id || doc.status !== current?.status || doc.attempt !== current?.attempt;
  if (doc.id !== current?.id) {
    page = 1;
    highlighted = null;
    pageImages.clear();
    $("crop-figure").hidden = true;
  }
  current = doc;
  if (view === "documents") {
    $("empty").hidden = true;
    $("detail").hidden = false;
  }
  const working = ["queued", "processing"].includes(doc.status);
  const editable = doc.status === "review";
  $("filename").textContent = doc.filename;
  $("status-chip").textContent = statuses[doc.status];
  $("status-chip").dataset.status = doc.status;
  const meta = [doc.method, doc.duration_ms == null ? "" : `extraction ${doc.duration_ms} ms`];
  if (doc.model_tokens != null) meta.push(`${doc.model_tokens} tokens`);
  const accepted = doc.approved?.discrepancies?.length;
  if (accepted) meta.push(`${accepted} écart${accepted > 1 ? "s" : ""} accepté${accepted > 1 ? "s" : ""}`);
  if (doc.review_ms != null) meta.push(`relue en ${seconds(doc.review_ms / 1000)}`);
  $("status").textContent = meta.filter(Boolean).join(" · ");

  $("processing").hidden = !working;
  $("retry").hidden = !doc.can_retry && doc.status !== "failed";
  $("invoice").hidden = !["review", "approved"].includes(doc.status);
  $("lines-section").hidden = $("invoice").hidden;
  $("action-bar").hidden = !editable;
  $("add-line").hidden = !editable;
  $("export").hidden = doc.status !== "approved";
  $("export").href = `/documents/${doc.id}/export.csv`;
  $("export-lines").hidden = doc.status !== "approved" || !doc.approved?.lines?.length;
  $("export-lines").href = `/documents/${doc.id}/lines.csv`;

  $("duplicates").hidden = !doc.duplicates?.length;
  $("duplicate-list").replaceChildren(...(doc.duplicates ?? []).map((other) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = other.filename;
    button.onclick = () => select(other.id);
    item.append(button, ` · ${statuses[other.status].toLowerCase()}`);
    return item;
  }));
  syncTimer();
  if (!changed) return;

  $("accept").checked = false;
  if (!$("crop-figure").hidden) closeCrop();
  const notes = doc.status === "approved" ? doc.approved?.discrepancies ?? [] : doc.notes;
  $("notes-box").hidden = !notes.length;
  $("notes-box").className = doc.status === "failed" ? "callout" : "callout warn";
  $("notes-title").textContent = {
    failed: "L’extraction a échoué",
    approved: "Écarts acceptés à la validation",
  }[doc.status] ?? "À vérifier";
  $("notes").replaceChildren(...notes.map((message) => {
    const li = document.createElement("li");
    li.textContent = message;
    return li;
  }));

  for (const key of Object.keys(fields)) {
    $(key).value = doc.approved ? frenchValue(key, doc.approved[key]) : doc.extraction?.fields[key] ?? "";
    $(key).readOnly = !editable;
    const source = doc.extraction?.sources?.[key];
    const button = $(`${key}-source`);
    button.hidden = !source;
    if (source) {
      button.textContent = `p. ${source.page}`;
      button.title = source.text;
      button.source = source;
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", `${fields[key]} : voir la zone source, page ${source.page}`);
    }
  }

  $("lines").replaceChildren();
  const lines = doc.approved
    ? doc.approved.lines.map((line) => Object.fromEntries(Object.entries(line).map(([key, value]) => [key, frenchValue(key, value)])))
    : doc.extraction?.fields.lines ?? [];
  const sources = doc.approved ? [] : doc.extraction?.sources?.lines ?? [];
  lines.forEach((line, index) => addLine(line, sources[index], !editable));
  if (!lines.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    row.className = "lines-empty";
    cell.colSpan = 9;
    cell.textContent = editable ? "Aucune ligne détectée sur ce document." : "Aucune ligne.";
    row.append(cell);
    $("lines").append(row);
  }
  updateChecks();
  showPage();
}

/* Metrics */

function percent(value) {
  return value == null ? "—" : `${(Math.round(value * 1000) / 10).toLocaleString("fr-FR")} %`;
}

function seconds(value) {
  if (value == null) return "—";
  const format = (number) => number.toLocaleString("fr-FR", {maximumFractionDigits: 1});
  return value < 90 ? `${format(value)} s` : `${format(value / 60)} min`;
}

function showGain() {
  const baseline = number($("baseline").value);
  localStorage.setItem("idp-baseline-minutes", $("baseline").value);
  const median = lastMetrics?.review_seconds.median;
  $("gain").dataset.state = "";
  if (!baseline || median == null) {
    $("gain").textContent = baseline && median == null ? "Validez une première facture pour comparer." : "";
    return;
  }
  const change = Math.round((1 - median / (baseline * 60)) * 100);
  $("gain").dataset.state = change >= 0 ? "" : "worse";
  $("gain").textContent = change >= 0
    ? `La relecture médiane est ${change} % plus courte que le processus actuel.`
    : `La relecture médiane est ${-change} % plus longue que le processus actuel.`;
}

$("baseline").value = localStorage.getItem("idp-baseline-minutes") ?? "";
$("baseline").oninput = showGain;

async function refreshMetrics() {
  const metrics = await request("/metrics");
  lastMetrics = metrics;
  const review = metrics.review_seconds;
  $("stat-review").textContent = seconds(review.median);
  $("stat-review-detail").textContent = review.count
    ? `moyenne ${seconds(review.mean)} · ${review.count} relecture${review.count > 1 ? "s" : ""} chronométrée${review.count > 1 ? "s" : ""}`
    : "Aucune relecture chronométrée";
  $("stat-fields").textContent = percent(metrics.fields_accuracy);
  $("stat-lines").textContent = percent(metrics.line_accuracy);
  $("stat-lines-detail").textContent = metrics.lines.approved
    ? `${metrics.lines.unchanged} sur ${metrics.lines.approved} lignes validées`
    : "";
  $("stat-clean").textContent = percent(metrics.approved_without_correction);
  $("stat-approved").textContent = `${metrics.approved} facture${metrics.approved > 1 ? "s" : ""} validée${metrics.approved > 1 ? "s" : ""}`;
  $("stat-discrepancies").textContent = metrics.accepted_discrepancies
    ? `${metrics.accepted_discrepancies} facture${metrics.accepted_discrepancies > 1 ? "s" : ""} validée${metrics.accepted_discrepancies > 1 ? "s" : ""} avec des écarts acceptés.`
    : "";
  $("field-accuracy").replaceChildren(...Object.entries(metrics.field_accuracy).flatMap(([key, value]) => {
    const dt = document.createElement("dt");
    const bar = document.createElement("dd");
    const meter = document.createElement("div");
    const fill = document.createElement("span");
    const text = document.createElement("dd");
    dt.textContent = fields[key];
    meter.className = value != null && value < 0.9 ? "meter low" : "meter";
    fill.style.width = `${(value ?? 0) * 100}%`;
    meter.append(fill);
    bar.append(meter);
    text.className = "meter-value";
    text.textContent = percent(value);
    return [dt, bar, text];
  }));
  showGain();
}

$("show-metrics").onclick = () => setView(view === "metrics" ? "documents" : "metrics");

/* Document list */

async function refresh() {
  const docs = await request("/documents");
  $("doc-count").textContent = docs.length || "";
  const items = docs.map((doc) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const name = document.createElement("span");
    const status = document.createElement("span");
    button.type = "button";
    button.setAttribute("aria-current", String(view === "documents" && selected === doc.id));
    name.className = "doc-name";
    name.textContent = doc.filename;
    status.className = "status";
    status.dataset.status = doc.status;
    status.textContent = statuses[doc.status];
    button.append(name, status);
    button.onclick = () => select(doc.id);
    item.append(button);
    return item;
  });
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "doc-empty";
    empty.textContent = "Aucun document pour l’instant.";
    items.push(empty);
  }
  $("documents").replaceChildren(...items);
  if (selected) {
    const id = selected;
    const doc = await request(`/documents/${id}`);
    if (selected === id) display(doc);
  }
  if (view === "metrics") refreshMetrics().catch(report);
}

async function select(id) {
  selected = id;
  notify("");
  if (view !== "documents") setView("documents");
  await refresh().catch(report);
  $("workspace").focus({preventScroll: true});
}

/* Upload: choose a file or drop it anywhere on the page */

async function upload(file) {
  if (!file) return;
  const zone = $("drop-zone");
  zone.classList.add("busy");
  notify("");
  try {
    const body = new FormData();
    body.append("file", file);
    const doc = await request("/documents", {method: "POST", body});
    await select(doc.id);
    if (doc.duplicate) notify("Ce fichier avait déjà été importé : le document existant est affiché.", "info");
  } catch (error) {
    report(error);
  } finally {
    zone.classList.remove("busy");
    $("upload").reset();
  }
}

$("file").onchange = () => upload($("file").files[0]);
let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  $("drop-zone").classList.add("dragging");
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(dragDepth - 1, 0);
  if (!dragDepth) $("drop-zone").classList.remove("dragging");
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  $("drop-zone").classList.remove("dragging");
  upload(event.dataTransfer?.files[0]);
});

/* Approve and retry */

$("invoice").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("approve");
  const doc = current;
  if (!doc || doc.status !== "review" || button.disabled) return;
  button.disabled = true;
  notify("");
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
    $("action-state").textContent = error.message;
    $("action-state").dataset.state = "error";
  } finally {
    button.disabled = false;
  }
};

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("crop-figure").hidden) closeCrop();
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !$("action-bar").hidden) {
    event.preventDefault();
    $("invoice").requestSubmit();
  }
});

$("retry").onclick = async () => {
  $("retry").disabled = true;
  notify("");
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
