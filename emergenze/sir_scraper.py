"""
Scraper SIR Toscana — livelli idrometrici in tempo reale per il bacino pratese.

Fonte:  https://www.sir.toscana.it/monitoraggio/stazioni.php?type=idro
Dati:   acquisiti in tempo reale e NON validati (vedi disclaimer SIR).
        Per un'allerta la freschezza batte la validazione, ma il dato va
        sempre accompagnato dal disclaimer quando rilanciato a un utente.

Flusso a due step (piccolo anti-leech / cache-busting):
  1. GET stazioni.php?type=idro  -> nell'HTML c'e' <script src="...&extra=HASH">
  2. estrai HASH e rifai la GET con quel parametro -> payload con array JS

Il modulo separa:
  - fetch_raw()      -> rete (i due step)
  - parse_payload()  -> parsing PURO (testabile offline, niente rete)
  - get_stazioni_prato() -> orchestrazione + filtro stazioni pratesi

Uso:
    python sir_scraper.py            # stampa le stazioni pratesi
    python sir_scraper.py --all      # stampa tutte le stazioni idro
    python sir_scraper.py --json     # output JSON

Dipendenze: requests
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Optional

import requests

try:
    from .stations import CODICI_PRATO, meta
except ImportError:  # esecuzione come script standalone
    from stations import CODICI_PRATO, meta

BASE_URL = "https://www.sir.toscana.it/monitoraggio/stazioni.php"
PARAMS = {"type": "idro"}
HEADERS = {
    # Header "civile": ci identifichiamo, non ci spacciamo per browser anonimo.
    "User-Agent": "EmergenzePrato-monitor/0.1 (+progetto allerta idro Prato)",
    "Accept": "text/html,application/xhtml+xml",
}
TIMEOUT = 15

# --- Mappa indici del record (decodificata in fase di recon) ---
# "TOS01004782","Bisenzio","Prato (RADIO)","PO","Bisenzio","B","1.50","1.00",
#  "-0.46","3.99","0.00","-0.01","-0.01","07/06 19.45"
IDX = {
    "codice": 0,
    "fiume": 1,
    "localita": 2,
    "prov": 3,
    "bacino": 4,
    "flag": 5,
    "soglia1": 6,
    "soglia2": 7,
    "livello": 8,
    "rateo_0": 10,  # variazioni a intervalli crescenti
    "rateo_1": 11,
    "rateo_2": 12,
    "timestamp": 13,
}


@dataclass
class Lettura:
    codice: str
    fiume: str
    nome: str            # da anagrafica locale se nota, altrimenti localita SIR
    localita: str
    posizione: Optional[str]
    livello_m: Optional[float]
    soglia1_m: Optional[float]
    soglia2_m: Optional[float]
    ratei: list[Optional[float]]
    timestamp: str
    sopra_soglia1: Optional[bool]
    sopra_soglia2: Optional[bool]

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# RETE
# ---------------------------------------------------------------------------
def fetch_raw(session: Optional[requests.Session] = None) -> str:
    """Esegue i due step e restituisce il payload grezzo con gli array JS."""
    s = session or requests.Session()

    # Step 1: pagina contenitore
    r1 = s.get(BASE_URL, params=PARAMS, headers=HEADERS, timeout=TIMEOUT)
    r1.raise_for_status()

    # Cerca <script src="stazioni.php?type=idro&extra=HASH">
    m = re.search(r'stazioni\.php\?type=idro&(?:amp;)?extra=([A-Za-z0-9]+)', r1.text)
    if not m:
        # Fallback: forse gli array sono gia' inline nello step 1
        if "new Array" in r1.text or "Array(" in r1.text:
            return r1.text
        raise RuntimeError(
            "Hash 'extra' non trovato e nessun array inline: "
            "la pagina SIR potrebbe aver cambiato struttura."
        )

    extra = m.group(1)

    # Step 2: payload reale con l'hash di cache-busting
    r2 = s.get(
        BASE_URL,
        params={"type": "idro", "extra": extra},
        headers=HEADERS,
        timeout=TIMEOUT,
    )
    r2.raise_for_status()
    return r2.text


# ---------------------------------------------------------------------------
# PARSING PURO (no rete -> unit-testabile)
# ---------------------------------------------------------------------------
def _to_float(val: str) -> Optional[float]:
    if val is None:
        return None
    v = val.strip().replace(",", ".")
    if v in ("", "-", "n.d.", "nd", "N.D."):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _split_records(text: str) -> list[list[str]]:
    """
    Estrae i record dagli array JS. Gestisce sia
        new Array("a","b",...)
    sia il piu' compatto
        Array("a","b",...)
    Restituisce liste di stringhe (gli argomenti tra virgolette).

    NB: NON ci si basa sul match della parentesi chiusa, perche' i valori
    possono contenere '(' e ')' (es. la stazione "Prato (RADIO)"). Si spezza
    per statement (';') e si estraggono le stringhe quotate dopo 'Array('.
    """
    records: list[list[str]] = []
    for stmt in text.split(";"):
        pos = stmt.find("Array(")
        if pos == -1:
            continue
        block = stmt[pos + len("Array("):]
        # Estrai tutte le stringhe quotate (singole o doppie)
        fields = re.findall(r'"((?:[^"\\]|\\.)*)"|\'((?:[^\'\\]|\\.)*)\'', block)
        flat = [a if a != "" else b for a, b in fields]
        # Un record valido inizia con un codice tipo TOSxxxxxxxx
        if flat and re.match(r'^TOS\d+', flat[0]):
            records.append(flat)
    return records


def parse_payload(text: str, solo_prato: bool = True) -> list[Lettura]:
    """Trasforma il payload grezzo in una lista di Lettura. Funzione pura."""
    out: list[Lettura] = []
    for rec in _split_records(text):
        # Difesa: serve almeno fino al timestamp
        if len(rec) <= IDX["timestamp"]:
            continue
        codice = rec[IDX["codice"]]
        if solo_prato and codice not in CODICI_PRATO:
            continue

        livello = _to_float(rec[IDX["livello"]])
        # Le due soglie nel dato SIR non sono in ordine di severita' fisso.
        # Normalizziamo: guardia = la piu' bassa, allarme = la piu' alta.
        # (Interpretazione provvisoria, da confermare con la legenda ufficiale SIR.)
        raw = [v for v in (_to_float(rec[IDX["soglia1"]]), _to_float(rec[IDX["soglia2"]])) if v is not None]
        raw.sort()
        s1 = raw[0] if len(raw) >= 1 else None   # guardia
        s2 = raw[1] if len(raw) >= 2 else None   # allarme
        m = meta(codice) or {}

        out.append(
            Lettura(
                codice=codice,
                fiume=rec[IDX["fiume"]],
                nome=m.get("nome") or rec[IDX["localita"]],
                localita=rec[IDX["localita"]],
                posizione=m.get("posizione"),
                livello_m=livello,
                soglia1_m=s1,
                soglia2_m=s2,
                ratei=[
                    _to_float(rec[IDX["rateo_0"]]),
                    _to_float(rec[IDX["rateo_1"]]),
                    _to_float(rec[IDX["rateo_2"]]),
                ],
                timestamp=rec[IDX["timestamp"]],
                sopra_soglia1=(livello >= s1) if (livello is not None and s1 is not None) else None,
                sopra_soglia2=(livello >= s2) if (livello is not None and s2 is not None) else None,
            )
        )
    return out


# ---------------------------------------------------------------------------
# ORCHESTRAZIONE
# ---------------------------------------------------------------------------
def get_stazioni_prato() -> list[Lettura]:
    return parse_payload(fetch_raw(), solo_prato=True)


def get_tutte() -> list[Lettura]:
    return parse_payload(fetch_raw(), solo_prato=False)


def _stampa(letture: list[Lettura]) -> None:
    if not letture:
        print("Nessuna stazione trovata (controlla codici o struttura pagina).")
        return
    # Ordina monte->valle per bacino quando l'anagrafica lo conosce
    letture.sort(key=lambda x: (x.fiume, meta(x.codice)["ordine"] if meta(x.codice) else 99))
    print(f"{'Fiume':<12} {'Stazione':<22} {'Liv.[m]':>8} {'Sg1':>6} {'Sg2':>6} {'Rateo':>7}  Aggiorn.")
    print("-" * 80)
    for l in letture:
        liv = f"{l.livello_m:.2f}" if l.livello_m is not None else "n.d."
        s1 = f"{l.soglia1_m:.2f}" if l.soglia1_m is not None else "-"
        s2 = f"{l.soglia2_m:.2f}" if l.soglia2_m is not None else "-"
        rate = l.ratei[0] if l.ratei else None
        rate_s = f"{rate:+.2f}" if rate is not None else "-"
        warn = " ⚠SG1" if l.sopra_soglia1 else ""
        warn += " ⚠⚠SG2" if l.sopra_soglia2 else ""
        print(f"{l.fiume:<12} {l.nome:<22} {liv:>8} {s1:>6} {s2:>6} {rate_s:>7}  {l.timestamp}{warn}")
    print("\n⚠ Dati SIR in tempo reale NON validati — uso indicativo.")


def main(argv: list[str]) -> int:
    want_json = "--json" in argv
    want_all = "--all" in argv
    try:
        letture = get_tutte() if want_all else get_stazioni_prato()
    except Exception as e:
        print(f"Errore: {e}", file=sys.stderr)
        return 1

    if want_json:
        print(json.dumps([l.to_dict() for l in letture], ensure_ascii=False, indent=2))
    else:
        print(f"# SIR Toscana — idrometria ({datetime.now():%d/%m/%Y %H:%M})\n")
        _stampa(letture)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
