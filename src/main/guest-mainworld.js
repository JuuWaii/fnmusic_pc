'use strict';
/**
 * 主世界注入脚本（guest-mainworld.js）
 *
 * 由主进程在网页 dom-ready 后通过 webContents.executeJavaScript 注入到
 * **页面主世界**执行——隔离世界无法影响页面主世界的 AudioContext / fetch / XHR，
 * 因此必须在主世界安装这些钩子：
 *
 * 1. AudioContext 定向输出：代理 window.AudioContext，新创建的音频上下文
 *    自动调用 setSinkId 输出到所选设备（Chromium 110+ / Electron 33+）；
 * 2. 媒体元素兜底：对主文档中的 <audio>/<video> 应用 setSinkId；
 * 3. 歌词捕获：钩住 fetch / XHR，按 URL 关键字预过滤后嗅探 JSON 响应中的
 *    LRC 歌词，通过 window.postMessage 交给隔离世界 preload 转发主进程。
 *
 * 设计约束：
 * - 本脚本不向页面暴露任何能力，不读取本地资源；页面篡改钩子仅导致
 *   歌词捕获/设备定向失效（尽力而为），不影响安全边界；
 * - 无网络请求（歌词数据只在页面内 postMessage，由主进程 IPC 限额接收）。
 *
 * 注意：本文件既会被 executeJavaScript 作为脚本执行（浏览器环境），
 * 也可被 Node 直接 require（单元测试，导出纯函数），两处入口互不干扰。
 */

/** 递归扫描 JSON 对象，寻找 LRC 歌词字段（返回 [{track, lrc}]） */
function scanForLyrics(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const results = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 10) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (typeof v === 'string' && /^(lyric|lyrics|lrc|songlyric|song_lyric|lyricText)$/i.test(key)) {
        if (v.length >= 10 && v.includes('[') && v.includes(']')) {
          results.push({ track: '', lrc: v });
          break;
        }
      }
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(obj, 0);

  // 歌名补全（整棵树查找 title 类字段，限深）
  if (results.length) {
    let track = '';
    const seen2 = new Set();
    const findName = (node, depth) => {
      if (!node || typeof node !== 'object' || seen2.has(node) || depth > 6 || track) return;
      seen2.add(node);
      if (Array.isArray(node)) { for (const item of node) findName(item, depth + 1); return; }
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (typeof v === 'string' && /^(title|songName|songname|trackName|name)$/i.test(key) && v.length < 120) {
          track = v;
          return;
        }
        if (v && typeof v === 'object') findName(v, depth + 1);
      }
    };
    findName(obj, 0);
    for (const r of results) r.track = track;
  }
  return results.length ? results : null;
}

