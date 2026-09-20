'use strict';

// 对比度调色板求解器
//
// 问题模型：
//   - 每个令牌可在“原色”与全局候选色构成的有限域中取值；被锁定的令牌只能保留原色。
//   - 每条约束要求两个令牌的 WCAG 对比度 >= minContrast。
//   - 色觉鲁棒模式：输入可声明 profiles（normal / protanopia / deuteranopia /
//     tritanopia，缺省仅 normal）。每条约束必须在全部所选视型下（按固定模拟矩阵
//     变换后的颜色）都达到 minContrast，才视为可行。
//
// 优化目标（字典序）：
//   1. 改色令牌数最少；
//   2. 改色相对原色的 CIE Lab ΔE76 总和最小；
//   3. 稳定决胜：按令牌名升序的赋值色值字典序。
//
// 算法：深度优先分支定界（branch and bound）
//   - 以“当前改色数 + ΔE 增量”作为随路径单调递增的下界剪枝；
//   - MRV（最小剩余值域）变量选择 + 基于相容位掩码的前向检查；
//   - 每个变量先尝试原色：原方案可行时可立即得到零改色最优解；
//   - 无解时先枚举由锁定颜色“直接”造成的冲突（含具体失败视型）。

const {
  normalizeHex,
  contrastRatio,
  deltaE,
  simulateColor,
  VISION_PROFILES,
} = require('./color');

const MAX_TOKENS = 10;
const MAX_CANDIDATES = 12;
const MAX_CONSTRAINTS = 30;
const DEFAULT_NODE_BUDGET = 2_000_000;

class SolverError extends Error {}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * 解析 profiles 字段：缺省等同 ['normal']；重复值去重（保留首次出现顺序）；
 * 非数组、空数组或未知视型一律拒绝。
 */
function parseProfiles(raw) {
  if (raw === undefined || raw === null) {
    return ['normal'];
  }
  if (!Array.isArray(raw)) {
    throw new SolverError(
      `profiles 必须是数组，可选值：${VISION_PROFILES.join('、')}`
    );
  }
  if (raw.length === 0) {
    throw new SolverError('profiles 不能为空数组；不提供该字段时默认仅 normal');
  }
  const seen = new Set();
  const profiles = [];
  for (const p of raw) {
    if (typeof p !== 'string' || !VISION_PROFILES.includes(p)) {
      throw new SolverError(
        `未知视型 ${JSON.stringify(p)}，可选值：${VISION_PROFILES.join('、')}`
      );
    }
    if (!seen.has(p)) {
      seen.add(p);
      profiles.push(p);
    }
  }
  return profiles;
}

/**
 * 解析并校验输入。locks 为前端传入的 { [令牌名]: true }（覆盖 JSON 内 locked）。
 * 返回内部模型，所有颜色均规范化为 #rrggbb 小写。
 */
