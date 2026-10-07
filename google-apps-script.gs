/**
 * Collega l'app "Spese e portafoglio" a questo foglio Google.
 * Da incollare in: Estensioni → Apps Script (sostituisci tutto il contenuto di Codice.gs).
 *
 * Scheda "Movimenti": una riga per ogni spesa o entrata inserita nell'app. Puoi correggere o aggiungere righe anche a mano:
 *   Data (data) · Tipo (Uscita o Entrata) · Categoria · Importo (numero positivo) · Nota · ID (lo compila l'app, lascialo vuoto per le righe nuove)
 * Scheda "Dati app": portafoglio, mutuo, FIRE, budget, spese fisse e storico di Cashew, in formato JSON. Non modificarla a mano.
 */

// L'indirizzo dell'app installabile.
const APP_URL = "https://navazx.github.io/spese/";
// Il codice segreto lo genera la funzione prepara() e resta nelle proprietà dello script: non è scritto qui.
// Chi non lo conosce non può leggere né scrivere i tuoi dati.
function codiceSegreto() { return PropertiesService.getScriptProperties().getProperty("CODICE") || ""; }

const FOGLIO_MOV = "Movimenti";
const FOGLIO_DOC = "Dati app";
const FOGLIO_LINK = "Collegamento";
const INTESTAZIONE_MOV = ["Data", "Tipo", "Categoria", "Importo", "Nota", "ID"];
const INTESTAZIONE_DOC = ["Percorso", "Dati (JSON)", "Aggiornato"];

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (_) { return risposta({ok: false, errore: "richiesta non valida"}); }
  const codice = codiceSegreto();
  if (codice.length < 20) return risposta({ok: false, errore: "codice da impostare"});
  if (req.codice !== codice) return risposta({ok: false, errore: "codice errato"});
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (req.azione === "leggi") return risposta({ok: true, documenti: leggiTutto()});
    if (req.azione === "scrivi") { scrivi(req.documenti || {}); return risposta({ok: true}); }
    if (req.azione === "cancella") { cancella(String(req.path || "")); return risposta({ok: true}); }
    return risposta({ok: false, errore: "azione sconosciuta"});
  } catch (err) {
    return risposta({ok: false, errore: String(err)});
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return ContentService.createTextOutput("Collegamento attivo. Apri l'app per usarlo.");
}

function risposta(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function foglio(nome, intestazione) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(nome);
  if (!sh) {
    sh = ss.insertSheet(nome);
    sh.getRange(1, 1, 1, intestazione.length).setValues([intestazione]).setFontWeight("bold");
    sh.setFrozenRows(1);
    if (nome === FOGLIO_MOV) {
      sh.getRange("A:A").setNumberFormat("dd/mm/yyyy");
      sh.getRange("D:D").setNumberFormat("#,##0.00 €");
      sh.setColumnWidth(3, 170); sh.setColumnWidth(5, 220);
    } else {
      sh.setColumnWidth(1, 190); sh.setColumnWidth(2, 500);
    }
  }
  return sh;
}

