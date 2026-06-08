# Fonti dati per arricchire EmergenzePrato

Catalogo di fonti utili per il servizio allerte di Prato. Per ognuna: **cosa dà**,
**URL**, e soprattutto **come si ingerisce**, che è la cosa che conta davvero:

- 🟢 **macchina-pronta** — API REST/JSON o feed strutturato, integrazione diretta
- 🟡 **semi-strutturata** — XML / CSV / WMS / GeoTIFF / GitHub raw (serve un parser ma è stabile)
- 🔴 **solo web** — niente API ufficiale, va fatto scraping (fragile)

> Stato: giugno 2026. Gli endpoint vanno comunque ri-verificati al primo collegamento.

---

## 1. Idro-meteo in tempo reale (il cuore del servizio)

**SIR Toscana — Idrometria** 🔴 *(già in uso)*
Livelli fiumi/portate in tempo reale, soglie e ratei. Endpoint a 2 step con hash.
`https://www.sir.toscana.it/monitoraggio/stazioni.php?type=idro`
→ Aggiungere anche i **pluviometri** (`type=pluvio`) a monte del Bisenzio: sono la base del nowcasting dell'onda di piena.

**CFR Toscana — Centro Funzionale Regionale** 🔴/🟡
Bollettino di vigilanza meteo e bollettino di criticità regionale; dati grezzi di livelli/piogge.
`https://www.cfr.toscana.it/` — pagine consultabili, da valutare se espongono feed.

**LaMMA — Consorzio meteo Toscana (open data)** 🟡
Previsioni a 5 giorni per **287 località toscane in XML** (aggiornate 2×/giorno), dati stazioni mezz'ora in CSV, mappe in GeoTIFF, anagrafica via API.
`https://dati.toscana.it/dataset?organization=lamma-toscana` · `https://www.lamma.toscana.it/`
→ Ottima per la **pioggia prevista** su Prato nelle prossime 24-72h (fase previsionale).

**Open-Meteo — Forecast API** 🟢 *(consigliata, gratis, no API key)*
Pioggia/temperatura/vento previsti orari, JSON pulito, copertura puntuale su coordinate.
`https://open-meteo.com/en/docs`
→ La via più rapida per dare al bot un **preavviso meteo** ("in arrivo 40mm in 3h su Prato").

**Open-Meteo — Flood API (GloFAS)** 🟢
Portata fluviale prevista (river discharge, m³/s) fino a 210 giorni, basata su Copernicus GloFAS, risoluzione ~5km.
`https://open-meteo.com/en/docs/flood-api`
→ Utile come **secondo parere** sull'andamento atteso dei corsi d'acqua, da incrociare col dato SIR locale (occhio: 5km è grossolano per bacini piccoli come il Bisenzio).

---

## 2. Allerte ufficiali (Protezione Civile)

**allertameteo.app — API REST gratuita** 🟢 *(consigliata)*
Livello di criticità (idraulico, temporali, idrogeologico) per **oggi e domani** per tutti i 7.904 comuni italiani, Prato incluso. REST senza registrazione né limiti, JSON/CSV, archivio storico. I dati arrivano dal repo ufficiale DPC.
`https://allertameteo.app/`
→ Il modo più semplice per arricchire le allerte con il **codice colore ufficiale** del Comune di Prato.

**DPC — repository ufficiale bollettini (GitHub)** 🟡 *(fonte autorevole a monte)*
Bollettini di criticità idrogeologica/idraulica e di vigilanza meteo nazionali, pubblicati dal Dipartimento Protezione Civile.
`https://github.com/pcm-dpc` · mirror CSV community: `https://github.com/opendatasicilia/DPC-bollettini-criticita-idrogeologica-idraulica`
→ Se vuoi la fonte primaria invece di un intermediario.

**Regione Toscana — Allerta Meteo** 🔴/🟡
Bollettini e dichiarazioni di allerta regionali (le 25 zone Toscana, Prato è in "Medio Valdarno").
`https://www.regione.toscana.it/allertameteo`

