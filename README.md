# Iran Briefing

Iran war coverage live feed for reporters and editors covering Iran.

**Status: v1 prototype. Pre-editorial review. Do not share URL externally or cite content in published work.**

## What this is

A single live feed page that aggregates:
- **Persian Telegram** (via public `t.me/s/<handle>` previews) — Iranian state, IRGC-adjacent, diaspora, grassroots
- **OSINT** — NetBlocks, HRANA, IranWire, IHRNGO, CHRI, Filterwatch
- **Persian independent** — Radio Zamaneh, Kayhan London
- **Wires** — Reuters / AP / Bloomberg / BBC Middle East via Google News queries

Filterable by language (All / FA / EN) and source type (All / Telegram / RSS). Persian headlines auto-translated via Google Translate free tier; originals preserved as tooltips.

## What this is NOT

- Not verified. Raw aggregation from Iranian state, IRGC-adjacent, diaspora, OSINT, and wires. Editors must treat every Telegram-sourced item as unverified until checked against a primary source.
- Not synthesis. No Claude API calls on the feed path. Narrative briefing deferred to Phase 2.
- Not real-time. Scrape cadence is ~5 min via GitHub Actions, best-effort. UI shows actual last-refresh time ("Updated Xm ago"), never a misleading "LIVE" label.
- Not editorially reviewed. Source list is pre-review. `reviewed: false` on every source and on the file metadata.
- Not scoped to Israeli press or war-theater breadth. This is specifically Iranian-channel + Iran-focused OSINT + Iran-filtered wires. Israeli coverage lives elsewhere.

## Architecture

```
  sources.json  ──┐
                  ├──►  scrape-feed.js  ──►  feed.json  ──►  feed.html  (browser)
  t.me/s/ + RSS ──┘            │
                               ▼
                        Google Translate
                          (free tier)
```

- `scrape-feed.js` — Node stdlib only. No Playwright, no deps. ~5 min runtime.
- `feed.json` — Rolling 200-item schema-v2 JSON. URL-deduped, date-sorted, per-source capped at 10.
- `feed.html` — Static page, client-side filter/render. Polls `feed.json` every 60s.
- `.github/workflows/feed.yml` — `*/5 * * * *` cron, commits updated `feed.json` back to main.

## Deferred to Phase 1.5 / 2

- Chain-of-custody text matching (MinHash/shingle on pre-translation text) to detect cross-source reposts
- Reliability tagging (cut from v1 after Murder Board flagged laundering risk; revisit only if CoC matching lands)
- Daily 7am ET narrative briefing (Claude writer, separate workflow)
- Source-health workflow (hourly check, open GitHub issue if source returns 0 items for 3+ hours)
- Screenshot layer (IRNA/Fars/Khamenei.ir/President.ir homepages) — daily only, not 5-min
- Editorial review of source list

## Running locally

```bash
cd ~/Downloads/iran-briefing
node scrape-feed.js              # generates feed.json
python3 -m http.server 8080      # serve feed.html
# open http://localhost:8080/feed.html
```

## Keys to maintain

- **Telegram markup stability.** `t.me/s/` is an undocumented public surface. If Telegram changes the HTML or adds auth, Persian layer breaks silently. The source-health workflow (when built) will detect zero-item returns.
- **Google Translate rate limits.** Free tier, unpublished quota. On Persian-heavy days we may see truncated translations. No paid fallback in v1 — budget this if Persian accuracy becomes load-bearing.
- **Source URL drift.** Several OSINT/Israeli RSS URLs are best-guess and may need correction at first run. Check `feed.json.failed[]` after first scrape and fix URLs in `sources.json`.

## Editorial guardrails (baked into UI)

1. `LIVE` label banned. Header shows actual "Updated Xm ago" with color-coded freshness (green <7m, amber <20m, red >=20m).
2. Aggregation-only banner persistent at top. Reminds editors these items are not verified.
3. Forwarded indicator (↻) on Telegram reposts, so editors can see when an item is a repost from another channel.
4. Original pre-translation text preserved as hover tooltip on translated headlines.
5. No cross-source velocity signals, no "corroborated" badges, no reliability bucket chips — Murder Board identified these as laundering vectors for IRGC disinfo. Kept out of v1.
6. Every source in `sources.json` carries `notes` and `reviewed: false` fields.
