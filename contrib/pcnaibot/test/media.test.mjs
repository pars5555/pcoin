// The builder's catalogue, prices and client (lib/media.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';

import { Bucket } from '../lib/oonacode.mjs';
import { mediaOffer, priceFor, usdToMicro, moneyLabel, maxInputs, videoDurations, MediaClient, MediaError, PriceUnavailable } from '../lib/media.mjs';
import { creditsToMicroUsd } from '../lib/money.mjs';
import { LISTING, OFFER, MARGIN_E6 } from './fixtures.mjs';

test('only what OonaCode is serving is on sale; a video needs its text-to-video model', () => {
  assert.deepEqual(Object.keys(OFFER).sort(), ['happyhorse-1.1', 'qwen-image-3.0-pro', 'wan2.7-image-pro']);
  const noI2v = mediaOffer(LISTING.filter((m) => m.id !== 'happyhorse-1.1-i2v'));
  assert.ok(noI2v['happyhorse-1.1'], 'text-to-video alone still sells');
  assert.equal(noI2v['happyhorse-1.1'].i2v, null);
  assert.equal(mediaOffer(LISTING.filter((m) => m.id !== 'happyhorse-1.1-t2v'))['happyhorse-1.1'], undefined);
  assert.deepEqual(mediaOffer(null), {});
  assert.equal(maxInputs(OFFER['wan2.7-image-pro']), 9);
  assert.deepEqual(videoDurations(OFFER['happyhorse-1.1']), { min: 3, max: 15 });
});

test('the exact price of a job, and which model it calls', () => {
  assert.deepEqual(priceFor(OFFER['wan2.7-image-pro'], { kind: 'image' }), { usd: 0.09, apiModel: 'wan2.7-image-pro' });
  const q = priceFor(OFFER['qwen-image-3.0-pro'], { kind: 'image', inputs: 2 });
  assert.ok(Math.abs(q.usd - (0.048 + 2 * 0.0036)) < 1e-12, 'the 1k tier every size we ask for is in, plus each input image');
  const v = priceFor(OFFER['happyhorse-1.1'], { kind: 'video', seconds: 5, resolution: '720P' });
  assert.equal(v.apiModel, 'happyhorse-1.1-t2v');
  assert.ok(Math.abs(v.usd - 0.84) < 1e-12);
  assert.equal(priceFor(OFFER['happyhorse-1.1'], { kind: 'video', seconds: 3, resolution: '480P', fromImage: true }).apiModel, 'happyhorse-1.1-i2v');
  assert.throws(() => priceFor(OFFER['happyhorse-1.1'], { kind: 'video', seconds: 5, resolution: '4K' }), PriceUnavailable);
  assert.throws(() => priceFor(mediaOffer(LISTING.filter((m) => m.id !== 'happyhorse-1.1-i2v'))['happyhorse-1.1'],
    { kind: 'video', seconds: 5, resolution: '720P', fromImage: true }), PriceUnavailable);
  // x3 margin, integer micro-USD, rounded up.
  assert.equal(usdToMicro(0.09, MARGIN_E6), 270000n);
  assert.equal(usdToMicro(0.84, MARGIN_E6), 2520000n);
  assert.equal(moneyLabel(270000n), '$0.27');
  assert.equal(creditsToMicroUsd(90, MARGIN_E6), 270000n);
  assert.equal(creditsToMicroUsd(51.6, MARGIN_E6), 154800n);
});

test('the client classifies an answer the way every other gateway call does', async () => {
  const answer = (status, json) => async () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  const refused = new MediaClient('https://api.example', 'k', { fetchImpl: answer(400, { type: 'error', error: { type: 'invalid_request_error', message: 'DataInspectionFailed' } }) });
  await assert.rejects(refused.generateImage({ model: 'm', prompt: 'p', size: '1024x1024' }), (e) => e instanceof MediaError && e.bucket === Bucket.PERMANENT && /DataInspectionFailed/.test(e.message));

  const html502 = new MediaClient('https://api.example', 'k', { fetchImpl: async () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(html502.generateImage({ model: 'm', prompt: 'p', size: '1' }), (e) => e.bucket === Bucket.UNKNOWN);

  const dropped = new MediaClient('https://api.example', 'k', { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(dropped.generateImage({ model: 'm', prompt: 'p', size: '1' }), (e) => e.bucket === Bucket.UNKNOWN);

  const refusedConn = new MediaClient('https://api.example', 'k', { fetchImpl: async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; } });
  await assert.rejects(refusedConn.generateImage({ model: 'm', prompt: 'p', size: '1' }), (e) => e.bucket === Bucket.PERMANENT);

  let sent = null;
  const ok = new MediaClient('https://api.example', 'k', { fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  await ok.generateImage({ model: 'wan2.7-image-pro', prompt: 'p', size: '2048x2048', images: ['data:image/png;base64,AA=='] });
  assert.deepEqual(sent, { model: 'wan2.7-image-pro', prompt: 'p', n: 1, size: '2048x2048', image: ['data:image/png;base64,AA=='] });
});
