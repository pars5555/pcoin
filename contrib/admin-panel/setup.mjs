#!/usr/bin/env node
// Set the operator credential for the unified PCoin admin.
//
//   node setup.mjs                 show whether a credential exists
//   node setup.mjs --set           set a password (typed, not echoed) + new 2FA secret
//   node setup.mjs --rotate-2fa    keep the password, issue a fresh 2FA secret
//
// Run it as root on the box. That is the whole enrolment story: no email, no
// reset link, no recovery questions. Anyone who can run this is already root and
// could read the service's memory anyway, so a reset flow would only add attack
// surface without adding a barrier.
//
// The password is read from the terminal with echo OFF and never appears in
// argv — a password passed as an argument is visible in `ps` to every user on
// the box and lands in shell history.
import { createInterface } from 'node:readline';
import { hashPassword, loadCredential, saveCredential, newTotpSecret, totpAt } from './auth.mjs';

const args = process.argv.slice(2);

function ask(prompt, { silent = false } = {}) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (silent) {
      // Suppress echo by overriding the output write for this prompt only.
      const out = rl.output;
      rl.output = Object.create(out);
      rl.output.write = chunk => { if (String(chunk).includes(prompt)) out.write(chunk); };
    }
    rl.question(prompt, answer => { if (silent) process.stdout.write('\n'); rl.close(); resolve(answer); });
  });
}

const existing = loadCredential();

if (!args.length) {
  console.log('  credential file : ' + (existing ? 'present' : 'NOT SET — the panel will refuse every login'));
  if (existing) {
    console.log('  password        : set (scrypt)');
    console.log('  second factor   : ' + (existing.totp ? 'enabled' : 'NOT ENABLED'));
    console.log('  set at          : ' + (existing.setAt || 'unknown'));
  }
  console.log('\n  usage: node setup.mjs --set | --rotate-2fa');
  process.exit(0);
}

if (args.includes('--rotate-2fa')) {
  if (!existing) { console.error('  no credential yet — run --set first'); process.exit(1); }
  const totp = newTotpSecret();
  saveCredential({ ...existing, totp, setAt: new Date().toISOString() });
  showEnrolment(totp);
  process.exit(0);
}

if (args.includes('--set')) {
  const pw1 = await ask('  new password: ', { silent: true });
  if (pw1.length < 12) {
    console.error('\n  REFUSED: use at least 12 characters. This is the only password on the panel.');
    process.exit(1);
  }
  const pw2 = await ask('  again:        ', { silent: true });
  if (pw1 !== pw2) { console.error('\n  REFUSED: they do not match.'); process.exit(1); }

  const { salt, key } = hashPassword(pw1);
  const totp = existing?.totp && !args.includes('--new-2fa') ? existing.totp : newTotpSecret();
  saveCredential({ salt, key, totp, setAt: new Date().toISOString() });
  console.log('\n  password set.');
  showEnrolment(totp);
  process.exit(0);
}

console.error('  unknown argument. usage: node setup.mjs --set | --rotate-2fa');
process.exit(2);

function showEnrolment(totp) {
  const uri = 'otpauth://totp/' + encodeURIComponent('PCoin admin')
            + '?secret=' + totp + '&issuer=' + encodeURIComponent('pc.am') + '&digits=6&period=30';
  console.log('\n  ── enrol your authenticator ───────────────────────────────');
  console.log('  secret : ' + totp);
  console.log('  uri    : ' + uri);
  console.log('\n  Add it to Google Authenticator, Aegis, 1Password — anything doing TOTP.');
  console.log('  Right now the code should be: ' + totpAt(totp, Math.floor(Date.now() / 30000)));
  console.log('  If your app shows a different number, its clock is off and login will fail.');
  console.log('\n  WRITE THE SECRET DOWN SOMEWHERE OFFLINE. There is no recovery flow:');
  console.log('  losing it means running this command again as root on the box.');
}
