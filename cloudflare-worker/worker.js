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
    if (url.pathname === "/auth") {
      if (request.method !== "POST") return json({ error: "Metodo non consentito" }, 405, cors);
      let authBody;
      try { authBody = await request.json(); } catch { return json({ error: "JSON non valido" }, 400, cors); }
      const supplied = String(authBody.password || "").trim();
      const configured = String(env.ADMIN_PASSWORD || "").trim();
      if (!configured || supplied !== configured) return json({ error: "Password errata" }, 401, cors);
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
