"""Verifica setup Telegram — da eseguire in locale, NON in CI.

Serve a: (1) confermare che il token funziona, (2) trovare il chat_id del
canale, (3) mandare un messaggio di prova.

Bot: @emergenzeprato_bot

Uso:
    export TELEGRAM_BOT_TOKEN="123456:ABC..."        # il tuo token da @BotFather
    python -m emergenze.setup_check                  # getMe + lista chat viste
    export TELEGRAM_CHAT_ID="@nomecanale"            # oppure -100xxxxxxxxxx
    python -m emergenze.setup_check --test           # manda un messaggio di prova

Come trovare il chat_id di un CANALE:
    1. Aggiungi @emergenzeprato_bot come AMMINISTRATORE del canale.
    2. Pubblica un messaggio qualsiasi nel canale.
    3. Esegui questo script: il chat_id del canale comparira' tra le chat viste
       (tipicamente un numero negativo che inizia con -100).
    In alternativa, se il canale e' pubblico, basta usare @nomecanale.
"""

from __future__ import annotations

import os
import sys

import requests

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
API = f"https://api.telegram.org/bot{TOKEN}"


def _check_token() -> bool:
    if not TOKEN:
        print("✗ TELEGRAM_BOT_TOKEN non impostato.", file=sys.stderr)
        return False
    r = requests.get(f"{API}/getMe", timeout=15)
    if not r.ok or not r.json().get("ok"):
        print(f"✗ Token non valido: {r.text}", file=sys.stderr)
        return False
    me = r.json()["result"]
    print(f"✓ Bot ok: @{me.get('username')} (id {me.get('id')})")
    return True


def _list_chats() -> None:
    r = requests.get(f"{API}/getUpdates", timeout=15)
    data = r.json().get("result", [])
    if not data:
        print("\nNessun update recente. Pubblica un messaggio nel canale "
              "(col bot admin) e riprova.")
        return
    visti = {}
    for upd in data:
        for key in ("channel_post", "message", "my_chat_member"):
            obj = upd.get(key)
            if obj and "chat" in obj:
                c = obj["chat"]
                visti[c["id"]] = f"{c.get('title') or c.get('username') or c.get('type')} (tipo: {c['type']})"
    print("\nChat viste dal bot (usa l'id come TELEGRAM_CHAT_ID):")
    for cid, label in visti.items():
        print(f"  {cid}  ->  {label}")


def _send_test() -> None:
    if not CHAT_ID:
        print("✗ TELEGRAM_CHAT_ID non impostato.", file=sys.stderr)
        return
    r = requests.post(
        f"{API}/sendMessage",
        json={
            "chat_id": CHAT_ID,
            "text": "✅ <b>EmergenzePrato</b>: test di collegamento riuscito. "
                    "Il canale ricevera' qui le allerte idrometriche.",
            "parse_mode": "HTML",
        },
        timeout=15,
    )
    if r.ok and r.json().get("ok"):
        print(f"✓ Messaggio di prova inviato a {CHAT_ID}.")
    else:
        print(f"✗ Invio fallito: {r.text}", file=sys.stderr)


def main(argv: list[str]) -> int:
    if not _check_token():
        return 1
    if "--test" in argv:
        _send_test()
    else:
        _list_chats()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
