# Passerelle CORS maison (Cloudflare Worker)

Dans un navigateur, la plupart des flux RSS ne renvoient pas d'en-tête CORS :
la version web doit passer par une passerelle. Les passerelles publiques
gratuites (`allorigins`, `codetabs`, `cors.sh`, `cors.lol`) tombent
régulièrement — le 4 août 2026, `allorigins` renvoyait 522 par intermittence et
`codetabs` était HS : plus aucun article ne s'affichait sur
https://laurentsar.github.io/flux-rss/.

`proxy.js` fait le même travail sur notre propre compte Cloudflare :
**100 000 requêtes/jour en gratuit**, cache de 5 min au bord, et personne
d'autre à qui demander la permission.

## Ce que fait le Worker

- `GET /?url=<url encodée>` → renvoie le flux avec les en-têtes CORS.
- En-têtes CORS servis **uniquement** aux origines de `ALLOWED_ORIGINS`
  (github.io du projet, localhost, `capacitor://localhost`) : la passerelle
  n'est pas un proxy ouvert utilisable depuis n'importe quelle page.
- Refuse les protocoles autres que http/https et les hôtes internes
  (`localhost`, `10.x`, `192.168.x`, `.local`…) — pas de sonde de réseau privé.
- Plafond 5 Mo par flux, timeout amont 12 s, cache `public, max-age=300`.

## Déploiement

Sans wrangler (le CLI + ses dépendances ne tiennent pas sur le disque de cette
machine) : trois appels à l'API REST, dans `deploy.sh`.

1. Compte Cloudflare (gratuit) : https://dash.cloudflare.com
2. Jeton d'API : *My Profile → API Tokens → Create Token → **Edit Cloudflare
   Workers*** (permissions `Account / Workers Scripts / Edit`).
3. Déployer :

   ```bash
   export CF_API_TOKEN=…            # jeton créé à l'étape 2
   # export CF_ACCOUNT_ID=…         # facultatif : deviné sinon
   worker/deploy.sh                 # nom par défaut : flux-rss-proxy
   ```

4. Le script affiche l'URL obtenue. La reporter dans `www/app.js` :

   ```js
   const WORKER_PROXY = 'https://flux-rss-proxy.<sous-domaine>.workers.dev/?url=';
   ```

   La passerelle maison est alors essayée **en premier**, les publiques
   servent de repli (`viaProxy()` mémorise celle qui répond).

## Test

```bash
curl -s -H 'Origin: https://laurentsar.github.io' \
  "https://flux-rss-proxy.<sous-domaine>.workers.dev/?url=https%3A%2F%2Fwww.lemonde.fr%2Frss%2Fune.xml" | head -c 200
```

Le harnais de test hors-Cloudflare (Node 20 fournit `fetch`/`Request`/
`Response`, seul `caches.default` est simulé) couvre : origine autorisée,
cache HIT, origine tierce refusée, préflight, POST refusé, `?url=` manquant,
url invalide, `file://`, hôtes internes, erreur amont.

⚠️ Certains sites bloquent les IP de datacenter (ex. `realite-virtuelle.com`
renvoie 403 à toutes les passerelles testées) : ces flux-là ne remonteront que
dans l'APK, qui lit en direct depuis le téléphone.
