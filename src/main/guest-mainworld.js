'use strict';
/**
 * 主世界注入脚本（guest-mainworld.js）
 *
 * 由主进程在网页 dom-ready 后通过 WebContentsView 的 frame.executeJavaScript
 * 注入到**页面主世界**执行（覆盖主 frame 与全部子 frame）。职责：
 *
 * 1. 音频输出设备定向：代理 window.AudioContext（构造期 sinkId 选项 +
 *    suspend→setSinkId→resume 序列处理 Chromium 对运行中上下文切换不生效的限制），
 *    对主文档媒体元素应用 setSinkId；
 * 2. 音量控制：为每个 AudioContext 挂载 master gain（覆盖 destination getter），
 *    页面全部音频经过客户端可控增益节点；媒体元素同步设置 volume；
 * 3. 诊断：window.__fnmusicDiagnose 返回注入状态、上下文状态、setSinkId 结果等。
 *
 * 设计约束：
 * - 不向页面暴露任何本地能力；页面篡改钩子仅导致音频定向/音量失效（尽力而为）；
 * - 无网络请求；注入脚本本身不采集任何页面数据（桌面歌词功能已按用户要求移除）。
 *
 * 注意：本文件既会被 executeJavaScript 作为脚本执行（浏览器环境），
 * 也可被 Node 直接 require（单元测试，导出纯函数），两处入口互不干扰。
 */

/* ---------------- 单元测试导出（仅 Node 环境） ---------------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {};
}

/* ---------------- 主世界执行入口（仅浏览器环境） ---------------- */
if (typeof window !== 'undefined') {
  (function mainWorldInit() {
    if (window.__fnmusicMainworld) return;
    window.__fnmusicMainworld = true;

    // 错误记录（诊断用）：各分段失败时记录，保证诊断接口始终可用
    const initErrors = [];

    let sinkId = ''; // 当前目标音频输出设备
    let volume = 1;  // 当前音量（0~1，作用于页面播放器输出）

    /* ---- 诊断统计 ---- */
    const diag = {
      injected: true,
      sinkId: '',
      volume: 1,
      contexts: 0,
      elements: 0,
      iframes: 0,
      audioContextPatched: false,
      masterGains: 0,
      sinkResults: [], // 最近 20 条 setSinkId 结果
      initErrors: initErrors,
      // v0.1.10 新增：mediaDevices 可用性 + 安全上下文（定位「设备枚举失败：
      // mediaDevices API 不可用」——飞牛门户可能把音乐应用渲染在跨域 iframe，
      // iframe 内受 Permissions-Policy 限制时 navigator.mediaDevices 为 undefined）
      mediaDevices: false,
      secureContext: false,
    };

    function diagPush(kind, ok, detail) {
      diag.sinkResults.push({ t: Date.now(), kind, ok, detail: String(detail || '').slice(0, 200) });
      if (diag.sinkResults.length > 20) diag.sinkResults.shift();
    }

    // 诊断接口提前注册（即使后续安装失败，诊断也能返回注入状态与错误）
    window.__fnmusicDiagnose = () => {
      diag.iframes = document.querySelectorAll('iframe').length;
      diag.sinkId = sinkId;
      diag.volume = volume;
      diag.contexts = liveContexts.length;
      diag.contextStates = liveContexts.map((c) => c && c.state ? c.state : 'unknown');
      diag.mediaDevices = typeof navigator !== 'undefined' && !!navigator.mediaDevices
        && typeof navigator.mediaDevices.enumerateDevices === 'function';
      diag.secureContext = typeof window !== 'undefined' && !!window.isSecureContext;
      return diag;
    };
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

    /* ==================== 音频输出设备 ==================== */

    /** 已创建的 AudioContext 登记表 */
    const liveContexts = [];

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

    /**
     * 为 AudioContext 挂载「主音量增益节点」。
     *
     * 原理：页面播放器（WebAudio）把音频节点 connect 到 ctx.destination；
     * 我们在实例上覆盖 destination getter 返回一个 GainNode（master gain），
     * 并把它 connect 到真正的 destination。此后页面所有音频都经过该增益节点，
     * 客户端即可统一控制音量。
     * 兼容性注记（审查轮 M2）：GainNode 具备 destination 常用方法，多数页面无感；
     * instanceof AudioDestinationNode 会为 false、maxChannelCount 为 undefined
     * （依赖这两点的播放器逻辑可能异常，属已知限制）；页面调用 destination.disconnect()
     * 会切断 master→realDest，我们拦截 disconnect 并自动重连。
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
        // disconnect 防护：页面清空输出逻辑不应导致永久静音
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
     * - Chromium 对「正在播放」的 AudioContext 直接 setSinkId 返回成功但输出流不重建，
     *   需 suspend → setSinkId → resume 强制重路由（毫秒级中断）；
     * - 所有调用路径包 try/catch，异常保证恢复播放（不留下永久暂停的静音上下文）；
     * - epoch 串行化：快速连续切换时只有最新一次生效；
     * - closed 上下文从登记表移除，防内存增长；
     * - suspended 上下文用幂等 suspend→setSinkId 并保持 suspended。
     */
    function applySinkToContext(ctx) {
      if (!ctx || typeof ctx.setSinkId !== 'function') {
        diagPush('audio-context', false, 'setSinkId 不可用');
        return;
      }
      if (ctx.state === 'closed') {
        const i = liveContexts.indexOf(ctx);
        if (i >= 0) liveContexts.splice(i, 1);
        return;
      }
      const epoch = (ctx.__fnSinkEpoch = (ctx.__fnSinkEpoch || 0) + 1);

      const doSwitch = (method) => {
        let p = null;
        try {
          p = ctx.setSinkId(sinkId);
        } catch (err) {
          diagPush('audio-context', false, 'sync error: ' + (err && err.message || err) + ' method=' + method);
          return null;
        }
        return Promise.resolve(p).then(
          () => {
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
            if (ctx.__fnSinkEpoch === epoch) {
              const p = doSwitch('direct');
              if (p) p.catch(() => {});
            }
            return null;
          })
          .catch((err) => diagPush('audio-context', false, 'switch chain error: ' + (err && err.message || err)));
      } else if (ctx.state === 'suspended') {
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
        const p = doSwitch('direct');
        if (p) p.catch(() => {});
      }
    }

    /** 对已创建的 AudioContext 重定向（设备切换） */
    function applySinkToContexts() {
      for (const ctx of liveContexts) applySinkToContext(ctx);
    }

    /* ---- 安装（各分段容错，失败互不影响） ---- */

    // AudioContext 代理：构造期 sinkId + master gain
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
              throw err;
            }
          }
          liveContexts.push(ctx);
          diag.contexts = liveContexts.length;
          patchMasterGain(ctx);
          if (!sinkId || ctx.sinkId !== sinkId) {
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
    });

    // 接收隔离世界转发的指令（设备/音量）
    safeRun('message-bridge', () => {
      window.addEventListener('message', (e) => {
        if (!e || e.source !== window) return;
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
      });
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
    });
  })();
}
