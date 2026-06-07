"""Configurazione centrale: variabili d'ambiente + parametri di allerta + layer punti critici."""

from __future__ import annotations

import json
import os
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load_dotenv() -> None:
    """Carica un .env nella root del progetto, se presente (zero dipendenze).
    Non sovrascrive variabili gia' definite nell'ambiente (es. in CI)."""
    env_file = _HERE.parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


_load_dotenv()


def _env(name: str, default: str | None = None, required: bool = False) -> str | None:
    val = os.environ.get(name, default)
    if required and not val:
        raise RuntimeError(f"Variabile d'ambiente mancante: {name}")
    return val


# --- Supabase ---
SUPABASE_URL = _env("SUPABASE_URL")
SUPABASE_SERVICE_KEY = _env("SUPABASE_SERVICE_KEY")  # service_role: bypassa RLS

# --- Telegram ---
TELEGRAM_BOT_TOKEN = _env("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = _env("TELEGRAM_CHAT_ID")  # @nomecanale oppure -100xxxxxxxxxx

# --- Parametri di allerta ---
# Variazione (in metri) sull'intervallo del rateo SIR oltre la quale segnaliamo
# una salita rapida anche se il livello e' ancora sotto soglia.
RATEO_RAPIDO_M = float(_env("RATEO_RAPIDO_M", "0.15"))

# Se True, manda anche i messaggi di "rientro" quando una stazione torna in calma.
NOTIFICA_RIENTRO = _env("NOTIFICA_RIENTRO", "true").lower() == "true"

DISCLAIMER = (
    "ℹ️ Dati SIR Toscana acquisiti in tempo reale e <b>non validati</b>. "
    "Uso indicativo: in emergenza segui sempre le indicazioni della Protezione Civile."
)

# Fonte dei dati idrometrici, da citare in coda ai messaggi sui fiumi.
FONTE_SIR = (
    "🔗 Fonte: SIR Toscana\n"
    "https://www.sir.toscana.it/monitoraggio/stazioni.php?type=idro"
)

# --- Layer punti critici ---
with open(_HERE / "punti_critici.json", encoding="utf-8") as f:
    PUNTI_CRITICI: dict = json.load(f)


def punti_critici(codice: str) -> dict:
    return PUNTI_CRITICI.get(codice, {})
