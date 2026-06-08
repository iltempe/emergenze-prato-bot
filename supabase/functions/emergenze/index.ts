// Edge Function "emergenze" — port TypeScript della pipeline Python.
// Sostituisce i workflow GitHub Actions con uno scheduler affidabile (pg_cron).
//
// Modalita' (querystring ?mode= o body {"mode": ...}):
//   - "tick" (default): poll idrometrico SIR (allerte) + monitor Protezione Civile.
//                       Invocata ogni 5 min da pg_cron -> latenza <= ~5 min.
//   - "bollettino":     riepilogo giornaliero di tutti i fiumi (notifica silenziosa).
//
// Segreti: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID letti dalla tabella em_config
// (RLS, accessibile solo col service_role). SUPABASE_URL / SERVICE_ROLE_KEY sono
// iniettati automaticamente nell'ambiente Edge.
//
// Stato/serie storica su Supabase: em_letture, em_stato, em_pc_stato (come prima).

import { createClient } from "jsr:@supabase/supabase-js@2";

// ===========================================================================
// CONFIG
// ===========================================================================
const RATEO_RAPIDO_M = 0.15;
const NOTIFICA_RIENTRO = true;

const DISCLAIMER =
  "ℹ️ Dati SIR Toscana acquisiti in tempo reale e <b>non validati</b>. " +
  "Uso indicativo: in emergenza segui sempre le indicazioni della Protezione Civile.";

const FONTE_SIR =
  "🔗 Fonte: SIR Toscana\n" +
  "https://www.sir.toscana.it/monitoraggio/stazioni.php?type=idro";

const FONTE_PC =
  "🔗 Fonte: Protezione Civile Comune di Prato\n" +
  "https://emergenze.comune.prato.it/mirror_emergenze/it/pagina2413.html";

// ===========================================================================
// ANAGRAFICA STAZIONI + PUNTI CRITICI (port di stations.py / punti_critici.json)
// ===========================================================================
interface Stazione {
  codice: string; fiume: string; nome: string;
  posizione: string; bacino: string; ordine: number;
}
const STAZIONI_PRATO: Stazione[] = [
  { codice: "TOS01004779", fiume: "Bisenzio", nome: "Gamberame", posizione: "monte", bacino: "Bisenzio", ordine: 1 },
  { codice: "TOS01004782", fiume: "Bisenzio", nome: "Prato (RADIO)", posizione: "citta", bacino: "Bisenzio", ordine: 2 },
  { codice: "TOS01004791", fiume: "Bisenzio", nome: "S. Piero a Ponti", posizione: "valle", bacino: "Bisenzio", ordine: 3 },
  { codice: "TOS01004875", fiume: "Ombrone PT", nome: "Poggio a Caiano", posizione: "valle", bacino: "Ombrone PT", ordine: 2 },
  { codice: "TOS15004865", fiume: "Ombrone PT", nome: "Ponte alle Vanne (Cassa)", posizione: "cassa", bacino: "Ombrone PT", ordine: 3 },
];
const CODICI_PRATO = new Set(STAZIONI_PRATO.map((s) => s.codice));
function meta(codice: string): Stazione | undefined {
  return STAZIONI_PRATO.find((s) => s.codice === codice);
}

const PUNTI_CRITICI: Record<string, any> = {
  "TOS01004779": {
    etichetta: "Bisenzio a Gamberame (monte)",
    soglia1_significato: "guardia", soglia2_significato: "allarme",
    azioni_soglia1: "Bisenzio in crescita a monte. Tempo stimato all'arrivo a Prato citta': ~1-2 h (da tarare). Tieni d'occhio.",
    azioni_soglia2: "Onda di piena importante in arrivo verso Prato. Allontanati da argini e aree golenali.",
    punti: [],
  },
  "TOS01004782": {
    etichetta: "Bisenzio a Prato (citta')",
    soglia1_significato: "guardia", soglia2_significato: "allarme",
    azioni_soglia1: "Non sostare in locali interrati/seminterrati. Non parcheggiare lungo il fiume.",
    azioni_soglia2: "NON entrare nei sottopassi. Allontanati dai piani interrati. Sali ai piani alti se in zona allagabile.",
    punti: [{ nome: "Sottopassi cittadini di Prato", tipo: "sottopasso", azione: "Punto critico storico n.1: mai entrare col semaforo/segnale rosso, rischio annegamento in auto." }],
  },
  "TOS01004791": {
    etichetta: "Bisenzio a S. Piero a Ponti (valle)",
    soglia1_significato: "guardia", soglia2_significato: "allarme",
    azioni_soglia1: "Deflusso a valle in aumento. Rilevante per Campi Bisenzio.",
    azioni_soglia2: "Criticita' a valle: aree di Campi Bisenzio a rischio.",
    punti: [],
  },
  "TOS01004875": {
    etichetta: "Ombrone PT a Poggio a Caiano",
    soglia1_significato: "guardia", soglia2_significato: "allarme",
    azioni_soglia1: "Ombrone in crescita. Attenzione nelle zone golenali.",
    azioni_soglia2: "Ombrone in allarme: allontanati dalle aree perifluviali.",
    punti: [],
  },
  "TOS15004865": {
    etichetta: "Ombrone PT - Cassa di Ponte alle Vanne",
    soglia1_significato: "riempimento", soglia2_significato: "prossima saturazione",
    azioni_soglia1: "La cassa sta lavorando (si sta riempiendo).",
    azioni_soglia2: "Cassa verso saturazione: ridotta capacita' di laminazione a valle.",
    punti: [],
  },
};
function puntiCritici(codice: string): any {
  return PUNTI_CRITICI[codice] ?? {};
}

