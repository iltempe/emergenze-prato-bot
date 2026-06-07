"""Test offline del parser della pagina Protezione Civile Prato (nessuna rete).

Esegui:  python -m tests.test_pc_prato     (dalla root del progetto)
"""

from emergenze import pc_prato

# Frammento realistico (con null byte come nella pagina vera) — stato verde.
HTML_NORMALITA = (
    '<div id="regola_default">'
    '<div class="inner_oggetto0"><div>'
    '<i class="fas fa-circle fa-2x" style="color: green"></i> '
    '<span style="color: green; font-size: 1.3em !important;">'
    '07.06.2026 ore 22:05 - Stato di normalit\x00 al momento non ci sono '
    'dichiarazioni di "Stato di Allerta" del CFR (Centro Funzionale Regionale '
    'della Toscana)</span></div></div></div>'
)

# Stessa pagina, ORARIO diverso ma stesso messaggio -> NON deve contare come cambio.
HTML_NORMALITA_ORARIO_DIVERSO = HTML_NORMALITA.replace("ore 22:05", "ore 23:10")

# Stato di allerta arancione (sintetico).
HTML_ALLERTA = (
    '<div id="regola_default"><div class="inner_oggetto0"><div>'
    '<i class="fas fa-circle fa-2x" style="color: orange"></i> '
    '<span style="color: orange;">07.06.2026 ore 14:00 - Stato di Allerta '
    'ARANCIONE per rischio idrogeologico-idraulico</span></div></div></div>'
)

HTML_ROTTO = "<html><body>nessun blocco di stato qui</body></html>"


def test_parse_normalita():
    st = pc_prato.parse(HTML_NORMALITA)
    assert st is not None
    assert st.colore == "green"
    assert st.is_normalita is True
    assert st.emoji == "🟢"
    assert "\x00" not in st.testo          # null byte ripulito
    assert "Stato di normalit" in st.testo


def test_parse_allerta():
    st = pc_prato.parse(HTML_ALLERTA)
    assert st is not None
    assert st.colore == "orange"
    assert st.is_normalita is False
    assert st.emoji == "🟠"
    assert "ARANCIONE" in st.testo


def test_dedup_ignora_il_timestamp():
    a = pc_prato.parse(HTML_NORMALITA)
    b = pc_prato.parse(HTML_NORMALITA_ORARIO_DIVERSO)
    # Il messaggio normalizzato (senza data/ora) deve coincidere.
    assert a.messaggio_norm == b.messaggio_norm
    # Mentre il testo completo differisce (orari diversi).
    assert a.testo != b.testo


def test_cambio_stato_cambia_la_chiave():
    norm = pc_prato.parse(HTML_NORMALITA).messaggio_norm
    allerta = pc_prato.parse(HTML_ALLERTA).messaggio_norm
    assert norm != allerta


def test_struttura_mancante_ritorna_none():
    assert pc_prato.parse(HTML_ROTTO) is None


def _run():
    fns = [v for k, v in globals().items() if k.startswith("test_")]
    ok = 0
    for fn in fns:
        fn()
        print(f"  PASS  {fn.__name__}")
        ok += 1
    print(f"\n{ok}/{len(fns)} test passati.")


if __name__ == "__main__":
    _run()
