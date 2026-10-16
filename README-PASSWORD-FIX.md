# Aggiornamento correzione password ADMIN

Questa versione verifica la password subito quando si preme **Accedi**, invece di scoprirlo solo al primo salvataggio. Ignora eventuali spazi involontari all'inizio/fine della password.

## File da aggiornare

1. `cloudflare-worker/worker.js`: apri Cloudflare Dashboard > Worker `lvt` > Edit code, sostituisci tutto il codice con questo file e premi Deploy.
2. `admin/index.html`: sostituisci il file `admin/index.html` nel repository GitHub `cuggini/lvt-volley` con quello incluso qui.

Non modificare `data/risultati.json`, non cambiare i segreti già configurati e non creare un nuovo token GitHub.

## Verifica

Dopo il deploy del Worker e la pubblicazione di GitHub Pages:
1. Apri https://cuggini.github.io/lvt-volley/admin/
2. Inserisci la password e premi Accedi.
3. Se è errata, il messaggio apparirà subito nella schermata di accesso.
4. Se l'accesso riesce, modifica una partita e salva.

Il Worker usa l'endpoint `POST /auth` per verificare la password e continua a usare `GET /results` e `PUT /results` per leggere e salvare le partite.
