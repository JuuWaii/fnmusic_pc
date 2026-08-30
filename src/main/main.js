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

// Windows 通知/任务栏分组标识（需在 ready 前设置）
app.setAppUserModelId('com.fnmusic.pc');

// 【重要】启动早期（Chromium 初始化前）：把已配置的 http 服务器来源标记为安全上下文。
// 原因：飞牛音乐网页多为内网纯 HTTP 地址，Chromium 视其为非安全上下文，
// 页面内 navigator.mediaDevices 不可用，导致音频输出设备无法枚举/定向。
// 此开关仅作用于用户自己配置的来源，不影响其他站点（详见 settings.js 说明）。
try {
  const secureOrigins = settings.readConfiguredOriginsPreReady();
  if (secureOrigins.length) {
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', secureOrigins.join(','));
    logger.info('已将以下 HTTP 来源标记为安全上下文:', secureOrigins.join(', '));
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

  app.on('before-quit', () => {
    global.__fnmusicQuit = true; // 允许主窗口 close 真正生效
    lyrics.dispose();
  });

  // 自动化冒烟测试：npm run smoke（仅开发/CI 使用；打包产物不启用）
  if (!app.isPackaged && process.argv.includes('--smoke-test')) runSmokeTest();
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

// 全部窗口关闭即退出（音乐客户端无需驻留托盘）
app.on('window-all-closed', () => {
  app.quit();
});