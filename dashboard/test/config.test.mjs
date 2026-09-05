import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, buildSkeleton } from '../lib/config.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mgs-dash-'));

test('配置文件不存在时返回 null，交给扁平模式降级', () => {
  assert.equal(loadConfig(join(dir, '不存在.json')), null);
});

test('配置文件语法坏掉时抛错，不静默降级', () => {
  // 静默降级会让人以为「本来就没配」，改错一个逗号却查不出来。
  const p = join(dir, 'broken.json');
  writeFileSync(p, '{ "groups": [ }');

  assert.throws(() => loadConfig(p), /broken\.json/);
});

test('toggle 卡片缺 on/off 时抛错并指出是哪张卡', () => {
  const p = join(dir, 'incomplete.json');
  writeFileSync(p, JSON.stringify({ groups: [{ title: '客厅', cards: [{ kind: 'toggle', title: '观影模式', scope: 'global', id: 'xggCinema' }] }] }));

  assert.throws(() => loadConfig(p), /观影模式/);
});

test('合法配置原样读出来', () => {
  const cfg = { groups: [{ title: '客厅', cards: [{ kind: 'rule', title: '光亮灯灭', ruleId: '1' }] }] };
  const p = join(dir, 'good.json');
  writeFileSync(p, JSON.stringify(cfg));

  assert.deepEqual(loadConfig(p), cfg);
});

const snapshot = {
  fetchedAt: '2026-09-05T10:00:00.000Z',
  variables: {
    global: {
      xggCinema: { type: 'number', value: 1, name: '观影模式' },
      xggLivingLux: { type: 'number', value: 50, name: '客厅照度阈值' },
    },
    R20260822110: { step: { type: 'number', value: 3, name: '当前步骤' } },
  },
  rules: { '20260822110': { id: '20260822110', name: '光亮灯灭', enable: true } },
};

test('骨架把匹配 runtimeVars 的 0/1 全局变量生成成可翻的开关', () => {
  const cfg = buildSkeleton(snapshot, { runtimePatterns: ['^xggCinema$'] });

  const card = cfg.groups.find((g) => g.title === 'global').cards.find((c) => c.id === 'xggCinema');
  assert.deepEqual(card, { kind: 'toggle', title: '观影模式', scope: 'global', id: 'xggCinema', on: 1, off: 0 });
});

test('骨架把不匹配 runtimeVars 的全局变量生成成只读', () => {
  const cfg = buildSkeleton(snapshot, { runtimePatterns: ['^xggCinema$'] });

  const card = cfg.groups.find((g) => g.title === 'global').cards.find((c) => c.id === 'xggLivingLux');
  assert.equal(card.kind, 'readonly');
});

test('规则域变量一律只读，绝不生成成可翻的开关', () => {
  // R 开头的 scope 是规则内部状态。翻它们等于伸手进规则肚子里，
  // 不是住户该在看板上做的事 —— 哪怕 mgs 把它们算作运行时变量。
  const cfg = buildSkeleton(snapshot, { runtimePatterns: ['.*'] });

  const group = cfg.groups.find((g) => g.title === 'R20260822110');
  assert.equal(group.cards.every((c) => c.kind === 'readonly'), true);
});

test('骨架把全部规则生成成一组只读卡片', () => {
  const cfg = buildSkeleton(snapshot, { runtimePatterns: [] });

  assert.deepEqual(cfg.groups.find((g) => g.title === '规则').cards, [
    { kind: 'rule', title: '光亮灯灭', ruleId: '20260822110' },
  ]);
});

test('生成的骨架自己能通过校验', () => {
  const p = join(dir, 'skeleton.json');
  writeFileSync(p, JSON.stringify(buildSkeleton(snapshot, { runtimePatterns: ['^xgg'] })));

  assert.doesNotThrow(() => loadConfig(p));
});
