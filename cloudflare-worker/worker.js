const JSON_PATH = "data/risultati.json";

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed && origin === allowed ? origin : allowed,
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/evento") return registraVisita(request, env, cors);
    if (url.pathname === "/stats") return statistiche(request, env, cors);
    if (url.pathname.startsWith("/push/")) return gestisciPush(request, env, cors, url.pathname);
    if (url.pathname.startsWith("/live")) return gestisciLive(request, env, cors, url.pathname);
    if (url.pathname === "/auth") {
      if (request.method !== "POST") return json({ error: "Metodo non consentito" }, 405, cors);
      let authBody;
      try { authBody = await request.json(); } catch { return json({ error: "JSON non valido" }, 400, cors); }
      const supplied = String(authBody.password || "").trim();
      const configured = String(env.ADMIN_PASSWORD || "").trim();
      const ok = !!configured && supplied === configured;
      await registraAccessoAdmin(request, env, ok, authBody.tipo === "ripristino" ? "ripristino" : "login");
      if (!ok) return json({ error: "Password errata" }, 401, cors);
      return json({ ok: true }, 200, cors);
    }
    if (url.pathname !== "/results") return json({ error: "Endpoint non trovato" }, 404, cors);
    if (request.method === "GET") {
      try {
        const file = await githubFile(env);
        return json(JSON.parse(decodeURIComponent(escape(atob(file.content.replace(/\n/g, ""))))), 200, cors);
      } catch (e) {
        return json({ error: "Impossibile leggere risultati.json: " + e.message }, 502, cors);
      }
    }
    if (request.method !== "PUT") return json({ error: "Metodo non consentito" }, 405, cors);
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON non valido" }, 400, cors); }
    if (!env.ADMIN_PASSWORD || String(body.password || "").trim() !== String(env.ADMIN_PASSWORD).trim()) {
      return json({ error: "Password errata" }, 401, cors);
    }
    if (!Array.isArray(body.partite)) return json({ error: "Il campo partite deve essere un array" }, 400, cors);
    const clean = body.partite.map((m, i) => ({
      id: Number(m.id ?? i + 1),
      data: String(m.data || ""),
      ora: String(m.ora || ""),
      gara: String(m.gara || ""),
      competizione: String(m.competizione || ""),
      squadraCasa: String(m.squadraCasa || ""),
      squadraOspite: String(m.squadraOspite || ""),
      setCasa: Number(m.setCasa || 0),
      setOspite: Number(m.setOspite || 0),
      punteggiSet: Array.isArray(m.punteggiSet) ? m.punteggiSet.map(String) : [],
      campo: String(m.campo || "")
    }));
    try {
      let current = null;
      try { current = await githubFile(env); } catch (e) {
        if (!String(e.message).includes("404")) throw e;
      }
      // Allenamenti: se l'admin li manda li salvo, altrimenti tengo quelli già presenti nel file
      let allenamenti;
      if (body.allenamenti !== undefined) allenamenti = pulisciAllenamenti(body.allenamenti);
      else if (current) {
        try { allenamenti = JSON.parse(decodeURIComponent(escape(atob(current.content.replace(/\n/g, ""))))).allenamenti; } catch {}
      }
      const dati = { partite: clean, ...(allenamenti ? { allenamenti } : {}) };
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(dati, null, 2) + "\n")));
      const api = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${JSON_PATH}`;
      const resp = await fetch(api, {
        method: "PUT",
        headers: ghHeaders(env),
        body: JSON.stringify({
          message: "Aggiorna risultati volley",
          content,
          branch: env.GH_BRANCH || "main",
          ...(current?.sha ? { sha: current.sha } : {})
        })
      });
      if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
      return json({ ok: true, partite: clean, ...(allenamenti ? { allenamenti } : {}) }, 200, cors);
    } catch (e) {
      return json({ error: "Scrittura su GitHub fallita: " + e.message }, 502, cors);
    }
  }
};

// ================= STATISTICHE ANONIME =================
// Archivio: database Cloudflare D1 collegato al Worker con il nome "DB".
// Si salva solo: giorno, ora, un codice casuale del telefono (non riconducibile a una persona),
// tipo di dispositivo e quali sezioni/funzioni sono state usate. Nessun cookie, nessun indirizzo IP.
let tabellePronte = false;
async function preparaTabelle(env) {
  if (tabellePronte || !env.DB) return !!env.DB;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS visite (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, giorno TEXT, ora INTEGER,
      vid TEXT, nuovo INTEGER, seguito INTEGER, interno INTEGER, modalita TEXT, dispositivo TEXT, durata INTEGER,
      viste TEXT, funzioni TEXT, errori TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS visite_giorno ON visite(giorno)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS iscrizioni (endpoint TEXT PRIMARY KEY, dati TEXT, ts INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS notifiche (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, titolo TEXT, testo TEXT, url TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS impostazioni (nome TEXT PRIMARY KEY, valore TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS live (id INTEGER PRIMARY KEY, dati TEXT, ts INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS accessi_admin (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, esito TEXT,
      tipo TEXT, dispositivo TEXT, browser TEXT, luogo TEXT)`),
  ]);
  tabellePronte = true;
  return true;
}
function oraRoma(ts = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { giorno: `${p.year}-${p.month}-${p.day}`, ora: Number(p.hour) };
}
function contatori(o, ammessi) {   // {nome: numero} con nomi semplici e numeri piccoli
  const out = {};
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o).slice(0, 40))
    if (/^[a-z0-9_-]{1,30}$/.test(k) && Number.isFinite(+v) && +v > 0) out[k] = Math.min(+v, 50);
  return JSON.stringify(out);
}
async function registraVisita(request, env, cors) {
  if (request.method !== "POST") return new Response(null, { status: 204, headers: cors });
  try {
    if (!(await preparaTabelle(env))) return new Response(null, { status: 204, headers: cors });
    const testo = await request.text();
    if (testo.length > 4000) return new Response(null, { status: 204, headers: cors });
    const b = JSON.parse(testo), { giorno, ora } = oraRoma();
    await env.DB.prepare(`INSERT INTO visite (ts, giorno, ora, vid, nuovo, seguito, interno, modalita, dispositivo, durata, viste, funzioni, errori)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      Date.now(), giorno, ora, /^[a-f0-9]{8,32}$/.test(b.vid || "") ? b.vid : "anonimo", b.nuovo ? 1 : 0, b.seguito ? 1 : 0,
      b.interno ? 1 : 0, b.modalita === "app" ? "app" : "browser",
      ["telefono", "tablet", "computer"].includes(b.dispositivo) ? b.dispositivo : "altro",
      Math.max(0, Math.min(Number(b.durata) || 0, 7200)), contatori(b.viste), contatori(b.funzioni), contatori(b.errori)).run();
    if (Math.random() < 0.02)   // ogni tanto cancello i dati più vecchi di 13 mesi
      await env.DB.prepare(`DELETE FROM visite WHERE ts < ?`).bind(Date.now() - 400 * 864e5).run();
  } catch (e) { /* le statistiche non devono mai disturbare il sito */ }
  return new Response(null, { status: 204, headers: cors });
}
function leggiDispositivo(ua) {
  const dispositivo = /iPad|Tablet/i.test(ua) ? "tablet" : /Mobi|Android|iPhone/i.test(ua) ? "telefono" : "computer";
  const sistema = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "";
  const browser = /SamsungBrowser/i.test(ua) ? "Samsung Internet" : /Edg\//i.test(ua) ? "Edge" : /Firefox|FxiOS/i.test(ua) ? "Firefox"
    : /Chrome|CriOS/i.test(ua) ? "Chrome" : /Safari/i.test(ua) ? "Safari" : "altro";
  return { dispositivo, browser: [browser, sistema].filter(Boolean).join(" su ") };
}
async function registraAccessoAdmin(request, env, ok, tipo) {
  try {
    if (!(await preparaTabelle(env))) return;
    const { dispositivo, browser } = leggiDispositivo(request.headers.get("User-Agent") || "");
    const cf = request.cf || {};
    const luogo = [cf.city, cf.country].filter(Boolean).join(", ");
    await env.DB.prepare(`INSERT INTO accessi_admin (ts, esito, tipo, dispositivo, browser, luogo) VALUES (?,?,?,?,?,?)`)
      .bind(Date.now(), ok ? "ok" : "password errata", tipo, dispositivo, browser, luogo).run();
  } catch (e) {}
}
async function statistiche(request, env, cors) {
  if (request.method !== "POST") return json({ error: "Metodo non consentito" }, 405, cors);
  let b; try { b = await request.json(); } catch { return json({ error: "JSON non valido" }, 400, cors); }
  if (!env.ADMIN_PASSWORD || String(b.password || "").trim() !== String(env.ADMIN_PASSWORD).trim())
    return json({ error: "Password errata" }, 401, cors);
  if (!(await preparaTabelle(env))) return json({ error: "archivio non configurato: collega al Worker un database D1 con il nome DB" }, 501, cors);
  const giorni = Math.max(1, Math.min(Number(b.giorni) || 30, 365));
  const dal = oraRoma(Date.now() - (giorni - 1) * 864e5).giorno;
  const righe = (await env.DB.prepare(`SELECT giorno, ora, vid, nuovo, seguito, modalita, dispositivo, durata, viste, funzioni, errori
    FROM visite WHERE interno = 0 AND giorno >= ? ORDER BY ts`).bind(dal).all()).results || [];
  // per la fedeltà mi serve anche lo storico precedente dei codici
  const storico = (await env.DB.prepare(`SELECT vid, MIN(giorno) AS primo, GROUP_CONCAT(DISTINCT giorno) AS giorni
    FROM visite WHERE interno = 0 AND seguito = 0 GROUP BY vid`).all()).results || [];
  const interne = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM visite WHERE interno = 1 AND seguito = 0 AND giorno >= ?`).bind(dal).first()) || { n: 0 };
  const accessi = (await env.DB.prepare(`SELECT ts, esito, tipo, dispositivo, browser, luogo FROM accessi_admin ORDER BY ts DESC LIMIT 40`).all()).results || [];
  return json({ giorni, dal, righe, storico, visiteInterne: interne.n, accessi }, 200, cors);
}

