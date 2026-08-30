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
 * 5. 桌面歌词：捕获网页接口歌词数据驱动悬浮窗（需求 6，可选）；
 * 6. 不收集任何用户数据；不包含任何个人信息（需求 8）。
 */
const { app, session } = require('electron');
const path = require('path');
const logger = require('./logger');
const settings = require('./settings');
const security = require('./security');
const windowManager = require('./window-manager');
const lyrics = require('./lyrics');
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
  app.on('before-quit', () => {
    global.__fnmusicQuit = true; // 允许主窗口 close 真正生效
    lyrics.dispose();
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