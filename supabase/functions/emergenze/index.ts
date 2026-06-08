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

async function sirFetchRaw(): Promise<string> {
  const r1 = await fetchText(`${SIR_BASE}?type=idro`);
  const m = r1.match(/stazioni\.php\?type=idro&(?:amp;)?extra=([A-Za-z0-9]+)/);
  if (!m) {
    if (r1.includes("new Array") || r1.includes("Array(")) return r1;
    throw new Error("Hash 'extra' non trovato e nessun array inline: struttura SIR cambiata?");
  }
  return await fetchText(`${SIR_BASE}?type=idro&extra=${m[1]}`);
}

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
function costruisciBollettino(letture: Lettura[]): string {
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
  righe.push("");
  righe.push(DISCLAIMER);
  righe.push("");
  righe.push(FONTE_SIR);
  return righe.join("\n");
}

// ===========================================================================
// TELEGRAM + STORAGE
// ===========================================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function getConfig(): Promise<{ token: string; chatId: string }> {
  const { data, error } = await db.from("em_config").select("chiave,valore").in("chiave", ["telegram_bot_token", "telegram_chat_id"]);
  if (error) throw error;
  const map: Record<string, string> = {};
  for (const r of data ?? []) map[r.chiave] = r.valore;
  if (!map.telegram_bot_token || !map.telegram_chat_id) throw new Error("Config Telegram mancante in em_config");
  return { token: map.telegram_bot_token, chatId: map.telegram_chat_id };
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
async function runSir(cfg: { token: string; chatId: string }): Promise<string> {
  const letture = parsePayload(await sirFetchRaw(), true);
  if (!letture.length) return "SIR: nessuna lettura";
  const { data: statoRows } = await db.from("em_stato").select("*");
  const statoPrec: Record<string, any> = {};
  for (const r of statoRows ?? []) statoPrec[r.codice] = r;
  const { messaggi, nuovoStato } = valuta(letture, statoPrec);
  await db.from("em_letture").insert(rigaLettureDb(letture));
  for (const m of messaggi) await telegramInvia(cfg.token, cfg.chatId, m, false);
  await db.from("em_stato").upsert(nuovoStato, { onConflict: "codice" });
  return `SIR: ${letture.length} letture, ${messaggi.length} allerte`;
}

async function runPc(cfg: { token: string; chatId: string }): Promise<string> {
  const st = parsePc(await fetchText(PC_URL));
  if (!st) return "PC: pagina non valida (errore/WAF) — skip";
  const h = await pcHash(st);
  const { data } = await db.from("em_pc_stato").select("hash").eq("chiave", "prato").maybeSingle();
  if (data?.hash === h) return "PC: nessuna variazione";
  await telegramInvia(cfg.token, cfg.chatId, pcMessaggio(st), pcIsNormalita(st.colore));
  await db.from("em_pc_stato").upsert({ chiave: "prato", hash: h, testo: st.testo, colore: st.colore }, { onConflict: "chiave" });
  return "PC: aggiornamento inviato";
}

async function runBollettino(cfg: { token: string; chatId: string }): Promise<string> {
  const letture = parsePayload(await sirFetchRaw(), true);
  if (!letture.length) return "Bollettino: nessuna lettura";
  await telegramInvia(cfg.token, cfg.chatId, costruisciBollettino(letture), true);
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
    const cfg = await getConfig();
    if (mode === "bollettino") {
      out.bollettino = await runBollettino(cfg);
    } else {
      // tick: i due controlli sono indipendenti (uno non deve bloccare l'altro)
      try { out.sir = await runSir(cfg); } catch (e) { out.sir = `ERRORE: ${e instanceof Error ? e.message : e}`; }
      try { out.pc = await runPc(cfg); } catch (e) { out.pc = `ERRORE: ${e instanceof Error ? e.message : e}`; }
    }
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = e instanceof Error ? e.message : String(e);
  }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" }, status: out.ok ? 200 : 500 });
});
