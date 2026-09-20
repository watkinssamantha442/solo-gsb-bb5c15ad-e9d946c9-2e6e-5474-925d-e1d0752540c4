'use strict';

// 浏览器回归测试配置：复用 Docker/生产环境相同的 src/server.js，
// 仅在测试时监听 3100 端口（Docker 启动方式与对外 3000 端口均不变）。
//
// 说明：CI/容器内通常无 root 安装 Chromium 系统依赖，因此允许通过
// PW_LD_LIBRARY_PATH 指向预先解包的库目录（apt-get download + dpkg-deb -x
// 即可获得，无需写入系统路径）。系统库经 LD_LIBRARY_PATH 提供时，跳过
// Playwright 自身的主机依赖校验（它无法识别非系统路径中的库）。
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const extraLibPath = process.env.PW_LD_LIBRARY_PATH || '';
const ldLibraryPath = [extraLibPath, process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(':');

module.exports = {
  testDir: './tests/browser',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      env: ldLibraryPath
        ? { ...process.env, LD_LIBRARY_PATH: ldLibraryPath }
        : undefined,
    },
  },
  webServer: {
    command: 'node src/server.js',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: { ...process.env, PORT: '3100', NODE_ENV: 'test' },
  },
};

