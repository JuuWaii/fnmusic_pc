'use strict';
/**
 * 桌面歌词（需求 6，可选功能，基础功能之后的第二阶段）
 *
 * 实现思路（不改动网页）：
 * - guest-preload 钩住 fetch/XHR，嗅探网页接口返回的 LRC 歌词并上报（fnmusic:lyrics）；
 * - guest-preload 周期性上报当前播放进度（fnmusic:audio-state）；
 * - 本模块维护「歌词行 + 当前时间」，驱动一个无边框、置顶、可拖动的小窗口显示歌词。
 *
 * 说明：
 * - 歌词数据完全来自飞牛音乐网页自身接口，本应用不抓取、不上传任何数据；
 * - 若网页接口不提供歌词，窗口显示提示文案（属预期行为，功能为「尽力而为」）。
 */
const { BrowserWindow, screen, ipcMain, app } = require('electron');
const path = require('path');
const logger = require('./logger');
const settings = require('./settings');

/** LRC 时间标签正则：[mm:ss.xx] / [mm:ss:xx] / [mm:ss] */
const LRC_TIME_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** 解析 LRC 文本为 {time, text}[]（按时间升序） */
function parseLrc(lrc) {
  if (typeof lrc !== 'string' || !lrc.trim()) return [];
  const lines = [];
  let lastTime = 0;
  for (const raw of lrc.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const matches = [...line.matchAll(LRC_TIME_RE)];
    if (!matches.length) {
      // 无时间标签的纯文本行：沿用上一个时间（LRC 常见做法）
      lines.push({ time: lastTime, text: line });
      continue;
    }
    const text = line.replace(LRC_TIME_RE, '').trim();
    for (const m of matches) {
      const min = parseInt(m[1], 10) || 0;
      const sec = parseInt(m[2], 10) || 0;
      const fracRaw = m[3] ? m[3].padEnd(3, '0') : '000';
      const time = min * 60 + sec + parseInt(fracRaw, 10) / 1000;
      lastTime = time;
      lines.push({ time, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** 二分查找当前时间对应的歌词行下标 */
function indexForTime(lines, time) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/** 歌词模块状态 */
let windowIpcRegistered = false; // 歌词窗口 IPC 只注册一次，防止重复监听
const state = {
  enabled: false,
  interactive: true,   // 窗口是否可交互（false = 点击穿透）
  track: '',
  lines: [],           // 当前歌词行
  currentTime: 0,
  playing: false,
  win: null,
  tickTimer: null,
};

/** 上报歌词（限额：LRC 最大 200KB，歌名最大 200 字符，防止异常来源刷屏/占内存） */
const MAX_LRC_LENGTH = 200 * 1024;
const MAX_TRACK_LENGTH = 200;

function onLyrics(payload) {
  // 无有效载荷/新曲目无歌词：清空旧歌词（避免显示上一首的歌词）
  if (!payload || typeof payload.lrc !== 'string' || payload.lrc.length > MAX_LRC_LENGTH) {
    state.lines = [];
    state.track = '';
    return;
  }
  const lines = parseLrc(payload.lrc);
  if (!lines.length) {
    state.lines = [];
    state.track = payload.track && typeof payload.track === 'string' ? payload.track.slice(0, MAX_TRACK_LENGTH) : '';
    return;
  }
  // 新歌词到达：若载荷未带歌名则清空旧歌名（等待 audio-state 的标题补充）
  state.track = typeof payload.track === 'string' && payload.track
    ? payload.track.slice(0, MAX_TRACK_LENGTH)
    : '';
  state.lines = lines;
}

/** 上报播放进度 */
function onAudioState(payload) {
  if (!payload) return;
  state.currentTime = Number(payload.currentTime) || 0;
  state.playing = Boolean(payload.playing);
  if (typeof payload.title === 'string' && payload.title && !state.track) {
    state.track = payload.title.slice(0, MAX_TRACK_LENGTH);
  }
}

/* ---------------- 窗口管理 ---------------- */

/** 计算歌词窗口默认位置：屏幕右下角，略高于任务栏 */
function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 720;
  const H = 120;
  return { x: wa.x + wa.width - W - 24, y: wa.y + wa.height - H - 24, width: W, height: H };
}

function createWindow() {
  const b = defaultBounds();
  state.win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,       // 不抢键盘焦点，不影响网页操作
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'lyrics-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged, // 生产包禁用开发者工具
    },
  });
  state.win.setAlwaysOnTop(true, 'screen-saver');
  state.win.loadFile(path.join(__dirname, '..', 'renderer', 'lyrics.html'));
  state.win.once('ready-to-show', () => {
    // 仅当歌词仍处于开启状态时显示（避免开关竞态）
    if (state.enabled && state.win && !state.win.isDestroyed()) state.win.showInactive();
  });
  state.win.on('closed', () => {
    state.win = null;
    // 窗口被系统关闭（Alt+F4 等）时同步开关状态，保证再次开启能重建（审查轮 B B12）
    state.enabled = false;
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
  });
  registerWindowIpcOnce();
  return state.win;
}

/** 每 250ms 向歌词窗口推送一次最新歌词与进度 */
function tick() {
  if (!state.win || state.win.isDestroyed()) return;
  const { lines, currentTime } = state;
  const idx = indexForTime(lines, currentTime);
  const cur = idx >= 0 ? lines[idx] : null;
  const next = idx >= 0 && idx + 1 < lines.length ? lines[idx + 1] : null;
  state.win.webContents.send('lyrics:update', {
    track: state.track,
    cur: cur ? cur.text : '',
    next: next ? next.text : '',
    idx,
    total: lines.length,
    hasLyrics: lines.length > 0,
    progress: currentTime,
    playing: state.playing,
  });
}

/** 开启/关闭桌面歌词 */
function setEnabled(enabled) {
  const want = Boolean(enabled);
  if (want === state.enabled) return;
  state.enabled = want;
  if (want) {
    if (!state.win || state.win.isDestroyed()) {
      createWindow();
    } else {
      // 窗口已存在（曾被隐藏）：重新显示
      state.win.showInactive();
    }
    if (!state.tickTimer) state.tickTimer = setInterval(tick, 250);
    logger.info('桌面歌词已开启');
  } else {
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    if (state.win && !state.win.isDestroyed()) state.win.hide();
    logger.info('桌面歌词已关闭');
  }
}

function setOpacity(value) {
  const v = Math.min(1, Math.max(0.3, Number(value) || 0.9));
  settings.update({ lyricsOpacity: v });
  if (state.win && !state.win.isDestroyed()) state.win.setOpacity(v);
}

function setInteractive(interactive) {
  state.interactive = Boolean(interactive);
  if (state.win && !state.win.isDestroyed()) {
    if (state.interactive) {
      state.win.setIgnoreMouseEvents(false);
    } else {
      state.win.setIgnoreMouseEvents(true, { forward: true });
    }
  }
}

/* ---------------- 歌词窗口 IPC（拖动 / 关闭 / 穿透） ---------------- */

/** 校验发送方：必须是本应用歌词窗口页面（纵深防御） */
function isLyricsWindowSender(event) {
  try {
    const url = (event.senderFrame && event.senderFrame.url) || event.sender.getURL();
    return url.startsWith('file://') && url.includes('/renderer/lyrics.html');
  } catch {
    return false;
  }
}

function registerWindowIpcOnce() {
  if (windowIpcRegistered) return;
  windowIpcRegistered = true;
  registerWindowIpc();
}

function registerWindowIpc() {
  // 拖动开始：记录起点（屏幕坐标）
  ipcMain.on('lyrics:drag-start', (e, p) => {
    if (!isLyricsWindowSender(e)) return;
    if (!state.win || state.win.isDestroyed()) return;
    if (!p || typeof p.screenX !== 'number' || typeof p.screenY !== 'number') return;
    state.dragStart = { sx: p.screenX, sy: p.screenY, wx: state.win.getPosition()[0], wy: state.win.getPosition()[1] };
  });
  // 拖动移动：按屏幕坐标差移动窗口
  ipcMain.on('lyrics:drag-move', (e, p) => {
    if (!isLyricsWindowSender(e)) return;
    if (!state.win || state.win.isDestroyed() || !state.dragStart) return;
    if (!p || typeof p.screenX !== 'number' || typeof p.screenY !== 'number') return;
    const dx = p.screenX - state.dragStart.sx;
    const dy = p.screenY - state.dragStart.sy;
    state.win.setPosition(state.dragStart.wx + dx, state.dragStart.wy + dy);
  });
  ipcMain.on('lyrics:drag-end', (e) => { if (isLyricsWindowSender(e)) state.dragStart = null; });
  // 关闭按钮
  ipcMain.on('lyrics:close', (e) => { if (isLyricsWindowSender(e)) setEnabled(false); });
  // 点击穿透切换
  ipcMain.on('lyrics:toggle-interactive', (e) => { if (isLyricsWindowSender(e)) setInteractive(!state.interactive); });
}

/** 应用退出前的清理 */
function dispose() {
  if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
}

module.exports = { onLyrics, onAudioState, setEnabled, setOpacity, setInteractive, dispose, parseLrc, indexForTime };