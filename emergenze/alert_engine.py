"""Motore di allerta: confronta le letture correnti con lo stato precedente
e produce messaggi AZIONABILI (edge-triggered, niente spam)."""

from __future__ import annotations

from datetime import datetime, timezone

from . import config
from .sir_scraper import Lettura

# Ordinamento di severita'
_RANK = {"calma": 0, "soglia1": 1, "soglia2": 2}
_EMOJI = {"calma": "🟢", "soglia1": "🟠", "soglia2": "🔴"}


def _stato_da_livello(l: Lettura) -> str:
    if l.sopra_soglia2:
        return "soglia2"
    if l.sopra_soglia1:
        return "soglia1"
    return "calma"


def _trend(rateo: float | None) -> str:
    if rateo is None:
        return "trend n.d."
    if rateo > 0.02:
        return f"in salita ({rateo:+.2f} m/intervallo)"
    if rateo < -0.02:
        return f"in calo ({rateo:+.2f} m/intervallo)"
    return "stabile"


def _azioni(codice: str, stato: str) -> str:
    pc = config.punti_critici(codice)
    righe = []
    if stato == "soglia2" and pc.get("azioni_soglia2"):
        righe.append(pc["azioni_soglia2"])
    elif stato == "soglia1" and pc.get("azioni_soglia1"):
        righe.append(pc["azioni_soglia1"])
    for p in pc.get("punti", []):
        righe.append(f"• <b>{p['nome']}</b>: {p['azione']}")
    return "\n".join(righe)


def _msg_allerta(l: Lettura, stato: str) -> str:
    pc = config.punti_critici(l.codice)
    et = pc.get("etichetta", f"{l.fiume} - {l.nome}")
    sig = pc.get(f"{stato}_significato", stato)
    liv = f"{l.livello_m:.2f} m" if l.livello_m is not None else "n.d."
    soglia = l.soglia2_m if stato == "soglia2" else l.soglia1_m
    soglia_s = f"{soglia:.2f} m" if soglia is not None else "?"
    azioni = _azioni(l.codice, stato)
    return (
        f"{_EMOJI[stato]} <b>ALLERTA {sig.upper()}</b> — {et}\n"
        f"Livello <b>{liv}</b> (soglia {sig} {soglia_s}), {_trend(l.ratei[0])}.\n"
        + (f"\n{azioni}\n" if azioni else "")
        + f"\n🕒 aggiornato {l.timestamp}\n{config.DISCLAIMER}"
    )


def _msg_rapido(l: Lettura) -> str:
    pc = config.punti_critici(l.codice)
    et = pc.get("etichetta", f"{l.fiume} - {l.nome}")
    liv = f"{l.livello_m:.2f} m" if l.livello_m is not None else "n.d."
    return (
        f"⚡ <b>SALITA RAPIDA</b> — {et}\n"
        f"Livello ancora sotto soglia ({liv}) ma sta salendo in fretta "
        f"({l.ratei[0]:+.2f} m/intervallo). Tieni d'occhio.\n"
        f"\n🕒 aggiornato {l.timestamp}\n{config.DISCLAIMER}"
    )


def _msg_rientro(l: Lettura) -> str:
    pc = config.punti_critici(l.codice)
    et = pc.get("etichetta", f"{l.fiume} - {l.nome}")
    liv = f"{l.livello_m:.2f} m" if l.livello_m is not None else "n.d."
    return (
        f"🟢 <b>RIENTRO</b> — {et}\n"
        f"Livello tornato sotto soglia ({liv}). Situazione in normalizzazione.\n"
        f"🕒 aggiornato {l.timestamp}"
    )


def valuta(
    letture: list[Lettura], stato_prec: dict[str, dict]
) -> tuple[list[str], list[dict]]:
    """Restituisce (messaggi_da_inviare, righe_nuovo_stato)."""
    messaggi: list[str] = []
    nuovo_stato: list[dict] = []
    ora = datetime.now(timezone.utc).isoformat()

    for l in letture:
        prev = stato_prec.get(l.codice, {})
        prev_stato = prev.get("ultimo_stato", "calma")
        prev_rapido = bool(prev.get("rapido_attivo", False))

        corr = _stato_da_livello(l)
        rateo = l.ratei[0] if l.ratei else None
        rapido = rateo is not None and rateo >= config.RATEO_RAPIDO_M

        # Escalation di soglia (es. calma->soglia1, soglia1->soglia2)
        if _RANK[corr] > _RANK[prev_stato]:
            messaggi.append(_msg_allerta(l, corr))
        # Rientro
        elif _RANK[corr] < _RANK[prev_stato] and corr == "calma":
            if config.NOTIFICA_RIENTRO:
                messaggi.append(_msg_rientro(l))

        # Pre-allerta da salita rapida (solo se ancora in calma, evita doppioni con le soglie)
        if rapido and not prev_rapido and corr == "calma":
            messaggi.append(_msg_rapido(l))

        nuovo_stato.append(
            {
                "codice": l.codice,
                "fiume": l.fiume,
                "nome": l.nome,
                "ultimo_livello": l.livello_m,
                "ultimo_stato": corr,
                "rapido_attivo": rapido,
                "aggiornato_il": ora,
            }
        )

    return messaggi, nuovo_stato


def riga_letture_db(letture: list[Lettura]) -> list[dict]:
    """Mappa le Lettura in righe per la tabella em_letture."""
    return [
        {
            "codice": l.codice,
            "fiume": l.fiume,
            "nome": l.nome,
            "livello_m": l.livello_m,
            "soglia1_m": l.soglia1_m,
            "soglia2_m": l.soglia2_m,
            "rateo": l.ratei[0] if l.ratei else None,
            "ts_sir": l.timestamp,
        }
        for l in letture
    ]
