// fetch-articles.js
// Fetches news + tech abundance + podcast RSS feeds
// Uses RSS proxy fallback for Substack feeds blocked by GitHub Actions CDN
// Runs Claude sentiment filter on tech articles (positive/innovation only)
// Explicitly keeps positive coverage of key tech leaders
// Detects guest appearances via watchedVoices
// Writes articles.json, tech.json, and podcasts.json

const fs = require('fs');
const https = require('https');
const http = require('http');

const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const MAX_ARTICLES        = 60;
const MAX_TECH_ARTICLES   = 40;
const MAX_PODCAST_LIVE    = 5;
const MAX_PODCAST_ARCHIVE = 500;
const MIN_NEW_ARTICLES    = 1;
const NEWS_TIMEOUT_MS     = 25000;
const PODCAST_TIMEOUT_MS  = 30000;

// RSS2JSON proxy — used as fallback when direct Substack fetch returns 0 items
// Free tier: 10,000 requests/day, no key needed for basic use
const RSS2JSON_BASE = 'https://api.rss2json.com/v1/api.json?rss_url=';

// ── HTTP ─────────────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = NEWS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RSS-Reader/1.0)',
        'Accept': 'application/rss+xml, application/xml, application/json, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ── PARSE HELPERS ─────────────────────────────────────────────────────────────
function parseDate(str) {
  if (!str) return new Date(0);
  const d = new Date(str);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function extractText(xml, tag) {
  const patterns = [
    new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'),
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) return m[1].replace(/<[^>]+>/g, '').trim();
  }
  return '';
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

function extractImage(itemXml) {
  let img = extractAttr(itemXml, 'media:content', 'url');
  if (!img) img = extractAttr(itemXml, 'enclosure', 'url');
  if (!img) {
    const m = itemXml.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp))[^"']*["']/i);
    if (m) img = m[1];
  }
  return (img && !img.endsWith('.mp3') && !img.endsWith('.m4a')) ? img : '';
}

function extractAudio(itemXml) {
  const u = extractAttr(itemXml, 'enclosure', 'url');
  if (u && (u.includes('.mp3') || u.includes('.m4a') || u.includes('audio'))) return u;
  return '';
}

function makeId(url) {
  return Buffer.from(url).toString('base64').slice(0, 24);
}

// ── SAFE JSON PARSE ───────────────────────────────────────────────────────────
function safeParseArray(text) {
  if (!text) return null;
  let cleaned = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('[');
  const end   = cleaned.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  const lastComplete = cleaned.lastIndexOf('},');
  if (lastComplete !== -1) {
    try { return JSON.parse(cleaned.slice(0, lastComplete + 1) + ']'); } catch {}
  }
  return null;
}

// ── NEWS RSS PARSER ───────────────────────────────────────────────────────────
function parseNewsRSS(xml, sourceName) {
  const items = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const item  = m[1];
    const title = extractText(item, 'title');
    const url   = extractText(item, 'link') || extractAttr(item, 'link', 'href');
    const date  = extractText(item, 'pubDate') || extractText(item, 'published') || extractText(item, 'dc:date');
    const image = extractImage(item);
    if (title && url && !url.includes('.mp3')) {
      items.push({
        title:  title.replace(/\s+/g, ' ').trim(),
        url:    url.trim(),
        date:   parseDate(date).toISOString(),
        image,
        source: sourceName,
        teaser: '',
        id:     makeId(url)
      });
    }
  }
  return items;
}

