// fetch-articles.js
// GP360 — fetches news, tech abundance, podcasts
// Proxy fallback for blocked Substack feeds
// Claude sentiment filter on tech articles
// Guest detection via watchedVoices

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
const RSS2JSON_BASE       = 'https://api.rss2json.com/v1/api.json?rss_url=';
const ALLORIGINS_BASE     = 'https://api.allorigins.win/raw?url=';

function httpGet(url, timeoutMs) {
  if (!timeoutMs) timeoutMs = NEWS_TIMEOUT_MS;
  return new Promise(function(resolve, reject) {
    var lib = url.startsWith('https') ? https : http;
    var req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RSS-Reader/1.0)',
        'Accept': 'application/rss+xml, application/xml, application/json, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    }, function(res) {
      if ([301,302,303,307,308].indexOf(res.statusCode) !== -1 && res.headers.location) {
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve(data); });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, function() { req.destroy(); reject(new Error('Timeout: ' + url)); });
  });
}

function parseDate(str) {
  if (!str) return new Date(0);
  var d = new Date(str);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function extractText(xml, tag) {
  var p1 = new RegExp('<' + tag + '[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/' + tag + '>', 'i');
  var p2 = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  var m = xml.match(p1) || xml.match(p2);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

function extractAttr(xml, tag, attr) {
  var re = new RegExp('<' + tag + '[^>]*\\s' + attr + '=["\']([^"\']+)["\'][^>]*>', 'i');
  var m = xml.match(re);
  return m ? m[1] : '';
}

function extractImage(itemXml) {
  var img = extractAttr(itemXml, 'media:content', 'url');
  if (!img) img = extractAttr(itemXml, 'enclosure', 'url');
  if (!img) {
    var m = itemXml.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp))[^"']*["']/i);
    if (m) img = m[1];
  }
  if (img && !img.endsWith('.mp3') && !img.endsWith('.m4a')) return img;
  return '';
}

function extractAudio(itemXml) {
  var u = extractAttr(itemXml, 'enclosure', 'url');
  if (u && (u.indexOf('.mp3') !== -1 || u.indexOf('.m4a') !== -1 || u.indexOf('audio') !== -1)) return u;
  return '';
}

function makeId(url) {
  return Buffer.from(url).toString('base64').slice(0, 24);
}

function safeParseArray(text) {
  if (!text) return null;
  var cleaned = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch(e) {}
  var start = cleaned.indexOf('[');
  var end = cleaned.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch(e) {}
  }
  var last = cleaned.lastIndexOf('},');
  if (last !== -1) {
    try { return JSON.parse(cleaned.slice(0, last + 1) + ']'); } catch(e) {}
  }
  return null;
}

function parseNewsRSS(xml, sourceName) {
  var items = [];
  var re = /<item[\s>]([\s\S]*?)<\/item>/gi;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var item = m[1];
    var title = extractText(item, 'title');
    var url = extractText(item, 'link') || extractAttr(item, 'link', 'href');
    var date = extractText(item, 'pubDate') || extractText(item, 'published') || extractText(item, 'dc:date');
    var image = extractImage(item);
    if (title && url && url.indexOf('.mp3') === -1) {
      items.push({
        title: title.replace(/\s+/g, ' ').trim(),
        url: url.trim(),
        date: parseDate(date).toISOString(),
        image: image,
        source: sourceName,
        teaser: '',
        id: makeId(url)
      });
    }
  }
  return items;
}

function parseRss2JsonResponse(jsonText, sourceName) {
  try {
    var data = JSON.parse(jsonText);
    if (!data || data.status !== 'ok' || !Array.isArray(data.items)) return [];
    return data.items.map(function(item) {
      var url = item.link || item.guid || '';
      if (!url || url.indexOf('.mp3') !== -1) return null;
      var image = item.thumbnail || (item.enclosure && item.enclosure.link) || '';
      return {
        title: (item.title || '').replace(/\s+/g, ' ').trim(),
        url: url.trim(),
        date: parseDate(item.pubDate).toISOString(),
        image: (image && !image.endsWith('.mp3')) ? image : '',
        source: sourceName,
        teaser: '',
        id: makeId(url)
      };
    }).filter(Boolean);
  } catch(e) {
    return [];
  }
}

function isSubstack(url) {
  return url.indexOf('substack.com') !== -1;
}