// ================= NOTIFICHE SUI TELEFONI (Web Push) =================
// Le chiavi di firma (VAPID) vengono create da sole la prima volta e salvate nel database.
// La notifica parte "vuota": il telefono, ricevuta la spinta, chiede a /push/ultima il testo da mostrare.
const SITO = "https://cuggini.github.io/lvt-volley/";
const LOTTO = 40;   // telefoni avvisati per ogni chiamata (limite di richieste del piano gratuito Cloudflare)
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const testoB64u = t => b64u(new TextEncoder().encode(t));
async function chiaviVapid(env) {
  const r = await env.DB.prepare(`SELECT valore FROM impostazioni WHERE nome = 'vapid'`).first();
  if (r) return JSON.parse(r.valore);
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const chiavi = { privata: await crypto.subtle.exportKey("jwk", k.privateKey), pubblica: b64u(await crypto.subtle.exportKey("raw", k.publicKey)) };
  await env.DB.prepare(`INSERT OR IGNORE INTO impostazioni (nome, valore) VALUES ('vapid', ?)`).bind(JSON.stringify(chiavi)).run();
  const salvata = await env.DB.prepare(`SELECT valore FROM impostazioni WHERE nome = 'vapid'`).first();
  return JSON.parse(salvata.valore);
}
async function firmaVapid(chiavi, endpoint) {
  const aud = new URL(endpoint).origin;
  const intest = testoB64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const corpo = testoB64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITO }));
  const chiave = await crypto.subtle.importKey("jwk", chiavi.privata, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chiave, new TextEncoder().encode(`${intest}.${corpo}`));
  return `vapid t=${intest}.${corpo}.${b64u(firma)}, k=${chiavi.pubblica}`;
}
const passwordOk = (env, pw, anchePapa) => {
  const p = String(pw || "").trim();
  if (!p) return false;
  if (env.ADMIN_PASSWORD && p === String(env.ADMIN_PASSWORD).trim()) return true;
  return !!(anchePapa && env.LIVE_PASSWORD && p === String(env.LIVE_PASSWORD).trim());
};
async function creaNotifica(env, titolo, testo) {
  titolo = String(titolo || "LVT Volley").slice(0, 80); testo = String(testo || "").slice(0, 300);
  const r = await env.DB.prepare(`INSERT INTO notifiche (ts, titolo, testo, url) VALUES (?,?,?,?)`).bind(Date.now(), titolo, testo, SITO).run();
  return r.meta.last_row_id;
}
async function inviaLotto(env, da) {   // avvisa i telefoni da "da" in poi, LOTTO alla volta
  const chiavi = await chiaviVapid(env);
  const subs = (await env.DB.prepare(`SELECT endpoint FROM iscrizioni ORDER BY ts LIMIT ? OFFSET ?`).bind(LOTTO, da).all()).results || [];
  let inviate = 0, scadute = [];
  await Promise.all(subs.map(async ({ endpoint }) => {
    try {
      const r = await fetch(endpoint, { method: "POST", headers: { Authorization: await firmaVapid(chiavi, endpoint), TTL: "86400", Urgency: "high", "Content-Length": "0" } });
      if (r.status === 404 || r.status === 410) scadute.push(endpoint); else if (r.ok) inviate++;
    } catch (e) {}
  }));
  for (const e of scadute) await env.DB.prepare(`DELETE FROM iscrizioni WHERE endpoint = ?`).bind(e).run();
  const totale = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM iscrizioni`).first()).n;
  const prossimo = da - scadute.length + subs.length;
  return { inviate, rimosse: scadute.length, prossimo: subs.length === LOTTO && prossimo < totale ? prossimo : null, totale };
}
function tipoDispositivo(ua) {
  ua = String(ua || "");
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android" : "Tablet Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "PC Windows";
  if (/Linux|CrOS/.test(ua)) return "Computer";
  return "Sconosciuto";
}
async function gestisciPush(request, env, cors, path) {
  if (!(await preparaTabelle(env))) return json({ error: "archivio non configurato: collega al Worker un database D1 con il nome DB" }, 501, cors);
  try {
    if (path === "/push/chiave") return json({ chiave: (await chiaviVapid(env)).pubblica }, 200, cors);
    if (path === "/push/ultima") {   // l'ultima news inviata (o rimandata): il clic apre il sito su quella news
      const n = await env.DB.prepare(`SELECT id, ts, titolo, testo FROM notifiche ORDER BY ts DESC, id DESC LIMIT 1`).first();
      return json(n ? { ...n, url: `${SITO}?news=${n.id}` } : { titolo: "LVT Volley", testo: "Ci sono novità sul sito", url: SITO }, 200, cors);
    }
    if (path === "/push/news") {   // archivio pubblico delle news
      const r = await env.DB.prepare(`SELECT id, ts, titolo, testo FROM notifiche ORDER BY ts DESC, id DESC LIMIT 50`).all();
      return json({ news: r.results || [] }, 200, cors);
    }
    if (request.method !== "POST") return json({ error: "Metodo non consentito" }, 405, cors);
    const b = await request.json().catch(() => ({}));
    if (path === "/push/iscrivi") {
      const s = b.iscrizione || {};
      if (!/^https:\/\//.test(s.endpoint || "") || String(s.endpoint).length > 800) return json({ error: "iscrizione non valida" }, 400, cors);
      // solo dati tecnici: tipo di dispositivo (dal browser) e data della prima iscrizione
      const prima = await env.DB.prepare(`SELECT dati, ts FROM iscrizioni WHERE endpoint = ?`).bind(s.endpoint).first();
      let vecchi = {}; try { vecchi = JSON.parse(prima && prima.dati || "{}"); } catch (e) {}
      const dati = { disp: tipoDispositivo(request.headers.get("User-Agent")), dal: vecchi.dal || (prima ? prima.ts : Date.now()) };
      await env.DB.prepare(`INSERT INTO iscrizioni (endpoint, dati, ts) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET dati = excluded.dati, ts = excluded.ts`)
        .bind(s.endpoint, JSON.stringify(dati), Date.now()).run();
      return json({ ok: true }, 200, cors);
    }
    if (path === "/push/annulla") {
      await env.DB.prepare(`DELETE FROM iscrizioni WHERE endpoint = ?`).bind(String(b.endpoint || "")).run();
      return json({ ok: true }, 200, cors);
    }
    // chi segna la diretta può solo completare l'invio (a lotti) della notifica di fine partita appena creata
    let ammesso = passwordOk(env, b.password);
    if (!ammesso && path === "/push/invia" && Number(b.da) > 0 && passwordOk(env, b.password, true)) {
      const ult = await env.DB.prepare(`SELECT ts FROM notifiche ORDER BY ts DESC LIMIT 1`).first();
      ammesso = !!ult && Date.now() - ult.ts < 10 * 60000;
    }
    if (!ammesso) return json({ error: "Password errata" }, 401, cors);
    if (path === "/push/stato") {
      const righe = (await env.DB.prepare(`SELECT dati, ts FROM iscrizioni ORDER BY ts DESC`).all()).results || [];
      const elenco = righe.map(r => { let d = {}; try { d = JSON.parse(r.dati || "{}"); } catch (e) {} return { disp: d.disp || "Sconosciuto", dal: d.dal || r.ts, ultimo: r.ts }; })
        .sort((a, b) => b.dal - a.dal);
      const ultime = (await env.DB.prepare(`SELECT id, ts, titolo, testo FROM notifiche ORDER BY ts DESC, id DESC LIMIT 30`).all()).results || [];
      return json({ iscritti: elenco.length, elenco, ultime }, 200, cors);
    }
    if (["/push/cancella", "/push/rimanda", "/push/modifica"].includes(path)) {
      const id = Number(b.id);
      const n = await env.DB.prepare(`SELECT id FROM notifiche WHERE id = ?`).bind(id).first();
      if (!n) return json({ error: "News non trovata" }, 404, cors);
      if (path === "/push/cancella") {
        await env.DB.prepare(`DELETE FROM notifiche WHERE id = ?`).bind(id).run();
        return json({ ok: true }, 200, cors);
      }
      if (path === "/push/modifica") {
        if (!String(b.testo || "").trim()) return json({ error: "Scrivi il testo della notifica" }, 400, cors);
        await env.DB.prepare(`UPDATE notifiche SET titolo = ?, testo = ? WHERE id = ?`)
          .bind(String(b.titolo || "LVT Volley").slice(0, 80), String(b.testo).slice(0, 300), id).run();
        if (!b.invia) return json({ ok: true }, 200, cors);
      }
      // rimanda: la news torna in cima (è quella che i telefoni mostreranno) e parte di nuovo
      await env.DB.prepare(`UPDATE notifiche SET ts = ? WHERE id = ?`).bind(Date.now(), id).run();
      return json({ ok: true, ...(await inviaLotto(env, 0)) }, 200, cors);
    }
    if (path === "/push/invia") {
      const da = Math.max(0, Number(b.da) || 0);
      if (!da) { if (!String(b.testo || "").trim()) return json({ error: "Scrivi il testo della notifica" }, 400, cors); await creaNotifica(env, b.titolo, b.testo); }
      return json({ ok: true, ...(await inviaLotto(env, da)) }, 200, cors);
    }
    return json({ error: "Endpoint non trovato" }, 404, cors);
  } catch (e) { return json({ error: "Errore notifiche: " + e.message }, 500, cors); }
}

// ================= PUNTEGGIO IN DIRETTA =================
// Un genitore in palestra aggiorna i set con la password "live" (variabile LIVE_PASSWORD);
// il sito legge /live ogni 20 secondi quando c'è una partita LVT in giornata.
const DURATA_LIVE = 5 * 3600 * 1000;   // dopo 5 ore senza aggiornamenti la diretta sparisce
function pulisciLive(b) {
  const set = (Array.isArray(b.set) ? b.set : []).slice(0, 5)
    .map(x => [Math.max(0, Math.min(99, Number(x && x[0]) || 0)), Math.max(0, Math.min(99, Number(x && x[1]) || 0))]);
  return { id: Number(b.id), set };
}
async function gestisciLive(request, env, cors, path) {
  if (!(await preparaTabelle(env))) return json({ error: "archivio non configurato: collega al Worker un database D1 con il nome DB" }, 501, cors);
  try {
    if (path === "/live" && request.method === "GET") {
      const r = await env.DB.prepare(`SELECT dati, ts FROM live WHERE ts > ? ORDER BY ts DESC`).bind(Date.now() - DURATA_LIVE).all();
      return json({ dirette: (r.results || []).map(x => ({ ...JSON.parse(x.dati), ts: x.ts })) }, 200, cors);
    }
    if (request.method !== "POST") return json({ error: "Metodo non consentito" }, 405, cors);
    const b = await request.json().catch(() => ({}));
    if (!passwordOk(env, b.password, true)) return json({ error: "Password errata" }, 401, cors);
    if (path === "/live/auth") return json({ ok: true }, 200, cors);
    const d = pulisciLive(b);
    if (!Number.isFinite(d.id)) return json({ error: "Partita non indicata" }, 400, cors);
    if (path === "/live") {
      await env.DB.prepare(`INSERT INTO live (id, dati, ts) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET dati = excluded.dati, ts = excluded.ts`)
        .bind(d.id, JSON.stringify(d), Date.now()).run();
      return json({ ok: true }, 200, cors);
    }
    if (path === "/live/annulla") {
      await env.DB.prepare(`DELETE FROM live WHERE id = ?`).bind(d.id).run();
      return json({ ok: true }, 200, cors);
    }
    if (path === "/live/fine") {   // salva il risultato finale nel file del sito e chiude la diretta
      const chiusi = d.set.filter(([x, y], i) => Math.max(x, y) >= (i === 4 ? 15 : 25) && Math.abs(x - y) >= 2);
      const setCasa = chiusi.filter(([x, y]) => x > y).length, setOspite = chiusi.length - setCasa;
      let partita;
      await modificaFile(env, dati => {
        partita = (dati.partite || []).find(m => Number(m.id) === d.id);
        if (!partita) throw new Error("partita non trovata");
        partita.setCasa = setCasa; partita.setOspite = setOspite;
        partita.punteggiSet = chiusi.map(([x, y]) => `${x}-${y}`);
        return "Risultato finale dal campo";
      });
      await env.DB.prepare(`DELETE FROM live WHERE id = ?`).bind(d.id).run();
      let notifica = null;
      if (b.notifica) {
        await creaNotifica(env, `🏐 Finale ${partita.competizione || ""}`.trim(),
          `${partita.squadraCasa} ${setCasa}-${setOspite} ${partita.squadraOspite} (${partita.punteggiSet.join(", ")})`);
        notifica = await inviaLotto(env, 0);
      }
      return json({ ok: true, setCasa, setOspite, notifica }, 200, cors);
    }
    return json({ error: "Endpoint non trovato" }, 404, cors);
  } catch (e) { return json({ error: "Errore diretta: " + e.message }, 500, cors); }
}
async function modificaFile(env, cambia) {   // legge risultati.json da GitHub, lo modifica e lo riscrive
  const current = await githubFile(env);
  const dati = JSON.parse(decodeURIComponent(escape(atob(current.content.replace(/\n/g, "")))));
  const messaggio = cambia(dati) || "Aggiorna risultati volley";
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(dati, null, 2) + "\n")));
  const resp = await fetch(`https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${JSON_PATH}`, {
    method: "PUT", headers: ghHeaders(env),
    body: JSON.stringify({ message: messaggio, content, branch: env.GH_BRANCH || "main", sha: current.sha })
  });
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
}

function pulisciAllenamenti(a) {
  if (!a || typeof a !== "object") return undefined;
  const giorno = /^\d{4}-\d{2}-\d{2}$/, ora = /^\d{1,2}:\d{2}$/;
  const serie = (Array.isArray(a.serie) ? a.serie : []).map(s => ({
    id: String(s.id || ""), giorno: Number(s.giorno),
    inizio: String(s.inizio || ""), fine: String(s.fine || ""), palestra: String(s.palestra || ""),
    dal: String(s.dal || ""), al: String(s.al || "")
  })).filter(s => s.id && s.giorno >= 0 && s.giorno <= 6 && ora.test(s.inizio) && ora.test(s.fine)
             && (!s.dal || giorno.test(s.dal)) && (!s.al || giorno.test(s.al)));
  const eccezioni = (Array.isArray(a.eccezioni) ? a.eccezioni : []).map(e => e.annullato
    ? { data: String(e.data || ""), serie: String(e.serie || ""), annullato: true }
    : { data: String(e.data || ""), serie: String(e.serie || ""), inizio: String(e.inizio || ""), fine: String(e.fine || ""), palestra: String(e.palestra || "") }
  ).filter(e => giorno.test(e.data) && e.serie);
  return { serie, eccezioni };
}

function ghHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lvt-volley-admin"
  };
}
async function githubFile(env) {
  const api = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${JSON_PATH}?ref=${env.GH_BRANCH || "main"}`;
  const resp = await fetch(api, { headers: ghHeaders(env) });
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
  return await resp.json();
}
function json(data, status, cors) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "CDN-Cache-Control": "no-store", "Pragma": "no-cache", "Expires": "0", ...cors } });
}
