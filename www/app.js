'use strict';

/* ---------- config ---------- */
const PALETTE = ['#ef4444','#2563eb','#16a34a','#9333ea','#ea580c','#0891b2','#db2777','#4f46e5'];
const CAT_COLORS = {
  ve:['#E31937','#7A0D1C'], vr:['#00BCD4','#00626E'], cyber:['#E67E22','#8A4A10'],
  ia:['#6366F1','#312E81'], rugby:['#16A34A','#0B5D2A'], domotique:['#0EA5E9','#075985'],
  solaire:['#F59E0B','#92600A'], deals_fr:['#27AE60','#145F34'], anglais:['#1E3A8A','#0C1E4A'],
};
const PER_FEED = 12;       // articles gardés par flux
const MAX_SHOW = 60;       // articles affichés par catégorie
const PROXY = 'https://api.allorigins.win/raw?url='; // repli CORS (PWA navigateur)

const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

/* ---------- état ---------- */
let DATA = null;
let current = null;

const $ = (s) => document.querySelector(s);
const elCats = $('#cats'), elArticles = $('#articles'), elStatus = $('#status'), elRefresh = $('#refresh');

/* ---------- réseau ---------- */
async function httpGet(url){
  if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp){
    const r = await window.Capacitor.Plugins.CapacitorHttp.get({
      url, headers:{'User-Agent':'FluxRSS/1.0','Accept':'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'},
      responseType:'text', connectTimeout:15000, readTimeout:15000,
    });
    return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  }
  // navigateur : direct puis repli proxy CORS
  try{
    const r = await fetch(url, {redirect:'follow'});
    if (r.ok) return await r.text();
    throw new Error('http '+r.status);
  }catch(e){
    const r = await fetch(PROXY + encodeURIComponent(url));
    if (!r.ok) throw new Error('proxy '+r.status);
    return await r.text();
  }
}

/* ---------- parsing RSS / Atom ---------- */
function txt(node, sel){ const n = node.querySelector(sel); return n ? (n.textContent||'').trim() : ''; }

