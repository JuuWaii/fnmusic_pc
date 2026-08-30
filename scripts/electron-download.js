'use strict';
/**
 * Electron 二进制手动下载工具
 *
 * 用途：当网络环境无法执行 npm postinstall（下载被代理/TLS 策略拦截）时，
 * 手动下载并解压 Electron 二进制到 node_modules/electron/dist。
 *
 * 用法：node scripts/electron-download.js
 * （普通环境无需使用，npm install 会自动完成）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ZIP = path.join(ROOT, 'electron-tmp.zip');
let VERSION = '';
// 优先取 node_modules 实际安装版本，其次 package.json 声明的版本
try {
  VERSION = require(path.join(ROOT, 'node_modules/electron/package.json')).version;
} catch {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const dep = pkg.devDependencies && pkg.devDependencies.electron;
    if (dep) VERSION = String(dep).replace(/^\^|^~/, '');
  } catch { /* 保持空 */ }
}
if (!VERSION) {
  console.error('无法确定 Electron 版本，请先 npm install');
  process.exit(1);
}

// 依次尝试官方源与国内镜像
const MIRRORS = [
  `https://github.com/electron/electron/releases/download/v${VERSION}/electron-v${VERSION}-win32-x64.zip`,
  `https://npmmirror.com/mirrors/electron/${VERSION}/electron-v${VERSION}-win32-x64.zip`,
  `https://registry.npmmirror.com/-/binary/electron/${VERSION}/electron-v${VERSION}-win32-x64.zip`,
];

(async () => {
  for (const url of MIRRORS) {
    try {
      console.log('[download]', url);
      const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 50 * 1024 * 1024) throw new Error('响应体过小(' + buf.length + ')，不是有效的二进制包');
      fs.writeFileSync(ZIP, buf);
      console.log('[download] 完成:', (buf.length / 1024 / 1024).toFixed(1), 'MB');

      const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
      fs.rmSync(dist, { recursive: true, force: true });
      fs.mkdirSync(dist, { recursive: true });
      execSync(`tar -xf "${ZIP}" -C "${dist}"`, { stdio: 'inherit' });
      fs.writeFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'electron.exe');
      console.log('[download] OK: Electron ' + VERSION + ' 已就绪');
      process.exit(0);
    } catch (e) {
      console.warn('[download] 镜像失败:', e.message);
    }
  }
  console.error('[download] 所有镜像均失败');
  process.exit(1);
})();