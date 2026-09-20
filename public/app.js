'use strict';

// 对比度调色板求解器前端（原生 JS，无外部依赖）。
// 页面只与同源的本机 Express 服务通信，数据不离开本机。
//
// 状态提交模型：输入、文件导入、示例载入与求解都通过 commitInput() 提交，
// 每次提交分配严格递增的版本号；提交时先清理旧结果，再原子更新 parsed、
// parseError 可见性、锁定/视型面板与求解按钮。异步流程（文件读取、示例
// 请求、求解响应）完成时必须仍持有最新版本才允许写回，避免较早开始的
// 异步操作覆盖更新后的输入（竞态乱序）。

const $ = (id) => document.getElementById(id);

const els = {
  jsonInput: $('jsonInput'),
  fileInput: $('fileInput'),
  loadSampleBtn: $('loadSampleBtn'),
  solveBtn: $('solveBtn'),
  parseError: $('parseError'),
  tokenLocks: $('tokenLocks'),
  profileList: $('profileList'),
  inputMeta: $('inputMeta'),
  resultPlaceholder: $('resultPlaceholder'),
  resultArea: $('resultArea'),
  resultSummary: $('resultSummary'),
  constraintTable: $('constraintTable'),
  tokenTable: $('tokenTable'),
  exportBtn: $('exportBtn'),
  conflictArea: $('conflictArea'),
  conflictIntro: $('conflictIntro'),
  conflictList: $('conflictList'),
  limitArea: $('limitArea'),
};

let parsed = null; // 最近一次成功解析的 JSON 对象
let lastExport = null; // 最近一次最优解的导出对象
// 单调递增的前端状态版本号：每次新输入意图或求解开始时 +1。
let inputVersion = 0;

const LIMITS = { tokens: 10, candidates: 12, constraints: 30 };

// 色觉鲁棒模式支持的视型（与服务端一致）。
const KNOWN_PROFILES = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];
const PROFILE_LABELS = {
  normal: 'normal（正常视觉）',
  protanopia: 'protanopia（红色盲）',
  deuteranopia: 'deuteranopia（绿色盲）',
  tritanopia: 'tritanopia（蓝黄色盲）',
};

// ---------- 版本化状态提交 ----------

// 开始一个新的输入意图（用户正在编辑/选择文件/点击示例）：分配新版本并
// 立刻清理旧结果与错误。返回的版本号用于异步完成时校验是否仍为最新。
function beginInput() {
  inputVersion += 1;
  clearResultViews();
  return inputVersion;
}

function isCurrent(version) {
  return version === inputVersion;
}

// 统一提交入口：解析当前 textarea，并原子更新全部派生视图。
// 由输入、文件导入、示例载入、面板勾选与求解前校验共同使用。
function commitInput() {
  const result = evaluateInput();
  applyCommit(result);
  return result;
}

function evaluateInput() {
  const text = els.jsonInput.value.trim();
  if (!text) return { data: null, error: null };
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { data: null, error: 'JSON 语法错误：' + err.message };
  }
  const problem = validateShape(data);
  if (problem) return { data: null, error: problem };
  return { data, error: null };
}

// 先清理旧结果（在 commitInput 场景下通常已由 beginInput 完成），
// 再原子写入 parsed、parseError、锁定/视型面板与求解按钮可用性。
function applyCommit(result) {
  clearResultViews();
  parsed = result.data;
  if (result.error) {
    showParseError(result.error);
  } else {
    els.parseError.hidden = true;
    els.parseError.textContent = '';
  }
  refreshLockPanel();
}

function showParseError(msg) {
  els.parseError.textContent = msg;
  els.parseError.hidden = false;
}

// 仅清理结果区与旧的求解产物；parseError 由 applyCommit / 成功渲染统一管理，
// 绝不在识别出无效输入后再被顺手隐藏。
function clearResultViews() {
  els.resultPlaceholder.hidden = false;
  els.resultPlaceholder.textContent = '运行求解后在此查看结果。';
  els.resultArea.hidden = true;
  els.conflictArea.hidden = true;
  els.limitArea.hidden = true;
  lastExport = null;
}

