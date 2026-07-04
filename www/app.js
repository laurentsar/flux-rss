'use strict';

/* ---------- config ---------- */
const APP_VERSION = '4.60';
const GITHUB_REPO = 'laurentsar/flux-rss';
const PALETTE = ['#ef4444','#2563eb','#16a34a','#9333ea','#ea580c','#0891b2','#db2777','#4f46e5'];
const CAT_COLORS = {
  ve:['#E31937','#7A0D1C'], vr:['#00BCD4','#00626E'], cyber:['#E67E22','#8A4A10'],
  ia:['#6366F1','#312E81'], rugby:['#16A34A','#0B5D2A'], domotique:['#0EA5E9','#075985'],
  solaire:['#F59E0B','#92600A'], deals_fr:['#27AE60','#145F34'], anglais:['#1E3A8A','#0C1E4A'],
  jeux:['#8b5cf6','#4c1d95'], voyage:['#0D9488','#0F5D57'], youtube:['#FF0000','#7A0B0B'], deals_voyage:['#EA580C','#7C2D12'],
  podcasts:['#7C3AED','#3B0764'], tesla:['#CC0000','#7A0000'],
  placement:['#D97706','#78350F'],
  bricolage:['#B45309','#6B2E00'], byd:['#0F766E','#083A38'],
  football:['#1E3A8A','#0C1E4A'],
  agenda:['#6366F1','#312E81'],
  magazine:['#7B3F00','#3D1F00'],
};
const CAT_LABELS = {
  ve:'🚗 VE', rugby:'🏉 Rugby', cyber:'🔒 Cyber', ia:'🤖 IA',
  domotique:'🏠 Domotique', solaire:'☀️ Solaire', deals_fr:'💸 Deals',
  jeux:'🎮 Jeux', voyage:'✈️ Voyage', tesla:'⚡ Tesla',
  placement:'💰 Placement', bricolage:'🔨 Bricolage', byd:'🛠️ BYD',
  football:'⚽ Football',
};
const PER_FEED = 12;       // articles gardés par flux
const MAX_SHOW = 60;       // articles affichés par catégorie
const PROXY = 'https://api.allorigins.win/raw?url='; // repli CORS (PWA navigateur)

const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const isVR = /OculusBrowser/i.test(navigator.userAgent);
if (isVR) document.body.classList.add('vr');

/* ---------- état ---------- */
let DATA = null;
let current = null;
let currentTab = 'news';   // 'news' = articles · 'pods' = podcasts
let RENDERED = [];
let lang = localStorage.getItem('srcLang') || 'fr';
let lastUpdated = '';
let _rlTop14Journees = [];
let _rlTop14Shown = 2;

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

/* flux d'une catégorie pour l'onglet actif : articles (sans .pod) ou podcasts (.pod) */
function feedsForTab(cat, tab){
  const all = feedsFor(cat).filter(f => !f.off);
  return (tab === 'pods') ? all.filter(f => f.pod) : all.filter(f => !f.pod);
}
function hasPods(cat){ return feedsFor(cat).some(f => f.pod && !f.off); }
function hasNews(cat){ return feedsFor(cat).some(f => !f.pod && !f.off); }


const $ = (s) => document.querySelector(s);
const elCats = $('#cats'), elArticles = $('#articles'), elStatus = $('#status'), elRefresh = $('#refresh');
const elSubtabs = $('#subtabs');
const elRugbyLive = document.getElementById('rugby-live');
const elChangelogLive = document.getElementById('changelog-live');

/* ---------- réseau ---------- */

// Timeout fetch via AbortController (navigateur uniquement)
function fetchWithTimeout(url, opts={}, ms=10000){
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),ms);
  return fetch(url,{...opts,signal:ctrl.signal}).finally(()=>clearTimeout(t));
}

// Détecte une connexion lente via Network Information API
function slowConnection(){
  const c=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
  return !!(c && (c.saveData || /slow-2g|2g/.test(c.effectiveType||'')));
}

// Limiteur de concurrence : n requêtes max en parallèle
function makePool(n){
  let r=0; const q=[];
  const next=()=>{ if(r>=n||!q.length) return; r++; const{fn,res,rej}=q.shift(); fn().then(res,rej).finally(()=>{r--;next();}); };
  return fn=>new Promise((res,rej)=>{q.push({fn,res,rej});next();});
}

async function httpGet(url){
  if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp){
    const r = await window.Capacitor.Plugins.CapacitorHttp.get({
      url, headers:{'User-Agent':'FluxRSS/1.0','Accept':'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'},
      responseType:'text', connectTimeout:8000, readTimeout:12000,
    });
    return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  }

  // navigateur : direct avec timeout, puis repli proxy CORS avec timeout
  try{
    const r = await fetchWithTimeout(url, {redirect:'follow'}, 10000);
    if (r.ok) return await r.text();
    throw new Error('http '+r.status);
  }catch(e){
    const r = await fetchWithTimeout(PROXY + encodeURIComponent(url), {}, 10000);
    if (!r.ok) throw new Error('proxy '+r.status);
    return await r.text();
  }
}

