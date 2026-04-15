#!/usr/bin/env node
/**
 * Iran Briefing — Live Feed Scraper (v1)
 *
 * Two-tier scraper:
 *   Tier 1: Telegram via t.me/s/<handle> HTML scrape (Persian channels — state, IRGC-adjacent, diaspora, grassroots)
 *   Tier 2: RSS feeds (OSINT, Persian-independent, international wires via Google News)
 *
 * Output: feed.json (200-item rolling window, URL-deduped, date-sorted, per-source cap)
 *
 * NOT in v1 (deliberate):
 *   - No reliability tagging / bucket taxonomy (removed — Murder Board flagged laundering risk)
 *   - No chain-of-custody text matching
 *   - No cross-source velocity scoring
 *   - No GDELT tier
 *   - No screenshots
 *   - No Claude API calls on this path
 *
 * Every item is tagged with:
 *   - language (en | fa | ar — hebrew regex kept in case of future addition)
 *   - schemaVersion: 3
 *   - fetchedAt (ISO timestamp of scrape)
 *   - originalPostUrl (Telegram permalink or article URL)
 *   - telegramMessageId (for Telegram items, for future chain-of-custody work)
 *   - forwarded (bool, for Telegram items)
 *   - languagePreTranslation (original language before auto-translate)
 *   - translationEngine (null or 'google-free-tier')
 *
 * Run: node scrape-feed.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG_PATH = './sources.json';
const FEED_PATH = './feed.json';
const MAX_ITEMS = 200;
const PER_SOURCE_CAP = 10;  // max items per source in final feed (MB: prevent aggregator domination)
const MAX_ITEMS_PER_SCRAPE = 15;  // max items per source per scrape cycle
const FETCH_TIMEOUT_MS = 20000;

// ============================================
// FETCH
// ============================================

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html, application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        fetch(nextUrl, options).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || FETCH_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// ============================================
// TRANSLATION (Google Translate free tier)
// Same technique as gulf-briefing. Unpublished quota — fine for normal load.
// If rate-limited, the call silently returns the original text.
// ============================================

const HAS_PERSIAN_ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const HAS_HEBREW = /[\u0590-\u05FF]/;

function needsTranslation(text) {
  if (!text) return false;
  return HAS_PERSIAN_ARABIC.test(text) || HAS_HEBREW.test(text);
}

async function translateText(text) {
  if (!text || text.length === 0) return text;
  // Google Translate's free tier has an unpublished char cap. Truncate defensively.
  const MAX_CHARS = 4800;
  const input = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(input)}`;
  try {
    const response = await fetch(url, { timeout: 10000 });
    const data = JSON.parse(response);
    if (data && data[0]) {
      return data[0].map(item => item[0]).join('');
    }
    return text;
  } catch (e) {
    return text;  // fall back to original on any failure
  }
}

// ============================================
// HTML / HEADLINE HELPERS
// ============================================

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Noise patterns — items matching these are discarded as off-topic.
// Iran-briefing scope is the war + domestic developments, not sports/weather/horoscope.
const NOISE_PATTERNS = [
  /\b(horoscope|zodiac|tarot)\b/i,
  /\b(weather forecast|temperature|humidity|rainfall)\b/i,
  /\b(premier league|la liga|serie a|bundesliga|nba|nfl|mlb|nhl|formula 1|f1|motogp|ipl|cricket)\b/i,
  /\b(recipe|cooking tips|beauty tips)\b/i,
];

function isNoise(text) {
  return NOISE_PATTERNS.some(pattern => pattern.test(text));
}

function cleanHeadline(text) {
  if (!text) return null;
  let h = stripHtml(text);
  h = h.replace(/^\d+\s*min\s*(read|listen)/i, '').trim();
  h = h.replace(/\d+\s*min\s*(read|listen)$/i, '').trim();
  if (h.length < 10 || h.length > 400) return null;
  if (isNoise(h)) return null;
  return h;
}

// ============================================
// RSS PARSER
// Unchanged from gulf-briefing pattern. Handles both RSS 2.0 and Atom.
// ============================================

function parseRSS(xml, source) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < MAX_ITEMS_PER_SCRAPE) {
    const itemXml = match[1];
    const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   itemXml.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
    const link = (itemXml.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/) ||
                  itemXml.match(/<link>(.*?)<\/link>/) ||
                  itemXml.match(/<link[^>]*href="([^"]+)"/))?.[1]?.trim();
    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim();

    const headline = cleanHeadline(title);
    if (headline && link) {
      items.push(buildFeedItem(source, {
        headline,
        url: link,
        date: pubDate ? safeDate(pubDate) : new Date().toISOString(),
      }));
    }
  }

  // Fallback: Atom format
  if (items.length === 0) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    while ((match = entryRegex.exec(xml)) !== null && items.length < MAX_ITEMS_PER_SCRAPE) {
      const entryXml = match[1];
      const title = (entryXml.match(/<title[^>]*>(.*?)<\/title>/))?.[1]?.trim();
      const link = (entryXml.match(/<link[^>]*href="([^"]+)"/))?.[1]?.trim();
      const updated = (entryXml.match(/<updated>(.*?)<\/updated>/))?.[1]?.trim();

      const headline = cleanHeadline(title);
      if (headline && link) {
        items.push(buildFeedItem(source, {
          headline,
          url: link,
          date: updated ? safeDate(updated) : new Date().toISOString(),
        }));
      }
    }
  }

  return items;
}

function safeDate(s) {
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ============================================
// TELEGRAM PARSER — new in iran-briefing
//
// Parses the server-rendered HTML preview at https://t.me/s/<handle>.
// Verified working as of 2026-04-15 on BBC Persian, Fars News, Hengaw.
// No auth, no API key, no geofencing.
//
// HTML structure (documented):
//   <div class="tgme_widget_message_wrap">
//     <div class="tgme_widget_message" data-post="channel/MSG_ID">
//       <div class="tgme_widget_message_text">POST BODY</div>
//       <div class="tgme_widget_message_footer">
//         <time datetime="ISO-8601">HH:MM</time>
//       </div>
//     </div>
//   </div>
//
// Known failure mode: Telegram could change markup or require auth at any
// time. This is the single largest operational risk in v1. Source-health
// workflow (deferred) will detect zero-item returns and open an issue.
// ============================================

function parseTelegram(html, source) {
  const items = [];

  // Split HTML into post chunks. Each chunk contains one post.
  // The actual message container has data-post attribute with "channel/msgid".
  const chunks = html.split(/<div class="tgme_widget_message_wrap/);

  for (const chunk of chunks) {
    if (items.length >= MAX_ITEMS_PER_SCRAPE) break;

    // data-post e.g. "bbcpersian/278219"
    const dataPostMatch = chunk.match(/data-post="([^"]+)"/);
    if (!dataPostMatch) continue;
    const dataPost = dataPostMatch[1];
    const [channel, msgId] = dataPost.split('/');
    if (!channel || !msgId) continue;

    // Extract post text. Look for the first tgme_widget_message_text div,
    // capturing content up to its closing tag. Text divs can have nested
    // inline elements (b, em, a, br) but not nested divs.
    const textMatch = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div|<a|<span)/);
    const textFallback = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const textHtml = textMatch ? textMatch[1] : (textFallback ? textFallback[1] : '');
    if (!textHtml) continue;

    const text = stripHtml(textHtml);
    if (text.length < 10) continue;
    if (isNoise(text)) continue;

    // Extract ISO timestamp from <time datetime="..."> in footer
    const dateMatch = chunk.match(/<time[^>]+datetime="([^"]+)"/);
    const isoDate = dateMatch ? safeDate(dateMatch[1]) : new Date().toISOString();

    // Check for forwarded marker — flag reposts for editorial awareness
    const isForwarded = /tgme_widget_message_forwarded_from/.test(chunk);

    // View count (optional, informational only)
    const viewMatch = chunk.match(/<span class="tgme_widget_message_views">([^<]+)<\/span>/);
    const views = viewMatch ? viewMatch[1].trim() : null;

    const permalink = `https://t.me/${dataPost}`;
    // Headline = first ~280 chars, single-line
    const headline = text.slice(0, 280).replace(/\s+/g, ' ').trim();

    items.push(buildFeedItem(source, {
      headline,
      url: permalink,
      date: isoDate,
      telegramMessageId: msgId,
      originalPostUrl: permalink,
      forwarded: isForwarded,
      views,
      // Full post text (beyond headline) preserved for future chain-of-custody dedup
      fullText: text,
    }));
  }

  return items;
}

// ============================================
// FEED ITEM BUILDER
// Single source of truth for schema v2.
// ============================================

function buildFeedItem(source, partial) {
  return {
    schemaVersion: 3,
    headline: partial.headline,
    url: partial.url,
    source: source.name,
    sourceId: source.id,
    priority: source.priority || 'secondary',
    language: source.language || 'en',
    languagePreTranslation: source.language || 'en',
    translationEngine: null,
    date: partial.date,
    fetchedAt: new Date().toISOString(),
    originalPostUrl: partial.originalPostUrl || partial.url,
    telegramMessageId: partial.telegramMessageId || null,
    forwarded: partial.forwarded || false,
    views: partial.views || null,
    fullText: partial.fullText || null,
  };
}

// ============================================
// SOURCE SCRAPE DISPATCH
// ============================================

async function scrapeSource(source) {
  if (source._comment) return { items: [], source };
  try {
    let items = [];
    if (source.type === 'telegram') {
      const html = await fetch(source.url);
      items = parseTelegram(html, source);
    } else if (source.type === 'rss') {
      const xml = await fetch(source.url);
      items = parseRSS(xml, source);
    } else {
      return { items: [], source, error: `Unknown type: ${source.type}` };
    }
    return { items, source };
  } catch (e) {
    return { items: [], source, error: e.message };
  }
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('Iran Briefing — Feed Scraper (v1)');
  console.log(new Date().toISOString());
  console.log('');

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const sources = config.sources.filter(s => !s._comment);

  const telegramCount = sources.filter(s => s.type === 'telegram').length;
  const rssCount = sources.filter(s => s.type === 'rss').length;
  console.log(`Scraping ${sources.length} sources (${telegramCount} Telegram, ${rssCount} RSS)...\n`);

  // Scrape all sources in parallel. Telegram channels are independent HTTP fetches
  // to t.me/s/ so no concern about shared session or rate limit across channels.
  const results = await Promise.all(sources.map(scrapeSource));

  // Flatten and report per-source results
  let allItems = [];
  const failed = [];
  for (const { items, source, error } of results) {
    if (error) {
      failed.push({ name: source.name, id: source.id, error });
      console.log(`  X  ${source.name}: ${error}`);
    } else {
      console.log(`  OK ${source.name}: ${items.length}`);
      allItems.push(...items);
    }
  }

  console.log(`\nRaw items: ${allItems.length}`);

  // ---- Translate non-English headlines (Persian, Arabic, Hebrew) ----
  let translated = 0;
  for (const item of allItems) {
    if (needsTranslation(item.headline)) {
      const preTranslation = item.headline;
      const en = await translateText(item.headline);
      if (en && en !== preTranslation) {
        item.headline = en;
        item.languagePreTranslation = item.language;
        item.translationEngine = 'google-free-tier';
        // Preserve original for UI tooltip / debugging
        item.headlineOriginal = preTranslation;
        translated++;
      }
    }
  }
  if (translated > 0) {
    console.log(`Translated ${translated} non-English headlines`);
  }

  // ---- Merge with existing feed.json (preserve history across runs) ----
  let existing = [];
  if (fs.existsSync(FEED_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(FEED_PATH, 'utf8'));
      existing = prev.items || [];
    } catch (e) {
      console.log('  (existing feed.json corrupt, starting fresh)');
    }
  }

  // Merge: new items first, then existing. Dedup by URL.
  const seen = new Set();
  const merged = [];
  for (const item of [...allItems, ...existing]) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      merged.push(item);
    }
  }

  // Sort by date (newest first)
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));

  // ---- Per-source cap (prevents any single source from drowning out others) ----
  const perSourceCount = {};
  const capped = [];
  for (const item of merged) {
    const count = perSourceCount[item.sourceId] || 0;
    if (count < PER_SOURCE_CAP) {
      capped.push(item);
      perSourceCount[item.sourceId] = count + 1;
    }
  }

  const final = capped.slice(0, MAX_ITEMS);

  // ---- Write feed.json ----
  const feed = {
    schemaVersion: 3,
    updated: new Date().toISOString(),
    itemCount: final.length,
    sourceStats: {
      scraped: sources.length,
      succeeded: sources.length - failed.length,
      failed: failed.length
    },
    failed,
    items: final
  };
  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2));

  console.log(`\nWrote feed.json: ${final.length} items (${Object.keys(perSourceCount).length} sources represented)`);
  if (failed.length > 0) {
    console.log(`\n${failed.length} sources failed:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
  }
  console.log('Done');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
