'use strict';
// 临时验证脚本：求解样例、检查改色/色差/约束明细。
const fs = require('fs');
const path = require('path');
const { solve, buildReport, buildExport } = require('../src/solver');
const { contrastRatio } = require('../src/color');

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'examples', 'sample-palette.json'), 'utf8')
);

const result = solve(sample, {});
console.log(JSON.stringify(result, null, 2));

if (result.status === 'optimal') {
  const report = buildReport(sample, {}, result.assignment);
  console.log('REPORT', JSON.stringify(report, null, 2));
  // 验证所有约束通过
  for (const c of report.constraints) {
    if (!c.afterPass) throw new Error('约束未通过: ' + JSON.stringify(c));
  }
  // 暴力校验最优：枚举全部赋值（值域较小）
  const { parseModel } = require('../src/solver');
  const model = parseModel(sample, {});
  const { deltaE } = require('../src/color');
  const names = model.tokenNames;
  const doms = names.map((n) => model.tokens.get(n).domain);
  const idx = Object.fromEntries(names.map((n, i) => [n, i]));
  let best = null;
  function rec(i, assign) {
    if (i === names.length) {
      let changes = 0, d = 0;
      for (const n of names) {
        const t = model.tokens.get(n);
        if (assign[n] !== t.original) { changes++; d += deltaE(t.original, assign[n]); }
      }
      for (const con of model.constraints) {
        if (contrastRatio(assign[con.a], assign[con.b]) + 1e-9 < con.min) return;
      }
      const key = [...names].sort().map((n) => assign[n]).join('|');
      if (!best || changes < best.changes ||
        (changes === best.changes && (d < best.d - 1e-9 ||
        (Math.abs(d - best.d) <= 1e-9 && key < best.key)))) {
        best = { changes, d, key, assign: { ...assign } };
      }
      return;
    }
    for (const c of doms[i]) { assign[names[i]] = c; rec(i + 1, assign); }
  }
  rec(0, {});
  console.log('BRUTE BEST', best.changes, best.d, best.key);
  const solverKey = [...names].sort().map((n) => result.assignment[n]).join('|');
  console.log('MATCH changes:', best.changes === result.changes,
    'delta:', Math.abs(best.d - result.totalDelta) < 1e-6,
    'key:', best.key === solverKey);
}