function parseModel(input, locks) {
  if (!isPlainObject(input)) {
    throw new SolverError('输入必须是 JSON 对象');
  }

  const profiles = parseProfiles(input.profiles);

  const tokensRaw = input.tokens;
  const candidatesRaw = input.candidates;
  const constraintsRaw = input.constraints;

  if (!Array.isArray(tokensRaw)) {
    throw new SolverError('tokens 必须是数组');
  }
  if (tokensRaw.length < 1) {
    throw new SolverError('至少需要 1 个令牌');
  }
  if (tokensRaw.length > MAX_TOKENS) {
    throw new SolverError(`令牌数不能超过 ${MAX_TOKENS} 个（当前 ${tokensRaw.length} 个）`);
  }
  if (!Array.isArray(candidatesRaw)) {
    throw new SolverError('candidates 必须是数组');
  }
  if (candidatesRaw.length > MAX_CANDIDATES) {
    throw new SolverError(`候选色不能超过 ${MAX_CANDIDATES} 个（当前 ${candidatesRaw.length} 个）`);
  }
  if (!Array.isArray(constraintsRaw)) {
    throw new SolverError('constraints 必须是数组');
  }
  if (constraintsRaw.length > MAX_CONSTRAINTS) {
    throw new SolverError(`约束不能超过 ${MAX_CONSTRAINTS} 条（当前 ${constraintsRaw.length} 条）`);
  }

  const tokenNames = [];
  const tokens = new Map();
  for (let i = 0; i < tokensRaw.length; i++) {
    const path = `tokens[${i}]`;
    const t = tokensRaw[i];
    if (!isPlainObject(t)) {
      throw new SolverError(`${path} 必须是对象`);
    }
    if (typeof t.name !== 'string' || t.name.trim() === '') {
      throw new SolverError(`${path}.name 必须是非空字符串`);
    }
    const name = t.name;
    if (tokens.has(name)) {
      throw new SolverError(`令牌名 "${name}" 重复`);
    }
    const color = normalizeHex(t.color, `${path} (${name}).color`);
    let locked = t.locked === true;
    if (isPlainObject(locks) && Object.prototype.hasOwnProperty.call(locks, name)) {
      locked = locks[name] === true;
    }
    tokenNames.push(name);
    tokens.set(name, { name, original: color, locked });
  }

  // 全局候选色：去重、规范化，按十六进制值升序（稳定顺序）。
  const candidateSet = new Set();
  candidatesRaw.forEach((raw, i) => {
    candidateSet.add(normalizeHex(raw, `candidates[${i}]`));
  });
  const candidates = [...candidateSet].sort();

  const constraints = [];
  constraintsRaw.forEach((raw, i) => {
    const path = `constraints[${i}]`;
    if (!isPlainObject(raw)) {
      throw new SolverError(`${path} 必须是对象`);
    }
    const a = raw.foreground;
    const b = raw.background;
    if (typeof a !== 'string' || typeof b !== 'string') {
      throw new SolverError(`${path} 需要 foreground 与 background 两个令牌名字符串`);
    }
    if (!tokens.has(a)) {
      throw new SolverError(`${path}.foreground 引用了不存在的令牌 "${a}"`);
    }
    if (!tokens.has(b)) {
      throw new SolverError(`${path}.background 引用了不存在的令牌 "${b}"`);
    }
    const min = Number(raw.minContrast);
    if (!Number.isFinite(min) || min < 1 || min > 21) {
      throw new SolverError(`${path}.minContrast 必须是 1 到 21 之间的数字`);
    }
    constraints.push({ index: i, a, b, min });
  });

  // 每个令牌的值域 = {原色} ∪ 候选色（去重、升序），原色位置单独记录。
  for (const name of tokenNames) {
    const token = tokens.get(name);
    const domain = new Set(candidates);
    domain.add(token.original);
    const sorted = [...domain].sort();
    token.domain = token.locked ? [token.original] : sorted;
    token.originalIndex = sorted.indexOf(token.original);
  }

  return { tokenNames, tokens, candidates, constraints, profiles };
}

/**
 * 预处理：统一全局色表、各视型的对比度表、每条约束的相容位掩码与令牌关联关系。
 * 一对颜色只有在全部所选视型下都达到 minContrast 才相容。
 */
function preprocess(model, activeConstraints) {
  const allColors = new Set(model.candidates);
  for (const name of model.tokenNames) {
    allColors.add(model.tokens.get(name).original);
  }
  const colors = [...allColors].sort();
  const n = colors.length;
  const indexOf = new Map(colors.map((hex, i) => [hex, i]));

  // 每个视型一张对比度表：先按固定矩阵模拟该视型下的颜色，再计算 WCAG 对比度。
  const ratioByProfile = model.profiles.map((profile) => {
    const simulated = colors.map((hex) => simulateColor(hex, profile));
    const table = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const r = i === j ? 1 : contrastRatio(simulated[i], simulated[j]);
        table[i * n + j] = r;
        table[j * n + i] = r;
      }
    }
    return table;
  });

  // 每条活动约束两个方向的相容掩码：
  // maskA[i] 的第 j 位 = 1 表示 A 侧取颜色 i 时与 B 侧颜色 j 在全部视型下都相容。
  const masksPerConstraint = activeConstraints.map((con) => {
    const maskA = new Uint32Array(n);
    const maskB = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let ok = true;
        for (let p = 0; p < ratioByProfile.length; p++) {
          if (ratioByProfile[p][i * n + j] < con.min) {
            ok = false;
            break;
          }
        }
        if (ok) {
          maskA[i] |= 1 << j;
          maskB[j] |= 1 << i;
        }
      }
    }
    return { maskA, maskB };
  });

  // 令牌 -> 关联约束（带侧别），按活动约束数组下标。
  const incidents = new Map();
  model.tokenNames.forEach((name) => incidents.set(name, []));
  activeConstraints.forEach((con, ai) => {
    incidents.get(con.a).push({ ai, side: 0 });
    if (con.b !== con.a) incidents.get(con.b).push({ ai, side: 1 });
  });

  const domainMaskByToken = new Map();
  for (const name of model.tokenNames) {
    let mask = 0;
    for (const hex of model.tokens.get(name).domain) {
      mask |= 1 << indexOf.get(hex);
    }
    domainMaskByToken.set(name, mask);
  }

  return { activeConstraints, colors, n, indexOf, ratioByProfile, masksPerConstraint, incidents, domainMaskByToken };
}

