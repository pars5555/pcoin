#!/usr/bin/env node
// PCoin contact form backend — receives POST /api/contact from Apache on pc.am,
// appends every submission to JSONL on disk, and forwards it to Telegram.
//
// Zero external dependencies (Node 20+ built-ins only).
// Runs bound to 127.0.0.1 only behind Apache's reverse proxy on pc.am.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const TOPICS = Object.freeze({
  promotion: 'Promotion / Marketing offer',
  exchange: 'Exchange / Listing inquiry',
  partnership: 'Partnership / Integration',
  support: 'Support / Account issue',
  bug: 'Bug report / Security',
  other: 'General / Other',
});

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_PER_IP_PER_HOUR = 5;
export const MAX_GLOBAL_PER_10M = 30;
const HOUR_MS = 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

export function parseEnvFile(filePath) {
  const out = {};
  if (!filePath || !fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function cleanText(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

export function validatePayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Invalid submission.' };
  }
  // Honeypot: bots often fill hidden "website" field.
  const trap = typeof raw.website === 'string' ? raw.website.trim() : '';
  if (trap.length > 0) {
    return { honeypot: true };
  }

  const topicKey = typeof raw.topic === 'string' && Object.hasOwn(TOPICS, raw.topic.trim())
    ? raw.topic.trim()
    : 'other';
  const name = cleanText(raw.name, 100);
  const replyTo = cleanText(raw.reply_to ?? raw.contact ?? raw.email, 160);
  const message = cleanText(raw.message, 3000);

  if (name.length < 1) {
    return { error: 'Please enter your name or handle.' };
  }
  if (replyTo.length < 2) {
    return { error: 'Please enter an email address or Telegram/Discord handle so we can reply.' };
  }
  if (message.length < 10) {
    return { error: 'Please enter a message of at least 10 characters.' };
  }

  return {
    data: {
      topic: topicKey,
      topicLabel: TOPICS[topicKey],
      name,
      replyTo,
      message,
    },
  };
}

export function extractClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim().slice(0, 64);
  }
  return (req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

export function formatTelegramMessage(sub) {
  const lines = [
    `📩 New pc.am contact submission (${sub.id})`,
    `Topic: ${sub.topicLabel}`,
    `From: ${sub.name}`,
    `Reply to: ${sub.replyTo}`,
    `Origin: ${sub.ip}${sub.country ? ` (${sub.country})` : ''} · ${sub.at}`,
    '',
    sub.message,
  ];
  const text = lines.join('\n');
  return text.length > 3950 ? text.slice(0, 3947) + '...' : text;
}

export async function defaultSendTelegram(token, chatId, text, fetchImpl = fetch) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
  let lastErr = 'unknown error';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const body = await res.text();
      if (res.ok) {
        return { ok: true, status: res.status };
      }
      lastErr = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      if (res.status < 500 && res.status !== 429) {
        return { ok: false, error: lastErr };
      }
    } catch (err) {
      lastErr = err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err));
    }
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return { ok: false, error: lastErr };
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/json')) {
    return JSON.parse(raw || '{}');
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
  }
  // Fallback: try JSON first, then URLSearchParams.
  try {
    return JSON.parse(raw);
  } catch {
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
  }
}

function wantsHtmlRedirect(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const accept = String(req.headers.accept || '').toLowerCase();
  const xrw = String(req.headers['x-requested-with'] || '').toLowerCase();
  if (ct.includes('application/json') || xrw === 'fetch' || accept.includes('application/json')) {
    return false;
  }
  return accept.includes('text/html');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendRedirect(res, location) {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
  });
  res.end();
}

