"""Accesso a Supabase via PostgREST (solo requests, niente SDK pesante).

Usa la service_role key: bypassa RLS, quindi gira solo lato server (GitHub Actions),
mai esporre la chiave in un client.
"""

from __future__ import annotations

from typing import Optional

import requests

from . import config

_TIMEOUT = 15


def _headers(extra: Optional[dict] = None) -> dict:
    if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_KEY non configurati.")
    h = {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def _rest(path: str) -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{path}"


def insert_letture(righe: list[dict]) -> None:
    """Inserisce una o piu' letture nella serie temporale em_letture."""
    if not righe:
        return
    r = requests.post(
        _rest("em_letture"),
        headers=_headers({"Prefer": "return=minimal"}),
        json=righe,
        timeout=_TIMEOUT,
    )
    r.raise_for_status()


def get_stato() -> dict[str, dict]:
    """Stato corrente per stazione, indicizzato per codice."""
    r = requests.get(
        _rest("em_stato?select=*"),
        headers=_headers(),
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    return {row["codice"]: row for row in r.json()}


def upsert_stato(righe: list[dict]) -> None:
    """Upsert (merge su chiave 'codice') dello stato corrente."""
    if not righe:
        return
    r = requests.post(
        _rest("em_stato"),
        headers=_headers(
            {"Prefer": "resolution=merge-duplicates,return=minimal"}
        ),
        json=righe,
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
