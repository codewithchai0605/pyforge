import test from 'node:test';
import assert from 'node:assert/strict';
import { AnsiParser, type AnsiToken } from '../../src/python/ansi';

const texts = (tokens: AnsiToken[]) => tokens.map((t) => (t.type === 'text' ? t.text : `<${t.type}>`)).join('');

test('plain text and newlines', () => {
  assert.equal(texts(new AnsiParser().push('a\nb\n')), 'a<lf>b<lf>');
});

test('CRLF is a single line break, even when split across chunks', () => {
  const p = new AnsiParser();
  const out = [...p.push('line one\r'), ...p.push('\nline two\r\n')];
  assert.equal(texts(out), 'line one<lf>line two<lf>');
});

test('a lone CR (progress bar) becomes a carriage-return token', () => {
  const p = new AnsiParser();
  assert.equal(texts(p.push('10%\r20%\r')), '10%<cr>20%');
  assert.equal(texts(p.push('30%')), '<cr>30%'); // the held "\r" resolves once more data arrives
});

test('flush() releases a trailing CR at program end', () => {
  const p = new AnsiParser();
  p.push('x\r');
  assert.deepEqual(p.flush(), [{ type: 'cr' }]);
});

test('SGR colours and resets', () => {
  const tokens = new AnsiParser().push('\u001b[31mred\u001b[0m plain \u001b[1;92mbold green\u001b[39m');
  const t = tokens.filter((x) => x.type === 'text') as Extract<AnsiToken, { type: 'text' }>[];
  assert.equal(t[0]!.style.fg, 'var(--ansi-1)');
  assert.equal(t[1]!.style.fg, null);
  assert.equal(t[2]!.style.fg, 'var(--ansi-10)');
  assert.equal(t[2]!.style.bold, true);
});

test('256-colour and truecolour', () => {
  const tokens = new AnsiParser().push('\u001b[38;5;196ma\u001b[38;2;1;2;3mb\u001b[48;5;232mc') as Extract<AnsiToken, { type: 'text' }>[];
  assert.equal(tokens[0]!.style.fg, '#ff0000');
  assert.equal(tokens[1]!.style.fg, '#010203');
  assert.equal(tokens[2]!.style.bg, '#080808');
});

test('an escape sequence split across chunks is not rendered as garbage', () => {
  const p = new AnsiParser();
  const out = [...p.push('ok \u001b[3'), ...p.push('1mred')];
  assert.equal(texts(out), 'ok red');
  assert.equal((out.at(-1) as Extract<AnsiToken, { type: 'text' }>).style.fg, 'var(--ansi-1)');
});

test('erase-line and unknown CSI sequences', () => {
  assert.equal(texts(new AnsiParser().push('abc\u001b[2Kdef\u001b[10;5Hghi')), 'abc<clear-line>defghi');
});

test('bare ESC and backspace do not leak into text', () => {
  assert.equal(texts(new AnsiParser().push('a\u001bb\bc')), 'abc');
});
