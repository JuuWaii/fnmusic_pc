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
      if (typeof v === 'string' && /^(lyric|lyrics|lrc|songlyric|song_lyric|lyricText|lyricContent|lyricTxt|lrcText|lyric_text|lyrics_text|musicLyric)$/i.test(key)) {
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

    // 错误记录（诊断用）：注入脚本各分段失败时记录，保证诊断接口始终可用
    const initErrors = [];

    let sinkId = ''; // 当前目标音频输出设备
    let volume = 1;    // 当前音量（0~1，作用于页面播放器输出）
    let lyricsEnabled = false; // 桌面歌词开关（主世界侧门控：关闭时不采集/不上报）

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
      wsHooked: false,
      sinkResults: [], // 最近 20 条 setSinkId 结果
      initErrors: initErrors,
      lyricsScanned: 0,
      lyricsHits: 0,
    };

    // 诊断接口提前注册（即使后续安装失败，诊断也能返回注入状态与错误）
    window.__fnmusicDiagnose = () => {
      diag.iframes = document.querySelectorAll('iframe').length;
      diag.sinkId = sinkId;
      diag.volume = volume;
      diag.contexts = liveContexts.length;
      diag.contextStates = liveContexts.map((c) => c && c.state ? c.state : 'unknown');
      return diag;
    };
    diag.domLyricHits = 0;
    window.__fnmusicSetSinkNow = (deviceId) => {
      if (typeof deviceId === 'string') {
        sinkId = deviceId;
        diag.sinkId = deviceId;
        applySinkToElements();
        applySinkToContexts();
      }
    };
    window.__fnmusicSetVolume = (v) => {
      volume = Math.min(1, Math.max(0, Number(v) || 0));
      applyVolume();
      return volume;
    };
    const safeRun = (name, fn) => {
      try { fn(); } catch (err) {
        const msg = name + ': ' + (err && err.message || err);
        initErrors.push(msg.slice(0, 200));
        if (initErrors.length > 10) initErrors.shift();
      }
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
    safeRun('audio-patch', () => {
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
        patchMasterGain(ctx);
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
    }); // safeRun audio-patch

    /**
     * 为 AudioContext 挂载「主音量增益节点」。
     *
     * 原理：页面播放器（WebAudio）把音频节点 connect 到 ctx.destination；
     * 我们在实例上覆盖 destination getter 返回一个 GainNode（master gain），
     * 并把它 connect 到真正的 destination。此后页面所有音频都经过该增益节点，
     * 客户端即可统一控制音量（音量滑块同步网页播放器输出）。
     * 兼容性：仅影响 connect 目标（GainNode 具备 destination 的常用方法），
     * 对页面逻辑无其他影响。
     */
    function patchMasterGain(ctx) {
      try {
        if (!ctx || ctx.__fnMasterGain) return;
        if (typeof ctx.createGain !== 'function' || !ctx.destination) return;
        const realDest = ctx.destination;
        const master = ctx.createGain();
        master.gain.value = volume;
        master.connect(realDest);
        Object.defineProperty(ctx, 'destination', {
          configurable: true,
          enumerable: false,
          get: () => master,
        });
        // M2 防护：页面若对 destination 调用 disconnect()（常见"清空输出"逻辑），
        // 会把 master 与真实输出的连接切断导致无声——拦截并自动重连。
        try {
          const origDisconnect = master.disconnect && master.disconnect.bind(master);
          if (origDisconnect) {
            master.disconnect = function (...disArgs) {
              origDisconnect(...disArgs);
              try { master.connect(realDest); } catch { /* 已连接则忽略 */ }
            };
          }
        } catch { /* 忽略 */ }
        ctx.__fnMasterGain = master;
        diag.masterGains = (diag.masterGains || 0) + 1;
      } catch { /* 不支持时静默跳过（音量控制降级） */ }
    }

    /** 应用音量到全部音频上下文与媒体元素 */
    function applyVolume() {
      for (const ctx of liveContexts) {
        if (ctx.__fnMasterGain && ctx.__fnMasterGain.gain) {
          try { ctx.__fnMasterGain.gain.value = volume; } catch { /* 忽略 */ }
        }
      }
      try {
        document.querySelectorAll('audio, video').forEach((el) => {
          try { el.volume = volume; } catch { /* 忽略 */ }
        });
      } catch { /* 忽略 */ }
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

    // 接收隔离世界转发的指令（设备/音量/歌词开关）
    safeRun('message-bridge', () => {
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
        if (d.__fnmusicSetVolume && typeof d.__fnmusicSetVolume.value === 'number') {
          window.__fnmusicSetVolume(d.__fnmusicSetVolume.value);
        }
        if (d.__fnmusicLyricsEnabled && typeof d.__fnmusicLyricsEnabled.enabled === 'boolean') {
          lyricsEnabled = d.__fnmusicLyricsEnabled.enabled;
          diag.lyricsEnabled = lyricsEnabled;
        }
      });
    });

    // WebAudio 播放进度上报（歌词时间轴；媒体元素路径由隔离世界 preload 上报）
    safeRun('time-report', () => {
      setInterval(() => {
        if (!lyricsEnabled) return; // 歌词关闭时不采集（审查轮 F1 门控）
        if (!liveContexts.length) return;
        let playing = null;
        for (const ctx of liveContexts) {
          if (ctx.state === 'running') { playing = ctx; break; }
        }
        if (!playing) return; // 无正在播放的上下文时不打扰主进程
        window.postMessage({
          __fnmusicAudioState: {
            playing: true,
            currentTime: typeof playing.currentTime === 'number' ? playing.currentTime : 0,
            duration: 0, // WebAudio 无总时长概念，交由歌词窗口按行推进
            paused: false,
            title: document.title || '',
          },
        }, '*');
      }, 1000);
    });

    // 动态创建的媒体元素（rAF 去抖）
    safeRun('media-observe', () => {
    if (typeof MutationObserver !== 'undefined') {
      let scheduled = false;
      new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; applySinkToElements(); });
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
    applySinkToElements();
    }); // safeRun media-observe

    /* ---- 2. 歌词捕获（fetch / XHR 嗅探） ---- */

    let lastLyricHash = '';

    function reportLyrics(found) {
      for (const item of found) {
        const hash = item.lrc.length + ':' + item.lrc.slice(0, 200);
        if (hash === lastLyricHash) continue;
        lastLyricHash = hash;
        diag.lyricsHits++;
        window.postMessage({ __fnmusicLyrics: { track: item.track || '', lrc: item.lrc } }, '*');
      }
    }

    // 歌词捕获统计（诊断用）
    diag.lyricsScanned = 0;
    diag.lyricsHits = 0;

    const MAX_RESPONSE = 5 * 1024 * 1024; // 超过 5MB 的响应跳过

    /**
     * 对 JSON 对象做歌词嗅探并上报（去重）。
     * 不再按 URL 关键字过滤：飞牛歌词接口路径未知，放宽到全部 JSON 响应
     * （大小与扫描预算已在 scanForLyrics 内限制，性能可控）。
     */
    function sniffJson(data) {
      if (!data || typeof data !== 'object') return;
      const found = scanForLyrics(data);
      if (found) reportLyrics(found);
    }

    safeRun('lyrics-hooks', () => {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      diag.fetchHooked = true;
      window.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        p.then((resp) => {
          try {
            const ct = resp && resp.headers ? (resp.headers.get('content-type') || '') : '';
            if (!ct.includes('json')) return;
            const len = resp.headers.get('content-length');
            if (len && Number(len) > MAX_RESPONSE) return;
            // 无 content-length 头（chunked）时用文本长度预检（审查轮 B5）
            resp.clone().text().then((text) => {
              if (!text || text.length > MAX_RESPONSE) return;
              diag.lyricsScanned++;
              sniffJson(JSON.parse(text));
            }).catch(() => {});
          } catch { /* 忽略 */ }
        }).catch(() => {});
        return p;
      };
    }

    // WebSocket 消息钩子（歌词可能走 WS 通道；审查轮 H1 修复）
    const OrigWS = window.WebSocket;
    if (OrigWS && OrigWS.prototype && typeof OrigWS.prototype.addEventListener === 'function') {
      diag.wsHooked = true;
      // 原始 listener -> 包装 listener 的双向映射（保证 removeEventListener 可用、once 生效）
      const wsWrapMap = new WeakMap();
      const origAddEventListener = OrigWS.prototype.addEventListener;
      const origRemoveEventListener = OrigWS.prototype.removeEventListener;

      const wrapWsListener = function (listener) {
        if (typeof listener !== 'function' || wsWrapMap.has(listener)) return listener;
        const wrapped = function (event) {
          try {
            const data = event && event.data;
            if (typeof data === 'string' && data.length < MAX_RESPONSE) {
              const obj = JSON.parse(data);
              diag.lyricsScanned++;
              sniffJson(obj);
            } else if (event && event.data && typeof event.data.arrayBuffer === 'function') {
              // 二进制帧：尝试按 UTF-8 解码后嗅探（受限，仅小帧）
              event.data.arrayBuffer().then((buf) => {
                try {
                  if (buf && buf.byteLength && buf.byteLength < 512 * 1024) {
                    const text = new TextDecoder().decode(buf);
                    if (text && text.length < MAX_RESPONSE) {
                      const obj = JSON.parse(text);
                      diag.lyricsScanned++;
                      sniffJson(obj);
                    }
                  }
                } catch { /* 非 JSON 忽略 */ }
              }).catch(() => {});
            }
          } catch { /* 非 JSON 消息忽略 */ }
          return listener.apply(this, arguments);
        };
        wsWrapMap.set(listener, wrapped);
        return wrapped;
      };

      OrigWS.prototype.addEventListener = function (type, listener, options) {
        if (type === 'message') {
          listener = wrapWsListener(listener);
        }
        // 透传第三个参数（once/capture/AbortSignal）
        return origAddEventListener.call(this, type, listener, options);
      };
      OrigWS.prototype.removeEventListener = function (type, listener) {
        if (type === 'message' && wsWrapMap.has(listener)) {
          listener = wsWrapMap.get(listener);
        }
        return origRemoveEventListener.call(this, type, listener);
      };

      // 钩住 onmessage 属性赋值路径
      try {
        const desc = Object.getOwnPropertyDescriptor(OrigWS.prototype, 'onmessage');
        if (desc && desc.set) {
          const origSet = desc.set;
          desc.set = function (fn) {
            if (typeof fn === 'function') {
              const wrapped = function (event) {
                // 复用与 addEventListener 相同的处理逻辑：直接调用包装函数体
                try {
                  const data = event && event.data;
                  if (typeof data === 'string' && data.length < MAX_RESPONSE) {
                    const obj = JSON.parse(data);
                    diag.lyricsScanned++;
                    sniffJson(obj);
                  }
                } catch { /* 忽略 */ }
                return fn.apply(this, arguments);
              };
              return origSet.call(this, wrapped);
            }
            return origSet.call(this, fn);
          };
          Object.defineProperty(OrigWS.prototype, 'onmessage', desc);
        }
      } catch { /* 属性不可写时跳过（不影响其他钩子） */ }
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
        // 全量嗅探（与 fetch 一致，不再按 URL 关键字过滤；审查轮 C1 修复）
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
            diag.lyricsScanned++;
            sniffJson(JSON.parse(text));
          } catch { /* 忽略 */ }
        });
        return origSend.apply(this, args);
      };
    }

    // DOM 歌词兜底捕获（独立 safeRun 段；接口嗅探未命中时的第二通道）。
    // 审查轮 B/C 修复：当前行优先（active/cur 特征）、排除控件节点、可见性校验、
    // 歌词开关门控（关闭时零采集）。
    safeRun('dom-lyric', () => {
      let lastDomLyricText = '';
      let observer = null;
      let pollTimer = null;

      const DOM_LYRIC_SELECTOR = [
        '[class*="lyric"]:not([class*="btn"]):not([class*="switch"]):not([class*="icon"]):not([class*="button"]):not([class*="search"]):not([class*="setting"]):not([class*="tip"])',
        '[id*="lyric"]:not([id*="btn"]):not([id*="icon"]):not([id*="button"]):not([id*="search"])',
        '[class*="lrc"]:not([class*="btn"]):not([class*="icon"]):not([class*="button"])',
        '[aria-label*="歌词"]',
      ].join(',');

      // 判定一个节点是否像"歌词当前行"：可见 + 短文本 + 非控件
      const isVisible = (node) => {
        try {
          if (!node.offsetParent && node.getClientRects) {
            return node.getClientRects().length > 0 || node.offsetParent !== null;
          }
          return node.offsetParent !== null;
        } catch { return false; }
      };
      const looksLikeLyricLine = (node) => {
        if (!node || typeof node.innerText !== 'string') return false;
        const text = node.innerText.trim();
        if (text.length < 2 || text.length > 120) return false;
        if (text.includes('\n')) return false;
        if (/^(歌词|翻译|查看|关闭|开启)$/.test(text)) return false; // 控件标签
        return true;
      };

      const readDomLyric = () => {
        try {
          let best = null;
          const nodes = document.querySelectorAll(DOM_LYRIC_SELECTOR);
          for (const node of nodes) {
            // 跳过控件与隐藏节点
            if (node.closest && node.closest('button, input, textarea, [role="textbox"], [contenteditable]')) continue;
            if (!isVisible(node)) continue;
            if (!looksLikeLyricLine(node)) continue;
            // 当前行优先：class 含 active/cur/current/hl
            const cls = (typeof node.className === 'string' ? node.className : '') + ' ' + (node.id || '');
            const score = /(active|current|cur|hl|highlight)/i.test(cls) ? 2 : 1;
            if (!best || score > best.score) best = { node, text: node.innerText.trim(), score };
          }
          if (best) {
            if (best.text !== lastDomLyricText) {
              lastDomLyricText = best.text;
              diag.domLyricHits = (diag.domLyricHits || 0) + 1;
              window.postMessage({ __fnmusicDomLyric: { text: best.text } }, '*');
            }
          }
        } catch { /* 页面结构变化，忽略 */ }
      };

      const stopCapture = () => {
        if (observer) { try { observer.disconnect(); } catch { /* 忽略 */ } observer = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      };
      const startCapture = () => {
        if (!lyricsEnabled) return;
        if (!observer && typeof MutationObserver !== 'undefined') {
          let scheduled = false;
          observer = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; readDomLyric(); });
          });
          try {
            observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
          } catch { /* 忽略 */ }
        }
        if (!pollTimer) pollTimer = setInterval(readDomLyric, 2000);
        readDomLyric();
      };

      // 歌词开关切换时启停采集（关闭桌面歌词时零 DOM 采集——审查轮 F1）
      const origListener = window.addEventListener.bind(window);
      window.addEventListener('message', (e) => {
        const d = e && e.data;
        if (!d || typeof d !== 'object') return;
        if (d.__fnmusicLyricsEnabled) {
          if (lyricsEnabled) startCapture(); else stopCapture();
        }
      });

      // 初始状态由主进程回放（replaySettingsToGuest 转发）；先按当前值启动
      if (lyricsEnabled) startCapture();
    });

    }); // 关闭 safeRun('lyrics-hooks', ...)
  })(); // 关闭并执行 mainWorldInit
}

/* ---------------- 单元测试导出（仅 Node 环境） ---------------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scanForLyrics };
}