// ── RSS2JSON PROXY PARSER ─────────────────────────────────────────────────────
// Parses the JSON response from api.rss2json.com into our article format
function parseRss2JsonResponse(jsonText, sourceName) {
  try {
    const data = JSON.parse(jsonText);
    if (!data || data.status !== 'ok' || !Array.isArray(data.items)) return [];
    return data.items.map(item => {
      const url = item.link || item.guid || '';
      if (!url || url.includes('.mp3')) return null;
      const image = item.thumbnail || item.enclosure?.link || '';
      return {
        title:  (item.title || '').replace(/\s+/g, ' ').trim(),
        url:    url.trim(),
        date:   parseDate(item.pubDate).toISOString(),
        image:  (image && !image.endsWith('.mp3')) ? image : '',
        source: sourceName,
        teaser: '',
        id:     makeId(url)
      };
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ── FETCH WITH PROXY FALLBACK ─────────────────────────────────────────────────
// Tries direct RSS fetch first; if 0 items returned, retries via RSS2JSON proxy
async function fetchFeedWithFallback(src, timeoutMs) {
  // Direct fetch
  try {
    const xml = await httpGet(src.url, timeoutMs);
    const items = parseNewsRSS(xml, src.name);
    if (items.length > 0) return { items, method: 'direct' };
  } catch (e) {
    // direct failed — fall through to proxy
  }

  // Proxy fallback — only for substack.com feeds
  if (src.url.includes('substack.com')) {
    try {
      const proxyUrl = RSS2JSON_BASE + encodeURIComponent(src.url) + '&count=20';
      const jsonText = await httpGet(proxyUrl, timeoutMs);
      const items = parseRss2JsonResponse(jsonText, src.name);
      if (items.length > 0) return { items, method: 'proxy' };
    } catch (e) {
      // proxy also failed
    }
  }

  return { items: [], method: 'failed' };
}

// ── PODCAST RSS PARSER ────────────────────────────────────────────────────────
function parsePodcastRSS(xml, showName) {
  const episodes = [];
  let showArt = '';
  const artM = xml.match(/<itunes:image[^>]*href=["']([^"']+)["']/i)
    || xml.match(/<image>[\s\S]*?<url>([^<]+)<\/url>/i);
  if (artM) showArt = artM[1];

  const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const item     = m[1];
    const title    = extractText(item, 'title');
    const pubDate  = extractText(item, 'pubDate') || extractText(item, 'published');
    const audioUrl = extractAudio(item);
    const link     = extractText(item, 'link') || extractAttr(item, 'link', 'href');
    const duration = extractText(item, 'itunes:duration');
    const desc     = (extractText(item, 'description') || extractText(item, 'itunes:summary') || '').slice(0, 400);
    const epArt    = extractAttr(item, 'itunes:image', 'href') || showArt;

    if (title && (audioUrl || link)) {
      episodes.push({
        id:        makeId(audioUrl || link),
        show:      showName,
        title:     title.replace(/\s+/g, ' ').trim(),
        audioUrl:  audioUrl || '',
        listenUrl: link || audioUrl || '',
        date:      parseDate(pubDate).toISOString(),
        duration:  duration || '',
        image:     epArt,
        desc,
        guestTags: []
      });
    }
  }
  return episodes;
}

// ── GUEST DETECTION ───────────────────────────────────────────────────────────
function detectGuests(episodes, watchedVoices) {
  const active = (watchedVoices || []).filter(v => v.active && v.keywords && v.keywords.length);
  if (!active.length) return episodes;
  return episodes.map(ep => {
    const haystack = `${ep.title} ${ep.desc}`.toLowerCase();
    const tags = [];
    for (const voice of active) {
      for (const kw of voice.keywords) {
        if (haystack.includes(kw.toLowerCase())) {
          if (!tags.includes(voice.name)) tags.push(voice.name);
          break;
        }
      }
    }
    return { ...ep, guestTags: tags };
  });
}

// ── CLAUDE API CALL ───────────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 1024) {
  if (!ANTHROPIC_API_KEY) return null;

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  });

  const response = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.write(payload);
    req.end();
  });

  const json = JSON.parse(response);
  return json.content?.[0]?.text || null;
}

