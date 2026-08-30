'use strict';
/**
 * 设置页逻辑：加载/保存设置、测试连接、设备列表、桌面歌词、数据清理、关于信息
 * 支持 ?welcome=1 的「欢迎/首次配置」模式（隐藏高级与关于，简化流程）。
 */
const api = window.fnmusic;
const $ = (id) => document.getElementById(id);

const isWelcome = new URLSearchParams(location.search).get('welcome') === '1';
let current = null;

// 硬件加速「用户是否显式改动过」标记（审查轮 9 P1 修复）：
// 与欢迎页一致——用户未触碰该开关时保存不提交 hardwareAcceleration，
// 保持原设置不变。否则渲染异常机器上「打开设置窗口保存任意设置」会
// 把软件渲染意外切回硬件加速 → 黑屏回归 + hardwareAccelUserSet 置位
// 导致自动降级永久失效。
let hardwareTouched = false;

/** 轻提示 */
function toast(text, isErr) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

/** 展示测试结果 */
function showTest(ok, text) {
  const el = $('testResult');
  el.className = ok ? 'ok' : 'err';
  el.textContent = text;
}

(async function init() {
  current = await api.getSettings();
  $('serverUrl').value = current.serverUrl || '';
  $('remoteUrl').value = current.remoteUrl || '';
  $('accessMode').value = current.accessMode || 'auto';
  $('musicPath').value = current.musicPath || '';
  $('ignoreCertErrors').checked = Boolean(current.ignoreCertErrors);
  $('minimizeToTray').checked = Boolean(current.minimizeToTray);
  $('hardwareAcceleration').checked = current.hardwareAcceleration !== false;
  $('hardwareAcceleration').addEventListener('change', () => { hardwareTouched = true; });

  // 欢迎模式：简化页面
  if (isWelcome) {
    $('pageTitle').textContent = '欢迎使用 FN Music PC';
    $('pageSub').textContent = '填写飞牛音乐服务器地址即可开始（可随时在设置中修改）';
    $('sectionAdvanced').style.display = 'none';
    document.querySelector('section:nth-of-type(3)').style.display = 'none'; // 高级
    $('btnSave').textContent = '开始使用';
  }

  // 关于信息
  try {
    const info = await api.getAppInfo();
    $('aboutText').innerHTML =
      '版本 ' + info.appVersion + '<br/>' +
      'Electron ' + info.electron + ' · Chromium ' + info.chrome + ' · Node ' + info.node +
      '<br/>平台 ' + info.platform;
  } catch { /* 忽略 */ }

  refreshDevices();
})();

/* ---------- 服务器 ---------- */
$('btnTest').addEventListener('click', async () => {
  const url = $('serverUrl').value.trim() || $('remoteUrl').value.trim();
  if (!url) { showTest(false, '请先填写地址'); return; }
  showTest(false, '测试中…');
  const r = await api.testServer(url);
  if (r.ok) showTest(true, '连接成功（HTTP ' + r.status + '）');
  else showTest(false, '连接失败：' + (r.error || '未知错误'));
});

/* ---------- 音频设备 ---------- */
async function refreshDevices() {
  const select = $('deviceSelect');
  const prev = select.value;
  select.innerHTML = '<option value="">系统默认设备（跟随系统设置）</option>';
  select.disabled = true;
  const r = await api.listAudioDevices();
  if (r.ok && r.devices) {
    for (const d of r.devices) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label;
      select.appendChild(opt);
    }
  }
  select.disabled = false;
  // 恢复当前选中（含未加载前的默认值）
  select.value = current && current.audioDeviceId ? current.audioDeviceId : prev;
}

$('btnRefreshDevices').addEventListener('click', refreshDevices);

/* ---------- 音频诊断 ---------- */
$('btnOpenLog').addEventListener('click', async () => {
  const ok2 = await api.openLogDir();
  if (!ok2) toast('日志目录不可用（请查看控制台输出）', true);
});

$('btnDiag').addEventListener('click', async () => {
  const pre = $('diagResult');
  pre.classList.remove('hidden');
  pre.textContent = '正在收集诊断信息…';
  const r = await api.diagnoseAudio();
  pre.textContent = JSON.stringify(r, null, 2);
});

/* ---------- 保存 / 默认 ---------- */
$('btnSave').addEventListener('click', async () => {
  const patch = {
    serverUrl: $('serverUrl').value.trim(),
    remoteUrl: $('remoteUrl').value.trim(),
    musicPath: $('musicPath').value.trim(),
    accessMode: $('accessMode').value,
    ignoreCertErrors: $('ignoreCertErrors').checked,
    minimizeToTray: $('minimizeToTray').checked,
  };
  // 仅当用户显式改动过硬件加速开关才提交该字段（审查轮 9 P1：避免
  // 渲染异常机器上保存任意设置把软件渲染意外切回硬件加速 → 黑屏回归）
  if (hardwareTouched) patch.hardwareAcceleration = $('hardwareAcceleration').checked;
  // 音频设备：仅当选择项有变化时才发送（避免空列表时误清空）
  const sel = $('deviceSelect').value;
  const curDevice = (current && current.audioDeviceId) || '';
  if (sel !== curDevice) patch.audioDeviceId = sel;

  const result = await api.saveSettings(patch);
  current = await api.getSettings();
  if (result && result.ok === false) {
    toast('保存失败：' + (result.error || '未知错误'), true);
    return;
  }
  if (result && result.needsRestart) {
    toast('已保存——硬件加速设置需重启客户端后生效');
    return;
  }
  toast('已保存并应用');
  if (isWelcome) {
    // 欢迎模式保存后直接关闭设置窗口，回到主界面
    setTimeout(() => api.closeSettings(), 600);
  }
});

$('btnDefaults').addEventListener('click', async () => {
  if (!confirm('确定恢复默认设置吗？服务器地址将被清空。')) return;
  await api.saveSettings({
    serverUrl: '', remoteUrl: '', musicPath: '/music', accessMode: 'auto',
    audioDeviceId: '', ignoreCertErrors: false, minimizeToTray: true, hardwareAcceleration: true,
  });
  location.reload();
});

/* ---------- 清除数据 ---------- */
$('btnClearData').addEventListener('click', async () => {
  if (!confirm('将清除飞牛音乐网页的登录信息（Cookie）与缓存，确定继续？')) return;
  const r = await api.clearData();
  toast(r.ok ? '已清除，页面已重新加载' : '清除失败：' + (r.error || ''), !r.ok);
});