// ---------- 前端校验 ----------

// 轻量前端校验（服务端会做同样的严格校验，此处仅为提前反馈）。
function validateShape(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return '输入必须是 JSON 对象。';
  }
  if (!Array.isArray(data.tokens)) return '缺少 tokens 数组。';
  if (!Array.isArray(data.candidates)) return '缺少 candidates 数组。';
  if (!Array.isArray(data.constraints)) return '缺少 constraints 数组。';
  if (data.tokens.length < 1 || data.tokens.length > LIMITS.tokens) {
    return `令牌数量必须在 1–${LIMITS.tokens} 之间（当前 ${data.tokens.length}）。`;
  }
  if (data.candidates.length > LIMITS.candidates) {
    return `候选色最多 ${LIMITS.candidates} 个（当前 ${data.candidates.length}）。`;
  }
  if (data.constraints.length > LIMITS.constraints) {
    return `约束最多 ${LIMITS.constraints} 条（当前 ${data.constraints.length}）。`;
  }
  const names = new Set();
  for (let i = 0; i < data.tokens.length; i++) {
    const t = data.tokens[i];
    if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.name) {
      return `tokens[${i}] 缺少有效的 name。`;
    }
    if (names.has(t.name)) return `令牌名 "${t.name}" 重复。`;
    names.add(t.name);
    if (typeof t.color !== 'string' || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t.color.trim())) {
      return `tokens[${i}] (${t.name}) 的 color 不是 #rgb/#rrggbb 颜色。`;
    }
  }
  for (let i = 0; i < data.candidates.length; i++) {
    if (typeof data.candidates[i] !== 'string' ||
        !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(data.candidates[i].trim())) {
      return `candidates[${i}] 不是合法颜色。`;
    }
  }
  for (let i = 0; i < data.constraints.length; i++) {
    const c = data.constraints[i];
    if (!c || typeof c !== 'object') return `constraints[${i}] 必须是对象。`;
    if (!names.has(c.foreground) || !names.has(c.background)) {
      return `constraints[${i}] 引用了不存在的令牌。`;
    }
    const m = Number(c.minContrast);
    if (!Number.isFinite(m) || m < 1 || m > 21) {
      return `constraints[${i}].minContrast 必须是 1–21 的数字。`;
    }
  }
  if (data.profiles !== undefined) {
    if (!Array.isArray(data.profiles) || data.profiles.length === 0) {
      return 'profiles 必须是非空数组（不提供该字段时默认仅 normal）。';
    }
    for (const p of data.profiles) {
      if (typeof p !== 'string' || !KNOWN_PROFILES.includes(p)) {
        return `未知视型 "${p}"（可选：${KNOWN_PROFILES.join('、')}）。`;
      }
    }
  }
  return null;
}

// ---------- 锁定 / 视型面板 ----------

function refreshLockPanel() {
  els.tokenLocks.innerHTML = '';
  els.solveBtn.disabled = !parsed;
  if (!parsed) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '尚未载入有效数据。';
    els.tokenLocks.appendChild(empty);
    els.inputMeta.textContent = '';
    refreshProfilePanel();
    return;
  }
  for (const t of parsed.tokens) {
    const item = document.createElement('div');
    item.className = 'lock-item' + (t.locked ? ' is-locked' : '');

    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.locked === true;
    cb.dataset.name = t.name;
    cb.addEventListener('change', () => {
      if (!parsed) return;
      t.locked = cb.checked;
      item.classList.toggle('is-locked', cb.checked);
      // 锁定状态同步回文本框中的 JSON，并按新版本统一提交
      // （若有求解在途，其响应会因版本过期而被丢弃）。
      syncParsedIntoText();
      beginInput();
      commitInput();
    });

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = t.color;

    const textWrap = document.createElement('span');
    const nameEl = document.createElement('div');
    nameEl.className = 'lock-name';
    nameEl.textContent = t.name;
    const hexEl = document.createElement('div');
    hexEl.className = 'lock-hex';
    hexEl.textContent = t.color;
    textWrap.append(nameEl, hexEl);

    label.append(cb, swatch, textWrap);
    item.appendChild(label);
    els.tokenLocks.appendChild(item);
  }
  els.inputMeta.textContent =
    `${parsed.tokens.length} 个令牌 · ${parsed.candidates.length} 个候选色 · ${parsed.constraints.length} 条约束`;
  refreshProfilePanel();
}

