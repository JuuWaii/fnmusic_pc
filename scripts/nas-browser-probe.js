/*
 * 阶段 1 手动诊断：在已登录的 NAS 音乐页面控制台运行此文件。
 * 仅复用页面已加载的 API 模块；不提取凭据，不创建转码任务，不写歌单。
 * 模块文件名对应本次分析版本，服务器升级后须重新核对，禁止猜测导出。
 */
'use strict';

async function runNasReadonlyProbe(env) {
  const report = { schemaVersion: 1, completed: false, stage: 'preflight' };
  const clientFile = 'bdf49c3c3882102fc017ffb661108c63-DxzHiN_b.js';
  let timer;
  const controller = new AbortController();
  try {
    const page = new URL(env.href);
    if (!['http:', 'https:'].includes(page.protocol) || !page.pathname.startsWith('/music/')) {
      report.reason = 'not-music-page';
      return report;
    }
    const moduleUrl = env.resourceUrls.map(value => {
      try { return new URL(value); } catch { return null; }
    }).find(url => url && url.origin === page.origin &&
      url.pathname === '/music/static/assets/' + clientFile && !url.search && !url.hash);
    if (!moduleUrl) {
      report.reason = 'reviewed-client-module-not-loaded';
      return report;
    }
    timer = setTimeout(() => controller.abort(), 20000);
    // 此模块已由音乐页面加载；使用其公开导出完成签名，不读取 Cookie 值。
    const loaded = await env.loadApi(moduleUrl.href);
    const api = loaded.w;
    if (typeof api?.auth?.me !== 'function' || typeof api?.track?.list !== 'function' ||
        typeof api?.track?.metadata !== 'function') {
      report.reason = 'client-contract-changed';
      return report;
    }
    const options = { authPolicy: 'none', errorPolicy: 'throw', signal: controller.signal };
    report.stage = 'session';
    const user = await api.auth.me(undefined, options);
    report.session = { returnedUserObject: !!user && typeof user === 'object' };
    if (!report.session.returnedUserObject) {
      report.reason = 'no-user-object';
      return report;
    }
    report.stage = 'library';
    const pageData = await api.track.list({ page: 1, size: 1 }, options);
    report.library = { hasList: Array.isArray(pageData?.list), hasNumericTotal: typeof pageData?.total === 'number' };
    if (!report.library.hasList) {
      report.reason = 'unexpected-library-contract';
      return report;
    }
    const track = pageData.list[0];
    if (!track) {
      report.reason = 'no-track-available';
      return report;
    }
    if (typeof track.guid !== 'string' || !track.guid || track.guid.length > 256) {
      report.reason = 'missing-track-identifier';
      return report;
    }
    report.stage = 'metadata';
    const metadata = await api.track.metadata({ guid: track.guid }, options);
    report.metadata = {
      hasTrack: !!metadata?.track && typeof metadata.track === 'object',
      hasAudioSpec: !!metadata?.audioSpec && typeof metadata.audioSpec === 'object',
      hasNumericDuration: typeof metadata?.audioSpec?.duration === 'number',
      isCue: track.isCue === true
    };
    report.stage = 'stream-range';
    const stream = new URL('/music/api/v1/track/stream', page.origin);
    stream.searchParams.set('guid', track.guid);
    const response = await env.fetch(stream.href, {
      method: 'GET', credentials: 'same-origin', redirect: 'error',
      headers: { Range: 'bytes=0-1023' }, signal: controller.signal
    });
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const knownTypes = ['audio/mpeg', 'audio/flac', 'audio/x-flac', 'audio/mp4', 'audio/aac',
      'audio/wav', 'audio/x-wav', 'audio/ogg', 'application/octet-stream'];
    report.stream = {
      httpStatus: response.status,
      contentType: knownTypes.includes(contentType) ? contentType : 'other',
      partialResponse: response.status === 206,
      hasValidContentRange: /^bytes 0-\d+\/(?:\d+|\*)$/.test(response.headers.get('content-range') || ''),
      sampledBytes: 0
    };
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (report.stream.sampledBytes < 1024) {
          const item = await reader.read();
          if (item.done) break;
          // 只统计，不保存或输出内容；网络缓冲可能大于请求的采样长度。
          report.stream.sampledBytes += Math.min(item.value.byteLength, 1024 - report.stream.sampledBytes);
        }
      } finally { await reader.cancel(); }
    }
    report.completed = true;
    report.stage = 'done';
    // HTTP 200 不代表可拖动进度；206 也不代表 WinUI 能解码。
    report.stream.transferObserved = [200, 206].includes(response.status) && report.stream.sampledBytes > 0;
    return report;
  } catch (error) {
    report.reason = controller.signal.aborted ? 'timeout' : 'request-failed';
    // 严禁输出异常 message、URL、响应 body、用户对象或曲目名称。
    if (Number.isInteger(error?.statusCode) && error.statusCode >= 100 && error.statusCode <= 599) {
      report.httpStatus = error.statusCode;
    }
    if ([120001, 99999].includes(error?.code)) report.authErrorCode = error.code;
    return report;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runNasReadonlyProbe };
} else {
  void runNasReadonlyProbe({
    href: location.href,
    resourceUrls: performance.getEntriesByType('resource').map(entry => entry.name),
    loadApi: url => import(url),
    fetch: (...args) => fetch(...args)
  }).then(report => console.info('FN_MUSIC_SAFE_PROBE ' + JSON.stringify(report)));
}
