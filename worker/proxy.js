/*
 * Passerelle CORS maison pour la version web de Flux RSS.
 *
 * Pourquoi : dans un navigateur, la plupart des flux RSS n'envoient pas
 * d'en-tête CORS, donc la lecture directe est refusée. Les passerelles
 * publiques gratuites (allorigins, codetabs, cors.sh…) tombent régulièrement
 * ou sont rate-limitées — une panne = page web sans aucun article. Ce Worker
 * fait le même travail, sur notre propre compte Cloudflare (100 000 requêtes /
 * jour en gratuit), avec un cache de 5 min au bord.
 *
 * Usage : https://<worker>.workers.dev/?url=<url encodée>
 *
 * Déploiement : voir worker/README.md (script deploy.sh, API Cloudflare).
 */

// Seules ces origines reçoivent les en-têtes CORS : sans eux, le navigateur
// d'un site tiers refusera la réponse. Évite que la passerelle devienne un
// proxy ouvert utilisable depuis n'importe quelle page.
const ALLOWED_ORIGINS = [
  'https://laurentsar.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'capacitor://localhost',
  'https://localhost',
];

const CACHE_TTL = 300;                    // 5 min au bord
const MAX_BYTES = 5 * 1024 * 1024;        // garde-fou : 5 Mo par flux
const UPSTREAM_TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (compatible; FluxRSS/1.0; +https://github.com/laurentsar/flux-rss)';

// Hôtes internes / non routables : refusés (une passerelle ne doit pas servir
// à sonder un réseau privé).
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

function corsHeaders(origin) {
  const h = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function fail(status, msg, origin) {
  return new Response(msg + '\n', {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const reqOrigin = request.headers.get('Origin') || '';
    // Origine absente (curl, test manuel) : la requête passe, mais sans
    // en-tête CORS — inexploitable depuis une page tierce.
    const origin = ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : '';
    if (reqOrigin && !origin) return fail(403, 'origine non autorisée', '');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') return fail(405, 'GET uniquement', origin);

    const raw = new URL(request.url).searchParams.get('url');
    if (!raw) return fail(400, 'paramètre ?url= manquant', origin);

    let target;
    try { target = new URL(raw); } catch { return fail(400, 'url invalide', origin); }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return fail(400, 'protocole non autorisé', origin);
    }
    if (PRIVATE_HOST.test(target.hostname)) return fail(403, 'hôte interne refusé', origin);

    // Cache au bord, indexé sur l'URL cible (indépendant de l'origine appelante).
    const cache = caches.default;
    const cacheKey = new Request('https://proxy.invalid/?url=' + encodeURIComponent(target.href));
    const hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => h.set(k, v));
      h.set('X-Proxy-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers: h });
    }

    let upstream;
    try {
      upstream = await fetch(target.href, {
        redirect: 'follow',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
        headers: {
          'User-Agent': UA,
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        },
      });
    } catch (e) {
      return fail(502, 'flux injoignable : ' + (e && e.message || e), origin);
    }

    if (!upstream.ok) return fail(upstream.status, 'flux en erreur ' + upstream.status, origin);

    const len = parseInt(upstream.headers.get('Content-Length') || '0', 10);
    if (len > MAX_BYTES) return fail(413, 'flux trop volumineux', origin);

    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return fail(413, 'flux trop volumineux', origin);

    const type = upstream.headers.get('Content-Type') || 'application/xml; charset=utf-8';
    const headers = new Headers({
      'Content-Type': type,
      'Cache-Control': 'public, max-age=' + CACHE_TTL,
      'X-Proxy-Cache': 'MISS',
    });
    // La copie mise en cache n'embarque pas les en-têtes CORS : ils sont
    // réappliqués à chaque service, selon l'origine appelante.
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers })));
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => headers.set(k, v));
    return new Response(body, { headers });
  },
};
