// The builder: OonaCode's image and video models, what each costs, and the client that calls them.
//
// Since 2026-09-26 the bot is a picture & video studio: a free chat agent (lib/studio.mjs) agrees
// with the user what to make, the user's ✅ on a card starts it (lib/jobs.mjs), and this file is
// what makes it. The models are the admin's choice (lib/settings.mjs), never the user's.
//
// Verified live against the non-agentic API key: a picture in 13-50 s; wan2.7-image-pro and
// qwen-image-3.0-pro both change a picture given as an input image (same subject, same pose); a
// 3-second 480P clip in ~65 s. OonaCode serves no video-EDIT model yet, so "change this video"
// makes a new version (lib/studio.mjs explains that to the user).

import { classify, Bucket } from './oonacode.mjs';
import { CREDITS_PER_USD, creditsToMicroUsd, microUsdToString } from './money.mjs';

// What the bot can use, and how it asks for it. OonaCode's own list (`GET /v1/models` with an API
// key) decides WHETHER each is served and at WHAT price. The owner, 2026-09-25: no GPT or Grok
// image models "for now".
export const MEDIA_MODELS = {
  'wan2.7-image-pro': {
    kind: 'image', api: 'wan2.7-image-pro', label: 'photographic, 2K',
    // One price at any size, so 2K.
    sizes: { square: '2048x2048', wide: '2048x1152', tall: '1152x2048' },
  },
  'qwen-image-3.0-pro': {
    kind: 'image', api: 'qwen-image-3.0-pro', label: 'best with writing in the picture',
    // All three stay inside Qwen-Image's cheaper "1k" tier (area up to 2,250,000 px), which is the
    // tier priceFor() charges -- so the button's price is the price.
    sizes: { square: '1024x1024', wide: '1536x1024', tall: '1024x1536' },
  },
  'happyhorse-1.1': {
    kind: 'video', t2v: 'happyhorse-1.1-t2v', i2v: 'happyhorse-1.1-i2v', label: 'video with sound',
    // Text-to-video takes a ratio; from a photo, the photo decides its own shape.
    ratios: { square: '1:1', wide: '16:9', tall: '9:16' },
  },
};

export const SHAPES = { square: 'square', wide: 'wide', tall: 'tall' };

// ---- what is on sale ------------------------------------------------------------------------

// The entries of OonaCode's list we can use, keyed by OUR id, each with the listing it prices
// from. A video entry needs its text-to-video model; photo-to-video is an extra that may be absent.
export function mediaOffer(listing) {
  const byId = new Map((Array.isArray(listing) ? listing : []).map((m) => [m.id, m]));
  const out = {};
  for (const [id, info] of Object.entries(MEDIA_MODELS)) {
    if (info.kind === 'image') {
      const e = byId.get(info.api);
      if (e && e.modality === 'image' && e.pricing?.tiers) out[id] = { id, info, image: e };
    } else {
      const t2v = byId.get(info.t2v);
      if (t2v && t2v.modality === 'video' && t2v.pricing?.tiers) {
        const i2v = byId.get(info.i2v);
        out[id] = { id, info, t2v, i2v: i2v && i2v.modality === 'video' && i2v.pricing?.tiers ? i2v : null };
      }
    }
  }
  return out;
}

// The most input images a picture model takes (0 when it cannot change a picture at all).
export const maxInputs = (offer) => Math.max(0, Number(offer?.image?.limits?.input_images?.max ?? 0));

// A clip's allowed lengths, from the model's own limits.
export function videoDurations(offer) {
  const d = offer?.t2v?.limits?.durations;
  return { min: Number(d?.min ?? 1), max: Number(d?.max ?? 15) };
}

export class PriceUnavailable extends Error {}

