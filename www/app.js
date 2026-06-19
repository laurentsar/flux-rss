'use strict';

/* ---------- config ---------- */
const PALETTE = ['#ef4444','#2563eb','#16a34a','#9333ea','#ea580c','#0891b2','#db2777','#4f46e5'];
const CAT_COLORS = {
  ve:['#E31937','#7A0D1C'], vr:['#00BCD4','#00626E'], cyber:['#E67E22','#8A4A10'],
  ia:['#6366F1','#312E81'], rugby:['#16A34A','#0B5D2A'], domotique:['#0EA5E9','#075985'],
  solaire:['#F59E0B','#92600A'], deals_fr:['#27AE60','#145F34'], anglais:['#1E3A8A','#0C1E4A'],
  jeux:['#8b5cf6','#4c1d95'], voyage:['#0D9488','#0F5D57'], youtube:['#FF0000','#7A0B0B'], deals_voyage:['#EA580C','#7C2D12'],
  podcasts:['#7C3AED','#3B0764'], tesla:['#CC0000','#7A0000'],
};
const PER_FEED = 12;       // articles gardés par flux
const MAX_SHOW = 60;       // articles affichés par catégorie
const PROXY = 'https://api.allorigins.win/raw?url='; // repli CORS (PWA navigateur)

const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

/* ---------- état ---------- */
let DATA = null;
let current = null;
let RENDERED = [];
let lang = localStorage.getItem('srcLang') || 'fr';
let lastUpdated = '';

/* ---------- articles lus (masqués une fois consultés) ---------- */
const READ_KEY = 'readArticles';
let READ = (() => { try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]')); } catch (e) { return new Set(); } })();
function saveRead(){
  let arr = [...READ];
  if (arr.length > 3000) { arr = arr.slice(arr.length - 3000); READ = new Set(arr); }
  try { localStorage.setItem(READ_KEY, JSON.stringify(arr)); } catch (e) {}
}
function markRead(link){ if (link && !READ.has(link)) { READ.add(link); saveRead(); } }

/* sources actives d'une catégorie selon la langue choisie (repli FR) */
function feedsFor(cat){
  return (lang === 'en' && cat.feeds_en && cat.feeds_en.length) ? cat.feeds_en : (cat.feeds || []);
}


const $ = (s) => document.querySelector(s);
const elCats = $('#cats'), elArticles = $('#articles'), elStatus = $('#status'), elRefresh = $('#refresh');
const elRugbyLive = document.getElementById('rugby-live');

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

/* ---------- rugby live (classements + résultats via Wikipedia) ---------- */
function rugbySeason(){
  const m = new Date().getMonth(); // 0=jan
  const y = new Date().getFullYear();
  const start = m >= 7 ? y : y - 1; // saison commence en août
  return `${start}-${start+1}`;
}

function wikiUrl(page, section){
  return `https://fr.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&section=${section}&format=json&origin=*`;
}

function parseWikitables(html){
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const tables = [];
  tmp.querySelectorAll('table.wikitable').forEach(tbl => {
    const rows = [];
    tbl.querySelectorAll('tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('td,th').forEach(td => cells.push(td.textContent.replace(/\s+/g,' ').trim()));
      if (cells.length) rows.push(cells);
    });
    if (rows.length > 1) tables.push(rows);
  });
  return tables;
}

function calcPts(row){
  const v = parseInt(row[3])||0, n = parseInt(row[4])||0;
  const bo = parseInt(row[row.length-2])||0, bd = parseInt(row[row.length-1])||0;
  return v*4 + n*2 + bo + bd;
}

function renderRLStandings(rows, label, maxRows=14, topN=6, botN=2){
  if (!rows || rows.length < 2) return '';
  const total = Math.min(rows.length - 1, maxRows);
  const body = rows.slice(1, total+1).map((r,i)=>{
    const rank = parseInt(r[0])||i+1;
    const club = (r[1]||'').replace(/[A-Z]\d?\s*$|[CTPB]\d?\s*$/,'').trim();
    const cls = rank<=topN?'rl-top':botN>0&&rank>total-botN?'rl-bot':'';
    return `<tr class="${cls}"><td>${rank}</td><td class="rl-club">${esc(club)}</td><td>${r[2]||'-'}</td><td>${r[3]||'-'}</td><td>${r[4]||'-'}</td><td>${r[5]||'-'}</td><td><b>${calcPts(r)}</b></td></tr>`;
  }).join('');
  return `<details class="rl-section" open>
    <summary class="rl-sh">🏆 ${esc(label)}</summary>
    <div class="rl-table-wrap"><table class="rl-table">
      <thead><tr><th>#</th><th>Équipe</th><th>J</th><th>V</th><th>N</th><th>D</th><th>Pts</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </details>`;
}

