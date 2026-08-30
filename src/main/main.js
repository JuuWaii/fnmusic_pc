'use strict';
/**
 * FN Music PC —— 飞牛音乐网页的 PC 客户端（主进程入口）
 *
 * 核心设计（对应需求）：
 * 1. 网页嵌套：WebContentsView 承载飞牛音乐网页，壳页面零侵入（需求 1/5）；
 * 2. 登录态保持：独立持久分区 persist:fnmusic-guest，cookie/localStorage
 *    持久化于用户数据目录，重启免登录（需求 1）；
 * 3. FN Connect：设置中可配置官方远程访问地址，auto 模式本地失败自动回退
 *    （需求 2）；
 * 4. 音频输出设备：运行时注入 setSinkId 定向输出（需求 4）；
 * 5. （桌面歌词功能已按用户要求移除，v0.1.6 起不再提供）；
 * 6. 不收集任何用户数据；不包含任何个人信息（需求 8）。
 */
const { app, session } = require('electron');
const fs = require('fs');
const path = require('path');

// 【登录态保障】固定 userData 路径：安装版/便携版/开发版统一使用
// %APPDATA%\FNMusicPC。便携版若不固定，数据会随 exe 位置/版本移动而丢失，
// 表现为"每次打开都要重新登录"。
// 注意：必须位于任何 getPath('userData') 调用（含 readPreReadyConfig 硬件加速
// 决策）之前——审查轮 H2：此前顺序错误导致固定路径下硬件加速关闭永不生效。
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'FNMusicPC'));
} catch (e) {
  console.error('设置 userData 路径失败:', e && e.message);
}

// H1：旧数据迁移（v0.1.5 及以前默认 %APPDATA%\fnmusic-pc → 新固定路径）。
// 首次启动检测旧目录存在而新目录为空时，迁移 settings.json 与登录态分区，
// 避免升级后"重新配置 + 重新登录"。
try {
  const oldDir = path.join(app.getPath('appData'), 'fnmusic-pc');
  const newDir = path.join(app.getPath('appData'), 'FNMusicPC');
  if (fs.existsSync(oldDir) && fs.existsSync(newDir)) {
    const onlyEmpty = fs.readdirSync(newDir).length === 0;
    if (onlyEmpty) {
      for (const item of ['settings.json', 'Partitions']) {
        const src = path.join(oldDir, item);
        if (fs.existsSync(src)) {
          try { fs.renameSync(src, path.join(newDir, item)); } catch { /* 单文件失败不阻塞 */ }
        }
      }
    }
  }
} catch { /* 迁移失败不阻塞启动 */ }
const logger = require('./logger');
const settings = require('./settings');
const security = require('./security');
const windowManager = require('./window-manager');
const audioDevices = require('./audio-devices');
const ipc = require('./ipc');
const menu = require('./menu');
const tray = require('./tray');

// 【兼容性】硬件加速策略：默认开启；用户可在设置/欢迎页关闭（部分显卡/驱动/远程桌面
// 环境下 Chromium GPU 合成失败会黑屏）。必须在 Chromium 初始化前决定，重启生效。
// CLI 逃生口（审查轮 D1）：黑屏无法操作 UI 时，可在启动参数中强制切换——
//   --disable-gpu        强制软件渲染（修黑屏）
//   --hardware-acceleration  强制开启硬件加速
let forceGpu = null;
for (const arg of process.argv) {
  if (arg === '--disable-gpu') forceGpu = false;
  else if (arg === '--hardware-acceleration') forceGpu = true;
}
try {
  const preReady = settings.readPreReadyConfig();
  const useHardware = forceGpu !== null ? forceGpu : preReady.hardwareAcceleration;
  if (!useHardware) {
    app.disableHardwareAcceleration();
    logger.info('已按设置禁用硬件加速（软件渲染）' + (forceGpu === false ? ' [CLI 逃生口]' : ''));
  } else if (forceGpu === true) {
    logger.info('已按 CLI 参数强制开启硬件加速');
  }
} catch (e) {
  logger.warn('读取硬件加速设置失败（使用默认开启）:', e.message);
}

// Windows 通知/任务栏分组标识（需在 ready 前设置）
app.setAppUserModelId('com.fnmusic.pc');

// 【重要】启动早期（Chromium 初始化前）：把已配置的 http 服务器来源标记为安全上下文。
// 原因：飞牛音乐网页多为内网纯 HTTP 地址，Chromium 视其为非安全上下文，
// 页面内 navigator.mediaDevices 不可用，导致音频输出设备无法枚举/定向。
// 此开关仅作用于用户自己配置的来源，不影响其他站点（详见 settings.js 说明）。
try {
  const preReady = settings.readPreReadyConfig();
  if (preReady.origins.length) {
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', preReady.origins.join(','));
    logger.info('已将以下 HTTP 来源标记为安全上下文:', preReady.origins.join(', '));
  }
} catch (e) {
  logger.warn('安全上下文标记失败（不影响启动）:', e.message);
}

// 单实例：重复启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在运行：通知旧实例显示窗口后退出本进程。
  // 若用户感觉"打不开"，请检查任务管理器是否残留 FNMusicPC.exe / electron.exe 进程。
  app.quit();
} else {
  app.on('second-instance', () => {
    // 已有实例运行：显示并聚焦主窗口（解决"双击没反应"——旧实例还在后台）
    // tray.showMainWindow 内部对「托盘尚未创建」场景有 window-manager 兜底
    tray.showMainWindow();
  });

  app.whenReady().then(bootstrap);
}