/* ---------------- 主世界执行入口（仅浏览器环境） ---------------- */
if (typeof window !== 'undefined') {
  (function mainWorldInit() {
    if (window.__fnmusicMainworld) return;
    window.__fnmusicMainworld = true;

    let sinkId = ''; // 当前目标音频输出设备

    /* ---- 1. 音频输出设备 ---- */

    /** 对主文档媒体元素应用输出设备 */
    function applySinkToElements() {
      try {
        const els = document.querySelectorAll('audio, video');
        for (const el of els) {
          if (typeof el.setSinkId !== 'function') continue;
          if (el.__fnSinkApplied === sinkId) continue;
          el.__fnSinkApplied = sinkId;
          try {
            const p = el.setSinkId(sinkId);
            if (p && typeof p.then === 'function') p.catch(() => { el.__fnSinkApplied = undefined; });
          } catch { el.__fnSinkApplied = undefined; }
        }
      } catch { /* 页面未就绪等，忽略 */ }
    }

    // 已创建的 AudioContext 登记表（设备切换时一并重定向）
    const liveContexts = [];

    // 代理 AudioContext：新上下文自动定向输出
    const OrigAC = window.AudioContext || window.webkitAudioContext;
    if (OrigAC && !OrigAC.__fnSinkPatched) {
      const PatchedAC = function () {
        const ctx = new OrigAC(...arguments);
        liveContexts.push(ctx);
        setTimeout(() => {
          if (ctx.setSinkId && sinkId) {
            ctx.setSinkId(sinkId).catch(() => {});
          }
        }, 0);
        return ctx;
      };
      PatchedAC.prototype = OrigAC.prototype;
      try { Object.defineProperty(PatchedAC, 'name', { value: 'AudioContext' }); } catch { /* 忽略 */ }
      PatchedAC.__fnSinkPatched = true;
      window.AudioContext = PatchedAC;
      if (window.webkitAudioContext) window.webkitAudioContext = PatchedAC;
    }

    // 对已创建的 AudioContext 重定向（设备切换）
    function applySinkToContexts() {
      for (const ctx of liveContexts) {
        if (ctx && ctx.setSinkId) {
          ctx.setSinkId(sinkId).catch(() => {});
        }
      }
    }

    // 接收隔离世界转发的设备切换指令
    window.addEventListener('message', (e) => {
      if (!e || e.source !== window) return; // 仅接受本窗口消息，防 iframe 伪造
      const d = e && e.data;
      if (!d || typeof d !== 'object') return;
      if (d.__fnmusicSetSink && typeof d.__fnmusicSetSink.deviceId === 'string') {
        sinkId = d.__fnmusicSetSink.deviceId;
        applySinkToElements();
        applySinkToContexts();
      }
    });

    // 动态创建的媒体元素（rAF 去抖）
    if (typeof MutationObserver !== 'undefined') {
      let scheduled = false;
      new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; applySinkToElements(); });
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
    applySinkToElements();

    /* ---- 2. 歌词捕获（fetch / XHR 嗅探） ---- */

    let lastLyricHash = '';

    function reportLyrics(found) {
      for (const item of found) {
        const hash = item.lrc.length + ':' + item.lrc.slice(0, 200);
        if (hash === lastLyricHash) continue;
        lastLyricHash = hash;
        window.postMessage({ __fnmusicLyrics: { track: item.track || '', lrc: item.lrc } }, '*');
      }
    }

    // 疑似歌词接口的 URL 关键字（先过滤再解析，避免嗅探所有响应）
    const LYRIC_URL_HINT = /(lyric|lrc|song|track|music|audio)/i;
    const MAX_RESPONSE = 5 * 1024 * 1024; // 超过 5MB 的响应跳过

    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        try {
          const url = String(args[0] && typeof args[0] === 'object' ? args[0].url : args[0]);
          if (!LYRIC_URL_HINT.test(url)) return p;
        } catch { return p; }
        p.then((resp) => {
          try {
            const ct = resp && resp.headers ? (resp.headers.get('content-type') || '') : '';
            if (!ct.includes('json')) return;
            const len = resp.headers.get('content-length');
            if (len && Number(len) > MAX_RESPONSE) return;
            resp.clone().json().then((data) => {
              const found = scanForLyrics(data);
              if (found) reportLyrics(found);
            }).catch(() => {});
          } catch { /* 忽略 */ }
        }).catch(() => {});
        return p;
      };
    }

    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__fnmusicUrl = String(url || '');
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function (...args) {
        const self = this;
        if (LYRIC_URL_HINT.test(self.__fnmusicUrl || '')) {
          this.addEventListener('load', () => {
            try {
              if (self.status !== 200) return;
              const ct = String(self.getResponseHeader('content-type') || '');
              if (!ct.includes('json')) return;
              let text = null;
              if (self.responseType === 'json' && self.response) {
                text = JSON.stringify(self.response);
              } else if (typeof self.responseText === 'string') {
                text = self.responseText;
              }
              if (!text || text.length > MAX_RESPONSE) return;
              const found = scanForLyrics(JSON.parse(text));
              if (found) reportLyrics(found);
            } catch { /* 忽略 */ }
          });
        }
        return origSend.apply(this, args);
      };
    }
  })();
}

/* ---------------- 单元测试导出（仅 Node 环境） ---------------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scanForLyrics };
}