#!/usr/bin/env node
// Unit tests for contrib/contact/server.mjs — pure local, zero external network.
// Run: node contrib/contact/server.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContactServer } from './server.mjs';

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail++;
    console.error(`  FAIL  ${name}\n        ${err.stack || err.message}`);
  }
}

async function withServer(opts, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcoin-contact-test-'));
  const sent = [];
  let tgBehavior = async (token, chatId, text) => {
    sent.push({ token, chatId, text });
    return { ok: true, status: 200 };
  };
  const server = createContactServer({
    telegramToken: 'TEST_TOKEN',
    telegramChats: ['-1004340510788', '508669931'],
    dataDir: tmpDir,
    sendTelegram: (...args) => tgBehavior(...args),
    ...opts,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({
      base,
      sent,
      logPath: path.join(tmpDir, 'submissions.jsonl'),
      setTg: (f) => { tgBehavior = f; },
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await withServer({}, async ({ base, sent, logPath }) => {
  await test('GET /api/contact/health returns 200 ok', async () => {
    const r = await fetch(`${base}/api/contact/health`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.chats, 2);
  });

  await test('POST valid JSON forwards to both Telegram chats and persists JSONL', async () => {
    const r = await fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '198.51.100.10',
        'CF-IPCountry': 'US',
      },
      body: JSON.stringify({
        topic: 'promotion',
        name: '100x Founder',
        reply_to: '@Founder100X',
        message: 'We have 10+ TG channels and want to discuss a campaign for PCoin.',
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.id, /^C-\d{8}-[0-9a-f]{6}$/);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].chatId, '-1004340510788');
    assert.equal(sent[1].chatId, '508669931');
    assert.match(sent[0].text, /Promotion \/ Marketing offer/);
    assert.match(sent[0].text, /@Founder100X/);
    assert.match(sent[0].text, /198\.51\.100\.10 \(US\)/);

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.id, j.id);
    assert.equal(rec.deliveredCount, 2);
  });

  await test('POST honeypot returns 200 ok silently without sending to Telegram', async () => {
    const before = sent.length;
    const r = await fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.11' },
      body: JSON.stringify({
        topic: 'other',
        name: 'Bot',
        reply_to: 'bot@example.com',
        message: 'Buy cheap followers right now!',
        website: 'https://spam.example',
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(sent.length, before);
  });

  await test('POST missing/short message returns 400 validation error', async () => {
    const r = await fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.12' },
      body: JSON.stringify({ topic: 'bug', name: 'Alice', reply_to: 'a@b.c', message: 'hi' }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.match(j.error, /10 characters/i);
  });

  await test('POST form-urlencoded from non-JS browser redirects 303 to /contact/?sent=1', async () => {
    const body = new URLSearchParams({
      topic: 'partnership',
      name: 'Bob',
      reply_to: 'bob@example.org',
      message: 'Hello team, interested in integrating PCN payments on our site.',
    });
    const r = await fetch(`${base}/api/contact`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml',
        'CF-Connecting-IP': '198.51.100.13',
      },
      body,
    });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('location') || '', /^\/contact\/\?sent=1&id=C-/);
  });
});

await withServer({ maxPerIpPerHour: 2 }, async ({ base }) => {
  await test('Per-IP rate limit blocks after threshold with 429', async () => {
    const makeReq = () => fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5' },
      body: JSON.stringify({
        topic: 'other',
        name: 'Tester',
        reply_to: 't@example.com',
        message: 'Testing rate limit with a valid length message.',
      }),
    });
    assert.equal((await makeReq()).status, 200);
    assert.equal((await makeReq()).status, 200);
    assert.equal((await makeReq()).status, 429);
  });
});

await withServer({}, async ({ base, setTg, logPath }) => {
  await test('Partial Telegram delivery failure still succeeds (200)', async () => {
    setTg(async (_tok, chatId) => chatId === '508669931' ? { ok: true } : { ok: false, error: 'HTTP 500' });
    const r = await fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
      body: JSON.stringify({
        topic: 'support',
        name: 'Carol',
        reply_to: '@carol',
        message: 'Need help with my deposit confirmation status please.',
      }),
    });
    assert.equal(r.status, 200);
    const rec = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(rec.deliveredCount, 1);
  });

  await test('Total Telegram delivery failure still logs to disk and returns 503', async () => {
    setTg(async () => ({ ok: false, error: 'timeout' }));
    const r = await fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.8' },
      body: JSON.stringify({
        topic: 'other',
        name: 'Dave',
        reply_to: 'dave@example.com',
        message: 'Important message that must still be logged locally on outage.',
      }),
    });
    assert.equal(r.status, 503);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).deliveredCount, 0);
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
