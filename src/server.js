'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { solve, buildReport, buildExport, SolverError } = require('./solver');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

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

    const result = solve(payload, locks);

    if (result.status === 'optimal') {
      result.report = buildReport(payload, locks, result.assignment);
      result.export = buildExport(payload, result.assignment);
    } else if (result.status === 'search-limit' && result.best) {
      result.report = buildReport(payload, locks, result.best.assignment);
      result.export = buildExport(payload, result.best.assignment);
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
