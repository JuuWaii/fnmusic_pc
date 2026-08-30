'use strict';
/**
 * 桌面歌词窗口逻辑：显示当前行/下一行，支持拖动、关闭、点击穿透
 */
const bridge = window.fnmusicLyrics;
const $ = (id) => document.getElementById(id);

bridge.onUpdate((d) => {
  if (d.hasLyrics) {
    $('curLine').textContent = d.cur || '…';
    $('nextLine').textContent = d.next || '';
    $('trackName').textContent = d.track || '正在播放';
    $('trackName').title = d.track || '';
  } else {
    $('curLine').textContent = '未获取到歌词';
    $('nextLine').textContent = '（当前歌曲无歌词，或网页未提供歌词数据）';
  }
  if (d.domOnly) {
    $('trackName').textContent = (d.track || '正在播放') + ' · 歌词（页面捕获）';
  }
});

/* ---------- 拖动窗口 ---------- */
let dragging = false;
$('dragbar').addEventListener('mousedown', (e) => {
  if (e.target.closest('.mini')) return; // 按钮不触发拖动
  dragging = true;
  bridge.dragStart({ screenX: e.screenX, screenY: e.screenY });
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (dragging) bridge.dragMove({ screenX: e.screenX, screenY: e.screenY });
});
window.addEventListener('mouseup', () => {
  if (dragging) { dragging = false; bridge.dragEnd(); }
});

/* ---------- 按钮 ---------- */
$('btnClose').addEventListener('click', () => bridge.close());
$('btnInteractive').addEventListener('click', () => bridge.toggleInteractive());