"""Entrypoint: controlla la pagina "Emergenze in corso" della Protezione Civile
di Prato e invia al canale Telegram SOLO quando il messaggio cambia.

Flusso: fetch pagina -> parse stato -> confronta hash col precedente (Supabase)
-> se cambiato, invia su Telegram -> salva il nuovo stato.

Il timestamp della pagina cambia anche senza variazioni di stato: per questo si
confronta solo il messaggio normalizzato + colore (vedi pc_prato.py), niente spam.

Uso:
    python -m emergenze.run_pc_prato
    python -m emergenze.run_pc_prato --dry-run   # non invia/salva, stampa soltanto
"""

from __future__ import annotations

import hashlib
import sys

from . import pc_prato, supabase_store, telegram_notify

FONTE = ("🔗 Fonte: Protezione Civile Comune di Prato\n"
         "https://emergenze.comune.prato.it/mirror_emergenze/it/pagina2413.html")


def _hash(st: pc_prato.StatoPC) -> str:
    base = f"{st.colore}|{st.messaggio_norm}"
    return hashlib.sha256(base.encode("utf-8")).hexdigest()


def costruisci_messaggio(st: pc_prato.StatoPC) -> str:
    return (
        f"{st.emoji} <b>Protezione Civile Prato</b>\n"
        f"{st.testo}\n\n"
        f"{FONTE}"
    )


def main(argv: list[str]) -> int:
    dry = "--dry-run" in argv

    st = pc_prato.get_stato_pc()
    if not st:
        # Pagina non valida in questo momento: tipicamente un blocco temporaneo
        # del server (WAF Imunify360) o una pagina di errore. NON è un errore
        # nostro e NON va inviato nulla: skip silenzioso (exit 0, niente run rosso).
        print("Stato PC non estraibile ora (pagina di errore/WAF?) — salto, "
              "nessun invio.", file=sys.stderr)
        return 0

    nuovo_hash = _hash(st)
    print(f"PC Prato: [{st.colore}] {st.testo[:80]}... hash={nuovo_hash[:12]}")

    if dry:
        print("\n--- MESSAGGIO ---\n" + costruisci_messaggio(st))
        return 0

    prec = supabase_store.get_pc_stato()
    if prec.get("hash") == nuovo_hash:
        print("Nessuna variazione rispetto all'ultimo stato — niente da inviare.")
        return 0

    # Variazione (o primo avvio): invia. Notifica silenziosa se torna/è normalità.
    telegram_notify.invia(costruisci_messaggio(st), silenzioso=st.is_normalita)
    supabase_store.upsert_pc_stato(nuovo_hash, st.testo, st.colore)
    print("Aggiornamento PC inviato e stato salvato.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
