"""Entrypoint di POLLING (girato dal cron di GitHub Actions).

Flusso: fetch SIR -> salva serie temporale -> valuta soglie/rateo ->
manda allerte su Telegram -> aggiorna lo stato.

Uso:
    python -m emergenze.run_poll
    python -m emergenze.run_poll --dry-run   # non invia, stampa soltanto
"""

from __future__ import annotations

import sys

from . import alert_engine, supabase_store, telegram_notify
from .sir_scraper import get_stazioni_prato


def main(argv: list[str]) -> int:
    dry = "--dry-run" in argv

    letture = get_stazioni_prato()
    if not letture:
        print("Nessuna lettura ottenuta dal SIR — esco senza modifiche.", file=sys.stderr)
        return 1

    stato_prec = {} if dry else supabase_store.get_stato()
    messaggi, nuovo_stato = alert_engine.valuta(letture, stato_prec)

    print(f"Letture: {len(letture)} | Allerte da inviare: {len(messaggi)} | dry-run={dry}")
    for l in letture:
        print(f"  {l.fiume:<11} {l.nome:<22} {l.livello_m} m  rateo={l.ratei[0]}")

    if dry:
        for m in messaggi:
            print("\n--- MESSAGGIO ---\n" + m)
        return 0

    # Persisti la serie temporale
    supabase_store.insert_letture(alert_engine.riga_letture_db(letture))

    # Invia allerte
    for m in messaggi:
        telegram_notify.invia(m, silenzioso=False)

    # Aggiorna lo stato (dedup)
    supabase_store.upsert_stato(nuovo_stato)

    print("OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
