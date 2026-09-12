// The address pool: import, and allocation.
//
// ONLY the derived (index, address) list is on this server. Not the account
// xpub, not any child private key. If the pool is pre-derived the server needs
// the addresses, not the key that generates them -- and shipping the xpub
// anyway keeps a real liability for zero functional gain: anyone holding it can
// derive every address and read the customer payment history in signup order,
// and it cannot be rotated without orphaning every address ever issued.

import { readFileSync } from 'node:fs';
import { validatePcoinAddress } from './address.mjs';
import { immediate, nowSec } from './db.mjs';

export class PoolEmpty extends Error {
  constructor() {
    super('address pool is empty');
    this.name = 'PoolEmpty';
  }
}

// Parse the vault tool's pool listing.
//
// TWO FORMATS, and the difference is load-bearing.
//
//   1. "<index> <address>"  -- the index is explicit and self-describing.
//   2. "<address>"          -- ONE PER LINE, the index is POSITIONAL, counted
//                              from the start index. This is what
//                              pcoin-seed-vault.mjs actually writes, and its own
//                              output says why it matters: "The order is
//                              load-bearing: the row a user is handed is
//                              identified by its index, and an off-by-one sends
//                              their deposit to a different row."
//
// A positional file therefore CANNOT be imported without being told where it
// starts. Guessing 0 would silently shift every address by 1000 and hand every
// user an address the offline signer will never derive for them, which is money
// sent somewhere nobody can reach. So: no start index, no import.
export function parsePoolFile(text, { startIndex = null } = {}) {
  const rows = [];
  const problems = [];
  let lineNo = 0;
  let positional = 0;

  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withIndex = /^(\d+)[\s,]+(\S+)$/.exec(line);
    let index;
    let addrText;

    if (withIndex) {
      index = Number(withIndex[1]);
      addrText = withIndex[2];
      if (!Number.isSafeInteger(index) || index < 0) {
        problems.push(`line ${lineNo}: bad derivation index`);
        continue;
      }
    } else if (/^\S+$/.test(line)) {
      if (startIndex === null) {
        problems.push(`line ${lineNo}: bare address with no start index supplied -- refusing to guess the derivation index`);
        continue;
      }
      index = startIndex + positional;
      positional++;
      addrText = line;
    } else {
      problems.push(`line ${lineNo}: not "<index> <address>" and not a bare address`);
      continue;
    }

    const v = validatePcoinAddress(addrText);
    if (!v.valid) { problems.push(`line ${lineNo}: ${v.reason}`); continue; }
    if (!v.isP2wpkh) { problems.push(`line ${lineNo}: not a v0 P2WPKH address`); continue; }
    rows.push({ index, address: v.normalized }); // LOWERCASE, always
  }
  return { rows, problems };
}

// VALIDATE EVERY LINE AND REFUSE THE WHOLE BATCH IF ANY LINE IS BAD.
//
// A partial import shifts every later derivation index out of alignment with
// the wallet -- so an address we show a customer is no longer the address the
// offline signer would derive for that index, and the money goes somewhere we
// cannot reach. All-or-nothing is the only safe shape.
export function importPool(db, text, { expectStartIndex = null, expectFirst = null, expectLast = null } = {}) {
  const { rows, problems } = parsePoolFile(text, { startIndex: expectStartIndex });
  if (problems.length) {
    throw new Error(`pool import refused, ${problems.length} bad line(s):\n  - ${problems.slice(0, 10).join('\n  - ')}`);
  }
  if (rows.length === 0) throw new Error('pool import refused: no rows');

  const seenIdx = new Set();
  const seenAddr = new Set();
  for (const r of rows) {
    if (seenIdx.has(r.index)) throw new Error(`pool import refused: duplicate index ${r.index}`);
    if (seenAddr.has(r.address)) throw new Error('pool import refused: duplicate address in file');
    seenIdx.add(r.index);
    seenAddr.add(r.address);
  }

  // NEVER allocate from MAX(index)+1 -- any deletion lowers the maximum and
  // hands the next user an address that already belonged to somebody else. One
  // live integration had already recycled index 0. The pool starts at 1000,
  // above anything ever issued, and index 0 is never derived at all.
  const minIndex = Math.min(...rows.map((r) => r.index));
  if (expectStartIndex !== null && minIndex !== expectStartIndex) {
    throw new Error(`pool import refused: starts at index ${minIndex}, expected ${expectStartIndex}`);
  }

  // Check the endpoints against what the vault tool printed when it derived
  // them. A truncated, reordered or wrong-wallet file has the right SHAPE and
  // the wrong CONTENT, and the only cheap way to catch that is to compare the
  // two addresses a human actually saw.
  const sorted = [...rows].sort((a, b) => a.index - b.index);
  if (expectFirst !== null && sorted[0].address !== expectFirst.toLowerCase()) {
    throw new Error(`pool import refused: first address is ${sorted[0].address}, expected ${expectFirst}`);
  }
  if (expectLast !== null && sorted[sorted.length - 1].address !== expectLast.toLowerCase()) {
    throw new Error(`pool import refused: last address is ${sorted[sorted.length - 1].address}, expected ${expectLast}`);
  }

  return immediate(db, () => {
    const ins = db.prepare(
      `INSERT INTO pcn_addresses (derivation_index, address, chat_id, assigned_at, remainder_nano_usd)
       VALUES (?,?,NULL,NULL,0)
       ON CONFLICT(derivation_index) DO NOTHING`
    );
    let inserted = 0;
    for (const r of rows) {
      // A row whose index exists but whose ADDRESS differs means this file does
      // not describe the wallet already loaded. Refuse the whole import.
      const existing = db.prepare('SELECT address FROM pcn_addresses WHERE derivation_index = ?').get(r.index);
      if (existing && existing.address !== r.address) {
        throw new Error(`pool import refused: index ${r.index} already holds a DIFFERENT address -- wrong pool file for this wallet`);
      }
      inserted += ins.run(r.index, r.address).changes;
    }
    return { total: rows.length, inserted, skipped: rows.length - inserted, minIndex };
  });
}