async function fetchFeedWithFallback(src, timeoutMs) {
  // 1 — direct fetch
  try {
    var xml = await httpGet(src.url, timeoutMs);
    var items = parseNewsRSS(xml, src.name);
    if (items.length > 0) return { items: items, method: 'direct' };
  } catch(e) {}

  // 2 — rss2json proxy (good for Substack)
  if (isSubstack(src.url)) {
    try {
      var proxyUrl = RSS2JSON_BASE + encodeURIComponent(src.url) + '&count=20';
      var jsonText = await httpGet(proxyUrl, timeoutMs);
      var proxyItems = parseRss2JsonResponse(jsonText, src.name);
      if (proxyItems.length > 0) return { items: proxyItems, method: 'rss2json' };
    } catch(e) {}
  }

  // 3 — allorigins proxy (works for any blocked URL)
  try {
    var aoUrl = ALLORIGINS_BASE + encodeURIComponent(src.url);
    var aoXml = await httpGet(aoUrl, timeoutMs);
    var aoItems = parseNewsRSS(aoXml, src.name);
    if (aoItems.length > 0) return { items: aoItems, method: 'allorigins' };
  } catch(e) {}

  // 4 — allorigins + rss2json combo (last resort for stubborn Substack feeds)
  if (isSubstack(src.url)) {
    try {
      var comboUrl = RSS2JSON_BASE + encodeURIComponent(ALLORIGINS_BASE + encodeURIComponent(src.url)) + '&count=20';
      var comboText = await httpGet(comboUrl, timeoutMs);
      var comboItems = parseRss2JsonResponse(comboText, src.name);
      if (comboItems.length > 0) return { items: comboItems, method: 'combo' };
    } catch(e) {}
  }

  return { items: [], method: 'failed' };
}

function parsePodcastRSS(xml, showName) {
  var episodes = [];
  var showArt = '';
  var artM = xml.match(/<itunes:image[^>]*href=["']([^"']+)["']/i) ||
             xml.match(/<image>[\s\S]*?<url>([^<]+)<\/url>/i);
  if (artM) showArt = artM[1];

  var re = /<item[\s>]([\s\S]*?)<\/item>/gi;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var item = m[1];
    var title = extractText(item, 'title');
    var pubDate = extractText(item, 'pubDate') || extractText(item, 'published');
    var audioUrl = extractAudio(item);
    var link = extractText(item, 'link') || extractAttr(item, 'link', 'href');
    var duration = extractText(item, 'itunes:duration');
    var desc = (extractText(item, 'description') || extractText(item, 'itunes:summary') || '').slice(0, 400);
    var epArt = extractAttr(item, 'itunes:image', 'href') || showArt;

    if (title && (audioUrl || link)) {
      episodes.push({
        id: makeId(audioUrl || link),
        show: showName,
        title: title.replace(/\s+/g, ' ').trim(),
        audioUrl: audioUrl || '',
        listenUrl: link || audioUrl || '',
        date: parseDate(pubDate).toISOString(),
        duration: duration || '',
        image: epArt,
        desc: desc,
        guestTags: []
      });
    }
  }
  return episodes;
}

function detectGuests(episodes, watchedVoices) {
  var active = (watchedVoices || []).filter(function(v) {
    return v.active && v.keywords && v.keywords.length;
  });
  if (!active.length) return episodes;
  return episodes.map(function(ep) {
    var haystack = (ep.title + ' ' + ep.desc).toLowerCase();
    var tags = [];
    for (var i = 0; i < active.length; i++) {
      var voice = active[i];
      for (var j = 0; j < voice.keywords.length; j++) {
        if (haystack.indexOf(voice.keywords[j].toLowerCase()) !== -1) {
          if (tags.indexOf(voice.name) === -1) tags.push(voice.name);
          break;
        }
      }
    }
    return Object.assign({}, ep, { guestTags: tags });
  });
}

async function callClaude(prompt, maxTokens) {
  if (!maxTokens) maxTokens = 1024;
  if (!ANTHROPIC_API_KEY) return null;

  var payload = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  });

  var response = await new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve(data); });
    });
    req.on('error', reject);
    req.setTimeout(30000, function() { req.destroy(); reject(new Error('Claude timeout')); });
    req.write(payload);
    req.end();
  });

  var json = JSON.parse(response);
  return (json.content && json.content[0] && json.content[0].text) ? json.content[0].text : null;
}

