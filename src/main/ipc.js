'use strict';
/**
 * IPC 总线：壳页面（工具栏/欢迎页/设置页）<-> 主进程 <-> guest 网页
 *
 * 安全约定：
 * - 壳页面通过 contextBridge 暴露的受限 API（renderer/preload.js）访问；
 * - 所有来自壳页面的请求都校验发送方（必须是本应用 renderer 目录下的本地页面）；
 * - guest 网页（不可信）只能通过 guest-preload 上报日志（fnmusic:log），
 *   并校验发送来源必须是已配置的服务器主机、限长 500；
 * - 所有通道参数在主进程侧再次校验。
 */
const { ipcMain, BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const settings = require('./settings');
const serverUrl = require('./server-url');
const audioDevices = require('./audio-devices');
const windowManager = require('./window-manager');
const security = require('./security');

/** 设置窗口 */
let settingsWindow = null;
/** 音频调节面板窗口（独立小窗：设备 + 音量，即选即生效） */
let audioPanelWindow = null;

/** 打开设置窗口（welcome=true 时为「欢迎/首次配置」模式） */
function openSettingsWindow(welcome) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 700,
    height: 820,
    minWidth: 580,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: '设置 - FN Music PC',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  // 设置窗口只允许加载本地页面；外链一律交给系统浏览器
  settingsWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      require('electron').shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'), {
    query: { welcome: welcome ? '1' : '0' },
  });
  // 渲染异常机器上 ready-to-show 可能不触发 → 5s 超时兜底强制显示
  // （与主窗口黑屏兜底一致，v0.1.8 修复：此前设置窗口可能永远不显示/显示异常）
  const settingsReadyTimer = setTimeout(() => {
    if (settingsWindow && !settingsWindow.isDestroyed() && !settingsWindow.isVisible()) {
      logger.warn('设置窗口 ready-to-show 超时（5s），强制显示');
      settingsWindow.show();
    }
  }, 5000);
  settingsWindow.once('ready-to-show', () => {
    clearTimeout(settingsReadyTimer);
    settingsWindow.show();
  });
  settingsWindow.on('closed', () => {
    clearTimeout(settingsReadyTimer); // 审查轮 9 P3：与主窗口对齐，防止旧定时器误触发新窗口
    settingsWindow = null;
  });
}

/** 打开音频调节面板（独立小窗；设备/音量调整即时生效，无需保存） */
function openAudioPanelWindow() {
  if (audioPanelWindow && !audioPanelWindow.isDestroyed()) {
    audioPanelWindow.focus();
    return;
  }
  audioPanelWindow = new BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    show: false,
    autoHideMenuBar: true,
    title: '音频调节 - FN Music PC',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  audioPanelWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  // 与设置窗口一致：外链一律交给系统浏览器
  audioPanelWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      require('electron').shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  audioPanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'audio-panel.html'));
  // 渲染异常机器上 ready-to-show 可能不触发 → 5s 超时兜底强制显示（v0.1.8 修复）
  const panelReadyTimer = setTimeout(() => {
    if (audioPanelWindow && !audioPanelWindow.isDestroyed() && !audioPanelWindow.isVisible()) {
      logger.warn('音频面板 ready-to-show 超时（5s），强制显示');
      audioPanelWindow.show();
    }
  }, 5000);
  audioPanelWindow.once('ready-to-show', () => {
    clearTimeout(panelReadyTimer);
    audioPanelWindow.show();
  });
  audioPanelWindow.on('closed', () => { audioPanelWindow = null; });
}

/**
 * 校验 IPC 发送方：必须是本应用 renderer 目录下的本地页面（file://）
 * @param {import('electron').IpcMainInvokeEvent | import('electron').IpcMainEvent} event
 */
function isTrustedShellSender(event) {
  try {
    const url = (event.senderFrame && event.senderFrame.url) || event.sender.getURL();
    const filePath = url.startsWith('file:///') ? decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) : '';
    const rendererDir = path.join(__dirname, '..', 'renderer');
    const resolved = path.resolve(filePath);
    return resolved.startsWith(rendererDir + path.sep) || resolved === rendererDir;
  } catch {
    return false;
  }
}

/**
 * 校验 guest 上报来源：必须是已配置的服务器主机
 * @param {import('electron').IpcMainEvent} event
 */
function isTrustedGuestSender(event) {
  try {
    const url = (event.senderFrame && event.senderFrame.url) || event.sender.getURL();
    return security.isTrustedOrigin(() => settings.getAll(), url);
  } catch {
    return false;
  }
}

/**
 * 注册全部 IPC 处理器
 * @param {{guestSession: import('electron').Session}} ctx
 */
