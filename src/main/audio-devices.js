'use strict';
/**
 * 音频输出设备管理（需求 4）
 *
 * 枚举逻辑：
 * - 在 guest 页面（飞牛音乐网页）上下文中执行 navigator.mediaDevices.enumerateDevices()；
 * - 若设备标签为空（浏览器未授予标签权限），尝试一次性获取音频流以解锁标签，
 *   随后立即释放（不会录音）；
 * - 设备切换：将目标 deviceId 下发给 guest-preload，由它调用
 *   HTMLMediaElement.setSinkId / AudioContext.setSinkId 完成定向输出。
 *
 * 设备 id 只保存在用户本机的 settings.json 中，不进入版本库。
 */
const logger = require('./logger');
const settings = require('./settings');

/** 在 guest 页面中执行的设备枚举脚本（字符串形式，注入执行） */
const ENUMERATE_SNIPPET = `(async () => {
  try {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
      return { ok: false, error: 'mediaDevices API 不可用' };
    }
    let devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    const allEmpty = outputs.length > 0 && outputs.every(d => !d.label);
    if (allEmpty) {
      // 标签为空：申请一次音频权限解锁标签（立即停止轨道，不录音）
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch (e) { /* 用户拒绝/不可用：继续使用无标签列表 */ }
    }
    const out = devices.filter(d => d.kind === 'audiooutput').map(d => ({
      deviceId: d.deviceId,
      label: d.label || d.deviceId,
    }));
    return { ok: true, devices: out };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
})()`;

/** 设备展示名（系统默认/通信设备给出友好名称） */
function prettyLabel(device) {
  if (device.deviceId === 'default') return '系统默认设备（跟随系统设置）';
  if (device.deviceId === 'communications') return '系统通信设备';
  return device.label || device.deviceId;
}

/**
 * 枚举当前可用的音频输出设备
 * @param {import('electron').WebContents | null} guestWc guest 页面的 webContents
 * @returns {Promise<{ok:boolean, devices?:{deviceId:string,label:string}[], error?:string}>}
 */
async function listDevices(guestWc) {
  if (!guestWc || guestWc.isDestroyed()) {
    return { ok: false, error: '页面尚未就绪，请稍后重试' };
  }
  // 仅当页面处于 http(s) 且非加载中时才执行枚举（about:blank/重载窗口期直接提示）
  const currentUrl = guestWc.getURL();
  if (!/^https?:/.test(currentUrl) || guestWc.isLoading()) {
    return { ok: false, error: '页面加载中，请稍后再试' };
  }
  try {
    const result = await guestWc.executeJavaScript(ENUMERATE_SNIPPET, true);
    if (result && result.ok && Array.isArray(result.devices)) {
      return {
        ok: true,
        devices: result.devices.map((d) => ({ deviceId: d.deviceId, label: prettyLabel(d) })),
      };
    }
    return { ok: false, error: (result && result.error) || '未知错误' };
  } catch (e) {
    logger.warn('枚举音频设备失败:', e && e.message);
    return { ok: false, error: '枚举失败：' + ((e && e.message) || e) };
  }
}

/**
 * 切换音频输出设备并持久化
 * @param {import('electron').WebContents | null} guestWc
 * @param {string} deviceId '' = 跟随系统
 */
function setDevice(guestWc, deviceId) {
  const id = typeof deviceId === 'string' ? deviceId : '';
  settings.update({ audioDeviceId: id });
  if (guestWc && !guestWc.isDestroyed()) {
    guestWc.send('fnmusic:set-audio-device', { deviceId: id });
  }
  logger.info('音频输出设备已切换:', id === '' ? '系统默认' : id);
}

module.exports = { listDevices, setDevice, prettyLabel };