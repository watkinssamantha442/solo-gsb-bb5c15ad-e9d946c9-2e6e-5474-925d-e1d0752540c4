# 对比度调色板求解器（Contrast Palette Solver）

导入颜色令牌、候选色与 WCAG 对比度约束，**全局搜索**出同时满足全部约束的最优改色方案。
Node.js + Express + 原生前端，无前端框架、无外部网络请求，**所有数据仅在本机内存中处理**。

## 唯一启动命令

```bash
docker compose up --build
```

启动后用浏览器打开：

> http://localhost:3000

构建镜像时会自动安装全部依赖，无需手动 `npm install`。停止服务使用 `Ctrl+C`（或
`docker compose down`）。

## 功能

- 导入 JSON（粘贴文本或选择文件），内置「载入示例」按钮；
- 可**锁定任意令牌**：被锁定的令牌保持原色，不参与改色；
- **色觉鲁棒模式**：输入可声明 `profiles`（`normal` / `protanopia` / `deuteranopia` /
  `tritanopia`），每条约束必须在**全部所选视型**下都达到 `minContrast` 才视为可行；
- **全局分支定界搜索**（branch and bound），在满足全部 WCAG 对比度约束的方案中，按以下顺序优化：
  1. **改色令牌数最少**；
  2. **CIE Lab 总色差最小**（ΔE\*ab / CIE76，D65 白点）；
  3. 稳定决胜：按令牌名升序、以色值字典序最小者为准（相同输入永远得到相同结果）；
- 页面按约束列出**各视型的改前 / 改后对比度比值**与是否达标，并**突出最差视型**；
- **无解时列出锁定颜色直接造成的冲突**（两端锁定不达标、单侧锁定导致对端无可用颜色、
  自反约束等），并说明**具体失败视型**；
- 一键**导出替换后的令牌 JSON**（保留输入中的其他字段与结构，仅替换颜色）；
- 搜索采用 MRV 变量选择 + 相容位掩码前向检查 + 改色数/色差单调下界剪枝。

## 输入格式与上限

```json
{
  "name": "示例产品主题",
  "tokens": [
    { "name": "bg", "color": "#f8fafc", "locked": true },
    { "name": "text", "color": "#6b7280" }
  ],
  "candidates": ["#0f172a", "#1f2937", "#ffffff"],
  "constraints": [
    { "foreground": "text", "background": "bg", "minContrast": 4.5 }
  ],
  "profiles": ["normal", "protanopia"]
}
```

- 颜色支持 `#rgb` 或 `#rrggbb`（不区分大小写）；
- 每个令牌的取值域 = 原色 + 全部候选色（自动去重）；
- `locked: true` 或在页面勾选锁定的令牌只能保留原色；
- `minContrast` 为 WCAG 对比度（1–21）。常用阈值：普通文本 **4.5**、大号文本/UI **3**、
  严格文本 **7**；
- `profiles`（可选）：色觉视型数组，可选值 `normal`、`protanopia`、`deuteranopia`、
  `tritanopia`；**未提供时等同 `["normal"]`**。重复值自动去重；空数组、非数组或
  未知视型会被拒绝并返回明确错误。

| 项目 | 上限 |
| --- | --- |
| 令牌数 | **10** |
| 候选色数 | **12** |
| 约束条数 | **30** |

超出上限或格式有误时，页面与接口都会返回明确的错误信息。

## 色觉鲁棒模式

声明 `profiles` 后，求解器会把每个颜色按下述**固定流程**模拟为各视型下看到的颜色，
再计算 WCAG 对比度。每条约束必须在**全部所选视型**中都达到 `minContrast`，
才进入既有的最少改色、最小总色差与稳定决胜优化。

每个颜色的模拟流程（对 `normal` 以外的视型）：

1. **sRGB 线性化**：各分量按标准公式转为线性光；
2. **矩阵变换**：左乘下表对应视型的 3×3 矩阵（行优先，作用于线性 RGB）；
3. **裁剪**：各分量裁剪到 `[0, 1]`；
4. **重新编码**：按 sRGB 伽马公式编码回 8 位十六进制颜色。

固定模拟矩阵（Machado, Oliveira & Fernandes, 2009，severity = 1.0）：

| 视型 | 模拟矩阵（行优先，作用于线性 sRGB） |
| --- | --- |
| `protanopia` | `0.152286  1.052583 -0.204868`<br>`0.114503  0.786281  0.099216`<br>`-0.003882 -0.048116  1.051998` |
| `deuteranopia` | `0.367322  0.860646 -0.227968`<br>`0.280085  0.672501  0.047413`<br>`-0.011820  0.042940  0.968881` |
| `tritanopia` | `1.255528 -0.076749 -0.178779`<br>`-0.078411  0.930809  0.147602`<br>`0.004733  0.691367  0.303900` |

`normal` 视型不做任何变换。页面上可直接勾选视型（第 3 区），勾选结果会同步为输入
JSON 的 `profiles` 字段；结果表格按约束逐行展示各视型的改前/改后比值，改后比值
最低的**最差视型**会以高亮行与徽章标出。

