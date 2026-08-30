'use strict';
/**
 * 音频调节面板：设备选择 + 音量滑块（即选即生效，无需保存）
 * - 设备选择：onchange 立即调用 setAudioDevice（主进程即刻应用并广播到播放器）
 * - 音量滑块：input 实时调用 setVolume（作用于网页播放器输出并持久化）
 */
const api = window.fnmusic;
const $ = (id) => document.getElementById(id);

async function loadDevices() {
  const select = $('deviceSelect');
  select.disabled = true;
  const r = await api.listAudioDevices();
  select.innerHTML = '<option value="">系统默认设备（跟随系统设置）</option>';
  if (r.ok && r.devices) {
    for (const d of r.devices) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label;
      select.appendChild(opt);
    }
  } else {
    $('deviceStatus').className = 'status err';
    $('deviceStatus').textContent = '设备枚举失败：' + (r.error || '未知错误（页面可能未加载完成）');
  }
  const s = await api.getSettings();
  select.value = s.audioDeviceId || '';
  select.disabled = false;
}

(async function init() {
  await loadDevices();
  const s = await api.getSettings();
  const v = typeof s.volume === 'number' ? s.volume : 1;
  $('volumeSlider').value = v;
  $('volumeValue').textContent = Math.round(v * 100) + '%';
})();

/* 设备：即选即生效 */
$('deviceSelect').addEventListener('change', async () => {
  const id = $('deviceSelect').value;
  await api.setAudioDevice(id);
  $('deviceStatus').className = 'status';
  $('deviceStatus').textContent = id ? '已切换（立即生效）' : '已恢复系统默认';
  setTimeout(() => { $('deviceStatus').textContent = ''; }, 2000);
});

/* 音量：实时生效（rAF 节流，避免拖动时高频 IPC/写盘——审查轮 B4） */
let volumeRaf = null;
$('volumeSlider').addEventListener('input', () => {
  const v = Number($('volumeSlider').value);
  $('volumeValue').textContent = Math.round(v * 100) + '%';
  if (volumeRaf) return;
  volumeRaf = requestAnimationFrame(() => {
    volumeRaf = null;
    api.setVolume(Number($('volumeSlider').value));
  });
});

$('btnRefresh').addEventListener('click', loadDevices);
$('btnClose').addEventListener('click', () => api.closeAudioPanel());