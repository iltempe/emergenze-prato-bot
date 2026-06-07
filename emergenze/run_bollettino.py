"""Entrypoint del BOLLETTINO giornaliero (cron fisso, es. 08:00).

Manda un riepilogo dello stato di tutti i fiumi pratesi, notifica silenziosa.

Uso:
    python -m emergenze.run_bollettino
    python -m emergenze.run_bollettino --dry-run
"""

from __future__ import annotations

import sys
from datetime import datetime

from . import config, telegram_notify
from .alert_engine import _EMOJI, _stato_da_livello, _trend
from .sir_scraper import Lettura, get_stazioni_prato


def costruisci_bollettino(letture: list[Lettura]) -> str:
    oggi = datetime.now().strftime("%d/%m/%Y %H:%M")
    righe = [f"📋 <b>Bollettino fiumi Prato</b> — {oggi}", ""]

    # Ordina monte->valle per bacino
    from .stations import meta
    letture.sort(key=lambda x: (x.fiume, (meta(x.codice) or {}).get("ordine", 99)))

    for l in letture:
        st = _stato_da_livello(l)
        liv = f"{l.livello_m:.2f} m" if l.livello_m is not None else "n.d."
        pc = config.punti_critici(l.codice)
        et = pc.get("etichetta", f"{l.fiume} - {l.nome}")
        righe.append(f"{_EMOJI[st]} <b>{et}</b>: {liv} — {_trend(l.ratei[0])}")

    in_allerta = [l for l in letture if _stato_da_livello(l) != "calma"]
    righe.append("")
    if in_allerta:
        righe.append("⚠️ Alcune stazioni sono sopra soglia: vedi sopra.")
    else:
        righe.append("✅ Tutti i corsi d'acqua sotto le soglie di guardia.")
    righe.append("")
    righe.append(config.DISCLAIMER)
    return "\n".join(righe)


def main(argv: list[str]) -> int:
    dry = "--dry-run" in argv
    letture = get_stazioni_prato()
    if not letture:
        print("Nessuna lettura — bollettino non inviato.", file=sys.stderr)
        return 1

    testo = costruisci_bollettino(letture)
    if dry:
        print(testo)
        return 0

    telegram_notify.invia(testo, silenzioso=True)
    print("Bollettino inviato.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