function renderRLResults(tables, label, count=2){
  if (!tables || !tables.length) return '';
  const recent = tables.slice(-count);
  const matchesHtml = recent.map((rows, ji)=>{
    const jn = tables.length - count + ji + 1;
    const cards = rows.map(r=>{
      if (r.length < 5) return '';
      const home = r[1], hs = r[2], as_ = r[3], away = r[4];
      const hw = parseInt(hs)>parseInt(as_), aw = parseInt(as_)>parseInt(hs);
      return `<div class="rl-match"><span class="rl-tn ${hw?'rl-w':''}">${esc(home)}</span><span class="rl-sb"><b>${esc(hs)}</b><span class="rl-vs">–</span><b>${esc(as_)}</b></span><span class="rl-tn rl-tnr ${aw?'rl-w':''}">${esc(away)}</span></div>`;
    }).filter(Boolean).join('');
    return `<div class="rl-journee"><span class="rl-jlbl">Journée ${jn}</span>${cards}</div>`;
  }).join('');
  return `<details class="rl-section" open><summary class="rl-sh">🏉 ${esc(label)}</summary>${matchesHtml}</details>`;
}

async function loadRugbyLive(){
  if (!elRugbyLive) return;
  elRugbyLive.hidden = false;
  elRugbyLive.innerHTML = '<div class="rl-loading"><span class="spinner"></span>Scores & classements…</div>';
  const season = rugbySeason();
  const top14 = `Championnat de France de rugby à XV ${season}`;
  const champ = `Champions Cup ${season}`;
  // Sections 1-7 pour Champions Cup (format phase de ligue depuis 2023-24, pas de poules fixes)
  const [r1, r2, ...rChamp] = await Promise.allSettled([
    fetch(wikiUrl(top14,6)).then(r=>r.json()),
    fetch(wikiUrl(top14,7)).then(r=>r.json()),
    fetch(wikiUrl(champ,1)).then(r=>r.json()),
    fetch(wikiUrl(champ,2)).then(r=>r.json()),
    fetch(wikiUrl(champ,3)).then(r=>r.json()),
    fetch(wikiUrl(champ,4)).then(r=>r.json()),
    fetch(wikiUrl(champ,5)).then(r=>r.json()),
    fetch(wikiUrl(champ,6)).then(r=>r.json()),
    fetch(wikiUrl(champ,7)).then(r=>r.json()),
  ]);
  let html = '';
  // Top 14 classement
  if (r1.status==='fulfilled'){
    const tbls = parseWikitables(r1.value?.parse?.text?.['*']||'');
    if (tbls[0]) html += renderRLStandings(tbls[0],'Classement Top 14',14,6,2);
  }
  // Top 14 résultats (2 dernières journées)
  if (r2.status==='fulfilled'){
    const tbls = parseWikitables(r2.value?.parse?.text?.['*']||'');
    const jtbls = tbls.filter(t=>t.length>=5 && t.length<=10 && t[0].length<=6);
    if (jtbls.length) html += renderRLResults(jtbls,'Résultats récents Top 14',2);
  }
  // Champions Cup — collecte toutes les tables de classement uniques
  const seen = new Set();
  const champTables = [];
  for (const r of rChamp){
    if (r.status !== 'fulfilled') continue;
    for (const t of parseWikitables(r.value?.parse?.text?.['*']||'')){
      if (t.length < 7 || (t[0]||[]).length < 5) continue;
      // clé = header + 1ère ligne de données (évite doublons inter-sections)
      const key = (t[0]||[]).join('|') + '||' + (t[1]||[]).slice(0,3).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      champTables.push(t);
    }
  }
  if (champTables.length === 1){
    // Format phase de ligue (depuis 2023-24) : une seule grande table ~24 équipes
    const t = champTables[0];
    const rows = Math.min(t.length - 1, 24);
    html += renderRLStandings(t,'Champions Cup — Phase de ligue',rows,8,0);
  } else if (champTables.length > 1){
    // Ancien format à poules
    champTables.forEach((t,i)=>{
      html += renderRLStandings(t,`Champions Cup — Poule ${String.fromCharCode(65+i)}`,Math.min(t.length-1,8),3,0);
    });
  }
  elRugbyLive.innerHTML = html || '<div class="rl-loading">Données non disponibles.</div>';
}

