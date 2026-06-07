"""Invio messaggi al canale Telegram via Bot API."""

from __future__ import annotations

import requests

from . import config

_TIMEOUT = 15


def invia(testo: str, silenzioso: bool = False) -> dict:
    """Manda un messaggio HTML al canale configurato.

    silenzioso=True -> notifica senza suono (per i bollettini di routine).
    """
    if not config.TELEGRAM_BOT_TOKEN or not config.TELEGRAM_CHAT_ID:
        raise RuntimeError("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID non configurati.")
    url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": config.TELEGRAM_CHAT_ID,
        "text": testo,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "disable_notification": silenzioso,
    }
    r = requests.post(url, json=payload, timeout=_TIMEOUT)
    r.raise_for_status()
    return r.json()