/**
 * 单侧锁定冲突详情：列出无法达标的具体视型（及各失败视型在值域内的最佳对比度）。
 * 触发条件：对方值域内没有任何单一颜色能在全部所选视型下同时达标。
 */
function lockedSideConflict(model, pre, con, lockedSide, lockedGi) {
  const isFg = lockedSide === 'foreground';
  const lockedSideName = isFg ? '前景' : '背景';
  const otherSideName = isFg ? '背景' : '前景';
  const lockedName = isFg ? con.a : con.b;
  const otherName = isFg ? con.b : con.a;
  const lockedColor = model.tokens.get(lockedName).original;
  const otherDomain = model.tokens.get(otherName).domain;

  // 每个视型下，对方值域内可达的最佳对比度。
  const bestPerProfile = model.profiles.map((profile, pi) => {
    let best = 0;
    for (const hex of otherDomain) {
      const gi = pre.indexOf.get(hex);
      const r = pre.ratioByProfile[pi][lockedGi * pre.n + gi];
      if (r > best) best = r;
    }
    return { profile, best };
  });
  const failing = bestPerProfile.filter((e) => e.best < con.min);

  let message;
  if (failing.length > 0) {
    const names = failing.map((e) => e.profile).join('、');
    const bests = failing.map((e) => `${e.profile} ${round3(e.best)}`).join('、');
    message =
      `约束 #${con.index + 1}：${lockedSideName} ${lockedName} 被锁定为 ${lockedColor}，` +
      `视型 ${names} 下${otherSideName} ${otherName} 取值域内任何颜色都无法使对比度达到 ` +
      `${con.min}（各失败视型最佳：${bests}）`;
  } else {
    message =
      `约束 #${con.index + 1}：${lockedSideName} ${lockedName} 被锁定为 ${lockedColor}，` +
      `${otherSideName} ${otherName} 取值域内没有任何单一颜色能在全部所选视型` +
      `（${model.profiles.join('、')}）下同时达到 ${con.min}`;
  }

  return {
    kind: isFg ? 'locked-foreground' : 'locked-background',
    constraintIndex: con.index,
    foreground: con.a,
    background: con.b,
    ...(isFg ? { foregroundColor: lockedColor } : { backgroundColor: lockedColor }),
    minContrast: con.min,
    failedProfiles: failing.map((e) => e.profile),
    message,
  };
}

/**
 * 枚举由锁定颜色直接造成的冲突（用于无解诊断）：
 *  - both-locked：两个锁定令牌在某些视型下对比度不达标；
 *  - locked-foreground / locked-background：锁定一侧与对端值域中任何颜色
 *    都无法在全部视型下同时相容。冲突条目均通过 failedProfiles 说明具体失败视型。
 */
function findDirectLockConflicts(model, activeConstraints, pre) {
  const conflicts = [];

  for (let ai = 0; ai < activeConstraints.length; ai++) {
    const con = activeConstraints[ai];
    const ta = model.tokens.get(con.a);
    const tb = model.tokens.get(con.b);
    const giA = pre.indexOf.get(ta.original);
    const giB = pre.indexOf.get(tb.original);

    if (ta.locked && tb.locked) {
      const failing = [];
      let worst = Infinity;
      model.profiles.forEach((profile, pi) => {
        const r = pre.ratioByProfile[pi][giA * pre.n + giB];
        if (r < worst) worst = r;
        if (r < con.min) failing.push({ profile, ratio: r });
      });
      if (failing.length > 0) {
        const detail = failing
          .map((f) => `视型 ${f.profile} 下对比度 ${round3(f.ratio)}`)
          .join('、');
        conflicts.push({
          kind: 'both-locked',
          constraintIndex: con.index,
          foreground: con.a,
          background: con.b,
          foregroundColor: ta.original,
          backgroundColor: tb.original,
          minContrast: con.min,
          actual: round3(worst),
          failedProfiles: failing.map((f) => f.profile),
          message:
            `约束 #${con.index + 1}（${con.a} / ${con.b}）两端均被锁定：` +
            `${detail}，低于要求的 ${con.min}`,
        });
      }
      continue;
    }

    const { maskA, maskB } = pre.masksPerConstraint[ai];
    if (ta.locked && !tb.locked) {
      if ((maskA[giA] & pre.domainMaskByToken.get(con.b)) === 0) {
        conflicts.push(lockedSideConflict(model, pre, con, 'foreground', giA));
      }
    }
    if (tb.locked && !ta.locked) {
      if ((maskB[giB] & pre.domainMaskByToken.get(con.a)) === 0) {
        conflicts.push(lockedSideConflict(model, pre, con, 'background', giB));
      }
    }
  }

  return conflicts;
}