export function createContactServer(options = {}) {
  const token = options.telegramToken || '';
  const chats = (options.telegramChats || []).filter(Boolean);
  const dataDir = options.dataDir || '/var/lib/pcoin-contact';
  const sendTelegram = options.sendTelegram || defaultSendTelegram;
  const nowFn = options.now || (() => Date.now());
  const maxPerIpPerHour = options.maxPerIpPerHour ?? MAX_PER_IP_PER_HOUR;
  const maxGlobalPer10m = options.maxGlobalPer10m ?? MAX_GLOBAL_PER_10M;

  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, 'submissions.jsonl');

  const ipHits = new Map();
  const globalHits = [];

  function checkRateLimit(ip, now) {
    while (globalHits.length && now - globalHits[0] > TEN_MIN_MS) {
      globalHits.shift();
    }
    if (globalHits.length >= maxGlobalPer10m) {
      return 'Too many submissions right now. Please try again in a few minutes.';
    }
    const list = (ipHits.get(ip) || []).filter((t) => now - t <= HOUR_MS);
    if (list.length >= maxPerIpPerHour) {
      ipHits.set(ip, list);
      return 'Too many submissions from your address. Please wait before sending another message.';
    }
    list.push(now);
    ipHits.set(ip, list);
    globalHits.push(now);
    // Keep map bounded if many distinct IPs appear.
    if (ipHits.size > 5000) {
      for (const [k, arr] of ipHits.entries()) {
        if (!arr.length || now - arr[arr.length - 1] > HOUR_MS) ipHits.delete(k);
      }
    }
    return null;
  }

  return http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && (urlPath === '/api/contact/health' || urlPath === '/health')) {
      return sendJson(res, 200, { ok: true, chats: chats.length });
    }

    if (req.method !== 'POST' || (urlPath !== '/api/contact' && urlPath !== '/')) {
      return sendJson(res, 404, { ok: false, error: 'Not found' });
    }

    const htmlMode = wantsHtmlRedirect(req);
    const replyErr = (status, msg) => {
      if (htmlMode) {
        return sendRedirect(res, `/contact/?err=${encodeURIComponent(msg)}`);
      }
      return sendJson(res, status, { ok: false, error: msg });
    };

    let parsed;
    try {
      const raw = await readBody(req);
      parsed = parseBody(raw, req.headers['content-type']);
    } catch (err) {
      const code = err?.statusCode === 413 ? 413 : 400;
      return replyErr(code, code === 413 ? 'Message is too large.' : 'Could not read submission.');
    }

    const check = validatePayload(parsed);
    if (check.honeypot) {
      if (htmlMode) return sendRedirect(res, '/contact/?sent=1');
      return sendJson(res, 200, { ok: true, id: 'ok' });
    }
    if (check.error) {
      return replyErr(400, check.error);
    }

    const ip = extractClientIp(req);
    const now = nowFn();
    const limitErr = checkRateLimit(ip, now);
    if (limitErr) {
      return replyErr(429, limitErr);
    }

    const stamp = new Date(now).toISOString();
    const dayTag = stamp.slice(0, 10).replace(/-/g, '');
    const id = `C-${dayTag}-${crypto.randomBytes(3).toString('hex')}`;
    const country = typeof req.headers['cf-ipcountry'] === 'string'
      ? req.headers['cf-ipcountry'].trim().slice(0, 8)
      : '';

    const submission = {
      id,
      at: stamp,
      ip,
      country,
      topic: check.data.topic,
      topicLabel: check.data.topicLabel,
      name: check.data.name,
      replyTo: check.data.replyTo,
      message: check.data.message,
    };

    // Persist before network I/O so no submission is ever lost.
    const tgText = formatTelegramMessage(submission);
    const deliveries = [];
    if (token && chats.length > 0) {
      for (const chatId of chats) {
        const r = await sendTelegram(token, chatId, tgText);
        deliveries.push({ chatId, ok: Boolean(r?.ok), error: r?.ok ? null : (r?.error || 'failed') });
      }
    }

    const deliveredCount = deliveries.filter((d) => d.ok).length;
    const record = { ...submission, deliveries, deliveredCount };
    try {
      fs.appendFileSync(logFile, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch (err) {
      console.error('[pcoin-contact] failed to write submission log:', err?.message || err);
    }

    if (chats.length > 0 && deliveredCount === 0) {
      console.error('[pcoin-contact] all Telegram deliveries failed for', id, deliveries);
      return replyErr(503, 'Your message was recorded, but notification delivery hit a temporary error. Please also email pcoin@pc.am if urgent.');
    }

    if (htmlMode) {
      return sendRedirect(res, `/contact/?sent=1&id=${encodeURIComponent(id)}`);
    }
    return sendJson(res, 200, { ok: true, id });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const confPath = process.env.CONTACT_CONF || '/etc/pcoin/contact.conf';
  const cfg = parseEnvFile(confPath);
  const host = process.env.BIND_HOST || cfg.BIND_HOST || '127.0.0.1';
  const port = Number(process.env.PORT || cfg.PORT || 18590);
  const dataDir = process.env.DATA_DIR || cfg.DATA_DIR || '/var/lib/pcoin-contact';
  const telegramToken = process.env.TELEGRAM_TOKEN || cfg.TELEGRAM_TOKEN || '';
  const chatsRaw = process.env.TELEGRAM_CHATS || cfg.TELEGRAM_CHATS || cfg.ALERT_CHAT || '';
  const telegramChats = chatsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  if (!telegramToken || telegramChats.length === 0) {
    console.error('[pcoin-contact] WARNING: TELEGRAM_TOKEN or TELEGRAM_CHATS not configured');
  }

  const server = createContactServer({
    telegramToken,
    telegramChats,
    dataDir,
  });

  server.listen(port, host, () => {
    console.log(`[pcoin-contact] listening on http://${host}:${port} (chats=${telegramChats.length})`);
  });
}