**Comune di Prato — Protezione Civile / Emergenze** 🔴 *(già in integrazione)*
Dichiarazioni di allerta e stato emergenze in corso. La fonte più locale.
`https://protezionecivile.comune.prato.it/` · `https://emergenze.comune.prato.it/`

**IT-Alert** ℹ️ *(no API)*
Cell broadcast nazionale per emergenze imminenti. Non integrabile, ma vale citarlo nei messaggi come canale ufficiale di ultimo miglio.

---

## 3. Radar e nowcasting (finestra 0-6h)

**Radar-DPC v2 — Protezione Civile nazionale** 🟢/🟡 *(consigliata per il nowcasting)*
Mosaico radar nazionale in tempo reale, pioggia stimata, fulminazioni, satellite. Espone **Open Access Web Services**.
`https://radar.protezionecivile.it/` · doc: `https://dpc-radar.readthedocs.io/`
→ Il pezzo che ti permette di vedere la cella temporalesca *prima* che scarichi sul bacino.

**LaMMA — radar e nowcasting Toscana** 🟡
Prodotti radar regionali. `https://www.lamma.toscana.it/`

---

## 4. Altri rischi (per allargare "emergenze" oltre l'idro)

**INGV — Terremoti** 🟢
Eventi sismici in tempo reale via webservice FDSN (QuakeML) e **feed GeoRSS**. Filtrabile per area → puoi limitare al territorio pratese/toscano.
`https://terremoti.ingv.it/en/webservices_and_software` · `https://webservices.ingv.it/`

**EFFIS — Incendi boschivi (Copernicus)** 🟡
Pericolo incendi (mappe fire danger con forecast a 6 giorni), hotspot e perimetri aree bruciate. Web services + data request.
`https://forest-fire.emergency.copernicus.eu/applications/data-and-services`
→ Rilevante d'estate per la collina pratese (Monteferrato, Calvana).

**Copernicus EMS — Rapid Mapping** 🟡
Le attivazioni tipo **EMSR705** (l'alluvione del nov 2023): mappe di delineazione/danni post-evento. Utile per validare le tue zone a rischio e per la comunicazione.
`https://mapping.emergency.copernicus.eu/`

**ARPAT — Agenzia ambientale Toscana** 🟡/🔴
Qualità aria, qualità acque, dati ambientali. `https://www.arpat.toscana.it/`

---

## 5. Dati di base e hazard mapping (non real-time, ma per il "cervello")

**dati.toscana.it — Open Data Regione** 🟢/🟡
Anagrafica idrometri con **coordinate** (per la mappa), dataset meteo. `https://dati.toscana.it/dataset/idrometri`

**PGRA — Piani Gestione Rischio Alluvioni** 🟡
Mappe di pericolosità idraulica (tempi di ritorno 30/200/500 anni) dell'Autorità di Bacino Distrettuale dell'Appennino Settentrionale. Base per definire quali zone/vie segnalare.
`https://www.appenninosettentrionale.it/`

**Copernicus EWDS — EFAS/GloFAS (avanzato)** 🟡
Early Warning Data Store: previsioni idrologiche europee, **OGC API**, formati GRIB/NetCDF. Per la fase 2 di nowcasting serio.
`https://global-flood.emergency.copernicus.eu/`

---

## Priorità consigliate per i prossimi passi

1. **Open-Meteo Forecast API** 🟢 — preavviso pioggia 24-72h, integrazione in mezz'ora. Massimo valore/sforzo.
2. **allertameteo.app** 🟢 — codice colore ufficiale per Prato, arricchisce ogni messaggio.
3. **SIR pluviometri a monte** 🔴 — stesso scraper che hai già, abilita il nowcasting dell'onda Bisenzio.
4. **Radar-DPC v2** 🟢 — nowcasting 0-6h, la finestra che conta davvero per i flash flood pratesi.

---

### Nota sull'affidabilità
Mescolare fonti **previsionali** (Open-Meteo, LaMMA, allerte colore) e **real-time/osservate**
(SIR, radar) è la forza del servizio, ma vanno tenute distinte nei messaggi: la previsione dà
preavviso ampio ma incerto, il dato osservato dà certezza ma poco anticipo. Etichetta sempre
la fonte e l'ora del dato.
