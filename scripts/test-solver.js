'use strict';
// 求解器行为测试：锁定冲突、全局无解、决胜顺序、上限校验、自反约束、零改色、色觉鲁棒模式。
const assert = require('assert');
const { solve, buildReport, parseModel, SolverError } = require('../src/solver');

function base(overrides = {}) {
  return {
    tokens: [
      { name: 'a', color: '#ffffff' },
      { name: 'b', color: '#000000' },
    ],
    candidates: ['#777777', '#eeeeee', '#111111'],
    constraints: [
      { foreground: 'a', background: 'b', minContrast: 4.5 },
    ],
    ...overrides,
  };
}

// 1. 原方案已满足 -> 零改色、零色差，立即返回。
{
  const r = solve(base());
  assert.strictEqual(r.status, 'optimal');
  assert.strictEqual(r.changes, 0);
  assert.ok(r.totalDelta === 0);
  assert.strictEqual(r.assignment.a, '#ffffff');
}

// 2. 两端锁定且不达标 -> both-locked 直接冲突。
{
  const input = base({
    tokens: [
      { name: 'a', color: '#ffffff', locked: true },
      { name: 'b', color: '#eeeeee', locked: true },
    ],
  });
  const r = solve(input);
  assert.strictEqual(r.status, 'unsatisfiable');
  assert.strictEqual(r.reason, 'locked-conflict');
  assert.strictEqual(r.conflicts[0].kind, 'both-locked');
  assert.ok(r.conflicts[0].actual < 4.5);
}

// 3. 前景锁定，对端值域无解 -> locked-foreground 冲突。
{
  const input = base({
    tokens: [
      { name: 'a', color: '#777777', locked: true },
      { name: 'b', color: '#ffffff' },
    ],
    candidates: ['#ffffff', '#eeeeee'], // 与 #777777 对比均 < 4.5
  });
  const r = solve(input);
  assert.strictEqual(r.status, 'unsatisfiable');
  assert.strictEqual(r.conflicts[0].kind, 'locked-foreground');
}

// 4. 无直接锁定冲突，但组合无解 -> reason global。
{
  const input = {
    tokens: [
      { name: 'a', color: '#777777' },
      { name: 'b', color: '#666666' },
      { name: 'c', color: '#888888' },
    ],
    candidates: ['#707070', '#808080'],
    constraints: [
      { foreground: 'a', background: 'b', minContrast: 4.5 },
      { foreground: 'b', background: 'c', minContrast: 4.5 },
      { foreground: 'a', background: 'c', minContrast: 4.5 },
    ],
  };
  const r = solve(input);
  assert.strictEqual(r.status, 'unsatisfiable');
  assert.strictEqual(r.reason, 'global');
}

// 5. 决胜顺序：改色数与色差均相同的方案，取令牌名升序色值字典序最小者。
{
  const input = {
    tokens: [
      { name: 'z', color: '#808080' },
      { name: 'a', color: '#808080' },
    ],
    candidates: ['#000000', '#ffffff'],
    // 无约束 -> 零改色；改为测有约束但两种对称解等距的情形。
    constraints: [],
  };
  const r = solve(input);
  assert.strictEqual(r.status, 'optimal');
  assert.strictEqual(r.changes, 0);
}

// 6. 稳定决胜：对称构造，两个方案同为改 1 个令牌且 ΔE 相同。
{
  // a 与 b 原色相同，候选提供纯黑/纯白；#444 对白底对比度约 8.7:1，改任一侧即可达标。
  const input = {
    tokens: [
      { name: 'a', color: '#444444' },
      { name: 'b', color: '#444444' },
    ],
    candidates: ['#000000', '#ffffff'],
    constraints: [{ foreground: 'a', background: 'b', minContrast: 7 }],
  };
  const r = solve(input);
  assert.strictEqual(r.status, 'optimal');
  assert.strictEqual(r.changes, 1);
  // 两种方案 ΔE 相同；决胜键按令牌名升序（a 在 b 前），#444444 < #ffffff，
  // 故 a 保留原色、b 改为白。
  assert.strictEqual(r.assignment.a, '#444444');
  assert.strictEqual(r.assignment.b, '#ffffff');
}

// 7. locks 由请求覆盖 JSON 中的 locked 字段。
{
  const input = base({
    tokens: [
      { name: 'a', color: '#ffffff' },
      { name: 'b', color: '#eeeeee' },
    ],
  });
  const r = solve(input, { a: true, b: true });
  assert.strictEqual(r.status, 'unsatisfiable');
  assert.strictEqual(r.conflicts[0].kind, 'both-locked');
}