// 当前生效的视型：未提供 profiles 时等同仅 normal；按固定顺序返回。
function currentProfiles() {
  if (!parsed || !Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
    return ['normal'];
  }
  const set = new Set(parsed.profiles);
  return KNOWN_PROFILES.filter((p) => set.has(p));
}

function refreshProfilePanel() {
  els.profileList.innerHTML = '';
  const selected = new Set(currentProfiles());
  for (const id of KNOWN_PROFILES) {
    const item = document.createElement('div');
    item.className = 'profile-item' + (selected.has(id) ? ' is-active' : '');

    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(id);
    cb.disabled = !parsed;
    cb.dataset.profile = id;
    cb.addEventListener('change', () => {
      if (!parsed) {
        cb.checked = true;
        return;
      }
      const boxes = els.profileList.querySelectorAll('input[type="checkbox"]');
      const chosen = KNOWN_PROFILES.filter((p) =>
        [...boxes].some((b) => b.dataset.profile === p && b.checked)
      );
      if (chosen.length === 0) {
        cb.checked = true;
        showParseError('至少保留一个视型；不提供 profiles 字段时默认仅 normal。');
        return;
      }
      // 以固定顺序写回 JSON（仅 normal 时移除该字段，回到缺省语义），
      // 随后作为一次新版本的输入意图统一提交。
      if (chosen.length === 1 && chosen[0] === 'normal') {
        delete parsed.profiles;
      } else {
        parsed.profiles = chosen;
      }
      syncParsedIntoText();
      beginInput();
      commitInput();
    });

    const text = document.createElement('span');
    text.textContent = PROFILE_LABELS[id];

    label.append(cb, text);
    item.appendChild(label);
    els.profileList.appendChild(item);
  }
}

// 将面板上的锁定勾选与视型选择状态回写到 textarea 的 JSON 文本。
function syncParsedIntoText() {
  if (!parsed) return;
  try {
    els.jsonInput.value = JSON.stringify(parsed, null, 2);
  } catch (_) {
    /* 文本仅作展示，失败时保持原样 */
  }
}

// ---------- 文件导入 / 示例（异步，版本保护） ----------

els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  // 无论后续读取成功与否，清空文件选择，避免同名文件无法再次触发 change。
  els.fileInput.value = '';
  if (!file) return;
  // 读取开始即占用新版本：读取期间的任何编辑都比该文件更新。
  const version = beginInput();
  try {
    const text = await file.text();
    if (!isCurrent(version)) return; // 读取期间用户又改了输入，丢弃旧文件
    els.jsonInput.value = text;
    commitInput();
  } catch (err) {
    if (!isCurrent(version)) return;
    parsed = null;
    clearResultViews();
    showParseError('读取文件失败：' + err.message);
    refreshLockPanel();
  }
});