// ===========================================================================
// HTTP helper
// ===========================================================================
async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "EmergenzePrato-monitor/0.2 (+progetto allerta Prato)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} su ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// ===========================================================================
// SIR SCRAPER (port di sir_scraper.py)
// ===========================================================================
const SIR_BASE = "https://www.sir.toscana.it/monitoraggio/stazioni.php";
const IDX = { codice: 0, fiume: 1, localita: 2, soglia1: 6, soglia2: 7, livello: 8, rateo_0: 10, rateo_1: 11, rateo_2: 12, timestamp: 13 };

interface Lettura {
  codice: string; fiume: string; nome: string; localita: string;
  posizione: string | null;
  livello_m: number | null; soglia1_m: number | null; soglia2_m: number | null;
  ratei: (number | null)[]; timestamp: string;
  sopra_soglia1: boolean | null; sopra_soglia2: boolean | null;
}

function toFloat(val: string | undefined): number | null {
  if (val === undefined || val === null) return null;
  const v = val.trim().replace(",", ".");
  if (["", "-", "n.d.", "nd", "N.D."].includes(v)) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

async function sirFetchRaw(url: string): Promise<string> {
  const r1 = await fetchText(url);
  const m = r1.match(/stazioni\.php\?type=[a-z]+&(?:amp;)?extra=([A-Za-z0-9]+)/);
  if (!m) {
    if (r1.includes("Array(")) return r1;
    throw new Error("Hash 'extra' non trovato e nessun array inline: struttura SIR cambiata?");
  }
  return await fetchText(`${url}&extra=${m[1]}`);
}
const SIR_IDRO_URL = "https://www.sir.toscana.it/monitoraggio/stazioni.php?type=idro";

function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  for (const stmt of text.split(";")) {
    const pos = stmt.indexOf("Array(");
    if (pos === -1) continue;
    const block = stmt.slice(pos + "Array(".length);
    const flat: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(block)) !== null) flat.push(mm[1] !== undefined ? mm[1] : mm[2]);
    if (flat.length && /^TOS\d+/.test(flat[0])) records.push(flat);
  }
  return records;
}

function parsePayload(text: string, soloPrato = true): Lettura[] {
  const out: Lettura[] = [];
  for (const rec of splitRecords(text)) {
    if (rec.length <= IDX.timestamp) continue;
    const codice = rec[IDX.codice];
    if (soloPrato && !CODICI_PRATO.has(codice)) continue;
    const livello = toFloat(rec[IDX.livello]);
    const raw = [toFloat(rec[IDX.soglia1]), toFloat(rec[IDX.soglia2])].filter((v): v is number => v !== null).sort((a, b) => a - b);
    const s1 = raw.length >= 1 ? raw[0] : null;
    const s2 = raw.length >= 2 ? raw[1] : null;
    const m = meta(codice);
    out.push({
      codice, fiume: rec[IDX.fiume],
      nome: m?.nome ?? rec[IDX.localita], localita: rec[IDX.localita],
      posizione: m?.posizione ?? null,
      livello_m: livello, soglia1_m: s1, soglia2_m: s2,
      ratei: [toFloat(rec[IDX.rateo_0]), toFloat(rec[IDX.rateo_1]), toFloat(rec[IDX.rateo_2])],
      timestamp: rec[IDX.timestamp],
      sopra_soglia1: livello !== null && s1 !== null ? livello >= s1 : null,
      sopra_soglia2: livello !== null && s2 !== null ? livello >= s2 : null,
    });
  }
  return out;
}

// ===========================================================================
// ALERT ENGINE (port di alert_engine.py)
// ===========================================================================
const RANK: Record<string, number> = { calma: 0, soglia1: 1, soglia2: 2 };
const EMOJI: Record<string, string> = { calma: "🟢", soglia1: "🟠", soglia2: "🔴" };

function statoDaLivello(l: Lettura): string {
  if (l.sopra_soglia2) return "soglia2";
  if (l.sopra_soglia1) return "soglia1";
  return "calma";
}
function trend(rateo: number | null): string {
  if (rateo === null) return "trend n.d.";
  if (rateo > 0.02) return `in salita (${rateo >= 0 ? "+" : ""}${rateo.toFixed(2)} m/intervallo)`;
  if (rateo < -0.02) return `in calo (${rateo.toFixed(2)} m/intervallo)`;
  return "stabile";
}
function fmtM(v: number | null): string {
  return v !== null ? `${v.toFixed(2)} m` : "n.d.";
}
function azioni(codice: string, stato: string): string {
  const pc = puntiCritici(codice);
  const righe: string[] = [];
  if (stato === "soglia2" && pc.azioni_soglia2) righe.push(pc.azioni_soglia2);
  else if (stato === "soglia1" && pc.azioni_soglia1) righe.push(pc.azioni_soglia1);
  for (const p of pc.punti ?? []) righe.push(`• <b>${p.nome}</b>: ${p.azione}`);
  return righe.join("\n");
}
function msgAllerta(l: Lettura, stato: string): string {
  const pc = puntiCritici(l.codice);
  const et = pc.etichetta ?? `${l.fiume} - ${l.nome}`;
  const sig = pc[`${stato}_significato`] ?? stato;
  const soglia = stato === "soglia2" ? l.soglia2_m : l.soglia1_m;
  const sogliaS = soglia !== null ? `${soglia.toFixed(2)} m` : "?";
  const az = azioni(l.codice, stato);
  return (
    `${EMOJI[stato]} <b>ALLERTA ${String(sig).toUpperCase()}</b> — ${et}\n` +
    `Livello <b>${fmtM(l.livello_m)}</b> (soglia ${sig} ${sogliaS}), ${trend(l.ratei[0])}.\n` +
    (az ? `\n${az}\n` : "") +
    `\n🕒 aggiornato ${l.timestamp}\n${DISCLAIMER}\n\n${FONTE_SIR}`
  );
}
function msgRapido(l: Lettura): string {
  const pc = puntiCritici(l.codice);
  const et = pc.etichetta ?? `${l.fiume} - ${l.nome}`;
  const r = l.ratei[0]!;
  return (
    `⚡ <b>SALITA RAPIDA</b> — ${et}\n` +
    `Livello ancora sotto soglia (${fmtM(l.livello_m)}) ma sta salendo in fretta ` +
    `(${r >= 0 ? "+" : ""}${r.toFixed(2)} m/intervallo). Tieni d'occhio.\n` +
    `\n🕒 aggiornato ${l.timestamp}\n${DISCLAIMER}\n\n${FONTE_SIR}`
  );
}
function msgRientro(l: Lettura): string {
  const pc = puntiCritici(l.codice);
  const et = pc.etichetta ?? `${l.fiume} - ${l.nome}`;
  return (
    `🟢 <b>RIENTRO</b> — ${et}\n` +
    `Livello tornato sotto soglia (${fmtM(l.livello_m)}). Situazione in normalizzazione.\n` +
    `🕒 aggiornato ${l.timestamp}\n\n${FONTE_SIR}`
  );
}

