// Edge Function "opendata" — API pubblica, SOLA LETTURA, dei dati EmergenzePrato.
// Espone come dato aperto solo le tabelle whitelisted (MAI em_config/em_push/vault).
// Pubblica (verify_jwt=false) + CORS, output JSON o CSV.
//
//   GET /functions/v1/opendata                      -> catalogo dataset
//   GET /functions/v1/opendata?dataset=em_letture   -> JSON (ultime righe)
//   GET /functions/v1/opendata?dataset=em_sismi&format=csv&limit=500

import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Whitelist: dataset pubblici + colonna di ordinamento (desc).
const DATASETS: Record<string, { desc: string; order: string }> = {
  em_letture:     { desc: "Letture idrometriche SIR (livelli fiumi) nel tempo", order: "inserito_il" },
  em_stato:       { desc: "Stato corrente per stazione fluviale (dedup allerte)", order: "aggiornato_il" },
  em_pluvio:      { desc: "Pioggia pluviometri SIR a monte del Bisenzio", order: "inserito_il" },
  em_sismi:       { desc: "Terremoti INGV entro 30 km da Prato (M>=2.0)", order: "ts" },
  em_allerta_dpc: { desc: "Allerta colore DPC (oggi/domani) per Prato", order: "inserito_il" },
  em_meteo:       { desc: "Snapshot previsione meteo oraria (Open-Meteo)", order: "inserito_il" },
  em_flood:       { desc: "Snapshot portata fluviale prevista (Open-Meteo/GloFAS)", order: "inserito_il" },
  em_lamma:       { desc: "Previsione settimanale LaMMA per Prato", order: "inserito_il" },
  em_fonti:       { desc: "Registry delle fonti dati del servizio", order: "chiave" },
};

const LICENZA = "Dati aggregati da fonti pubbliche (SIR Toscana, INGV, DPC/allertameteo.app, Open-Meteo, LaMMA); ogni fonte mantiene la propria licenza. Aggregazione a cura di EmergenzePrato, uso civico/indicativo. In emergenza fa fede la Protezione Civile.";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
}
function csvResp(rows: any[], name: string) {
  if (!rows.length) return new Response("", { headers: { ...CORS, "Content-Type": "text/csv; charset=utf-8" } });
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  return new Response(csv, { headers: { ...CORS, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const base = `${url.origin}${url.pathname}`;
  const ds = url.searchParams.get("dataset");
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 1000, 1), 5000);

  if (!ds) {
    return jsonResp({
      servizio: "EmergenzePrato — Open Data",
      descrizione: "Dati idro-meteo, sismici e di allerta per Prato, aggregati da fonti pubbliche.",
      canale_telegram: "https://t.me/+3ip1DgGs4OdkMGI8",
      licenza: LICENZA,
      parametri: { dataset: "nome tabella", format: "json|csv", limit: "1-5000 (default 1000)" },
      dataset: Object.entries(DATASETS).map(([k, v]) => ({
        dataset: k, descrizione: v.desc,
        json: `${base}?dataset=${k}`,
        csv: `${base}?dataset=${k}&format=csv`,
      })),
    });
  }

  if (!DATASETS[ds]) return jsonResp({ error: "dataset non valido", disponibili: Object.keys(DATASETS) }, 404);

  const conf = DATASETS[ds];
  const q = db.from(ds).select("*").limit(limit);
  const { data, error } = conf.order === "chiave"
    ? await q.order("chiave", { ascending: true })
    : await q.order(conf.order, { ascending: false });
  if (error) return jsonResp({ error: "lettura fallita", dettaglio: error.message }, 500);

  if (format === "csv") return csvResp(data ?? [], ds);
  return jsonResp({ dataset: ds, descrizione: conf.desc, righe: data?.length ?? 0, licenza: LICENZA, dati: data ?? [] });
});
