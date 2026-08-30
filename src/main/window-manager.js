'use strict';
/**
 * 主窗口与内容视图管理
 *
 * 布局：主窗口是一个「壳」——顶部 44px 为自绘工具栏（本地页面 toolbar.html），
 * 其余区域挂载 WebContentsView 承载飞牛音乐网页（独立持久分区 persist:fnmusic-guest）。
 *
 * 两种壳模式：
 * - welcome：尚未配置服务器时，壳内显示本地欢迎页（welcome.html）；
 * - app：已配置服务器，壳内显示工具栏 + 挂载网页视图（懒创建）。
 *
 * 加载策略（需求 3 / 需求 2）：
 * - auto 模式：本地优先；did-fail-load 自动切远程；另有 12s 加载看门狗，
 *   本地地址长时间无响应（TCP 挂起）时同样切换远程；
 * - local / remote 模式：分别固定使用本地 / 远程地址。
 *
 * 主世界注入：dom-ready 后向网页主世界注入 guest-mainworld.js
 * （AudioContext 定向输出 + 歌词捕获，见该文件说明）。
 */
const fs = require('fs');
const { BrowserWindow, WebContentsView, app } = require('electron');
const path = require('path');
const logger = require('./logger');
const settings = require('./settings');
const serverUrl = require('./server-url');
const security = require('./security');
const lyrics = require('./lyrics');

/** 工具栏高度（与 titleBarOverlay 高度保持一致） */
const TOOLBAR_HEIGHT = 44;
/** 独立持久分区：飞牛音乐网页的 cookie/localStorage 等登录态保存在这里 */
const GUEST_PARTITION = 'persist:fnmusic-guest';
/** auto 模式本地加载看门狗时长（ms）：超时仍未加载完成则切换远程 */
const LOAD_WATCHDOG_MS = 12000;

/** 主世界注入脚本内容（缓存，避免重复读盘） */
let mainWorldScript = null;

let mainWindow = null;
let guestView = null;           // 懒创建：首次进入 app 模式才创建
let guestAttached = false;      // guestView 是否已挂到 contentView
let shellMode = 'welcome';      // 'welcome' | 'app'
let lastIntent = null;          // {url, mode, fallback, triedRemote}
let watchdogTimer = null;       // 加载看门狗
let reloadTimer = null;         // 渲染进程崩溃后的延迟重载
let firstContentResolvers = []; // --smoke-test 用
let firstContentDone = false;
const pageLoadedCallbacks = []; // 页面加载完成回调（设置回放）

/** 读取主世界注入脚本 */
function getMainWorldScript() {
  if (!mainWorldScript) {
    try {
      mainWorldScript = fs.readFileSync(path.join(__dirname, 'guest-mainworld.js'), 'utf8');
    } catch (e) {
      logger.error('读取主世界脚本失败:', e.message);
      mainWorldScript = '';
    }
  }
  return mainWorldScript;
}

