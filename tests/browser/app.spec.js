'use strict';

// 前端状态提交的浏览器回归测试。
// 覆盖：
//  1. 含未知视型的合法 JSON：具体错误持续可见、求解按钮禁用；修正后清错并恢复面板；
//  2. JSON 语法错误同样持续可见（不再被清理旧结果的逻辑瞬间隐藏）；
//  3. 异步乱序：较早开始的文件读取 / 示例请求 / 求解响应均不得覆盖更新后的输入；
//  4. 服务端 400 错误持续可见，直至下次有效提交；
//  5. 正常求解端到端可用。

const { test, expect } = require('@playwright/test');

// 恒可行的最小调色板（#ffffff / #000000 对比度 21:1，零改色）。
function minimalPalette(overrides = {}) {
  return JSON.stringify(
    {
      tokens: [
        { name: 'a', color: '#ffffff' },
        { name: 'b', color: '#000000' },
      ],
      candidates: ['#777777'],
      constraints: [{ foreground: 'a', background: 'b', minContrast: 4.5 }],
      ...overrides,
    },
    null,
    2
  );
}

const UNKNOWN_PROFILE_PALETTE = minimalPalette({ profiles: ['normal', 'achromatopsia'] });

async function fillInput(page, text) {
  await page.locator('#jsonInput').fill(text);
}

test.describe('未知视型 / 无效输入', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('粘贴含未知视型的合法 JSON 后错误持续可见且求解禁用', async ({ page }) => {
    await fillInput(page, UNKNOWN_PROFILE_PALETTE);

    const error = page.locator('#parseError');
    // 错误立即出现且包含具体视型名。
    await expect(error).toBeVisible();
    await expect(error).toContainText('未知视型');
    await expect(error).toContainText('achromatopsia');

    // 关键回归点：错误不会在稍后（清理旧结果时）瞬间消失。
    await page.waitForTimeout(600);
    await expect(error).toBeVisible();
    await expect(error).toContainText('achromatopsia');

    // 无效输入必须禁用求解，且不显示锁定令牌面板内容。
    await expect(page.locator('#solveBtn')).toBeDisabled();
    await expect(page.locator('#tokenLocks .lock-item')).toHaveCount(0);
    await expect(page.locator('#inputMeta')).toHaveText('');
  });

  test('修正为已知视型后清除错误、恢复面板并允许求解', async ({ page }) => {
    await fillInput(page, UNKNOWN_PROFILE_PALETTE);
    await expect(page.locator('#parseError')).toBeVisible();

    await fillInput(page, minimalPalette({ profiles: ['normal', 'protanopia'] }));

    const error = page.locator('#parseError');
    await expect(error).toBeHidden();
    await expect(page.locator('#solveBtn')).toBeEnabled();
    // 锁定面板恢复：2 个令牌；视型面板勾选 normal + protanopia。
    await expect(page.locator('#tokenLocks .lock-item')).toHaveCount(2);
    await expect(page.locator('#inputMeta')).toContainText('2 个令牌');
    const checkedProfiles = page.locator('#profileList input[type="checkbox"]:checked');
    await expect(checkedProfiles).toHaveCount(2);
  });

  test('JSON 语法错误也持续可见', async ({ page }) => {
    await fillInput(page, '{ "tokens": [ }');
    const error = page.locator('#parseError');
    await expect(error).toBeVisible();
    await expect(error).toContainText('JSON 语法错误');
    await page.waitForTimeout(400);
    await expect(error).toBeVisible();
    await expect(page.locator('#solveBtn')).toBeDisabled();
  });
});