function countBits(mask) {
  let c = 0;
  while (mask) {
    mask &= mask - 1;
    c++;
  }
  return c;
}

/**
 * 分支定界搜索。
 * 返回 { status: 'optimal' | 'unsatisfiable' | 'search-limit', ... }。
 */
function runSearch(model, pre, options = {}) {
  const nodeBudget = options.nodeBudget || DEFAULT_NODE_BUDGET;

  // 未锁定变量，按令牌名升序排列（顺序确定性）。
  const varNames = model.tokenNames.filter((name) => !model.tokens.get(name).locked).sort();
  const vcount = varNames.length;

  // 位置对齐的并行数组（MRV 通过交换位置实现）。
  const optionsGlobal = varNames.map((name) =>
    model.tokens.get(name).domain.map((hex) => pre.indexOf.get(hex))
  );
  const incidents = varNames.map((name) => pre.incidents.get(name));
  const domainMasks = varNames.map((name, vi) => {
    let mask = 0;
    for (const gi of optionsGlobal[vi]) mask |= 1 << gi;
    return mask;
  });
  const assigned = new Int32Array(vcount).fill(-1);

  const swap = (i, j, domains) => {
    if (i === j) return;
    const t = varNames[i];
    varNames[i] = varNames[j];
    varNames[j] = t;
    const og = optionsGlobal[i];
    optionsGlobal[i] = optionsGlobal[j];
    optionsGlobal[j] = og;
    const ic = incidents[i];
    incidents[i] = incidents[j];
    incidents[j] = ic;
    const ag = assigned[i];
    assigned[i] = assigned[j];
    assigned[j] = ag;
    const dm = domains[i];
    domains[i] = domains[j];
    domains[j] = dm;
  };

  const sortedTokenNames = [...model.tokenNames].sort();
  let incumbent = null;
  let nodes = 0;
  let budgetExceeded = false;
  let earlyStop = false;
  const startTime = Date.now();

  const buildAssignment = () => {
    const result = {};
    for (const name of model.tokenNames) {
      const token = model.tokens.get(name);
      if (token.locked) {
        result[name] = token.original;
      } else {
        result[name] = pre.colors[assigned[varNames.indexOf(name)]];
      }
    }
    return result;
  };

  const tieKeyOf = (assignment) =>
    sortedTokenNames.map((name) => assignment[name]).join('|');

  const recordSolution = (changes, totalDelta) => {
    const assignment = buildAssignment();
    const key = tieKeyOf(assignment);
    if (
      !incumbent ||
      changes < incumbent.changes ||
      (changes === incumbent.changes &&
        (totalDelta < incumbent.totalDelta - 1e-9 ||
          (Math.abs(totalDelta - incumbent.totalDelta) <= 1e-9 && key < incumbent.tieKey)))
    ) {
      incumbent = { changes, totalDelta, tieKey: key, assignment };
    }
  };

  /**
   * @param pos       下一个待赋值位置
   * @param domains   各位置当前值域（全局颜色位掩码）
   * @param changes   路径上已改色令牌数
   * @param deltaSum  路径上已累计 ΔE
   */
  const dfs = (pos, domains, changes, deltaSum) => {
    if (earlyStop) return;
    if (++nodes > nodeBudget) {
      budgetExceeded = true;
      return;
    }

    // 单调下界剪枝（ΔE 相等时必须继续，以保证决胜键比较完整）。
    if (incumbent) {
      if (changes > incumbent.changes) return;
      if (changes === incumbent.changes && deltaSum > incumbent.totalDelta + 1e-9) return;
    }

    if (pos === vcount) {
      recordSolution(changes, deltaSum);
      if (incumbent.changes === 0) earlyStop = true; // 零改色即全局最优
      return;
    }

    // MRV：选值域最小的未赋值变量。
    let pick = pos;
    let pickSize = countBits(domains[pos]);
    for (let i = pos + 1; i < vcount; i++) {
      const size = countBits(domains[i]);
      if (size < pickSize) {
        pickSize = size;
        pick = i;
      }
    }
    if (pickSize === 0) return; // 前向检查已判定死路
    swap(pos, pick, domains);

    const name = varNames[pos];
    const token = model.tokens.get(name);
    const originalGi = pre.indexOf.get(token.original);
    const mask = domains[pos];

    // 取值顺序：原色最先；其余按全局颜色下标升序（等价 hex 字典序）。
    const order = [];
    if (mask & (1 << originalGi)) order.push(originalGi);
    for (const gi of optionsGlobal[pos]) {
      if (gi !== originalGi && mask & (1 << gi)) order.push(gi);
    }

    outer: for (const gi of order) {
      if (earlyStop || budgetExceeded) return;

      const isChange = gi !== originalGi;
      const nextChanges = changes + (isChange ? 1 : 0);
      const nextDelta = deltaSum + (isChange ? deltaE(token.original, pre.colors[gi]) : 0);

      if (incumbent) {
        if (nextChanges > incumbent.changes) continue;
        if (nextChanges === incumbent.changes && nextDelta > incumbent.totalDelta + 1e-9) {
          continue;
        }
      }

      assigned[pos] = gi;

      // 前向检查：基于与本变量相关的约束收缩其余未赋值变量的值域。
      const nextDomains = domains.slice();
      for (const inc of incidents[pos]) {
        const con = pre.activeConstraints[inc.ai];
        const compatible = inc.side === 0
          ? pre.masksPerConstraint[inc.ai].maskA[gi]
          : pre.masksPerConstraint[inc.ai].maskB[gi];
        const otherName = inc.side === 0 ? con.b : con.a;

        if (otherName === name) continue; // 自反约束已在前面单独处理

        const otherToken = model.tokens.get(otherName);
        if (otherToken.locked) {
          const otherGi = pre.indexOf.get(otherToken.original);
          if ((compatible & (1 << otherGi)) === 0) {
            assigned[pos] = -1;
            continue outer;
          }
        } else {
          let otherPos = -1;
          for (let i = pos + 1; i < vcount; i++) {
            if (varNames[i] === otherName) {
              otherPos = i;
              break;
            }
          }
          if (otherPos === -1) {
            // 已在更早位置赋值：直接检验相容性。
            const otherGi = assigned[varNames.indexOf(otherName)];
            if ((compatible & (1 << otherGi)) === 0) {
              assigned[pos] = -1;
              continue outer;
            }
          } else {
            nextDomains[otherPos] &= compatible;
            if (nextDomains[otherPos] === 0) {
              assigned[pos] = -1;
              continue outer;
            }
          }
        }
      }

      dfs(pos + 1, nextDomains, nextChanges, nextDelta);
      assigned[pos] = -1;
    }

    swap(pos, pick, domains); // 还原变量顺序
  };

  dfs(0, domainMasks, 0, 0);

  const stats = { nodes, elapsedMs: Date.now() - startTime };

  if (budgetExceeded) {
    return {
      status: 'search-limit',
      nodeBudget,
      best: incumbent
        ? {
            assignment: incumbent.assignment,
            changes: incumbent.changes,
            totalDelta: round3(incumbent.totalDelta),
          }
        : null,
      stats,
    };
  }
  if (!incumbent) {
    return {
      status: 'unsatisfiable',
      stats,
    };
  }
  return {
    status: 'optimal',
    assignment: incumbent.assignment,
    changes: incumbent.changes,
    totalDelta: round3(incumbent.totalDelta),
    stats,
  };
}

