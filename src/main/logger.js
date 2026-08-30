'use strict';
/**
 * 极简日志模块
 * - 同时输出到控制台与用户数据目录下的 logs/main-<date>.log
 * - 日志中绝不记录 cookie、token、密码等敏感信息（各调用方自行注意）
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let logDir = null;
let logFile = null;

function ensureFile() {
  if (logFile) return logFile;
  try {
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    logFile = path.join(logDir, `main-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
    // 验证目录可写（立即写入空串），失败则抛错走兜底
    fs.writeFileSync(logFile, '', { flag: 'a' });
  } catch (e) {
    logFile = null; // 写日志失败：显式报告原因（仅控制台），避免静默丢失诊断信息
    try {
      console.error('[logger] 日志初始化失败（诊断信息将仅输出到控制台）:', e && e.message ? e.message : e);
    } catch { /* 忽略 */ }
  }
  return logFile;
}

/** 日志目录（供诊断界面展示 / 打开） */
function getLogDir() {
  ensureFile();
  return logDir;
}

/** @param {string} level @param {string} msg @param {unknown[]} args */
function write(level, msg, ...args) {
  const time = new Date().toISOString();
  let extra = '';
  try {
    extra = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  } catch {
    extra = '';
  }
  const line = `[${time}] [${level}] ${msg} ${extra}`.trimEnd();
  console.log(line);
  const file = ensureFile();
  if (file) {
    try {
      // 轮转：单文件超过 1MB 时归档（main-<date>-<n>.log），保留最近 5 份（审查轮 C L4）
      const size = fs.statSync(file).size;
      if (size > 1024 * 1024) {
        const base = file.replace(/\.log$/, '');
        for (let n = 4; n >= 1; n--) {
          const src = base + '-' + n + '.log';
          const dst = base + '-' + (n + 1) + '.log';
          try { if (fs.existsSync(src)) fs.renameSync(src, dst); } catch { /* 忽略 */ }
        }
        try { fs.renameSync(file, base + '-1.log'); } catch { /* 忽略 */ }
      }
      fs.appendFileSync(file, line + '\n');
    } catch { /* 忽略写日志错误 */ }
  }
}

module.exports = {
  getLogDir,
  info: (msg, ...args) => write('INFO', msg, ...args),
  warn: (msg, ...args) => write('WARN', msg, ...args),
  error: (msg, ...args) => write('ERROR', msg, ...args),
};