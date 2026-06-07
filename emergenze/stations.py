"""
Anagrafica delle stazioni idrometriche del bacino pratese (SIR Toscana).

Le stazioni sono ordinate logicamente da MONTE a VALLE su ogni corso d'acqua:
questo ordinamento e' la chiave per il nowcasting "fatto in casa" — vedere
l'onda di piena arrivare alla stazione di monte e stimare quando colpisce Prato.

Le soglie qui sono PLACEHOLDER da confermare con la legenda ufficiale SIR
(idro-pub) e/o col Piano di Protezione Civile comunale. Il dato live del SIR
porta gia' due soglie nel record (campi sg1/sg2): all'avvio confronta questi
valori con quelli ufficiali e correggi.

Codici verificati nella sessione di recon (giugno 2026).
"""

# Ogni stazione:
#   codice    -> codice SIR (chiave nei record live)
#   fiume     -> corso d'acqua
#   nome      -> etichetta leggibile
#   posizione -> "monte" | "citta" | "valle" | "cassa"
#   ordine    -> indice monte->valle sullo stesso bacino (per il routing dell'onda)
#   lat/lon   -> da popolare dall'open data dati.toscana.it/dataset/idrometri

STAZIONI_PRATO = [
    # --- Bisenzio: monte -> citta -> valle ---
    {
        "codice": "TOS01004779",
        "fiume": "Bisenzio",
        "nome": "Gamberame",
        "posizione": "monte",
        "bacino": "Bisenzio",
        "ordine": 1,
        "lat": None,
        "lon": None,
    },
    {
        "codice": "TOS01004782",
        "fiume": "Bisenzio",
        "nome": "Prato (RADIO)",
        "posizione": "citta",
        "bacino": "Bisenzio",
        "ordine": 2,
        "lat": None,
        "lon": None,
    },
    {
        "codice": "TOS01004791",
        "fiume": "Bisenzio",
        "nome": "S. Piero a Ponti",
        "posizione": "valle",
        "bacino": "Bisenzio",
        "ordine": 3,
        "lat": None,
        "lon": None,
    },
    # --- Ombrone pratese: valle + cassa di espansione ---
    {
        "codice": "TOS01004875",
        "fiume": "Ombrone PT",
        "nome": "Poggio a Caiano",
        "posizione": "valle",
        "bacino": "Ombrone PT",
        "ordine": 2,
        "lat": None,
        "lon": None,
    },
    {
        "codice": "TOS15004865",
        "fiume": "Ombrone PT",
        "nome": "Ponte alle Vanne (Cassa)",
        "posizione": "cassa",
        "bacino": "Ombrone PT",
        "ordine": 3,
        "lat": None,
        "lon": None,
    },
]

# Set dei codici per filtraggio veloce
CODICI_PRATO = {s["codice"] for s in STAZIONI_PRATO}

# Lookup codice -> metadati
def meta(codice: str) -> dict | None:
    for s in STAZIONI_PRATO:
        if s["codice"] == codice:
            return s
    return None
