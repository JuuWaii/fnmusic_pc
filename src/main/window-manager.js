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

  // 壳页面渲染生命周期日志（诊断黑屏用）
  mainWindow.webContents.on('did-start-loading', () => logger.info('壳页面开始加载'));
  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('壳页面加载完成:', mainWindow.webContents.getURL());
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    logger.error('壳页面加载失败:', code, desc);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logger.error('壳页面渲染进程异常:', details.reason);
  });
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    // 页面侧 console 输出（仅记录错误与警告）
    if (level >= 2) logger.warn('[壳页面]', String(message).slice(0, 300));
  });

  mainWindow.on('resize', () => layout());
  let readyTimer = null; // ready-to-show 超时兜底定时器（closed 时清理）

  // 关闭按钮（X）行为：
  // - 「关闭时最小化到托盘」开启：隐藏到托盘，网页继续后台播放；
  // - 关闭该选项或托盘「退出」：真正退出应用（含歌词窗，避免僵尸进程）。
  mainWindow.on('close', (e) => {
    if (!global.__fnmusicQuit && settings.getAll().minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
      return;
    }
    global.__fnmusicQuit = true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    guestView = null;
    guestAttached = false;
    clearWatchdog();
    clearTimeout(reloadTimer);
    clearTimeout(readyTimer);
    // 主窗口真正关闭（托盘退出/关闭托盘选项）时退出整个应用
    app.quit();
  });
  // 渲染就绪后再显示；若 GPU/渲染异常导致 ready-to-show 迟迟不触发，
  // 5 秒后强制显示窗口（黑屏问题兜底），并记录日志便于排查。
  readyTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      logger.warn('ready-to-show 超时（5s），强制显示窗口——疑似渲染异常');
      mainWindow.show();
    }
  }, 5000);
  mainWindow.once('ready-to-show', () => {
    clearTimeout(readyTimer);
    mainWindow.show();
  });
  mainWindow.on('show', () => logger.info('主窗口已显示'));
  mainWindow.on('hide', () => logger.info('主窗口已隐藏'));

  // 显示后 3 秒自检壳页面状态（诊断黑屏）
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents
        .executeJavaScript('({ ready: document.readyState, title: document.title, url: location.href, bodyChildren: document.body ? document.body.children.length : -1, css: !!document.styleSheets.length })', true)
        .then((s) => logger.info('壳页面自检:', JSON.stringify(s)))
        .catch((e) => logger.error('壳页面自检失败:', e && e.message));
    }, 3000);
  });

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
  // 注：飞牛门户可能把应用渲染在（跨域）iframe 中，因此向主 frame 与全部子 frame 注入，
  // 并通过 frame-created 覆盖运行时动态创建的 iframe。
  wc.on('dom-ready', () => injectMainWorldIntoFrames());
  wc.on('frame-created', (_e, details) => {
    const frame = details && details.frame;
    if (frame && (!wc.mainFrame || frame !== wc.mainFrame)) {
      injectIntoFrame(frame);
    }
  });

  /** 注入失败记录（供诊断接口展示，审查轮 A P12） */
  const injectFailures = [];

  /** 向主 frame 及其全部后代 frame 注入主世界脚本（framesInSubtree 覆盖嵌套 iframe） */
  function injectMainWorldIntoFrames() {
    const script = getMainWorldScript();
    if (!script) return;
    const frames = [];
    try {
      if (wc.mainFrame) {
        frames.push(wc.mainFrame);
        for (const f of wc.mainFrame.framesInSubtree || []) {
          if (f !== wc.mainFrame) frames.push(f);
        }
      }
    } catch (e) {
      logger.warn('枚举 frame 失败:', e.message);
    }
    for (const frame of frames) injectIntoFrame(frame);
  }

  /** 向单个 frame 注入主世界脚本，并回放当前音频输出设备 */
  function injectIntoFrame(frame) {
    if (!frame || typeof frame.executeJavaScript !== 'function') return;
    const script = getMainWorldScript();
    if (!script) return;
    frame
      .executeJavaScript(script)
      .then(() => {
        // 注入后立即回放已保存的音频输出设备与音量（新 frame 没收到过切换消息）
        const s = settings.getAll();
        const deviceId = s.audioDeviceId || '';
        const volume = typeof s.volume === 'number' ? s.volume : 1;
        return frame.executeJavaScript(
          'window.__fnmusicSetSinkNow && window.__fnmusicSetSinkNow(' + JSON.stringify(deviceId) + ');' +
          'window.__fnmusicSetVolume && window.__fnmusicSetVolume(' + JSON.stringify(volume) + ');'
        );
      })
      .catch((e) => {
        const msg = 'frame 注入失败: ' + (e && e.message || e);
        logger.warn(msg);
        injectFailures.push(msg.slice(0, 200));
        if (injectFailures.length > 10) injectFailures.shift();
      });
  }

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

  if (!resolved.url) {
    switchShellMode('welcome');
    resolveFirstContent();
    return;
  }

  switchShellMode('app');

  lastIntent = {
    url: resolved.url,
    mode: resolved.mode,
    // 远程回退目标（已含音乐入口路径，见 server-url.resolve）
    fallback: resolved.fallback,
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
    case 'back': if (canGoBack(wc)) goBack(wc); break;
    case 'forward': if (canGoForward(wc)) goForward(wc); break;
    case 'reload': wc.reload(); startWatchdog(); break;
    case 'home': loadHome(); break;
    default: break;
  }
}

/* ---------------- 导航历史（Electron 33+ 推荐 navigationHistory） ---------------- */

function canGoBack(wc) {
  try { return wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(); } catch { return false; }
}
function canGoForward(wc) {
  try { return wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(); } catch { return false; }
}
function goBack(wc) {
  try { if (wc.navigationHistory) wc.navigationHistory.goBack(); else wc.goBack(); } catch { /* 忽略 */ }
}
function goForward(wc) {
  try { if (wc.navigationHistory) wc.navigationHistory.goForward(); else wc.goForward(); } catch { /* 忽略 */ }
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
    canGoBack: wc ? canGoBack(wc) : false,
    canGoForward: wc ? canGoForward(wc) : false,
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

/** 注入失败记录（诊断用） */
function getInjectFailures() {
  return injectFailures.slice();
}

/** 收集全部 frame 的主世界诊断（审查轮 A P8：iframe 播放器场景不再"全绿误导"） */
async function diagnoseAllFrames() {
  const result = { frames: [], injectFailures: getInjectFailures() };
  if (!guestView || guestView.webContents.isDestroyed() || !guestView.webContents.mainFrame) return result;
  const frames = [guestView.webContents.mainFrame];
  try {
    for (const f of guestView.webContents.mainFrame.framesInSubtree || []) {
      if (f !== guestView.webContents.mainFrame) frames.push(f);
    }
  } catch { /* 忽略 */ }
  const code = '(window.__fnmusicDiagnose ? window.__fnmusicDiagnose() : { injected: false })';
  const tasks = frames.map((frame) =>
    frame
      .executeJavaScript(code, true)
      .then((d) => ({ url: serverUrl.sanitizeUrl(frame.url || ''), data: d }))
      .catch((e) => ({ url: serverUrl.sanitizeUrl(frame.url || ''), data: { injected: false, error: e && e.message } }))
  );
  const settled = await Promise.allSettled(tasks);
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) result.frames.push(s.value);
  }
  return result;
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
  diagnoseAllFrames,
  pushStatus,
  whenFirstContent,
  GUEST_PARTITION,
  TOOLBAR_HEIGHT,
};