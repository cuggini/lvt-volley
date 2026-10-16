# LVT Volley — admin e risultati JSON

Questa versione mantiene il calendario e la grafica esistenti, ma sposta le partite in `data/risultati.json`. Il file JSON è già popolato con le 22 partite che erano presenti nell'HTML originale.

## File da caricare nel repository `cuggini/lvt-volley`
- `index.html` (versione aggiornata: legge `data/risultati.json`)
- `data/risultati.json` (calendario iniziale già migrato)
- `admin/index.html` (pagina di amministrazione)
- `cloudflare-worker/worker.js` (servizio che salva le modifiche nel repository)

## Configurazione
1. Carica `index.html`, `data/risultati.json` e la cartella `admin/` nella radice del repository.
2. Pubblica `cloudflare-worker/worker.js` su Cloudflare Workers.
3. Imposta come variabili/segreti del Worker:
   - `GH_OWNER` = `cuggini`
   - `GH_REPO` = `lvt-volley`
   - `GH_BRANCH` = `main` (o il branch predefinito effettivo)
   - `GH_TOKEN` = token GitHub fine-grained limitato al solo repository, con `Contents: Read and write`
   - `ADMIN_PASSWORD` = `lissone77` (provvisoria; cambiala quando vuoi)
   - `ALLOWED_ORIGIN` = `https://cuggini.github.io`
4. Apri `https://cuggini.github.io/lvt-volley/admin/`: l’URL del Worker è già inserito nel codice, quindi devi digitare soltanto la password.

Il link ADMIN è già incluso nell'index aggiornato. Il sito pubblico carica il JSON relativo al percorso `data/risultati.json`. Il token GitHub non va mai messo nell'HTML.

Nota: la pagina admin e il Worker sono predisposti per conservare data, ora, numero gara, competizione, squadre, risultato in set, parziali e palestra. Dopo aver caricato i file, verifica che il branch sia quello corretto e che il Worker sia configurato.


URL Worker configurato nella pagina ADMIN: `https://lvt.cicciodesimone.workers.dev`. Se la distribuzione Cloudflare non contiene ancora il codice di `cloudflare-worker/worker.js` e i segreti richiesti, il salvataggio non funzionerà finché non completi quella configurazione.