interface StatoRow { codice: string; fiume: string; nome: string; ultimo_livello: number | null; ultimo_stato: string; rapido_attivo: boolean; aggiornato_il: string; }

function valuta(letture: Lettura[], statoPrec: Record<string, any>): { messaggi: string[]; nuovoStato: StatoRow[] } {
  const messaggi: string[] = [];
  const nuovoStato: StatoRow[] = [];
  const ora = new Date().toISOString();
  for (const l of letture) {
    const prev = statoPrec[l.codice] ?? {};
    const prevStato = prev.ultimo_stato ?? "calma";
    const prevRapido = Boolean(prev.rapido_attivo ?? false);
    const corr = statoDaLivello(l);
    const rateo = l.ratei[0] ?? null;
    const rapido = rateo !== null && rateo >= RATEO_RAPIDO_M;

    if (RANK[corr] > RANK[prevStato]) messaggi.push(msgAllerta(l, corr));
    else if (RANK[corr] < RANK[prevStato] && corr === "calma") {
      if (NOTIFICA_RIENTRO) messaggi.push(msgRientro(l));
    }
    if (rapido && !prevRapido && corr === "calma") messaggi.push(msgRapido(l));

    nuovoStato.push({
      codice: l.codice, fiume: l.fiume, nome: l.nome,
      ultimo_livello: l.livello_m, ultimo_stato: corr,
      rapido_attivo: rapido, aggiornato_il: ora,
    });
  }
  return { messaggi, nuovoStato };
}
function rigaLettureDb(letture: Lettura[]): any[] {
  return letture.map((l) => ({
    codice: l.codice, fiume: l.fiume, nome: l.nome,
    livello_m: l.livello_m, soglia1_m: l.soglia1_m, soglia2_m: l.soglia2_m,
    rateo: l.ratei[0] ?? null, ts_sir: l.timestamp,
  }));
}

// ===========================================================================
// PC PRATO (port di pc_prato.py)
// ===========================================================================
const PC_URL = "https://emergenze.comune.prato.it/mirror_emergenze/it/pagina2413.html";
const PC_EMOJI: Record<string, string> = { green: "🟢", lime: "🟢", yellow: "🟡", gold: "🟡", orange: "🟠", red: "🔴", darkred: "🔴" };
const RE_PREFISSO = /^\s*\d{1,2}[./]\d{1,2}[./]\d{2,4}\s+ore\s+\d{1,2}[:.]\d{2}\s*[-–:]\s*/i;