// Allocate this chat's deposit address, idempotently.
//
// SQLite has no SELECT ... FOR UPDATE. BEGIN IMMEDIATE takes the write lock up
// front, which is the equivalent; the conditional UPDATE plus a changes() check
// is what makes the claim atomic even so.
export function allocateAddress(db, chatId) {
  return immediate(db, () => {
    // Re-check INSIDE the transaction so a double /topup is idempotent rather
    // than burning a second pool address.
    const mine = db.prepare(
      'SELECT derivation_index, address FROM pcn_addresses WHERE chat_id = ?'
    ).get(chatId);
    if (mine) return { address: mine.address, index: mine.derivation_index, fresh: false };

    // CLAIMABILITY IS `assigned_at IS NULL`, NEVER `chat_id IS NULL`.
    // Deleting a user nulls chat_id -- but an address that has been SHOWN to
    // somebody can still receive coin years later and must never be re-issued.
    // assigned_at is set once and never cleared.
    const cand = db.prepare(
      `SELECT id, derivation_index, address FROM pcn_addresses
        WHERE assigned_at IS NULL
        ORDER BY derivation_index ASC
        LIMIT 1`
    ).get();
    if (!cand) throw new PoolEmpty();

    const res = db.prepare(
      `UPDATE pcn_addresses SET chat_id = ?, assigned_at = ?
        WHERE id = ? AND chat_id IS NULL AND assigned_at IS NULL`
    ).run(chatId, nowSec(), cand.id);

    if (res.changes !== 1) {
      // Somebody else took it between the SELECT and the UPDATE. Under BEGIN
      // IMMEDIATE this should be unreachable, which is exactly why it must
      // throw rather than silently hand back an address we did not claim.
      throw new Error('address allocation raced: no row claimed');
    }
    return { address: cand.address, index: cand.derivation_index, fresh: true };
  });
}

export function poolStats(db) {
  const row = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN assigned_at IS NULL THEN 1 ELSE 0 END) AS free,
            MIN(derivation_index) AS min_index,
            MAX(derivation_index) AS max_index
       FROM pcn_addresses`
  ).get();
  return {
    total: row.total ?? 0,
    free: row.free ?? 0,
    issued: (row.total ?? 0) - (row.free ?? 0),
    minIndex: row.min_index,
    maxIndex: row.max_index,
  };
}

// Every address that has ever been ISSUED -- `assigned_at IS NOT NULL`, NOT
// `chat_id IS NOT NULL`. An address shown to a human can receive coin forever,
// and a deleted user nulls chat_id. `chat_id IS NOT NULL` is a filter on WHO TO
// NOTIFY, never on WHAT TO WATCH.
export function issuedAddresses(db) {
  return db.prepare(
    `SELECT derivation_index, address, chat_id
       FROM pcn_addresses
      WHERE assigned_at IS NOT NULL
      ORDER BY derivation_index ASC`
  ).all();
}

export function loadPoolFromFile(db, path, opts) {
  return importPool(db, readFileSync(path, 'utf8'), opts);
}