function register(ctx) {
  const { guestSession } = ctx;

  /* ---------- 设置 ---------- */
  ipcMain.handle('settings:get', (event) => {
    if (!isTrustedShellSender(event)) return null;
    return settings.getAll();
  });

  ipcMain.handle('settings:save', (event, patch) => {
    if (!isTrustedShellSender(event)) return { ok: false, error: '拒绝访问' };
    const p = patch && typeof patch === 'object' ? patch : {};

    // 服务器地址在保存前统一规范化（长度上限 + 格式校验），防止脏数据入库
    for (const key of ['serverUrl', 'remoteUrl']) {
      if (key in p) {
        const raw = typeof p[key] === 'string' ? p[key].trim() : '';
        const normalized = raw ? serverUrl.validateUrl(raw) : '';
        if (raw && !normalized) {
          logger.warn('拒绝保存非法服务器地址');
          return { ok: false, error: '服务器地址格式不正确（需 http:// 或 https://）', settings: settings.getAll() };
        }
        p[key] = normalized;
      }
    }

    const prev = settings.getAll();
    const next = settings.update(p);
    // 硬件加速变更需要重启才生效（返回给渲染层提示）
    const needsRestart = 'hardwareAcceleration' in p && p.hardwareAcceleration !== prev.hardwareAcceleration;

    // 仅当「解析后的实际加载地址」发生变化时才重新加载主页（避免保存音量等无关设置时打断播放）
    // 审查轮 9 P2：musicPath 变更同样影响解析结果（v0.1.8 起带路径地址也会追加），需联动重载
    if ('serverUrl' in p || 'remoteUrl' in p || 'accessMode' in p || 'musicPath' in p) {
      const prevResolved = serverUrl.resolve(prev);
      const nextResolved = serverUrl.resolve(next);
      if (prevResolved.url !== nextResolved.url || prev.accessMode !== next.accessMode) {
        windowManager.loadHome();
      }
    }
    // 音频输出设备变更
    if ('audioDeviceId' in p) {
      audioDevices.setDevice(windowManager.getGuestWebContents(), next.audioDeviceId);
    }
    // 用户显式更改硬件加速 → 标记（自动降级不再干预；仅值实际变化时置位，
    // 避免"任意保存"污染标记——审查轮 M1）
    if ('hardwareAcceleration' in p && p.hardwareAcceleration !== prev.hardwareAcceleration) {
      settings.update({ hardwareAccelUserSet: true });
    }
    return { ok: true, settings: settings.getAll(), needsRestart };
  });

  /* ---------- 服务器 ---------- */
  ipcMain.handle('server:test', async (event, rawUrl) => {
    if (!isTrustedShellSender(event)) return { ok: false, error: '拒绝访问' };
    // 与应用实际加载一致：自动追加音乐入口路径后再测试
    const url = serverUrl.applyMusicPath(rawUrl, settings.getAll());
    if (!url) return { ok: false, error: '地址格式不正确（需 http:// 或 https://，且不超过 2048 字符）' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const resp = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
      // 重定向收窄：最终地址必须是 http(s)
      if (!/^https?:/.test(resp.url || url)) {
        return { ok: false, error: '连接被重定向到非 http(s) 地址' };
      }
      return { ok: true, status: resp.status };
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? '连接超时（6 秒）' : ((e && e.message) || String(e));
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  });

  /* ---------- 音频设备 ---------- */
  ipcMain.handle('audio:list', async (event) => {
    if (!isTrustedShellSender(event)) return { ok: false, error: '拒绝访问' };
    return audioDevices.listDevices(windowManager.getGuestWebContents());
  });

  ipcMain.handle('audio:set', (event, payload) => {
    if (!isTrustedShellSender(event)) return null;
    const id = payload && typeof payload.deviceId === 'string' ? payload.deviceId : '';
    audioDevices.setDevice(windowManager.getGuestWebContents(), id);
    return settings.getAll().audioDeviceId;
  });

  /* ---------- 音量 ---------- */
  ipcMain.handle('volume:set', (event, payload) => {
    if (!isTrustedShellSender(event)) return null;
    const v = payload && payload.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return settings.getAll().volume; // 非法载荷：忽略（不静音不清零）
    }
    audioDevices.setVolume(windowManager.getGuestWebContents(), v);
    return settings.getAll().volume;
  });

  /* ---------- 导航 ---------- */
  ipcMain.handle('nav:action', (event, action) => {
    if (!isTrustedShellSender(event)) return;
    const allowed = ['back', 'forward', 'reload', 'home'];
    if (allowed.includes(action)) windowManager.navigate(action);
  });

  /* ---------- 数据清理（隐私） ---------- */
  ipcMain.handle('data:clear', async (event) => {
    if (!isTrustedShellSender(event)) return { ok: false, error: '拒绝访问' };
    try {
      await guestSession.clearStorageData();
      await guestSession.clearCache();
      await guestSession.clearAuthCache(); // 清除 HTTP 基本认证凭据
      logger.info('已清除网页登录数据（cookie/缓存/认证/本地存储）');
      windowManager.loadHome();
      return { ok: true };
    } catch (e) {
      logger.error('清除数据失败:', e.message);
      return { ok: false, error: e.message };
    }
  });

  /* ---------- 音频诊断（排查设备切换问题） ---------- */
  ipcMain.handle('app:diagnose-audio', async (event) => {
    if (!isTrustedShellSender(event)) return null;
    const wc = windowManager.getGuestWebContents();
    const logDir = logger.getLogDir();
    const result = { page: null, logTail: '', logDir: logDir || null };
    // 多 frame 聚合诊断（含 iframe；注入失败记录一并返回）
    result.page = await windowManager.diagnoseAllFrames();
    // 登录态诊断：cookie 数量 + localStorage 占用（排查"每次重新登录"；
    // localStorage 型登录态不受 cookie flush 保护——审查轮 M4）
    try {
      const cookies = await guestSession.cookies.get({});
      result.cookieCount = cookies.length;
    } catch { result.cookieCount = -1; }
    if (wc && !wc.isDestroyed()) {
      try {
        result.localStorage = await wc.executeJavaScript(
          '(() => { try { let n = 0, len = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) { n++; len += (k.length + String(localStorage.getItem(k) || "").length); } } return { keys: n, bytes: len }; } catch (e) { return { error: String(e && e.message || e) }; } })()',
          true
        );
      } catch { result.localStorage = { error: '不可用' }; }
    }
    // 日志尾部（脱敏后展示，审查轮 C L1/L2：抹掉 URL query/token）
    try {
      if (logDir && fs.existsSync(logDir)) {
        const files = fs.readdirSync(logDir).filter((f) => f.startsWith('main-')).sort().reverse();
        result.logFiles = files;
        if (files.length) {
          const lines = fs.readFileSync(path.join(logDir, files[0]), 'utf8').split(/\r?\n/).filter(Boolean);
          result.logTail = lines
            .slice(-40)
            .map((l) => serverUrl.sanitizeUrl(l))
            .join('\n');
        }
      }
    } catch { /* 无日志时忽略 */ }
    return result;
  });

  /* ---------- 打开日志目录（资源管理器） ---------- */
  ipcMain.handle('app:open-log-dir', (event) => {
    if (!isTrustedShellSender(event)) return false;
    const dir = logger.getLogDir();
    if (!dir) return false;
    const { shell } = require('electron');
    shell.openPath(dir).catch(() => {});
    return true;
  });

  /* ---------- 关于 ---------- */
  ipcMain.handle('app:info', (event) => {
    if (!isTrustedShellSender(event)) return null;
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
    };
  });

  /* ---------- 壳页面就绪 ---------- */
  ipcMain.on('shell:ready', (event) => {
    if (isTrustedShellSender(event)) windowManager.pushStatus();
  });

  /* ---------- 设置窗口 / 音频面板 ---------- */
  ipcMain.on('settings:open', (event, welcome) => {
    if (isTrustedShellSender(event)) openSettingsWindow(Boolean(welcome));
  });
  ipcMain.on('audio-panel:open', (event) => {
    if (isTrustedShellSender(event)) openAudioPanelWindow();
  });
  ipcMain.on('audio-panel:close', (event) => {
    if (isTrustedShellSender(event) && audioPanelWindow && !audioPanelWindow.isDestroyed()) {
      audioPanelWindow.close();
    }
  });
  ipcMain.on('settings:close', (event) => {
    if (isTrustedShellSender(event) && settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });

  /* ---------- guest 网页上报（来源校验 + 限额） ---------- */
  ipcMain.on('fnmusic:log', (event, payload) => {
    if (isTrustedGuestSender(event) && typeof payload === 'string' && payload.length < 500) {
      logger.info('[网页]', payload);
    }
  });

  /* ---------- 页面加载完成 → 回放设置 ---------- */
  windowManager.onGuestPageLoaded(replaySettingsToGuest);

  /* ---------- 供菜单模块调用的全局钩子 ---------- */
  global.__fnmusicOpenSettings = () => openSettingsWindow(false);
  global.__fnmusicNav = (action) => windowManager.navigate(action);
}

/** 页面（重新）加载后回放设置：音频设备 + 音量（刷新/重启后仍生效） */
function replaySettingsToGuest() {
  const s = settings.getAll();
  const wc = windowManager.getGuestWebContents();
  if (!wc || wc.isDestroyed()) return;
  wc.send('fnmusic:set-audio-device', { deviceId: s.audioDeviceId || '' });
  wc.send('fnmusic:set-volume', { value: s.volume });
  // 主世界直接广播（frame 注入后立即生效）
  audioDevices.broadcastToAllFrames(
    wc,
    'window.__fnmusicSetSinkNow && window.__fnmusicSetSinkNow(' + JSON.stringify(s.audioDeviceId || '') + ');' +
    'window.__fnmusicSetVolume && window.__fnmusicSetVolume(' + JSON.stringify(s.volume) + ');'
  );
}

module.exports = { register, openSettingsWindow, openAudioPanelWindow };