interface StatoPC { colore: string; testo: string; messaggioNorm: string; }

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", agrave: "à", egrave: "è", igrave: "ì", ograve: "ò", ugrave: "ù", eacute: "é" };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const code = (e[1] === "x" || e[1] === "X") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return named[e] ?? m;
  });
}
function cleanPc(s: string): string {
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/\x00/g, "à"); // byte nullo nella pagina = carattere accentato (es. 'à' di normalità)
  s = Array.from(s).filter((ch) => ch >= " ").join("");
  s = s.replace(/\s+/g, " ");
  return s.trim();
}
function parsePc(htmlText: string): StatoPC | null {
  const idx = htmlText.indexOf('id="regola_default"');
  if (idx < 0) return null; // contenitore di stato assente -> pagina di errore/WAF
  const blocco = htmlText.slice(idx, idx + 3000);
  const cm = blocco.match(/fa-circle[^>]*style="[^"]*color:\s*([a-zA-Z]+)/i);
  if (!cm) return null; // nessuna icona di stato colorata
  const colore = cm[1].toLowerCase();
  const sm = blocco.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
  if (!sm) return null;
  const testo = cleanPc(sm[1]);
  if (!testo) return null;
  const messaggioNorm = testo.replace(RE_PREFISSO, "").trim().toLowerCase();
  return { colore, testo, messaggioNorm };
}
function pcEmoji(colore: string): string { return PC_EMOJI[colore.toLowerCase()] ?? "ℹ️"; }
function pcIsNormalita(colore: string): boolean { return ["green", "lime"].includes(colore.toLowerCase()); }
async function pcHash(st: StatoPC): Promise<string> {
  const data = new TextEncoder().encode(`${st.colore}|${st.messaggioNorm}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function pcMessaggio(st: StatoPC): string {
  return `${pcEmoji(st.colore)} <b>Protezione Civile Prato</b>\n${st.testo}\n\n${FONTE_PC}`;
}

// ===========================================================================
// BOLLETTINO (port di run_bollettino.py)
// ===========================================================================
function nowRome(): string {
  const f = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return f.format(new Date()).replace(",", "");
}
function costruisciBollettino(letture: Lettura[], extra = ""): string {
  const righe = [`📋 <b>Bollettino fiumi Prato</b> — ${nowRome()}`, ""];
  letture.sort((a, b) => {
    if (a.fiume !== b.fiume) return a.fiume < b.fiume ? -1 : 1;
    return (meta(a.codice)?.ordine ?? 99) - (meta(b.codice)?.ordine ?? 99);
  });
  for (const l of letture) {
    const st = statoDaLivello(l);
    const pc = puntiCritici(l.codice);
    const et = pc.etichetta ?? `${l.fiume} - ${l.nome}`;
    righe.push(`${EMOJI[st]} <b>${et}</b>: ${fmtM(l.livello_m)} — ${trend(l.ratei[0])}`);
  }
  const inAllerta = letture.filter((l) => statoDaLivello(l) !== "calma");
  righe.push("");
  righe.push(inAllerta.length ? "⚠️ Alcune stazioni sono sopra soglia: vedi sopra." : "✅ Tutti i corsi d'acqua sotto le soglie di guardia.");
  if (extra) { righe.push(""); righe.push("— <i>Previsioni e allerte</i> —"); righe.push(extra); }
  righe.push("");
  righe.push(DISCLAIMER);
  righe.push("");
  righe.push(FONTE_SIR);
  return righe.join("\n");
}

// ===========================================================================
// SISMI INGV (terremoti.ingv.it — web service FDSN)
// ===========================================================================
const PRATO_LAT = 43.8777, PRATO_LON = 11.0955;
const SISMA_RAGGIO_KM = 30;
const SISMA_MAG_MIN = 2.0;            // soglia scelta: M >= 2.0
const SISMA_WINDOW_MIN = 180;         // finestra di query a ogni tick (resilienza ritardi/down)
const INGV_BASE = "https://webservices.ingv.it/fdsnws/event/1/query";

interface Sisma {
  event_id: number; ts: string; mag: number | null; mag_type: string | null;
  profondita_km: number | null; luogo: string | null;
  lat: number; lon: number; distanza_km: number;
}

function haversineKm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371, toR = (x: number) => (x * Math.PI) / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function ingvQuery(base: string, startIsoUtc: string): Promise<any[]> {
  const url = `${base}?starttime=${startIsoUtc}` +
    `&latitude=${PRATO_LAT}&longitude=${PRATO_LON}&maxradiuskm=${SISMA_RAGGIO_KM}` +
    `&minmagnitude=${SISMA_MAG_MIN}&format=geojson&orderby=time`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "EmergenzePrato-monitor/0.3 (+progetto allerta Prato)" } });
    if (r.status === 204) return []; // INGV: 204 No Content = nessun evento
    if (!r.ok) throw new Error(`INGV ${r.status}`);
    const txt = await r.text();
    if (!txt.trim()) return [];
    return (JSON.parse(txt).features ?? []);
  } finally {
    clearTimeout(t);
  }
}

function sismaTimeRome(tsUtc: string): string {
  const d = new Date(tsUtc.endsWith("Z") ? tsUtc : tsUtc + "Z");
  return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d).replace(",", "");
}
function sismaHeader(mag: number | null): string {
  if (mag !== null && mag >= 4) return "🔴 <b>Terremoto forte vicino a Prato</b>";
  if (mag !== null && mag >= 3) return "🟠 <b>Terremoto vicino a Prato</b>";
  return "🟡 <b>Terremoto vicino a Prato</b>";
}
function sismaMessaggio(s: Sisma): string {
  const magS = s.mag !== null ? `${s.mag_type ?? "M"} ${s.mag.toFixed(1)}` : "magnitudo n.d.";
  const prof = s.profondita_km !== null ? `Profondità: ${s.profondita_km.toFixed(0)} km\n` : "";
  return (
    `${sismaHeader(s.mag)}\n` +
    `Magnitudo <b>${magS}</b> — ${s.distanza_km.toFixed(0)} km da Prato\n` +
    `📍 ${s.luogo ?? "località n.d."}\n` +
    `🕒 ${sismaTimeRome(s.ts)} (ora italiana)\n` +
    prof +
    `\n🔗 Fonte: INGV\nhttps://terremoti.ingv.it/event/${s.event_id}`
  );
}
function featureToSisma(f: any): Sisma {
  const [lon, lat, depth] = f.geometry.coordinates;
  return {
    event_id: f.properties.eventId, ts: f.properties.time,
    mag: f.properties.mag ?? null, mag_type: f.properties.magType ?? null,
    profondita_km: depth ?? null, luogo: f.properties.place ?? null,
    lat, lon, distanza_km: Math.round(haversineKm(PRATO_LAT, PRATO_LON, lat, lon) * 10) / 10,
  };
}