/** 应用启动引导 */
function bootstrap() {
  settings.load();
  logger.info('FN Music PC 启动 v' + app.getVersion(), 'platform=' + process.platform);
  // 登录态诊断：userData 路径、persist 分区 Cookie 文件、settings 状态
  // （Electron 33+/Chromium 新版 Cookie 数据库位于 Partitions/fnmusic-guest/Network/Cookies，
  //   旧版在分区根目录——两处都检查，避免误报「不存在」；路径做脱敏，避免日志分享时泄露用户名）
  try {
    const home = app.getPath('home');
    const sanitized = (p) => (home ? String(p).replace(home, '%USERPROFILE%') : String(p));
    const cookiePathNew = path.join(app.getPath('userData'), 'Partitions', 'fnmusic-guest', 'Network', 'Cookies');
    const cookiePathOld = path.join(app.getPath('userData'), 'Partitions', 'fnmusic-guest', 'Cookies');
    const cookieFile = fs.existsSync(cookiePathNew) ? cookiePathNew : (fs.existsSync(cookiePathOld) ? cookiePathOld : null);
    logger.info('userData 路径:', sanitized(app.getPath('userData')));
    logger.info('登录态 Cookie 文件:', cookieFile ? (fs.statSync(cookieFile).size + ' bytes') : '不存在');
    logger.info('settings.json:', fs.existsSync(path.join(app.getPath('userData'), 'settings.json')) ? '存在' : '不存在');
  } catch (e) {
    logger.warn('登录态诊断失败:', e.message);
  }

  // guest 会话：独立持久分区（登录态保存在 userData 下）
  const guestSession = session.fromPartition(windowManager.GUEST_PARTITION);
  security.setupGuestSessionSecurity(guestSession, () => settings.getAll());
  guestSession.setPreloads([path.join(__dirname, 'guest-preload.js')]);

  menu.setupMenu();
  windowManager.createMainWindow();
  // 系统托盘（后台运行）；窗口隐藏时仍可从此恢复
  tray.createTray(() => windowManager.getMainWindow());
  ipc.register({ guestSession });

  // 全局兜底日志（不崩溃退出，仅记录）
  process.on('uncaughtException', (e) => logger.error('未捕获异常:', e && e.stack ? e.stack : e));
  process.on('unhandledRejection', (e) => logger.error('未处理 Promise 拒绝:', e && e.message ? e.message : e));

  // 登录态落盘保障：Cookie 默认异步延迟写盘，异常退出（强杀/断电）会丢最近登录态。
  // 周期性强制 flush + 退出时 flush，确保"登录一次，下次免登录"。
  const cookieFlushTimer = setInterval(() => {
    guestSession.cookies.flushStore().catch(() => {});
  }, 60000);
  // 渲染异常自动降级：主窗口 ready-to-show 超时（黑屏）时触发。
  // 仅当用户未显式设置过硬件加速时自动关闭（软件渲染，重启生效）并弹窗提示；
  // 用户显式配置过硬件加速后不再自动干预（尊重用户选择）。
  global.__fnmusicRenderFallback = () => {
    try {
      const s = settings.getAll();
      if (s.hardwareAcceleration && !s.hardwareAccelUserSet) {
        settings.update({ hardwareAcceleration: false });
        logger.warn('检测到渲染异常：已自动切换为软件渲染（重启客户端后生效）');
        const { dialog } = require('electron');
        dialog.showMessageBox({
          type: 'warning',
          title: '显示异常',
          message: '检测到窗口渲染异常（可能是显卡/驱动兼容性问题），已自动切换为软件渲染。',
          detail: '需要重启客户端后生效。是否立即重启？',
          buttons: ['立即重启', '稍后'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) {
            app.relaunch();
            app.exit(0);
          }
        }).catch(() => {});
      }
    } catch (e) {
      logger.warn('自动降级失败:', e.message);
    }
  };

  app.on('before-quit', () => {
    global.__fnmusicQuit = true; // 允许主窗口 close 真正生效
    guestSession.cookies.flushStore().catch(() => {});
  });
  app.on('will-quit', () => {
    // 定时器在真正退出时才清理（避免退出被取消后本会话失去周期 flush——审查轮 C1）
    clearInterval(cookieFlushTimer);
    guestSession.cookies.flushStore().catch(() => {});
  });

  // 自动化冒烟测试：npm run smoke（仅开发/CI 使用；打包产物不启用）
  if (!app.isPackaged && process.argv.includes('--smoke-test')) {
    app.commandLine.appendSwitch('disable-gpu'); // CI/远程桌面环境确定性（审查轮 D4）
    runSmokeTest();
  }
}

/** 冒烟测试：加载完成后校验核心链路并退出 */
async function runSmokeTest() {
  try {
    await windowManager.whenFirstContent();
    logger.info('SMOKE: 主界面与内容加载完成');

    const wc = windowManager.getGuestWebContents();
    if (wc && !wc.isDestroyed()) {
      const sum = await wc.executeJavaScript('1+1');
      logger.info('SMOKE: guest 页面 JS 执行结果 =', sum);

      const dev = await audioDevices.listDevices(wc);
      logger.info('SMOKE: 音频设备枚举', dev.ok ? ('设备数=' + (dev.devices || []).length) : ('失败: ' + dev.error));
    }
    logger.info('SMOKE: PASS');
    app.exit(0);
  } catch (e) {
    logger.error('SMOKE: FAIL', e && e.stack ? e.stack : e);
    app.exit(1);
  }
}

// 全部窗口关闭即退出（托盘「退出」路径；关闭按钮默认最小化到托盘，见 window-manager）
app.on('window-all-closed', () => {
  app.quit();
});