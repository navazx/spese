// Collegamento al database cloud (Supabase).
// Offre all'app la stessa interfaccia che usava nell'artifact: db.doc(path).set/get/onSnapshot e db.collection(nome).onSnapshot.
// Ogni documento è una riga della tabella "documenti" (user_id, path, data). Le scritture passano da una coda
// salvata sul telefono, così funzionano anche offline e partono appena torna la connessione.
(function(){
  const CFG = window.APP_CONFIG || {};
  const MERCATO = {"portafoglio/prezzi":"prezzi", "portafoglio/mercati":"mercati", "portafoglio/tassi":"tassi"};
  const OUTBOX = "pf-outbox";
  const LIVE = new Map();
  const docL = new Map(), colL = new Map();
  let sb = null, uid = null, caricato = false, mercato = null, svuotando = false, ritardo = 0;
  const $ = id => document.getElementById(id);
  const copia = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));
  const uguale = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const avvisa = m => { if (typeof toast === "function") toast(m); };

  function leggiOutbox(){ try{ return JSON.parse(localStorage.getItem(OUTBOX) || "{}"); }catch(_){ return {}; } }
  function scriviOutbox(o){ try{ localStorage.setItem(OUTBOX, JSON.stringify(o)); }catch(_){} }

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
  function aggiornaStato(){
    const n = Object.keys(leggiOutbox()).length;
    if (!sb) return;
    if (!navigator.onLine) stato(n ? `Offline · ${n} ${n === 1 ? "modifica" : "modifiche"} da inviare` : "Offline · i dati restano sul telefono", false);
    else if (n) stato(`Invio di ${n} ${n === 1 ? "modifica" : "modifiche"}…`);
    else stato("Sincronizzato", true);
  }

  async function svuota(){
    if (svuotando || !sb || !uid || !navigator.onLine) { aggiornaStato(); return; }
    const o = leggiOutbox();
    const righe = Object.entries(o).map(([path, data]) => ({user_id: uid, path, data, aggiornato: new Date().toISOString()}));
    if (!righe.length){ aggiornaStato(); return; }
    svuotando = true; aggiornaStato();
    try{
      const {error} = await sb.from("documenti").upsert(righe, {onConflict: "user_id,path"});
      if (error) throw error;
      const ora = leggiOutbox();
      righe.forEach(r => { if (uguale(ora[r.path], r.data)) delete ora[r.path]; });
      scriviOutbox(ora);
      ritardo = 0;
    }catch(e){
      console.error(e);
      ritardo = Math.min(60000, (ritardo || 4000) * 2);
      setTimeout(svuota, ritardo);
    }finally{
      svuotando = false;
      aggiornaStato();
      if (!ritardo && Object.keys(leggiOutbox()).length) setTimeout(svuota, 300);
    }
  }
  function scrivi(path, data){
    const o = leggiOutbox(); o[path] = data; scriviOutbox(o);
    svuota();
  }

  async function ricarica(){
    const {data, error} = await sb.from("documenti").select("path,data").limit(5000);
    if (error) throw error;
    const o = leggiOutbox();
    const visti = new Set();
    data.forEach(r => {
      visti.add(r.path);
      if (o[r.path]) return;                         // c'è una modifica locale non ancora inviata: vince quella
      if (!uguale(LIVE.get(r.path), r.data)){ LIVE.set(r.path, r.data); if (caricato) avvisaListener(r.path); }
    });
    [...LIVE.keys()].forEach(p => { if (!visti.has(p) && !o[p] && caricato){ LIVE.delete(p); avvisaListener(p); } });
    Object.entries(o).forEach(([p, d]) => LIVE.set(p, d));
    if (!caricato){ caricato = true; avvisaTutti(); }
    mostraVuoto();
  }
  function realtime(){
    sb.channel("documenti-" + uid)
      .on("postgres_changes", {event: "*", schema: "public", table: "documenti", filter: `user_id=eq.${uid}`}, ev => {
        if (ev.eventType === "DELETE"){ const p = ev.old?.path; if (p && LIVE.has(p) && !leggiOutbox()[p]){ LIVE.delete(p); avvisaListener(p); } return; }
        const r = ev.new; if (!r?.path) return;
        if (leggiOutbox()[r.path] || uguale(LIVE.get(r.path), r.data)) return;
        LIVE.set(r.path, r.data); avvisaListener(r.path); mostraVuoto();
      })
      .subscribe();
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
          if (sb && uid) await sb.from("documenti").delete().eq("user_id", uid).eq("path", path);
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

  // ---- accesso ----
  function mostraLogin(modo, msg){
    const box = $("login"); if (!box) return;
    box.hidden = false;
    $("lg-config").hidden = modo !== "config";
    $("lg-form").hidden = modo === "config";
    $("lg-msg").textContent = msg || "";
    $("lg-msg").hidden = !msg;
    if (modo !== "config") setTimeout(() => $("lg-email").focus(), 50);
  }
  function chiediAccesso(){
    return new Promise(resolve => {
      mostraLogin("login");
      const form = $("lg-form");
      let registra = false;
      $("lg-nuovo").onclick = () => { registra = true; form.requestSubmit(); };
      form.onsubmit = async e => {
        e.preventDefault();
        const email = $("lg-email").value.trim(), password = $("lg-pass").value;
        if (!email || password.length < 8){ mostraLogin("login", "Scrivi la tua email e una password di almeno 8 caratteri."); registra = false; return; }
        $("lg-ok").disabled = $("lg-nuovo").disabled = true;
        try{
          const r = registra ? await sb.auth.signUp({email, password}) : await sb.auth.signInWithPassword({email, password});
          if (r.error) throw r.error;
          if (!r.data.session){ mostraLogin("login", "Account creato. Conferma l'indirizzo dal link che ti è arrivato per email, poi accedi qui."); return; }
          $("login").hidden = true; $("lg-pass").value = "";
          resolve(r.data.session);
        }catch(err){
          const m = String(err?.message || "");
          mostraLogin("login", /invalid login/i.test(m) ? "Email o password sbagliate."
            : /already registered/i.test(m) ? "Esiste già un account con questa email: tocca Accedi."
            : /signups? not allowed|disabled/i.test(m) ? "La creazione di nuovi account è disattivata."
            : /fetch|network/i.test(m) ? "Nessuna connessione: per il primo accesso serve internet."
            : "Accesso non riuscito: " + m);
        }finally{
          registra = false;
          $("lg-ok").disabled = $("lg-nuovo").disabled = false;
        }
      };
    });
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
    try{
      const j = JSON.parse(await file.text());
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
    await svuota();
    avvisa("Backup importato");
    setTimeout(() => location.reload(), 700);
  }
  async function esci(){
    if (Object.keys(leggiOutbox()).length && !confirmaUscita){ confirmaUscita = true; $("cl-esci").textContent = "Ci sono modifiche non inviate: tocca ancora per uscire"; return; }
    try{ await sb?.auth.signOut(); }catch(_){}
    try{ Object.keys(localStorage).filter(k => k.startsWith("pf-")).forEach(k => localStorage.removeItem(k)); }catch(_){}
    location.reload();
  }
  let confirmaUscita = false;

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
    if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase){ mostraLogin("config"); return null; }
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {auth: {persistSession: true, autoRefreshToken: true, storageKey: "pf-auth"}});
    let session = null;
    try{ session = (await sb.auth.getSession()).data.session; }catch(_){}
    if (!session) session = await chiediAccesso();
    uid = session.user.id;
    $("cl-utente").textContent = session.user.email || "";
    $("cl-bar").hidden = false;
    try{ await ricarica(); }catch(e){ console.error(e); }
    realtime();
    svuota();
    window.addEventListener("online", () => { svuota(); ricarica().catch(() => {}); });
    window.addEventListener("offline", aggiornaStato);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible"){ caricaMercato(); if (navigator.onLine){ svuota(); ricarica().catch(() => {}); } }
    });
    return db;
  };

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