// What ONE job costs at OonaCode's retail, in USD, before our margin -- and which model is called.
//   picture: the cheapest tier (every size in MEDIA_MODELS is in it) + each input image it bills
//   video:   the resolution's price per second x seconds, on photo-to-video when it starts from one
export function priceFor(offer, { kind, inputs = 0, seconds = 0, resolution = null, fromImage = false }) {
  if (kind === 'image') {
    if (offer?.info?.kind !== 'image') throw new PriceUnavailable('not a picture model');
    const tiers = Object.values(offer.image.pricing.tiers).map(Number).filter(Number.isFinite);
    if (!tiers.length) throw new PriceUnavailable(`${offer.id} has no price`);
    const perInput = Number(offer.image.pricing.input_image ?? 0) || 0;
    return { usd: Math.min(...tiers) + inputs * perInput, apiModel: offer.image.id };
  }
  if (offer?.info?.kind !== 'video') throw new PriceUnavailable('not a video model');
  const api = fromImage ? offer.i2v : offer.t2v;
  if (!api) throw new PriceUnavailable(`${offer.id} cannot start from a picture right now`);
  const perSecond = Number(api.pricing.tiers[resolution]);
  if (!Number.isFinite(perSecond)) throw new PriceUnavailable(`${api.id} has no ${resolution} price`);
  return { usd: perSecond * seconds, apiModel: api.id };
}

export const usdToMicro = (usd, marginE6) => creditsToMicroUsd(Number(usd) * CREDITS_PER_USD, marginE6);
// $0.27, $0.144, $2.52, $0.10 -- at least two decimals, a third only when it is not zero.
export function moneyLabel(micro) {
  const [whole, frac = ''] = microUsdToString(micro, 3).split('.');
  const f = frac.endsWith('0') ? frac.slice(0, 2) : frac;
  return `$${whole}.${f}`;
}

// ---- the API --------------------------------------------------------------------------------

export class MediaError extends Error {
  constructor(bucket, message, { status = null } = {}) {
    super(message);
    this.name = 'MediaError';
    this.bucket = bucket;
    this.status = status;
  }
}

export class MediaClient {
  #key;

  constructor(baseUrl, apiKey, { fetchImpl = fetch } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.#key = apiKey;
    this.fetchImpl = fetchImpl;
  }

  // One exchange, classified the way every other gateway call here is: a JSON answer or a
  // MediaError carrying its bucket. A connection that never opened did not run; anything lost
  // after the request left is UNKNOWN -- a picture may have been made and charged.
  async #call(method, path, body, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { 'x-api-key': this.#key, 'content-type': 'application/json', accept: 'application/json' },
        body: body === null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const code = e?.cause?.code ?? '';
      if (!ctrl.signal.aborted && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(code)) {
        throw new MediaError(Bucket.PERMANENT, `could not connect: ${code}`);
      }
      throw new MediaError(Bucket.UNKNOWN, ctrl.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : `the request failed: ${e.message}`);
    } finally {
      clearTimeout(t);
    }
    const ct = res.headers.get('content-type') || '';
    let json = null;
    if (ct.includes('application/json')) { try { json = await res.json(); } catch { /* unreadable */ } }
    const bucket = classify(res.status, json, { hadJsonContentType: json !== null });
    if (bucket !== Bucket.OK) {
      const msg = json?.error?.message ?? `HTTP ${res.status}`;
      throw new MediaError(bucket, String(msg).slice(0, 300), { status: res.status });
    }
    if (!json || typeof json !== 'object') throw new MediaError(Bucket.UNKNOWN, `HTTP ${res.status} with an unreadable body`, { status: res.status });
    return json;
  }

  // Every model this key can call, media included, with prices and limits.
  async listModels() {
    const j = await this.#call('GET', '/v1/models', null, 30000);
    return Array.isArray(j.data) ? j.data : [];
  }

  // One picture. Measured at 13-51 s; the wait allows for a slow provider.
  async generateImage({ model, prompt, size, images = [] }) {
    const body = { model, prompt, n: 1, size };
    if (images.length) body.image = images;
    return this.#call('POST', '/v1/images/generations', body, 300000);
  }

  async createVideo({ model, prompt, image = null, resolution, duration, ratio = null }) {
    const body = { model, resolution, duration };
    if (prompt) body.prompt = prompt;
    if (image) body.image = image;
    if (ratio) body.ratio = ratio;
    return this.#call('POST', '/v1/videos', body, 60000);
  }

  async getVideo(id) {
    return this.#call('GET', `/v1/videos/${encodeURIComponent(id)}`, null, 30000);
  }

  // The result itself, from the provider's short-lived URL.
  async download(url, { maxBytes = 50 * 1024 * 1024 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120000);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`${buf.length} bytes, over the limit`);
      return buf;
    } finally {
      clearTimeout(t);
    }
  }
}