test.describe('异步乱序（版本化提交）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('较早开始的文件读取不得覆盖读取期间键入的新输入', async ({ page }) => {
    // 确定性地拖慢 File.text()：文件内容（示例，8 令牌）较“旧”，
    // 读取完成前键入的最小调色板（2 令牌）较“新”，最终必须以新输入为准。
    await page.evaluate(() => {
      const orig = File.prototype.text;
      File.prototype.text = function delayedText() {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            orig.call(this).then(resolve, reject);
          }, 500);
        });
      };
    });

    const sampleText = JSON.stringify(
      {
        tokens: [
          { name: 'a', color: '#fff' },
          { name: 'b', color: '#000' },
          { name: 'c', color: '#111' },
          { name: 'd', color: '#222' },
          { name: 'e', color: '#333' },
          { name: 'f', color: '#444' },
          { name: 'g', color: '#555' },
          { name: 'h', color: '#666' },
        ],
        candidates: ['#777777'],
        constraints: [],
      },
      null,
      2
    );

    await page.locator('#fileInput').setInputFiles({
      name: 'old-palette.json',
      mimeType: 'application/json',
      buffer: Buffer.from(sampleText),
    });

    // 文件读取在途（500ms），用户改为键入另一组合法输入。
    await page.waitForTimeout(150);
    await fillInput(page, minimalPalette());

    // 等待被拖慢的文件读取返回。
    await page.waitForTimeout(700);

    // 旧文件不得覆盖：面板仍是 2 个令牌、按钮可用、无错误。
    await expect(page.locator('#inputMeta')).toContainText('2 个令牌');
    await expect(page.locator('#tokenLocks .lock-item')).toHaveCount(2);
    await expect(page.locator('#parseError')).toBeHidden();
    await expect(page.locator('#solveBtn')).toBeEnabled();
  });

  test('较早开始的示例请求不得覆盖随后导入的文件', async ({ page }) => {
    let releaseSample;
    await page.route('**/sample-palette.json', (route) => {
      releaseSample = route.fetch().then((res) => () => route.fulfill({ response: res }));
    });

    await page.locator('#loadSampleBtn').click();
    // 示例请求在途时导入一个最小调色板文件（2 令牌）。
    await expect(page.locator('#resultPlaceholder')).toContainText('正在载入示例');
    await page.locator('#fileInput').setInputFiles({
      name: 'newer-palette.json',
      mimeType: 'application/json',
      buffer: Buffer.from(minimalPalette()),
    });

    await expect(page.locator('#inputMeta')).toContainText('2 个令牌');

    // 较旧的示例响应此时才返回，不得覆盖文件导入结果。
    const fulfill = await releaseSample;
    await fulfill();
    await page.waitForTimeout(300);

    await expect(page.locator('#inputMeta')).toContainText('2 个令牌');
    await expect(page.locator('#tokenLocks .lock-item')).toHaveCount(2);
    await expect(page.locator('#parseError')).toBeHidden();
  });

  test('在途求解响应不得覆盖求解期间键入的未知视型输入', async ({ page }) => {
    let releaseSolve;
    await page.route('**/api/solve', (route) => {
      releaseSolve = route.fetch().then((res) => () => route.fulfill({ response: res }));
    });

    // 以合法输入发起求解并挂起响应。
    await fillInput(page, minimalPalette());
    await page.locator('#solveBtn').click();
    await expect(page.locator('#resultPlaceholder')).toContainText('分支定界搜索');

    // 求解在途时改粘贴含未知视型的合法 JSON：错误立现、求解禁用。
    await fillInput(page, UNKNOWN_PROFILE_PALETTE);
    const error = page.locator('#parseError');
    await expect(error).toBeVisible();
    await expect(error).toContainText('achromatopsia');
    await expect(page.locator('#solveBtn')).toBeDisabled();

    // 旧求解响应返回：必须因版本过期被丢弃。
    const fulfill = await releaseSolve;
    await fulfill();
    await page.waitForTimeout(300);

    await expect(error).toBeVisible();
    await expect(error).toContainText('achromatopsia');
    await expect(page.locator('#solveBtn')).toBeDisabled();
    // 旧结果不得渲染。
    await expect(page.locator('#resultArea')).toBeHidden();
    await expect(page.locator('#inputMeta')).toHaveText('');
  });
});

test.describe('服务端错误与正常求解', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('服务端 400 错误持续可见，下次有效提交时清除', async ({ page }) => {
    await page.route('**/api/solve', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: '400 模拟校验失败' }),
      })
    );

    await fillInput(page, minimalPalette());
    await page.locator('#solveBtn').click();

    const error = page.locator('#parseError');
    await expect(error).toBeVisible();
    await expect(error).toContainText('400 模拟校验失败');
    // 错误持续存在，不会自己消失；按钮恢复可点以便用户重试/修改。
    await page.waitForTimeout(400);
    await expect(error).toBeVisible();
    await expect(page.locator('#solveBtn')).toBeEnabled();

    // 重新键入合法输入后错误清除。
    await fillInput(page, minimalPalette());
    await expect(error).toBeHidden();
  });

  test('合法输入正常求解并渲染结果，错误区保持隐藏', async ({ page }) => {
    await fillInput(page, minimalPalette());
    await page.locator('#solveBtn').click();

    await expect(page.locator('#resultArea')).toBeVisible();
    await expect(page.locator('#parseError')).toBeHidden();
    await expect(page.locator('#resultSummary')).toContainText('改色令牌数');
    // 零改色：#ffffff / #000000 原本即达标。
    await expect(page.locator('#resultSummary')).toContainText('0');
    await expect(page.locator('#solveBtn')).toBeEnabled();
  });
});
