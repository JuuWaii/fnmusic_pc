'use strict';
/**
 * 注入到「飞牛音乐网页」所在会话的隔离世界 preload（仅客户端运行时注入，不改动网页源码）
 *
 * 职责（与主世界脚本 guest-mainworld.js 分工）：
 * 1. 音频输出设备（需求 4）——媒体元素路径
 *    - 周期性 + MutationObserver（rAF 去抖）扫描页面 <audio>/<video> 元素（含 Shadow DOM、
 *      iframe，preload 在会话内所有 frame 生效），调用 setSinkId 定向输出；
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
let lyricsEnabled = false;      // 桌面歌词开关
let stateTimer = null;          // 播放进度上报定时器
const appliedMedia = new WeakMap();    // el -> 已应用的 deviceId（WeakMap 自动回收，防泄漏）
let lastLyricsHash = '';        // 歌词去重哈希

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

  // 2) 主进程指令：桌面歌词开关（控制进度上报）
  ipcRenderer.on('fnmusic:lyrics-enabled', (_event, payload) => {
    const enabled = Boolean(payload && payload.enabled);
    if (enabled === lyricsEnabled) return;
    lyricsEnabled = enabled;
    if (lyricsEnabled) startStateTimer(); else stopStateTimer();
  });

  // 3) 主世界 → 本世界 → 主进程 的歌词桥
  window.addEventListener('message', (e) => {
    if (!e || e.source !== window) return; // 仅接受本窗口消息，防 iframe 伪造
    const d = e && e.data;
    if (!d || typeof d !== 'object') return;
    const l = d.__fnmusicLyrics;
    if (l && typeof l.lrc === 'string' && l.lrc.length > 0) {
      reportLyrics([{ track: typeof l.track === 'string' ? l.track : '', lrc: l.lrc }]);
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
        () => appliedMedia.set(el, targetDeviceId),
        () => { if (!targetDeviceId) appliedMedia.set(el, ''); }
      );
    } else {
      appliedMedia.set(el, targetDeviceId);
    }
  } catch {
    // 罕见：空 id 在某些实现上抛错——标记为"已应用"避免反复重试刷屏
    if (!targetDeviceId) appliedMedia.set(el, '');
  }
}

/** 对当前页面所有媒体元素应用输出设备 */
function applyToAllMedia() {
  for (const el of findMediaElements(document)) applyToMediaElement(el);
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