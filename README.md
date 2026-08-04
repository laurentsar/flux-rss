# Flux RSS

Lecteur de **flux RSS multi-thèmes** (FR + EN), autonome, dérivé du système Home Assistant.
Catégories thématiques avec interrupteur de langue 🇫🇷/🇬🇧 (sources FR ou EN). Récupération **native dans l'APK** (CapacitorHttp → pas de CORS).

- Web pur dans `www/` (HTML/CSS/JS vanilla, 0 dépendance runtime) = PWA + contenu embarqué dans l'APK.
- Données : `www/data/feeds.json` (catégories + flux).
- APK construit par **GitHub Actions** (`.github/workflows/build-apk.yml`) → release auto.

## Catégories
🚗 Tesla & Recharge · 🥽 VR/XR · 🛡️ Cyber · 🤖 IA · 🏉 Rugby · 🏠 Domotique · ☀️ Énergie/Solaire · 🔥 Deals FR · 🇬🇧 Anglais

## Page web / PWA

L'app est publiée telle quelle sur le web : **https://laurentsar.github.io/flux-rss/**

Le CI (`.github/workflows/deploy-pages.yml`) déploie `www/` sur GitHub Pages à
chaque push sur `master` (source Pages = *GitHub Actions*). Les chemins du
`manifest.webmanifest` et du `sw.js` sont relatifs (`./`), donc l'app fonctionne
aussi bien à la racine d'une origine (WebView Capacitor) que dans le
sous-dossier `/flux-rss/` de github.io.

### Installation sur iPhone (gratuit, sans App Store)
1. Ouvrir l'URL ci-dessus dans **Safari** (obligatoire : les autres navigateurs
   iOS ne proposent pas l'installation).
2. **Partager** → **« Sur l'écran d'accueil »** → **Ajouter**.

L'icône Flux RSS apparaît sur l'écran d'accueil et s'ouvre en plein écran.

### Limite du web vs APK
⚠️ Dans un navigateur, la lecture directe des flux est bloquée par CORS : l'app
bascule automatiquement sur un proxy public (`api.allorigins.win`), donc
quelques flux peuvent être plus lents ou temporairement indisponibles. L'**APK**
récupère les flux nativement (CapacitorHttp), sans cette limite.

Pour servir en local : `www/` sur HTTPS/localhost (ex. `python3 -m http.server`).
