import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAddressInput } from '../../shared/address.mjs';
import { normalizeUrl } from '../../shared/validation.mjs';

test('address fields navigate domains, explicit URLs and local development addresses', () => {
  const cases = [
    ['  naver.com  ', 'https://naver.com/'],
    ['example.com/path?q=hello#part', 'https://example.com/path?q=hello#part'],
    ['https://example.com/a', 'https://example.com/a'],
    ['http://intranet/path', 'http://intranet/path'],
    ['example.com:8080/path', 'https://example.com:8080/path'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['localhost', 'http://localhost/'],
    ['127.0.0.1:4317/test', 'http://127.0.0.1:4317/test'],
    ['192.168.1.1', 'https://192.168.1.1/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['//example.com/path', 'https://example.com/path'],
    ['한글.한국/검색', new URL('https://한글.한국/검색').href],
  ];
  for (const [input, expected] of cases) assert.equal(resolveAddressInput(input), expected, input);
});

test('words, phrases, search operators and punctuation become one intact Google query', () => {
  for (const query of [
    '날씨', 'mosaic', '서울 날씨', 'C++ & C# 100%?',
    'site:example.com', 'filetype:pdf 마케팅', '2026.11.10', '12345',
    'https 사용법', '운동화 추천 #가벼운 +편한', 'hello?x=1&y=2',
    'user@example.com', 'user+tag@example.com',
  ]) {
    const result = new URL(resolveAddressInput('  ' + query + '  '));
    assert.equal(result.origin, 'https://www.google.com', query);
    assert.equal(result.pathname, '/search', query);
    assert.deepEqual([...result.searchParams], [['q', query]], query);
    assert.equal(result.hash, '', query);
  }
});

test('blank input, unsupported explicit URLs and credentials cannot become navigation or a query', () => {
  for (const input of ['', ' \t ', null, undefined])
    assert.throws(() => resolveAddressInput(input), /주소나 검색어/);
  for (const input of [
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'file:///C:/private.txt', 'ftp://example.com',
    'https://user:secret@example.com', 'user:secret@example.com', 'https://',
  ]) assert.throws(() => resolveAddressInput(input), undefined, input);
});

test('encoded search and address lengths respect the persisted URL limit', () => {
  assert.throws(() => resolveAddressInput('가'.repeat(250)), /2048/);
  assert.throws(() => resolveAddressInput('https://example.com/' + '가'.repeat(250)), /2048/);
  assert.equal(normalizeUrl(resolveAddressInput('검색어')), resolveAddressInput('검색어'));
  assert.throws(() => normalizeUrl('서울 날씨'), /공백/);
});