/* ---------------- 窗口创建 ---------------- */

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#1f2329',
    autoHideMenuBar: true,
    title: 'FN Music PC',
    // Windows 隐藏原生标题栏但保留系统窗口按钮（最小化/最大化/关闭）
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1f2329', symbolColor: '#e8e8e8', height: TOOLBAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  // 壳页面禁止任意导航（壳本身是静态本地页面）
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.on('resize', () => layout());
  mainWindow.on('closed', () => {
    mainWindow = null;
    guestView = null;
    guestAttached = false;
    clearWatchdog();
    clearTimeout(reloadTimer);
    // 音乐客户端：主窗口关闭即退出整个应用（含歌词窗，避免"僵尸进程"）
    app.quit();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  loadHome();
  return mainWindow;
}

/** 创建承载飞牛音乐网页的 WebContentsView（懒创建，仅 app 模式需要） */
function createGuestView() {
  const view = new WebContentsView({
    webPreferences: {
      partition: GUEST_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  const wc = view.webContents;

  security.setupWindowOpenHandler(wc);

  // 只允许 http/https 导航
  wc.on('will-navigate', (e, url) => {
    if (!/^https?:/.test(url)) e.preventDefault();
  });

  // 主世界注入（AudioContext 定向 / 歌词捕获）
  wc.on('dom-ready', () => {
    const script = getMainWorldScript();
    if (script) {
      wc.executeJavaScript(script).catch((e) => logger.warn('主世界注入失败:', e.message));
    }
  });

  wc.on('did-start-loading', () => pushStatus());
  wc.on('did-stop-loading', () => pushStatus());
  wc.on('did-navigate', () => pushStatus());
  wc.on('did-navigate-in-page', () => pushStatus());
  wc.on('page-title-updated', (_e, title) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(title ? `飞牛音乐 - ${title}` : 'FN Music PC');
    }
  });

  // 加载失败：auto 模式自动回退到 FN Connect 远程地址
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED：用户主动取消
    clearWatchdog();
    logger.warn('页面加载失败:', errorCode, errorDescription, serverUrl.displayHost(validatedURL));
    // 双侧归一化（Chromium 的 validatedURL 通常带尾斜杠，validateUrl 输出不带）
    const norm = (u) => { try { return String(u).replace(/\/+$/, ''); } catch { return u; } };
    if (lastIntent && lastIntent.fallback && !lastIntent.triedRemote && norm(validatedURL) === norm(lastIntent.url)) {
      lastIntent.triedRemote = true;
      logger.info('auto 模式：切换到 FN Connect 远程地址');
      wc.loadURL(lastIntent.fallback).catch((e) => logger.warn('远程地址加载失败:', e.message));
    }
    pushStatus();
  });

  // 渲染进程崩溃：记录并尝试自动重载「当前实际地址」（而非固定本地地址）
  wc.on('render-process-gone', (_e, details) => {
    logger.error('网页渲染进程异常退出:', details.reason);
    pushStatus();
    const currentUrl = wc.getURL();
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (!wc.isDestroyed() && currentUrl && /^https?:/.test(currentUrl)) {
        wc.loadURL(currentUrl).catch(() => {});
      }
    }, 1500);
  });

  wc.on('did-finish-load', () => {
    pushStatus();
    resolveFirstContent();
    // 页面（重新）加载后回放设置：音频输出设备、桌面歌词开关
    for (const cb of pageLoadedCallbacks) {
      try { cb(); } catch (e) { logger.warn('页面加载回调异常:', e.message); }
    }
  });

  return view;
}

/** 确保 guest 视图存在 */
function ensureGuestView() {
  if (!guestView || guestView.webContents.isDestroyed()) {
    guestView = createGuestView();
  }
  return guestView;
}

/* ---------------- 模式切换与布局 ---------------- */

function attachGuest() {
  if (!mainWindow || !guestView || guestAttached) return;
  try {
    mainWindow.contentView.addChildView(guestView);
    guestAttached = true;
  } catch (e) {
    logger.warn('挂载网页视图失败:', e.message);
  }
  layout();
}

function detachGuest() {
  if (!guestView || !guestAttached) return;
  try {
    mainWindow.contentView.removeChildView(guestView);
    guestAttached = false;
    // 停止加载并暂停媒体播放，避免欢迎页状态下后台继续出声
    if (!guestView.webContents.isDestroyed()) {
      guestView.webContents.stop();
      guestView.webContents.executeJavaScript(
        '(()=>{try{document.querySelectorAll("audio,video").forEach(el=>{try{el.pause()}catch(e){}})}catch(e){}})()'
      ).catch(() => {});
    }
  } catch (e) {
    logger.warn('卸载网页视图失败:', e.message);
  }
}

/** 按窗口尺寸摆放网页视图（工具栏以下区域） */
function layout() {
  if (!mainWindow || !guestView || shellMode !== 'app' || !guestAttached) return;
  const [w, h] = mainWindow.getContentSize();
  guestView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - TOOLBAR_HEIGHT) });
}

/** 切换到指定壳模式 */
function switchShellMode(mode) {
  if (shellMode === mode) return;
  shellMode = mode;
  if (mode === 'app') {
    mainWindow.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'toolbar.html'));
    ensureGuestView();
    attachGuest();
  } else {
    detachGuest();
    mainWindow.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'welcome.html'));
  }
}

/* ---------------- 导航 ---------------- */

