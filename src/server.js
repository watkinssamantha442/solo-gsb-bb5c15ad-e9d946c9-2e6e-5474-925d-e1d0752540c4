'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { solve, buildReport, buildExport, SolverError } = require('./solver');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// 最小解锁恢复诊断的节点预算（可用环境变量覆盖；缺省由求解器内置默认值决定）。
const DIAGNOSTIC_NODE_BUDGET = Number(process.env.DIAGNOSTIC_NODE_BUDGET) || undefined;

// 恢复方案的最差视型：全部约束中改后比值最低者（并列取靠前的约束）。
function worstProfileOf(report) {
  let worst = null;
  for (const c of report.constraints) {
    if (!worst || c.afterRatio < worst.ratio) {
      worst = { profile: c.worstProfile, ratio: c.afterRatio };
    }
  }
  return worst;
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/solve', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: '请求体必须是 JSON 对象' });
    }
    const { payload, locks } = body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: '缺少 payload（调色板 JSON）' });
    }

    const options = {};
    if (DIAGNOSTIC_NODE_BUDGET) options.diagnosticNodeBudget = DIAGNOSTIC_NODE_BUDGET;
    const result = solve(payload, locks, options);

    if (result.status === 'optimal') {
      result.report = buildReport(payload, locks, result.assignment);
      result.export = buildExport(payload, result.assignment);
    } else if (result.status === 'search-limit' && result.best) {
      result.report = buildReport(payload, locks, result.best.assignment);
      result.export = buildExport(payload, result.best.assignment);
    }
    // 最小解锁恢复：为每个返回集合补充改色明细报告与恢复后方案的最差视型。
    if (result.recovery && Array.isArray(result.recovery.sets)) {
      for (const set of result.recovery.sets) {
        set.report = buildReport(payload, set.locks, set.assignment);
        const worst = worstProfileOf(set.report);
        set.worstProfile = worst ? worst.profile : null;
        set.worstRatio = worst ? worst.ratio : null;
      }
    }
    return res.json(result);
  } catch (err) {
    if (err instanceof SolverError) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: '服务器内部错误' });
  }
});

// 兜底返回首页（SPA 友好）。
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  // 启动提示，同时检查样例数据是否随镜像提供。
  const samplePath = path.join(__dirname, '..', 'examples', 'sample-palette.json');
  const hasSample = fs.existsSync(samplePath);
  console.log(`对比度调色板求解器已启动: http://localhost:${PORT}`);
  if (hasSample) console.log(`样例数据位于: examples/sample-palette.json`);
});
