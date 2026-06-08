"""
Monitor della pagina "Emergenze in corso" della Protezione Civile di Prato.

Fonte: https://emergenze.comune.prato.it/mirror_emergenze/it/pagina2413.html

La pagina espone UN blocco di stato (dentro <div id="regola_default">):
  <i class="fas fa-circle" style="color: green"></i>
  <span ...>07.06.2026 ore 22:05 - Stato di normalita' ... CFR ...</span>
Il COLORE dell'icona indica la gravita' (green/giallo/arancione/rosso).

Attenzione: il timestamp ("ore HH:MM") e l'header Last-Modified cambiano anche
quando lo STATO non cambia. Per il change-detection si confronta quindi solo il
messaggio normalizzato (timestamp iniziale rimosso) + il colore.

Il modulo separa:
  - fetch_raw()      -> rete
  - parse(html)      -> parsing PURO (testabile offline)
  - get_stato_pc()   -> orchestrazione

Dipendenze: requests
"""

from __future__ import annotations

import html
import re
import sys
from dataclasses import dataclass
from typing import Optional

import requests

URL = "https://emergenze.comune.prato.it/mirror_emergenze/it/pagina2413.html"
HEADERS = {
    "User-Agent": "EmergenzePrato-monitor/0.1 (+progetto allerta Prato)",
    "Accept": "text/html,application/xhtml+xml",
}
TIMEOUT = 15

# Prefisso data/ora da scartare per la dedup: "07.06.2026 ore 22:05 - "
_RE_PREFISSO_DATA = re.compile(
    r"^\s*\d{1,2}[./]\d{1,2}[./]\d{2,4}\s+ore\s+\d{1,2}[:.]\d{2}\s*[-–:]\s*",
    re.IGNORECASE,
)

# Emoji per colore icona (gravita').
_EMOJI = {
    "green": "🟢",
    "lime": "🟢",
    "yellow": "🟡",
    "gold": "🟡",
    "orange": "🟠",
    "red": "🔴",
    "darkred": "🔴",
}


@dataclass
class StatoPC:
    colore: str          # colore icona (es. "green")
    testo: str           # messaggio completo, ripulito (con timestamp)
    messaggio_norm: str  # messaggio senza prefisso data/ora, per la dedup

    @property
    def emoji(self) -> str:
        return _EMOJI.get(self.colore.lower(), "ℹ️")

    @property
    def is_normalita(self) -> bool:
        return self.colore.lower() in ("green", "lime")


def _clean(s: str) -> str:
    """Rimuove tag, decodifica entita', toglie caratteri di controllo (la
    pagina contiene perfino dei null byte) e normalizza gli spazi."""
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = s.replace("\x00", "")
    s = "".join(ch for ch in s if ch >= " " or ch == "\n")
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def parse(html_text: str) -> Optional[StatoPC]:
    """Estrae il blocco di stato ufficiale. Ritorna None (= non inviare nulla)
    se la struttura attesa non c'e': cambio impaginazione, oppure una pagina di
    errore/blocco del server (es. WAF Imunify360). Meglio niente che spazzatura.

    Requisiti minimi per considerare valida la pagina:
      1) presenza del contenitore <... id="regola_default">
      2) presenza dell'icona-cerchio di stato con un colore (fa-circle + color)
    Entrambi mancano nelle pagine di errore/interstiziali."""
    idx = html_text.find('id="regola_default"')
    if idx < 0:
        return None  # contenitore di stato assente -> pagina non valida
    blocco = html_text[idx: idx + 3000]

    cm = re.search(
        r'fa-circle[^>]*style="[^"]*color:\s*([a-zA-Z]+)', blocco, re.IGNORECASE
    )
    if cm is None:
        return None  # nessuna icona di stato colorata -> contenuto non valido
    colore = cm.group(1).lower()

    sm = re.search(r"<span[^>]*>(.*?)</span>", blocco, re.IGNORECASE | re.DOTALL)
    if sm is None:
        return None

    testo = _clean(sm.group(1))
    if not testo:
        return None

    messaggio_norm = _RE_PREFISSO_DATA.sub("", testo).strip().lower()
    return StatoPC(colore=colore, testo=testo, messaggio_norm=messaggio_norm)


def fetch_raw() -> str:
    r = requests.get(URL, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    # La pagina non dichiara un charset affidabile: forziamo utf-8 tollerante.
    r.encoding = "utf-8"
    return r.text


def get_stato_pc() -> Optional[StatoPC]:
    return parse(fetch_raw())


if __name__ == "__main__":
    st = get_stato_pc()
    if not st:
        print("Impossibile estrarre lo stato (struttura pagina cambiata?).",
              file=sys.stderr)
        raise SystemExit(1)
    print(f"{st.emoji} [{st.colore}] {st.testo}")
