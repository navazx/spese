// Collegamento al foglio Google (tramite il suo Apps Script).
// Offre all'app la stessa interfaccia che usava nell'artifact: db.doc(path).set/get/onSnapshot e db.collection(nome).onSnapshot.
// Le scritture passano da una coda salvata sul dispositivo, così funzionano anche offline e partono appena torna la connessione.
(function(){
  const CHIAVE = "pf-cloud";
  const MERCATO = {"portafoglio/prezzi":"prezzi", "portafoglio/mercati":"mercati", "portafoglio/tassi":"tassi"};
  const OUTBOX = "pf-outbox";
  const LIVE = new Map();
  const docL = new Map(), colL = new Map();
  let cfg = null, caricato = false, mercato = null, svuotando = false, ritardo = 0, ultimaLettura = 0;
  const $ = id => document.getElementById(id);
  const copia = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));
  const uguale = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const avvisa = m => { if (typeof toast === "function") toast(m); };

  // link dal foglio: #collega=<url dello script>~<codice>. Si salva sul dispositivo e sparisce dalla barra degli indirizzi.
  (function(){
    const m = location.hash.match(/^#collega=([^~]+)~([A-Za-z0-9]{20,})$/);
    if (!m) return;
    try{
      const url = decodeURIComponent(m[1]);
      if (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) localStorage.setItem(CHIAVE, JSON.stringify({url, codice: m[2]}));
    }catch(_){}
    history.replaceState(null, "", location.pathname + "#spese");
  })();
  function leggiCfg(){ try{ const c = JSON.parse(localStorage.getItem(CHIAVE) || "null"); return c?.url && c?.codice ? c : null; }catch(_){ return null; } }
  function leggiOutbox(){ try{ return JSON.parse(localStorage.getItem(OUTBOX) || "{}"); }catch(_){ return {}; } }
  function scriviOutbox(o){ try{ localStorage.setItem(OUTBOX, JSON.stringify(o)); }catch(_){} }

  // Google a volte risponde con una pagina d'errore ("Impossibile aprire il file", 404) anche se lo script funziona:
  // in quel caso la stessa richiesta si ripete subito, fino a 5 volte. Scrivere due volte lo stesso documento non fa danni.
  async function chiama(azione, extra, conf = cfg){
    let ultimo = null;
    for (let tentativo = 0; tentativo < 5; tentativo++){
      if (tentativo) await new Promise(r => setTimeout(r, 800 * tentativo));
      let j = null;
      // sul telefono una richiesta può restare appesa (es. mentre si sceglie un file): dopo 20 s la si abbandona e si riprova
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 20000);
      try{
        const r = await fetch(conf.url, {
          method: "POST",
          headers: {"Content-Type": "text/plain;charset=utf-8"},   // richiesta semplice: Apps Script non gestisce il preflight
          body: JSON.stringify({codice: conf.codice, azione, ...extra}),
          redirect: "follow",
          signal: stop.signal
        });
        j = await r.json();
      }catch(e){ ultimo = new Error("risposta"); continue; }
      finally{ clearTimeout(timer); }
      if (!j?.ok){
        ultimo = new Error(j?.errore || "errore");
        if (/codice/.test(ultimo.message)) throw ultimo;          // codice sbagliato o mancante: ripetere non serve
        continue;
      }
      return j;
    }
    throw ultimo;
  }

  // I prezzi arrivano da mercati.json, aggiornato ogni giorno di borsa; una quotazione scritta a mano più recente vince.
  function valore(path){
    let d = LIVE.get(path);
    const k = MERCATO[path];
    if (k && mercato && mercato[k]){
      const j = mercato[k];
      if (!d || k !== "prezzi" || String(j.aggiornato || "") >= String(d.aggiornato || "")) d = j;
    }
    return d;
  }
  function snapDoc(path){
    const d = valore(path);
    return {id: path.split("/").pop(), exists: d !== undefined, data: () => d, metadata: {fromCache: !caricato, hasPendingWrites: !!leggiOutbox()[path]}};
  }
  function snapCol(col){
    const docs = [...LIVE.keys()].filter(p => p.split("/").length === 2 && p.startsWith(col + "/")).sort().map(snapDoc);
    return {docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {fromCache: !caricato, hasPendingWrites: false}};
  }
  function avvisaListener(path){
    (docL.get(path) || []).forEach(fn => { try{ fn(snapDoc(path)); }catch(e){ console.error(e); } });
    const parti = path.split("/");
    if (parti.length === 2 && caricato) (colL.get(parti[0]) || []).forEach(fn => { try{ fn(snapCol(parti[0])); }catch(e){ console.error(e); } });
  }
  function avvisaTutti(){
    docL.forEach((_, p) => avvisaListener(p));
    if (caricato) colL.forEach((set, col) => set.forEach(fn => { try{ fn(snapCol(col)); }catch(e){ console.error(e); } }));
  }

  // ---- stato della sincronizzazione ----
  function stato(t, ok){
    const el = $("cl-stato"); if (!el) return;
    el.textContent = t;
    el.className = "cl-stato " + (ok === true ? "ok" : ok === false ? "ko" : "");
  }
  function aggiornaStato(errore){
    if (!cfg) return;
    const n = Object.keys(leggiOutbox()).length;
    if (!navigator.onLine) stato(n ? `Offline · ${n} ${n === 1 ? "modifica" : "modifiche"} da inviare` : "Offline · i dati restano sul dispositivo", false);
    else if (errore) stato(`Il foglio non risponde · ${n} ${n === 1 ? "modifica" : "modifiche"} in attesa, riprovo da solo`, false);
    else if (n) stato(`Salvataggio nel foglio di ${n} ${n === 1 ? "modifica" : "modifiche"}…`);
    else stato("Sincronizzato con il foglio Google", true);
  }

  async function svuota(){
    if (svuotando || !cfg || !navigator.onLine){ aggiornaStato(); return; }
    const o = leggiOutbox();
    if (!Object.keys(o).length){ aggiornaStato(); return; }
    svuotando = true; aggiornaStato();
    let errore = false;
    try{
      await chiama("scrivi", {documenti: o});
      if (o["portafoglio/spese"]) avvisa("Spese di Cashew salvate nel foglio");
      const ora = leggiOutbox();
      Object.keys(o).forEach(p => { if (uguale(ora[p], o[p])) delete ora[p]; });
      scriviOutbox(ora);
      ritardo = 0;
    }catch(e){
      console.error(e); errore = true;
      if (/codice errato/.test(e.message)) richiediDiNuovo();
      ritardo = Math.min(30000, (ritardo || 2000) * 2);
      setTimeout(svuota, ritardo);
    }finally{
      svuotando = false;
      aggiornaStato(errore);
      if (!errore && Object.keys(leggiOutbox()).length) setTimeout(svuota, 300);
    }
  }
  // le scritture ravvicinate (es. un cursore trascinato) partono insieme
  let svuotaT = 0;
  const scrittoIl = {};   // ultima modifica fatta su questo dispositivo, per documento
  function scrivi(path, data){
    scrittoIl[path] = Date.now();
    const o = leggiOutbox(); o[path] = data; scriviOutbox(o);
    aggiornaStato();
    clearTimeout(svuotaT); svuotaT = setTimeout(svuota, 800);
  }

  // inizio = quando è partita la lettura: un documento modificato qui dopo quel momento è più nuovo di ciò che è arrivato
  function applica(documenti, inizio = 0){
    const o = leggiOutbox();
    const recente = p => scrittoIl[p] !== undefined && scrittoIl[p] >= inizio;
    const visti = new Set(Object.keys(documenti));
    Object.entries(documenti).forEach(([p, d]) => {
      if (o[p] || recente(p)) return;                 // modifica locale più nuova: vince quella
      if (!uguale(LIVE.get(p), d)){ LIVE.set(p, d); if (caricato) avvisaListener(p); }
    });
    [...LIVE.keys()].forEach(p => { if (!visti.has(p) && !o[p] && !recente(p) && caricato){ LIVE.delete(p); avvisaListener(p); } });
    Object.entries(o).forEach(([p, d]) => LIVE.set(p, d));
    if (!caricato){ caricato = true; avvisaTutti(); }
    ultimaLettura = Date.now();
    mostraVuoto();
  }
  async function ricarica(){
    if (svuotando || Object.keys(leggiOutbox()).length) await svuota();
    const inizio = Date.now();
    const j = await chiama("leggi");
    applica(j.documenti || {}, inizio);
  }

  async function caricaMercato(){
    try{
      const r = await fetch("mercati.json", {cache: "no-store"});
      if (!r.ok) return;
      const j = await r.json();
      if (uguale(j, mercato)) return;
      mercato = j;
      Object.keys(MERCATO).forEach(avvisaListener);
    }catch(_){}
  }

  const db = {
    doc(path){
      return {
        id: path.split("/").pop(), path,
        async get(){ return snapDoc(path); },
        async set(data){ const d = copia(data); LIVE.set(path, d); avvisaListener(path); scrivi(path, d); mostraVuoto(); },
        async update(data){ const d = {...(LIVE.get(path) || {}), ...copia(data)}; LIVE.set(path, d); avvisaListener(path); scrivi(path, d); },
        async delete(){
          LIVE.delete(path); avvisaListener(path);
          const o = leggiOutbox(); delete o[path]; scriviOutbox(o);
          if (cfg) await chiama("cancella", {path}).catch(() => {});
        },
        onSnapshot(fn){
          let s = docL.get(path); if (!s) docL.set(path, s = new Set());
          s.add(fn); setTimeout(() => fn(snapDoc(path)), 0);
          return () => s.delete(fn);
        },
        collection(sub){ return db.collection(path + "/" + sub); }
      };
    },
    collection(col){
      return {
        path: col,
        doc(id){ return db.doc(col + "/" + id); },
        async get(){ return snapCol(col); },
        onSnapshot(fn){
          let s = colL.get(col); if (!s) colL.set(col, s = new Set());
          s.add(fn); if (caricato) setTimeout(() => fn(snapCol(col)), 0);
          return () => s.delete(fn);
        }
      };
    }
  };

  // ---- collegamento al foglio ----
  function mostraLogin(msg){
    $("login").hidden = false;
    $("lg-msg").textContent = msg || "";
    $("lg-msg").hidden = !msg;
    setTimeout(() => $("lg-url").focus(), 50);
  }
  function chiediCollegamento(msg){
    return new Promise(resolve => {
      mostraLogin(msg);
      $("lg-form").onsubmit = async e => {
        e.preventDefault();
        const url = $("lg-url").value.trim(), codice = $("lg-codice").value.trim();
        if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)){ mostraLogin("L'indirizzo deve essere quello dell'app web di Apps Script: inizia con https://script.google.com/macros/s/ e finisce con /exec."); return; }
        if (codice.length < 20){ mostraLogin("Il codice segreto è quello che hai scritto nello script, di almeno 20 caratteri."); return; }
        $("lg-ok").disabled = true; $("lg-ok").textContent = "Collegamento…";
        try{
          const j = await chiama("leggi", {}, {url, codice});
          try{ localStorage.setItem(CHIAVE, JSON.stringify({url, codice})); }catch(_){}
          $("login").hidden = true; $("lg-codice").value = "";
          resolve({conf: {url, codice}, documenti: j.documenti || {}});
        }catch(err){
          const m = String(err?.message || "");
          mostraLogin(/codice errato/.test(m) ? "Il codice segreto non corrisponde a quello dello script."
            : /codice da impostare/.test(m) ? "Lo script non ha ancora un codice segreto: nell'editor esegui la funzione prepara."
            : /fetch|network|Failed/i.test(m) ? "Non riesco a raggiungere il foglio. Controlla la connessione e che il deployment abbia accesso «Chiunque»."
            : "Collegamento non riuscito: " + m);
        }finally{
          $("lg-ok").disabled = false; $("lg-ok").textContent = "Collega";
        }
      };
    });
  }
  let giaRichiesto = false;
  function richiediDiNuovo(){
    if (giaRichiesto) return; giaRichiesto = true;
    try{ localStorage.removeItem(CHIAVE); }catch(_){}
    avvisa("Il codice segreto è cambiato: collega di nuovo il foglio");
    setTimeout(() => location.reload(), 1500);
  }

  // ---- backup e account vuoto ----
  function tutti(){
    const out = {};
    LIVE.forEach((d, p) => { out[p] = d; });
    Object.entries(leggiOutbox()).forEach(([p, d]) => { out[p] = d; });
    return out;
  }
  function mostraVuoto(){
    const el = $("cl-vuoto"); if (!el) return;
    el.hidden = !(caricato && !LIVE.has("portafoglio/config"));
  }
  function esporta(){
    const nome = `spese-backup-${new Date().toISOString().slice(0,10)}.json`;
    const blob = new Blob([JSON.stringify({versione: 1, esportato: new Date().toISOString(), documenti: tutti()}, null, 1)], {type: "application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    avvisa("Backup salvato: " + nome);
  }
  let inAttesa = null;
  async function scegliBackup(file){
    const testo = await file.text().catch(() => "");
    // un export CSV di Cashew scelto dal pulsante sbagliato: lo passo all'importazione di Cashew
    const intestazione = testo.replace(/^﻿/, "").split(/\r?\n/, 1)[0].toLowerCase();
    if (/(^|,)"?amount"?(,|$)/.test(intestazione) && intestazione.includes("category name")){
      const input = $("sp-file");
      if (input){
        try{
          const dt = new DataTransfer(); dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event("change", {bubbles: true}));
          return;
        }catch(_){}
      }
      avvisa("È un export di Cashew: caricalo da Spese → Andamento → Carica un CSV di Cashew");
      return;
    }
    try{
      const j = JSON.parse(testo);
      const docs = j?.documenti;
      if (!docs || typeof docs !== "object" || !Object.keys(docs).length) throw new Error();
      inAttesa = docs;
      const n = Object.keys(docs).length, quando = j.esportato ? new Date(j.esportato).toLocaleDateString("it-IT", {day: "numeric", month: "long", year: "numeric"}) : "";
      $("cl-conf-t").textContent = `Sostituire i tuoi dati con il backup${quando ? " del " + quando : ""} (${n} ${n === 1 ? "documento" : "documenti"})? Quello che hai ora con lo stesso nome viene sovrascritto.`;
      $("cl-conf").hidden = false;
    }catch(_){ avvisa("Il file non è un backup di questa app"); }
  }
  async function importa(){
    const docs = inAttesa; inAttesa = null; $("cl-conf").hidden = true;
    if (!docs) return;
    const o = leggiOutbox();
    Object.entries(docs).forEach(([p, d]) => {
      if (typeof p !== "string" || p.split("/").length !== 2 || !d || typeof d !== "object") return;
      LIVE.set(p, d); o[p] = d;
    });
    scriviOutbox(o);
    ["pf-config","pf-fire","pf-alloc","pf-mutuo","pf-patr","pf-spese","pf-mov","pf-ric","pf-budget","pf-fp"].forEach(k => { try{ localStorage.removeItem(k); }catch(_){} });
    avvisa("Importazione nel foglio in corso…");
    await svuota();
    if (Object.keys(leggiOutbox()).length){ avvisa("Importato sul dispositivo: lo salvo nel foglio appena risponde"); return; }
    avvisa("Backup importato");
    setTimeout(() => location.reload(), 700);
  }
  let confermaUscita = false;
  function esci(){
    if (Object.keys(leggiOutbox()).length && !confermaUscita){ confermaUscita = true; $("cl-esci").textContent = "Ci sono modifiche non salvate nel foglio: tocca ancora per scollegare"; return; }
    try{ Object.keys(localStorage).filter(k => k.startsWith("pf-")).forEach(k => localStorage.removeItem(k)); }catch(_){}
    location.reload();
  }

  document.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "cl-esporta") esporta();
    else if (b.id === "cl-importa-ok") importa();
    else if (b.id === "cl-importa-no"){ inAttesa = null; $("cl-conf").hidden = true; }
    else if (b.id === "cl-esci") esci();
  });
  document.addEventListener("change", e => {
    if (e.target.id === "cl-file" || e.target.id === "cl-file2"){ const f = e.target.files?.[0]; if (f) scegliBackup(f); e.target.value = ""; }
  });

  // ---- avvio ----
  window.avviaCloud = async function(){
    caricaMercato();
    setInterval(caricaMercato, 30 * 60 * 1000);
    cfg = leggiCfg();
    if (!cfg){
      const r = await chiediCollegamento();
      cfg = r.conf;
      $("cl-bar").hidden = false;
      applica(r.documenti);
    } else {
      $("cl-bar").hidden = false;
      // il foglio a volte è lento o occupato a salvare: riprova da solo finché non risponde
      let attesa = 3000;
      const riprova = async () => {
        try{ await ricarica(); aggiornaStato(); }
        catch(e){
          console.error(e);
          if (/codice errato/.test(e.message)){ richiediDiNuovo(); return; }
          aggiornaStato(true);
          setTimeout(riprova, attesa); attesa = Math.min(60000, attesa * 2);
        }
      };
      await riprova();
    }
    svuota();
    window.addEventListener("online", () => { svuota(); ricarica().catch(() => {}); });
    window.addEventListener("offline", () => aggiornaStato());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible"){ caricaMercato(); if (navigator.onLine) ricarica().catch(() => {}); }
    });
    // con l'app aperta, ogni 2 minuti prende le modifiche fatte dall'altro dispositivo o nel foglio
    setInterval(() => { if (document.visibilityState === "visible" && navigator.onLine && Date.now() - ultimaLettura > 110000) ricarica().catch(() => {}); }, 30000);
    return db;
  };

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
