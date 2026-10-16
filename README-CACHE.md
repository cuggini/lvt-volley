# Correzione cache LVT Volley

## 1. Sito pubblico
Sostituire `index.html` nel repository GitHub con questo file. La lettura di `data/risultati.json` usa un URL anti-cache univoco e `cache: reload`. Se la pagina resta aperta in background per più di 30 secondi, viene ricaricata quando si torna sulla scheda.

## 2. Cloudflare Worker
Nel Worker `lvt` (URL `https://lvt.cicciodesimone.workers.dev`), sostituire tutto il codice con `cloudflare-worker/worker.js` e fare Deploy. Mantiene le route `/auth` e `/results` e aggiunge intestazioni `no-store` alle risposte JSON. Non modificare le variabili o i segreti già configurati.

## Nota
Il file pubblico `data/risultati.json` resta quello nel repository: non occorre modificarlo per questa correzione. Dopo il deploy, attendere la pubblicazione GitHub Pages e fare un refresh normale della pagina.