// ── TECH ABUNDANCE SENTIMENT FILTER ──────────────────────────────────────────
async function filterTechArticles(articles) {
  if (!articles.length) return [];
  if (!ANTHROPIC_API_KEY) {
    console.warn('  No API key — skipping sentiment filter, keeping all tech articles');
    return articles;
  }

  const BATCH = 25;
  const approved = [];

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);

    const prompt = `You are a curator for the "Tech Abundance" section of a news site. The editorial voice is pro-innovation, pro-builder, and relentlessly optimistic about technology.

KEEP articles that are:
- About AI breakthroughs, progress, capabilities, adoption
- About crypto/Bitcoin growth, adoption, or policy wins
- About space exploration, rockets, satellites, Mars
- About defense tech innovation (Anduril, Palantir, new weapons systems)
- About longevity, biotech, quantum computing, energy breakthroughs
- About venture capital, startup launches, funding rounds
- Positive or neutral coverage of: Elon Musk, SpaceX, Tesla, xAI, Palmer Luckey, Anduril, Alex Karp, Palantir, Joe Lonsdale, 8VC, Chamath, Marc Andreessen, a16z, David Sacks, Balaji Srinivasan, Jensen Huang, Nvidia, Peter Diamandis
- About abundance, progress, innovation, building

DROP articles that are:
- Negative, critical, or attacking tech leaders or companies
- About AI dangers, risks, or calls for regulation
- About crypto crashes, scams, or failures
- About tech layoffs, company failures, or scandals
- General doom or anti-tech sentiment

Return ONLY a valid JSON array of article IDs to KEEP. Example: ["id1","id2","id3"]
No explanation, no markdown, no other text — just the JSON array.

Articles:
${JSON.stringify(batch.map(a => ({ id: a.id, title: a.title, source: a.source })))}`;

    try {
      const result = await callClaude(prompt, 600);
      if (!result) { approved.push(...batch); continue; }
      const kept = safeParseArray(result);
      if (!kept) { console.warn(`  Tech filter: could not parse — keeping batch`); approved.push(...batch); continue; }
      const keptSet  = new Set(Array.isArray(kept) ? kept : []);
      const filtered = batch.filter(a => keptSet.has(a.id));
      console.log(`  Tech filter batch ${Math.floor(i/BATCH)+1}: ${batch.length} in → ${filtered.length} kept`);
      approved.push(...filtered);
    } catch (e) {
      console.warn(`  Tech filter error: ${e.message} — keeping batch`);
      approved.push(...batch);
    }
  }

  return approved;
}