async function filterTechArticles(articles) {
  if (!articles.length) return [];
  if (!ANTHROPIC_API_KEY) {
    console.warn('  No API key - keeping all tech articles unfiltered');
    return articles;
  }

  var BATCH = 25;
  var approved = [];

  for (var i = 0; i < articles.length; i += BATCH) {
    var batch = articles.slice(i, i + BATCH);
    var batchNum = Math.floor(i / BATCH) + 1;

    var prompt = 'You are a curator for the Tech Abundance section of a news site. ' +
      'The editorial voice is pro-innovation, pro-builder, and relentlessly optimistic about technology.\n\n' +
      'KEEP articles that are:\n' +
      '- About AI breakthroughs, progress, capabilities, adoption\n' +
      '- About crypto/Bitcoin growth, adoption, or policy wins\n' +
      '- About space exploration, rockets, satellites, Mars\n' +
      '- About defense tech innovation (Anduril, Palantir, new weapons systems)\n' +
      '- About longevity, biotech, quantum computing, energy breakthroughs\n' +
      '- About venture capital, startup launches, funding rounds\n' +
      '- Positive or neutral coverage of: Elon Musk, SpaceX, Tesla, xAI, Palmer Luckey, Anduril, ' +
      'Alex Karp, Palantir, Joe Lonsdale, 8VC, Chamath, Marc Andreessen, a16z, David Sacks, ' +
      'Balaji Srinivasan, Jensen Huang, Nvidia, Peter Diamandis\n' +
      '- About abundance, progress, innovation, building\n\n' +
      'DROP articles that are:\n' +
      '- Negative, critical, or attacking tech leaders or companies\n' +
      '- About AI dangers, risks, or calls for regulation\n' +
      '- About crypto crashes, scams, or failures\n' +
      '- About tech layoffs, company failures, or scandals\n' +
      '- General doom or anti-tech sentiment\n\n' +
      'Return ONLY a valid JSON array of article IDs to KEEP. Example: ["id1","id2","id3"]\n' +
      'No explanation, no markdown, no other text.\n\n' +
      'Articles:\n' + JSON.stringify(batch.map(function(a) {
        return { id: a.id, title: a.title, source: a.source };
      }));

    try {
      var result = await callClaude(prompt, 600);
      if (!result) { approved = approved.concat(batch); continue; }
      var kept = safeParseArray(result);
      if (!kept) {
        console.warn('  Tech filter batch ' + batchNum + ': parse failed - keeping batch');
        approved = approved.concat(batch);
        continue;
      }
      var keptSet = {};
      (Array.isArray(kept) ? kept : []).forEach(function(id) { keptSet[id] = true; });
      var filtered = batch.filter(function(a) { return keptSet[a.id]; });
      console.log('  Tech filter batch ' + batchNum + ': ' + batch.length + ' in -> ' + filtered.length + ' kept');
      approved = approved.concat(filtered);
    } catch(e) {
      console.warn('  Tech filter error: ' + e.message + ' - keeping batch');
      approved = approved.concat(batch);
    }
  }

  return approved;
}

async function generateTeasers(articles) {
  if (!ANTHROPIC_API_KEY) { console.warn('No API key - skipping teasers'); return articles; }

  var prompt = 'You are a sharp news editor. For each article, write ONE sentence under 25 words ' +
    'that teases the story - intriguing, factual, no hype. ' +
    'Return ONLY a valid JSON array with objects containing id and teaser fields. ' +
    'Example: [{"id":"abc","teaser":"One sentence here."}]\n' +
    'No markdown, no explanation, no other text.\n\n' +
    'Articles:\n' + JSON.stringify(articles.map(function(a) {
      return { id: a.id, title: a.title, source: a.source };
    }));

  try {
    var result = await callClaude(prompt, 1200);
    if (!result) return articles;
    var teasers = safeParseArray(result);
    if (!teasers) { console.warn('Teaser: could not parse response'); return articles; }
    var map = {};
    teasers.forEach(function(t) { if (t && t.id) map[t.id] = t.teaser; });
    return articles.map(function(a) { return Object.assign({}, a, { teaser: map[a.id] || '' }); });
  } catch(e) {
    console.warn('Teaser error: ' + e.message);
    return articles;
  }
}