/** 加载看门狗：auto 模式本地地址长时间无响应时切换远程 */
function startWatchdog() {
  clearWatchdog();
  if (!lastIntent || !lastIntent.fallback || lastIntent.triedRemote) return;
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    const wc = guestView && !guestView.webContents.isDestroyed() ? guestView.webContents : null;
    if (!wc) return;
    if (wc.isLoading()) {
      lastIntent.triedRemote = true;
      logger.info('看门狗触发：本地地址超时，切换到 FN Connect 远程地址');
      wc.stop();
      wc.loadURL(lastIntent.fallback).catch((e) => logger.warn('远程地址加载失败:', e.message));
    }
  }, LOAD_WATCHDOG_MS);
}

function clearWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

/**
 * 按当前设置加载主页（并决定壳模式）
 * auto 模式：本地优先，失败/超时自动回退远程
 */
function loadHome() {
  const s = settings.getAll();
  const resolved = serverUrl.resolve(s);
  const remote = serverUrl.validateUrl(s.remoteUrl);

  if (!resolved.url) {
    switchShellMode('welcome');
    resolveFirstContent();
    return;
  }

  switchShellMode('app');

  lastIntent = {
    url: resolved.url,
    mode: resolved.mode,
    // 仅 auto 且本地优先时记录远程回退目标
    fallback: resolved.mode === 'auto' && remote && resolved.url !== remote ? remote : null,
    triedRemote: false,
  };

  logger.info('加载飞牛音乐:', serverUrl.displayHost(resolved.url), '(模式:' + resolved.mode + ')');
  ensureGuestView();
  guestView.webContents
    .loadURL(resolved.url)
    .catch((e) => logger.warn('加载启动失败:', e.message));
  startWatchdog();
  pushStatus();
}

/** 工具栏导航动作 */
function navigate(action) {
  if (!guestView || shellMode !== 'app') return;
  const wc = guestView.webContents;
  switch (action) {
    case 'back': wc.canGoBack() && wc.goBack(); break;
    case 'forward': wc.canGoForward() && wc.goForward(); break;
    case 'reload': wc.reload(); startWatchdog(); break;
    case 'home': loadHome(); break;
    default: break;
  }
}

/* ---------------- 状态推送（URL 脱敏：只含 origin+path，去掉 query/hash） ---------------- */

function sanitizeUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** 向壳页面推送当前状态（工具栏展示用） */
function pushStatus() {
  if (!mainWindow || mainWindow.isDestroyed() || shellMode !== 'app') return;
  const wc = guestView && !guestView.webContents.isDestroyed() ? guestView.webContents : null;
  const payload = {
    shellMode,
    url: wc ? sanitizeUrl(wc.getURL()) : '',
    title: wc ? wc.getTitle() : '',
    canGoBack: wc ? wc.canGoBack() : false,
    canGoForward: wc ? wc.canGoForward() : false,
    isLoading: wc ? wc.isLoading() : false,
  };
  try {
    mainWindow.webContents.send('toolbar:status', payload);
  } catch { /* 壳页面尚未就绪时静默忽略 */ }
}

/* ---------------- 供其他模块使用 ---------------- */

function getMainWindow() { return mainWindow; }
function getGuestWebContents() { return guestView && !guestView.webContents.isDestroyed() ? guestView.webContents : null; }

/** 注册「页面加载完成」回调（设置回放：音频设备/歌词开关） */
function onGuestPageLoaded(cb) {
  if (typeof cb === 'function') pageLoadedCallbacks.push(cb);
}

/** 首次内容加载完成（--smoke-test 用） */
function resolveFirstContent() {
  if (firstContentDone) return;
  firstContentDone = true;
  firstContentResolvers.forEach((fn) => fn());
  firstContentResolvers = [];
}

function whenFirstContent(timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    if (firstContentDone) return resolve();
    const timer = setTimeout(() => {
      firstContentResolvers = firstContentResolvers.filter((f) => f !== onDone);
      reject(new Error('等待内容加载超时'));
    }, timeoutMs);
    const onDone = () => { clearTimeout(timer); resolve(); };
    firstContentResolvers.push(onDone);
  });
}

module.exports = {
  createMainWindow,
  loadHome,
  navigate,
  getMainWindow,
  getGuestWebContents,
  onGuestPageLoaded,
  pushStatus,
  whenFirstContent,
  GUEST_PARTITION,
  TOOLBAR_HEIGHT,
};