function hideRugbyLive(){
  if (elRugbyLive){ elRugbyLive.hidden=true; elRugbyLive.innerHTML=''; }
}

/* ---------- chargement catégorie ---------- */
function cacheKey(id){ return 'feedcache:'+id; }

async function loadCategory(cat, {silent=false}={}){
  current = cat.id;
  const [a,b] = CAT_COLORS[cat.id] || ['#F26522','#A8400F'];
  document.documentElement.style.setProperty('--a',a);
  document.documentElement.style.setProperty('--b',b);
  $('#hero-sub').textContent = cat.label;
  if (cat.id==='rugby') loadRugbyLive(); else hideRugbyLive();

  // cache immédiat
  const cached = JSON.parse(localStorage.getItem(cacheKey(cat.id)) || 'null');
  if (cached && cached.items && cached.items.length){
    render(cached.items, cat.id, cached.ts);
  } else if (!silent){
    elArticles.innerHTML = '';
    elStatus.innerHTML = '<span class="spinner"></span>Chargement des flux…';
  }

  elRefresh.classList.add('spinning');
  const activeFeeds = feedsFor(cat).filter(f => !f.off);
  const results = await Promise.allSettled(activeFeeds.map(async (f) => {
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

function setStatus(n){
  elStatus.textContent = n ? `${n} articles · ${lastUpdated}` : `Tous les articles lus 🎉 · ${lastUpdated}`;
}
function render(items, catId, ts){
  items = items.filter(it => !READ.has(it.link));
  RENDERED = items;
  lastUpdated = ts ? `Mis à jour ${fmtDate(new Date(ts).toISOString())}` : '';
  setStatus(items.length);
  const html = items.map((it, i) => {
    const accent = PALETTE[i % PALETTE.length];
    const dateHtml = it.date ? `<span class="date">🕒 ${esc(fmtDate(it.date))}</span>` : '';
    const src = `<span class="src">${esc(it.source)}</span>`;
    const excerpt = it.summary.length > 280 ? esc(it.summary.slice(0,280))+'…' : esc(it.summary);
    const thumb = it.image ? `<img class="thumb" src="${esc(it.image)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : '';
    if (it.summary.length > 40){
      const img = it.image ? `<img class="lead" src="${esc(it.image)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : '';
      return `<details class="card" style="--accent:${accent}">
        <summary><span class="dot"></span>${thumb}<span class="ctitle"><b>${esc(it.title)}</b>${dateHtml}${src}</span><span class="chev">▾</span></summary>
        <div class="cbody">${img}${excerpt}<br><a class="read" href="${esc(it.link)}" target="_blank" rel="noopener">Lire l'article →</a></div>
      </details>`;
    }
    return `<a class="card" style="--accent:${accent}" href="${esc(it.link)}" target="_blank" rel="noopener">
      <span class="dot"></span>${thumb}<span class="ctitle"><b>${esc(it.title)}</b>${dateHtml}${src}</span></a>`;
  }).join('');
  elArticles.innerHTML = html;
  window.scrollTo({top:0, behavior:'smooth'});
}

/* ---------- catégories ---------- */
function renderChips(){
  elCats.innerHTML = DATA.categories.filter(c => !c.off).map(c =>
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

function firstEnabled(){ return DATA.categories.find(c=>!c.off); }
function refreshAfterConfig(){
  if (!DATA.categories.length){ DATA.categories=clone(DEFAULTS.categories); saveConfig(); }
  renderChips();
  let cat = DATA.categories.find(c=>c.id===current && !c.off) || firstEnabled();
  if (cat){ selectCat(cat.id); }
  else { elCats.innerHTML=''; elArticles.innerHTML=''; elStatus.textContent='Toutes les catégories sont désactivées (⚙️).'; }
}

/* ---------- menu réglages ---------- */
const elModal = $('#modal'), elCard = $('#modal-card');
function openSettings(){ renderSettings(); elModal.hidden=false; }
function closeSettings(){ elModal.hidden=true; refreshAfterConfig(); }

/* tableau de sources édité = celui de la langue active */
function catFeeds(ci){
  const c = DATA.categories[ci];
  if (lang === 'en'){ if(!c.feeds_en) c.feeds_en = []; return c.feeds_en; }
  return c.feeds;
}
function renderSettings(){
  const cats = DATA.categories.map((c,ci) => {
    const color = (CAT_COLORS[c.id]||['#F26522'])[0];
    const feeds = catFeeds(ci).map((f,fi) => `
      <div class="feed-row ${f.off?'off':''}">
        <button class="iconbtn tg" data-act="toggle-feed" data-ci="${ci}" data-fi="${fi}" title="${f.off?'Activer':'Désactiver'}">${f.off?'🚫':'👁️'}</button>
        <input class="f-name" data-ci="${ci}" data-fi="${fi}" value="${esc(f.name)}">
        <input class="f-url" data-ci="${ci}" data-fi="${fi}" value="${esc(f.url)}">
        <button class="iconbtn" data-act="del-feed" data-ci="${ci}" data-fi="${fi}">✕</button>
      </div>`).join('');
    return `<div class="cat-block ${c.off?'off':''}" style="--accent:${color}">
      <div class="cat-head">
        <button class="iconbtn tg" data-act="toggle-cat" data-ci="${ci}" title="${c.off?'Activer la catégorie':'Désactiver la catégorie'}">${c.off?'🚫':'👁️'}</button>
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
    <div class="modal-head"><h2>⚙️ Sources ${lang==='en'?'🇬🇧 EN':'🇫🇷 FR'}</h2><button data-act="close">✕</button></div>
    <div class="modal-body">
      <div class="hint">Tu édites les sources <b>${lang==='en'?'anglaises 🇬🇧':'françaises 🇫🇷'}</b> (bascule via le drapeau en haut). 👁️/🚫 activer/désactiver · ✕/🗑️ supprimer. Sauvegarde auto.</div>
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
  else if (t.classList.contains('f-name')) catFeeds(ci)[fi].name=v;
  else if (t.classList.contains('f-url')) catFeeds(ci)[fi].url=v;
  else return;
  saveConfig();
}
function onSettingsClick(e){
  const btn=e.target.closest('[data-act]'); if(!btn) return;
  const act=btn.dataset.act, ci=+btn.dataset.ci, fi=+btn.dataset.fi;
  if (act==='close'){ closeSettings(); return; }
  if (act==='del-feed'){ catFeeds(ci).splice(fi,1); }
  else if (act==='del-cat'){ if(!confirm('Supprimer cette catégorie ?')) return; DATA.categories.splice(ci,1); }
  else if (act==='toggle-cat'){ const c=DATA.categories[ci]; c.off=!c.off; }
  else if (act==='toggle-feed'){ const f=catFeeds(ci)[fi]; f.off=!f.off; }
  else if (act==='add-feed'){
    const name=elCard.querySelector(`.nf-name[data-ci="${ci}"]`).value.trim();
    const url=elCard.querySelector(`.nf-url[data-ci="${ci}"]`).value.trim();
    if(!name||!/^https?:\/\//i.test(url)){ alert('Indique un nom et une URL valide (http…).'); return; }
    catFeeds(ci).push({name,url});
  }
  else if (act==='add-cat'){
    const label=elCard.querySelector('#new-cat').value.trim();
    if(!label){ alert('Donne un nom de catégorie.'); return; }
    DATA.categories.push({id:newCatId(label),label,lang:'fr',feeds:[],feeds_en:[]});
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
  // migration : ajoute les catégories par défaut absentes + resync des flux par défaut
  // (noms harmonisés, 8/catégorie) en préservant tes ajouts perso et tes désactivations.
  if (saved){
    let changed=false;
    // fusion des deux anciennes catégories voyage en une seule (« Voyage & bons plans »)
    const dvCat = DATA.categories.find(c=>c.id==='deals_voyage');
    if (dvCat){
      const v = DATA.categories.find(c=>c.id==='voyage');
      if (v){
        const urls = new Set([...(v.feeds||[]),...(v.feeds_en||[])].map(f=>f.url));
        (dvCat.feeds||[]).forEach(f=>{ if(!urls.has(f.url)){ (v.feeds=v.feeds||[]).push(f); urls.add(f.url); } });
        (dvCat.feeds_en||[]).forEach(f=>{ if(!urls.has(f.url)){ (v.feeds_en=v.feeds_en||[]).push(f); urls.add(f.url); } });
        DATA.categories = DATA.categories.filter(c=>c.id!=='deals_voyage');
      } else { dvCat.id='voyage'; }
      if (localStorage.getItem('lastCat')==='deals_voyage') localStorage.setItem('lastCat','voyage');
      changed=true;
    }
    const have = new Set(DATA.categories.map(c=>c.id));
    DEFAULTS.categories.forEach((c,i)=>{ if(!have.has(c.id)){ DATA.categories.splice(Math.min(i,DATA.categories.length),0,clone(c)); changed=true; } });
    const dv = DEFAULTS.version || 1;
    if ((DATA.version||1) < dv){
      // l'ancien fourre-tout 'anglais' est remplacé par l'interrupteur de langue
      DATA.categories = DATA.categories.filter(c=> c.id!=='anglais');
      const allDef = new Set(), defById = {};
      DEFAULTS.categories.forEach(c=>{ defById[c.id]=c; (c.feeds||[]).forEach(f=>allDef.add(f.url)); (c.feeds_en||[]).forEach(f=>allDef.add(f.url)); });
      const offUrl = new Set();
      DATA.categories.forEach(c=> [...(c.feeds||[]),...(c.feeds_en||[])].forEach(f=>{ if(f.off) offUrl.add(f.url); }));
      const syncArr = (userArr, defArr) => {
        const userAdded = (userArr||[]).filter(f=> !allDef.has(f.url));
        return (defArr||[]).map(f=> offUrl.has(f.url) ? {name:f.name,url:f.url,off:true} : {name:f.name,url:f.url}).concat(userAdded);
      };
      DATA.categories.forEach(c=>{
        const dc = defById[c.id]; if(!dc) return;
        c.feeds = syncArr(c.feeds, dc.feeds);
        c.feeds_en = syncArr(c.feeds_en, dc.feeds_en);
      });
      // recentrage « voyage » sur les deals uniquement (on retire les blogs/news généralistes)
      const vCat = DATA.categories.find(c=>c.id==='voyage'), vDef = defById['voyage'];
      if (vCat && vDef){ vCat.label = vDef.label; vCat.feeds = clone(vDef.feeds); vCat.feeds_en = clone(vDef.feeds_en); }
      DATA.version = dv; changed=true;
    }
    if (changed) saveConfig();
  }
  renderChips();
  const last = localStorage.getItem('lastCat');
  const startCat = DATA.categories.find(c=>c.id===last && !c.off) || firstEnabled();
  if (startCat) selectCat(startCat.id);
  else elStatus.textContent='Toutes les catégories sont désactivées (⚙️).';
  elRefresh.addEventListener('click', () => {
    const cat = DATA.categories.find(c => c.id === current);
    if (cat) loadCategory(cat);
  });
  // article ouvert (carte courte ou « Lire l'article ») = consulté -> masqué et mémorisé
  elArticles.addEventListener('click', (e)=>{
    const a = e.target.closest('a.card, a.read'); if(!a) return;
    markRead(a.getAttribute('href'));
    const card = a.closest('.card'); if (card) card.remove();
    RENDERED = RENDERED.filter(it => !READ.has(it.link));
    setStatus(elArticles.querySelectorAll('.card').length);
  });
  const langBtn = $('#lang-btn');
  const updateLangBtn = ()=>{ langBtn.textContent = lang==='en' ? '🇬🇧' : '🇫🇷'; langBtn.classList.toggle('en', lang==='en'); };
  updateLangBtn();
  langBtn.addEventListener('click', ()=>{
    lang = (lang==='en') ? 'fr' : 'en';
    localStorage.setItem('srcLang', lang);
    updateLangBtn();
    const cat = DATA.categories.find(c=>c.id===current && !c.off) || firstEnabled();
    if (cat) loadCategory(cat);
  });
  $('#settings-btn').addEventListener('click', openSettings);
  elCard.addEventListener('click', onSettingsClick);
  elCard.addEventListener('change', onSettingsChange);
  elModal.addEventListener('click', (e)=>{ if(e.target===elModal) closeSettings(); });
  if ('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('sw.js'); }catch(e){} }
}
init();
