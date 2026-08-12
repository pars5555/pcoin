// Tests for clientip.mjs. Run: node clientip-test.mjs
//
// The cases that matter are the two historical bugs and the spoof attempt:
// trusting the FIRST X-Forwarded-For entry (client-controlled, defeats the rate
// limiter) and trusting the LAST one (Cloudflare's edge, collapses every
// visitor onto one bucket). Both are asserted against here so neither can come
// back quietly.

import { clientIp, isCloudflare, ipLabel } from './clientip.mjs';

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = got === want;
  good ? pass++ : fail++;
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${name}${good ? '' : `\n         got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const req = (headers, remote = '127.0.0.1') =>
  ({ headers, socket: { remoteAddress: remote } });

console.log('\ncloudflare range membership');
ok('104.23.229.118 is CF (observed live)', isCloudflare('104.23.229.118'), true);
ok('172.67.196.49 is CF',                  isCloudflare('172.67.196.49'), true);
ok('104.21.52.61 is CF',                   isCloudflare('104.21.52.61'), true);
ok('2606:4700:3032::6815:343d is CF',      isCloudflare('2606:4700:3032::6815:343d'), true);
ok('178.105.178.27 (origin) is NOT CF',    isCloudflare('178.105.178.27'), false);
ok('127.0.0.1 is NOT CF',                  isCloudflare('127.0.0.1'), false);
ok('8.8.8.8 is NOT CF',                    isCloudflare('8.8.8.8'), false);
ok('2a01:4f8:1c18:2578::1 is NOT CF',      isCloudflare('2a01:4f8:1c18:2578::1'), false);
ok('::ffff:104.23.229.118 unwraps to CF',  isCloudflare('::ffff:104.23.229.118'), true);
ok('garbage is not CF',                    isCloudflare('not-an-ip'), false);
ok('empty is not CF',                      isCloudflare(''), false);

console.log('\nthe real production shape: browser -> cloudflare -> caddy -> node');
ok('returns the BROWSER, not the edge',
  clientIp(req({ 'x-forwarded-for': '203.0.113.9, 104.23.229.118',
                 'cf-connecting-ip': '203.0.113.9' })), '203.0.113.9');
ok('ipv6 browser through cloudflare',
  clientIp(req({ 'x-forwarded-for': '2a01:4f8:1c18:2578::1, 2606:4700:3032::6815:343d',
                 'cf-connecting-ip': '2a01:4f8:1c18:2578::1' })), '2a01:4f8:1c18:2578::1');

console.log('\nregression: the two bugs this replaced');
{
  // BUG 1 — trusting the first entry. A guesser prepends a fresh fake address
  // on every attempt and never trips the lockout.
  const forged = clientIp(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 104.23.229.118',
                                'cf-connecting-ip': '203.0.113.9' }));
  ok('a prepended fake XFF entry is ignored', forged, '203.0.113.9');
  ok('  ...and specifically is not the fake', forged === '1.2.3.4', false);
}
{
  // BUG 2 — trusting the last entry. Two different visitors behind the same
  // Cloudflare edge must NOT share a rate-limit bucket.
  const a = clientIp(req({ 'x-forwarded-for': '203.0.113.9, 104.23.229.118',
                           'cf-connecting-ip': '203.0.113.9' }));
  const b = clientIp(req({ 'x-forwarded-for': '198.51.100.7, 104.23.229.118',
                           'cf-connecting-ip': '198.51.100.7' }));
  ok('two visitors, one edge -> distinct keys', a !== b, true);
  ok('  neither is the edge address', a !== '104.23.229.118' && b !== '104.23.229.118', true);
}

console.log('\nspoofing: direct-to-origin, bypassing cloudflare');
ok('forged CF-Connecting-IP from a non-CF peer is refused',
  clientIp(req({ 'x-forwarded-for': '9.9.9.9, 198.51.100.200',
                 'cf-connecting-ip': '1.1.1.1' })), '198.51.100.200');
ok('  a bare forged header with no proxy is refused',
  clientIp(req({ 'cf-connecting-ip': '1.1.1.1' }, '203.0.113.55')), '203.0.113.55');

console.log('\nunknown stays unknown — it must never become a plausible address');
ok('through CF but no CF-Connecting-IP -> null',
  clientIp(req({ 'x-forwarded-for': '104.23.229.118' })), null);
ok('through CF with a malformed CF-Connecting-IP -> null',
  clientIp(req({ 'x-forwarded-for': '104.23.229.118', 'cf-connecting-ip': 'nonsense' })), null);
ok('no headers, no socket -> null', clientIp({ headers: {}, socket: {} }), null);
ok('ipLabel renders null as "unknown"', ipLabel(null), 'unknown');
ok('ipLabel passes a real address through', ipLabel('203.0.113.9'), '203.0.113.9');

console.log('\nheader edge cases');
ok('array-valued header takes the first',
  clientIp(req({ 'x-forwarded-for': ['203.0.113.9, 104.23.229.118'],
                 'cf-connecting-ip': ['203.0.113.9'] })), '203.0.113.9');
ok('extra whitespace tolerated',
  clientIp(req({ 'x-forwarded-for': '  203.0.113.9 ,  104.23.229.118  ',
                 'cf-connecting-ip': ' 203.0.113.9 ' })), '203.0.113.9');
ok('octet > 255 rejected', clientIp(req({ 'x-forwarded-for': '999.1.1.1' })), null);
ok('non-numeric octet rejected', clientIp(req({ 'x-forwarded-for': '1.1.1.a' })), null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