## 示例数据

仓库内置示例 [`examples/sample-palette.json`](examples/sample-palette.json)
（运行后点击页面「载入示例」即可）。示例包含 8 个令牌、12 个候选色、7 条约束，
其中背景 `bg` 与 `surface` 已锁定。求解结果为：

- 只改 **2** 个令牌：`primaryText #1d4ed8 → #f8fafc`（按钮文字改为浅色）、
  `danger #f87171 → #b91c1c`（错误红加深至 6.18:1）；
- CIE Lab 总色差 ΔE\*ab = **131.64**；
- 注意 `danger` 最终选 `#b91c1c` 而不是肉眼“看起来更近”的 `#dc2626`，
  因为在 CIE Lab 空间中前者的 ΔE（30.35）略小于后者（30.91）。

部分约束的改前/改后比值：

| 约束 | 要求 | 改前 | 改后 |
| --- | --- | --- | --- |
| primaryText / primary | 4.5 | 1.30:1 ❌ | 4.94:1 ✅ |
| danger / bg | 4.5 | 2.64:1 ❌ | 6.18:1 ✅ |
| textPrimary / bg | 7 | 14.03:1 ✅ | 14.03:1 ✅ |

### 无解锁冲突示例

将示例中的 `primary` 也锁定（保持 `#2563eb`）、同时锁定 `primaryText` 为 `#1d4ed8`，
会得到无解，页面直接列出：

> 约束 #5（primaryText / primary）两端均被锁定：视型 normal 下对比度 1.3，低于要求的 4.5

启用色觉鲁棒模式后，冲突条目还会通过 `failedProfiles` 与页面徽章说明具体失败视型，例如：

> 约束 #1（text / bg）两端均被锁定：视型 protanopia 下对比度 3.287，低于要求的 4.5

## HTTP 接口（可选）

- `POST /api/solve`：请求体 `{ "payload": <输入JSON>, "locks": { "令牌名": true } }`，
  返回最优方案、每条约束改前/改后比值与导出用 JSON；
  - 响应顶层 `profiles` 为实际生效的视型列表（去重后）；
  - `report.constraints[*].perProfile` 按视型给出改前/改后比值与是否达标，
    `worstProfile` 标注改后比值最低的视型；聚合字段 `beforeRatio` / `afterRatio`
    取全部视型中的最差（最低）值；
  - 无解时 `conflicts[*].failedProfiles` 列出具体失败视型；
- `GET /api/health`：健康检查。

## 无 Docker 时的本地开发方式（可选）

需要 Node.js ≥ 18：

```bash
npm install
npm start
```

### 测试

- `npm test`：求解器行为测试（锁定冲突、色觉视型、决胜顺序、上限校验等，纯 Node）；
- `npm run test:browser`：前端浏览器回归测试（[Playwright](https://playwright.dev/)），
  首次运行需先执行 `npx playwright install chromium` 安装测试浏览器。测试会临时用
  **3100** 端口启动同一份 `src/server.js`，不影响默认的 3000 端口与 Docker 启动方式。

浏览器回归覆盖：含未知视型的合法 JSON 必须**持续显示具体错误并禁用求解按钮**、
修正后清错恢复面板、服务端 400 错误保持可见，以及文件导入 / 示例载入 / 求解
三类异步操作乱序返回时，较早开始的响应不得覆盖更新后的输入（版本化状态提交）。

在无 root 的精简容器中运行浏览器测试时，可用 `PW_LD_LIBRARY_PATH` 指向预先
解包的 Chromium 依赖库目录（无需写入系统路径；详见 `playwright.config.js`）：

```bash
# 可选：下载 deb 并解包到用户目录（Debian/Ubuntu）
#   apt-get download <缺失的库包名...>
#   for f in *.deb; do dpkg-deb -x "$f" deps-root/; done
PW_LD_LIBRARY_PATH="$(find "$PWD/deps-root" -name '*.so*' -printf '%h\n' | sort -u | paste -sd: -)" \
  npm run test:browser
```

## 项目结构

```
Dockerfile              # 多阶段构建，构建期自动准备依赖
compose.yaml            # docker compose up --build 即启动
src/color.js            # sRGB/WCAG 亮度、对比度、CIE Lab 色差与色觉缺陷模拟矩阵
src/solver.js           # 输入校验 + 分支定界搜索 + 锁定冲突诊断（含失败视型）
src/server.js           # Express 服务与 /api/solve
public/                 # 原生前端（HTML/CSS/JS）
examples/               # 示例数据
scripts/                # 求解器测试与样例验证脚本
tests/browser/          # Playwright 浏览器回归测试（输入错误与异步乱序）
playwright.config.js    # 浏览器测试配置（临时 3100 端口，不影响 3000）
```

## 隐私

页面不会向任何第三方发送数据；JSON 仅在浏览器与本机 `localhost:3000` 服务之间传递，
求解在进程内存中完成，不写磁盘、不做持久化。
