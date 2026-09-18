// Write one upstream credential into /opt/pcoin-admin/upstream.json.
//   node setup-upstream.mjs <service> <field>     value arrives on STDIN, never argv
// argv is visible in `ps` to every user on the box; stdin is not.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const F = '/opt/pcoin-admin/upstream.json';
const [svc, field] = process.argv.slice(2);
if (!svc || !field) { console.error('usage: setup-upstream.mjs <service> <field>  (value on stdin)'); process.exit(2); }
let v = ''; process.stdin.on('data', d => v += d);
process.stdin.on('end', () => {
  v = v.replace(/[\r\n]+$/, '');                    // CRLF has bitten this project before
  if (!v) { console.error('  refusing: empty value'); process.exit(1); }
  const cur = existsSync(F) ? JSON.parse(readFileSync(F, 'utf8')) : {};
  cur[svc] = { ...(cur[svc] || {}), [field]: v };
  writeFileSync(F, JSON.stringify(cur, null, 2), { mode: 0o600 });
  console.log(`  ${svc}.${field} stored (${v.length} chars) — value not echoed`);
});