async function main() {
  console.log('=== GP360 fetch started: ' + new Date().toISOString());

  var cfg = JSON.parse(fs.readFileSync('sources.json', 'utf-8'));
  var activeNews     = (cfg.sources        || []).filter(function(s) { return s.active && s.category === 'news'; });
  var activeTech     = (cfg.techSources    || []).filter(function(s) { return s.active && s.url; });
  var activePodcasts = (cfg.podcastSources || []).filter(function(s) { return s.active && s.url; });
  var watchedVoices  = cfg.watchedVoices   || [];

  console.log('News: ' + activeNews.length + ' | Tech: ' + activeTech.length + ' | Podcasts: ' + activePodcasts.length + ' | Voices: ' + watchedVoices.filter(function(v) { return v.active; }).length);

  var existingArticles = { articles: [] };
  var existingTech     = { articles: [] };
  var existingPodcasts = { latest: [], archive: [] };
  try { existingArticles = JSON.parse(fs.readFileSync('articles.json', 'utf-8')); } catch(e) {}
  try { existingTech     = JSON.parse(fs.readFileSync('tech.json',     'utf-8')); } catch(e) {}
  try { existingPodcasts = JSON.parse(fs.readFileSync('podcasts.json', 'utf-8')); } catch(e) {}

  var existingArticleIds = {};
  (existingArticles.articles || []).forEach(function(a) { existingArticleIds[a.id] = true; });
  var existingTechIds = {};
  (existingTech.articles || []).forEach(function(a) { existingTechIds[a.id] = true; });

  // NEWS
  console.log('\n--- NEWS ---');
  var allArticles = [];
  for (var i = 0; i < activeNews.length; i++) {
    var src = activeNews[i];
    try {
      console.log('[NEWS] ' + src.name);
      var r = await fetchFeedWithFallback(src, NEWS_TIMEOUT_MS);
      console.log('  v ' + r.items.length + (r.method !== 'direct' ? ' (' + r.method + ')' : ''));
      allArticles = allArticles.concat(r.items);
    } catch(e) { console.warn('  x ' + src.name + ': ' + e.message); }
  }

  var seenUrls = {};
  allArticles = allArticles.filter(function(a) {
    if (seenUrls[a.url]) return false;
    seenUrls[a.url] = true;
    return true;
  });
  allArticles.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });

  var teaserCache = {};
  (existingArticles.articles || []).forEach(function(a) { if (a.teaser) teaserCache[a.id] = a.teaser; });
  allArticles = allArticles.map(function(a) { return Object.assign({}, a, { teaser: teaserCache[a.id] || '' }); });

  var newArticles = allArticles.filter(function(a) { return !existingArticleIds[a.id]; });
  if (newArticles.length >= MIN_NEW_ARTICLES) {
    var NBATCH = 20;
    for (var ni = 0; ni < newArticles.length; ni += NBATCH) {
      var nbatch = newArticles.slice(ni, ni + NBATCH);
      console.log('Teasers batch ' + (Math.floor(ni / NBATCH) + 1) + ': ' + nbatch.length);
      var done = await generateTeasers(nbatch);
      done.forEach(function(a) { teaserCache[a.id] = a.teaser; });
    }
    allArticles = allArticles.map(function(a) { return Object.assign({}, a, { teaser: teaserCache[a.id] || '' }); });
  }

  fs.writeFileSync('articles.json', JSON.stringify({
    lastUpdated:  new Date().toISOString(),
    articleCount: Math.min(allArticles.length, MAX_ARTICLES),
    articles:     allArticles.slice(0, MAX_ARTICLES)
  }, null, 2));
  console.log('v articles.json: ' + Math.min(allArticles.length, MAX_ARTICLES));

  // TECH ABUNDANCE
  console.log('\n--- TECH ABUNDANCE ---');
  var allTechArticles = [];
  for (var ti = 0; ti < activeTech.length; ti++) {
    var tsrc = activeTech[ti];
    try {
      console.log('[TECH] ' + tsrc.name);
      var tr = await fetchFeedWithFallback(tsrc, NEWS_TIMEOUT_MS);
      console.log('  v ' + tr.items.length + (tr.method !== 'direct' ? ' (' + tr.method + ')' : ''));
      allTechArticles = allTechArticles.concat(tr.items);
    } catch(e) { console.warn('  x ' + tsrc.name + ': ' + e.message); }
  }

  var seenTechUrls = {};
  allTechArticles = allTechArticles.filter(function(a) {
    if (seenTechUrls[a.url]) return false;
    seenTechUrls[a.url] = true;
    return true;
  });
  allTechArticles.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });

  var newTechArticles = allTechArticles.filter(function(a) { return !existingTechIds[a.id]; });
  console.log('Sentiment filter: ' + newTechArticles.length + ' new articles to evaluate...');
  var approvedNew = await filterTechArticles(newTechArticles);
  console.log('  v ' + approvedNew.length + ' approved after filter');

  var approvedNewIds = {};
  approvedNew.forEach(function(a) { approvedNewIds[a.id] = true; });
  var existingApprovedIds = {};
  (existingTech.articles || []).forEach(function(a) { existingApprovedIds[a.id] = true; });
  var finalTechArticles = allTechArticles.filter(function(a) {
    return approvedNewIds[a.id] || existingApprovedIds[a.id];
  });

  var techTeaserCache = {};
  (existingTech.articles || []).forEach(function(a) { if (a.teaser) techTeaserCache[a.id] = a.teaser; });
  var techNeedTeasers = approvedNew.filter(function(a) { return !techTeaserCache[a.id]; });

  if (techNeedTeasers.length > 0) {
    var TBATCH = 20;
    for (var tbi = 0; tbi < techNeedTeasers.length; tbi += TBATCH) {
      var tbatch = techNeedTeasers.slice(tbi, tbi + TBATCH);
      console.log('Tech teasers batch ' + (Math.floor(tbi / TBATCH) + 1) + ': ' + tbatch.length);
      var tdone = await generateTeasers(tbatch);
      tdone.forEach(function(a) { techTeaserCache[a.id] = a.teaser; });
    }
  }

  var finalTechWithTeasers = finalTechArticles
    .map(function(a) { return Object.assign({}, a, { teaser: techTeaserCache[a.id] || '' }); })
    .slice(0, MAX_TECH_ARTICLES);

  fs.writeFileSync('tech.json', JSON.stringify({
    lastUpdated:  new Date().toISOString(),
    articleCount: finalTechWithTeasers.length,
    articles:     finalTechWithTeasers
  }, null, 2));
  console.log('v tech.json: ' + finalTechWithTeasers.length + ' articles');

  // PODCASTS
  console.log('\n--- PODCASTS ---');
  var allEpisodes = [];
  for (var pi = 0; pi < activePodcasts.length; pi++) {
    var psrc = activePodcasts[pi];
    try {
      console.log('[POD] ' + psrc.name);
      var xml = await httpGet(psrc.url, PODCAST_TIMEOUT_MS);
      var eps = parsePodcastRSS(xml, psrc.name);
      console.log('  v ' + eps.length);
      allEpisodes = allEpisodes.concat(eps);
    } catch(e) { console.warn('  x ' + psrc.name + ': ' + e.message); }
  }

  console.log('Running guest detection...');
  allEpisodes = detectGuests(allEpisodes, watchedVoices);
  var taggedCount = allEpisodes.filter(function(e) { return e.guestTags.length > 0; }).length;
  console.log('  v ' + taggedCount + ' episodes tagged');

  allEpisodes.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
  var seenEpIds = {};
  allEpisodes = allEpisodes.filter(function(e) {
    if (seenEpIds[e.id]) return false;
    seenEpIds[e.id] = true;
    return true;
  });

  var byShow = {};
  allEpisodes.forEach(function(e) {
    if (!byShow[e.show]) byShow[e.show] = [];
    byShow[e.show].push(e);
  });
  var latestEpisodes = [];
  Object.values(byShow).forEach(function(eps) {
    latestEpisodes = latestEpisodes.concat(eps.slice(0, MAX_PODCAST_LIVE));
  });
  latestEpisodes.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });

  var archiveMap = {};
  (existingPodcasts.archive || []).forEach(function(e) { archiveMap[e.id] = e; });
  allEpisodes.forEach(function(e) { archiveMap[e.id] = e; });
  var fullArchive = Object.values(archiveMap)
    .sort(function(a, b) { return new Date(b.date) - new Date(a.date); })
    .slice(0, MAX_PODCAST_ARCHIVE);

  var guestIndex = {};
  fullArchive.forEach(function(ep) {
    (ep.guestTags || []).forEach(function(tag) {
      if (!guestIndex[tag]) guestIndex[tag] = [];
      guestIndex[tag].push(ep.id);
    });
  });

  fs.writeFileSync('podcasts.json', JSON.stringify({
    lastUpdated:  new Date().toISOString(),
    showCount:    activePodcasts.length,
    episodeCount: latestEpisodes.length,
    archiveCount: fullArchive.length,
    taggedCount:  taggedCount,
    latest:       latestEpisodes,
    archive:      fullArchive,
    guestIndex:   guestIndex
  }, null, 2));

  console.log('v podcasts.json: ' + latestEpisodes.length + ' latest, ' + fullArchive.length + ' archived, ' + taggedCount + ' tagged');
  console.log('\n=== Done: ' + new Date().toISOString());
}

main().catch(function(e) { console.error('FATAL:', e); process.exit(1); });
