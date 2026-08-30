'use strict';
/**
 * IPC 总线：壳页面（工具栏/欢迎页/设置页）<-> 主进程 <-> guest 网页
 *
 * 安全约定：
 * - 壳页面通过 contextBridge 暴露的受限 API（renderer/preload.js）访问；
 * - 所有来自壳页面的请求都校验发送方（必须是本应用 renderer 目录下的本地页面）；
 * - guest 网页（不可信）只能通过 guest-preload 上报歌词/播放进度/日志，
 *   且歌词上报会校验发送来源必须是已配置的服务器主机、并做长度限额；
 * - 所有通道参数在主进程侧再次校验。
 */
const { ipcMain, BrowserWindow, app } = require('electron');
const path = require('path');
const logger = require('./logger');
const settings = require('./settings');
const serverUrl = require('./server-url');
const audioDevices = require('./audio-devices');
const lyrics = require('./lyrics');
const windowManager = require('./window-manager');
const security = require('./security');

/** 设置窗口 */
let settingsWindow = null;

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
  // 设置窗口只允许加载本地页面
  settingsWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'), {
    query: { welcome: welcome ? '1' : '0' },
  });
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
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
    if (!isTrustedShellSender(event)) return null;
    const p = patch && typeof patch === 'object' ? patch : {};

    // 服务器地址在保存前统一规范化（长度上限 + 格式校验），防止脏数据入库
    for (const key of ['serverUrl', 'remoteUrl']) {
      if (key in p) {
        const raw = typeof p[key] === 'string' ? p[key].trim() : '';
        const normalized = raw ? serverUrl.validateUrl(raw) : '';
        if (raw && !normalized) {
          logger.warn('拒绝保存非法服务器地址');
          return settings.getAll();
        }
        p[key] = normalized;
      }
    }

    const prev = settings.getAll();
    const next = settings.update(p);

    // 仅当「解析后的实际加载地址」发生变化时才重新加载主页（避免保存歌词透明度等
    // 无关设置时打断播放）
    if ('serverUrl' in p || 'remoteUrl' in p || 'accessMode' in p) {
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
    // 桌面歌词开关变更
    if ('showDesktopLyrics' in p) {
      lyrics.setEnabled(next.showDesktopLyrics);
      notifyGuestLyricsEnabled(next.showDesktopLyrics);
    }
    if ('lyricsOpacity' in p) lyrics.setOpacity(next.lyricsOpacity);
    return next;
  });

  /* ---------- 服务器 ---------- */
  ipcMain.handle('server:test', async (event, rawUrl) => {
    if (!isTrustedShellSender(event)) return { ok: false, error: '拒绝访问' };
    const url = serverUrl.validateUrl(rawUrl);
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

  /* ---------- 导航 ---------- */
  ipcMain.handle('nav:action', (event, action) => {
    if (!isTrustedShellSender(event)) return;
    const allowed = ['back', 'forward', 'reload', 'home'];
    if (allowed.includes(action)) windowManager.navigate(action);
  });

  /* ---------- 桌面歌词 ---------- */
  ipcMain.handle('lyrics:set-enabled', (event, payload) => {
    if (!isTrustedShellSender(event)) return false;
    const enabled = Boolean(payload && payload.enabled);
    settings.update({ showDesktopLyrics: enabled });
    lyrics.setEnabled(enabled);
    notifyGuestLyricsEnabled(enabled);
    return enabled;
  });

  ipcMain.handle('lyrics:set-opacity', (event, payload) => {
    if (!isTrustedShellSender(event)) return;
    lyrics.setOpacity(payload && payload.value);
  });

  ipcMain.handle('lyrics:set-interactive', (event, payload) => {
    if (!isTrustedShellSender(event)) return;
    lyrics.setInteractive(Boolean(payload && payload.interactive));
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

  /* ---------- 设置窗口 ---------- */
  ipcMain.on('settings:open', (event, welcome) => {
    if (isTrustedShellSender(event)) openSettingsWindow(Boolean(welcome));
  });
  ipcMain.on('settings:close', (event) => {
    if (isTrustedShellSender(event) && settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });

  /* ---------- guest 网页上报（来源校验 + 限额） ---------- */
  ipcMain.on('fnmusic:lyrics', (event, payload) => {
    if (!isTrustedGuestSender(event)) return; // 仅接受来自已配置服务器主机的歌词
    lyrics.onLyrics(payload);
  });
  ipcMain.on('fnmusic:audio-state', (event, payload) => {
    if (!isTrustedGuestSender(event)) return;
    lyrics.onAudioState(payload);
  });
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

/** 通知 guest 网页歌词上报开关 */
function notifyGuestLyricsEnabled(enabled) {
  const wc = windowManager.getGuestWebContents();
  if (wc && !wc.isDestroyed()) {
    wc.send('fnmusic:lyrics-enabled', { enabled: Boolean(enabled) });
  }
}

/** 页面（重新）加载后回放设置：音频输出设备 + 歌词开关（网页刷新/重启后仍生效） */
function replaySettingsToGuest() {
  const s = settings.getAll();
  const wc = windowManager.getGuestWebContents();
  if (!wc || wc.isDestroyed()) return;
  wc.send('fnmusic:set-audio-device', { deviceId: s.audioDeviceId || '' });
  wc.send('fnmusic:lyrics-enabled', { enabled: Boolean(s.showDesktopLyrics) });
}

module.exports = { register, openSettingsWindow };
