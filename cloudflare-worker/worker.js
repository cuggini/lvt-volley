const JSON_PATH = "data/risultati.json";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed && origin === allowed ? origin : allowed,
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname !== "/results") return json({ error: "Endpoint non trovato" }, 404, cors);
    if (request.method === "GET") {
      try {
        const file = await githubFile(env);
        return json(JSON.parse(atob(file.content.replace(/\n/g, ""))), 200, cors);
      } catch (e) {
        return json({ error: "Impossibile leggere risultati.json: " + e.message }, 502, cors);
      }
    }
    if (request.method !== "PUT") return json({ error: "Metodo non consentito" }, 405, cors);
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON non valido" }, 400, cors); }
    if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) {
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
      const content = btoa(unescape(encodeURIComponent(JSON.stringify({ partite: clean }, null, 2) + "\n")));
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
      return json({ ok: true, partite: clean }, 200, cors);
    } catch (e) {
      return json({ error: "Scrittura su GitHub fallita: " + e.message }, 502, cors);
    }
  }
};

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
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
}
