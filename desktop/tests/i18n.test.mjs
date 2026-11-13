import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { resolveLocale, normalizeLanguagePreference, translate, t, setLocale, getLocale, messages } from '../../shared/i18n.mjs';

test('language follows the system initially and explicit choices override it', () => {
  assert.equal(resolveLocale('system', 'ko-KR'), 'ko');
  assert.equal(resolveLocale('system', 'KO_kr'), 'ko');
  assert.equal(resolveLocale('system', 'en-US'), 'en');
  assert.equal(resolveLocale('system', 'fr-FR'), 'en');
  assert.equal(resolveLocale('en', 'ko-KR'), 'en');
  assert.equal(resolveLocale('ko', 'en-US'), 'ko');
  assert.equal(resolveLocale('unexpected', 'en-US'), 'en');
  for (const bad of [null, 4, {}, 'fr', '__proto__']) assert.equal(normalizeLanguagePreference(bad), 'system');
});

test('translations interpolate values once without rewriting user content', () => {
  assert.equal(translate('en', '언어'), 'Language');
  assert.equal(translate('ko', '언어'), '언어');
  const title = '<b>내 작업 {count}</b>';
  assert.equal(translate('en', '{name} · {count}개 화면', { name: title, count: 2 }), title + ' · 2 panes');
  assert.equal(translate('ko', '{name} · {count}개 화면', { name: title, count: 2 }), title + ' · 2개 화면');
  assert.equal(translate('en', 'unregistered user text'), 'unregistered user text');
  assert.equal(translate('en', 'toString'), 'toString');
  setLocale('en'); assert.equal(getLocale(), 'en'); assert.equal(t('언어'), 'Language');
  setLocale('ko'); assert.equal(t('언어'), '언어');
});

test('every English catalog message preserves its named placeholders', () => {
  const placeholders = text => [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]))].sort();
  for (const [key, value] of Object.entries(messages.en)) {
    assert.equal(typeof value, 'string', key);
    assert.ok(value.trim(), key);
    assert.deepEqual(placeholders(value), placeholders(key), key);
  }
});

test('all explicit product translation calls have an English catalog entry', async () => {
  const missing = [];
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) {
        if (!['tests', 'e2e', 'locales'].includes(entry.name)) await inspect(url);
      } else if (/\.(tsx?|mjs|js)$/.test(entry.name)) {
        const source = await readFile(url, 'utf8');
        const tree = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true, entry.name.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        function visit(node) {
          if (ts.isCallExpression(node) && /(^|\.)(t|tr)$/.test(node.expression.getText(tree)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
            const key = node.arguments[0].text;
            if (/[가-힣]/.test(key) && !Object.hasOwn(messages.en, key)) missing.push({ file: url.pathname, key });
          }
          if (url.pathname.endsWith('/src/model.ts') && ts.isStringLiteral(node) && /[가-힣]/.test(node.text) && !Object.hasOwn(messages.en, node.text)) {
            missing.push({ file: url.pathname, key: node.text });
          }
          ts.forEachChild(node, visit);
        }
        visit(tree);
      }
    }
  }
  for (const directory of ['src', 'shared', 'desktop']) await inspect(new URL('../../' + directory + '/', import.meta.url));
  assert.deepEqual(missing, []);
});