function isoGiorno(v) {
  if (v instanceof Date) return Utilities.formatDate(v, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM-dd");
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
  return "";
}
function numero(v) {
  if (typeof v === "number") return Math.abs(v);
  const s = String(v || "").replace(/[€\s]/g, "");
  const n = Number(s.indexOf(",") >= 0 ? s.replace(/\./g, "").replace(",", ".") : s);
  return isFinite(n) ? Math.abs(n) : NaN;
}

function leggiTutto() {
  const out = {};
  // movimenti: raggruppati per mese, come li usa l'app
  const sm = foglio(FOGLIO_MOV, INTESTAZIONE_MOV);
  const n = sm.getLastRow() - 1;
  if (n > 0) {
    const righe = sm.getRange(2, 1, n, 6).getValues();
    const nuoviId = [];
    righe.forEach((r, i) => {
      const d = isoGiorno(r[0]), imp = numero(r[3]);
      if (!d || !(imp > 0)) return;
      let id = String(r[5] || "").trim();
      if (!id) { id = Utilities.getUuid().slice(0, 10); nuoviId.push([i + 2, id]); }
      const M = d.slice(0, 7);
      (out["movimenti/" + M] = out["movimenti/" + M] || {voci: []}).voci.push({
        id: id, d: d, imp: Math.round(imp * 100) / 100,
        tipo: /^entr|^in/i.test(String(r[1])) ? "in" : "out",
        cat: String(r[2] || "Altro").trim() || "Altro",
        nota: String(r[4] || "")
      });
    });
    nuoviId.forEach(x => sm.getRange(x[0], 6).setValue(x[1]));
  }
  // altri documenti
  const sd = foglio(FOGLIO_DOC, INTESTAZIONE_DOC);
  const k = sd.getLastRow() - 1;
  if (k > 0) {
    sd.getRange(2, 1, k, 2).getValues().forEach(r => {
      const p = String(r[0] || "").trim();
      if (!p) return;
      try { out[p] = JSON.parse(r[1]); } catch (_) {}
    });
  }
  return out;
}

function scrivi(documenti) {
  const mesi = {};
  const altri = {};
  Object.keys(documenti).forEach(p => {
    const d = documenti[p];
    const m = p.match(/^movimenti\/(\d{4}-\d{2})$/);
    if (m) mesi[m[1]] = Array.isArray(d && d.voci) ? d.voci : [];
    else if (/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/.test(p) && d && typeof d === "object") altri[p] = d;
  });

  if (Object.keys(mesi).length) {
    // riscrive solo le righe dei mesi cambiati, lascia le altre come sono
    const sm = foglio(FOGLIO_MOV, INTESTAZIONE_MOV);
    const n = sm.getLastRow() - 1;
    const tenute = n > 0 ? sm.getRange(2, 1, n, 6).getValues().filter(r => {
      const d = isoGiorno(r[0]);
      return !(d && mesi.hasOwnProperty(d.slice(0, 7)));
    }) : [];
    Object.keys(mesi).forEach(M => mesi[M].forEach(v => {
      const p = String(v.d || "").split("-").map(Number);
      if (p.length !== 3 || !(Number(v.imp) > 0)) return;
      // mezzogiorno: la data resta la stessa anche se il fuso dello script e quello del foglio sono diversi
      tenute.push([new Date(p[0], p[1] - 1, p[2], 12), v.tipo === "in" ? "Entrata" : "Uscita", String(v.cat || "Altro"), Number(v.imp), String(v.nota || ""), String(v.id || Utilities.getUuid().slice(0, 10))]);
    }));
    tenute.sort((a, b) => (b[0] instanceof Date ? b[0].getTime() : 0) - (a[0] instanceof Date ? a[0].getTime() : 0));
    if (n > 0) sm.getRange(2, 1, n, 6).clearContent();
    if (tenute.length) sm.getRange(2, 1, tenute.length, 6).setValues(tenute);
  }

  if (Object.keys(altri).length) {
    const sd = foglio(FOGLIO_DOC, INTESTAZIONE_DOC);
    const k = sd.getLastRow() - 1;
    const percorsi = k > 0 ? sd.getRange(2, 1, k, 1).getValues().map(r => String(r[0])) : [];
    const ora = new Date();
    Object.keys(altri).forEach(p => {
      const riga = [p, JSON.stringify(altri[p]), ora];
      const i = percorsi.indexOf(p);
      if (i >= 0) sd.getRange(i + 2, 1, 1, 3).setValues([riga]);
      else { sd.appendRow(riga); percorsi.push(p); }
    });
  }
}

function cancella(p) {
  const m = p.match(/^movimenti\/(\d{4}-\d{2})$/);
  if (m) { const o = {}; o[p] = {voci: []}; scrivi(o); return; }
  const sd = foglio(FOGLIO_DOC, INTESTAZIONE_DOC);
  const k = sd.getLastRow() - 1;
  if (k <= 0) return;
  const i = sd.getRange(2, 1, k, 1).getValues().map(r => String(r[0])).indexOf(p);
  if (i >= 0) sd.deleteRow(i + 2);
}

// Esegui questa funzione una volta dall'editor (menu in alto → Esegui): crea le schede, il codice segreto e dà i permessi.
function prepara() {
  foglio(FOGLIO_MOV, INTESTAZIONE_MOV);
  foglio(FOGLIO_DOC, INTESTAZIONE_DOC);
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty("CODICE")) p.setProperty("CODICE", (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ""));
  const sh = foglioLink();
  if (!sh.getRange("B1").getValue()) sh.getRange("B3").setValue("Dopo il deployment, incolla in B1 l'URL dell'app web (finisce con /exec) e scegli App spese → Aggiorna il link.");
}

function foglioLink() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(FOGLIO_LINK);
  if (!sh) {
    sh = ss.insertSheet(FOGLIO_LINK);
    sh.getRange("A1:A5").setValues([["URL dell'app web (/exec)"], [""], ["Link per collegare l'app"], [""], ["Come si usa"]]).setFontWeight("bold");
    sh.getRange("B5").setValue("Apri il link sul computer e sul telefono (in Chrome): l'app si collega da sola a questo foglio. Non condividerlo: contiene il codice segreto.");
    sh.setColumnWidth(1, 210); sh.setColumnWidth(2, 520);
  }
  return sh;
}

// Crea in B3 il link che apre l'app già collegata. Si riesegue da menu App spese → Aggiorna il link.
function creaLink() {
  const sh = foglioLink();
  const url = String(sh.getRange("B1").getValue() || "").trim();
  const codice = codiceSegreto();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) { sh.getRange("B3").setValue("In B1 serve l'URL dell'app web che finisce con /exec."); return; }
  if (!codice) { sh.getRange("B3").setValue("Esegui prima la funzione prepara dall'editor dello script."); return; }
  const link = APP_URL + "#collega=" + encodeURIComponent(url) + "~" + codice;
  sh.getRange("B3").setRichTextValue(SpreadsheetApp.newRichTextValue().setText("Apri l'app collegata a questo foglio").setLinkUrl(link).build());
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("App spese").addItem("Aggiorna il link", "creaLink").addToUi();
}
