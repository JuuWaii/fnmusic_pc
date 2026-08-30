'use strict';
/**
 * 安全策略
 * - 会话权限：只放行媒体/通知/全屏，且仅限「已配置的服务器主机」；其余一律拒绝
 * - 证书错误：默认透传 Chromium 的正常校验；仅当用户在设置中显式开启
 *   「忽略证书错误」时放行（FN Connect 隧道在个别网络环境下证书校验可能失败）
 * - 外部链接：window.open 一律交给系统默认浏览器，且只允许 http/https
 */
const { shell } = require('electron');
const logger = require('./logger');
const serverUrl = require('./server-url');

/**
 * 判断某个请求来源是否为「已配置的服务器主机」
 * @param {() => object} getSettings
 * @param {string | undefined} rawUrl 完整 URL（requestingUrl / requestingOrigin 等）
 */
function isTrustedOrigin(getSettings, rawUrl) {
  if (!rawUrl) return false;
  let host;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  const s = getSettings();
  const candidates = [serverUrl.validateUrl(s.serverUrl), serverUrl.validateUrl(s.remoteUrl)]
    .filter(Boolean)
    .map((u) => { try { return new URL(u).hostname; } catch { return null; } })
    .filter(Boolean);
  return candidates.includes(host);
}

/**
 * 为「guest 会话」（飞牛音乐网页所在的分区）配置权限策略
 * @param {import('electron').Session} ses
 * @param {() => object} getSettings 返回当前设置的函数
 */
function setupGuestSessionSecurity(ses, getSettings) {
  // 允许的权限集合（且必须命中已配置服务器主机）
  const ALLOWED_PERMISSIONS = new Set(['media', 'notifications', 'fullscreen']);

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const originUrl = (details && details.requestingUrl) || webContents.getURL();
    const trusted = isTrustedOrigin(getSettings, originUrl);
    if (!trusted) {
      logger.info('拒绝权限请求（来源不在已配置服务器）:', permission, originUrl || '?');
      callback(false);
      return;
    }
    if (!ALLOWED_PERMISSIONS.has(permission)) {
      logger.info('拒绝权限请求（非白名单）:', permission);
      callback(false);
      return;
    }
    // media 权限按请求类型收窄：只放行音频（音频输出/输入），拒绝摄像头采集
    if (permission === 'media') {
      const types = (details && details.mediaTypes) || [];
      const allowAudio = types.length === 0 || types.includes('audio') || types.includes('audiooutput');
      if (!allowAudio) {
        logger.info('拒绝媒体权限（非音频）:', JSON.stringify(types));
        callback(false);
        return;
      }
    }
    callback(true);
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!ALLOWED_PERMISSIONS.has(permission)) return false;
    return isTrustedOrigin(getSettings, requestingOrigin);
  });

  // 证书错误：
  // - 默认：透传 Chromium 的校验结果（合法证书正常通过，非法证书被拒）
  // - 设置开启后：一律放行（全局选择，界面有风险提示）
  ses.setCertificateVerifyProc((request, callback) => {
    try {
      if (getSettings().ignoreCertErrors) {
        callback(0);
        return;
      }
    } catch (e) {
      logger.warn('读取证书设置失败:', e.message);
    }
    // errorCode === 0 表示 Chromium 校验通过；其余一律拒绝
    callback(typeof request.errorCode === 'number' && request.errorCode === 0 ? 0 : -3);
  });
}

/**
 * 为 guest WebContents 设置新窗口处理：一律交给系统浏览器
 * @param {import('electron').WebContents} wc
 */
function setupWindowOpenHandler(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(() => logger.warn('打开外部链接失败:', url));
    } else {
      logger.warn('拒绝非 http(s) 新窗口:', url);
    }
    return { action: 'deny' };
  });
}

module.exports = { setupGuestSessionSecurity, setupWindowOpenHandler, isTrustedOrigin };
