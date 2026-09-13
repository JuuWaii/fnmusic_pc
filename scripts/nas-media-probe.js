'use strict';

/**
 * 在用户已登录的音乐页面验证原始流；不导出 Cookie、不使用网页私有模块。
 * 播放使用独立、静音的 Audio，结束后释放，不更改页面播放队列。
 * 此文件用于协议探查，不能代替 Windows 原生播放器验收。
 */
async function runNasMediaProbe(env) {
  const report = { schemaVersion: 1, stage: 'preflight', completed: false };
  const controller = new AbortController();
  let audio;
  let cleanupSucceeded = true;
  const deadline = setTimeout(() => controller.abort(), env.timeoutMs ?? 25000);
  let page;

  async function json(path) {
    const response = await env.fetch(new URL('/music/api/v1' + path, page.origin).href, {
      credentials: 'same-origin', redirect: 'error', signal: controller.signal
    });
    if (!response.ok) throw new Error('http');
    const body = await response.json();
    if (![0, 200].includes(body?.code)) throw new Error('business');
    return body.data;
  }

  function waitFor(name, action) {
    return new Promise((resolve, reject) => {
      const clean = () => {
        audio.removeEventListener(name, success);
        audio.removeEventListener('error', failure);
        controller.signal.removeEventListener('abort', failure);
      };
      const success = () => { clean(); resolve(); };
      const failure = () => { clean(); reject(new Error('media')); };
      audio.addEventListener(name, success, { once: true });
      audio.addEventListener('error', failure, { once: true });
      controller.signal.addEventListener('abort', failure, { once: true });
      if (controller.signal.aborted) return failure();
      try { action(); } catch { failure(); }
    });
  }

  try {
    page = new URL(env.href);
    if (!['http:', 'https:'].includes(page.protocol) || !page.pathname.startsWith('/music/')) {
      report.reason = 'not-music-page';
      return report;
    }
    report.stage = 'session';
    report.sessionValid = !!(await json('/user/me'));
    if (!report.sessionValid) { report.reason = 'no-session'; return report; }
    report.stage = 'library';
    const library = await json('/track/list?page=1&size=1');
    const guid = library?.list?.[0]?.guid;
    if (typeof guid !== 'string' || !guid || guid.length > 256) {
      report.reason = 'no-track';
      return report;
    }
    report.unsignedLibrarySucceeded = true;
    report.stage = 'metadata';
    const metadata = await json('/track/metadata?guid=' + encodeURIComponent(guid));
    report.unsignedMetadataSucceeded = !!metadata?.track;
    report.stage = 'nonzero-range';
    const stream = new URL('/music/api/v1/track/stream', page.origin);
    stream.searchParams.set('guid', guid);
    const response = await env.fetch(stream.href, {
      credentials: 'same-origin', redirect: 'error', headers: { Range: 'bytes=4096-5119' },
      signal: controller.signal
    });
    report.range = {
      httpStatus: response.status,
      correctOffset: /^bytes 4096-5119\/\d+$/.test(response.headers.get('content-range') || '')
    };
    await response.body?.cancel();
    if (response.status !== 206 || !report.range.correctOffset) {
      report.reason = 'range-contract-mismatch';
      return report;
    }
    report.stage = 'browser-decode';
    audio = env.createAudio();
    audio.muted = true;
    audio.preload = 'auto';
    await waitFor('loadedmetadata', () => {
      audio.src = stream.href;
      audio.load();
      // 启动播放以免后台页面无限推迟 preload；拒绝时主动终止等待。
      void audio.play().catch(() => {
        // loadedmetadata 之后主动 pause/seek 可取消这次 play，不能误报为登录或解码失败。
        if (report.stage === 'browser-decode') { report.playStartRejected = true; controller.abort(); }
      });
    });
    report.media = { finiteDuration: Number.isFinite(audio.duration) && audio.duration > 0 };
    if (!report.media.finiteDuration) { report.reason = 'invalid-duration'; return report; }
    report.stage = 'browser-seek';
    audio.pause();
    await waitFor('seeked', () => { audio.currentTime = Math.min(5, audio.duration / 2); });
    report.media.seeked = audio.currentTime > 0;
    report.stage = 'browser-play';
    const start = audio.currentTime;
    await new Promise((resolve, reject) => {
      const fail = () => { clean(); reject(new Error('playback')); };
      const advance = () => { if (audio.currentTime > start + 0.25) { clean(); resolve(); } };
      const interval = setInterval(advance, 100);
      function clean() { clearInterval(interval); controller.signal.removeEventListener('abort', fail); audio.removeEventListener('error', fail); }
      controller.signal.addEventListener('abort', fail, { once: true });
      audio.addEventListener('error', fail, { once: true });
      if (controller.signal.aborted) return fail();
      try { void audio.play().catch(fail); } catch { fail(); }
    });
    report.media.timeAdvanced = true;
    report.stage = 'done';
    report.completed = true;
    return report;
  } catch {
    report.reason = report.playStartRejected ? 'play-start-rejected' : controller.signal.aborted ? 'timeout' : 'request-or-media-failed';
    if (audio) report.mediaState = {
      readyState: audio.readyState, networkState: audio.networkState,
      pageVisible: env.isPageVisible()
    };
    return report;
  } finally {
    clearTimeout(deadline);
    controller.abort();
    if (audio) {
      for (const release of [() => audio.pause(), () => audio.removeAttribute('src'), () => audio.load()]) {
        try { release(); } catch { cleanupSucceeded = false; }
      }
    }
    report.cleanupSucceeded = cleanupSucceeded;
    if (!cleanupSucceeded) { report.completed = false; report.reason = 'media-cleanup-failed'; }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runNasMediaProbe };
} else {
  void runNasMediaProbe({
    href: location.href, fetch: (...args) => fetch(...args),
    createAudio: () => new Audio(), isPageVisible: () => document.visibilityState === 'visible'
  }).then(report => console.info('FN_MUSIC_SAFE_MEDIA_PROBE ' + JSON.stringify(report)));
}
