// The Markdown-to-Telegram-HTML rendering: what a model writes is what the reader sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdToHtml } from '../lib/markdown.mjs';

test('headings, emphasis, code, links and bullets become Telegram HTML', () => {
  const html = mdToHtml('## Title\n\n**bold** and *it* and `a<b`\n- one\n* two\nSee [x](https://e.com/?a=1&b=2).');
  assert.equal(html, '<b>Title</b>\n\n<b>bold</b> and <i>it</i> and <code>a&lt;b</code>\n• one\n• two\nSee <a href="https://e.com/?a=1&amp;b=2">x</a>.');
});

test('a fenced block is a pre, escaped, and a table is aligned monospaced text', () => {
  assert.equal(mdToHtml('```js\nif (a < b) {}\n```'), '<pre><code class="language-js">if (a &lt; b) {}</code></pre>');
  assert.equal(mdToHtml('| Name | Price |\n|---|---|\n| **Oil** | $103 |'), '<pre>Name  Price\nOil   $103</pre>');
});

test('unpaired markers and identifiers are left alone; the model cannot inject a tag', () => {
  assert.equal(mdToHtml('a ** b and snake_case and 2*3*4 and `open'), 'a ** b and snake_case and 2*3*4 and `open');
  assert.equal(mdToHtml('<script>x</script> & <b>'), '&lt;script&gt;x&lt;/script&gt; &amp; &lt;b&gt;');
});

test('a quote and a rule', () => {
  assert.equal(mdToHtml('> note\n---\nend'), '<blockquote>note</blockquote>\n———\nend');
});
