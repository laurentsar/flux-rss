'use strict';

/* ---------- config ---------- */
const APP_VERSION = '4.88';
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
const elFootballLive = document.getElementById('football-live');
const elPlacementLive = document.getElementById('placement-live');

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
  const ESPN_IDS = ['270559','180659','271937','289688','17567'];
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
      tournament:{name:e.league?.name||'', round:e.competitions?.[0]?.notes?.[0]?.headline||''},
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
  const cutoff = Date.now()/1000 - 7*24*3600;
  const deduped = events
    .filter(e=>!seen.has(e.id)&&seen.add(e.id))
    .filter(e=>e.status.type!=='finished' || e.startTimestamp>cutoff);
  deduped.sort((a,b)=>{const o=t=>t==='inprogress'?0:t==='finished'?1:2;return o(a.status.type)-o(b.status.type)||(a.startTimestamp-b.startTimestamp);});
  const r={events:deduped, error:null};
  _espnCache=r; _espnCacheTs=Date.now();
  return r;
}

function renderLiveScores(events, extraIntlHtml=''){
  const top14Events = events.filter(e=>e.isClub);
  const intlEvents  = events.filter(e=>!e.isClub).filter(e=>
    e.status?.type!=='notstarted' ||
    FR_RE.test(e.homeTeam?.name||'') || FR_RE.test(e.awayTeam?.name||'')
  );

  function section(evts, label, extra=''){
    if (!evts.length && !extra) return '';
    const renderCard = e => {
      const st = e.status?.type;
      const live = st==='inprogress', fin = st==='finished';
      const hs = e.homeScore?.current??'', as_ = e.awayScore?.current??'';
      const hw = fin && parseInt(hs)>parseInt(as_), aw = fin && parseInt(as_)>parseInt(hs);
      const badge = live ? '<span class="rl-live-dot"></span>' : '';
      const time = live ? (e.status.description||'⏱') : fin ? '' :
        new Date((e.startTimestamp||0)*1000).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
      const score = (live||fin) ? `<b>${hs}</b><span class="rl-vs">–</span><b>${as_}</b>${time?`<span class="rl-time"> ${time}</span>`:''}` : `<span class="rl-vs">${time}</span>`;
      const hn=e.homeTeam?.name||'?', an=e.awayTeam?.name||'?';
      const roundLbl=e.tournament?.round?` · ${esc(e.tournament.round)}`:'';
      const compLine=e.tournament?.name?`<div class="rl-jlbl">🏉 ${esc(e.tournament.name)}${roundLbl}</div>`:'';
      return compLine+`<div class="rl-match"><span class="rl-tn ${hw?'rl-w':''}">${teamBadge(hn)}${esc(hn)}</span><span class="rl-sb">${badge}${score}</span><span class="rl-tn rl-tnr ${aw?'rl-w':''}">${teamBadge(an)}${esc(an)}</span></div>`;
    };
    const liveEvts = evts.filter(e=>e.status?.type==='inprogress');
    const doneEvts = evts.filter(e=>e.status?.type!=='inprogress');
    let html = '';
    if(liveEvts.length)
      html += `<div class="rl-section rl-live-section"><div class="rl-sh">🔴 ${label} — En direct<button class="rl-refresh-btn" onclick="manualRefreshLive()" title="Actualiser">⟳</button></div>${liveEvts.map(renderCard).join('')}</div>`;
    const doneCards = doneEvts.map(renderCard).join('');
    if(doneCards || extra)
      html += `<details class="rl-section"><summary class="rl-sh">${label}</summary>${doneCards}${extra}</details>`;
    return html;
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
  return `<details class="rl-section"><summary class="rl-sh">🏉 Brive & Colomiers — Pro D2</summary>${cards}</details>`;
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
        // Upcoming / live : n'afficher que les matchs France
        if (!FR_RE.test(home) && !FR_RE.test(away)) return '';
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
let _liveRefreshTimer = null;
function stopLiveRefresh(){ if(_liveRefreshTimer){clearTimeout(_liveRefreshTimer);_liveRefreshTimer=null;} }
function scheduleLiveRefresh(fn){ stopLiveRefresh(); _liveRefreshTimer=setTimeout(fn,20000); }
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
function manualRefreshLive(){
  stopLiveRefresh();
  if (current==='rugby'){ _espnCache=null; loadRugbyLive({liveRefresh:true}); }
  else if (current==='football'){ _footLiveHtml=null; _frSocCache=null; _toulouseCache=null; _worldCupCache=null; loadFootballLive({liveRefresh:true}); }
  else if (current==='agenda') reloadAgendaLive();
}

async function loadRugbyLive(opts={}){
  if (!elRugbyLive) return;
  elRugbyLive.hidden = false;
  if (_rugbyLiveHtml && Date.now() - _rugbyLiveTs < 3 * 60 * 1000 && !opts.liveRefresh){
    elRugbyLive.innerHTML = _rugbyLiveHtml;
    return;
  }
  if (opts.liveRefresh) _espnCache = null;
  else elRugbyLive.innerHTML = '<div class="rl-loading"><span class="spinner"></span>Scores & classements…</div>';
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
  if (sofa.error) html += `<details class="rl-section"><summary class="rl-sh">📡 Scores live</summary><div class="rl-loading">⚠️ ${sofa.error}</div></details>`;
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
  if (_hasLiveSports) scheduleLiveRefresh(()=>loadRugbyLive({liveRefresh:true}));
}

function hideRugbyLive(){
  if (elRugbyLive){ elRugbyLive.hidden=true; elRugbyLive.innerHTML=''; }
  stopLiveRefresh();
}

/* ---------- Changelog Live ---------- */
let _clHtml = null;
let _clSeen = JSON.parse(localStorage.getItem('cl_seen') || '{}');
function _showClNewBadge(catId){
  document.querySelector(`.chip[data-id="${catId}"]`)?.classList.add('chip-has-new');
}
function _clMarkSeen(catId, version, el){
  _clSeen[catId] = version;
  try { localStorage.setItem('cl_seen', JSON.stringify(_clSeen)); } catch(e){}
  document.querySelector(`.chip[data-id="${catId}"]`)?.classList.remove('chip-has-new');
  el.querySelectorAll('.cl-new').forEach(b => b.remove());
  el.ontoggle = null;
  _clHtml = document.getElementById('changelog-live')?.innerHTML || null;
}

// Extrait le vrai src d'une balise img (gère WordPress lazy-load : data-lazy-src / data-src)
function imgRealSrc(el){
  const s = el.getAttribute('data-lazy-src') || el.getAttribute('data-src') || el.getAttribute('src') || '';
  return s.startsWith('data:') ? '' : s; // ignore SVG placeholder
}

// Parse les sections d'une page : cherche h3 (ou h2) → img → description
function parseFeatureSections(html, tagName='h3', baseUrl=''){
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const features = [];
  tmp.querySelectorAll(tagName).forEach(hEl => {
    const title = hEl.textContent.trim();
    if (!title || title.length < 3) return;
    let imgSrc = '';
    const descParts = [];
    let el = hEl.nextElementSibling;
    while (el && el.tagName !== tagName.toUpperCase() && el.tagName !== 'H2' && el.tagName !== 'H1'){
      // cherche img directement ou imbriquée (ex: <a><img></a>, <figure><img></figure>)
      const imgEl = (el.tagName === 'IMG') ? el : el.querySelector('img');
      if (!imgSrc && imgEl){
        imgSrc = imgRealSrc(imgEl);
        if (imgSrc && imgSrc.startsWith('/')) imgSrc = baseUrl + imgSrc;
      }
      // look for <p> both as direct sibling and nested inside container divs
      const pEls = el.tagName === 'P' ? [el] : [...el.querySelectorAll('p')];
      for (const p of pEls){
        const txt = p.textContent.trim();
        if (txt.length > 20) descParts.push(txt);
      }
      el = el.nextElementSibling;
    }
    if (imgSrc) features.push({ title, image: imgSrc, desc: descParts.slice(0,3).join(' ') });
  });
  return features;
}

function featureIcon(title){
  const t = (title||'').toLowerCase();
  // Tesla
  if (/angle mort|blind.?spot/.test(t))                         return '👁️';
  if (/dashcam|clip/.test(t))                                   return '📷';
  if (/chiffr|encrypt|verrou/.test(t))                          return '🔐';
  if (/autopilot|fsd|conduite|pilotage|driving/.test(t))        return '🚗';
  if (/parking|stationnement/.test(t))                          return '🅿️';
  if (/grok|gemini|chatgpt|copilot/.test(t))                    return '🤖';
  if (/phone|téléphone|mobile/.test(t))                         return '📱';
  if (/phare|éclairage/.test(t))                                return '💡';
  if (/service|maintenance|diagnostic|mode\s+atelier/.test(t))  return '🔧';
  // Home Assistant
  if (/automati|workflow|déclench|trigger/.test(t))             return '🔄';
  if (/tableau\s+de\s+bord|dashboard|lovelace|interface|ux|expérience/.test(t)) return '🖥️';
  if (/intégration|integration|protocole/.test(t))              return '🔌';
  if (/appareil|device|matériel|hardware/.test(t))              return '📟';
  if (/zigbee|zha|z-wave|zwave|matter|thread/.test(t))          return '📡';
  if (/infrarouge|radiofréq|rf\b/.test(t))                      return '📶';
  if (/journal|activité|log|histor/.test(t))                    return '📋';
  if (/mise\s+à\s+jour|maj\b|update|version/.test(t))           return '⬆️';
  if (/performance|débogage|debug|optimis/.test(t))             return '⚡';
  if (/utilisateur|user|profil|compte|accès/.test(t))           return '👤';
  if (/notification|alerte|alert/.test(t))                      return '🔔';
  if (/alarme|alarm|sirène/.test(t))                            return '🚨';
  if (/scène|scene|ambiance/.test(t))                           return '🎬';
  if (/script|action|service/.test(t))                          return '⚙️';
  if (/calendrier|agenda|schedule|planifi/.test(t))             return '📅';
  // Claude / IA
  if (/claude|sonnet|opus|haiku|fable/.test(t))                 return '🤖';
  if (/agent|agentic|tool use|computer use/.test(t))            return '🦾';
  if (/api|sdk|developer|développeur/.test(t))                  return '🔗';
  if (/benchmark|eval|évaluation|test/.test(t))                 return '📊';
  if (/safety|safeguard|jailbreak|alignment/.test(t))           return '🛡️';
  if (/context|window|token|mémoire/.test(t))                   return '🧠';
  if (/image|vision|multimodal|pdf/.test(t))                    return '🖼️';
  if (/pricing|prix|cost|gratuit|free/.test(t))                 return '💰';
  if (/science|research|recherche/.test(t))                     return '🔬';
  // VR / Quest
  if (/quest|vr\b|casque|headset|horizon os/.test(t))           return '🥽';
  if (/game|jeu|play|gaming|titre/.test(t))                     return '🎮';
  if (/discord|social|friend|multi.?joueur|multijoueur/.test(t)) return '👥';
  if (/controller|manette|joystick|touch/.test(t))              return '🕹️';
  if (/mixed.?reality|passthrough|ar\b|réalité\s+mixte/.test(t)) return '🔀';
  if (/sale|deal|promo|discount|réduction/.test(t))             return '🏷️';
  // Commun Tesla + HA
  if (/caméra|camera/.test(t))                                  return '📷';
  if (/sécurité|security/.test(t))                              return '🛡️';
  if (/parent|famille|family|enfant|child/.test(t))             return '👨‍👩‍👧';
  if (/voice|voix|hey\s|vocale|speech/.test(t))                 return '🎙️';
  if (/navigation|nav|itinér|route|map|carte/.test(t))          return '🗺️';
  if (/music|média|media|spotify|audio|son|radio/.test(t))      return '🎵';
  if (/énergie|energy|charge|batterie|battery|recharge|conso/.test(t)) return '🔋';
  if (/température|climate|clim|chauffage|heat|thermostat/.test(t)) return '🌡️';
  if (/lumière|light/.test(t))                                  return '💡';
  if (/bluetooth|wifi|connect|wireless|réseau|network/.test(t)) return '📡';
  return '✦';
}

async function loadTeslaReleaseNotes(){
  // Step 1: sitemap → première URL /software-updates/version/{VER}/release-notes = version la plus récente
  // Use regex on raw XML text to avoid Chrome/Android namespace issues with querySelectorAll on XML docs
  let version = null;
  try {
    const sitemapXml = await httpGet('https://www.notateslaapp.com/sitemap.xml');
    const m = sitemapXml.match(/\/software-updates\/version\/([^\/]+)\/release-notes/);
    if (m) version = m[1];
  } catch(e){}
  // Fallback : scan RSS brut si le sitemap échoue
  if (!version){
    try {
      const rssXml = await httpGet('https://www.notateslaapp.com/rss');
      const m = rssXml.match(/\/software-updates\/version\/([^\/]+)\//);
      if (m) version = m[1];
    } catch(e){}
  }
  if (!version) return null;

  // Step 2: fetch the French page, fallback to English if French fails
  let html, pageLink;
  try {
    pageLink = `https://www.notateslaapp.com/fr/mises-a-jour-logicielles/version/${version}/notes-de-mise-a-jour`;
    html = await httpGet(pageLink);
  } catch(e){}
  if (!html) {
    try {
      pageLink = `https://www.notateslaapp.com/software-updates/version/${version}/release-notes`;
      html = await httpGet(pageLink);
    } catch(e){ return null; }
  }
  if (!html) return null;

  // Step 3: parse features — actual feature sections use h2, h3s are nav overview links
  // Filter out section headers (Update Stats, Recent News, Details...) and news (Tesla Videos, etc.)
  const features = parseFeatureSections(html, 'h2', 'https://www.notateslaapp.com').map(f=>({
    ...f,
    desc: f.desc.replace(/^(Disponible|Modèles?:|Models?:)[^\n]*/gim,'').trim()
  }))
    .filter(f=>!/^(Update Stats|Recent News|Details|Statistics|Overview|\d{4}\.\d)/i.test(f.title))
    .filter(f=>!/^Tesla\s/i.test(f.title))
    .filter(f=> f.title && (f.image || f.desc));

  return features.length ? { version, features, pageLink } : null;
}

async function loadHAChangelog(){
  // Step 1: trouver le dernier article HA release sur domo-blog.fr via RSS
  let articleUrl = null, version = null;
  try {
    const rssXml = await httpGet('https://www.domo-blog.fr/feed/');
    const rssItems = parseFeed(rssXml, 'domo-blog', null);
    const haItem = rssItems.find(it => /home[\s-]?assistant\s+\d{4}\.\d+/i.test(it.title||''));
    if (haItem){
      articleUrl = haItem.link;
      const m = (haItem.title||'').match(/(\d{4}\.\d+)/);
      if (m) version = m[1];
    }
  } catch(e){}
  if (!articleUrl) return null;

  // Step 2: récupérer la page de l'article
  let html;
  try { html = await httpGet(articleUrl); } catch(e){ return null; }

  // Step 3: parser les sections h3 avec images (WordPress lazy-load géré par imgRealSrc)
  const features = parseFeatureSections(html, 'h3', 'https://www.domo-blog.fr');
  return features.length ? { version: version||'HA', features, pageLink: articleUrl } : null;
}

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

async function loadClaudeChangelog(){
  // Find latest Claude article from Anthropic news listing
  let articleUrl = null, version = null;
  try {
    const newsHtml = await httpGet('https://www.anthropic.com/news');
    const m = newsHtml.match(/href="(\/news\/claude[-\w]+)"/);
    if (m) {
      articleUrl = 'https://www.anthropic.com' + m[1];
      version = m[1].replace('/news/','').replace(/-/g,' ').replace(/\b\w/g, c=>c.toUpperCase());
    }
  } catch(e){}
  if (!articleUrl) return null;
  let html;
  try { html = await httpGet(articleUrl); } catch(e){ return null; }
  // Decode Next.js image optimization URLs → original CDN URLs
  // /_next/image?url=ENCODED_CDN_URL&... → CDN_URL
  html = html.replace(/\/_next\/image\?url=([^&"'\s]+)[^"']*/g, (_, enc) => {
    try { return decodeURIComponent(enc); } catch(e){ return _; }
  });
  const features = parseFeatureSections(html, 'h2', 'https://www.anthropic.com')
    .filter(f => f.title && (f.image || f.desc))
    .filter(f => !/^(related|availability|pricing|feedback)/i.test(f.title));
  return features.length ? { version, features, pageLink: articleUrl } : null;
}

async function loadQuestChangelog(){
  // Step 1: trouver le dernier article Horizon OS sur UploadVR via RSS
  let articleUrl = null, version = null;
  try {
    const rssXml = await httpGet('https://www.uploadvr.com/feed/');
    const rssItems = parseFeed(rssXml, 'uploadvr', null);
    const item = rssItems.find(it => /horizon\s*os\s+v?\d+/i.test(it.title||'') || /meta\s+quest.*v?\d+.*update/i.test(it.title||''));
    if (item) {
      articleUrl = item.link;
      const m = (item.title||'').match(/v?(\d+[\d.]*)/i);
      if (m) version = 'Horizon OS v' + m[1];
    }
  } catch(e){}
  // Fallback : Road to VR
  if (!articleUrl) {
    try {
      const rssXml = await httpGet('https://www.roadtovr.com/tag/horizon-os/feed/');
      const rssItems = parseFeed(rssXml, 'roadtovr', null);
      const item = rssItems.find(it => /horizon\s*os|meta\s+quest.*update/i.test(it.title||''));
      if (item) {
        articleUrl = item.link;
        const m = (item.title||'').match(/v?(\d+[\d.]*)/i);
        if (m) version = 'Horizon OS v' + m[1];
      }
    } catch(e){}
  }
  if (!articleUrl) return null;

  // Step 2: récupérer la page de l'article
  let html;
  try { html = await httpGet(articleUrl); } catch(e){ return null; }

  // Step 3: parser les sections — UploadVR utilise des <h2>/<h3> pour chaque feature
  const BASE = articleUrl.match(/^https?:\/\/[^/]+/)?.[0] || '';
  const features = parseFeatureSections(html, 'h2', BASE);
  const featuresH3 = features.length < 2 ? parseFeatureSections(html, 'h3', BASE) : [];
  const best = features.length >= featuresH3.length ? features : featuresH3;

  if (!best.length) return null;
  return { version: version || 'Horizon OS', features: best.slice(0, 10), pageLink: articleUrl };
}

async function loadChangelogLive(cat){
  if (!elChangelogLive) return;
  const feeds = (cat.feeds_changelog || []).filter(f => !f.off);
  const scraperFn = cat.id==='tesla' ? loadTeslaReleaseNotes
    : cat.id==='domotique' ? loadHAChangelog
    : cat.id==='ia'        ? loadClaudeChangelog
    : cat.id==='vr'        ? loadQuestChangelog
    : null;
  if (!feeds.length && !scraperFn){ hideChangelogLive(); return; }
  if (_clHtml){ elChangelogLive.hidden=false; elChangelogLive.innerHTML=_clHtml; return; }
  elChangelogLive.hidden = false;
  elChangelogLive.innerHTML = '<div class="cl-loading"><span class="spinner"></span> Changelog…</div>';

  const label = cat.id==='ia' ? '🤖 Dernière release Claude' : cat.id==='domotique' ? '🏠 Dernière version Home Assistant' : cat.id==='vr' ? '🥽 Dernière mise à jour Meta Quest' : '⚡ Mise à jour Tesla';

  if (scraperFn) {
    const release = await scraperFn();
    if (release) {
      const isNew = _clSeen[cat.id] !== release.version;
      if (isNew) _showClNewBadge(cat.id);
      const newBadge = isNew ? ' <span class="cl-new">NEW</span>' : '';
      const verBadge = `<span class="cl-ver">${esc(release.version)}</span>${newBadge}`;
      const sections = release.features.map(f => {
        const imgHtml = f.image ? `<img class="cl-feat-img" src="${esc(f.image)}" alt="" loading="lazy" onerror="this.remove()">` : '';
        const descHtml = f.desc ? `<p class="cl-feat-desc">${esc(f.desc)}</p>` : '';
        const icon = featureIcon(f.title);
        const href = esc(f.link || release.pageLink);
        return `<details class="rl-section cl-feat-section"><summary class="rl-sh"><span class="cl-feat-icon">${icon}</span>${esc(f.title)}</summary>
          <a class="cl-feature" href="${href}" target="_blank" rel="noopener">${imgHtml}${descHtml}<span class="cl-feat-link">🔗 Voir les détails</span></a>
        </details>`;
      }).join('');
      const detailsAttr = isNew
        ? `data-cl-cat="${cat.id}" data-cl-ver="${esc(release.version)}" ontoggle="if(this.open)_clMarkSeen(this.dataset.clCat,this.dataset.clVer,this)"`
        : '';
      const html = `<details class="rl-section" ${detailsAttr}><summary class="rl-sh">${label} ${verBadge}</summary><div class="cl-feat-list">${sections}</div></details>`;
      elChangelogLive.innerHTML = html;
      if (!isNew) _clHtml = html;
      return;
    }
  }

  // Fallback RSS (IA, Domotique, ou si Tesla scraping échoue)
  const results = await Promise.allSettled(feeds.map(f =>
    httpGet(f.url).then(xml => parseFeed(xml, f.name, null).map(it => ({...it, _lang: f.lang||'en'})))
  ));
  let items = [];
  results.forEach(r => { if (r.status === 'fulfilled') items = items.concat(r.value); });
  const seen = new Set();
  items = items.filter(it => it.link && !seen.has(it.link) && seen.add(it.link));
  items.sort((a,b) => b.ts - a.ts);
  if (!items.length){ hideChangelogLive(); return; }

  const verRe = /(\d{4}\.\d+\.\d+(?:\.\d+)?|v?\d+\.\d+\.\d+)/i;
  const firstVer = (items[0].title.match(verRe)||[])[1] || null;
  // Grouper par version si elle existe, sinon afficher toutes les entrées (mode flux d'actualités)
  const versionItems = firstVer
    ? items.filter(it => (it.title.match(verRe)||[])[1] === firstVer)
    : items.slice(0, 8);
  const rssIsNew = firstVer && _clSeen[cat.id] !== firstVer;
  if (rssIsNew) _showClNewBadge(cat.id);
  const rssNewBadge = rssIsNew ? ' <span class="cl-new">NEW</span>' : '';
  const verBadge = firstVer ? `<span class="cl-ver">${esc(firstVer)}</span>${rssNewBadge}` : '';

  // Toujours afficher en mode sous-sections (une idée par entrée, photo si disponible)
  const sections = versionItems.map(it => {
    const featTitle = it.title.replace(verRe,'').replace(/^\s*[-–·:,]\s*/,'').replace(/\s*[-–·:,]\s*$/,'').trim() || it.title;
    const imgHtml = it.image ? `<img class="cl-feat-img" src="${esc(it.image)}" alt="" loading="lazy" onerror="this.remove()">` : '';
    const bullets = clBullets(it.summary||'').slice(0,4);
    const body = bullets.length > 1
      ? `<ul class="cl-bullets">${bullets.map(b=>`<li>${esc(b)}</li>`).join('')}</ul>`
      : it.summary ? `<p class="cl-excerpt">${esc(it.summary.slice(0,280))}${it.summary.length>280?'…':''}</p>` : '';
    const dateLbl = it.date ? `<span class="cl-meta-date">🕒 ${esc(fmtDate(it.date))}</span>` : '';
    return `<details class="rl-section cl-feat-section"><summary class="rl-sh">${esc(featTitle)}</summary>
      <a class="cl-feature" href="${esc(it.link)}" target="_blank" rel="noopener">${imgHtml}${body}${dateLbl}<span class="cl-feat-link">🔗 Voir les détails</span></a>
    </details>`;
  }).join('');
  const rssDetailsAttr = rssIsNew
    ? `data-cl-cat="${cat.id}" data-cl-ver="${esc(firstVer||'')}" ontoggle="if(this.open)_clMarkSeen(this.dataset.clCat,this.dataset.clVer,this)"`
    : '';
  const html = `<details class="rl-section" ${rssDetailsAttr}><summary class="rl-sh">${label} ${verBadge}</summary><div class="cl-feat-list">${sections}</div></details>`;
  elChangelogLive.innerHTML = html;
  if (!rssIsNew) _clHtml = html;
}

function hideChangelogLive(){
  if (elChangelogLive){ elChangelogLive.hidden=true; elChangelogLive.innerHTML=''; }
  _clHtml = null;
}

/* ---------- Football Live (France + Toulouse) ---------- */
let _footLiveHtml = null, _footLiveTs = 0;
let _toulouseCache = null, _toulouseCacheTs = 0;
let _worldCupCache = null, _worldCupCacheTs = 0;

function isToulouseTeam(comp){
  const n=(comp?.team?.name||'').toLowerCase(), a=(comp?.team?.abbreviation||'').toUpperCase();
  return n.includes('toulouse') || a==='TOU';
}

// Récupère les buteurs depuis le résumé ESPN (summary endpoint)
async function fetchMatchGoals(leagueId, eventId, homeTeamId){
  try {
    const BASE='https://site.api.espn.com/apis/site/v2/sports/soccer';
    const data=await fetchJson(`${BASE}/${leagueId}/summary?event=${eventId}`);
    const plays=(data?.scoring?.plays||[]).concat(data?.plays||[]);
    return plays
      .filter(p=>/^goal/i.test(p.type?.text||''))
      .map(p=>{
        const min=p.clock?.displayValue||(p.clock?.value!=null?p.clock.value+"'":'');
        const nm=(
          (p.participants||[]).map(pt=>pt.athlete?.displayName||'').filter(Boolean)[0]||
          (p.athletes||[]).map(a=>a.displayName||'').filter(Boolean)[0]||''
        ).split(' ').slice(-1)[0];
        return {nm, min, isHome:String(p.team?.id)===String(homeTeamId)};
      }).filter(g=>g.nm);
  } catch(e){ return []; }
}

async function fetchToulouseMatches(){
  if (_toulouseCache && Date.now()-_toulouseCacheTs<5*60*1000) return _toulouseCache;
  const LIGUE_IDS=['fra.1','uefa.europa','uefa.conference'];
  const BASE='https://site.api.espn.com/apis/site/v2/sports/soccer';
  const yesterday=new Date(Date.now()-86400000);
  const yDate=yesterday.toISOString().slice(0,10).replace(/-/g,'');
  const results=await Promise.allSettled(
    LIGUE_IDS.flatMap(id=>[
      fetchJson(`${BASE}/${id}/scoreboard`).then(d=>(d.events||[]).map(e=>({...e,_lid:id}))),
      fetchJson(`${BASE}/${id}/scoreboard?dates=${yDate}`).then(d=>(d.events||[]).map(e=>({...e,_lid:id}))),
    ])
  );
  const seen=new Set();
  const raw=results.flatMap(r=>r.status==='fulfilled'?r.value:[])
    .filter(e=>(e.competitions?.[0]?.competitors||[]).some(c=>isToulouseTeam(c)))
    .filter(e=>!seen.has(e.id)&&seen.add(e.id));

  const events=await Promise.all(raw.map(async e=>{
    const comps=e.competitions?.[0]?.competitors||[];
    const home=comps.find(c=>c.homeAway==='home'), away=comps.find(c=>c.homeAway==='away');
    const state=e.competitions?.[0]?.status?.type?.state||'';
    const detail=e.competitions?.[0]?.status?.type?.shortDetail||'';
    const live=state==='in', fin=state==='post';
    const d=new Date(e.date||0);
    // Essai depuis le scoreboard d'abord, sinon fetch summary
    const sbDetails=e.competitions?.[0]?.details||[];
    let goals=sbDetails
      .filter(dv=>/^goal/i.test(dv.type?.text||''))
      .map(dv=>{
        const min=dv.clock?.displayValue||(dv.clock?.value!=null?dv.clock.value+"'":'');
        const nm=(dv.athletesInvolved?.[0]?.displayName||'').split(' ').slice(-1)[0];
        return {nm, min, isHome:String(dv.team?.id)===String(home?.team?.id)};
      });
    if (!goals.length && (live||fin))
      goals=await fetchMatchGoals(e._lid||'fra.1', e.id, home?.team?.id);
    return {
      id:'espn-tou-'+e.id,
      homeTeam:{name:home?.team?.displayName||home?.team?.name||'?'},
      awayTeam:{name:away?.team?.displayName||away?.team?.name||'?'},
      homeScore:{current:home?.score??''},
      awayScore:{current:away?.score??''},
      status:{type:live?'inprogress':fin?'finished':'notstarted', description:detail},
      startTimestamp:d.getTime()/1000,
      date:d.toISOString().slice(0,10),
      tournament:{name:e.league?.name||'Football',round:e.competitions?.[0]?.notes?.[0]?.headline||''},
      goals,
    };
  }));
  _toulouseCache=events; _toulouseCacheTs=Date.now();
  return events;
}

function renderFootMatchSection(title, events){
  const renderCard = e => {
    const st=e.status?.type, live=st==='inprogress', fin=st==='finished';
    const hs=e.homeScore?.current??'', as_=e.awayScore?.current??'';
    const hw=fin&&parseInt(hs)>parseInt(as_), aw=fin&&parseInt(as_)>parseInt(hs);
    const badge=live?'<span class="rl-live-dot"></span>':'';
    const time=live?(e.status?.description||'⏱'):'';
    const score=(live||fin)?`<b>${esc(hs)}</b><span class="rl-vs">–</span><b>${esc(as_)}</b>${time?`<span class="rl-time"> ${esc(time)}</span>`:''}`:''
    const hn2=e.homeTeam?.name||'?', an2=e.awayTeam?.name||'?';
    const matchCard=`<div class="rl-match"><span class="rl-tn ${hw?'rl-w':''}">${teamBadge(hn2)}${esc(hn2)}</span><span class="rl-sb">${badge}${score}</span><span class="rl-tn rl-tnr ${aw?'rl-w':''}">${teamBadge(an2)}${esc(an2)}</span></div>`;
    const gs=e.goals||[];
    const hg=gs.filter(g=>g.isHome).map(g=>`${g.nm} ${g.min}`).join(', ');
    const ag=gs.filter(g=>!g.isHome).map(g=>`${g.nm} ${g.min}`).join(', ');
    const scorerLine=(live||fin)&&gs.length?`<div class="rl-scorers"><span>${esc(hg)}</span><span>${esc(ag)}</span></div>`:'';
    const roundLbl=e.tournament?.round?` · ${esc(e.tournament.round)}`:'';
    const compLine=e.tournament?.name?`<div class="rl-jlbl">⚽ ${esc(e.tournament.name)}${roundLbl}</div>`:'';
    return compLine+matchCard+scorerLine;
  };
  const liveEvs=events.filter(e=>e.status?.type==='inprogress');
  const doneEvs=events.filter(e=>e.status?.type!=='inprogress');
  let html='';
  if(liveEvs.length)
    html+=`<div class="rl-section rl-live-section"><div class="rl-sh">🔴 ${esc(title)} — En direct<button class="rl-refresh-btn" onclick="manualRefreshLive()" title="Actualiser">⟳</button></div>${liveEvs.map(renderCard).join('')}</div>`;
  if(doneEvs.length)
    html+=`<details class="rl-section"><summary class="rl-sh">${esc(title)} — Résultats récents</summary>${doneEvs.map(renderCard).join('')}</details>`;
  return html;
}

async function fetchWorldCupMatches(){
  if (_worldCupCache && Date.now()-_worldCupCacheTs<5*60*1000) return _worldCupCache;
  const BASE='https://site.api.espn.com/apis/site/v2/sports/soccer';
  const WC_ID='fifa.world';
  const dates=Array.from({length:7},(_,i)=>{
    const d=new Date(Date.now()-i*86400000);
    return d.toISOString().slice(0,10).replace(/-/g,'');
  });
  const results=await Promise.allSettled(
    dates.map(dt=>fetchJson(`${BASE}/${WC_ID}/scoreboard?dates=${dt}`).then(r=>(r.events||[]).map(e=>({...e,_lid:WC_ID}))))
  );
  const seen=new Set();
  const raw=results.flatMap(r=>r.status==='fulfilled'?r.value:[])
    .filter(e=>!seen.has(e.id)&&seen.add(e.id));
  const events=await Promise.all(raw.map(async e=>{
    const comps=e.competitions?.[0]?.competitors||[];
    const home=comps.find(c=>c.homeAway==='home'),away=comps.find(c=>c.homeAway==='away');
    const state=e.competitions?.[0]?.status?.type?.state||'';
    const detail=e.competitions?.[0]?.status?.type?.shortDetail||'';
    const live=state==='in',fin=state==='post';
    const d=new Date(e.date||0);
    const sbDetails=e.competitions?.[0]?.details||[];
    let goals=sbDetails.filter(dv=>/^goal/i.test(dv.type?.text||'')).map(dv=>{
      const min=dv.clock?.displayValue||(dv.clock?.value!=null?dv.clock.value+"'":'');
      const nm=(dv.athletesInvolved?.[0]?.displayName||'').split(' ').slice(-1)[0];
      return {nm,min,isHome:String(dv.team?.id)===String(home?.team?.id)};
    });
    if (!goals.length&&(live||fin)) goals=await fetchMatchGoals(WC_ID,e.id,home?.team?.id);
    return {
      id:'espn-wc-'+e.id,
      homeTeam:{name:home?.team?.displayName||home?.team?.name||'?'},
      awayTeam:{name:away?.team?.displayName||away?.team?.name||'?'},
      homeScore:{current:home?.score??''},
      awayScore:{current:away?.score??''},
      status:{type:live?'inprogress':fin?'finished':'notstarted',description:detail},
      startTimestamp:d.getTime()/1000,
      date:d.toISOString().slice(0,10),
      tournament:{name:e.league?.name||'FIFA World Cup',round:e.competitions?.[0]?.notes?.[0]?.headline||''},
      goals,
    };
  }));
  _worldCupCache=events; _worldCupCacheTs=Date.now();
  return events;
}

async function loadFootballLive(opts={}){
  if (!elFootballLive) return;
  if (_footLiveHtml && Date.now()-_footLiveTs<5*60*1000 && !opts.liveRefresh){
    elFootballLive.hidden=false; elFootballLive.innerHTML=_footLiveHtml; return;
  }
  if (opts.liveRefresh){ _frSocCache=null; _toulouseCache=null; _worldCupCache=null; }
  const [frSoccer, toulouse, worldCup]=await Promise.all([
    fetchFranceSoccer().catch(()=>[]),
    fetchToulouseMatches().catch(()=>[]),
    fetchWorldCupMatches().catch(()=>[]),
  ]);
  const frMatches=frSoccer.filter(e=>e.status?.type==='inprogress'||e.status?.type==='finished');
  const touMatches=toulouse.filter(e=>e.status?.type==='inprogress'||e.status?.type==='finished');
  const wcMatches=worldCup
    .filter(e=>e.status?.type==='inprogress'||e.status?.type==='finished')
    .sort((a,b)=>b.startTimestamp-a.startTimestamp);
  let html='';
  if (wcMatches.length) html+=renderFootMatchSection('🌍 Coupe du Monde',wcMatches);
  if (frMatches.length) html+=renderFootMatchSection('🇫🇷 Équipe de France',frMatches);
  if (touMatches.length) html+=renderFootMatchSection('🔴 Toulouse FC',touMatches);
  elFootballLive.hidden=!html;
  elFootballLive.innerHTML=html;
  if (html){ _footLiveHtml=html; _footLiveTs=Date.now(); }
  const hasLive=[...frSoccer,...toulouse,...worldCup].some(e=>e.status?.type==='inprogress');
  if (hasLive) scheduleLiveRefresh(()=>loadFootballLive({liveRefresh:true}));
}

function hideFootballLive(){
  if (elFootballLive){ elFootballLive.hidden=true; elFootballLive.innerHTML=''; }
  _footLiveHtml=null;
  stopLiveRefresh();
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

/* ---------- Offres bancaires (placement) ---------- */
const BANKING_OFFERS = {
  updated: '2026-07-08',
  note_livrets: '⚠️ Hausse du Livret A attendue au 1er août 2026 (vers 1,70–2,00 %)',
  livrets: [
    { nom:'Livret A',  taux:'1,50 %', plafond:'22 950 €',  net:true,  note:'Garanti, disponible, défiscalisé — hausse attendue le 1er août' },
    { nom:'LDDS',      taux:'1,50 %', plafond:'12 000 €',  net:true,  note:'Même taux que le Livret A — résidents fiscaux FR' },
    { nom:'LEP',       taux:'2,50 %', plafond:'10 000 €',  net:true,  note:'Sous conditions de revenus — hausse attendue le 1er août' },
    { nom:'PEL',       taux:'2,25 %', plafond:'61 200 €',  net:false, note:'Taux brut (ouvertures 2024+) — bloqué 4 ans minimum' },
    { nom:'CEL',       taux:'1,00 %', plafond:'15 300 €',  net:false, note:'Taux brut — droit à prêt immobilier' },
  ],
  primes: [
    { banque:'Hello bank!',  offre:'Compte + Hello Prime offerte', prime:'jusqu\'à 300 €', fin:'2026-08-10', cond:'Conditions sur le site',          lien:'https://www.hellobank.fr' },
    { banque:'BNP Paribas',  offre:'Compte courant',               prime:'jusqu\'à 270 €', fin:'2026-12-31', cond:'Voir conditions sur le site',     lien:'https://mabanque.bnpparibas.com' },
    { banque:'Fortuneo',     offre:'Compte + CB (25 ans)',          prime:'jusqu\'à 250 €', fin:'2026-12-31', cond:'Mobilité bancaire neoChange',      lien:'https://www.fortuneo.fr' },
    { banque:'Monabanq',     offre:'Compte courant',                prime:'jusqu\'à 200 €', fin:'2026-12-31', cond:'80 € souscription + CB Visa Prem', lien:'https://www.monabanq.com' },
  ],
  primes_epargne: [
    { banque:'Cashbee',          offre:'Livret Cashbee Plus',    prime:'50 €',          fin:'2026-12-31', cond:'Prime parrainage + taux boosté 3 mois',     lien:'https://www.cashbee.fr' },
    { banque:'Fortuneo',         offre:'Livret Fortuneo+',       prime:'jusqu\'à 80 €', fin:'2026-12-31', cond:'Offre couplée à l\'ouverture d\'un compte', lien:'https://www.fortuneo.fr' },
    { banque:'BoursoBank',       offre:'Livret BoursoLivret',    prime:'voir site',     fin:'2026-12-31', cond:'Conditions selon offre en cours',            lien:'https://www.boursobank.com' },
    { banque:'Placement Direct', offre:'Livret bienvenue',       prime:'taux boosté',   fin:'2026-12-31', cond:'Taux préférentiel garanti 3 mois',           lien:'https://www.placementdirect.fr' },
  ],
  livrets_boostes: [
    { banque:'Distingo Bank',     taux:'voir site', duree:'boosté',  plafond:'150 000 €',  lien:'https://www.distingo.com' },
    { banque:'Zesto (Renault)',   taux:'voir site', duree:'boosté',  plafond:'100 000 €',  lien:'https://www.renaultbank.fr' },
    { banque:'Cashbee',           taux:'voir site', duree:'boosté',  plafond:'75 000 €',   lien:'https://www.cashbee.fr' },
    { banque:'Placement Direct',  taux:'voir site', duree:'boosté',  plafond:'100 000 €',  lien:'https://www.placementdirect.fr' },
    { banque:'Meilleurtaux',      taux:'voir site', duree:'boosté',  plafond:'100 000 €',  lien:'https://placement.meilleurtaux.com' },
  ],
  top_actions: [
    { nom:'Brit. American Tobacco', ticker:'BATS', pays:'🇬🇧', rendement:'~9,5 %', dividende:'2,24 £', secteur:'Tabac',     marche:'LSE',      lien:'https://www.boursorama.com/cours/1rPBATS/' },
    { nom:'Vodafone',               ticker:'VOD',  pays:'🇬🇧', rendement:'~9,0 %', dividende:'0,09 €', secteur:'Télécom',   marche:'LSE',      lien:'https://www.boursorama.com/cours/1rPVOD/' },
    { nom:'Orange',                 ticker:'ORA',  pays:'🇫🇷', rendement:'~8,5 %', dividende:'0,70 €', secteur:'Télécom',   marche:'Euronext', lien:'https://www.boursorama.com/cours/1rPORA/' },
    { nom:'Altria',                 ticker:'MO',   pays:'🇺🇸', rendement:'~8,5 %', dividende:'4,08 $', secteur:'Tabac',     marche:'NYSE',     lien:'https://www.boursorama.com/cours/1rDMO/' },
    { nom:'Rio Tinto',              ticker:'RIO',  pays:'🇦🇺', rendement:'~8,0 %', dividende:'5,84 $', secteur:'Mines',     marche:'LSE/ASX',  lien:'https://www.boursorama.com/cours/1rPRIO/' },
    { nom:'BNP Paribas',            ticker:'BNP',  pays:'🇫🇷', rendement:'~8,0 %', dividende:'4,60 €', secteur:'Banque',    marche:'Euronext', lien:'https://www.boursorama.com/cours/1rPBNP/' },
    { nom:'Enbridge',               ticker:'ENB',  pays:'🇨🇦', rendement:'~7,0 %', dividende:'3,78 CA$',secteur:'Énergie',  marche:'TSX',      lien:'https://www.boursorama.com/cours/1rDENB/' },
    { nom:'AT&T',                   ticker:'T',    pays:'🇺🇸', rendement:'~6,5 %', dividende:'1,11 $', secteur:'Télécom',   marche:'NYSE',     lien:'https://www.boursorama.com/cours/1rDT/' },
    { nom:'BASF',                   ticker:'BAS',  pays:'🇩🇪', rendement:'~6,5 %', dividende:'2,25 €', secteur:'Chimie',    marche:'XETRA',    lien:'https://www.boursorama.com/cours/1zBBAS/' },
    { nom:'Verizon',                ticker:'VZ',   pays:'🇺🇸', rendement:'~6,5 %', dividende:'2,66 $', secteur:'Télécom',   marche:'NYSE',     lien:'https://www.boursorama.com/cours/1rDVZ/' },
  ],
  brokers: [
    { nom:'Trade Republic', pays:'🇩🇪', frais_ordre:'1 €',             garde:'0 €/an', atouts:'PEA · CTO · épargne programmée · fractionnées · intérêts sur liquidités',          lien:'https://www.traderepublic.com/fr-fr' },
    { nom:'DEGIRO',         pays:'🇳🇱', frais_ordre:'0,50 € + 0,004 %', garde:'0 €/an', atouts:'30+ bourses mondiales · app mobile · ETF Core gratuits',                           lien:'https://www.degiro.fr' },
    { nom:'Bourse Direct',  pays:'🇫🇷', frais_ordre:'0,99 €',           garde:'0 €/an', atouts:'PEA · SRD · meilleur service client FR · courtier agréé AMF',                     lien:'https://www.boursedirect.fr' },
    { nom:'XTB',            pays:'🇵🇱', frais_ordre:'0 € < 100k €/mois',garde:'0 €/an', atouts:'ETF gratuits · formation · CTO · levier · démo gratuite',                          lien:'https://www.xtb.com/fr' },
    { nom:'Interactive Brokers',pays:'🇺🇸',frais_ordre:'0,35–0,65 €',  garde:'0 €/an', atouts:'150+ marchés · multi-devises · options · professionnel · intérêts liquidités 4,5 %',lien:'https://www.interactivebrokers.com' },
    { nom:'Boursorama Bourse',pays:'🇫🇷',frais_ordre:'1,99 €',          garde:'0 €/an', atouts:'PEA · SRD · intégré au compte bancaire BoursoBank · bons plans',                  lien:'https://www.boursorama.com/bourse' },
    { nom:'Saxo Banque',    pays:'🇩🇰', frais_ordre:'dès 3 €',          garde:'0 €/an', atouts:'Options · devises · CFD · gamme pro · analyse intégrée',                           lien:'https://www.home.saxo/fr-fr' },
  ],
  avantages_actionnaires: [
    { nom:'Eurotunnel',     ticker:'GET',  condition:'1 action nominative',        avantage:'30 traversées Eurotunnel gratuites par an (valeur ~900 €)',             lien:'https://www.boursorama.com/cours/1rPGET/' },
    { nom:'TotalEnergies',  ticker:'TTE',  condition:'Nominatif pur ≥ 2 ans',      avantage:'Dividende majoré +10 % (plafond 0,5 % du capital)',                     lien:'https://www.boursorama.com/cours/1rPFP/' },
    { nom:'Accor',          ticker:'AC',   condition:'Nominatif ≥ 1 an',           avantage:'Carte Accor Plus offerte — 30 % de remise dans les hôtels du groupe',   lien:'https://www.boursorama.com/cours/1rPAC/' },
    { nom:'Air France-KLM', ticker:'AF',   condition:'Nominatif pur ≥ 2 ans',      avantage:'Réduction sur billets Air France + dividende majoré +10 %',             lien:'https://www.boursorama.com/cours/1rPAF/' },
    { nom:'Renault',        ticker:'RNO',  condition:'Nominatif pur ≥ 4 ans',      avantage:'1 000 € de remise sur l\'achat d\'un véhicule neuf Renault/Dacia',      lien:'https://www.boursorama.com/cours/1rPRNO/' },
    { nom:'LVMH',           ticker:'MC',   condition:'1 action + présence AG',     avantage:'Accès AG privé · cadeaux maisons du groupe (mode, champagne…)',         lien:'https://www.boursorama.com/cours/1rPMC/' },
    { nom:'Pernod Ricard',  ticker:'RI',   condition:'1 action + présence AG',     avantage:'Coffret de spiritueux offert à l\'assemblée générale (~60 €)',           lien:'https://www.boursorama.com/cours/1rPRI/' },
    { nom:'Michelin',       ticker:'ML',   condition:'Nominatif ≥ 4 ans',          avantage:'30 % de réduction sur pneumatiques via réseau Euromaster',              lien:'https://www.boursorama.com/cours/1rPML/' },
  ],
  etf_dividendes: [
    { nom:'iShares MSCI Eur. High Dividend', ticker:'IDVY',  eligible:'PEA', rendement:'~4,5 %', ter:'0,40 %', frequence:'Trim.', isin:'IE00B0M63284', lien:'https://www.justetf.com/fr/etf-profile.html?isin=IE00B0M63284' },
    { nom:'BNP Easy MSCI Europe Dividend+',  ticker:'EDIV',  eligible:'PEA', rendement:'~4,5 %', ter:'0,30 %', frequence:'Sem.',  isin:'FR0011550185', lien:'https://www.justetf.com/fr/etf-profile.html?isin=FR0011550185' },
    { nom:'Amundi MSCI Eur. High Dividend',  ticker:'EHDV',  eligible:'PEA', rendement:'~4,0 %', ter:'0,30 %', frequence:'Sem.',  isin:'LU1681041114', lien:'https://www.justetf.com/fr/etf-profile.html?isin=LU1681041114' },
    { nom:'Lyxor MSCI Europe Value',         ticker:'LVAL',  eligible:'PEA', rendement:'~3,5 %', ter:'0,20 %', frequence:'Ann.',  isin:'LU1215454460', lien:'https://www.justetf.com/fr/etf-profile.html?isin=LU1215454460' },
    { nom:'iShares STOXX Global Select Div', ticker:'ISPA',  eligible:'CTO', rendement:'~4,5 %', ter:'0,46 %', frequence:'Trim.', isin:'DE0002635299', lien:'https://www.justetf.com/fr/etf-profile.html?isin=DE0002635299' },
    { nom:'Vanguard FTSE All-World Hi Div',  ticker:'VHYL',  eligible:'CTO', rendement:'~3,5 %', ter:'0,29 %', frequence:'Trim.', isin:'IE00B8GKDB10', lien:'https://www.justetf.com/fr/etf-profile.html?isin=IE00B8GKDB10' },
    { nom:'SPDR Global Dividend Aristocrats',ticker:'GBDV',  eligible:'CTO', rendement:'~4,0 %', ter:'0,45 %', frequence:'Trim.', isin:'IE00B9CQXS71', lien:'https://www.justetf.com/fr/etf-profile.html?isin=IE00B9CQXS71' },
    { nom:'iShares MSCI World Quality Div',  ticker:'WQDV',  eligible:'CTO', rendement:'~3,5 %', ter:'0,38 %', frequence:'Trim.', isin:'IE00BYYHSQ67', lien:'https://www.justetf.com/fr/etf-profile.html?isin=IE00BYYHSQ67' },
    { nom:'Global X SuperDividend UCITS',    ticker:'SDVD',  eligible:'CTO', rendement:'~7,0 %', ter:'0,45 %', frequence:'Mens.', isin:'IE00077FRP95', lien:'https://www.justetf.com/fr/etf-profile.html?isin=IE00077FRP95' },
    { nom:'WisdomTree Global Qual. Div Gr.', ticker:'GGRG',  eligible:'CTO', rendement:'~2,5 %', ter:'0,38 %', frequence:'Trim.', isin:'IE00BZ56RN96', lien:'https://www.justetf.com/fr/etf-profile.html?isin=IE00BZ56RN96' },
  ],
};

const BANKING_JSON_URL='https://raw.githubusercontent.com/laurentsar/flux-rss/master/www/data/banking.json';

function renderPlacementOffers(o){
  if (!o) o = BANKING_OFFERS;
  const rawDate = o.generated || o.updated || '';
  const updDate = rawDate ? new Date(rawDate).toLocaleDateString('fr-FR',{month:'long',year:'numeric'}) : '';

  const livretRows = o.livrets.map(l=>`
    <div class="bk-row">
      <span class="bk-name">${esc(l.nom)}</span>
      <span class="bk-rate ${l.net?'bk-net':''}">${esc(l.taux)}</span>
      <span class="bk-cap">${esc(l.plafond)}</span>
      <span class="bk-note">${esc(l.note)}</span>
    </div>`).join('');

  const primeRows = o.primes.map(p=>{
    const fin = new Date(p.fin+'T00:00:00').toLocaleDateString('fr-FR',{day:'numeric',month:'short',year:'numeric'});
    return `<a class="bk-row bk-link" href="${esc(p.lien)}" target="_blank" rel="noopener">
      <span class="bk-name">${esc(p.banque)}</span>
      <span class="bk-rate bk-bonus">${esc(p.prime)}</span>
      <span class="bk-cap">${esc(p.offre)}</span>
      <span class="bk-note">${esc(p.cond)} · jusqu'au ${fin}</span>
    </a>`;
  }).join('');

  const primeEpRows = (o.primes_epargne||[]).map(p=>{
    const fin = p.fin ? new Date(p.fin+'T00:00:00').toLocaleDateString('fr-FR',{day:'numeric',month:'short',year:'numeric'}) : '';
    return `<a class="bk-row bk-link" href="${esc(p.lien)}" target="_blank" rel="noopener">
      <span class="bk-name">${esc(p.banque)}</span>
      <span class="bk-rate bk-bonus">${esc(p.prime)}</span>
      <span class="bk-cap">${esc(p.offre)}</span>
      <span class="bk-note">${esc(p.cond)}${fin?' · jusqu\'au '+fin:''}</span>
    </a>`;
  }).join('');

  const boostRows = o.livrets_boostes.map(b=>`
    <a class="bk-row bk-link" href="${esc(b.lien)}" target="_blank" rel="noopener">
      <span class="bk-name">${esc(b.banque)}</span>
      <span class="bk-rate bk-net">${esc(b.taux)}</span>
      <span class="bk-cap">${esc(b.plafond)}</span>
      <span class="bk-note">Boosté ${esc(b.duree)} puis taux de base</span>
    </a>`).join('');

  const actionRows = (o.top_actions||[]).map(a=>`
    <a class="bk-row bk-link" href="${esc(a.lien)}" target="_blank" rel="noopener">
      <span class="bk-name">${a.pays||''} ${esc(a.nom)} <span class="bk-ticker">${esc(a.ticker)}</span></span>
      <span class="bk-rate bk-net">${esc(a.rendement)}</span>
      <span class="bk-cap">${esc(a.dividende)}/an</span>
      <span class="bk-note">${esc(a.secteur)}${a.marche?' · '+esc(a.marche):''}</span>
    </a>`).join('');

  const brokerRows = (o.brokers||[]).map(b=>`
    <a class="bk-row bk-link" href="${esc(b.lien)}" target="_blank" rel="noopener">
      <span class="bk-name">${b.pays||''} ${esc(b.nom)}</span>
      <span class="bk-rate bk-bonus">${esc(b.frais_ordre)}</span>
      <span class="bk-cap">${esc(b.garde)}</span>
      <span class="bk-note">${esc(b.atouts)}</span>
    </a>`).join('');

  const avRows = (o.avantages_actionnaires||[]).map(a=>`
    <a class="bk-row bk-link bk-av-row" href="${esc(a.lien)}" target="_blank" rel="noopener">
      <span class="bk-name">${esc(a.nom)} <span class="bk-ticker">${esc(a.ticker)}</span></span>
      <span class="bk-cap">${esc(a.condition)}</span>
      <span class="bk-note bk-av-span">${esc(a.avantage)}</span>
    </a>`).join('');

  const etfRows = (o.etf_dividendes||[]).map(e=>`
    <a class="bk-row bk-link" href="${esc(e.lien)}" target="_blank" rel="noopener">
      <span class="bk-name">${esc(e.nom)} <span class="bk-ticker">${esc(e.ticker)}</span></span>
      <span class="bk-rate bk-net">${esc(e.rendement)}</span>
      <span class="bk-cap">${esc(e.ter)} · ${esc(e.frequence)}</span>
      <span class="bk-note"><span class="bk-badge ${e.eligible==='PEA'?'bk-badge-pea':'bk-badge-cto'}">${esc(e.eligible)}</span> ${esc(e.isin||'')}</span>
    </a>`).join('');

  const noteHtml = (o.note || o.note_livrets) ? `<div class="bk-alert">${esc(o.note || o.note_livrets)}</div>` : '';
  const primeEpSection = primeEpRows ? `
      <div class="bk-group-lbl" style="margin-top:12px">🏦 Primes d'ouverture — comptes d'épargne</div>
      <div class="bk-header"><span>Banque</span><span>Prime</span><span>Produit</span><span>Conditions</span></div>
      ${primeEpRows}` : '';
  const actionSection = actionRows ? `
      <div class="bk-group-lbl" style="margin-top:14px">📊 Top 10 actions à dividende — Mondial <span style="font-weight:400;opacity:.6;font-size:.72rem">rendements indicatifs · ${updDate}</span></div>
      <div class="bk-header"><span>Société</span><span>Rendement</span><span>Dividende</span><span>Secteur · Marché</span></div>
      ${actionRows}
      <div class="bk-disclaimer">⚠️ Rendements indicatifs basés sur le cours actuel — varient quotidiennement. Hors fiscalité (PFU 30 % sauf PEA/PEA-PME). Retenue à la source pour actions étrangères.</div>` : '';
  const brokerSection = brokerRows ? `
      <div class="bk-group-lbl" style="margin-top:14px">🏛️ Brokers &amp; plateformes d'investissement</div>
      <div class="bk-header"><span>Broker</span><span>Frais/ordre</span><span>Garde/an</span><span>Atouts</span></div>
      ${brokerRows}` : '';
  const avSection = avRows ? `
      <div class="bk-group-lbl" style="margin-top:14px">🎖️ Avantages actionnaires</div>
      <div class="bk-header bk-av-header"><span>Société</span><span>Condition</span><span>Avantage</span></div>
      ${avRows}
      <div class="bk-disclaimer">ℹ️ Avantages soumis à conditions — consultez les sites des émetteurs. Certains nécessitent l'inscription en nominatif pur (via votre broker ou directement chez l'émetteur).</div>` : '';
  return `<details class="rl-section bk-section">
    <summary class="rl-sh">💰 Meilleures offres bancaires &amp; placement <span class="bk-upd">vérifié ${updDate}</span></summary>
    <div class="bk-body">
      ${noteHtml}
      <div class="bk-group-lbl">📈 Livrets réglementés (taux nets, garantis)</div>
      <div class="bk-header"><span>Produit</span><span>Taux</span><span>Plafond</span><span>Note</span></div>
      ${livretRows}
      <div class="bk-group-lbl" style="margin-top:12px">🎁 Primes de bienvenue — comptes courants</div>
      <div class="bk-header"><span>Banque</span><span>Prime</span><span>Offre</span><span>Conditions</span></div>
      ${primeRows}${primeEpSection}
      <div class="bk-group-lbl" style="margin-top:12px">🚀 Livrets boostés (taux temporaires)</div>
      <div class="bk-header"><span>Banque</span><span>Taux</span><span>Plafond</span><span>Durée</span></div>
      ${boostRows}${actionSection}
      ${etfRows.length ? `<div class="bk-group-lbl" style="margin-top:14px">🧩 ETF à fort dividende — PEA &amp; CTO <span style="font-weight:400;opacity:.6;font-size:.72rem">rendements indicatifs · ${updDate}</span></div>
      <div class="bk-header"><span>ETF</span><span>Rendement</span><span>TER · Fréq.</span><span>Éligibilité · ISIN</span></div>
      ${etfRows}
      <div class="bk-disclaimer">💡 ETF PEA : dividendes réinvestis automatiquement, fiscalité allégée après 5 ans. ETF CTO : distribution soumise au PFU 30 %. Rendements nets de frais ETF, bruts de fiscalité personnelle.</div>` : ''}${brokerSection}${avSection}
    </div>
  </details>`;
}

async function loadPlacementLive(){
  if (!elPlacementLive) return;
  elPlacementLive.hidden = false;
  elPlacementLive.innerHTML = renderPlacementOffers();  // fallback rapide
  let data = null;
  try{ data=await (await fetch(BANKING_JSON_URL+'?_='+Date.now(),{cache:'no-store'})).json(); }catch(e){}
  if (!data){ try{ data=await (await fetch('data/banking.json')).json(); }catch(e){} }
  if (data) elPlacementLive.innerHTML = renderPlacementOffers(data);
}

function hidePlacementLive(){
  if (!elPlacementLive) return;
  elPlacementLive.hidden = true;
  elPlacementLive.innerHTML = '';
}

async function loadCategory(cat, {silent=false}={}){
  _clHtml = null;
  _footLiveHtml = null;
  current = cat.id;
  if (!hasNews(cat) && hasPods(cat)) currentTab='pods';      // catégorie 100% podcasts (ex. Podcasts globale)
  else if (currentTab==='pods' && !hasPods(cat)) currentTab='news';
  const [a,b] = CAT_COLORS[cat.id] || ['#F26522','#A8400F'];
  document.documentElement.style.setProperty('--a',a);
  document.documentElement.style.setProperty('--b',b);
  $('#hero-sub').textContent = cat.label;
  renderSubtabs(cat);
  if (cat.id==='rugby' && currentTab==='news') loadRugbyLive(); else hideRugbyLive();
  if (cat.id==='football' && currentTab==='news') loadFootballLive(); else hideFootballLive();
  if (cat.id==='placement' && currentTab==='news') loadPlacementLive(); else hidePlacementLive();
  const _hasChangelog = cat.feeds_changelog?.length || ['tesla','domotique','ia','vr'].includes(cat.id);
  if (_hasChangelog && currentTab==='news') loadChangelogLive(cat); else hideChangelogLive();

  // cache immédiat
  const cached = JSON.parse(localStorage.getItem(cacheKey(cat.id, currentTab)) || 'null');
  if (cached?.items) { const _c=Date.now()-15*24*3600*1000; cached.items=cached.items.filter(it=>!it.ts||it.ts>=_c); }
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
  const _cutoff = Date.now() - 15*24*3600*1000;
  items = items.filter(it => it.link && !_seen.has(it.link) && _seen.add(it.link));
  items = items.filter(it => !it.ts || it.ts >= _cutoff);
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
  const yesterday=new Date(Date.now()-86400000);
  const yDate=yesterday.toISOString().slice(0,10).replace(/-/g,'');
  const results=await Promise.allSettled(
    SOCCER_IDS.flatMap(id=>[
      fetchJson(`${BASE}/${id}/scoreboard`).then(d=>(d.events||[]).map(e=>({...e,_lid:id}))),
      fetchJson(`${BASE}/${id}/scoreboard?dates=${yDate}`).then(d=>(d.events||[]).map(e=>({...e,_lid:id}))),
    ])
  );
  const seen=new Set();
  const raw=results.flatMap(r=>r.status==='fulfilled'?r.value:[])
    .filter(e=>(e.competitions?.[0]?.competitors||[]).some(c=>isFR(c)))
    .filter(e=>!seen.has(e.id)&&seen.add(e.id));
  const events=await Promise.all(raw.map(async e=>{
    const comps=e.competitions?.[0]?.competitors||[];
    const home=comps.find(c=>c.homeAway==='home'),away=comps.find(c=>c.homeAway==='away');
    const state=e.competitions?.[0]?.status?.type?.state||'';
    const detail=e.competitions?.[0]?.status?.type?.shortDetail||'';
    const live=state==='in',fin=state==='post';
    const d=new Date(e.date||0);
    const sbDetails=e.competitions?.[0]?.details||[];
    let goals=sbDetails
      .filter(dv=>/^goal/i.test(dv.type?.text||''))
      .map(dv=>{
        const min=dv.clock?.displayValue||(dv.clock?.value!=null?dv.clock.value+"'":'');
        const nm=(dv.athletesInvolved?.[0]?.displayName||'').split(' ').slice(-1)[0];
        return {nm,min,isHome:String(dv.team?.id)===String(home?.team?.id)};
      });
    if (!goals.length && (live||fin))
      goals=await fetchMatchGoals(e._lid||SOCCER_IDS[0], e.id, home?.team?.id);
    return {
      id:'espn-soc-'+e.id,
      homeTeam:{name:home?.team?.displayName||home?.team?.name||'?'},
      awayTeam:{name:away?.team?.displayName||away?.team?.name||'?'},
      homeScore:{current:home?.score??''},
      awayScore:{current:away?.score??''},
      status:{type:live?'inprogress':fin?'finished':'notstarted',description:detail},
      startTimestamp:d.getTime()/1000,
      date:d.toISOString().slice(0,10),
      tournament:{name:e.league?.name||'Football',round:e.competitions?.[0]?.notes?.[0]?.headline||''},
      sport:'football',
      goals,
    };
  }));
  _frSocCache=events; _frSocCacheTs=Date.now();
  return events;
}

function renderFranceLive(rugbyLive, soccerEvents){
  const all=[
    ...rugbyLive.map(e=>({...e,sport:'rugby'})),
    ...soccerEvents.filter(e=>e.status?.type==='inprogress'||e.status?.type==='finished'),
  ];
  if(!all.length) return '';
  const allNames=all.map(e=>`${e.homeTeam?.name||''} ${e.awayTeam?.name||''}`).join(' ');
  const hasYouthA=/u\s*\d+|under|moins\s*de|junior/i.test(allNames);
  const agLabel=hasYouthA?'🇫🇷 Équipes de France':'🇫🇷 France';
  const renderCard = e => {
    const st=e.status?.type,live=st==='inprogress',fin=st==='finished';
    const hs=e.homeScore?.current??'',as_=e.awayScore?.current??'';
    const hw=fin&&parseInt(hs)>parseInt(as_),aw=fin&&parseInt(as_)>parseInt(hs);
    const badge=live?'<span class="rl-live-dot"></span>':'';
    const time=live?(e.status?.description||'⏱'):'';
    const score=(live||fin)?`<b>${esc(hs)}</b><span class="rl-vs">–</span><b>${esc(as_)}</b>${time?`<span class="rl-time"> ${esc(time)}</span>`:''}`:''
    const icon=e.sport==='football'?'⚽ ':'🏉 ';
    const hn2=e.homeTeam?.name||'?', an2=e.awayTeam?.name||'?';
    const matchCard=`<div class="rl-match"><span class="rl-tn ${hw?'rl-w':''}">${icon}${teamBadge(hn2)}${esc(hn2)}</span><span class="rl-sb">${badge}${score}</span><span class="rl-tn rl-tnr ${aw?'rl-w':''}">${teamBadge(an2)}${esc(an2)}</span></div>`;
    const gs=e.goals||[];
    const hg=gs.filter(g=>g.isHome).map(g=>`${g.nm} ${g.min}`).join(', ');
    const ag=gs.filter(g=>!g.isHome).map(g=>`${g.nm} ${g.min}`).join(', ');
    const scorerLine=(live||fin)&&gs.length?`<div class="rl-scorers"><span>${esc(hg)}</span><span>${esc(ag)}</span></div>`:'';
    const roundLbl=e.tournament?.round?` · ${esc(e.tournament.round)}`:'';
    const compLine=e.tournament?.name?`<div class="rl-jlbl">${icon}${esc(e.tournament.name)}${roundLbl}</div>`:'';
    return compLine+matchCard+scorerLine;
  };
  const liveAll=all.filter(e=>e.status?.type==='inprogress');
  const doneAll=all.filter(e=>e.status?.type!=='inprogress');
  let html='';
  if(liveAll.length)
    html+=`<div class="rl-section rl-live-section"><div class="rl-sh">🔴 ${agLabel} en direct<button class="rl-refresh-btn" onclick="manualRefreshLive()" title="Actualiser">⟳</button></div>${liveAll.map(renderCard).join('')}</div>`;
  if(doneAll.length)
    html+=`<details class="rl-section"><summary class="rl-sh">${agLabel} — Résultats récents</summary>${doneAll.map(renderCard).join('')}</details>`;
  return html;
}

/* ---------- Agenda ---------- */
let _agendaJson = null;
let _upcomingRugby = null, _upcomingRugbyTs = 0;
let _toulouseLiveCache = null, _toulouseLiveCacheTs = 0;
let _agendaTimer = null;

async function loadToulouseLiveEvents(){
  if (_toulouseLiveCache && Date.now()-_toulouseLiveCacheTs < 30*60*1000) return _toulouseLiveCache;
  const today = new Date().toISOString().slice(0,10);
  const q = encodeURIComponent(`date_fin >= '${today}'`);
  const url = `https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/agenda-des-manifestations-culturelles-so-toulouse/records?limit=100&order_by=date_debut%20ASC&where=${q}&timezone=Europe%2FParis`;
  try {
    const data = await fetchJson(url);
    const events = (data.results || []).map((r, i) => {
      const title = r.nom_de_la_manifestation || r.titre || r.title || 'Événement';
      const startRaw = r.date_debut || '';
      const endRaw = r.date_fin || '';
      const date = startRaw.slice(0,10);
      const dateEnd = endRaw ? endRaw.slice(0,10) : undefined;
      const desc = r.descriptif_court || r.description || r.resume || '';
      const commune = r.commune || r.ville || r.nom_commune || '';
      const locRaw = r.nom_du_lieu || r.lieu_nom || r.lieu || r.adresse || commune || 'Toulouse';
      const loc = typeof locRaw === 'object' ? (locRaw.nom || String(commune) || 'Toulouse') : String(locRaw);
      const link = r.url || r.url_de_la_page_web_de_l_evenement || undefined;
      const communeStr = String(commune).toLowerCase();
      const region = /colomiers/i.test(communeStr) ? 'Colomiers'
        : communeStr ? 'Toulouse'
        : 'Toulouse';
      return {
        id: 'tls-' + (r.identifiant || r.id_manifestation || i),
        title: String(title),
        desc: String(desc),
        date,
        dateEnd: dateEnd && dateEnd !== date ? dateEnd : undefined,
        cats: ['voyage'],
        loc,
        approx: false,
        region,
        url: link || undefined,
      };
    }).filter(e => e.date && e.title);
    _toulouseLiveCache = events;
    _toulouseLiveCacheTs = Date.now();
    return events;
  } catch(e) { return []; }
}

async function loadAgendaEvents(){
  if (!_agendaJson){
    try{ _agendaJson = await (await fetch('data/events.json')).json(); }
    catch(e){ _agendaJson = {events:[]}; }
  }
  const now = Date.now();
  const horizon = Date.now() + 365*86400*1000;
  return (_agendaJson.events||[])
    .filter(ev=>{
      const end = Date.parse(ev.dateEnd || ev.date);
      const start = Date.parse(ev.date);
      return end >= now && start <= horizon;
    })
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
  const ESPN_IDS = ['270559','180659','271937','289688','17567'];
  const CLUB_IDS_UP = new Set(['270559','271937']);
  const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/rugby';
  const results = await Promise.allSettled(
    ESPN_IDS.map(id=>fetchJson(`${ESPN_BASE}/${id}/scoreboard`).then(d=>(d.events||[]).map(e=>({...e,_lid:id}))))
  );
  const seen = new Set();
  const matches = results.flatMap(r=>r.status==='fulfilled'?r.value:[])
    .filter(e=>{ const st=e.competitions?.[0]?.status?.type?.state||''; return st==='pre'; })
    .filter(e=>!seen.has(e.id)&&seen.add(e.id))
    .filter(e=>{
      if (CLUB_IDS_UP.has(e._lid)) return true;
      const comps=e.competitions?.[0]?.competitors||[];
      return comps.some(c=>/france/i.test(c.team?.displayName||c.team?.name||''));
    })
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
  const _now=Date.now();
  const _today=new Date(); _today.setHours(0,0,0,0);
  const all=[...staticEvents,...matchEvents]
    // Use end-of-day (T23:59:59 = local time) to avoid midnight-UTC vs local-time confusion
    .filter(ev=>{ const end=new Date(`${ev.dateEnd||ev.date}T23:59:59`).getTime(); return end>=_now; })
    .sort((a,b)=>eventTs(a)-eventTs(b));
  if (!all.length) return '<div class="rl-loading">Aucun événement à venir.</div>';

  const byMonth={};
  all.forEach(ev=>{
    const startD=new Date(Date.parse(ev.date));
    // Events started in a past month → group under current month to avoid archive sections
    const d=startD<_today && startD.getMonth()!==_today.getMonth() ? _today : startD;
    const key=`${d.getFullYear()}-${d.getMonth()}`;
    if (!byMonth[key]) byMonth[key]={
      label:d.toLocaleDateString('fr-FR',{month:'long',year:'numeric'}),
      events:[]
    };
    byMonth[key].events.push(ev);
  });

  return Object.values(byMonth).map((month,idx)=>{
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
      const compLine=ev.competition?`<div class="ag-comp">🏉 ${esc(ev.competition)}</div>`:'';
      return `<${Tag} class="ag-card"${linkAttr}style="--accent:${color}">
        <div class="ag-date">${esc(dateLabel)}${timeHtml}${approxHtml}</div>
        <div class="ag-body">
          ${compLine}<b>${esc(ev.title)}</b>
          ${ev.desc?`<div class="ag-desc">${esc(ev.desc)}</div>`:''}
          ${locHtml}
          <div class="ag-badges">${badges}${regionBadge}${tvHtml}</div>
        </div>
      </${Tag}>`;
    }).join('');
    return `<details class="ag-month"${idx===0?' open':''}><summary class="ag-month-lbl">${esc(month.label)} <span class="ag-chev">▾</span></summary><div class="ag-month-body">${cards}</div></details>`;
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
  const floor=Date.now()-3600000;
  const filtered=list.filter(p=>{
    // Combine date+time so "2026-07-08T08:00:00" is parsed as LOCAL time (no timezone = local per spec)
    const ts=p.time ? new Date(`${p.date}T${p.time}:00`).getTime() : new Date(`${p.date}T23:59:59`).getTime();
    return !isNaN(ts) && ts>=floor;
  });
  // Group by date+time+channel: pair generic "Rugby : Competition" with specific match titles
  const groups={};
  filtered.forEach(p=>{
    const key=`${p.date}|${p.time}|${(p.chaine||[]).join(',')}`;
    if (!groups[key]) groups[key]=[];
    groups[key].push(p);
  });
  const exclude=new Set();
  filtered.forEach(p=>{
    const key=`${p.date}|${p.time}|${(p.chaine||[]).join(',')}`;
    const grp=groups[key];
    if (grp.length>=2){
      const compEntry=grp.find(q=>q.title.includes(' : '));
      const matchEntry=grp.find(q=>!q.title.includes(' : '));
      if (compEntry && matchEntry){
        matchEntry.competition=compEntry.title.split(' : ').slice(1).join(' : ');
        exclude.add(compEntry);
      }
    } else if (p.title.includes(' : ')){
      p.competition=p.title.split(' : ').slice(1).join(' : ');
    }
  });
  const out=filtered.filter(p=>!exclude.has(p));
  _epgRugby=out; _epgRugbyTs=Date.now();
  return out;
}

/* ---------- Autres sports France (agenda) ---------- */
let _otherSportsCache=null, _otherSportsCacheTs=0;

async function fetchOtherSportsFrance(){
  if (_otherSportsCache && Date.now()-_otherSportsCacheTs<60*60*1000) return _otherSportsCache;
  const fmt=d=>d.toISOString().slice(0,10);
  const dates=Array.from({length:7},(_,i)=>fmt(new Date(Date.now()-i*86400000)));
  const SPORTS=[
    {slug:'basketball', icon:'🏀'},
    {slug:'handball',   icon:'🤾'},
    {slug:'volleyball', icon:'🏐'},
    {slug:'ice-hockey', icon:'🏒'},
  ];
  const FR=/\bfrance\b/i;
  const results=await Promise.allSettled(
    SPORTS.flatMap(s=>dates.map(date=>
      fetchJson(`https://api.sofascore.com/api/v1/sport/${s.slug}/scheduled-events/${date}`)
        .then(d=>(d.events||[])
          .filter(e=>FR.test(e.homeTeam?.name||'')||FR.test(e.awayTeam?.name||''))
          .map(e=>{
            const code=e.status?.code??-1;
            const isLive=e.status?.type==='inprogress'||(code>=1&&code<100);
            const isFin=e.status?.type==='finished'||code===100;
            return {
              id:`sofa-${s.slug}-${e.id}`,
              homeTeam:{name:e.homeTeam?.name||'?'},
              awayTeam:{name:e.awayTeam?.name||'?'},
              homeScore:{current:e.homeScore?.current??e.homeScore?.display??''},
              awayScore:{current:e.awayScore?.current??e.awayScore?.display??''},
              status:{type:isLive?'inprogress':isFin?'finished':'notstarted', description:e.status?.description||''},
              startTimestamp:e.startTimestamp||0,
              tournament:{name:e.tournament?.name||s.slug, round:e.roundInfo?.name||''},
              sportIcon:s.icon,
            };
          })
        )
    ))
  );
  const seen=new Set();
  const events=results
    .flatMap(r=>r.status==='fulfilled'?r.value:[])
    .filter(e=>(e.status.type==='inprogress'||e.status.type==='finished')&&!seen.has(e.id)&&seen.add(e.id));
  _otherSportsCache=events; _otherSportsCacheTs=Date.now();
  return events;
}

function renderOtherSportsLive(events){
  if (!events.length) return '';
  const renderCard=e=>{
    const live=e.status?.type==='inprogress', fin=e.status?.type==='finished';
    const hs=String(e.homeScore?.current??''), as_=String(e.awayScore?.current??'');
    const hw=fin&&parseInt(hs)>parseInt(as_), aw=fin&&parseInt(as_)>parseInt(hs);
    const badge=live?'<span class="rl-live-dot"></span>':'';
    const time=live?(e.status?.description||'⏱'):'';
    const score=(live||fin)?`<b>${esc(hs)}</b><span class="rl-vs">–</span><b>${esc(as_)}</b>${time?`<span class="rl-time"> ${esc(time)}</span>`:''}`:'' ;
    const icon=e.sportIcon||'🏅';
    const hn=e.homeTeam?.name||'?', an=e.awayTeam?.name||'?';
    const roundLbl=e.tournament?.round?` · ${esc(e.tournament.round)}`:'';
    const compLine=e.tournament?.name?`<div class="rl-jlbl">${icon} ${esc(e.tournament.name)}${roundLbl}</div>`:'';
    return compLine+`<div class="rl-match"><span class="rl-tn ${hw?'rl-w':''}">${icon} ${esc(hn)}</span><span class="rl-sb">${badge}${score}</span><span class="rl-tn rl-tnr ${aw?'rl-w':''}">${esc(an)}</span></div>`;
  };
  const liveEvts=events.filter(e=>e.status?.type==='inprogress');
  const doneEvts=events.filter(e=>e.status?.type!=='inprogress');
  let html='';
  if(liveEvts.length)
    html+=`<div class="rl-section rl-live-section"><div class="rl-sh">🔴 🇫🇷 France — En direct<button class="rl-refresh-btn" onclick="manualRefreshLive()" title="Actualiser">⟳</button></div>${liveEvts.map(renderCard).join('')}</div>`;
  if(doneEvts.length)
    html+=`<details class="rl-section"><summary class="rl-sh">🇫🇷 France — Résultats récents</summary>${doneEvts.map(renderCard).join('')}</details>`;
  return html;
}

async function reloadAgendaLive(){
  const agLiveEl = document.getElementById('ag-live');
  if (!agLiveEl) return;
  const slow = slowConnection();
  const [espnRugby, otherSports] = await Promise.all([
    slow ? Promise.resolve({events:[]}) : fetchSportsEvents().catch(()=>({events:[]})),
    slow ? Promise.resolve([]) : fetchOtherSportsFrance().catch(()=>[]),
  ]);
  const frRugbyLive=(espnRugby.events||[]).filter(e=>isFranceMatch(e)&&(e.status?.type==='inprogress'||e.status?.type==='finished'));
  const rugbyLiveHtml=renderFranceLive(frRugbyLive,[]);
  const otherSportsHtml=renderOtherSportsLive(otherSports);
  const liveHtml=rugbyLiveHtml+otherSportsHtml;
  agLiveEl.innerHTML=liveHtml;
  const hasLive=[...(espnRugby.events||[]),...otherSports].some(e=>e.status?.type==='inprogress');
  if (hasLive) scheduleLiveRefresh(()=>reloadAgendaLive());
}

async function loadAgenda(){
  hideChangelogLive();
  hideRugbyLive();
  elSubtabs.hidden=true; elSubtabs.innerHTML='';
  elArticles.innerHTML='<div class="rl-loading"><span class="spinner"></span>Chargement de l\'agenda…</div>';
  elStatus.textContent='';
  const slow = slowConnection();
  const [staticEvents, epgRugby, espnRugby, toulouseLive, otherSports] = await Promise.all([
    loadAgendaEvents(),
    slow ? Promise.resolve([]) : loadRugbyEpg().catch(()=>[]),
    slow ? Promise.resolve({events:[]}) : fetchSportsEvents().catch(()=>({events:[]})),
    slow ? Promise.resolve([]) : loadToulouseLiveEvents().catch(()=>[]),
    slow ? Promise.resolve([]) : fetchOtherSportsFrance().catch(()=>[]),
  ]);
  // France rugby national live/terminé (inchangé)
  const frRugbyLive=(espnRugby.events||[]).filter(e=>isFranceMatch(e)&&(e.status?.type==='inprogress'||e.status?.type==='finished'));
  const rugbyLiveHtml=renderFranceLive(frRugbyLive,[]);
  const otherSportsHtml=renderOtherSportsLive(otherSports);
  const liveHtml=rugbyLiveHtml+otherSportsHtml;
  // Rugby = grille TV réelle (EPG, toutes chaînes) ; repli sur la liste figée.
  const rugbyAgenda = epgRugby.length ? epgRugby : upcomingRugbyShows(4);
  // Fusion événements statiques + live Toulouse (dédoublonnage par titre+date)
  const seenTls = new Set(staticEvents.map(e => e.title+'|'+e.date));
  const tlsNew = toulouseLive.filter(e => !seenTls.has(e.title+'|'+e.date));
  const allStatic = [...staticEvents, ...tlsNew];
  const total=allStatic.length+rugbyAgenda.length;
  elArticles.innerHTML=(liveHtml?`<div id="ag-live">${liveHtml}</div>`:'')+renderAgenda(allStatic,rugbyAgenda);
  elStatus.textContent=`${total} événement${total>1?'s':''} à venir`;
  const hasAgendaLive=[...(espnRugby.events||[]),...otherSports].some(e=>e.status?.type==='inprogress');
  if (hasAgendaLive) scheduleLiveRefresh(()=>reloadAgendaLive());
  if (_agendaTimer) clearTimeout(_agendaTimer);
  _agendaTimer = setTimeout(()=>{ if(current==='agenda'){ _toulouseLiveCache=null; loadAgenda(); } }, 3600000);
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
  stopLiveRefresh();
  if (_agendaTimer) { clearTimeout(_agendaTimer); _agendaTimer = null; }
  localStorage.setItem('lastCat', id);
  elCats.querySelectorAll('.chip').forEach(b=>{
    const on=b.dataset.id===id;
    b.classList.toggle('active', on);
    if (on){
      const [a,b2]=CAT_COLORS[id]||['#F26522','#A8400F'];
      b.style.setProperty('--a',a); b.style.setProperty('--b',b2);
      b.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
    }
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
  // Swipe horizontal → onglet suivant/précédent
  let _txStart=null, _tyStart=null;
  document.addEventListener('touchstart', e=>{ _txStart=e.touches[0].clientX; _tyStart=e.touches[0].clientY; },{passive:true});
  document.addEventListener('touchend', e=>{
    if (_txStart===null) return;
    const dx=e.changedTouches[0].clientX-_txStart;
    const dy=e.changedTouches[0].clientY-_tyStart;
    _txStart=null; _tyStart=null;
    if (Math.abs(dx)<60||Math.abs(dy)>Math.abs(dx)*0.8) return;
    const ids=['agenda',...DATA.categories.filter(c=>!c.off).map(c=>c.id)];
    const idx=ids.indexOf(current);
    if (idx===-1) return;
    const next=ids[idx+(dx<0?1:-1)];
    if (next) selectCat(next);
  },{passive:true});

  // Pause toutes les animations CSS quand l'écran est éteint / app en arrière-plan
  document.addEventListener('visibilitychange', ()=>{
    document.body.classList.toggle('page-hidden', document.hidden);
  });
  // Vérification de mise à jour non bloquante (3 s après le démarrage)
  setTimeout(checkForUpdate, 3000);
}
init();
