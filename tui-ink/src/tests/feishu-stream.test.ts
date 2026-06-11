import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitForStreaming, buildAnswerCard } from '../feishu/message.js';

describe('splitForStreaming', () => {
  it('空字符串返回 []', () => {
    assert.deepEqual(splitForStreaming(''), []);
    assert.deepEqual(splitForStreaming('   '), []);
  });

  it('单句文本返回 [text]', () => {
    const r = splitForStreaming('你好。');
    assert.equal(r.join(''), '你好。');
    assert.ok(r.length >= 1);
  });

  it('多段落：拼合回原文', () => {
    const text = '第一段内容，包含一些文字。\n\n第二段内容，包含更多文字。\n\n第三段。';
    const r = splitForStreaming(text);
    assert.equal(r.join(''), text);
    assert.ok(r.length >= 2, `expected ≥2 segments, got ${r.length}`);
  });

  it('英文长句：拼合回原文', () => {
    const text = 'This is the first sentence. This is the second. And a third one here.';
    const r = splitForStreaming(text);
    assert.equal(r.join(''), text);
  });

  it('超过 12 段时上限为 12', () => {
    const parts = Array.from({ length: 20 }, (_, i) => `第${i + 1}句，内容足够长以通过最小长度检测。`);
    const text = parts.join('\n\n');
    const r = splitForStreaming(text);
    assert.ok(r.length <= 12, `expected ≤12, got ${r.length}`);
    assert.equal(r.join(''), text);
  });

  it('中英混排：拼合回原文', () => {
    const text = '今天天气不错。Let us go outside! 下午可以去公园。Really fun.';
    const r = splitForStreaming(text);
    assert.equal(r.join(''), text);
  });
});

describe('buildAnswerCard', () => {
  it('占位状态（空 accumulated）：显示思考中文案', () => {
    const card = buildAnswerCard('', false);
    assert.equal(card.header?.template, 'blue');
    assert.ok(card.header?.title.content.includes('回复中'));
    const body = card.elements?.[0]?.content ?? '';
    assert.ok(body.includes('正在思考'), `expected "正在思考" in "${body}"`);
  });

  it('进行中：header blue，内容末尾有光标', () => {
    const card = buildAnswerCard('部分回复', false);
    assert.equal(card.header?.template, 'blue');
    assert.ok(card.elements?.[0]?.content?.endsWith('▋'));
  });

  it('完成：header green，无光标，有 footer', () => {
    const card = buildAnswerCard('完整回复内容。', true, 1234);
    assert.equal(card.header?.template, 'green');
    assert.equal(card.header?.title.content, '回复');
    assert.ok(!card.elements?.[0]?.content?.includes('▋'));
    const noteEl = card.elements?.find((e) => e.tag === 'note');
    assert.ok(noteEl, 'should have a note element');
    assert.ok(noteEl?.elements?.[0]?.content?.includes('1.2s'), `note should contain elapsed: ${noteEl?.elements?.[0]?.content}`);
  });

  it('完成但无 elapsedMs：无 footer', () => {
    const card = buildAnswerCard('回复', true);
    const hrEl = card.elements?.find((e) => e.tag === 'hr');
    assert.equal(hrEl, undefined);
  });
});