/**
 * 求解入口。返回值可直接序列化为 API 响应。
 */
function solve(input, locks, options = {}) {
  const model = parseModel(input, locks);

  // 自反约束（同一令牌作为前景与背景）：颜色与自身对比度恒为 1。
  const selfConflicts = [];
  const activeConstraints = [];
  for (const con of model.constraints) {
    if (con.a === con.b) {
      if (con.min > 1) {
        const token = model.tokens.get(con.a);
        selfConflicts.push({
          kind: 'self-contrast',
          constraintIndex: con.index,
          token: con.a,
          color: token.original,
          locked: token.locked,
          minContrast: con.min,
          message:
            `约束 #${con.index + 1} 的前景与背景同为令牌 ${con.a}：` +
            `任何颜色与自身的对比度都是 1，不可能达到要求的 ${con.min}`,
        });
      }
      // min <= 1 时恒成立，不进入搜索。
    } else {
      activeConstraints.push(con);
    }
  }
  if (selfConflicts.length > 0) {
    return {
      status: 'unsatisfiable',
      reason: 'direct-conflict',
      profiles: model.profiles,
      conflicts: selfConflicts,
      stats: { nodes: 0, elapsedMs: 0 },
    };
  }

  const pre = preprocess(model, activeConstraints);

  const directConflicts = findDirectLockConflicts(model, activeConstraints, pre);
  if (directConflicts.length > 0) {
    return {
      status: 'unsatisfiable',
      reason: 'locked-conflict',
      profiles: model.profiles,
      conflicts: directConflicts,
      stats: { nodes: 0, elapsedMs: 0 },
    };
  }

  const result = runSearch(model, pre, options);
  if (result.status === 'unsatisfiable') {
    return {
      status: 'unsatisfiable',
      reason: 'global',
      profiles: model.profiles,
      conflicts: [],
      message:
        '不存在同时满足全部约束的配色方案；未发现由锁定颜色直接导致的冲突，' +
        '不可行性可能由多条约束与候选色范围共同造成。',
      stats: result.stats,
    };
  }
  if (result.status === 'search-limit') {
    return {
      status: 'search-limit',
      reason: 'node-budget',
      profiles: model.profiles,
      message: `搜索节点数超过上限（${result.nodeBudget}），请放宽约束或增加候选色后重试。`,
      best: result.best,
      stats: result.stats,
    };
  }
  result.profiles = model.profiles;
  return result;
}

