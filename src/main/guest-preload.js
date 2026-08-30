'use strict';
/**
 * 注入到「飞牛音乐网页」所在会话的隔离世界 preload（仅客户端运行时注入，不改动网页源码）
 *
 * 职责（与主世界脚本 guest-mainworld.js 分工）：
 * 1. 音频输出设备（需求 4）——媒体元素路径
 *    - 周期性 + MutationObserver（rAF 去抖）扫描页面 <audio>/<video> 元素（含 Shadow DOM），
 *      调用 setSinkId 定向输出；
 *    - 按「元素 ↔ 已应用设备」记账（WeakMap），设备切换后立即对既有元素重新应用；
 *    - 注意：本 preload 默认只在主 frame 运行（nodeIntegrationInSubFrames=false）；
 *      iframe 内的重定向由主进程对各 frame 直接广播 __fnmusicSetSinkNow 完成（见 audio-devices.js）；
 *    - AudioContext 路径由主世界脚本处理（隔离世界无法影响页面主世界的 AudioContext）。
 * 2. 音量控制（媒体元素路径）：仅在主进程显式指令时应用一次（不覆盖页面自身音量控件）；
 *    主世界 master gain 路径负责 WebAudio 音量。
 * 3. 与主世界脚本的消息桥（window.postMessage）：转发设备切换与音量指令。
 *
 * 安全说明：本脚本运行在隔离世界，不向网页暴露任何能力；不采集页面数据。
 */
const { ipcRenderer } = require('electron');

// 仅处理 http/https 页面（本地 file:// 页面直接跳过）
if (/^https?:$/.test(window.location.protocol)) {
  initGuest();
}

/** 全局状态 */
let targetDeviceId = '';        // 当前目标音频输出设备 id（'' = 跟随系统）
let targetVolume = 1;           // 目标音量（0~1，应用于媒体元素）
const appliedMedia = new WeakMap(); // el -> 已应用的 deviceId（WeakMap 自动回收，防泄漏）

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

  // 2) 主进程指令：音量（媒体元素路径 + 转发主世界）
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

  // 3) 周期扫描（兜底）+ MutationObserver（rAF 去抖，避免高频 DOM 变更触发全树扫描）
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
          logSinkResult(el.tagName || '?', true, 'sink=' + targetDeviceId);
        },
        (err) => {
          if (!targetDeviceId) appliedMedia.set(el, '');
          logSinkResult(el.tagName || '?', false, err && err.message || err);
        }
      );
    } else {
      appliedMedia.set(el, targetDeviceId);
      logSinkResult(el.tagName || '?', true, 'sink=' + targetDeviceId + ' (sync)');
    }
  } catch (err) {
    if (!targetDeviceId) appliedMedia.set(el, '');
    logSinkResult(el.tagName || '?', false, err && err.message || err);
  }
}

/** 记录 setSinkId 结果到主进程日志（诊断用，限频） */
let lastSinkLogTime = 0;
function logSinkResult(kind, ok, detail) {
  const now = Date.now();
  if (now - lastSinkLogTime < 500) return;
  lastSinkLogTime = now;
  ipcRenderer.send('fnmusic:log', 'sink[' + kind + '] ' + (ok ? 'OK' : 'FAIL') + ' ' + detail);
}

/** 对当前页面所有媒体元素应用输出设备 */
function applyToAllMedia() {
  for (const el of findMediaElements(document)) applyToMediaElement(el);
}

/** 应用目标音量到媒体元素（仅在收到显式指令时调用） */
function applyVolumeToMedia() {
  for (const el of findMediaElements(document)) {
    try { el.volume = targetVolume; } catch { /* 忽略 */ }
  }
}
