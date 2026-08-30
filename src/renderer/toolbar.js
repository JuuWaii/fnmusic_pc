'use strict';
/**
 * 工具栏逻辑：导航按钮、状态展示、音频设备下拉、歌词开关、设置入口
 * 全部能力经由 preload 暴露的 window.fnmusic 白名单 API。
 */
const api = window.fnmusic;
const $ = (id) => document.getElementById(id);

/* ---------- 状态展示 ---------- */
let currentStatus = null;

api.onStatus((s) => {
  currentStatus = s;
  const dot = $('statusDot');
  const text = $('urlText');
  if (!s.url) {
    dot.className = 'dot dot-unknown';
    text.textContent = '未配置服务器';
  } else if (s.isLoading) {
    dot.className = 'dot dot-loading';
    text.textContent = '加载中… ' + s.url.replace(/^https?:\/\//, '');
  } else {
    dot.className = 'dot dot-ok';
    text.textContent = s.url.replace(/^https?:\/\//, '');
  }
  $('btnBack').disabled = !s.canGoBack;
  $('btnForward').disabled = !s.canGoForward;
});

/* ---------- 导航 ---------- */
$('btnBack').addEventListener('click', () => api.navigate('back'));
$('btnForward').addEventListener('click', () => api.navigate('forward'));
$('btnReload').addEventListener('click', () => api.navigate('reload'));
$('btnHome').addEventListener('click', () => api.navigate('home'));
$('urlPill').addEventListener('click', () => api.openSettings(false));

/* ---------- 设置 ---------- */
$('btnSettings').addEventListener('click', () => api.openSettings(false));

/* ---------- 桌面歌词开关 ---------- */
(async () => {
  const s = await api.getSettings();
  $('btnLyrics').classList.toggle('active', Boolean(s.showDesktopLyrics));
})();
$('btnLyrics').addEventListener('click', async () => {
  const s = await api.getSettings();
  const enabled = !s.showDesktopLyrics;
  await api.setLyricsEnabled(enabled);
  $('btnLyrics').classList.toggle('active', enabled);
});

/* ---------- 音频输出设备/音量：打开独立调节面板 ---------- */
// 说明：设备下拉菜单会被 guest 网页视图（WebContentsView）原生图层遮挡，
// 因此设备与音量调节收口到独立小窗（audio-panel），即选即生效。
$('btnDevice').addEventListener('click', () => api.openAudioPanel());