async function fetchJson(url){
  const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp){
    const r = await window.Capacitor.Plugins.CapacitorHttp.get({
      url, headers:{'User-Agent':BROWSER_UA,'Accept':'application/json, */*'},
      responseType:'text', connectTimeout:8000, readTimeout:10000,
    });
    if (r.status && r.status >= 400) throw new Error('HTTP '+r.status);
    const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    return JSON.parse(text);
  }
  try{
    const r = await fetchWithTimeout(url, {headers:{'Accept':'application/json'}}, 10000);
    if (r.ok) return await r.json();
    throw new Error('http '+r.status);
  }catch(e){
    const r = await fetchWithTimeout(PROXY + encodeURIComponent(url), {}, 10000);
    if (!r.ok) throw new Error('proxy '+r.status);
    return await r.json();
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

function extractAudio(itemEl){
  // enclosure / media:content de type audio
  const cands = itemEl.getElementsByTagName('*');
  for (const n of cands){
    const t = n.tagName.toLowerCase();
    const type = (n.getAttribute && (n.getAttribute('type')||n.getAttribute('medium'))) || '';
    if ((t==='enclosure'||t==='media:content') && /audio|mpeg|mp3|m4a|ogg/i.test(type) && n.getAttribute('url'))
      return n.getAttribute('url');
  }
  return '';
}

function parseFeed(xmlText, source, kind){
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
    const audio = kind ? extractAudio(it) : '';
    if (title && link) out.push({ title, link, date, ts: Date.parse(date)||0, summary, image, source, kind: kind||'news', audio });
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

function parseWikitables(html, selector='table.wikitable'){
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const tables = [];
  tmp.querySelectorAll(selector).forEach(tbl => {
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

function parsePts(row){
  return parseInt((row[row.length-1]||'').replace(/[^\d]/g,''))||0;
}

function renderRLStandings(rows, label, maxRows=14, topN=6, botN=2){
  if (!rows || rows.length < 2) return '';
  const total = Math.min(rows.length - 1, maxRows);
  const body = rows.slice(1, total+1).map((r,i)=>{
    const rank = parseInt(r[0])||i+1;
    const club = (r[1]||'').replace(/\s+[A-ZTCPBMR]+\d*$/, '').trim();
    const cls = rank<=topN?'rl-top':botN>0&&rank>total-botN?'rl-bot':'';
    return `<tr class="${cls}"><td>${rank}</td><td class="rl-club">${esc(club)}</td><td>${r[2]||'-'}</td><td>${r[3]||'-'}</td><td>${r[4]||'-'}</td><td>${r[5]||'-'}</td><td><b>${parsePts(r)}</b></td></tr>`;
  }).join('');
  return `<details class="rl-section">
    <summary class="rl-sh">🏆 ${esc(label)}</summary>
    <div class="rl-table-wrap"><table class="rl-table">
      <thead><tr><th>#</th><th>Équipe</th><th>J</th><th>V</th><th>N</th><th>D</th><th>Pts</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </details>`;
}

function renderRLResults(tables, label, count=2){
  if (!tables || !tables.length) return '';
  const total = tables.length;
  const shown = Math.min(count, total);
  const recent = tables.slice(Math.max(0, total - shown));
  const matchesHtml = recent.map((rows, ji)=>{
    const jn = total - shown + ji + 1;
    const cards = rows.map(r=>{
      if (r.length < 5) return '';
      const home = r[1], hs = r[2], as_ = r[3], away = r[4];
      const hw = parseInt(hs)>parseInt(as_), aw = parseInt(as_)>parseInt(hs);
      return `<div class="rl-match"><span class="rl-tn ${hw?'rl-w':''}">${esc(home)}</span><span class="rl-sb"><b>${esc(hs)}</b><span class="rl-vs">–</span><b>${esc(as_)}</b></span><span class="rl-tn rl-tnr ${aw?'rl-w':''}">${esc(away)}</span></div>`;
    }).filter(Boolean).join('');
    return `<div class="rl-journee"><span class="rl-jlbl">Journée ${jn}</span>${cards}</div>`;
  }).join('');
  const remaining = total - shown;
  const moreBtn = remaining > 0
    ? `<button class="rl-more-btn">📋 +${Math.min(3,remaining)} journée${Math.min(3,remaining)>1?'s':''}</button>`
    : '';
  return `<details class="rl-section rl-results-top14"><summary class="rl-sh">🏉 ${esc(label)}</summary>${matchesHtml}${moreBtn}</details>`;
}

/* --- ESPN : résultats rugby (live + récents + à venir) --- */
async function fetchSportsEvents(){
  if (_espnCache && Date.now()-_espnCacheTs < 3*60*1000) return _espnCache;
  // ESPN league IDs (confirmed via API exploration):
  // 270559 = French Top 14 | 180659 = Six Nations | 271937 = Champions Cup | 289688 = Autumn Nations
  const ESPN_IDS = ['270559','180659','271937','289688'];
  const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/rugby';

  // Club IDs (Top 14, Champions Cup) vs international IDs
  const CLUB_IDS = new Set(['270559','271937']);

  function parseEspnEvent(e, leagueId){
    const comps = e.competitions?.[0]?.competitors||[];
    const home = comps.find(c=>c.homeAway==='home');
    const away = comps.find(c=>c.homeAway==='away');
    const state = e.competitions?.[0]?.status?.type?.state||'';
    const detail = e.competitions?.[0]?.status?.type?.shortDetail||'';
    const live = state==='in', fin = state==='post';
    return {
      id: e.id,
      homeTeam:{name:home?.team?.name||'?'}, awayTeam:{name:away?.team?.name||'?'},
      homeScore:{current:home?.score??''}, awayScore:{current:away?.score??''},
      status:{type:live?'inprogress':fin?'finished':'notstarted', description:detail},
      startTimestamp:new Date(e.date||0).getTime()/1000,
      tournament:{name:e.league?.name||''},
      leagueId,
      isClub: CLUB_IDS.has(leagueId),
    };
  }

  // Fetch all ESPN league scoreboards in parallel
  const espnResults = await Promise.allSettled(
    ESPN_IDS.map(id=>fetchJson(`${ESPN_BASE}/${id}/scoreboard`).then(d=>(d.events||[]).map(e=>parseEspnEvent(e,id))))
  );
  const events = espnResults.flatMap(r=>r.status==='fulfilled'?r.value:[]);

  if (!events.length){
    const r={events:[], error:'Scores live indisponibles — <a href="https://www.flashscore.fr/rugby/" target="_blank" style="color:var(--accent)">Flashscore Rugby</a>'};
    _espnCache=r; _espnCacheTs=Date.now(); return r;
  }
  // dedup + sort: live first, then finished, then upcoming
  const seen = new Set();
  const deduped = events.filter(e=>!seen.has(e.id)&&seen.add(e.id));
  deduped.sort((a,b)=>{const o=t=>t==='inprogress'?0:t==='finished'?1:2;return o(a.status.type)-o(b.status.type)||(a.startTimestamp-b.startTimestamp);});
  const r={events:deduped, error:null};
  _espnCache=r; _espnCacheTs=Date.now();
  return r;
}

function renderLiveScores(events, extraIntlHtml=''){
  const top14Events = events.filter(e=>e.isClub);
  const intlEvents  = events.filter(e=>!e.isClub);

  function section(evts, label, extra=''){
    if (!evts.length && !extra) return '';
    const hasLive = evts.some(e=>e.status?.type==='inprogress');
    const cards = evts.map(e=>{
      const st = e.status?.type;
      const live = st==='inprogress', fin = st==='finished';
      const hs = e.homeScore?.current??'', as_ = e.awayScore?.current??'';
      const hw = fin && parseInt(hs)>parseInt(as_), aw = fin && parseInt(as_)>parseInt(hs);
      const badge = live ? '<span class="rl-live-dot"></span>' : '';
      const time = live ? (e.status.description||'⏱') : fin ? '' :
        new Date((e.startTimestamp||0)*1000).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
      const score = (live||fin) ? `<b>${hs}</b><span class="rl-vs">–</span><b>${as_}</b>${time?`<span class="rl-time"> ${time}</span>`:''}` : `<span class="rl-vs">${time}</span>`;
      const hn=e.homeTeam?.name||'?', an=e.awayTeam?.name||'?';
      return `<div class="rl-match"><span class="rl-tn ${hw?'rl-w':''}">${teamBadge(hn)}${esc(hn)}</span><span class="rl-sb">${badge}${score}</span><span class="rl-tn rl-tnr ${aw?'rl-w':''}">${teamBadge(an)}${esc(an)}</span></div>`;
    }).join('');
    const lbl = hasLive ? `🔴 ${label} — En direct` : label;
    return `<details class="rl-section${hasLive?' rl-live-section':''}"${hasLive?' open':''}><summary class="rl-sh">${lbl}</summary>${cards}${extra}</details>`;
  }
  return section(top14Events,'🏆 Top 14 / Champions Cup') + section(intlEvents,'🌐 Matchs internationaux', extraIntlHtml);
}

const FR_RE = /\bfrance\b/i;

function teamBadge(name){
  const n = name||'';
  if (FR_RE.test(n)) return '🇫🇷 ';
  if (/toulouse/i.test(n)) return '🔴 ';
  return '';
}

/* --- Pro D2 : Brive & Colomiers --- */
const PRO_D2_TEAMS = ['Brive','Colomiers'];
async function loadProD2Teams(season){
  const page = `Pro D2 ${season}`;
  try{
    const sectsData = await fetch(`https://fr.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=sections&format=json&origin=*`).then(r=>r.json());
    const sects = sectsData?.parse?.sections||[];
    const idx = sects.find(s=>/résultats/i.test(s.line))?.index;
    if (!idx) return [];
    const d = await fetch(wikiUrl(page,parseInt(idx))).then(r=>r.json());
    const tbls = parseWikitables(d?.parse?.text?.['*']||'').filter(t=>t.length>=3 && t[0].length<=6);
    const matches = [];
    tbls.forEach((rows,ji)=>{
      rows.slice(1).forEach(r=>{
        if (r.length<5) return;
        if (PRO_D2_TEAMS.some(t=>(r[1]||'').toLowerCase().includes(t.toLowerCase())||(r[4]||'').toLowerCase().includes(t.toLowerCase())))
          matches.push({jn:ji+1,r});
      });
    });
    return matches;
  } catch(e){ return []; }
}

function renderProD2Teams(matches){
  if (!matches.length) return '';
  const cards = matches.map(({r})=>{
    const home=r[1],hs=r[2],as_=r[3],away=r[4];
    const hw=parseInt(hs)>parseInt(as_), aw=parseInt(as_)>parseInt(hs);
    const favH=PRO_D2_TEAMS.some(t=>(home||'').toLowerCase().includes(t.toLowerCase()));
    const favA=PRO_D2_TEAMS.some(t=>(away||'').toLowerCase().includes(t.toLowerCase()));
    return `<div class="rl-match"><span class="rl-tn ${hw?'rl-w':''}">${esc(home)}${favH?' ⭐':''}</span><span class="rl-sb"><b>${esc(hs)}</b><span class="rl-vs">–</span><b>${esc(as_)}</b></span><span class="rl-tn rl-tnr ${aw?'rl-w':''}">${esc(away)}${favA?' ⭐':''}</span></div>`;
  }).join('');
  return `<details class="rl-section" open><summary class="rl-sh">🏉 Brive & Colomiers — Pro D2</summary>${cards}</details>`;
}

/* --- Championnat des nations : toutes les équipes --- */
async function loadChampionnatNations(year){
  const page = `Championnat des nations ${year}`;
  try{
    const sd = await fetch(`https://fr.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=sections&format=json&origin=*`).then(r=>r.json());
    const sects = (sd?.parse?.sections||[]).filter(s=>/journée/i.test(s.line));
    if (!sects.length) return null;
    const results = await Promise.allSettled(
      sects.map(s=>fetch(wikiUrl(page,parseInt(s.index))).then(r=>r.json()).then(d=>({label:s.line, html:d?.parse?.text?.['*']||''})))
    );
    return results.filter(r=>r.status==='fulfilled').map(r=>r.value).filter(v=>v.html);
  } catch(e){ return null; }
}

function renderChampionnatNations(journees){
  if (!journees?.length) return '';
  const SCORE_FIND = /\b(\d+)\s*[-–]\s*(\d+)\b/;
  // Strip HTML tags (e.g. <sup>re</sup>) and parenthetical annotations (bo, bd, etc.)
  const cleanLabel = s => s.replace(/<[^>]*>/g,'').trim();
  const cleanTeam  = s => s.replace(/\s*\([^)]+\)/g,'').trim();
  const blocks = journees.map(({label, html})=>{
    const tables = parseWikitables(html,'table').filter(t=>t.length>=2);
    if (!tables.length) return '';
    const cards = tables.flatMap(rows=>rows.map(r=>{
      if (r.length<3) return '';
      // Score cell: either "X – Y" (played) or lone "–" (live/upcoming)
      const LONE_DASH = /^\s*[-–]\s*$/;
      const scoreCol = r.findIndex(c=>SCORE_FIND.test(c)||LONE_DASH.test(c));
      if (scoreCol<0||scoreCol===0||scoreCol===r.length-1) return '';
      const home = cleanTeam(r[scoreCol-1]||'');
      const away = cleanTeam(r[scoreCol+1]||'');
      if (home.length<2||away.length<2) return '';
      const m = r[scoreCol].match(SCORE_FIND);
      if (!m){
        // Upcoming or live (no score yet)
        return `<div class="rl-match"><span class="rl-tn">${teamBadge(home)}${esc(home)}</span><span class="rl-sb"><span class="rl-vs">⏱</span></span><span class="rl-tn rl-tnr">${teamBadge(away)}${esc(away)}</span></div>`;
      }
      const hs=parseInt(m[1]), as_=parseInt(m[2]);
      const hw=hs>as_, aw=as_>hs;
      return `<div class="rl-match"><span class="rl-tn ${hw?'rl-w':''}">${teamBadge(home)}${esc(home)}</span><span class="rl-sb"><b>${hs}</b><span class="rl-vs">–</span><b>${as_}</b></span><span class="rl-tn rl-tnr ${aw?'rl-w':''}">${teamBadge(away)}${esc(away)}</span></div>`;
    }).filter(Boolean)).join('');
    if (!cards) return '';
    return `<div class="rl-journee"><span class="rl-jlbl">🌍 Championnat des nations — ${esc(cleanLabel(label))}</span>${cards}</div>`;
  }).filter(Boolean).join('');
  return blocks;
}

let _espnCache = null, _espnCacheTs = 0;
let _frSocCache = null, _frSocCacheTs = 0;
let _rugbyLiveHtml = '', _rugbyLiveTs = 0;
let _hasLiveSports = false;
let _autoSwitchedToLive = false;

function updateLiveBadge(){
  const chip = elCats?.querySelector('[data-id="rugby"]');
  if (chip) chip.classList.toggle('chip-has-live', _hasLiveSports);
}

function checkLiveAndSwitch(){
  fetchSportsEvents().then(data=>{
    const live = data.events.some(e=>e.status?.type==='inprogress');
    if (live !== _hasLiveSports){ _hasLiveSports=live; updateLiveBadge(); }
    if (live && current!=='rugby' && !_autoSwitchedToLive){
      _autoSwitchedToLive = true;
      selectCat('rugby');
    }
  }).catch(()=>{});
}
async function loadRugbyLive(){
  if (!elRugbyLive) return;
  elRugbyLive.hidden = false;
  // Réutilise le cache mémoire si < 3 minutes
  if (_rugbyLiveHtml && Date.now() - _rugbyLiveTs < 3 * 60 * 1000){
    elRugbyLive.innerHTML = _rugbyLiveHtml;
    return;
  }
  elRugbyLive.innerHTML = '<div class="rl-loading"><span class="spinner"></span>Scores & classements…</div>';
  const season = rugbySeason();
  const top14 = `Championnat de France de rugby à XV ${season}`;

  const currentYear = new Date().getFullYear();
  const [r1, r2, sofa, proD2, champNations] = await Promise.all([
    fetch(wikiUrl(top14,6)).then(r=>r.json()).catch(()=>null),
    fetch(wikiUrl(top14,7)).then(r=>r.json()).catch(()=>null),
    fetchSportsEvents(),
    loadProD2Teams(season),
    loadChampionnatNations(currentYear),
  ]);

  _hasLiveSports = sofa.events.some(e=>e.status?.type==='inprogress');
  updateLiveBadge();
  let html = '';
  const champHtml = renderChampionnatNations(champNations);
  if (sofa.error) html += `<details class="rl-section" open><summary class="rl-sh">📡 Scores live</summary><div class="rl-loading">⚠️ ${sofa.error}</div></details>`;
  else if (sofa.events.length || champHtml) html += renderLiveScores(sofa.events, champHtml);
  if (r1){
    const tbls = parseWikitables(r1?.parse?.text?.['*']||'');
    if (tbls[0]) html += renderRLStandings(tbls[0],'Classement Top 14',14,6,2);
  }
  if (r2){
    const tbls = parseWikitables(r2?.parse?.text?.['*']||'');
    const jtbls = tbls.filter(t=>t.length>=5 && t.length<=10 && t[0].length<=6);
    if (jtbls.length){
      _rlTop14Journees = jtbls;
      _rlTop14Shown = 2;
      html += renderRLResults(_rlTop14Journees,'Résultats Top 14',_rlTop14Shown);
    }
  }
  if (proD2.length) html += renderProD2Teams(proD2);
  elRugbyLive.innerHTML = html || '<div class="rl-loading">Données non disponibles.</div>';
  _rugbyLiveHtml = elRugbyLive.innerHTML;
  _rugbyLiveTs = Date.now();
}

function hideRugbyLive(){
  if (elRugbyLive){ elRugbyLive.hidden=true; elRugbyLive.innerHTML=''; }
}

/* ---------- Changelog Live ---------- */
let _clHtml = null;

function clBullets(text){
  if (!text) return [];
  // 1) Newline or bullet-character split
  const byLine = text.split(/\n/).map(l => l.trim().replace(/^[-•·–]\s*/, '')).filter(s => s.length > 10);
  if (byLine.length > 1) return byLine;
  // 2) "includes X, Y, Z" / "apporte X, Y, Z" / "avec X, Y, Z"
  const m = text.match(/(?:includes?|apporte|introduce[sd]?|avec)\s+(.+)/i);
  if (m) {
    const parts = m[1].split(/,\s*/).map(s => s.replace(/\.$/, '').trim()).filter(s => s.length > 3);
    if (parts.length > 1) return parts;
  }
  // 3) Colon then comma list: "Nouveautés : X, Y, Z"
  const mc = text.match(/:\s+([^.]{20,})/);
  if (mc) {
    const parts = mc[1].split(/,\s*/).map(s => s.trim()).filter(s => s.length > 3);
    if (parts.length > 1) return parts;
  }
  // 4) Period-separated sentences
  const bySentence = text.split(/\.\s+(?=[A-ZÀÂÉÈÊËÎÏÔÙÛÜ])/).map(s => s.trim()).filter(s => s.length > 15);
  if (bySentence.length > 1) return bySentence;
  return [];
}

async function loadChangelogLive(cat){
  if (!elChangelogLive) return;
  const feeds = (cat.feeds_changelog || []).filter(f => !f.off);
  if (!feeds.length){ hideChangelogLive(); return; }
  if (_clHtml){ elChangelogLive.hidden=false; elChangelogLive.innerHTML=_clHtml; return; }
  elChangelogLive.hidden = false;
  elChangelogLive.innerHTML = '<div class="cl-loading"><span class="spinner"></span> Changelog…</div>';
  const results = await Promise.allSettled(feeds.map(f =>
    httpGet(f.url).then(xml => parseFeed(xml, f.name, null).map(it => ({...it, _lang: f.lang||'en'})))
  ));
  let items = [];
  results.forEach(r => { if (r.status === 'fulfilled') items = items.concat(r.value); });
  const seen = new Set();
  items = items.filter(it => it.link && !seen.has(it.link) && seen.add(it.link));
  items.sort((a,b) => b.ts - a.ts);
  if (!items.length){ hideChangelogLive(); return; }
  // Préfère un item en français récent (dans les 30 derniers jours) sinon le plus récent
  const threshold = Date.now() - 30*24*60*60*1000;
  const frItem = items.find(it => it._lang==='fr' && it.ts > threshold);
  const it = frItem || items[0];
  const label = cat.id==='ia' ? '🤖 Dernière release IA' : cat.id==='domotique' ? '🏠 Dernière version Home Assistant' : '⚡ Dernière mise à jour Tesla';
  // Extrait le numéro de version Tesla (format YYYY.NN.N ou vX.Y.Z) depuis le titre
  const verMatch = it.title.match(/(\d{4}\.\d+\.\d+(?:\.\d+)?|v?\d+\.\d+\.\d+)/i);
  const verBadge = verMatch ? `<span class="cl-ver">${esc(verMatch[1])}</span>` : '';
  const bullets = clBullets(it.summary || '').slice(0, 5); // max 5 puces
  const buller = bullets.length > 1
    ? `<ul class="cl-bullets">${bullets.map(b=>`<li>${esc(b)}</li>`).join('')}</ul>`
    : it.summary ? `<span class="cl-excerpt">${esc(it.summary.slice(0,200))}${it.summary.length>200?'…':''}</span>` : '';
  const imgHtml = it.image ? `<img class="cl-img" src="${esc(it.image)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  const card = `<a class="cl-item" href="${esc(it.link)}" target="_blank" rel="noopener">
    ${imgHtml}
    <span class="cl-title">${verBadge}${esc(it.title)}</span>
    ${buller}
    <span class="cl-meta">${it.date?`<span>🕒 ${esc(fmtDate(it.date))}</span>`:''}</span>
  </a>`;
  const html = `<details class="rl-section" open><summary class="rl-sh">${label}</summary>${card}</details>`;
  elChangelogLive.innerHTML = html;
  _clHtml = html;
}

function hideChangelogLive(){
  if (elChangelogLive){ elChangelogLive.hidden=true; elChangelogLive.innerHTML=''; }
  _clHtml = null;
}

/* ---------- chargement catégorie ---------- */
function cacheKey(id, tab){ return 'feedcache:'+id+(tab==='pods'?':pod':''); }

/* barre de sous-onglets Articles / Podcasts (affichée seulement si la catégorie a des podcasts) */
function renderSubtabs(cat){
  // sous-onglets seulement si la catégorie a À LA FOIS des articles et des podcasts
  if (!(hasPods(cat) && hasNews(cat))){ elSubtabs.hidden=true; elSubtabs.innerHTML=''; return; }
  elSubtabs.hidden=false;
  elSubtabs.innerHTML =
    `<button class="subtab${currentTab==='news'?' active':''}" data-tab="news">📰 Articles</button>`+
    `<button class="subtab${currentTab==='pods'?' active':''}" data-tab="pods">🎙️ Podcasts</button>`;
}

async function loadCategory(cat, {silent=false}={}){
  _clHtml = null; // reset cache changelog à chaque changement de catégorie
  current = cat.id;
  if (!hasNews(cat) && hasPods(cat)) currentTab='pods';      // catégorie 100% podcasts (ex. Podcasts globale)
  else if (currentTab==='pods' && !hasPods(cat)) currentTab='news';
  const [a,b] = CAT_COLORS[cat.id] || ['#F26522','#A8400F'];
  document.documentElement.style.setProperty('--a',a);
  document.documentElement.style.setProperty('--b',b);
  $('#hero-sub').textContent = cat.label;
  renderSubtabs(cat);
  if (cat.id==='rugby' && currentTab==='news') loadRugbyLive(); else hideRugbyLive();
  if (cat.feeds_changelog?.length && currentTab==='news') loadChangelogLive(cat); else hideChangelogLive();

  // cache immédiat
  const cached = JSON.parse(localStorage.getItem(cacheKey(cat.id, currentTab)) || 'null');
  const isSlowConn = slowConnection();
  if (cached && cached.items && cached.items.length){
    render(cached.items, cat.id, cached.ts);
    // Connexion lente + cache < 30 min → on garde le cache, pas de requête réseau
    if (isSlowConn && Date.now() - (cached.ts||0) < 30*60*1000){
      elStatus.textContent += ' · 📶 cache (connexion lente)';
      return;
    }
  } else if (!silent){
    elArticles.innerHTML = '';
    elStatus.innerHTML = '<span class="spinner"></span>Chargement des flux…';
  }

  elRefresh.classList.add('spinning');
  const tab = currentTab;
  const activeFeeds = feedsForTab(cat, tab);
  if (!activeFeeds.length){
    elRefresh.classList.remove('spinning');
    elArticles.innerHTML=''; RENDERED=[];
    elStatus.textContent = tab==='pods' ? "Aucun podcast dans cette catégorie pour l'instant." : 'Aucune source.';
    return;
  }
  // Limite la concurrence : 2 requêtes simultanées sur connexion lente, 4 sinon
  const pool = makePool(isSlowConn ? 2 : 4);
  const results = await Promise.allSettled(activeFeeds.map(f => pool(async () => {
    const xml = await httpGet(f.url);
    return parseFeed(xml, f.name, tab==='pods' ? (f.kind||'audio') : null);
  })));
  elRefresh.classList.remove('spinning');
  if (current !== cat.id || currentTab !== tab) return; // l'utilisateur a changé de catégorie/onglet

  let items = [];
  let ok = 0;
  results.forEach((r) => { if (r.status==='fulfilled'){ ok++; items = items.concat(r.value); } });
  const _seen = new Set();
  items = items.filter(it => it.link && !_seen.has(it.link) && _seen.add(it.link));
  items.sort((x,y)=> y.ts - x.ts);
  items = items.slice(0, MAX_SHOW);

  if (items.length){
    const ts = Date.now();
    localStorage.setItem(cacheKey(cat.id, tab), JSON.stringify({ts, items}));
    render(items, cat.id, ts);
  } else if (!cached){
    elStatus.textContent = isNative
      ? 'Aucun article récupéré. Vérifie ta connexion.'
      : "Aucun article (le navigateur bloque souvent les flux : utilise l'APK).";
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
  if (currentTab==='pods'){ elStatus.textContent = `${n} épisode${n>1?'s':''} · ${lastUpdated}`; return; }
  elStatus.textContent = n ? `${n} articles · ${lastUpdated}` : `Tous les articles lus 🎉 · ${lastUpdated}`;
}
function renderPodcasts(items, ts){
  RENDERED = items;
  lastUpdated = ts ? `Mis à jour ${fmtDate(new Date(ts).toISOString())}` : '';
  setStatus(items.length);
  elArticles.innerHTML = items.map((it, i) => {
    const accent = PALETTE[i % PALETTE.length];
    const dateHtml = it.date ? `<span class="date">🕒 ${esc(fmtDate(it.date))}</span>` : '';
    const src = `<span class="src">${esc(it.source)}</span>`;
    const cover = it.image ? `<img class="pod-cover" src="${esc(it.image)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : '';
    const head = `<div class="pod-head">${cover}<span class="ctitle"><b>${esc(it.title)}</b>${dateHtml}${src}</span></div>`;
    if (it.audio){
      return `<div class="card pod" style="--accent:${accent}">${head}
        <audio class="pod-audio" controls preload="none" src="${esc(it.audio)}"></audio></div>`;
    }
    // vidéo (YouTube) ou audio sans flux direct : vignette + ouverture externe
    return `<a class="card pod podlink" style="--accent:${accent}" href="${esc(it.link)}" target="_blank" rel="noopener">
      ${head}<span class="pod-play">▶︎ ${it.kind==='video'?'Voir la vidéo':'Écouter'}</span></a>`;
  }).join('');
  window.scrollTo(0, 0);
}
function render(items, catId, ts){
  if (currentTab==='pods'){ renderPodcasts(items, ts); return; }
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
  const mag = CAT_MAGAZINES[catId];
  const magHtml = mag
    ? `<button class="mag-launch" data-mag="${catId}">📖 <b>${esc(mag.title)}</b><span class="mag-sub">Magazine · Cafeyn</span><span class="mag-go">▸</span></button>`
    : '';
  elArticles.innerHTML = magHtml + html;
  window.scrollTo(0, 0);
}

function isFranceMatch(e){
  const h=(e.homeTeam?.name||'').toLowerCase(), a=(e.awayTeam?.name||'').toLowerCase();
  return h.includes('france')||a.includes('france');
}

async function fetchFranceSoccer(){
  if (_frSocCache && Date.now()-_frSocCacheTs<5*60*1000) return _frSocCache;
  const SOCCER_IDS=['fifa.world','uefa.nations'];
  const BASE='https://site.api.espn.com/apis/site/v2/sports/soccer';
  function isFR(comp){ const n=(comp?.team?.name||'').toLowerCase(),a=(comp?.team?.abbreviation||'').toUpperCase(); return n.includes('france')||a==='FRA'; }
  const results=await Promise.allSettled(
    SOCCER_IDS.map(id=>fetchJson(`${BASE}/${id}/scoreboard`).then(d=>d.events||[]))
  );
  const seen=new Set();
  const events=results.flatMap(r=>r.status==='fulfilled'?r.value:[])
    .filter(e=>(e.competitions?.[0]?.competitors||[]).some(c=>isFR(c)))
    .filter(e=>!seen.has(e.id)&&seen.add(e.id))
    .map(e=>{
      const comps=e.competitions?.[0]?.competitors||[];
      const home=comps.find(c=>c.homeAway==='home'),away=comps.find(c=>c.homeAway==='away');
      const state=e.competitions?.[0]?.status?.type?.state||'';
      const detail=e.competitions?.[0]?.status?.type?.shortDetail||'';
      const live=state==='in',fin=state==='post';
      const d=new Date(e.date||0);
      return {
        id:'espn-soc-'+e.id,
        homeTeam:{name:home?.team?.displayName||home?.team?.name||'?'},
        awayTeam:{name:away?.team?.displayName||away?.team?.name||'?'},
        homeScore:{current:home?.score??''},
        awayScore:{current:away?.score??''},
        status:{type:live?'inprogress':fin?'finished':'notstarted',description:detail},
        startTimestamp:d.getTime()/1000,
        date:d.toISOString().slice(0,10),
        tournament:{name:e.league?.name||'Football'},
        sport:'football',
      };
    });
  _frSocCache=events; _frSocCacheTs=Date.now();
  return events;
}

function renderFranceLive(rugbyLive, soccerEvents){
  const all=[
    ...rugbyLive.map(e=>({...e,sport:'rugby'})),
    ...soccerEvents.filter(e=>e.status?.type==='inprogress'||e.status?.type==='finished'),
  ];
  if(!all.length) return '';
  const hasLive=all.some(e=>e.status?.type==='inprogress');
  const cards=all.map(e=>{
    const st=e.status?.type,live=st==='inprogress',fin=st==='finished';
    const hs=e.homeScore?.current??'',as_=e.awayScore?.current??'';
    const hw=fin&&parseInt(hs)>parseInt(as_),aw=fin&&parseInt(as_)>parseInt(hs);
    const badge=live?'<span class="rl-live-dot"></span>':'';
    const time=live?(e.status?.description||'⏱'):'';
    const score=(live||fin)?`<b>${esc(hs)}</b><span class="rl-vs">–</span><b>${esc(as_)}</b>${time?`<span class="rl-time"> ${esc(time)}</span>`:''}`:''
    const icon=e.sport==='football'?'⚽ ':'🏉 ';
    const hn2=e.homeTeam?.name||'?', an2=e.awayTeam?.name||'?';
    return `<div class="rl-match"><span class="rl-tn ${hw?'rl-w':''}">${icon}${teamBadge(hn2)}${esc(hn2)}</span><span class="rl-sb">${badge}${score}</span><span class="rl-tn rl-tnr ${aw?'rl-w':''}">${teamBadge(an2)}${esc(an2)}</span></div>`;
  }).join('');
  const allNames = all.map(e=>`${e.homeTeam?.name||''} ${e.awayTeam?.name||''}`).join(' ');
  const hasYouthA = /u\s*\d+|under|moins\s*de|junior/i.test(allNames);
  const agLabel = hasYouthA ? '🇫🇷 Équipes de France' : '🇫🇷 France';
  const label=hasLive?`🔴 ${agLabel} en direct`:`${agLabel} — Résultats récents`;
  return `<details class="rl-section${hasLive?' rl-live-section':''}" open><summary class="rl-sh">${label}</summary>${cards}</details>`;
}

/* ---------- Agenda ---------- */
let _agendaJson = null;
let _upcomingRugby = null, _upcomingRugbyTs = 0;

async function loadAgendaEvents(){
  if (!_agendaJson){
    try{ _agendaJson = await (await fetch('data/events.json')).json(); }
    catch(e){ _agendaJson = {events:[]}; }
  }
  const now = Date.now() - 86400*1000; // hier
  const horizon = Date.now() + 365*86400*1000;
  return (_agendaJson.events||[])
    .filter(ev=>{ const d=Date.parse(ev.date); return d>=now && d<=horizon; })
    .sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
}

/* Chaînes TV des compétitions de rugby (France, droits 2025-2026) — ÉDITABLE.
   Clé = motif sur le nom de ligue ESPN. Toutes les chaînes, Canal+ compris. */
const RUGBY_TV = [
  [/top\s*14/i,                         ['Canal+']],
  [/pro\s*d2/i,                         ['Canal+']],
  [/champions cup/i,                    ['beIN Sports', 'France 2']],
  [/challenge cup/i,                    ['beIN Sports', 'France 3']],
  [/six nations|6 nations|tournoi/i,    ['France TV', 'TF1']],
  [/autumn|automne|test match|tourn[ée]e/i, ['TF1', "La Chaîne L'Équipe"]],
  [/united rugby|\burc\b/i,             ['Canal+']],
  [/premiership/i,                      ['Canal+']],
  [/rugby championship/i,               ['beIN Sports']],
  [/world cup|coupe du monde/i,         ['TF1', 'France TV', 'M6']],
];
// Renvoie la/les chaîne(s) : d'abord ESPN si renseigné, sinon la table ci-dessus.
function rugbyChannel(league, espnBroadcasts){
  if (espnBroadcasts && espnBroadcasts.length){
    const names = espnBroadcasts
      .map(b=>(b.names&&b.names.join('/'))||b.media?.shortName||b.shortName||b.name)
      .filter(Boolean);
    if (names.length) return [...new Set(names)];
  }
  for (const [re,ch] of RUGBY_TV){ if (re.test(league||'')) return ch; }
  return null;
}

/* Chaînes TV des compétitions de football suivies (France, 2025-2026) — ÉDITABLE. */
const FOOT_TV = [
  [/ligue 1/i,                              ['Ligue 1+', 'beIN Sports']],
  [/ligue 2/i,                              ['beIN Sports']],
  [/champions league|ligue des champions/i, ['Canal+', 'beIN Sports']],
  [/europa league|ligue europa/i,           ['Canal+']],
  [/conference league/i,                    ['Canal+']],
  [/coupe de france/i,                       ['beIN Sports', 'France TV']],
  [/nations league|ligue des nations/i,      ['TF1', 'M6']],
  [/world cup|coupe du monde/i,              ['TF1', 'France TV', 'M6']],
  [/euro|championnat d.europe/i,             ['TF1', 'M6']],
  [/friendly|amical|france/i,                ['TF1', 'M6']],
];
function footChannel(comp){
  for (const [re,ch] of FOOT_TV){ if (re.test(comp||'')) return ch; }
  return null;
}

/* Lecteur IPTV : modèle d'URL fourni par l'utilisateur (aucun flux embarqué).
   Variables {chaine} et {q}. Vide = pas de lien direct. */
const IPTV_KEY = 'iptvTemplate';
function getIptv(){ try{ return localStorage.getItem(IPTV_KEY) || ''; }catch(e){ return ''; } }
function setIptv(v){ try{ v ? localStorage.setItem(IPTV_KEY, v) : localStorage.removeItem(IPTV_KEY); }catch(e){} }
function iptvUrl(tpl, chaine, title){
  return tpl.replace(/\{chaine\}/g, encodeURIComponent(chaine))
            .replace(/\{q\}/g, encodeURIComponent(title || ''));
}

/* Émissions TV récurrentes consacrées au rugby (France) — ÉDITABLE.
   day : 0=dimanche … 6=samedi. Générées seulement pendant la saison. */
const RUGBY_SHOWS = [
  // Canal+ (diffuseur du Top 14 / Pro D2)
  {title:'Canal Rugby Club',        chaine:'Canal+',            day:0, time:'21:00', desc:'Le magazine du Top 14'},
  {title:'Late Rugby Club',         chaine:'Canal+',            day:0, time:'22:45', desc:'Débrief en plateau de la journée'},
  {title:'Jour de Rugby',           chaine:'Canal+ Sport',      day:6, time:'23:00', desc:'Résumés et temps forts du multiplex'},
  // France Télévisions
  {title:'Stade 2',                 chaine:'France 3',          day:0, time:'18:05', desc:'Magazine multisport, forte place au rugby'},
  {title:'Rugby Magazine Occitanie',chaine:'France 3 Occitanie',day:1, time:'',      desc:'Magazine régional consacré au rugby'},
];
const RUGBY_SHOW_SEASON = [9,10,11,12,1,2,3,4,5,6]; // sept → juin
// Date locale "YYYY-MM-DD" SANS passer par UTC (toISOString décalerait d'un
// jour dans les fuseaux à offset positif comme Europe/Paris).
function localISO(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function upcomingRugbyShows(weeks){
  const out=[], today=new Date(); today.setHours(0,0,0,0);
  for (const s of RUGBY_SHOWS){
    for (let i=0;i<weeks;i++){
      const d=new Date(today);
      d.setDate(d.getDate()+(((s.day - today.getDay())+7)%7)+i*7);
      if (!RUGBY_SHOW_SEASON.includes(d.getMonth()+1)) continue;
      const iso=localISO(d);
      out.push({
        id:`show-${s.title}-${iso}`.replace(/\s+/g,'-'),
        title:s.title, desc:s.desc, date:iso,
        time:s.time, cats:['rugby'], chaine:s.chaine, approx:true,
      });
    }
  }
  return out;
}

async function fetchUpcomingMatches(){
  if (_upcomingRugby && Date.now()-_upcomingRugbyTs < 5*60*1000) return _upcomingRugby;
  const ESPN_IDS = ['270559','180659','271937','289688'];
  const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/rugby';
  const results = await Promise.allSettled(
    ESPN_IDS.map(id=>fetchJson(`${ESPN_BASE}/${id}/scoreboard`).then(d=>d.events||[]))
  );
  const seen = new Set();
  const matches = results.flatMap(r=>r.status==='fulfilled'?r.value:[])
    .filter(e=>{ const st=e.competitions?.[0]?.status?.type?.state||''; return st==='pre'; })
    .filter(e=>!seen.has(e.id)&&seen.add(e.id))
    .map(e=>{
      const comp=e.competitions?.[0]||{};
      const comps=comp.competitors||[];
      const home=comps.find(c=>c.homeAway==='home'), away=comps.find(c=>c.homeAway==='away');
      const d=new Date(e.date||0);
      const timeStr=d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
      return {
        id:'espn-'+e.id,
        title:`${home?.team?.displayName||home?.team?.name||'?'} — ${away?.team?.displayName||away?.team?.name||'?'}`,
        desc:(e.league?.name||'Rugby')+(comp.venue?.fullName?` · ${comp.venue.fullName}`:''),
        date:localISO(d),
        time:timeStr,
        cats:['rugby'],
        chaine:rugbyChannel(e.league?.name, comp.broadcasts||comp.geoBroadcasts),
        approx:false,
      };
    });
  _upcomingRugby = matches;
  _upcomingRugbyTs = Date.now();
  return matches;
}

function fmtEventDate(date, dateEnd){
  const d=new Date(Date.parse(date));
  const d1=d.toLocaleDateString('fr-FR',{day:'numeric',month:'short'});
  if (!dateEnd||dateEnd===date) return d1;
  const d2=new Date(Date.parse(dateEnd));
  if (d.getMonth()===d2.getMonth()&&d.getFullYear()===d2.getFullYear())
    return `${d.getDate()}–${d2.toLocaleDateString('fr-FR',{day:'numeric',month:'short'})}`;
  return `${d1} – ${d2.toLocaleDateString('fr-FR',{day:'numeric',month:'short'})}`;
}

// Horodatage de tri = jour + heure (sinon deux événements du même jour
// s'affichent dans l'ordre d'insertion, pas chronologique).
function eventTs(ev){
  let t=Date.parse(ev.date)||0;
  if (ev.time && /^\d{1,2}:\d{2}$/.test(ev.time)){
    const [h,m]=ev.time.split(':').map(Number);
    t+=(h*60+m)*60000;
  }
  return t;
}
function renderAgenda(staticEvents, matchEvents){
  const all=[...staticEvents,...matchEvents]
    .sort((a,b)=>eventTs(a)-eventTs(b));
  if (!all.length) return '<div class="rl-loading">Aucun événement à venir.</div>';

  const byMonth={};
  all.forEach(ev=>{
    const d=new Date(Date.parse(ev.date));
    const key=`${d.getFullYear()}-${d.getMonth()}`;
    if (!byMonth[key]) byMonth[key]={
      label:d.toLocaleDateString('fr-FR',{month:'long',year:'numeric'}),
      events:[]
    };
    byMonth[key].events.push(ev);
  });

  return Object.values(byMonth).map(month=>{
    const cards=month.events.map(ev=>{
      const cats=ev.cats||[];
      const color=(CAT_COLORS[cats[0]]||['#6366F1'])[0];
      const dateLabel=fmtEventDate(ev.date,ev.dateEnd);
      const timeHtml=ev.time?`<span class="ag-time"> ${esc(ev.time)}</span>`:'';
      const approxHtml=ev.approx?'<span class="ag-approx">~approx.</span>':'';
      const locHtml=ev.loc?`<div class="ag-loc">📍 ${esc(ev.loc)}</div>`:'';
      const badges=cats.map(cid=>{
        const lbl=CAT_LABELS[cid]||cid;
        const c=(CAT_COLORS[cid]||['#6366F1'])[0];
        return `<span class="ag-badge" style="background:${c}22;color:${c}">${esc(lbl)}</span>`;
      }).join('');
      const regionBadge=ev.region?`<span class="ag-badge ag-badge-local">📍 Local</span>`:'';
      const chaines=ev.chaine?(Array.isArray(ev.chaine)?ev.chaine:[ev.chaine]):[];
      const iptv=getIptv();
      // Lien direct seulement si modèle IPTV renseigné ET carte non déjà cliquable
      // (évite une balise <a> imbriquée dans le <a> de la carte).
      const canLink=iptv && !ev.url;
      const tvStyle='background:#11182788;color:#fff;border:1px solid #ffffff2e';
      const tvHtml=chaines.map(ch=>{
        if (canLink){
          const url=iptvUrl(iptv, ch, ev.title);
          return `<a class="ag-badge ag-tv" href="${esc(url)}" target="_blank" rel="noopener" title="Voir en direct (IPTV)" style="${tvStyle}">📺 ${esc(ch)} ▶</a>`;
        }
        return `<span class="ag-badge ag-tv" style="${tvStyle}">📺 ${esc(ch)}</span>`;
      }).join('');
      const Tag=ev.url?'a':'div';
      const linkAttr=ev.url?` href="${esc(ev.url)}" target="_blank" rel="noopener"`:' ';
      return `<${Tag} class="ag-card"${linkAttr}style="--accent:${color}">
        <div class="ag-date">${esc(dateLabel)}${timeHtml}${approxHtml}</div>
        <div class="ag-body">
          <b>${esc(ev.title)}</b>
          ${ev.desc?`<div class="ag-desc">${esc(ev.desc)}</div>`:''}
          ${locHtml}
          <div class="ag-badges">${badges}${regionBadge}${tvHtml}</div>
        </div>
      </${Tag}>`;
    }).join('');
    return `<div class="ag-month"><div class="ag-month-lbl">${esc(month.label)}</div>${cards}</div>`;
  }).join('');
}

/* Grille TV rugby = fichier généré par l'EPG (tools/rugby_epg.py, mis à jour
   par cron). Récupéré au runtime depuis GitHub raw (toujours frais, sans
   reconstruire l'APK), avec repli sur la copie embarquée puis sur rien. */
const RUGBY_EPG_URL='https://raw.githubusercontent.com/laurentsar/flux-rss/master/www/data/rugby_tv.json';
let _epgRugby=null, _epgRugbyTs=0;
async function loadRugbyEpg(){
  if (_epgRugby && Date.now()-_epgRugbyTs < 30*60*1000) return _epgRugby;
  let data=null;
  try{ data=await (await fetch(RUGBY_EPG_URL+'?_='+Date.now(),{cache:'no-store'})).json(); }catch(e){}
  if (!data){ try{ data=await (await fetch('data/rugby_tv.json')).json(); }catch(e){} }
  const list=(data&&data.programmes)||[];
  const floor=Date.now()-86400000; // hier
  const out=list.filter(p=>{ const d=Date.parse(p.date); return !isNaN(d) && d>=floor; });
  _epgRugby=out; _epgRugbyTs=Date.now();
  return out;
}

async function loadAgenda(){
  hideRugbyLive();
  elSubtabs.hidden=true; elSubtabs.innerHTML='';
  elArticles.innerHTML='<div class="rl-loading"><span class="spinner"></span>Chargement de l\'agenda…</div>';
  elStatus.textContent='';
  const slow = slowConnection();
  const [staticEvents, epgRugby, frSoccer, espnRugby] = await Promise.all([
    loadAgendaEvents(),
    slow ? Promise.resolve([]) : loadRugbyEpg().catch(()=>[]),
    slow ? Promise.resolve([]) : fetchFranceSoccer().catch(()=>[]),
    slow ? Promise.resolve({events:[]}) : fetchSportsEvents().catch(()=>({events:[]})),
  ]);
  // France rugby live/finished → live section
  const frRugbyLive=(espnRugby.events||[]).filter(e=>isFranceMatch(e)&&(e.status?.type==='inprogress'||e.status?.type==='finished'));
  // France soccer upcoming → inject into agenda timeline
  const frSocUpcoming=frSoccer
    .filter(e=>e.status?.type==='notstarted')
    .map(e=>({
      id:e.id,
      title:`⚽ ${e.homeTeam.name} — ${e.awayTeam.name}`,
      desc:e.tournament?.name||'Football',
      date:e.date,
      time:new Date(e.startTimestamp*1000).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}),
      cats:['football'],
      chaine:footChannel(e.tournament?.name),
      approx:false,
    }));
  const liveHtml=renderFranceLive(frRugbyLive,frSoccer);
  // Rugby = grille TV réelle (EPG, toutes chaînes) ; repli sur la liste figée.
  const rugbyAgenda = epgRugby.length ? epgRugby : upcomingRugbyShows(4);
  const allUpcoming=[...rugbyAgenda,...frSocUpcoming];
  const total=staticEvents.length+allUpcoming.length;
  elArticles.innerHTML=(liveHtml?`<div id="ag-live">${liveHtml}</div>`:'')+renderAgenda(staticEvents,allUpcoming);
  elStatus.textContent=`${total} événement${total>1?'s':''} à venir`;
}

/* ---------- Magazines / Cafeyn ---------- */
// Un magazine Cafeyn par catégorie (lanceur affiché en tête de l'onglet)
const CAT_MAGAZINES = {
  cyber:     { id:'informaticien', title:"L'Informaticien", url:'https://www.cafeyn.co/fr/magazines/linformaticien' },
  placement: { id:'revenu',        title:'Le Revenu',       url:'https://www.cafeyn.co/fr/magazines/le-revenu-2' },
  bricolage: { id:'systemed',      title:'Système D',       url:'https://www.cafeyn.co/fr/magazines/systeme-d' },
  jeux:      { id:'jeuxvideo',     title:'Jeux Vidéo Magazine', url:'https://www.cafeyn.co/fr/magazines/jeux-video-magazine' },
  rugby:     { id:'rugby',         title:'Rugby Magazine',  url:'https://www.cafeyn.co/fr/magazines/rugby-magazine' },
};

// URL de lecture exploitable pour « reprendre » (pas l'accueil / la home)
function isResumableCafeyn(u){
  if (!u || u.indexOf('cafeyn.co') < 0) return false;
  if (/\/(home|accueil)/.test(u)) return false;
  if (/cafeyn\.co\/fr\/?(\?|#|$)/.test(u)) return false;
  return true;
}

// Mini-menu Reprendre / Dernier numéro (résout 'resume' | 'latest' | null)
function magazineChoice(title){
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML =
      `<div class="modal-card" style="max-width:480px">`+
        `<div class="modal-head" style="background:linear-gradient(180deg,#7B3F00,#3D1F00)">`+
          `<h2>📖 ${esc(title)}</h2><button data-act="cancel" aria-label="Fermer">✕</button></div>`+
        `<div class="modal-body" style="display:flex;flex-direction:column;gap:10px">`+
          `<button data-act="resume" style="padding:14px;border-radius:12px;border:1px solid var(--line);background:#1e293b;color:var(--text);font-size:1em;text-align:left;cursor:pointer">▶ Reprendre la lecture</button>`+
          `<button data-act="latest" style="padding:14px;border-radius:12px;border:1px solid var(--line);background:#1e293b;color:var(--text);font-size:1em;text-align:left;cursor:pointer">🗞 Dernier numéro</button>`+
        `</div>`+
      `</div>`;
    const done = v => { ov.remove(); resolve(v); };
    ov.addEventListener('click', e => {
      if (e.target === ov) return done(null);
      const b = e.target.closest('[data-act]');
      if (!b) return;
      done(b.dataset.act === 'cancel' ? null : b.dataset.act);
    });
    document.body.appendChild(ov);
  });
}

async function openMagazine(mag){
  if (!mag) return;
  const UP = window.Capacitor?.Plugins?.UpdatePlugin;
  const lastKey = 'cafeynLast_' + mag.id;
  const resume = localStorage.getItem(lastKey);
  let target = mag.url;
  if (resume){
    const choice = await magazineChoice(mag.title);   // menu seulement si une lecture en cours existe
    if (choice === null) return;
    target = choice === 'resume' ? resume : mag.url;
  }
  if (isNative && UP){
    try {
      await UP.authenticate({reason: `Accès à ${mag.title}`});
    } catch(e){
      return;
    }
    try {
      const res = await UP.openInAppWebView({url: target, title: `📖 ${mag.title}`, barColor: '#7B3F00'});
      if (res && isResumableCafeyn(res.lastUrl)) localStorage.setItem(lastKey, res.lastUrl);
    } catch(e){}
  } else {
    window.open(target, '_blank', 'noopener');
  }
}

/* ---------- catégories ---------- */
function renderChips(){
  const [agA,agB]=CAT_COLORS.agenda;
  const agOn=current==='agenda';
  const agStyle=agOn?`style="--a:${agA};--b:${agB}"`:'';
  elCats.innerHTML=
    `<button class="chip${agOn?' active':''}" data-id="agenda" ${agStyle}>📅 Agenda</button>`+
    DATA.categories.filter(c=>!c.off).map(c=>
      `<button class="chip" data-id="${c.id}">${esc(c.label)}</button>`).join('');
  elCats.querySelectorAll('.chip').forEach(btn=>{
    btn.addEventListener('click', ()=>selectCat(btn.dataset.id));
  });
  updateLiveBadge();
}
function selectCat(id){
  localStorage.setItem('lastCat', id);
  elCats.querySelectorAll('.chip').forEach(b=>{
    const on=b.dataset.id===id;
    b.classList.toggle('active', on);
    if (on){ const [a,b2]=CAT_COLORS[id]||['#F26522','#A8400F']; b.style.setProperty('--a',a); b.style.setProperty('--b',b2); }
  });
  if (id==='agenda'){
    current='agenda'; currentTab='news';
    const [a,b]=CAT_COLORS.agenda;
    document.documentElement.style.setProperty('--a',a);
    document.documentElement.style.setProperty('--b',b);
    $('#hero-sub').textContent='📅 Agenda';
    loadAgenda();
    return;
  }
  const cat = DATA.categories.find(c => c.id === id);
  if (!cat) return;
  currentTab = 'news';
  loadCategory(cat);
}

/* ---------- configuration personnalisable ---------- */
let DEFAULTS = null;
const clone = (o) => JSON.parse(JSON.stringify(o));
const slug = (s) => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
  .replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'') || 'cat';
