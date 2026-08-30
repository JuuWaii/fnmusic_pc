'use strict';
/**
 * 欢迎页逻辑（首次配置 / 未配置服务器时显示）
 * - 预填本地地址（来自设置或开发配置）
 * - 测试连接 → 保存并开始使用（保存后主进程自动切换到工具栏+网页模式）
 */
const api = window.fnmusic;
const $ = (id) => document.getElementById(id);

(async function init() {
  const s = await api.getSettings();
  $('serverUrl').value = s.serverUrl || '';
  $('remoteUrl').value = s.remoteUrl || '';
  $('musicPath').value = s.musicPath || '';
  $('accessMode').value = s.accessMode || 'auto';
  $('hardwareAcceleration').checked = s.hardwareAcceleration !== false;
})();

/** 展示测试结果 */
function showResult(ok, text) {
  const el = $('testResult');
  el.className = 'test-result ' + (ok ? 'ok' : 'err');
  el.textContent = text;
}

$('btnTest').addEventListener('click', async () => {
  const url = $('serverUrl').value.trim() || $('remoteUrl').value.trim();
  if (!url) { showResult(false, '请先填写服务器地址'); return; }
  showResult(false, '测试中…');
  const r = await api.testServer(url);
  if (r.ok) showResult(true, '连接成功（HTTP ' + r.status + '）');
  else showResult(false, '连接失败：' + (r.error || '未知错误'));
});

$('btnStart').addEventListener('click', async () => {
  const serverUrl = $('serverUrl').value.trim();
  const remoteUrl = $('remoteUrl').value.trim();
  if (!serverUrl && !remoteUrl) {
    showResult(false, '请至少填写一个服务器地址');
    return;
  }
  const result = await api.saveSettings({
    serverUrl,
    remoteUrl,
    musicPath: $('musicPath').value.trim(),
    accessMode: $('accessMode').value,
    hardwareAcceleration: $('hardwareAcceleration').checked,
  });
  if (result && result.ok === false) {
    showResult(false, '保存失败：' + (result.error || '未知错误'));
    return;
  }
  if (result && result.needsRestart) {
    showResult(false, '硬件加速设置需重启客户端后生效');
  }
  // 保存后主进程会切换到「工具栏 + 网页」模式，本页面被替换，无需额外操作
});