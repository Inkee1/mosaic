import { lstat, readdir, readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MAX_TEXT = 16 * 1024 * 1024;
const ROOT_FILES = new Set([
  '.gitignore', '.gitattributes', 'README.md', 'SECURITY.md', 'package.json', 'package-lock.json', 'release.config.json',
  'index.html', 'tsconfig.json', 'vite.config.ts', 'playwright.config.ts', 'playwright.desktop.config.ts',
  'LICENSE', 'LICENSE.txt', 'LICENSE.md', 'NOTICE', 'NOTICE.txt',
  'electron-builder.config.cjs', 'electron-builder.config.mjs', 'electron-builder.config.json', 'electron-builder.config.yml',
]);
const TEXT_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.mts', '.cts', '.css', '.html', '.svg', '.json', '.md', '.txt', '.yml', '.yaml', '.nsi', '.nsh', '.ps1', '.cmd']);
export const INSTALLER_NOTICE_FILES = Object.freeze(['NSIS-LICENSE.txt', 'ELECTRON-BUILDER-LICENSE.txt', 'STDUTILS-LGPL.txt', 'STDUTILS-LGPL-CLARIFICATION.txt', '7ZIP-LICENSE.txt', '7ZIP-COPYING.txt']);
const ASSET_EXTENSIONS = new Set(['.ico', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2']);
const ROOT_DIRS = new Set(['src', 'desktop', 'shared', 'scripts', 'tests', 'public', 'installer', 'website']);
const GITHUB_FILES = new Set(['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/ISSUE_TEMPLATE/bug-report.yml', '.github/ISSUE_TEMPLATE/config.yml']);
const GITHUB_DIRS = new Set(['.github', '.github/workflows', '.github/ISSUE_TEMPLATE']);
const PRIVATE_DIRECTORIES = new Set([
  '.git', '.superpowers', 'node_modules', '.runtime', '.mosaic-ai', '.codex', '.claude',
  'chrome-profiles', 'profiles', 'sessions', 'ai-connections', 'ai-workspaces', 'user-data', 'userdata', 'user data', 'mosaicbrowser',
  'partitions', 'session storage', 'local storage', 'indexeddb', 'cache', 'code cache',
  'gpucache', 'logs', 'coverage', 'test-results', 'test-results-desktop', 'playwright-report', 'blob-report',
]);
const PRIVATE_BASENAMES = /^(?:\.env(?:\..*)?|agent-connection(?:\..*)?|credentials\.bin(?:\..*)?|sessions?\.bin(?:\..*)?|workspace\.json(?:\..*)?|ai-chats\.json(?:\..*)?|app-settings\.json(?:\..*)?|app-metrics\.json(?:\..*)?|usage-consent\.json(?:\..*)?|preferences|local state|cookies|login data|history|web data|devtoolsactiveport|id_rsa|id_ed25519)$/i;
const PRIVATE_SUFFIX = /\.(?:log|har|trace|dmp|bak|tmp|pem|key|pfx|p12|keystore|sqlite|sqlite3|db)$/i;
const posix = (path) => path.split(sep).join('/');
const privatePath = (path) => path.split('/').some((part) => PRIVATE_DIRECTORIES.has(part.toLowerCase())) || PRIVATE_BASENAMES.test(path.split('/').at(-1)) || PRIVATE_SUFFIX.test(path);
const inRoot = (root, file) => { const rest = relative(root, file); return rest !== '..' && !rest.startsWith('..' + sep) && !resolve(rest).startsWith('\\\\') && !rest.includes(':'); };

// Do not exempt tests or documentation: genuine credential formats fail everywhere.
// Short fixture words and explicitly reserved example identities are not credentials.
const PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{32,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g],
  ['provider-token', /\bsk-(?:proj-|ant-(?:api\d+-)?)?[A-Za-z0-9_-]{32,255}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{24,255}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/g],
];
const exampleIdentity = /^(?:example|test|tester|user|username|demo|brand|alice|bob|person|sample)(?:[-_.\d].*)?$/i;
const reservedDomain = /(?:^|\.)(?:example\.(?:com|net|org|test)|localhost|invalid|test)$/i;
function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  return [...counts.values()].reduce((sum, count) => sum - (count / value.length) * Math.log2(count / value.length), 0);
}
export function scanText(text, { scope = 'source', path = 'unknown', allowedEmail } = {}) {
  const findings = [];
  const found = (rule, index) => {
    const line = 1 + (text.slice(0, index).match(/\n/g)?.length || 0);
    if (!findings.some((entry) => entry.rule === rule && entry.line === line)) findings.push({ scope, path, rule, line });
  };
  for (const [rule, expression] of PATTERNS) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) found(rule, match.index);
  }
  for (const match of text.matchAll(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|token)\b["']?\s*[:=]\s*["']([^"'\r\n]{24,512})["']/gi)) {
    const value = match[1];
    if (/^[A-Za-z0-9_+/.=:@!$%-]+$/.test(value) && entropy(value) >= 3.7) found('embedded-credential', match.index);
  }
  for (const match of text.matchAll(/\b([A-Za-z0-9_.+%-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
    if (match[0] !== allowedEmail && /(?:^|\.)(?:gmail\.com|naver\.com|daum\.net|hanmail\.net|outlook\.com|hotmail\.com|icloud\.com|yahoo\.com|proton\.me|protonmail\.com)$/i.test(match[2]) && !exampleIdentity.test(match[1]) && !reservedDomain.test(match[2])) found('personal-email', match.index);
  }
  for (const match of text.matchAll(/(?:[A-Za-z]:[\\/]+Users[\\/]+|\/(?:Users|home)\/)([^\\/\s"'<>$`{}]+)/g)) {
    if (!exampleIdentity.test(match[1]) && !/^(?:Public|Default|runner|runneradmin)$/i.test(match[1])) found('personal-home-path', match.index);
  }
  return findings;
}

async function safeFile(root, path) {
  const file = join(root, path);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('unsafe-file');
  if (!inRoot(root, await realpath(file))) throw new Error('escaped-root');
  const data = await readFile(file);
  const after = await lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || data.length !== after.size) throw new Error('changed-during-audit');
  return data;
}

async function walk(root, { source, allowedEmail }) {
  if ((await lstat(resolve(root))).isSymbolicLink()) throw new Error('Linked publication root.');
  root = await realpath(resolve(root));
  const entries = [], findings = [];
  let excluded = 0, textFiles = 0;
  async function visit(path = '') {
    const dir = join(root, path);
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const rel = path ? path + '/' + item.name : item.name;
      const scope = source ? 'source' : 'package';
      if (source) {
        const top = rel.split('/')[0];
        const selected = ROOT_FILES.has(rel) || ROOT_DIRS.has(top) || rel === 'docs' || rel === 'docs/distribution' || rel.startsWith('docs/distribution/') || GITHUB_DIRS.has(rel) || GITHUB_FILES.has(rel);
        if (!selected || (rel.startsWith('docs/') && !rel.startsWith('docs/distribution'))) { excluded++; continue; }
      }
      if (privatePath(rel)) {
        excluded++;
        if (!source) findings.push({ scope, path: rel, rule: 'private-path' });
        continue;
      }
      const metadata = await lstat(join(root, rel));
      if (metadata.isSymbolicLink()) { findings.push({ scope, path: rel, rule: 'symbolic-link' }); continue; }
      if (metadata.isDirectory()) { await visit(rel); continue; }
      if (!metadata.isFile()) { findings.push({ scope, path: rel, rule: 'unsupported-file' }); continue; }
      const extension = extname(rel).toLowerCase();
      const textFile = TEXT_EXTENSIONS.has(extension) || ROOT_FILES.has(rel) || ['LICENSE', 'NOTICE'].includes(item.name);
      if (source && !textFile && !ASSET_EXTENSIONS.has(extension)) { excluded++; continue; }
      if (!source && rel.startsWith('resources/') && !rel.startsWith('resources/app/') && !['.pak'].includes(extension)) {
        findings.push({ scope, path: rel, rule: 'uninspected-app-archive' }); continue;
      }
      if (!source && rel.startsWith('resources/app/') && !textFile && !ASSET_EXTENSIONS.has(extension)) {
        findings.push({ scope, path: rel, rule: 'unsupported-app-file' }); continue;
      }
      // Upstream notices legitimately identify their authors. Only attribution/PII
      // rules are suppressed there; credential-shaped values still fail publication.
      const upstreamNotice = (!source && ['LICENSE', 'LICENSES.chromium.html', 'UI-LICENSES.txt'].includes(rel)) ||
        (source && rel.startsWith('installer/') && INSTALLER_NOTICE_FILES.includes(rel.slice('installer/'.length))) ||
        (!source && rel.startsWith('THIRD-PARTY-NOTICES/') && INSTALLER_NOTICE_FILES.includes(rel.slice('THIRD-PARTY-NOTICES/'.length)));
      if (textFile && metadata.size > MAX_TEXT) { findings.push({ scope, path: rel, rule: 'text-too-large' }); continue; }
      try {
        const data = await safeFile(root, rel);
        if (textFile) {
          textFiles++;
          const matches = scanText(data.toString('utf8'), { scope, path: rel, allowedEmail });
          findings.push(...matches.filter((finding) => !upstreamNotice || !['personal-email', 'personal-home-path'].includes(finding.rule)));
        }
        entries.push({ path: rel, bytes: data.length, sha256: sha256(data), data: source ? data : undefined });
      } catch {
        findings.push({ scope, path: rel, rule: 'unreadable-or-changed-file' });
      }
    }
  }
  await visit();
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { entries, findings, excluded, textFiles };
}

export async function prepareSource(root = projectRoot) {
  let config = {};
  try { config = JSON.parse(await readFile(join(root, 'release.config.json'), 'utf8')); } catch { /* gate checks validity */ }
  const result = await walk(root, { source: true, allowedEmail: config.supportEmail });
  return { ...result, allowedEmail: config.supportEmail };
}
const BUILD_INPUT_FILES = new Set(['index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json']);
export function buildInputs(files) {
  return files.filter((file) => BUILD_INPUT_FILES.has(file.path) || /^(?:src|public|shared)\//.test(file.path)).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
}
export async function stampBuild({ root = projectRoot } = {}) {
  const source = await prepareSource(root);
  if (source.findings.length) throw new Error('Source audit failed before build provenance recording.');
  let built;
  try { built = await walk(join(root, 'dist'), { source: false, allowedEmail: source.allowedEmail }); }
  catch { throw new Error('Build dist before recording provenance.'); }
  if (built.findings.length || !built.entries.some((file) => file.path === 'index.html')) throw new Error('A clean dist build with index.html is required.');
  const stamp = {
    schemaVersion: 1,
    scope: 'Recorded after the normal npm build sequence; detects stale inputs/outputs, not a cryptographic attestation of the compiler or build environment.',
    inputs: buildInputs(source.entries), outputs: publicFiles(built.entries.filter((file) => file.path !== 'BUILD-SOURCE.json')),
  };
  await writeFile(join(root, 'dist/BUILD-SOURCE.json'), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}
const publicFiles = (entries) => entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
export async function auditPublication({ root = projectRoot, packageRoot } = {}) {
  const source = await prepareSource(root);
  const report = {
    schemaVersion: 1, ok: false,
    scope: 'Allowlisted source and optional unpacked package; high-confidence patterns, not a complete security audit.',
    source: { files: publicFiles(source.entries), textFiles: source.textFiles, excluded: source.excluded },
    findings: [...source.findings],
  };
  if (packageRoot) {
    try {
      const packed = await walk(packageRoot, { source: false, allowedEmail: source.allowedEmail });
      report.package = { files: publicFiles(packed.entries), textFiles: packed.textFiles, excluded: packed.excluded };
      report.findings.push(...packed.findings);
    } catch { report.findings.push({ scope: 'package', path: '.', rule: 'package-unreadable' }); }
  }
  report.ok = report.findings.length === 0;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some((arg) => !['--package', '--source-only', '--stamp-build'].includes(arg))) throw new Error('usage');
    if (args.includes('--stamp-build')) {
      const stamp = await stampBuild();
      console.log(JSON.stringify({ buildProvenance: 'dist/BUILD-SOURCE.json', inputs: stamp.inputs.length, outputs: stamp.outputs.length }));
    } else {
    const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    const report = await auditPublication({ root: projectRoot, ...(args.includes('--package') ? { packageRoot: join(projectRoot, 'release', `Mosaic-${pkg.version}-win-x64`) } : {}) });
    await mkdir(join(projectRoot, 'release'), { recursive: true });
    await writeFile(join(projectRoot, 'release/publication-audit.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ok: report.ok, sourceFiles: report.source.files.length, packageFiles: report.package?.files.length, findings: report.findings, report: 'release/publication-audit.json' }, null, 2));
    if (!report.ok) process.exitCode = 1;
    }
  } catch { console.error('Publication audit could not finish. Usage: node scripts/audit-publication.mjs [--package | --source-only | --stamp-build]. No file contents are logged.'); process.exitCode = 1; }
}