// ===========================================================================
// TELEGRAM + STORAGE
// ===========================================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Contesto: credenziali Telegram + config (soglie) + registry fonti (url riconfigurabili).
interface Ctx {
  token: string; chatId: string;
  conf: Record<string, string>;
  fonti: Record<string, { url: string; attiva: boolean; tipo: string; nome: string }>;
}
async function getCtx(): Promise<Ctx> {
  const [confRes, fontiRes] = await Promise.all([
    db.from("em_config").select("chiave,valore"),
    db.from("em_fonti").select("chiave,url,attiva,tipo,nome"),
  ]);
  const conf: Record<string, string> = {};
  for (const r of confRes.data ?? []) conf[r.chiave] = r.valore;
  const fonti: Record<string, any> = {};
  for (const r of fontiRes.data ?? []) fonti[r.chiave] = r;
  if (!conf.telegram_bot_token || !conf.telegram_chat_id) throw new Error("Config Telegram mancante in em_config");
  return { token: conf.telegram_bot_token, chatId: conf.telegram_chat_id, conf, fonti };
}
function fonteUrl(cfg: Ctx, chiave: string, fallback: string): string {
  return cfg.fonti[chiave]?.url ?? fallback;
}
function fonteAttiva(cfg: Ctx, chiave: string): boolean {
  const f = cfg.fonti[chiave];
  return f ? f.attiva !== false : true;
}
// Etichetta "previsione/osservato/allerta" + nome fonte + ora del dato.
function fonteTag(cfg: Ctx, chiave: string, oraDato?: string): string {
  const f = cfg.fonti[chiave];
  const nome = f?.nome ?? chiave;
  const badge = f?.tipo === "previsione" ? "🔭 <i>Previsione</i>"
    : f?.tipo === "allerta" ? "🚨 <i>Allerta ufficiale</i>"
    : "📡 <i>Dato osservato</i>";
  return `${badge} · Fonte: ${nome}${oraDato ? ` · dati ${oraDato}` : ""}`;
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Dedup dei push "estremi" (meteo/flood): true se la firma è cambiata.
async function pushCambiato(chiave: string, firma: string): Promise<boolean> {
  const h = await sha256Hex(firma);
  const { data } = await db.from("em_push").select("hash").eq("chiave", chiave).maybeSingle();
  if (data?.hash === h) return false;
  await db.from("em_push").upsert({ chiave, hash: h }, { onConflict: "chiave" });
  return true;
}
async function telegramInvia(token: string, chatId: string, testo: string, silenzioso = false): Promise<void> {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: testo, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: silenzioso }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

// ===========================================================================
// JOBS
// ===========================================================================
// --- util ---
const UA = "EmergenzePrato-monitor/0.4 (+progetto allerta Prato)";
const PC_URL_DEFAULT = PC_URL;
const METEO_URL_DEFAULT = "https://api.open-meteo.com/v1/forecast?latitude=43.8805&longitude=11.097&hourly=precipitation_probability,precipitation,rain,showers,snowfall,snow_depth,cloud_cover_high,cloud_cover_mid,wind_speed_180m,wind_speed_120m,wind_speed_80m&timezone=Europe%2FBerlin";
const FLOOD_URL_DEFAULT = "https://flood-api.open-meteo.com/v1/flood?latitude=43.8805&longitude=11.097&daily=river_discharge,river_discharge_mean,river_discharge_median,river_discharge_max,river_discharge_min,river_discharge_p25,river_discharge_p75&ensemble=true";
const DPC_URL_DEFAULT = "https://allertameteo.app/api/alert/Prato";
const DPC_EMOJI: Record<string, string> = { verde: "🟢", giallo: "🟡", arancione: "🟠", rosso: "🔴" };
const num = (s: string | undefined, d: number) => { const n = Number(s); return Number.isFinite(n) ? n : d; };
const round1 = (x: number | null | undefined) => (x == null ? 0 : Math.round(x * 10) / 10);
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

async function runSir(cfg: Ctx): Promise<string> {
  const letture = parsePayload(await sirFetchRaw(fonteUrl(cfg, "sir_idro", SIR_IDRO_URL)), true);
  if (!letture.length) return "SIR: nessuna lettura";
  const { data: statoRows } = await db.from("em_stato").select("*");
  const statoPrec: Record<string, any> = {};
  for (const r of statoRows ?? []) statoPrec[r.codice] = r;
  const { messaggi, nuovoStato } = valuta(letture, statoPrec);
  await db.from("em_letture").insert(rigaLettureDb(letture)); // STORE FIRST
  for (const m of messaggi) await telegramInvia(cfg.token, cfg.chatId, m, false);
  await db.from("em_stato").upsert(nuovoStato, { onConflict: "codice" });
  return `SIR: ${letture.length} letture, ${messaggi.length} allerte`;
}

async function runPc(cfg: Ctx): Promise<string> {
  const st = parsePc(await fetchText(fonteUrl(cfg, "pc_prato", PC_URL_DEFAULT)));
  if (!st) return "PC: pagina non valida (errore/WAF) — skip";
  const h = await pcHash(st);
  const { data } = await db.from("em_pc_stato").select("hash").eq("chiave", "prato").maybeSingle();
  if (data?.hash === h) return "PC: nessuna variazione";
  await db.from("em_pc_stato").upsert({ chiave: "prato", hash: h, testo: st.testo, colore: st.colore }, { onConflict: "chiave" }); // STORE FIRST
  await telegramInvia(cfg.token, cfg.chatId, pcMessaggio(st), pcIsNormalita(st.colore));
  return "PC: aggiornamento inviato";
}

async function runSismi(cfg: Ctx, opts: { seed?: boolean; days?: number } = {}): Promise<string> {
  const start = opts.seed
    ? new Date(Date.now() - (opts.days ?? 90) * 86400000)
    : new Date(Date.now() - SISMA_WINDOW_MIN * 60000);
  const features = await ingvQuery(fonteUrl(cfg, "ingv", INGV_BASE), start.toISOString().slice(0, 19));
  if (!features.length) return "Sismi: nessun evento nella finestra";
  const sismi = features.filter((f) => f?.properties?.eventId != null).map(featureToSisma);
  const ids = sismi.map((s) => s.event_id);
  const { data: known } = await db.from("em_sismi").select("event_id").in("event_id", ids);
  const knownSet = new Set((known ?? []).map((r) => r.event_id));
  const nuovi = sismi.filter((s) => !knownSet.has(s.event_id));
  if (!nuovi.length) return "Sismi: nessuna novità";
  await db.from("em_sismi").upsert(nuovi, { onConflict: "event_id" }); // STORE FIRST
  if (!opts.seed) {
    for (const s of [...nuovi].reverse()) await telegramInvia(cfg.token, cfg.chatId, sismaMessaggio(s), false);
  }
  return `Sismi: ${opts.seed ? "seed" : "inviati"} ${nuovi.length}`;
}

// --- DPC allerta colore (allertameteo.app) ---
async function fetchDpc(cfg: Ctx): Promise<any | null> {
  const r = await fetch(fonteUrl(cfg, "dpc_allerta", DPC_URL_DEFAULT), { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`DPC ${r.status}`);
  const d = (await r.json())?.data;
  if (!d?.oggi?.allerta) return null;
  return {
    dataBoll: d.bulletin_info?.data_bollettino ?? "", oraBoll: d.bulletin_info?.ora_bollettino ?? "",
    oggi: d.oggi.allerta, domani: d.domani?.allerta ?? {},
    dettagli_oggi: d.oggi.dettagli, dettagli_domani: d.domani?.dettagli, info: d.bulletin_info,
  };
}
function dpcMessaggio(cfg: Ctx, d: any): string {
  const e = (c: string) => DPC_EMOJI[(c || "").toLowerCase()] ?? "⚪";
  const det = d.dettagli_oggi || {};
  return [
    `🚨 <b>Allerta Protezione Civile — Prato</b>`,
    `<b>Oggi</b>: ${e(d.oggi.colore)} ${cap(d.oggi.colore)} — ${d.oggi.descrizione}`,
    `<b>Domani</b>: ${e(d.domani.colore)} ${cap(d.domani.colore)} — ${d.domani.descrizione ?? "n.d."}`,
    ``,
    `• Idraulico: ${det.idraulico ?? "n.d."}`,
    `• Temporali: ${det.temporali ?? "n.d."}`,
    `• Idrogeologico: ${det.idrogeologico ?? "n.d."}`,
    ``,
    fonteTag(cfg, "dpc_allerta", `boll. ${d.dataBoll} ${d.oraBoll}`.trim()),
  ].join("\n");
}
async function runDpc(cfg: Ctx): Promise<string> {
  if (!fonteAttiva(cfg, "dpc_allerta")) return "DPC: disattivata";
  const d = await fetchDpc(cfg);
  if (!d) return "DPC: dati non disponibili";
  const hash = await sha256Hex(`${d.dataBoll}|${d.oggi.colore}|${d.oggi.livello}|${d.domani.colore}|${d.domani.livello}`);
  const { error } = await db.from("em_allerta_dpc").insert({ // STORE FIRST (unique hash = dedup)
    hash, data_bollettino: d.dataBoll, colore_oggi: d.oggi.colore, livello_oggi: d.oggi.livello,
    colore_domani: d.domani.colore, livello_domani: d.domani.livello,
    dettagli: { oggi: d.dettagli_oggi, domani: d.dettagli_domani, info: d.info },
  });
  if (error) return "DPC: nessuna variazione";
  const allerta = (d.oggi.livello ?? 1) >= 2 || (d.domani.livello ?? 1) >= 2;
  if (!allerta) return "DPC: salvato (nessuna allerta)";
  await telegramInvia(cfg.token, cfg.chatId, dpcMessaggio(cfg, d), false);
  return "DPC: allerta inviata";
}

// --- Meteo previsione (Open-Meteo) ---
async function fetchMeteo(cfg: Ctx): Promise<any | null> {
  const r = await fetch(fonteUrl(cfg, "meteo", METEO_URL_DEFAULT));
  if (!r.ok) throw new Error(`Meteo ${r.status}`);
  const j = await r.json(); const h = j.hourly;
  if (!h?.time) return null;
  const pref = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).format(new Date()).replace(" ", "T").slice(0, 13);
  let idx = h.time.findIndex((t: string) => t.slice(0, 13) === pref);
  if (idx < 0) idx = 0;
  const end = Math.min(idx + 12, h.time.length);
  let somma = 0, probMax = 0, peak = 0;
  for (let i = idx; i < end; i++) {
    const p = h.precipitation?.[i] ?? 0; somma += p; peak = Math.max(peak, p);
    probMax = Math.max(probMax, h.precipitation_probability?.[i] ?? 0);
  }
  return { oraRif: pref, pioggia12h: round1(somma), probMax12h: probMax, peakMmOra: round1(peak), payload: { da: h.time[idx], a: h.time[end - 1], hourly: h } };
}
function meteoMessaggio(cfg: Ctx, m: any): string {
  return [
    `⛈️ <b>Pioggia forte prevista — Prato</b>`,
    `Prossime 12h: <b>${m.pioggia12h} mm</b> totali · picco <b>${m.peakMmOra} mm/h</b> · prob. max ${m.probMax12h}%`,
    ``,
    fonteTag(cfg, "meteo", `agg. ${m.oraRif.replace("T", " ")}`),
  ].join("\n");
}
async function runMeteo(cfg: Ctx): Promise<string> {
  if (!fonteAttiva(cfg, "meteo")) return "Meteo: disattivata";
  const m = await fetchMeteo(cfg);
  if (!m) return "Meteo: dati non disponibili";
  await db.from("em_meteo").upsert( // STORE FIRST (uno snapshot per ora)
    { ora_riferimento: m.oraRif, pioggia_12h_mm: m.pioggia12h, prob_max_12h: m.probMax12h, payload: m.payload },
    { onConflict: "ora_riferimento", ignoreDuplicates: true },
  );
  const estremo = (m.peakMmOra >= num(cfg.conf.meteo_push_mm_ora, 15) || m.pioggia12h >= num(cfg.conf.meteo_push_mm_12h, 40))
    && m.probMax12h >= num(cfg.conf.meteo_push_prob_min, 70);
  if (!estremo) return `Meteo: salvato (12h ${m.pioggia12h}mm, picco ${m.peakMmOra}mm/h)`;
  if (!(await pushCambiato("meteo", `${m.oraRif}|${m.peakMmOra}|${m.pioggia12h}`))) return "Meteo: estremo già notificato";
  await telegramInvia(cfg.token, cfg.chatId, meteoMessaggio(cfg, m), false);
  return "Meteo: avviso pioggia inviato";
}

// --- Portata fluviale prevista (Open-Meteo Flood / GloFAS) ---
async function fetchFlood(cfg: Ctx): Promise<any | null> {
  const r = await fetch(fonteUrl(cfg, "flood", FLOOD_URL_DEFAULT));
  if (!r.ok) throw new Error(`Flood ${r.status}`);
  const d = (await r.json())?.daily;
  if (!d?.time) return null;
  const disc = d.river_discharge ?? [];
  const maxArr = d.river_discharge_max ?? disc;
  const medArr = d.river_discharge_median ?? disc;
  const max7 = Math.max(...maxArr.slice(0, 7).filter((x: number) => x != null), 0);
  return { giorno: d.time[0], oggi: disc[0] ?? null, max7g: max7, median: medArr[0] ?? null, payload: { time: d.time.slice(0, 10), river_discharge: disc.slice(0, 10), max: maxArr.slice(0, 10), median: medArr.slice(0, 10) } };
}
function floodMessaggio(cfg: Ctx, f: any): string {
  return [
    `🌊 <b>Portata fiume in forte aumento (previsione)</b> — Prato`,
    `Oggi ~${round1(f.oggi)} m³/s · max prossimi 7g <b>${round1(f.max7g)} m³/s</b> (mediana ${round1(f.median)})`,
    `⚠️ Modello globale ~5 km: indicativo per bacini piccoli. Verifica col dato SIR locale.`,
    ``,
    fonteTag(cfg, "flood", `agg. ${f.giorno}`),
  ].join("\n");
}
async function runFlood(cfg: Ctx): Promise<string> {
  if (!fonteAttiva(cfg, "flood")) return "Flood: disattivata";
  const f = await fetchFlood(cfg);
  if (!f) return "Flood: dati non disponibili";
  await db.from("em_flood").upsert( // STORE FIRST (uno snapshot al giorno)
    { giorno: f.giorno, discharge_oggi: f.oggi, discharge_max_7g: f.max7g, discharge_median: f.median, payload: f.payload },
    { onConflict: "giorno", ignoreDuplicates: true },
  );
  const base = Math.max(f.median ?? 0, 0.1);
  const estremo = f.max7g >= num(cfg.conf.flood_push_discharge, 20) || f.max7g >= num(cfg.conf.flood_push_ratio, 8) * base;
  if (!estremo) return `Flood: salvato (oggi ${round1(f.oggi)} m³/s, max7g ${round1(f.max7g)})`;
  if (!(await pushCambiato("flood", `${f.giorno}|${round1(f.max7g)}`))) return "Flood: estremo già notificato";
  await telegramInvia(cfg.token, cfg.chatId, floodMessaggio(cfg, f), false);
  return "Flood: avviso portata inviato";
}

// --- LaMMA: previsione settimanale (XML comuni_web) ---
const LAMMA_URL_DEFAULT = "https://www.lamma.toscana.it/previ/ita/xml/comuni_web/dati/prato.xml";
function lammaEmoji(d: string): string {
  const s = (d || "").toLowerCase();
  if (s.includes("temporale")) return "⛈️";
  if (s.includes("pioggia") || s.includes("rovesc") || s.includes("pioviggine")) return s.includes("schiarit") ? "🌦️" : "🌧️";
  if (s.includes("neve")) return "❄️";
  if (s.includes("nebbia")) return "🌫️";
  if (s.includes("coperto")) return "☁️";
  if (s.includes("nuvolos")) return "⛅";
  if (s.includes("sereno")) return "☀️";
  if (s.includes("variabile")) return "🌤️";
  return "🌡️";
}
function parseLamma(xml: string): { aggiornamento: string; giorni: any[] } {
  const aggiornamento = xml.match(/<aggiornamento>(.*?)<\/aggiornamento>/)?.[1] ?? "";
  const giorni: any[] = [];
  const re = /<previsione idday="\d+" ora="giorno" datadescr="([^"]*)">([\s\S]*?)<\/previsione>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const body = m[2];
    const rischi: string[] = [];
    for (const r of body.matchAll(/<rischio descr="([^"]*)"[^>]*value="([^"]*)"/g)) {
      if (r[2] && r[2] !== "nessuno") rischi.push(`${r[1]}: ${r[2]}`);
    }
    giorni.push({
      giorno: m[1],
      cielo: body.match(/<simbolo descr="([^"]*)"/)?.[1] ?? "",
      tmin: body.match(/<temp temp_type="min">([^<]*)<\/temp>/)?.[1] ?? "",
      tmax: body.match(/<temp temp_type="max">([^<]*)<\/temp>/)?.[1] ?? "",
      prob: body.match(/<prob_rain>([^<]*)<\/prob_rain>/)?.[1] ?? "",
      rischi,
      allerta: body.match(/<allerta[^>]*value="([^"]*)"/)?.[1] ?? "nessuno",
    });
  }
  return { aggiornamento, giorni };
}
function lammaMessaggio(cfg: Ctx, data: any): string {
  const righe = ["🗓️ <b>Meteo settimana — Prato</b>", ""];
  for (const g of data.giorni) {
    const t = g.tmin && g.tmax ? ` ${g.tmin}–${g.tmax}°C` : "";
    const p = g.prob ? ` · pioggia ${g.prob}%` : "";
    let line = `${lammaEmoji(g.cielo)} <b>${g.giorno}</b>: ${g.cielo}${t}${p}`;
    if (g.allerta && g.allerta !== "nessuno") line += ` ⚠️ allerta ${g.allerta}`;
    else if (g.rischi.length) line += ` ⚠️ ${g.rischi.join(", ")}`;
    righe.push(line);
  }
  righe.push("");
  righe.push(fonteTag(cfg, "lamma", `agg. ${data.aggiornamento}`));
  return righe.join("\n");
}
async function fetchLamma(cfg: Ctx): Promise<any | null> {
  const data = parseLamma(await fetchText(fonteUrl(cfg, "lamma", LAMMA_URL_DEFAULT)));
  return data.giorni.length ? data : null;
}
async function runLammaSettimana(cfg: Ctx): Promise<string> {
  if (!fonteAttiva(cfg, "lamma")) return "LaMMA: disattivata";
  const data = await fetchLamma(cfg);
  if (!data) return "LaMMA: dati non disponibili";
  await db.from("em_lamma").insert({ aggiornamento: data.aggiornamento, giorni: data.giorni }); // STORE FIRST
  await telegramInvia(cfg.token, cfg.chatId, lammaMessaggio(cfg, data), true); // settimanale informativo: silenzioso
  return `LaMMA: settimana inviata (${data.giorni.length} giorni)`;
}