let _savePrefTimer = null;
function saveConfig(){
  const json = JSON.stringify(DATA);
  localStorage.setItem('fluxConfig', json);
  // Sauvegarde native (SharedPreferences) → incluse dans Google Auto Backup
  // Debouncé 1 s pour éviter une écriture disque par frappe dans les settings
  if (isNative && window.Capacitor?.Plugins?.Preferences){
    clearTimeout(_savePrefTimer);
    _savePrefTimer = setTimeout(()=>{
      window.Capacitor.Plugins.Preferences.set({key:'fluxConfig', value:json});
      window.Capacitor.Plugins.Preferences.set({key:'srcLang', value:lang});
    }, 1000);
  }
}
function newCatId(base){ let id=slug(base), n=2; while(DATA.categories.some(c=>c.id===id)){ id=slug(base)+'_'+n; n++; } return id; }

function firstEnabled(){ return DATA.categories.find(c=>!c.off); }
function refreshAfterConfig(){
  if (!DATA.categories.length){ DATA.categories=clone(DEFAULTS.categories); saveConfig(); }
  renderChips();
  if (current==='agenda'){ selectCat('agenda'); return; }
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
    const farr = catFeeds(ci);
    const feeds = farr.map((f,fi) => `
      <div class="feed-row ${f.off?'off':''}">
        <button class="iconbtn tg" data-act="toggle-feed" data-ci="${ci}" data-fi="${fi}" title="${f.off?'Activer':'Désactiver'}">${f.off?'🚫':'👁️'}</button>
        <input class="f-name" data-ci="${ci}" data-fi="${fi}" value="${esc(f.name)}">
        <input class="f-url" data-ci="${ci}" data-fi="${fi}" value="${esc(f.url)}">
        <button class="iconbtn mv" data-act="feed-up" data-ci="${ci}" data-fi="${fi}" title="Monter le flux" ${fi===0?'disabled':''}>↑</button>
        <button class="iconbtn mv" data-act="feed-down" data-ci="${ci}" data-fi="${fi}" title="Descendre le flux" ${fi===farr.length-1?'disabled':''}>↓</button>
        <button class="iconbtn" data-act="del-feed" data-ci="${ci}" data-fi="${fi}">✕</button>
      </div>`).join('');
    const isFirst = ci === 0, isLast = ci === DATA.categories.length - 1;
    return `<div class="cat-block ${c.off?'off':''}" style="--accent:${color}">
      <div class="cat-head">
        <button class="iconbtn tg" data-act="toggle-cat" data-ci="${ci}" title="${c.off?'Activer la catégorie':'Désactiver la catégorie'}">${c.off?'🚫':'👁️'}</button>
        <input class="cat-label" data-ci="${ci}" value="${esc(c.label)}">
        <button class="iconbtn" data-act="cat-up" data-ci="${ci}" title="Monter" ${isFirst?'disabled':''}>↑</button>
        <button class="iconbtn" data-act="cat-down" data-ci="${ci}" title="Descendre" ${isLast?'disabled':''}>↓</button>
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
      <div class="hint">Tu édites les sources <b>${lang==='en'?'anglaises 🇬🇧':'françaises 🇫🇷'}</b> (bascule via le drapeau en haut). 👁️/🚫 activer/désactiver · ↑↓ réordonner · ✕/🗑️ supprimer. Sauvegarde auto (conservée lors des MAJ).</div>
      ${cats}
      <div class="add-cat">
        <input id="new-cat" placeholder="Nouvelle catégorie (ex : 🎮 Jeux)">
        <button class="btn cat" data-act="add-cat">+ Catégorie</button>
      </div>
      <button class="btn reset" data-act="reset">↺ Restaurer les flux par défaut</button>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn" style="flex:1;background:#1e293b;border:1px solid var(--line);color:#86efac" data-act="export-cfg">⬇ Exporter mes réglages</button>
        <label class="btn" style="flex:1;background:#1e293b;border:1px solid var(--line);color:#93c5fd;text-align:center;cursor:pointer">
          ⬆ Importer un backup<input type="file" accept=".json" style="display:none" id="import-cfg-file">
        </label>
      </div>
      <div class="iptv-cfg" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
        <div class="hint">📺 <b>Lecteur IPTV</b> (optionnel) — modèle d'URL ouvert au clic sur une chaîne de l'agenda, pour voir le direct. Variables : <code>{chaine}</code> (nom de la chaîne), <code>{q}</code> (match). Aucun flux n'est fourni : renseigne ta propre source légale. Vide = pas de lien direct.</div>
        <input id="iptv-tpl" placeholder="ex : http://mon-serveur/live/{chaine}.m3u8  ·  iptv://play?c={chaine}" value="${esc(getIptv())}" style="width:100%;margin-top:6px">
      </div>
      <div class="app-version">Flux RSS v${APP_VERSION}</div>
    </div>`;
}

