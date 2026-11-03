/**
 * Fail if any runtime dependency, direct or transitive, is not under a
 * permissive licence.
 *
 * This library is Apache-2.0 and is embedded in other people's applications,
 * so a copyleft dependency (the AGPL WISP and TLS clients in particular)
 * would pass its terms on to every one of them. The licence comes from
 * package.json, or from the LICENSE file when package.json does not say:
 * @tcpip/dns and @tcpip/wire ship an MIT LICENSE but no `license` field.
 *
 *   node scripts/check-licenses.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED = /^(MIT|ISC|0BSD|BSD-2-Clause|BSD-3-Clause|Apache-2\.0)$/;
const FROM_FILE = [
  [/^MIT License/m, 'MIT'],
  [/^ISC License/m, 'ISC'],
  [/Apache License\s+Version 2\.0/, 'Apache-2.0'],
  [/Redistribution and use in source and binary forms/, 'BSD-3-Clause'],
];

const dirs = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .slice(1); // the first line is this package

let failures = 0;
for (const dir of dirs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let license = typeof pkg.license === 'string' ? pkg.license : null;
  let source = 'package.json';
  if (!license) {
    const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f));
    const text = file ? fs.readFileSync(path.join(dir, file), 'utf8') : '';
    license = FROM_FILE.find(([pattern]) => pattern.test(text))?.[1] ?? null;
    source = file ?? 'nothing';
  }
  // An SPDX expression such as "MIT OR Apache-2.0" passes if any choice does.
  const choices = (license ?? '').replace(/[()]/g, '').split(/\s+OR\s+/);
  const ok = choices.some((c) => ALLOWED.test(c.trim()));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pkg.name}@${pkg.version}: ${license ?? 'unknown'} (from ${source})`);
  if (!ok) failures++;
}
if (failures) {
  console.error(`\n${failures} runtime dependenc${failures === 1 ? 'y is' : 'ies are'} not permissively licensed.`);
  process.exit(1);
}
console.log(`\nAll ${dirs.length} runtime dependencies are permissively licensed.`);
