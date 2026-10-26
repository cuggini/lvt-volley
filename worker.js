const JSON_PATH = "data/risultati.json";

export default {
  async fetch(request, env) {
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
