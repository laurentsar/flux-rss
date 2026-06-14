# Flux RSS

Lecteur de **flux RSS multi-thèmes** (FR + EN), autonome, dérivé du système Home Assistant.
9 catégories, 76 flux vérifiés. Récupération **native dans l'APK** (CapacitorHttp → pas de CORS).

- Web pur dans `www/` (HTML/CSS/JS vanilla, 0 dépendance runtime) = PWA + contenu embarqué dans l'APK.
- Données : `www/data/feeds.json` (catégories + flux).
- APK construit par **GitHub Actions** (`.github/workflows/build-apk.yml`) → release auto.

## Catégories
🚗 Tesla & Recharge · 🥽 VR/XR · 🛡️ Cyber · 🤖 IA · 🏉 Rugby · 🏠 Domotique · ☀️ Énergie/Solaire · 🔥 Deals FR · 🇬🇧 Anglais

## PWA (sans build)
Servir `www/` en HTTPS/localhost. ⚠️ Dans un navigateur, la lecture directe des flux est bloquée par CORS
(repli via proxy public) — l'**APK** récupère les flux nativement, sans cette limite.