// ── TEASER GENERATOR ──────────────────────────────────────────────────────────
async function generateTeasers(articles) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('No ANTHROPIC_API_KEY — skipping teasers');
    return articles;
  }

  const prompt = `You are a sharp news editor. For each article, write ONE sentence (under 25 words) that teases the story — intriguing, factual, no hype. Return ONLY a valid JSON array with objects containing "id" and "teaser" fields. Example: [{"id":"abc","teaser":"One sentence here."}]
No markdown, no explanation, no other text — just the JSON array.

Articles:
${JSON.stringify(articles.map(a => ({ id: a.id, title: a.title, source: a.source })))}`;

  try {
    const result = await callClaude(prompt, 1200);
    if (!result) return articles;
    const teasers = safeParseArray(result);
    if (!teasers) { console.warn('Teaser: could not parse response'); return articles; }
    const map = {};
    teasers.forEach(t => { if (t && t.id) map[t.id] = t.teaser; });
    return articles.map(a => ({ ...a, teaser: map[a.id] || '' }));
  } catch (e) {
    console.warn('Teaser error:', e.message);
    return articles;
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== GP360 fetch started:', new Date().toISOString());

  const cfg = JSON.parse(fs.readFileSync('sources.json', 'utf-8'));
  const activeNews     = (cfg.sources       || []).filter(s => s.active && s.category === 'news');
  const activeTech     = (cfg.techSources   || []).filter(s => s.active && s.url);
  const activePodcasts = (cfg.podcastSources || []).filter(s => s.active && s.url);
  const watchedVoices  = cfg.watchedVoices  || [];

  console.log(`News: ${activeNews.length} | Tech: ${activeTech.length} | Podcasts: ${activePodcasts.length} | Voices: ${watchedVoices.filter(v=>v.active).length}`);

  // Load existing data
  let existingArticles = { articles: [] };
  let existingTech     = { articles: [] };
  let existingPodcasts = { latest: [], archive: [] };
  try { existingArticles = JSON.parse(fs.readFileSync('articles.json', 'utf-8')); } catch {}
  try { existingTech     = JSON.parse(fs.readFileSync('tech.json',     'utf-8')); } catch {}
  try { existingPodcasts = JSON.parse(fs.readFileSync('podcasts.json', 'utf-8')); } catch {}

  const existingArticleIds = new Set((existingArticles.articles || []).map(a => a.id));
  const existingTechIds    = new Set((existingTech.articles     || []).map(a => a.id));

  // ── NEWS ──────────────────────────────────────────────────────────────────
  console.log('\n--- NEWS ---');
  let allArticles = [];
  for (const src of activeNews) {
    try {
      console.log(`[NEWS] ${src.name}`);
      const { items, method } = await fetchFeedWithFallback(src, NEWS_TIMEOUT_MS);
      console.log(`  ✓ ${items.length}${method === 'proxy' ? ' (proxy)' : ''}`);
      allArticles.push(...items);
    } catch (e) { console.warn(`  ✗ ${src.name}: ${e.message}`); }
  }

  const seenUrls = new Set();
  allArticles = allArticles.filter(a => {
    if (seenUrls.has(a.url)) return false;
    seenUrls.add(a.url);
    return true;
  });
  allArticles.sort((a, b) => new Date(b.date) - new Date(a.date));

  const teaserCache = {};
  (existingArticles.articles || []).forEach(a => { if (a.teaser) teaserCache[a.id] = a.teaser; });
  allArticles = allArticles.map(a => ({ ...a, teaser: teaserCache[a.id] || '' }));

  const newArticles = allArticles.filter(a => !existingArticleIds.has(a.id));
  if (newArticles.length >= MIN_NEW_ARTICLES) {
    const BATCH = 20;
    for (let i = 0; i < newArticles.length; i += BATCH) {
      const batch = newArticles.slice(i, i + BATCH);
      console.log(`Teasers batch ${Math.floor(i/BATCH)+1}: ${batch.length}`);
      const done = await generateTeasers(batch);
      done.forEach(a => { teaserCache[a.id] = a.teaser; });
    }
    allArticles = allArticles.map(a => ({ ...a, teaser: teaserCache[a.id] || '' }));
  }

  fs.writeFileSync('articles.json', JSON.stringify({
    lastUpdated:  new Date().toISOString(),
    articleCount: Math.min(allArticles.length, MAX_ARTICLES),
    articles:     allArticles.slice(0, MAX_ARTICLES)
  }, null, 2));
  console.log(`✓ articles.json: ${Math.min(allArticles.length, MAX_ARTICLES)}`);

  // ── TECH ABUNDANCE ────────────────────────────────────────────────────────
  console.log('\n--- TECH ABUNDANCE ---');
  let allTechArticles = [];
  for (const src of activeTech) {
    try {
      console.log(`[TECH] ${src.name}`);
      const { items, method } = await fetchFeedWithFallback(src, NEWS_TIMEOUT_MS);
      console.log(`  ✓ ${items.length}${method === 'proxy' ? ' (proxy)' : ''}`);
      allTechArticles.push(...items);
    } catch (e) { console.warn(`  ✗ ${src.name}: ${e.message}`); }
  }

  const seenTechUrls = new Set();
  allTechArticles = allTechArticles.filter(a => {
    if (seenTechUrls.has(a.url)) return false;
    seenTechUrls.add(a.url);
    return true;
  });
  allTechArticles.sort((a, b) => new Date(b.date) - new Date(a.date));

  const newTechArticles = allTechArticles.filter(a => !existingTechIds.has(a.id));
  console.log(`Sentiment filter: ${newTechArticles.length} new articles to evaluate...`);
  const approvedNew = await filterTechArticles(newTechArticles);
  console.log(`  ✓ ${approvedNew.length} approved after filter`);

  const approvedNewIds      = new Set(approvedNew.map(a => a.id));
  const existingApprovedIds = new Set((existingTech.articles || []).map(a => a.id));
  const finalTechArticles   = allTechArticles.filter(a =>
    approvedNewIds.has(a.id) || existingApprovedIds.has(a.id)
  );

  const techTeaserCache = {};
  (existingTech.articles || []).forEach(a => { if (a.teaser) techTeaserCache[a.id] = a.teaser; });
  const techNeedTeasers = approvedNew.filter(a => !techTeaserCache[a.id]);

  if (techNeedTeasers.length > 0) {
    const BATCH = 20;
    for (let i = 0; i < techNeedTeasers.length; i += BATCH) {
      const batch = techNeedTeasers.slice(i, i + BATCH);
      console.log(`Tech teasers batch ${Math.floor(i/BATCH)+1}: ${batch.length}`);
      const done = await generateTeasers(batch);
      done.forEach(a => { techTeaserCache[a.id] = a.teaser; });
    }
  }

  const finalTechWithTeasers = finalTechArticles
    .map(a => ({ ...a, teaser: techTeaserCache[a.id] || '' }))
    .slice(0, MAX_TECH_ARTICLES);

  fs.writeFileSync('tech.json', JSON.stringify({
    lastUpdated:  new Date().toISOString(),
    articleCount: finalTechWithTeasers.length,
    articles:     finalTechWithTeasers
  }, null, 2));
  console.log(`✓ tech.json: ${finalTechWithTeasers.length} articles`);

  // ── PODCASTS ──────────────────────────────────────────────────────────────
  console.log('\n--- PODCASTS ---');
  let allEpisodes = [];
  for (const src of activePodcasts) {
    try {
      console.log(`[POD] ${src.name}`);
      const xml = await httpGet(src.url, PODCAST_TIMEOUT_MS);
      const eps = parsePodcastRSS(xml, src.name);
      console.log(`  ✓ ${eps.length}`);
      allEpisodes.push(...eps);
    } catch (e) { console.warn(`  ✗ ${src.name}: ${e.message}`); }
  }

  console.log('Running guest detection...');
  allEpisodes = detectGuests(allEpisodes, watchedVoices);
  const taggedCount = allEpisodes.filter(e => e.guestTags.length > 0).length;
  console.log(`  ✓ ${taggedCount} episodes tagged`);

  allEpisodes.sort((a, b) => new Date(b.date) - new Date(a.date));
  const seenEpIds = new Set();
  allEpisodes = allEpisodes.filter(e => {
    if (seenEpIds.has(e.id)) return false;
    seenEpIds.add(e.id);
    return true;
  });

  const byShow = {};
  allEpisodes.forEach(e => {
    if (!byShow[e.show]) byShow[e.show] = [];
    byShow[e.show].push(e);
  });
  const latestEpisodes = [];
  Object.values(byShow).forEach(eps => latestEpisodes.push(...eps.slice(0, MAX_PODCAST_LIVE)));
  latestEpisodes.sort((a, b) => new Date(b.date) - new Date(a.date));

  const archiveMap = {};
  (existingPodcasts.archive || []).forEach(e => { archiveMap[e.id] = e; });
  allEpisodes.forEach(e => { archiveMap[e.id] = e; });
  const fullArchive = Object.values(archiveMap)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_PODCAST_ARCHIVE);

  const guestIndex = {};
  for (const ep of fullArchive) {
    for (const tag of (ep.guestTags || [])) {
      if (!guestIndex[tag]) guestIndex[tag] = [];
      guestIndex[tag].push(ep.id);
    }
  }

  fs.writeFileSync('podcasts.json', JSON.stringify({
    lastUpdated:  new Date().toISOString(),
    showCount:    activePodcasts.length,
    episodeCount: latestEpisodes.length,
    archiveCount: fullArchive.length,
    taggedCount,
    latest:       latestEpisodes,
    archive:      fullArchive,
    guestIndex
  }, null, 2));

  console.log(`✓ podcasts.json: ${latestEpisodes.length} latest, ${fullArchive.length} archived, ${taggedCount} tagged`);
  console.log('\n=== Done:', new Date().toISOString());
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
```

Commit, trigger the manual run, and screenshot the logs. You should now see lines like:
```
[TECH] Peter Diamandis / Metatrends
  ✓ 20 (proxy)
[TECH] Marc Andreessen
  ✓ 20 (proxy)