function onSettingsChange(e){
  const t=e.target, ci=+t.dataset.ci, fi=+t.dataset.fi, v=t.value.trim();
  if (t.id==='iptv-tpl'){ setIptv(v); return; }
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
  else if (act==='cat-up'){ if(ci>0){ const tmp=DATA.categories[ci-1]; DATA.categories[ci-1]=DATA.categories[ci]; DATA.categories[ci]=tmp; } }
  else if (act==='cat-down'){ if(ci<DATA.categories.length-1){ const tmp=DATA.categories[ci+1]; DATA.categories[ci+1]=DATA.categories[ci]; DATA.categories[ci]=tmp; } }
  else if (act==='feed-up'){ const a=catFeeds(ci); if(fi>0){ const tmp=a[fi-1]; a[fi-1]=a[fi]; a[fi]=tmp; } }
  else if (act==='feed-down'){ const a=catFeeds(ci); if(fi<a.length-1){ const tmp=a[fi+1]; a[fi+1]=a[fi]; a[fi]=tmp; } }
  else if (act==='reset'){ if(!confirm('Restaurer les catégories et flux d\'origine ?')) return; DATA=clone(DEFAULTS); }
  else if (act==='export-cfg'){
    const blob = new Blob([JSON.stringify({fluxConfig:DATA, srcLang:lang}, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fluxrss-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    return;
  }
  else return;
  saveConfig(); renderSettings();
}

/* ---------- mise à jour automatique ---------- */
function versionGt(tag, current){
  const p = v => v.replace(/^v/,'').split('.').map(Number);
  const [la, lb = 0] = p(tag), [ca, cb = 0] = p(current);
  return la > ca || (la === ca && lb > cb);
}

function showUpdateBanner(tag, apkUrl){
  const existing = document.getElementById('update-banner');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'update-banner';
  el.innerHTML =
    `<span class="upd-msg">🆕 <b>${esc(tag)}</b> disponible</span>`+
    `<button class="upd-btn" id="btn-update">⬇ Installer</button>`+
    `<button class="upd-x" id="btn-dismiss-update">✕</button>`;
  document.body.appendChild(el);

  document.getElementById('btn-dismiss-update').addEventListener('click', ()=>{
    localStorage.setItem('dismissedUpdate', tag);
    el.remove();
  });
  document.getElementById('btn-update').addEventListener('click', async ()=>{
    const btn = document.getElementById('btn-update');
    btn.textContent = '⏳…'; btn.disabled = true;
    try {
      await window.Capacitor.Plugins.UpdatePlugin.downloadAndInstall({url: apkUrl});
    } catch(e) {
      btn.textContent = '⬇ Installer'; btn.disabled = false;
      if (e && e.message && e.message.includes('permission')) {
        alert('Autorise l\'installation d\'apps depuis cette source dans les paramètres Android, puis réessaie.');
      } else {
        alert('Erreur : ' + (e && e.message || e));
      }
    }
  });
}

async function checkForUpdate(){
  if (!isNative || slowConnection()) return;
  try {
    const data = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    const tag = data.tag_name || '';
    if (!tag || !versionGt(tag, APP_VERSION)) return;
    if (localStorage.getItem('dismissedUpdate') === tag) return;
    const asset = (data.assets || []).find(a => a.name && a.name.endsWith('.apk'));
    if (!asset) return;
    showUpdateBanner(tag, asset.browser_download_url);
  } catch(e) { /* pas de réseau ou API indispo — silencieux */ }
}

/* ---------- init ---------- */
async function init(){
  DEFAULTS = await (await fetch('data/feeds.json')).json();
  const saved = localStorage.getItem('fluxConfig');
  let restoredFromBackup = false;
  if (saved){
    DATA = JSON.parse(saved);
  } else if (isNative && window.Capacitor?.Plugins?.Preferences){
    // Pas de config localStorage → vérifier si un backup natif existe (Auto Backup Google)
    try {
      const {value: cfgVal} = await window.Capacitor.Plugins.Preferences.get({key:'fluxConfig'});
      const {value: langVal} = await window.Capacitor.Plugins.Preferences.get({key:'srcLang'});
      if (cfgVal){
        DATA = JSON.parse(cfgVal);
        if (langVal){ lang = langVal; localStorage.setItem('srcLang', lang); }
        localStorage.setItem('fluxConfig', cfgVal); // recopie dans localStorage
        restoredFromBackup = true;
      } else {
        DATA = clone(DEFAULTS);
      }
    } catch(e){ DATA = clone(DEFAULTS); }
  } else {
    DATA = clone(DEFAULTS);
  }
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
    const dv = DEFAULTS.version || 1;
    const prevVer = DATA.version || 1;
    const defById = {};
    DEFAULTS.categories.forEach(c=> defById[c.id]=c);
    // migration ponctuelle (transition vers v10) : retrait de l'ancien fourre-tout 'anglais'
    if (prevVer < 10) DATA.categories = DATA.categories.filter(c=> c.id!=='anglais');
    // v15 : purge des flux morts/hors-sujet + correction des podcasts Radio France réassignés + ajout des podcasts
    if (prevVer < 15){
      const DEAD = new Set([
        'https://www.journaldugeek.com/feed/','https://www.objetconnecte.com/feed/',
        'https://www.lesnumeriques.com/maison-connectee/rss.xml','https://casques-vr.com/rss',
        'https://www.lesnumeriques.com/casque-realite-virtuelle/rss.xml','https://www.lebigdata.fr/feed',
        'https://next.ink/category/ia-algorithmes/feed/','https://siecledigital.fr/feed/',
        'https://lenergeek.com/feed/','https://www.lesnumeriques.com/bons-plans/rss.xml',
        'https://www.boursorama.com/bourse/actualites/rss/actualites',
        'https://rss.art19.com/la-story','https://rss.art19.com/l-heure-du-monde',
        'https://rss.acast.com/generationdoityourself','https://www.chosesasavoir.com/feed/podcast/',
        'https://podcast.rtl.fr/grosses-tetes/rss',
        'https://feeds.audiomeans.fr/feed/87476e72-eb04-4f8f-8cf9-51d7e6a8ec29.xml'
      ]);
      const RENAME = {
        'https://radiofrance-podcast.net/podcast09/rss_14312.xml':'La Science, CQFD (France Culture)',
        'https://radiofrance-podcast.net/podcast09/rss_10078.xml':'Les Pieds sur terre (France Culture)'
      };
      DATA.categories.forEach(c=>{
        ['feeds','feeds_en'].forEach(k=>{
          if (!Array.isArray(c[k])) return;
          c[k] = c[k].filter(f=> !DEAD.has(f.url));
          c[k].forEach(f=>{ if (RENAME[f.url]){ f.name=RENAME[f.url]; f.pod=true; f.kind='audio'; } });
        });
      });
      changed=true;
    }
    // v16 : suppression catégories YouTube FR + Podcasts globale, renommage ve -> Voiture électrique (FR & EN)
    if (prevVer < 16){
      DATA.categories = DATA.categories.filter(c=> c.id!=='youtube' && c.id!=='podcasts');
      const veCat = DATA.categories.find(c=>c.id==='ve');
      if (veCat) veCat.label = '🚗 Voiture électrique';
      const lc = localStorage.getItem('lastCat');
      if (lc==='youtube' || lc==='podcasts') localStorage.removeItem('lastCat');
      changed=true;
    }
    // nouvelles catégories par défaut -> AJOUTÉES EN FIN (ne bouscule pas TON ordre)
    const haveCats = new Set(DATA.categories.map(c=>c.id));
    DEFAULTS.categories.forEach(c=>{ if(!haveCats.has(c.id)){ DATA.categories.push(clone(c)); haveCats.add(c.id); changed=true; } });
    // v22 : fusion xv_direct dans rugby (en tête de liste) + suppression catégorie séparée
    if (prevVer < 22){
      const XV_URLS = [
        'https://news.google.com/rss/search?hl=fr&gl=FR&ceid=FR:fr&q=XV+de+France+rugby+direct',
        'https://news.google.com/rss/search?hl=fr&gl=FR&ceid=FR:fr&q=France+rugby+score+en+direct',
        'https://news.google.com/rss/search?hl=fr&gl=FR&ceid=FR:fr&q=France+rugby+r%C3%A9sultat+match',
        'https://news.google.com/rss/search?hl=fr&gl=FR&ceid=FR:fr&q=test+match+XV+de+France'
      ];
      const XV_NAMES = ['XV de France — direct','France rugby — score en direct','France rugby — résultat','Test match XV de France'];
      const rugbyCat = DATA.categories.find(c=>c.id==='rugby');
      if (rugbyCat){
        const haveUrls = new Set((rugbyCat.feeds||[]).map(f=>f.url));
        const toAdd = XV_URLS.map((url,i)=>({name:XV_NAMES[i],url})).filter(f=>!haveUrls.has(f.url));
        if (toAdd.length){ rugbyCat.feeds = [...toAdd, ...(rugbyCat.feeds||[])]; changed=true; }
      }
      const xvIdx = DATA.categories.findIndex(c=>c.id==='xv_direct');
      if (xvIdx > -1){ DATA.categories.splice(xvIdx,1); changed=true; }
      if (localStorage.getItem('lastCat')==='xv_direct') localStorage.setItem('lastCat','rugby');
    }
    // nouveaux flux par défaut -> AJOUTÉS EN FIN de leur catégorie, en préservant TON ordre,
    // tes renommages, tes désactivations ET tes suppressions (suivi via _knownDefaultFeeds).
    const known = new Set(DATA._knownDefaultFeeds || []);
    const firstTrack = !DATA._knownDefaultFeeds; // 1re exécution du suivi -> on n'ajoute rien (évite de ressusciter tes suppressions)
    const mergeNew = (userArr, defArr) => {
      userArr = userArr || [];
      if (firstTrack) return userArr;
      const haveUrls = new Set(userArr.map(f=>f.url));
      (defArr||[]).forEach(f=>{ if(!haveUrls.has(f.url) && !known.has(f.url)){ const nf={name:f.name,url:f.url}; if(f.pod){ nf.pod=true; if(f.kind) nf.kind=f.kind; } userArr.push(nf); haveUrls.add(f.url); changed=true; } });
      return userArr;
    };
    DATA.categories.forEach(c=>{
      const dc = defById[c.id]; if(!dc) return;
      c.feeds = mergeNew(c.feeds, dc.feeds);
      c.feeds_en = mergeNew(c.feeds_en, dc.feeds_en);
      // feeds_changelog n'est pas éditable par l'utilisateur : on le resync toujours depuis DEFAULTS
      if (dc.feeds_changelog) c.feeds_changelog = clone(dc.feeds_changelog);
    });
    // recentrage « voyage » sur les deals uniquement (une seule fois, transition v10)
    if (prevVer < 10){
      const vCat = DATA.categories.find(c=>c.id==='voyage'), vDef = defById['voyage'];
      if (vCat && vDef){ vCat.label = vDef.label; vCat.feeds = clone(vDef.feeds); vCat.feeds_en = clone(vDef.feeds_en); }
    }
    // mémorise les URLs par défaut connues -> distingue « nouveau flux » de « flux que tu as supprimé » au prochain MAJ
    const curDefUrls = [];
    DEFAULTS.categories.forEach(c=>{ (c.feeds||[]).forEach(f=>curDefUrls.push(f.url)); (c.feeds_en||[]).forEach(f=>curDefUrls.push(f.url)); });
    if (JSON.stringify(DATA._knownDefaultFeeds||[]) !== JSON.stringify(curDefUrls)){ DATA._knownDefaultFeeds = curDefUrls; changed=true; }
    if (DATA.version !== dv){ DATA.version = dv; changed=true; }
    if (changed) saveConfig();
  }
  const verEl = document.getElementById('app-ver');
  if (verEl) verEl.textContent = 'v' + APP_VERSION;
  renderChips();
  const last = localStorage.getItem('lastCat');
  if (last==='agenda'){
    selectCat('agenda');
  } else {
    const startCat = DATA.categories.find(c=>c.id===last && !c.off) || firstEnabled();
    if (startCat) selectCat(startCat.id);
    else elStatus.textContent='Toutes les catégories sont désactivées (⚙️).';
  }
  // Vérifie les matchs en direct en arrière-plan et bascule sur Rugby si besoin
  checkLiveAndSwitch();
  if (restoredFromBackup){
    setTimeout(()=>{
      const t = document.createElement('div');
      t.textContent = '✅ Réglages restaurés depuis le backup';
      Object.assign(t.style,{position:'fixed',bottom:'calc(env(safe-area-inset-bottom)+80px)',left:'50%',transform:'translateX(-50%)',background:'#16a34a',color:'#fff',padding:'10px 18px',borderRadius:'12px',fontWeight:'700',fontSize:'.9em',zIndex:'999',boxShadow:'0 4px 14px rgba(0,0,0,.4)',opacity:'1',transition:'opacity 1s'});
      document.body.appendChild(t);
      setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(),1000); }, 3000);
    }, 800);
  }
  elRefresh.addEventListener('click', () => {
    if (current==='agenda'){ _upcomingRugby=null; _espnCache=null; _frSocCache=null; loadAgenda(); return; }
    const cat = DATA.categories.find(c => c.id === current);
    if (cat) loadCategory(cat);
  });
  // article ouvert (carte courte ou « Lire l'article ») = consulté -> masqué et mémorisé
  elSubtabs.addEventListener('click', (e)=>{
    const b = e.target.closest('.subtab'); if(!b) return;
    const tab = b.dataset.tab;
    if (tab === currentTab) return;
    currentTab = tab;
    elSubtabs.querySelectorAll('.subtab').forEach(x=>x.classList.toggle('active', x.dataset.tab===tab));
    const cat = DATA.categories.find(c => c.id === current);
    if (cat) loadCategory(cat);
  });
  elArticles.addEventListener('click', (e)=>{
    const ml = e.target.closest('.mag-launch');
    if (ml){ e.preventDefault(); openMagazine(CAT_MAGAZINES[ml.dataset.mag]); return; }
    const a = e.target.closest('a.card, a.read'); if(!a || a.classList.contains('podlink') || currentTab==='pods') return;
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
  elModal.addEventListener('change', (e)=>{
    if (e.target.id !== 'import-cfg-file') return;
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const bk = JSON.parse(ev.target.result);
        if (!bk.fluxConfig) { alert('Fichier invalide — pas de fluxConfig trouvé.'); return; }
        if (!confirm('Importer ce backup ? Tes réglages actuels seront remplacés.')) return;
        DATA = bk.fluxConfig;
        if (bk.srcLang) { lang = bk.srcLang; localStorage.setItem('srcLang', lang); }
        saveConfig();
        renderSettings();
        alert('Réglages importés avec succès !');
      } catch(err) { alert('Erreur lors de la lecture du fichier : ' + err.message); }
    };
    reader.readAsText(file);
  });
  elModal.addEventListener('click', (e)=>{ if(e.target===elModal) closeSettings(); });
  elRugbyLive.addEventListener('click', e=>{
    if (!e.target.classList.contains('rl-more-btn')) return;
    _rlTop14Shown = Math.min(_rlTop14Shown + 3, _rlTop14Journees.length);
    const el = elRugbyLive.querySelector('.rl-results-top14');
    if (el) el.outerHTML = renderRLResults(_rlTop14Journees,'Résultats Top 14',_rlTop14Shown);
  });
  if ('serviceWorker' in navigator){
    if (isNative){
      // Sur Capacitor Android, le SW cache les assets et bloque les mises à jour APK.
      // On le désactive et on désinscrit tout SW existant.
      navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
    } else {
      try{
        navigator.serviceWorker.register('sw.js');
        navigator.serviceWorker.addEventListener('controllerchange', () => { window.location.reload(); });
      }catch(e){}
    }
  }
  // Pause toutes les animations CSS quand l'écran est éteint / app en arrière-plan
  document.addEventListener('visibilitychange', ()=>{
    document.body.classList.toggle('page-hidden', document.hidden);
  });
  // Vérification de mise à jour non bloquante (3 s après le démarrage)
  setTimeout(checkForUpdate, 3000);
}
init();
