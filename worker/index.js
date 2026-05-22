const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const ALLOWED_ORIGINS = [
  'https://jmorcos3.github.io',
  'https://arsenal-quad.netlify.app',
  'https://arsenal-goldendouble.netlify.app',
];
const CACHE_TTL = 120;

const SERIES = ['KXPREMIERLEAGUE', 'KXUCL'];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

async function fetchSeries(series) {
  const url = `${KALSHI_API}/markets?series_ticker=${series}&status=open&limit=100`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) return { series, markets: [], error: `HTTP ${resp.status}` };
  const data = await resp.json();
  return { series, markets: data.markets || [] };
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
    const path = url.pathname;

    // Batch endpoint - fetches all series in one call
    if (path === '/batch') {
      const cacheKey = new Request('https://cache.internal/batch-all', { method: 'GET' });
      const cache = caches.default;
      let cached = await cache.match(cacheKey);

      if (cached) {
        const body = await cached.text();
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
            'X-Cache': 'HIT',
            ...corsHeaders(origin),
          },
        });
      }

      try {
        // Fetch all series sequentially with small delays to avoid rate limits
        const results = {};
        for (let i = 0; i < SERIES.length; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, 300));
          const data = await fetchSeries(SERIES[i]);
          results[data.series] = data.markets;
        }

        const body = JSON.stringify(results);
        const cacheResp = new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
          },
        });
        await cache.put(cacheKey, cacheResp);

        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
            'X-Cache': 'MISS',
            ...corsHeaders(origin),
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    // Original single market endpoint
    if (!path.startsWith('/markets')) {
      return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
    }

    const cacheKey = new Request(`https://cache.internal${path}${url.search}`, { method: 'GET' });
    const cache = caches.default;
    let cached = await cache.match(cacheKey);

    if (cached) {
      const body = await cached.text();
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
          'X-Cache': 'HIT',
          ...corsHeaders(origin),
        },
      });
    }

    const kalshiUrl = `${KALSHI_API}${path}${url.search}`;

    try {
      const resp = await fetch(kalshiUrl, {
        headers: { 'Accept': 'application/json' },
      });

      const body = await resp.text();

      if (resp.ok) {
        const cacheResp = new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
          },
        });
        await cache.put(cacheKey, cacheResp);
      }

      return new Response(body, {
        status: resp.status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
          'X-Cache': 'MISS',
          ...corsHeaders(origin),
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  },
};