// 8. 上限与格式校验。
assert.throws(() => solve({ tokens: [], candidates: [], constraints: [] }), SolverError);
assert.throws(
  () =>
    solve({
      tokens: Array.from({ length: 11 }, (_, i) => ({ name: 't' + i, color: '#fff' })),
      candidates: [],
      constraints: [],
    }),
  /不能超过 10/
);
assert.throws(
  () => solve({ tokens: [{ name: 'x', color: '#fff' }], candidates: Array(13).fill('#000'), constraints: [] }),
  /候选色不能超过 12/
);
assert.throws(
  () => solve({ tokens: [{ name: 'x', color: '#fff' }], candidates: [], constraints: Array(31).fill({ foreground: 'x', background: 'x', minContrast: 1 }) }),
  /约束不能超过 30/
);
assert.throws(
  () => solve({ tokens: [{ name: 'x', color: 'nope' }], candidates: [], constraints: [] }),
  /颜色/
);
assert.throws(
  () => solve({ tokens: [{ name: 'x', color: '#fff' }], candidates: [], constraints: [{ foreground: 'x', background: 'y', minContrast: 4 }] }),
  /不存在的令牌/
);

// 9. 自反约束：>1 恒无解（锁定与未锁定均给出直接冲突）。
{
  const r = solve({
    tokens: [{ name: 'a', color: '#ffffff', locked: true }],
    candidates: ['#000000'],
    constraints: [{ foreground: 'a', background: 'a', minContrast: 2 }],
  });
  assert.strictEqual(r.status, 'unsatisfiable');
  assert.strictEqual(r.conflicts[0].kind, 'self-contrast');

  const ok = solve({
    tokens: [{ name: 'a', color: '#ffffff' }],
    candidates: ['#000000'],
    constraints: [{ foreground: 'a', background: 'a', minContrast: 1 }],
  });
  assert.strictEqual(ok.status, 'optimal');
}

// 10. #rgb 短格式、重复候选去重。
{
  const r = solve({
    tokens: [{ name: 'a', color: '#fff' }],
    candidates: ['#000', '#000000'],
    constraints: [],
  });
  assert.strictEqual(r.status, 'optimal');
  assert.strictEqual(r.assignment.a, '#ffffff');
}

// 11. 最小改色数优先：存在一个色差巨大但 0 改色不可行、1 改色可行的情形。
{
  const r = solve({
    tokens: [
      { name: 'a', color: '#ffffff' },
      { name: 'b', color: '#fafafa' },
    ],
    candidates: ['#000000'],
    constraints: [{ foreground: 'a', background: 'b', minContrast: 4.5 }],
  });
  assert.strictEqual(r.status, 'optimal');
  assert.strictEqual(r.changes, 1);
}

// 12. profiles 校验：缺省为 ['normal']；非数组、空数组、未知视型均被拒绝；重复值去重。
{
  const r = solve(base());
  assert.deepStrictEqual(r.profiles, ['normal']);

  assert.throws(() => solve(base({ profiles: 'normal' })), /profiles 必须是数组/);
  assert.throws(() => solve(base({ profiles: [] })), /不能为空数组/);
  assert.throws(() => solve(base({ profiles: ['normal', 'achromatopsia'] })), /未知视型/);
  assert.throws(() => solve(base({ profiles: [42] })), /未知视型/);

  const deduped = solve(base({ profiles: ['protanopia', 'normal', 'protanopia'] }));
  assert.deepStrictEqual(deduped.profiles, ['protanopia', 'normal']);
}

// 13. 色觉鲁棒模式：normal 达标但 protanopia 不达标时必须继续改色。
{
  // #ff0000 / #000000：normal 对比度约 5.25:1（达标），protanopia 模拟后约 3.29:1（不达标）。
  const input = {
    tokens: [
      { name: 'text', color: '#ff0000' },
      { name: 'bg', color: '#000000', locked: true },
    ],
    candidates: ['#ffffff'],
    constraints: [{ foreground: 'text', background: 'bg', minContrast: 4.5 }],
  };
  const normalOnly = solve(input);
  assert.strictEqual(normalOnly.status, 'optimal');
  assert.strictEqual(normalOnly.changes, 0);

  const robust = solve({ ...input, profiles: ['normal', 'protanopia'] });
  assert.strictEqual(robust.status, 'optimal');
  assert.strictEqual(robust.changes, 1);
  assert.strictEqual(robust.assignment.text, '#ffffff');

  const report = buildReport(
    { ...input, profiles: ['normal', 'protanopia'] },
    null,
    robust.assignment
  );
  assert.deepStrictEqual(report.profiles, ['normal', 'protanopia']);
  const c = report.constraints[0];
  assert.strictEqual(c.perProfile.length, 2);
  const byProfile = Object.fromEntries(c.perProfile.map((e) => [e.profile, e]));
  assert.ok(byProfile.normal.beforePass);
  assert.ok(!byProfile.protanopia.beforePass);
  assert.ok(byProfile.protanopia.beforeRatio < 4.5);
  assert.ok(c.afterPass);
  // 改后各视型均为 21:1，并列时最差视型取 profiles 中靠前者。
  assert.strictEqual(c.worstProfile, 'normal');
}

