"""Test offline del parser e dell'alert engine (nessuna rete).

Esegui:  python -m tests.test_parser     (dalla root del progetto)
"""

from emergenze.sir_scraper import parse_payload
from emergenze import alert_engine

# Payload sintetico che imita gli array JS iniettati dal SIR.
# Include: una stazione pratese in calma, una pratese sopra soglia,
# una NON pratese (deve essere filtrata).
PAYLOAD = """
var d = new Array();
d[0] = new Array("TOS01004782","Bisenzio","Prato (RADIO)","PO","Bisenzio","B","1.50","1.00","-0.46","3.99","0.00","-0.01","-0.01","07/06 19.45");
d[1] = new Array("TOS01004779","Bisenzio","Gamberame","PO","Bisenzio","B","2.00","1.20","1.85","3.99","0.22","0.10","0.05","07/06 19.45");
d[2] = new Array("TOS99999999","Arno","Firenze","FI","Arno","B","3.00","2.00","0.50","9.9","0.0","0.0","0.0","07/06 19.45");
"""


def test_filtra_solo_prato():
    letture = parse_payload(PAYLOAD, solo_prato=True)
    codici = {l.codice for l in letture}
    assert "TOS99999999" not in codici, "stazione non pratese non filtrata"
    assert codici == {"TOS01004782", "TOS01004779"}, codici


def test_campi_decodificati():
    letture = {l.codice: l for l in parse_payload(PAYLOAD, solo_prato=True)}
    prato = letture["TOS01004782"]
    assert prato.fiume == "Bisenzio"
    assert prato.livello_m == -0.46
    # Soglie normalizzate: guardia<=allarme  (1.00, 1.50)
    assert prato.soglia1_m == 1.00
    assert prato.soglia2_m == 1.50
    assert prato.sopra_soglia1 is False
    assert prato.sopra_soglia2 is False
    assert prato.nome == "Prato (RADIO)"


def test_sopra_soglia_e_rateo():
    letture = {l.codice: l for l in parse_payload(PAYLOAD, solo_prato=True)}
    gamb = letture["TOS01004779"]
    # livello 1.85, soglie normalizzate (1.20 guardia, 2.00 allarme)
    assert gamb.soglia1_m == 1.20
    assert gamb.soglia2_m == 2.00
    assert gamb.sopra_soglia1 is True   # 1.85 >= 1.20
    assert gamb.sopra_soglia2 is False  # 1.85 < 2.00
    assert gamb.ratei[0] == 0.22        # rateo principale


def test_alert_engine_escalation():
    letture = parse_payload(PAYLOAD, solo_prato=True)
    # Stato precedente: tutto calma -> Gamberame deve generare allerta guardia
    messaggi, nuovo_stato = alert_engine.valuta(letture, stato_prec={})
    testo = "\n".join(messaggi)
    assert "ALLERTA" in testo
    stati = {r["codice"]: r["ultimo_stato"] for r in nuovo_stato}
    assert stati["TOS01004779"] == "soglia1"
    assert stati["TOS01004782"] == "calma"


def test_alert_engine_nessun_doppione():
    letture = parse_payload(PAYLOAD, solo_prato=True)
    # Stato precedente gia' in soglia1 -> niente nuova allerta (no spam)
    prec = {"TOS01004779": {"ultimo_stato": "soglia1", "rapido_attivo": True}}
    messaggi, _ = alert_engine.valuta(letture, prec)
    assert all("ALLERTA" not in m for m in messaggi), messaggi


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