async function runBollettino(cfg: Ctx): Promise<string> {
  const letture = parsePayload(await sirFetchRaw(fonteUrl(cfg, "sir_idro", SIR_IDRO_URL)), true);
  if (!letture.length) return "Bollettino: nessuna lettura";
  let extra = "";
  try { const d = await fetchDpc(cfg); if (d) extra += `🚨 <b>Allerta DPC</b>: oggi ${DPC_EMOJI[(d.oggi.colore || "").toLowerCase()] ?? "⚪"} ${cap(d.oggi.colore)}, domani ${DPC_EMOJI[(d.domani.colore || "").toLowerCase()] ?? "⚪"} ${cap(d.domani.colore)}\n`; } catch { /* opzionale */ }
  try { const m = await fetchMeteo(cfg); if (m) extra += `🔭 <b>Pioggia prevista 12h</b>: ${m.pioggia12h} mm (picco ${m.peakMmOra} mm/h, prob ${m.probMax12h}%)\n`; } catch { /* opzionale */ }
  try { const fl = await fetchFlood(cfg); if (fl) extra += `🔭 <b>Portata prevista</b>: oggi ~${round1(fl.oggi)} m³/s, max 7g ${round1(fl.max7g)} m³/s\n`; } catch { /* opzionale */ }
  await telegramInvia(cfg.token, cfg.chatId, costruisciBollettino(letture, extra.trim()), true);
  return "Bollettino inviato";
}

