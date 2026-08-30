'use strict';
/**
 * 注入到「飞牛音乐网页」所在会话的隔离世界 preload（仅客户端运行时注入，不改动网页源码）
 *
 * 职责（与主世界脚本 guest-mainworld.js 分工）：
 * 1. 音频输出设备（需求 4）——媒体元素路径
 *    - 周期性 + MutationObserver（rAF 去抖）扫描页面 <audio>/<video> 元素（含 Shadow DOM），
 *      调用 setSinkId 定向输出；
 *    - 注意：本 preload 默认只在主 frame 运行（nodeIntegrationInSubFrames=false）；
 *      iframe 内的重定向由主进程对各 frame 直接广播 __fnmusicSetSinkNow 完成（见 audio-devices.js）；
 *    - 按「元素 ↔ 已应用设备」记账（WeakMap），设备切换后立即对既有元素重新应用，
 *      修复早期版本"已标记元素不再重应用"的缺陷；
 *    - AudioContext 路径由主世界脚本处理（隔离世界无法影响页面主世界的 AudioContext）。
 * 2. 与主世界脚本的消息桥（window.postMessage 双向）：
 *    - 把主进程的设备切换指令转发给主世界（AudioContext / 顶层元素）；
 *    - 把主世界嗅探到的歌词转发给主进程（fnmusic:lyrics）。
 * 3. 播放进度上报（歌词窗口驱动）：每 1s 读取播放中媒体元素的时间信息。
 *
 * 安全说明：本脚本运行在隔离世界，不向网页暴露任何能力；歌词数据仅存内存。
 */
const { ipcRenderer } = require('electron');

// 仅处理 http/https 页面（本地 file:// 页面直接跳过）
if (/^https?:$/.test(window.location.protocol)) {
  initGuest();
}

/** 全局状态 */
let targetDeviceId = '';        // 当前目标音频输出设备 id（'' = 跟随系统）
let targetVolume = 1;           // 目标音量（0~1，应用于媒体元素）
let lyricsEnabled = false;      // 桌面歌词开关
let stateTimer = null;          // 播放进度上报定时器
const appliedMedia = new WeakMap();    // el -> 已应用的 deviceId（WeakMap 自动回收，防泄漏）
let lastLyricsHash = '';        // 歌词去重哈希
let lastDomLyricSent = 0;       // DOM 歌词转发节流时间戳

/** 初始化入口 */
function initGuest() {
  // 1) 主进程指令：切换音频输出设备
  ipcRenderer.on('fnmusic:set-audio-device', (_event, payload) => {
    if (payload && typeof payload.deviceId === 'string') {
      targetDeviceId = payload.deviceId;
      applyToAllMedia();
      // 转发给主世界（AudioContext 定向 + 顶层文档元素）
      try { window.postMessage({ __fnmusicSetSink: { deviceId: targetDeviceId } }, '*'); } catch { /* 忽略 */ }
    }
  });

  // 1.5) 主进程指令：音量（媒体元素路径 + 转发主世界）
  // 注意：仅在显式指令时应用一次，绝不周期性强制写回 el.volume——
  // 否则会覆盖页面自身的音量控件（审查轮 B2 修复）。
  ipcRenderer.on('fnmusic:set-volume', (_event, payload) => {
    if (payload && typeof payload.value === 'number' && Number.isFinite(payload.value)) {
      targetVolume = Math.min(1, Math.max(0, payload.value));
      applyVolumeToMedia();
      try {
        window.postMessage({ __fnmusicSetVolume: { value: targetVolume } }, '*');
      } catch { /* 忽略 */ }
    }
  });

  // 2) 主进程指令：桌面歌词开关（控制进度上报 + 转发主世界采集门控）
  ipcRenderer.on('fnmusic:lyrics-enabled', (_event, payload) => {
    const enabled = Boolean(payload && payload.enabled);
    if (enabled === lyricsEnabled) return;
    lyricsEnabled = enabled;
    if (lyricsEnabled) startStateTimer(); else stopStateTimer();
    try {
      window.postMessage({ __fnmusicLyricsEnabled: { enabled } }, '*');
    } catch { /* 忽略 */ }
  });

  // 3) 主世界 → 本世界 → 主进程 的桥（歌词 + WebAudio 播放进度）
  window.addEventListener('message', (e) => {
    if (!e || e.source !== window) return; // 仅接受本窗口消息，防 iframe 伪造
    const d = e && e.data;
    if (!d || typeof d !== 'object') return;
    const l = d.__fnmusicLyrics;
    if (l && typeof l.lrc === 'string' && l.lrc.length > 0) {
      reportLyrics([{ track: typeof l.track === 'string' ? l.track : '', lrc: l.lrc }]);
    }
    // WebAudio 播放器没有媒体元素，进度由主世界脚本上报（歌词时间轴）
    const st = d.__fnmusicAudioState;
    if (st && typeof st.currentTime === 'number') {
      ipcRenderer.send('fnmusic:audio-state', {
        playing: Boolean(st.playing),
        currentTime: st.currentTime,
        duration: typeof st.duration === 'number' ? st.duration : 0,
        paused: Boolean(st.paused),
        title: typeof st.title === 'string' ? st.title : (document.title || ''),
      });
    }
    // DOM 歌词兜底（页面渲染出的当前行文本；长度/频率限额——审查轮 F3）
    const dl = d.__fnmusicDomLyric;
    if (dl && typeof dl.text === 'string' && dl.text.length > 0) {
      const now = Date.now();
      if (dl.text.length <= 200 && now - lastDomLyricSent > 300) {
        lastDomLyricSent = now;
        ipcRenderer.send('fnmusic:dom-lyric', { text: dl.text });
      }
    }
  });

  // 4) 周期扫描（兜底）+ MutationObserver（rAF 去抖，避免高频 DOM 变更触发全树扫描）
  setInterval(applyToAllMedia, 4000);
  if (typeof MutationObserver !== 'undefined') {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; applyToAllMedia(); });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  applyToAllMedia();
}

