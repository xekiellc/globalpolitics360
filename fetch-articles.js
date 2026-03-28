// fetch-articles.js
// Fetches news RSS + podcast RSS feeds from sources.json,
// generates AI teasers via Claude API, writes articles.json and podcasts.json

const fs = require('fs');
const https = require('https');
const http = require('http');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_ARTICLES       = 60;
const MAX_PODCAST_LIVE   = 5;
const MAX_PODCAST_ARCHIVE = 200;
const MIN_NEW_ARTICLES   = 1;
const FETCH_TIMEOUT_MS   = 14000;

// ── HTTP HELPER ──────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'GlobalPolitics360-Bot/1.0 (+https://globalpolitics360.com)' }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
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

// ── PARSE HELPERS ────────────────────────────────────────────────────────────
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
    const srcMatch = itemXml.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp))[^"']*["']/i);
    if (srcMatch) img = srcMatch[1];
  }
  return (img && !img.endsWith('.mp3') && !img.endsWith('.m4a')) ? img : '';
}

function extractAudio(itemXml) {
  const encUrl = extractAttr(itemXml, 'enclosure', 'url');
  if (encUrl && (encUrl.includes('.mp3') || encUrl.includes('.m4a') || encUrl.includes('audio'))) {
    return encUrl;
  }
  return '';
}

function makeId(url) {
  return Buffer.from(url).toString('base64').slice(0, 24);
}

// ── RSS PARSER (news) ────────────────────────────────────────────────────────
function parseNewsRSS(xml, sourceName) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
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

// ── RSS PARSER (podcasts) ────────────────────────────────────────────────────
function parsePodcastRSS(xml, showName) {
  const episodes = [];

  let showArt = '';
  const artMatch = xml.match(/<itunes:image[^>]*href=["']([^"']+)["']/i)
    || xml.match(/<image>[\s\S]*?<url>([^<]+)<\/url>/i);
  if (artMatch) showArt = artMatch[1];

  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title    = extractText(item, 'title');
    const pubDate  = extractText(item, 'pubDate') || extractText(item, 'published');
    const audioUrl = extractAudio(item);
    const link     = extractText(item, 'link') || extractAttr(item, 'link', 'href');
    const duration = extractText(item, 'itunes:duration');
    const desc     = extractText(item, 'description') || extractText(item, 'itunes:summary') || '';
    let epArt = extractAttr(item, 'itunes:image', 'href') || showArt;

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
        desc:      desc.slice(0, 300).trim(),
      });
    }
  }
  return episodes;
}

// ── CLAUDE TEASER GENERATOR ──────────────────────────────────────────────────
async function generateTeasers(articles) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('No ANTHROPIC_API_KEY — skipping teasers');
    return articles;
  }
  const payload = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a sharp news editor. For each article, write ONE sentence (under 25 words) that teases the story — intriguing, factual, no hype. Return ONLY a JSON array with fields "id" and "teaser". No other text, no markdown.

Articles:
${JSON.stringify(articles.map(a => ({ id: a.id, title: a.title, source: a.source })))}`
    }]
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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Claude API timeout')); });
    req.write(payload);
    req.end();
  });

  const json = JSON.parse(response);
  const text = json.content?.[0]?.text || '[]';
  let teasers = [];
  try {
    teasers = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.warn('Teaser parse error:', e.message);
    return articles;
  }
  const map = {};
  teasers.forEach(t => { if (t.id) map[t.id] = t.teaser; });
  return articles.map(a => ({ ...a, teaser: map[a.id] || '' }));
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== GP360 fetch started:', new Date().toISOString());

  const { sources, podcastSources = [] } = JSON.parse(fs.readFileSync('sources.json', 'utf-8'));
  const activeNews     = sources.filter(s => s.active && s.category === 'news');
  const activePodcasts = podcastSources.filter(s => s.active && s.url);

  console.log(`News sources: ${activeNews.length} | Podcast sources: ${activePodcasts.length}`);

  let existingArticles = { articles: [], lastUpdated: null };
  let existingPodcasts = { latest: [], archive: [], lastUpdated: null };
  try { existingArticles = JSON.parse(fs.readFileSync('articles.json', 'utf-8')); } catch {}
  try { existingPodcasts = JSON.parse(fs.readFileSync('podcasts.json', 'utf-8')); } catch {}

  const existingArticleIds = new Set((existingArticles.articles || []).map(a => a.id));

  // ── Fetch NEWS ──
  let allArticles = [];
  for (const src of activeNews) {
    try {
      console.log(`[NEWS] Fetching: ${src.name}`);
      const xml = await httpGet(src.url);
      allArticles.push(...parseNewsRSS(xml, src.name));
      console.log(`  ✓ parsed`);
    } catch (e) {
      console.warn(`  ✗ ${src.name}: ${e.message}`);
    }
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
      console.log(`Generating teasers: batch ${Math.floor(i/BATCH)+1} (${batch.length})`);
      const withTeasers = await generateTeasers(batch);
      withTeasers.forEach(a => { teaserCache[a.id] = a.teaser; });
    }
    allArticles = allArticles.map(a => ({ ...a, teaser: teaserCache[a.id] || '' }));
  }

  fs.writeFileSync('articles.json', JSON.stringify({
    lastUpdated: new Date().toISOString(),
    articleCount: Math.min(allArticles.length, MAX_ARTICLES),
    articles: allArticles.slice(0, MAX_ARTICLES)
  }, null, 2));
  console.log(`✓ articles.json: ${Math.min(allArticles.length, MAX_ARTICLES)} articles`);

  // ── Fetch PODCASTS ──
  let allEpisodes = [];
  for (const src of activePodcasts) {
    try {
      console.log(`[POD] Fetching: ${src.name}`);
      const xml = await httpGet(src.url);
      const eps = parsePodcastRSS(xml, src.name);
      console.log(`  ✓ ${eps.length} episodes`);
      allEpisodes.push(...eps);
    } catch (e) {
      console.warn(`  ✗ ${src.name}: ${e.message}`);
    }
  }

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
  Object.values(byShow).forEach(eps => {
    latestEpisodes.push(...eps.slice(0, MAX_PODCAST_LIVE));
  });
  latestEpisodes.sort((a, b) => new Date(b.date) - new Date(a.date));

  const archiveMap = {};
  (existingPodcasts.archive || []).forEach(e => { archiveMap[e.id] = e; });
  allEpisodes.forEach(e => { archiveMap[e.id] = e; });
  const fullArchive = Object.values(archiveMap)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_PODCAST_ARCHIVE);

  fs.writeFileSync('podcasts.json', JSON.stringify({
    lastUpdated: new Date().toISOString(),
    showCount: activePodcasts.length,
    episodeCount: latestEpisodes.length,
    latest: latestEpisodes,
    archive: fullArchive
  }, null, 2));
  console.log(`✓ podcasts.json: ${latestEpisodes.length} latest, ${fullArchive.length} archived`);
  console.log('=== Done:', new Date().toISOString());
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
