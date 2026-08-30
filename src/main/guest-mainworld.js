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

    /* ---- 诊断统计（供主进程 /app:diagnose-audio 读取） ---- */
    const diag = {
      injected: true,
      sinkId: '',
      contexts: 0,
      elements: 0,
      iframes: 0,
      audioContextPatched: false,
      fetchHooked: false,
      xhrHooked: false,
      sinkResults: [], // 最近 20 条 setSinkId 结果
    };
    function diagPush(kind, ok, detail) {
      diag.sinkResults.push({ t: Date.now(), kind, ok, detail: String(detail || '').slice(0, 200) });
      if (diag.sinkResults.length > 20) diag.sinkResults.shift();
    }

    /* ---- 1. 音频输出设备 ---- */

    /** 对主文档媒体元素应用输出设备 */
    function applySinkToElements() {
      try {
        const els = document.querySelectorAll('audio, video');
        diag.elements = els.length;
        for (const el of els) {
          if (typeof el.setSinkId !== 'function') continue;
          if (el.__fnSinkApplied === sinkId) continue;
          el.__fnSinkApplied = sinkId;
          try {
            const p = el.setSinkId(sinkId);
            if (p && typeof p.then === 'function') {
              p.then(() => diagPush('element:' + (el.tagName || '?'), true, 'sink=' + sinkId))
               .catch((err) => { el.__fnSinkApplied = undefined; diagPush('element:' + (el.tagName || '?'), false, err && err.message || err); });
            } else {
              diagPush('element:' + (el.tagName || '?'), true, 'sink=' + sinkId + ' (sync)');
            }
          } catch (err) {
            el.__fnSinkApplied = undefined;
            diagPush('element', false, err && err.message || err);
          }
        }
      } catch { /* 页面未就绪等，忽略 */ }
    }

    // 已创建的 AudioContext 登记表（设备切换时一并重定向）
    const liveContexts = [];

    /**
     * 创建 AudioContext 的补丁构造器：
     * - 首选：构造期直接传入 sinkId 选项（Chromium 110+/Electron 33+ 支持，
     *   创建即定向输出，无竞态、不打断播放）——审查轮 A P6；
     * - 兜底：构造抛错（如 sinkId 不被支持）时回退普通构造 + setTimeout(0) 补应用。
     */
    const OrigAC = window.AudioContext || window.webkitAudioContext;
    if (OrigAC && !OrigAC.__fnSinkPatched) {
      const PatchedAC = function () {
        let ctx = null;
        if (sinkId) {
          try {
            const opts = arguments.length && arguments[0] && typeof arguments[0] === 'object'
              ? Object.assign({}, arguments[0])
              : {};
            opts.sinkId = sinkId;
            ctx = new OrigAC(opts);
          } catch (err) {
            diagPush('audio-context-new', false, 'sinkId 构造失败，回退: ' + (err && err.message || err));
            ctx = null;
          }
        }
        if (!ctx) {
          try {
            ctx = new OrigAC(...arguments);
          } catch (err) {
            diagPush('audio-context-new', false, '构造失败: ' + (err && err.message || err));
            throw err; // 与原生行为一致：构造失败向上抛
          }
        }
        liveContexts.push(ctx);
        diag.contexts = liveContexts.length;
        if (!sinkId || ctx.sinkId !== sinkId) {
          // 构造期未生效（无设备/不支持/已运行）：延后一帧补应用
          setTimeout(() => {
            if (sinkId) applySinkToContext(ctx);
          }, 0);
        }
        return ctx;
      };
      PatchedAC.prototype = OrigAC.prototype;
      try { Object.defineProperty(PatchedAC, 'name', { value: 'AudioContext' }); } catch { /* 忽略 */ }
      PatchedAC.__fnSinkPatched = true;
      window.AudioContext = PatchedAC;
      if (window.webkitAudioContext) window.webkitAudioContext = PatchedAC;
      diag.audioContextPatched = true;
    }

    /**
     * 对单个 AudioContext 应用输出设备（审查轮 A P2/P3/P4/P5 修复）：
     * - 已知限制：Chromium 对「正在播放」的 AudioContext 直接 setSinkId 返回成功
     *   但输出流不重建（WPT 状态转换测试印证），需 suspend → setSinkId → resume
     *   强制重路由（毫秒级中断）；
     * - P2：所有调用路径包 try/catch，suspend 成功后才进入切换，任何异常都保证
     *   恢复播放（不留下永久暂停的静音上下文）；
     * - P3：epoch 串行化——快速连续切换时只有最新一次切换生效；
     * - P4：closed 上下文从登记表移除，防内存增长；
     * - P5：suspended 上下文用幂等 suspend→setSinkId 并保持 suspended
     *   （不主动 resume，尊重页面暂停意图；生效依赖下次 resume，诊断中标注）。
     */
    function applySinkToContext(ctx) {
      if (!ctx || typeof ctx.setSinkId !== 'function') {
        diagPush('audio-context', false, 'setSinkId 不可用');
        return;
      }
      if (ctx.state === 'closed') {
        // 从登记表移除，避免长期会话内存增长
        const i = liveContexts.indexOf(ctx);
        if (i >= 0) liveContexts.splice(i, 1);
        return;
      }
      // 串行化：本 context 的切换纪元递增，过期链不再执行 setSinkId
      const epoch = (ctx.__fnSinkEpoch = (ctx.__fnSinkEpoch || 0) + 1);

      const doSwitch = (method) => {
        let p = null;
        try {
          p = ctx.setSinkId(sinkId);
        } catch (err) {
          // 同步抛错（空设备 '' 在部分实现上会抛）：记录并跳过
          diagPush('audio-context', false, 'sync error: ' + (err && err.message || err) + ' method=' + method);
          return null;
        }
        return Promise.resolve(p).then(
          () => {
            // 验证真切换：ctx.sinkId 是否等于目标（部分版本需要第二次调用才生效）
            const applied = ctx.sinkId === sinkId;
            diagPush('audio-context', true, 'sink=' + sinkId + ' method=' + method + ' applied=' + applied + ' state=' + ctx.state);
            if (!applied) {
              // 假成功：再试一次（部分 Chromium 版本第二次调用生效）
              try {
                return Promise.resolve(ctx.setSinkId(sinkId)).then(
                  () => diagPush('audio-context', true, 'retry sink=' + sinkId + ' method=' + method),
                  (err) => diagPush('audio-context', false, 'retry failed: ' + (err && err.message || err))
                );
              } catch (err) {
                diagPush('audio-context', false, 'retry sync error: ' + (err && err.message || err));
              }
            }
            return null;
          },
          (err) => {
            diagPush('audio-context', false, (err && err.message || err) + ' method=' + method);
            return null;
          }
        );
      };

      const switchAndResume = () => {
        // epoch 校验：只有最新一次切换允许执行
        if (ctx.__fnSinkEpoch !== epoch) return Promise.resolve();
        const switching = doSwitch('suspend-resume');
        if (!switching) return Promise.resolve(ctx.resume ? ctx.resume().catch(() => {}) : null);
        return switching.then(() => {
          if (ctx.state !== 'closed' && typeof ctx.resume === 'function') {
            return ctx.resume().catch((err) => diagPush('audio-context', false, 'resume failed: ' + (err && err.message || err)));
          }
          return null;
        });
      };

      if (ctx.state === 'running' && typeof ctx.suspend === 'function') {
        // 正在播放：suspend → setSinkId → resume（suspend 失败退化为直接切换）
        let suspended = false;
        ctx.suspend()
          .then(() => { suspended = true; })
          .catch((err) => {
            diagPush('audio-context', false, 'suspend failed, direct switch: ' + (err && err.message || err));
            suspended = false;
          })
          .then(() => {
            if (suspended && ctx.__fnSinkEpoch === epoch) {
              return switchAndResume();
            }
            // suspend 失败或已被更新切换取代：直接 setSinkId（不打断播放）
            if (ctx.__fnSinkEpoch === epoch) {
              const p = doSwitch('direct');
              if (p) p.catch(() => {});
            }
            return null;
          })
          .catch((err) => diagPush('audio-context', false, 'switch chain error: ' + (err && err.message || err)));
      } else if (ctx.state === 'suspended') {
        // 已暂停：幂等 suspend→setSinkId，保持 suspended（生效依赖下次 resume）
        if (typeof ctx.suspend === 'function') {
          ctx.suspend().catch(() => {}).then(() => {
            if (ctx.__fnSinkEpoch === epoch) {
              const p = doSwitch('suspended');
              if (p) p.catch(() => {});
            }
          });
        } else {
          const p = doSwitch('suspended-direct');
          if (p) p.catch(() => {});
        }
      } else {
        // 其他状态（interrupted/unknown）：直接切换
        const p = doSwitch('direct');
        if (p) p.catch(() => {});
      }
    }

    // 对已创建的 AudioContext 重定向（设备切换）
    function applySinkToContexts() {
      for (const ctx of liveContexts) applySinkToContext(ctx);
    }

    // 接收隔离世界转发的设备切换指令
    window.addEventListener('message', (e) => {
      if (!e || e.source !== window) return; // 仅接受本窗口消息，防 iframe 伪造
      const d = e && e.data;
      if (!d || typeof d !== 'object') return;
      if (d.__fnmusicSetSink && typeof d.__fnmusicSetSink.deviceId === 'string') {
        sinkId = d.__fnmusicSetSink.deviceId;
        diag.sinkId = sinkId;
        diagPush('switch', true, 'device=' + sinkId);
        applySinkToElements();
        applySinkToContexts();
      }
    });

    // 主进程诊断读取接口
    window.__fnmusicDiagnose = () => {
      diag.iframes = document.querySelectorAll('iframe').length;
      diag.sinkId = sinkId;
      diag.contexts = liveContexts.length;
      diag.contextStates = liveContexts.map((c) => c && c.state ? c.state : 'unknown');
      return diag;
    };
    // 立即设置初始设备（注入后由主进程回放当前设置）
    window.__fnmusicSetSinkNow = (deviceId) => {
      if (typeof deviceId === 'string') {
        sinkId = deviceId;
        diag.sinkId = deviceId;
        applySinkToElements();
        applySinkToContexts();
      }
    };

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
      diag.fetchHooked = true;
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
      diag.xhrHooked = true;
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