els.loadSampleBtn.addEventListener('click', async () => {
  // 点击即占用新版本；先给出加载提示。
  const version = beginInput();
  els.resultPlaceholder.textContent = '正在载入示例…';
  try {
    const res = await fetch('/sample-palette.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!isCurrent(version)) return; // 较晚开始/更早返回的其他输入已生效
    els.jsonInput.value = JSON.stringify(data, null, 2);
    commitInput();
  } catch (err) {
    if (!isCurrent(version)) return;
    parsed = null;
    clearResultViews();
    showParseError('载入示例失败：' + err.message);
    refreshLockPanel();
  }
});

els.jsonInput.addEventListener('input', () => {
  beginInput();
  commitInput();
});

// ---------- 求解（异步，版本保护） ----------

els.solveBtn.addEventListener('click', async () => {
  // 求解前以当前文本做一次权威提交（错误须持续可见且禁用按钮）。
  const committed = commitInput();
  const data = committed.data;
  if (!data) return;

  const locks = {};
  for (const t of data.tokens) locks[t.name] = t.locked === true;

  // 求解占用新版本：期间到达的输入会作废本次响应。
  const version = beginInput();
  els.solveBtn.disabled = true;
  els.resultPlaceholder.innerHTML = '<span class="spinner"></span>正在进行全局分支定界搜索…';
  els.resultPlaceholder.hidden = false;

  try {
    const res = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: data, locks }),
    });
    const body = await res.json();
    if (!isCurrent(version)) return; // 求解期间用户修改/重新导入了输入
    if (!res.ok) {
      // 服务端 400（校验失败等）错误保持可见，直到下次有效提交。
      clearResultViews();
      showParseError(body.error || '求解失败');
      return;
    }
    renderResult(body);
  } catch (err) {
    if (!isCurrent(version)) return;
    clearResultViews();
    showParseError('请求本地服务失败：' + err.message);
  } finally {
    if (isCurrent(version)) els.solveBtn.disabled = false;
  }
});

// ---------- 结果渲染 ----------

function renderResult(body) {
  // 成功渲染结果时清除任何残留错误（如之前的服务端 400）。
  els.parseError.hidden = true;
  els.parseError.textContent = '';
  els.resultPlaceholder.hidden = true;

  if (body.status === 'unsatisfiable') {
    renderConflicts(body);
    return;
  }

  if (body.status === 'search-limit') {
    els.limitArea.hidden = false;
    els.limitArea.textContent = body.message || '搜索达到节点上限，以下为当前找到的最佳候选（未经最优性证明）。';
    if (!body.best || !body.report) return;
  }

  if (!body.report) return;

  els.resultArea.hidden = false;
  const reportSource = body.report;
  const changes = body.status === 'search-limit' ? body.best.changes : body.changes;
  const totalDelta = body.status === 'search-limit' ? body.best.totalDelta : body.totalDelta;

  // 概要
  els.resultSummary.innerHTML = '';
  const summary = document.createElement('div');
  summary.className = 'summary';
  summary.append(
    stat(reportSource.tokens.filter((t) => t.changed).length, '改色令牌数', true),
    stat(changes + ' / ' + reportSource.tokens.length, '改色 / 总数'),
    stat(Number(totalDelta).toFixed(2), 'CIE Lab 总色差 ΔE*ab'),
    stat(
      reportSource.constraints.filter((c) => c.afterPass).length +
        ' / ' + reportSource.constraints.length,
      '满足约束'
    ),
    stat((reportSource.profiles || []).length + ' 种', '色觉视型'),
    stat(body.stats.nodes.toLocaleString('zh-CN'), '搜索节点'),
    stat(body.stats.elapsedMs + ' ms', '耗时')
  );
  els.resultSummary.appendChild(summary);

  // 约束表：每条约束按视型逐行展示改前/改后比值，最差视型行高亮。
  els.constraintTable.innerHTML = '';
  {
    const rows = [];
    for (const c of reportSource.constraints) {
      c.perProfile.forEach((p, pi) => {
        const isWorst = c.worstProfile === p.profile;
        rows.push({
          cls: (pi === 0 ? 'group-start' : '') + (isWorst ? ' worst-profile' : ''),
          cells: [
            pi === 0 ? String(c.index + 1) : '',
            pi === 0 ? c.foreground : '',
            pi === 0 ? c.background : '',
            pi === 0 ? { num: c.minContrast } : '',
            profileCell(p.profile, isWorst),
            { num: ratioText(p.beforeRatio), cls: p.beforePass ? 'good' : 'bad' },
            '→',
            { num: ratioText(p.afterRatio), cls: p.afterPass ? 'good' : 'bad', strong: true },
            p.afterPass ? pill('满足', true) : pill('不满足', false),
          ],
        });
      });
    }
    els.constraintTable.appendChild(
      buildTable(['#', '前景', '背景', '最小对比度', '视型', '改前', '', '改后', '结果'], rows)
    );
  }

  // 令牌表
  els.tokenTable.innerHTML = '';
  els.tokenTable.appendChild(
    buildTable(
      ['令牌', '原色', '', '改后', 'ΔE', '状态'],
      reportSource.tokens.map((t) => [
        t.name + (t.locked ? ' 🔒' : ''),
        colorCell(t.original),
        t.changed ? '→' : '',
        colorCell(t.final),
        { num: t.deltaE.toFixed(2) },
        t.locked ? pill('已锁定', true) : t.changed ? pill('改色', false) : pill('保持', true),
      ])
    )
  );

  lastExport = body.export;
}

