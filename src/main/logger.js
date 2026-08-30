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
  } catch {
    logFile = null; // 写日志失败不致命，静默降级为仅控制台
  }
  return logFile;
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
    try { fs.appendFileSync(file, line + '\n'); } catch { /* 忽略写日志错误 */ }
  }
}

module.exports = {
  info: (msg, ...args) => write('INFO', msg, ...args),
  warn: (msg, ...args) => write('WARN', msg, ...args),
  error: (msg, ...args) => write('ERROR', msg, ...args),
};
