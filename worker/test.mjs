// Offline checks for the Worker: run with `node worker/test.mjs`. No network.
// The cache and Kalshi are both stubbed, so this exercises only the Worker's own rules.
import worker from './index.js';
let store = null, puts = 0, calls = 0, mode = 'ok', failFirst = 0;
globalThis.caches = { default: {
  async match() { return store ? new Response(store) : undefined; },
  async put(_k, resp) { puts++; store = await resp.clone().text(); },
}};
const big = { ticker: 'KXPREMIERLEAGUE-27-ARS', event_ticker: 'KXPREMIERLEAGUE-27', yes_sub_title: 'Arsenal',
  yes_bid_dollars: '0.7600', yes_ask_dollars: '0.7700', close_time: '2027-06-13T21:00:00Z',
  rules_primary: 'x'.repeat(900), title: 'Will Arsenal win?', volume_fp: '1', open_interest_fp: '2', yes_bid: null };
globalThis.fetch = async (url) => {
  calls++;
  if (mode === '429' || (mode === 'flaky' && failFirst-- > 0)) return new Response('slow down', { status: 429 });
  if (mode === 'errbody') return new Response(JSON.stringify({ error: { code: 'too_many_requests' } }), { status: 200 });
  if (mode === '404') return new Response('nope', { status: 404 });
  return new Response(JSON.stringify({ markets: [big] }), { status: 200 });
};
const call = (path = '/batch', origin = 'https://jmorcos3.github.io') =>
  worker.fetch(new Request('https://w.dev' + path, { headers: { Origin: origin } }));
const age = secs => { const b = JSON.parse(store); b.fetchedAt = new Date(Date.now() - secs * 1000).toISOString(); store = JSON.stringify(b); };
const ok = (name, cond, detail = '') => {
  if (!cond) process.exitCode = 1;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  | ' + detail : ''));
};

let r = await call(), body = await r.json();
ok('cold read hits Kalshi once per series', r.headers.get('X-Cache') === 'MISS' && calls === 4, `calls=${calls}`);
ok('Carabao no longer fetched, 4 series returned', !('KXEFLCUP' in body) && Object.keys(body).length === 5, Object.keys(body).join(','));
ok('markets trimmed to the six fields', Object.keys(body.KXPREMIERLEAGUE[0]).length === 6, `${JSON.stringify(body.KXPREMIERLEAGUE[0]).length}B vs ${JSON.stringify(big).length}B raw`);
ok('body is stamped', !Number.isNaN(Date.parse(body.fetchedAt)));
calls = 0; r = await call();
ok('repeat is a cache hit', r.headers.get('X-Cache') === 'HIT' && calls === 0);
r = await call('/batch?fresh=1');
ok('fresh inside 15s is throttled to the cache', r.headers.get('X-Cache') === 'HIT' && calls === 0);
age(30); r = await call('/batch?fresh=1');
ok('fresh on a 30s-old body re-reads Kalshi', r.headers.get('X-Cache') === 'MISS' && calls === 4);
age(200); calls = 0; r = await call();
ok('plain request refreshes after the 120s TTL', r.headers.get('X-Cache') === 'MISS' && calls === 4);

mode = 'flaky'; failFirst = 1; age(200); calls = 0; r = await call(); body = await r.json();
ok('one 429 is retried, not cached as empty', r.headers.get('X-Cache') === 'MISS' && body.KXPREMIERLEAGUE.length === 1 && calls === 5, `calls=${calls}`);

mode = '429'; age(200); const before = store, putsBefore = puts; r = await call(); body = await r.json();
ok('Kalshi down + old cache: stale prices served, 200', r.status === 200 && r.headers.get('X-Cache') === 'STALE' && body.KXPREMIERLEAGUE.length === 1);
ok('...and the failure is not written to the cache', store === before && puts === putsBefore);
mode = 'errbody'; r = await call();
ok('200-with-error-body counts as a failure', r.headers.get('X-Cache') === 'STALE');
store = null; mode = '429'; r = await call(); body = await r.json();
ok('Kalshi down + no cache: 502 with a reason', r.status === 502 && /KXPREMIERLEAGUE: HTTP 429/.test(body.error), body.error);
mode = '404'; calls = 0; r = await call();
ok('a 4xx is not retried', r.status === 502 && calls === 1, `calls=${calls}`);

mode = 'ok';
r = await call('/markets?series_ticker=KXUCL');
ok('old /markets passthrough is gone', r.status === 404);
r = await call('/batch', 'https://evil.example');
ok('unknown origin is not echoed back', r.headers.get('Access-Control-Allow-Origin') === 'https://jmorcos3.github.io' && r.headers.get('Vary') === 'Origin');
r = await call('/batch', 'https://arsenal-pent.netlify.app');
ok('the never-created pent origin is no longer allowed', r.headers.get('Access-Control-Allow-Origin') !== 'https://arsenal-pent.netlify.app');
if (process.exitCode) console.log('\nSome checks failed.');