function extractImage(itemEl, html){
  // media:content / media:thumbnail / enclosure
  const cands = itemEl.getElementsByTagName('*');
  for (const n of cands){
    const t = n.tagName.toLowerCase();
    if ((t==='media:content'||t==='media:thumbnail') && n.getAttribute('url')) return n.getAttribute('url');
    if (t==='enclosure' && (n.getAttribute('type')||'').startsWith('image')) return n.getAttribute('url');
    if (t==='itunes:image' && n.getAttribute('href')) return n.getAttribute('href');
  }
  const m = (html||'').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function parseFeed(xmlText, source){
  let doc;
  try{ doc = new DOMParser().parseFromString(xmlText, 'text/xml'); }catch(e){ return []; }
  if (doc.querySelector('parsererror')) {
    try{ doc = new DOMParser().parseFromString(xmlText, 'text/html'); }catch(e){ return []; }
  }
  const out = [];
  const items = doc.querySelectorAll('item, entry');
  items.forEach((it) => {
    const title = txt(it,'title');
    let link = txt(it,'link');
    const la = it.querySelector('link');
    if ((!link || link.length<4) && la && la.getAttribute('href')) link = la.getAttribute('href');
    const date = txt(it,'pubDate') || txt(it,'published') || txt(it,'updated') || txt(it,'date');
    const rawSummary = txt(it,'description') || txt(it,'summary') || txt(it,'content') || '';
    const image = extractImage(it, rawSummary);
    const summary = rawSummary.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    if (title && link) out.push({ title, link, date, ts: Date.parse(date)||0, summary, image, source });
  });
  return out.slice(0, PER_FEED);
}

/* ---------- chargement catégorie ---------- */
function cacheKey(id){ return 'feedcache:'+id; }

async function loadCategory(cat, {silent=false}={}){
  current = cat.id;
  const [a,b] = CAT_COLORS[cat.id] || ['#F26522','#A8400F'];
  document.documentElement.style.setProperty('--a',a);
  document.documentElement.style.setProperty('--b',b);
  $('#hero-sub').textContent = cat.label;

  // cache immédiat
  const cached = JSON.parse(localStorage.getItem(cacheKey(cat.id)) || 'null');
  if (cached && cached.items && cached.items.length){
    render(cached.items, cat.id, cached.ts);
  } else if (!silent){
    elArticles.innerHTML = '';
    elStatus.innerHTML = '<span class="spinner"></span>Chargement des flux…';
  }

  elRefresh.classList.add('spinning');
  const results = await Promise.allSettled(cat.feeds.map(async (f) => {
    const xml = await httpGet(f.url);
    return parseFeed(xml, f.name);
  }));
  elRefresh.classList.remove('spinning');
  if (current !== cat.id) return; // l'utilisateur a changé de catégorie

  let items = [];
  let ok = 0;
  results.forEach((r) => { if (r.status==='fulfilled'){ ok++; items = items.concat(r.value); } });
  items.sort((x,y)=> y.ts - x.ts);
  items = items.slice(0, MAX_SHOW);

  if (items.length){
    const ts = Date.now();
    localStorage.setItem(cacheKey(cat.id), JSON.stringify({ts, items}));
    render(items, cat.id, ts);
  } else if (!cached){
    elStatus.textContent = isNative
      ? 'Aucun article récupéré. Vérifie ta connexion.'
      : 'Aucun article (le navigateur bloque souvent les flux : utilise l’APK).';
  }
}

/* ---------- rendu ---------- */
function fmtDate(d){
  const t = Date.parse(d); if (!t) return '';
  const dt = new Date(t);
  const p = (n)=> String(n).padStart(2,'0');
  return `${p(dt.getDate())}/${p(dt.getMonth()+1)} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
function esc(s){ return (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function render(items, catId, ts){
  const updated = ts ? `Mis à jour ${fmtDate(new Date(ts).toISOString())}` : '';
  elStatus.textContent = `${items.length} articles · ${updated}`;
  const html = items.map((it, i) => {
    const accent = PALETTE[i % PALETTE.length];
    const dateHtml = it.date ? `<span class="date">🕒 ${esc(fmtDate(it.date))}</span>` : '';
    const src = `<span class="src">${esc(it.source)}</span>`;
    const excerpt = it.summary.length > 280 ? esc(it.summary.slice(0,280))+'…' : esc(it.summary);
    if (it.summary.length > 40){
      const img = it.image ? `<img class="lead" src="${esc(it.image)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : '';
      return `<details class="card" style="--accent:${accent}">
        <summary><span class="dot"></span><span class="ctitle"><b>${esc(it.title)}</b>${dateHtml}${src}</span><span class="chev">▾</span></summary>
        <div class="cbody">${img}${excerpt}<br><a class="read" href="${esc(it.link)}" target="_blank" rel="noopener">Lire l'article →</a></div>
      </details>`;
    }
    const thumb = it.image ? `<img class="thumb" src="${esc(it.image)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : '';
    return `<a class="card" style="--accent:${accent}" href="${esc(it.link)}" target="_blank" rel="noopener">
      <span class="dot"></span>${thumb}<span class="ctitle"><b>${esc(it.title)}</b>${dateHtml}${src}</span></a>`;
  }).join('');
  elArticles.innerHTML = html;
  window.scrollTo({top:0, behavior:'smooth'});
}

/* ---------- catégories ---------- */
function renderChips(){
  elCats.innerHTML = DATA.categories.map(c =>
    `<button class="chip" data-id="${c.id}">${esc(c.label)}</button>`).join('');
  elCats.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => selectCat(btn.dataset.id));
  });
}
function selectCat(id){
  const cat = DATA.categories.find(c => c.id === id);
  if (!cat) return;
  localStorage.setItem('lastCat', id);
  elCats.querySelectorAll('.chip').forEach(b => {
    const on = b.dataset.id === id;
    b.classList.toggle('active', on);
    if (on){ const [a,b2]=CAT_COLORS[id]||['#F26522','#A8400F']; b.style.setProperty('--a',a); b.style.setProperty('--b',b2); }
  });
  loadCategory(cat);
}

/* ---------- configuration personnalisable ---------- */
let DEFAULTS = null;
const clone = (o) => JSON.parse(JSON.stringify(o));
const slug = (s) => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
  .replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'') || 'cat';
function saveConfig(){ localStorage.setItem('fluxConfig', JSON.stringify(DATA)); }
function newCatId(base){ let id=slug(base), n=2; while(DATA.categories.some(c=>c.id===id)){ id=slug(base)+'_'+n; n++; } return id; }

function refreshAfterConfig(){
  if (!DATA.categories.length){ DATA.categories=clone(DEFAULTS.categories); saveConfig(); }
  renderChips();
  const cat = DATA.categories.find(c=>c.id===current) || DATA.categories[0];
  selectCat(cat.id);
}

/* ---------- menu réglages ---------- */
const elModal = $('#modal'), elCard = $('#modal-card');
function openSettings(){ renderSettings(); elModal.hidden=false; }
function closeSettings(){ elModal.hidden=true; refreshAfterConfig(); }

function renderSettings(){
  const cats = DATA.categories.map((c,ci) => {
    const color = (CAT_COLORS[c.id]||['#F26522'])[0];
    const feeds = c.feeds.map((f,fi) => `
      <div class="feed-row">
        <input class="f-name" data-ci="${ci}" data-fi="${fi}" value="${esc(f.name)}">
        <input class="f-url" data-ci="${ci}" data-fi="${fi}" value="${esc(f.url)}">
        <button class="iconbtn" data-act="del-feed" data-ci="${ci}" data-fi="${fi}">✕</button>
      </div>`).join('');
    return `<div class="cat-block" style="--accent:${color}">
      <div class="cat-head">
        <input class="cat-label" data-ci="${ci}" value="${esc(c.label)}">
        <button class="iconbtn" data-act="del-cat" data-ci="${ci}">🗑️</button>
      </div>
      ${feeds}
      <div class="feed-add">
        <input class="nf-name" data-ci="${ci}" placeholder="Nom du flux">
        <input class="nf-url" data-ci="${ci}" placeholder="https://…/feed">
        <button class="btn add" data-act="add-feed" data-ci="${ci}">+ Ajouter</button>
      </div>
    </div>`;
  }).join('');
  elCard.innerHTML = `
    <div class="modal-head"><h2>⚙️ Personnaliser</h2><button data-act="close">✕</button></div>
    <div class="modal-body">
      <div class="hint">Ajoute, modifie ou supprime catégories et flux. Sauvegarde auto sur cet appareil.</div>
      ${cats}
      <div class="add-cat">
        <input id="new-cat" placeholder="Nouvelle catégorie (ex : 🎮 Jeux)">
        <button class="btn cat" data-act="add-cat">+ Catégorie</button>
      </div>
      <button class="btn reset" data-act="reset">↺ Restaurer les flux par défaut</button>
    </div>`;
}

function onSettingsChange(e){
  const t=e.target, ci=+t.dataset.ci, fi=+t.dataset.fi, v=t.value.trim();
  if (t.classList.contains('cat-label')) DATA.categories[ci].label=v;
  else if (t.classList.contains('f-name')) DATA.categories[ci].feeds[fi].name=v;
  else if (t.classList.contains('f-url')) DATA.categories[ci].feeds[fi].url=v;
  else return;
  saveConfig();
}
function onSettingsClick(e){
  const btn=e.target.closest('[data-act]'); if(!btn) return;
  const act=btn.dataset.act, ci=+btn.dataset.ci, fi=+btn.dataset.fi;
  if (act==='close'){ closeSettings(); return; }
  if (act==='del-feed'){ DATA.categories[ci].feeds.splice(fi,1); }
  else if (act==='del-cat'){ if(!confirm('Supprimer cette catégorie ?')) return; DATA.categories.splice(ci,1); }
  else if (act==='add-feed'){
    const name=elCard.querySelector(`.nf-name[data-ci="${ci}"]`).value.trim();
    const url=elCard.querySelector(`.nf-url[data-ci="${ci}"]`).value.trim();
    if(!name||!/^https?:\/\//i.test(url)){ alert('Indique un nom et une URL valide (http…).'); return; }
    DATA.categories[ci].feeds.push({name,url});
  }
  else if (act==='add-cat'){
    const label=elCard.querySelector('#new-cat').value.trim();
    if(!label){ alert('Donne un nom de catégorie.'); return; }
    DATA.categories.push({id:newCatId(label),label,lang:'fr',feeds:[]});
  }
  else if (act==='reset'){ if(!confirm('Restaurer les catégories et flux d\'origine ?')) return; DATA=clone(DEFAULTS); }
  else return;
  saveConfig(); renderSettings();
}

/* ---------- init ---------- */
async function init(){
  DEFAULTS = await (await fetch('data/feeds.json')).json();
  const saved = localStorage.getItem('fluxConfig');
  DATA = saved ? JSON.parse(saved) : clone(DEFAULTS);
  renderChips();
  const last = localStorage.getItem('lastCat');
  const start = DATA.categories.find(c=>c.id===last) ? last : DATA.categories[0].id;
  selectCat(start);
  elRefresh.addEventListener('click', () => {
    const cat = DATA.categories.find(c => c.id === current);
    if (cat) loadCategory(cat);
  });
  $('#settings-btn').addEventListener('click', openSettings);
  elCard.addEventListener('click', onSettingsClick);
  elCard.addEventListener('change', onSettingsChange);
  elModal.addEventListener('click', (e)=>{ if(e.target===elModal) closeSettings(); });
  if ('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('sw.js'); }catch(e){} }
}
init();