// ===========================================================================
// ENTRYPOINT
// ===========================================================================
Deno.serve(async (req) => {
  let mode = new URL(req.url).searchParams.get("mode") ?? "";
  if (!mode) {
    try { mode = (await req.json())?.mode ?? ""; } catch { /* no body */ }
  }
  mode = mode || "tick";

  const out: Record<string, unknown> = { mode };
  try {
    const cfg = await getCtx();
    if (mode === "bollettino") {
      out.bollettino = await runBollettino(cfg);
    } else if (mode === "sismi_seed") {
      // Una tantum: popola lo storico INGV senza inviare nulla (evita blast iniziale).
      out.sismi = await runSismi(cfg, { seed: true, days: 90 });
    } else if (mode === "meteo_settimana") {
      // Settimanale (domenica): previsione 5 giorni LaMMA.
      out.lamma = await runLammaSettimana(cfg);
    } else {
      // tick: ogni fonte è indipendente (una che fallisce non blocca le altre)
      try { out.sir = await runSir(cfg); } catch (e) { out.sir = `ERRORE: ${e instanceof Error ? e.message : e}`; }
      try { out.pc = await runPc(cfg); } catch (e) { out.pc = `ERRORE: ${e instanceof Error ? e.message : e}`; }
      try { out.sismi = await runSismi(cfg); } catch (e) { out.sismi = `ERRORE: ${e instanceof Error ? e.message : e}`; }
      try { out.dpc = await runDpc(cfg); } catch (e) { out.dpc = `ERRORE: ${e instanceof Error ? e.message : e}`; }
      try { out.meteo = await runMeteo(cfg); } catch (e) { out.meteo = `ERRORE: ${e instanceof Error ? e.message : e}`; }
      try { out.flood = await runFlood(cfg); } catch (e) { out.flood = `ERRORE: ${e instanceof Error ? e.message : e}`; }
    }
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = e instanceof Error ? e.message : String(e);
  }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" }, status: out.ok ? 200 : 500 });
});