/**
 * 依据最终赋值生成令牌与约束的改前/改后明细。
 * 每条约束给出各视型的改前/改后比值（perProfile），并标注改后比值最低的最差视型；
 * 聚合字段 beforeRatio / afterRatio 取全部视型中的最差（最低）值。
 */
function buildReport(input, locks, assignment) {
  const model = parseModel(input, locks);
  const profiles = model.profiles;

  // 颜色 × 视型 的模拟结果缓存。
  const simCache = new Map();
  const simulate = (hex, profile) => {
    const key = `${hex}|${profile}`;
    let v = simCache.get(key);
    if (v === undefined) {
      v = simulateColor(hex, profile);
      simCache.set(key, v);
    }
    return v;
  };

  const tokens = model.tokenNames.map((name) => {
    const token = model.tokens.get(name);
    const final = assignment[name];
    return {
      name,
      original: token.original,
      final,
      locked: token.locked,
      changed: final !== token.original,
      deltaE: round3(deltaE(token.original, final)),
    };
  });

  const constraints = model.constraints.map((con) => {
    const origA = model.tokens.get(con.a).original;
    const origB = model.tokens.get(con.b).original;
    const perProfile = profiles.map((profile) => {
      const before = contrastRatio(simulate(origA, profile), simulate(origB, profile));
      const after = contrastRatio(
        simulate(assignment[con.a], profile),
        simulate(assignment[con.b], profile)
      );
      return {
        profile,
        beforeRatio: round3(before),
        afterRatio: round3(after),
        beforePass: before + 1e-9 >= con.min,
        afterPass: after + 1e-9 >= con.min,
      };
    });
    // 最差视型：改后比值最低者（并列时取 profiles 中靠前者）。
    let worst = perProfile[0];
    for (const entry of perProfile) {
      if (entry.afterRatio < worst.afterRatio) worst = entry;
    }
    return {
      index: con.index,
      foreground: con.a,
      background: con.b,
      minContrast: con.min,
      beforeRatio: Math.min(...perProfile.map((e) => e.beforeRatio)),
      afterRatio: worst.afterRatio,
      beforePass: perProfile.every((e) => e.beforePass),
      afterPass: perProfile.every((e) => e.afterPass),
      worstProfile: worst.profile,
      perProfile,
    };
  });

  return { profiles, tokens, constraints };
}

/**
 * 生成导出用令牌 JSON：深拷贝输入，仅替换颜色字段，其余内容与键顺序保持不变。
 */
function buildExport(input, assignment) {
  const exported = JSON.parse(JSON.stringify(input));
  if (Array.isArray(exported.tokens)) {
    for (const t of exported.tokens) {
      if (t && Object.prototype.hasOwnProperty.call(assignment, t.name)) {
        t.color = assignment[t.name];
      }
    }
  }
  return exported;
}

module.exports = {
  MAX_TOKENS,
  MAX_CANDIDATES,
  MAX_CONSTRAINTS,
  SolverError,
  parseModel,
  solve,
  buildReport,
  buildExport,
};