function stat(num, label, optimal) {
  const el = document.createElement('div');
  el.className = 'stat' + (optimal ? ' optimal' : '');
  const n = document.createElement('div');
  n.className = 'num';
  n.textContent = num;
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  el.append(n, l);
  return el;
}

function pill(text, pass) {
  const el = document.createElement('span');
  el.className = 'pill ' + (pass ? 'pass' : 'fail');
  el.textContent = text;
  return el;
}

function ratioText(r) {
  return r.toFixed(2) + ':1';
}

function colorCell(hex) {
  return { html: `<span class="cell-color"><span class="swatch" style="background:${hex}"></span>${hex}</span>` };
}

// 视型单元格：视型名 + （如适用）“最差视型”徽章。
function profileCell(profile, isWorst) {
  const label = PROFILE_LABELS[profile] || profile;
  return {
    html:
      `<span class="profile-name">${label}</span>` +
      (isWorst ? '<span class="worst-badge">最差视型</span>' : ''),
  };
}

function buildTable(headers, rows) {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    // 行可以是单元格数组，也可以是 { cells, cls }（cls 为行级 CSS 类）。
    const cells = Array.isArray(row) ? row : row.cells;
    const tr = document.createElement('tr');
    if (!Array.isArray(row) && row.cls) tr.className = row.cls.trim();
    for (const cell of cells) {
      const td = document.createElement('td');
      if (cell && typeof cell === 'object' && cell.html) {
        td.innerHTML = cell.html;
      } else if (cell && typeof cell === 'object' && 'num' in cell) {
        td.classList.add('num');
        td.textContent = String(cell.num);
        if (cell.cls) td.classList.add('ratio-after', cell.cls);
        if (cell.strong) td.classList.add('strong');
      } else if (cell instanceof HTMLElement) {
        td.appendChild(cell);
      } else {
        td.textContent = cell == null ? '' : String(cell);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function renderConflicts(body) {
  els.conflictArea.hidden = false;
  els.conflictList.innerHTML = '';

  els.conflictIntro.textContent =
    body.reason === 'global'
      ? (body.message || '全局无解，且未发现由锁定颜色直接造成的冲突。')
      : '以下冲突由锁定颜色直接导致，解锁相应令牌（或更换锁定颜色）后可能恢复可行：';

  const conflicts = body.conflicts || [];
  for (const c of conflicts) {
    const li = document.createElement('li');
    const msg = document.createElement('span');
    msg.textContent = c.message || JSON.stringify(c);
    li.appendChild(msg);
    // 具体失败视型徽章
    if (Array.isArray(c.failedProfiles) && c.failedProfiles.length > 0) {
      const badges = document.createElement('span');
      badges.className = 'profile-badges';
      for (const p of c.failedProfiles) {
        const b = document.createElement('span');
        b.className = 'profile-badge';
        b.textContent = '失败视型 ' + p;
        badges.appendChild(b);
      }
      li.appendChild(badges);
    }
    els.conflictList.appendChild(li);
  }
}

// ---------- 导出 ----------

els.exportBtn.addEventListener('click', () => {
  if (!lastExport) return;
  const blob = new Blob([JSON.stringify(lastExport, null, 2) + '\n'], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (lastExport.name ? String(lastExport.name) : 'palette') + '-solved.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ---------- 初始化 ----------

commitInput();
