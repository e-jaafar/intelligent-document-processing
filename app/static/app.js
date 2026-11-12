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
        const field = fields[issue.loc.at(-1)] || "Facture";
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
      body: JSON.stringify({attempt: doc.attempt, invoice: Object.fromEntries(new FormData(event.target))}),
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
