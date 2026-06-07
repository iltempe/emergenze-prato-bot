# EmergenzePrato — allerta idrometrica per Prato

Sistema che legge i livelli dei fiumi pratesi dal **SIR Toscana** in tempo reale,
li valuta contro le soglie e li traduce in **allerte azionabili** su un **canale Telegram**,
così il cittadino è sempre informato. Più un **bollettino giornaliero** di riepilogo.

Gira su **GitHub Actions** (cron, nessun hardware acceso) e usa **Supabase** per lo stato.

```
SIR Toscana ──fetch──> parser ──> alert engine ──> Telegram (canale)
                          │              │
                          └─> Supabase (serie temporale + stato per dedup)
```

## Cosa fa, in pratica

- Ogni ~15 min legge le stazioni del bacino pratese (Bisenzio monte→città→valle, Ombrone PT, cassa di espansione).
- Manda un'allerta **solo quando cambia qualcosa** (supera la soglia di guardia/allarme, o sale in fretta): niente spam.
- Le allerte sono **azionabili**: non "codice arancione" ma "Bisenzio sopra guardia, evita i sottopassi".
- Una volta al giorno manda un bollettino con lo stato di tutti i fiumi (notifica silenziosa).
- Ogni ~15 min controlla anche la pagina "Emergenze in corso" della **Protezione Civile di Prato** e inoltra al canale **solo quando il messaggio cambia** (es. dichiarazione di allerta CFR); il colore dell'icona ufficiale diventa l'emoji di gravità.

## Struttura

```
emergenze/
  sir_scraper.py     # fetch + parsing dell'endpoint SIR (testato offline)
  stations.py        # anagrafica stazioni pratesi (monte→valle)
  punti_critici.json # soglie→azioni→sottopassi (il "cervello" azionabile)
  alert_engine.py    # logica soglie/rateo edge-triggered + messaggi
  supabase_store.py  # serie temporale + stato (via REST)
  telegram_notify.py # invio al canale
  pc_prato.py        # monitor pagina Protezione Civile Prato (fetch+parse)
  run_poll.py        # entrypoint polling
  run_bollettino.py  # entrypoint bollettino
  run_pc_prato.py    # entrypoint monitor Protezione Civile (edge-triggered)
tests/               # test offline parser SIR + parser PC (10/10 verdi)
.github/workflows/   # cron poll + bollettino + pc_prato
```

## Setup (una volta)

### 1. Bot e canale Telegram
Il bot esiste già: **@emergenzeprato_bot**. Il token lo recuperi da **@BotFather** (`/mybots` → token).
1. Crea il **canale** (es. *AllertaFiumiPrato*).
2. Aggiungi **@emergenzeprato_bot** come **amministratore** del canale (serve per postare).
3. Trova il `TELEGRAM_CHAT_ID` e fai un test d'invio con lo script di setup:
   ```bash
   export TELEGRAM_BOT_TOKEN="il-tuo-token"
   python -m emergenze.setup_check            # conferma token + elenca i chat_id visti
   export TELEGRAM_CHAT_ID="-100xxxxxxxxxx"   # o @nomecanale se pubblico
   python -m emergenze.setup_check --test     # manda un messaggio di prova nel canale
   ```

### 2. Supabase
- Tabelle già create nel progetto **pratomimuovo-traffico**: `em_letture`, `em_stato`.
- `SUPABASE_URL`: `https://pfzfegfaagzeupopqaqj.supabase.co`
- `SUPABASE_SERVICE_KEY`: Dashboard → Project Settings → API → **service_role** (segreto, solo lato server).

### 3. Secrets su GitHub
Nel repo: *Settings → Secrets and variables → Actions → New repository secret*. Aggiungi:
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

I due workflow (`poll.yml`, `bollettino.yml`) partono da soli col cron; puoi anche lanciarli a mano da *Actions → Run workflow*.

## Test in locale

```bash
pip install -r requirements.txt
python -m tests.test_parser          # test offline del parser/engine

# prova reale senza inviare nulla (stampa letture + messaggi):
python -m emergenze.run_poll --dry-run
python -m emergenze.run_bollettino --dry-run

# vista rapida dei livelli attuali dal SIR:
python -m emergenze.sir_scraper
```

## ⚠️ Da validare alla prima esecuzione live

Il parser è testato su dati sintetici; questi due punti vanno confermati col primo run reale (`--dry-run`):

1. **Endpoint SIR a 2 step**: la pagina inietta gli array via un `<script src=…&extra=HASH>`.
   `fetch_raw()` gestisce l'hash; se il SIR cambia struttura, è l'unico punto da ritoccare.
2. **Significato delle soglie**: nel dato SIR le due soglie non sono in ordine fisso, quindi le
   normalizzo come *guardia = la più bassa, allarme = la più alta*. Va **confermato con la legenda
   ufficiale SIR** e con il Piano di Protezione Civile comunale. Stessa cosa per i `punti_critici.json`:
   i sottopassi e le strade a rischio vanno completati e georeferenziati dal piano comunale.

## Disclaimer
Dati SIR Toscana acquisiti in tempo reale e **non validati**. Uso civico/indicativo:
in emergenza fa fede sempre la Protezione Civile (IT-Alert, Comune di Prato, CFR Toscana).

## Roadmap (fase 2)
- Nowcasting "fatto in casa": stima dell'onda di piena monte→valle (Gamberame → Prato) dal rateo + pioggia cumulata a monte.
- Taratura dei tempi di corrivazione del Bisenzio.
- Dashboard web (artifact) con i livelli live e lo storico da `em_letture`.
- Bot interattivo: l'utente chiede "com'è il Bisenzio adesso?".
```