/* ==================== 音频输出设备（媒体元素路径） ==================== */

/**
 * 查找所有媒体元素（含 Shadow DOM 内部；每次调用对整棵文档做一次查询）
 * 已做遍历预算限制，防止极端页面导致卡顿。
 */
function findMediaElements(root) {
  const found = [];
  const queue = [root];
  let guard = 0;
  while (queue.length && guard < 300) {
    guard++;
    const node = queue.shift();
    let els = [];
    try { els = node.querySelectorAll('audio, video'); } catch { els = []; }
    for (const el of els) found.push(el);
    // 收集后代 shadow host（供下一轮查找）
    let hosts = [];
    try { hosts = node.querySelectorAll('*'); } catch { hosts = []; }
    for (const h of hosts) {
      if (h.shadowRoot && queue.length < 300) queue.push(h.shadowRoot);
    }
    if (node.shadowRoot && queue.length < 300) queue.push(node.shadowRoot);
  }
  return found;
}

/** 对单个媒体元素应用输出设备（按设备记账，设备切换时自动重应用） */
function applyToMediaElement(el) {
  if (!el || typeof el.setSinkId !== 'function') return;
  if (appliedMedia.get(el) === targetDeviceId) return; // 已应用同一设备
  try {
    const p = el.setSinkId(targetDeviceId);
    if (p && typeof p.then === 'function') {
      p.then(
        () => {
          appliedMedia.set(el, targetDeviceId);
          logSinkResult('isolated:' + (el.tagName || '?'), true, 'sink=' + targetDeviceId);
        },
        (err) => {
          if (!targetDeviceId) appliedMedia.set(el, '');
          logSinkResult('isolated:' + (el.tagName || '?'), false, err && err.message || err);
        }
      );
    } else {
      appliedMedia.set(el, targetDeviceId);
      logSinkResult('isolated:' + (el.tagName || '?'), true, 'sink=' + targetDeviceId + ' (sync)');
    }
  } catch (err) {
    // 罕见：空 id 在某些实现上抛错——标记为"已应用"避免反复重试刷屏
    if (!targetDeviceId) appliedMedia.set(el, '');
    logSinkResult('isolated:' + (el.tagName || '?'), false, err && err.message || err);
  }
}

/** 记录 setSinkId 结果到主进程日志（诊断用，限频） */
let lastSinkLogTime = 0;
function logSinkResult(kind, ok, detail) {
  const now = Date.now();
  if (now - lastSinkLogTime < 500) return; // 限频，避免刷屏
  lastSinkLogTime = now;
  ipcRenderer.send('fnmusic:log', 'sink[' + kind + '] ' + (ok ? 'OK' : 'FAIL') + ' ' + detail);
}

/** 对当前页面所有媒体元素应用输出设备 */
function applyToAllMedia() {
  for (const el of findMediaElements(document)) applyToMediaElement(el);
  // 注意：此处不再调用 applyVolumeToMedia（音量仅在显式指令时应用，
  // 避免周期性覆盖页面自身的音量控件——审查轮 B2）
}

/** 应用目标音量到媒体元素（仅在收到显式指令时调用） */
function applyVolumeToMedia() {
  for (const el of findMediaElements(document)) {
    try { el.volume = targetVolume; } catch { /* 忽略 */ }
  }
}

/* ==================== 播放进度上报（歌词窗口驱动） ==================== */

function startStateTimer() {
  if (stateTimer) return;
  stateTimer = setInterval(() => {
    const els = findMediaElements(document);
    let playing = null;
    for (const el of els) {
      if (el instanceof HTMLMediaElement && !el.paused && el.currentTime > 0) { playing = el; break; }
    }
    ipcRenderer.send('fnmusic:audio-state', {
      playing: Boolean(playing),
      currentTime: playing ? playing.currentTime : 0,
      duration: playing && playing.duration ? playing.duration : 0,
      paused: playing ? playing.paused : true,
      title: document.title || '',
    });
  }, 1000);
}

function stopStateTimer() {
  if (stateTimer) { clearInterval(stateTimer); stateTimer = null; }
}

/* ==================== 歌词上报（来自主世界桥） ==================== */

/** 歌词数据去重并上报主进程（不携带页面 URL，避免 URL 中的 token 外泄） */
function reportLyrics(found) {
  for (const item of found) {
    const hash = item.lrc.length + ':' + item.lrc.slice(0, 200);
    if (hash === lastLyricsHash) continue;
    lastLyricsHash = hash;
    ipcRenderer.send('fnmusic:lyrics', { track: item.track || '', lrc: item.lrc });
  }
}