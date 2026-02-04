const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const ALLOWED_ORIGINS = [
  'https://jmorcos3.github.io',
  'https://arsenal-quad.netlify.app',
];
const CACHE_TTL = 120; // cache responses for 2 minutes

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Only allow GET
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Only proxy /markets endpoint
    if (!path.startsWith('/markets')) {
      return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
    }

    // Check Cloudflare cache first (origin-independent cache key)
    const cacheKey = new Request(`https://cache.internal${path}${url.search}`, { method: 'GET' });
    const cache = caches.default;
    let cached = await cache.match(cacheKey);

    if (cached) {
      // Serve from cache but fix CORS header for this origin
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

    // Forward to Kalshi API
    const kalshiUrl = `${KALSHI_API}${path}${url.search}`;

    try {
      const resp = await fetch(kalshiUrl, {
        headers: { 'Accept': 'application/json' },
      });

      const body = await resp.text();

      // Only cache successful responses
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