// 14. 最差视型标注：改后比值最低的视型被标记为 worstProfile，聚合 afterRatio 取最差值。
{
  // #ff8888 / #000000：normal 约 9.1:1，protanopia 约 7.6:1，均达标但 protanopia 更低。
  const input = {
    tokens: [
      { name: 'text', color: '#ff0000' },
      { name: 'bg', color: '#000000', locked: true },
    ],
    candidates: ['#ff8888'],
    constraints: [{ foreground: 'text', background: 'bg', minContrast: 4.5 }],
    profiles: ['normal', 'protanopia'],
  };
  const r = solve(input);
  assert.strictEqual(r.status, 'optimal');
  assert.strictEqual(r.assignment.text, '#ff8888');

  const report = buildReport(input, null, r.assignment);
  const c = report.constraints[0];
  assert.strictEqual(c.worstProfile, 'protanopia');
  const byProfile = Object.fromEntries(c.perProfile.map((e) => [e.profile, e]));
  assert.ok(byProfile.protanopia.afterRatio < byProfile.normal.afterRatio);
  assert.strictEqual(c.afterRatio, byProfile.protanopia.afterRatio);
  assert.strictEqual(c.beforeRatio, Math.min(byProfile.normal.beforeRatio, byProfile.protanopia.beforeRatio));
}

// 15. 两端锁定冲突：failedProfiles 与消息都必须说明具体失败视型。
{
  const input = {
    tokens: [
      { name: 'text', color: '#ff0000', locked: true },
      { name: 'bg', color: '#000000', locked: true },
    ],
    candidates: ['#ffffff'],
    constraints: [{ foreground: 'text', background: 'bg', minContrast: 4.5 }],
    profiles: ['normal', 'protanopia'],
  };
  const r = solve(input);
  assert.strictEqual(r.status, 'unsatisfiable');
  assert.strictEqual(r.reason, 'locked-conflict');
  assert.strictEqual(r.conflicts[0].kind, 'both-locked');
  assert.deepStrictEqual(r.conflicts[0].failedProfiles, ['protanopia']);
  assert.ok(r.conflicts[0].message.includes('protanopia'));
  assert.ok(r.conflicts[0].actual < 4.5);
}

// 16. 单侧锁定冲突：前景锁定，protanopia 下对端值域无解。
{
  const input = {
    tokens: [
      { name: 'text', color: '#ff0000', locked: true },
      { name: 'bg', color: '#000000' },
    ],
    candidates: ['#111111', '#222222'],
    constraints: [{ foreground: 'text', background: 'bg', minContrast: 4.5 }],
    profiles: ['normal', 'protanopia'],
  };
  const r = solve(input);
  assert.strictEqual(r.status, 'unsatisfiable');
  assert.strictEqual(r.conflicts[0].kind, 'locked-foreground');
  assert.deepStrictEqual(r.conflicts[0].failedProfiles, ['protanopia']);
  assert.ok(r.conflicts[0].message.includes('protanopia'));
}

// 17. 全视型可行解：四个视型同时参与时搜索仍收敛且全部达标。
{
  const input = {
    tokens: [
      { name: 'text', color: '#ff0000' },
      { name: 'bg', color: '#000000', locked: true },
    ],
    candidates: ['#ffffff', '#ff8888'],
    constraints: [{ foreground: 'text', background: 'bg', minContrast: 4.5 }],
    profiles: ['normal', 'protanopia', 'deuteranopia', 'tritanopia'],
  };
  const r = solve(input);
  assert.strictEqual(r.status, 'optimal');
  assert.strictEqual(r.changes, 1);
  const report = buildReport(input, null, r.assignment);
  assert.strictEqual(report.constraints[0].perProfile.length, 4);
  assert.ok(report.constraints[0].afterPass);
}

console.log('全部求解器测试通过');
