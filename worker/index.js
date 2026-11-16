const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const ALLOWED_ORIGINS = [
  'https://jmorcos3.github.io',
  'https://arsenal-quad.netlify.app',
  'https://arsenal-goldendouble.netlify.app',
];

// A batch younger than this is served as-is.
const CACHE_TTL = 120;
// An explicit refresh may bypass the cache, but not more often than this — the
// button must not become a way to hammer Kalshi from a single tab.
const MIN_REFETCH_AGE = 15;
// How long a batch is kept as a fallback for when Kalshi cannot be read.
const STALE_TTL = 3600;

// The Carabao Cup is not here: Arsenal are out, and the page prices it at zero
// without asking.
const SERIES = ['KXPREMIERLEAGUE', 'KXUCL', 'KXFACUP', 'KXBALLONDOR'];

// The only fields the page reads. Kalshi sends about 1.8KB per market; this is
// about a tenth of that.
const KEEP = ['ticker', 'event_ticker', 'yes_sub_title', 'yes_bid_dollars', 'yes_ask_dollars', 'close_time'];

const RETRIES = 3;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    // The allowed origin differs per caller, so a shared cache must not reuse
    // one caller's answer for another.
    'Vary': 'Origin',
  };
}

function json(body, status, origin, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...extra, ...corsHeaders(origin) },
  });
}

// Age of a cached batch body, from the stamp the fetch path writes into it.
// A body with no stamp reads as infinitely old, so it is always refreshed.
function ageSeconds(body) {
  try {
    const stamp = Date.parse(JSON.parse(body).fetchedAt);
    return Number.isNaN(stamp) ? Infinity : (Date.now() - stamp) / 1000;
  } catch {
    return Infinity;
  }
}

// One series' open markets, trimmed. Throws rather than returning an empty
// list: an empty list is indistinguishable from "no markets", and caching one
// blanked a competition on the page for two minutes whenever Kalshi throttled.
async function fetchSeries(series) {
  const url = `${KALSHI_API}/markets?series_ticker=${series}&status=open&limit=200`;
  let failure = 'no attempt made';
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data.markets)) {
        return data.markets.map(m => Object.fromEntries(KEEP.filter(k => k in m).map(k => [k, m[k]])));
      }
      // Kalshi also reports throttling as a 200 carrying an error body.
      failure = (data.error && data.error.code) || 'unexpected body';
    } else {
      failure = `HTTP ${resp.status}`;
      // Only throttling and upstream trouble are worth another try.
      if (resp.status !== 429 && resp.status < 500) break;
    }
  }
  throw new Error(`${series}: ${failure}`);
}

async function fetchBatch() {
  const results = { fetchedAt: new Date().toISOString() };
  for (let i = 0; i < SERIES.length; i++) {
    // Spaced out: back-to-back requests trip Kalshi's rate limiter.
    if (i > 0) await sleep(300);
    results[SERIES[i]] = await fetchSeries(SERIES[i]);
  }
  return JSON.stringify(results);
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/batch') {
      return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
    }

    const cacheKey = new Request('https://cache.internal/batch-all', { method: 'GET' });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    const cachedBody = cached ? await cached.text() : null;
    const age = cachedBody ? ageSeconds(cachedBody) : Infinity;
    // ?fresh=1 is the page saying a person pressed Refresh, so re-read Kalshi
    // rather than replaying a body that can be two minutes old.
    const wantsFresh = url.searchParams.get('fresh') === '1';
    const browserCache = { 'Cache-Control': `public, max-age=${CACHE_TTL}` };

    if (cachedBody && age < (wantsFresh ? MIN_REFETCH_AGE : CACHE_TTL)) {
      return json(cachedBody, 200, origin, { ...browserCache, 'X-Cache': 'HIT' });
    }

    try {
      const body = await fetchBatch();
      await cache.put(cacheKey, new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${STALE_TTL}` },
      }));
      return json(body, 200, origin, { ...browserCache, 'X-Cache': 'MISS' });
    } catch (err) {
      // Kalshi unreadable. Older prices beat none: the body carries its own
      // fetchedAt, so the page shows how old they are.
      if (cachedBody) {
        return json(cachedBody, 200, origin, { 'Cache-Control': 'no-store', 'X-Cache': 'STALE' });
      }
      return json(JSON.stringify({ error: err.message }), 502, origin);
    }
  },
};
