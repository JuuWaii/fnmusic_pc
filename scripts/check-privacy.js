'use strict';
/**
 * 隐私合规检查脚本（npm run check:privacy）
 *
 * 目标：确保版本库中不包含任何个人信息——
 *   - 内网 IP 地址（192.168.x / 10.x / 172.16-31.x 等）
 *   - 远程访问域名（FN Connect 个人地址）
 *   - Cookie / Token / API 密钥 / 密码等凭据
 *   - 用户级配置文件（dev.config.json / settings.json）
 *
 * 实现说明：直接解析 .git/index（git 索引文件）获取被跟踪文件列表，
 * 不依赖 git 子进程（在受限环境/CI 中更可靠）。忽略文件（如 dev.config.json）
 * 天然不在索引中。若索引缺失（尚未提交），退化为扫描源码目录。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 解析 git 索引（v2 格式）返回被跟踪文件名列表；失败返回 null */
function trackedFilesFromIndex() {
  const indexPath = path.join(ROOT, '.git', 'index');
  let buf;
  try {
    buf = fs.readFileSync(indexPath);
  } catch {
    return null;
  }
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'DIRC') return null;
  const indexVersion = buf.readUInt32BE(4);
  if (indexVersion !== 2) {
    // v3/v4（前缀压缩）无法可靠解析文件名，报告并退化到目录扫描
    console.log('警告: git 索引版本 ' + indexVersion + '（不支持解析），退化为目录扫描');
    return null;
  }
  const count = buf.readUInt32BE(8);
  const files = [];
  let offset = 12;
  for (let i = 0; i < count && offset + 62 < buf.length; i++) {
    const entryStart = offset;
    offset += 40; // ctime(8) + mtime(8) + dev(4) + ino(4) + mode(4) + uid(4) + gid(4) + size(4)
    offset += 20; // sha1
    const flags = buf.readUInt16BE(offset);
    offset += 2;
    const nameLen = flags & 0x0fff;
    let name;
    if (nameLen < 0x0fff) {
      name = buf.toString('utf8', offset, offset + nameLen);
      offset += nameLen;
    } else {
      const start = offset;
      while (offset < buf.length && buf[offset] !== 0) offset++;
      name = buf.toString('utf8', start, offset);
    }
    offset += 1; // 结尾 NUL
    if (flags & 0x4000) offset += 2; // 扩展标志
    const used = offset - entryStart;
    offset += (8 - (used % 8)) % 8; // 8 字节对齐
    if (name) files.push(name);
  }
  return files;
}

/** 退化方案：扫描已知源码目录 */
function fallbackFiles() {
  const dirs = ['src', 'scripts', 'docs', 'build'];
  const files = [];
  for (const d of dirs) {
    const base = path.join(ROOT, d);
    if (!fs.existsSync(base)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    };
    walk(base);
  }
  for (const f of ['package.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'electron-builder.yml', 'LICENSE', 'dev.config.json.example', '.gitignore', '.npmrc']) {
    if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  }
  return files;
}

/** 禁止出现在版本库中的文件（用户个人配置） */
const FORBIDDEN_FILES = ['dev.config.json', 'settings.json', '.local/dev.config.json'];

/** 禁止出现在文本内容中的正则（个人信息/凭据） */
const PATTERNS = [
  { name: '内网 IP 地址', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/ },
  { name: '外网 IPv4（非文档示例）', re: /\b(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])(?:\.(?:\d{1,2}|1\d\d|2[0-4]\d|25[0-5])){3}\b/ },
  { name: '凭据（token/secret/password/key）', re: /(?:token|secret|password|passwd|api[_-]?key|authorization|sessionid)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: 'Cookie 明文', re: /cookie\s*[:=]\s*['"][^'"]{10,}['"]/i },
  { name: 'URL 内嵌凭据', re: /https?:\/\/[^\s/]+:[^\s/@]+@/ },
  // FN Connect 个人远程访问域名（官方代理域名的子域即个人地址）
  { name: 'FN Connect 个人域名', re: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:fnos\.net|5ddd\.com|trzznas\.com)\b/i },
  // FN Connect 官方域后的个人路径段（如 https://fnos.net/<用户名>）——审查轮 9 B P1：
  // 子域正则无法命中路径式个人地址，单列该模式兜底（xxx 等示例前缀豁免见下方过滤）
  { name: 'FN Connect 个人路径段', re: /fnos\.net\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\/|["'\s)]|$)/i },
];

/** 文档/示例文件中允许出现示例 IP */
const ALLOW_IP_FILES = new Set(['README.md', 'docs/ARCHITECTURE.md', 'THIRD_PARTY_NOTICES.md', 'dev.config.json.example']);
/** 允许出现 FN Connect 示例域名的文件（文档中的 xxxx.fnos.net 说明性示例） */
const ALLOW_FNCONNECT_FILES = new Set(['README.md', 'docs/ARCHITECTURE.md', 'THIRD_PARTY_NOTICES.md', 'dev.config.json.example', 'REVIEW.md', 'scripts/check-privacy.js']);
const ALLOWED_IP = ['127.0.0.1', '0.0.0.0', '::1'];

let violations = 0;
const report = [];

function checkFile(file) {
  if (FORBIDDEN_FILES.includes(file)) {
    violations++;
    report.push('✗ 禁止文件出现在版本库: ' + file);
    return;
  }
  // 点文件（.npmrc/.gitignore 等）也纳入内容扫描
  const isDotfile = /^\.[a-z0-9_-]+$/i.test(path.basename(file));
  if (!isDotfile && !/\.(js|json|md|yml|yaml|html|css|txt|example)$/i.test(file)) return;
  let content;
  try {
    content = fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch { return; }
  for (const { name, re } of PATTERNS) {
    const matches = content.match(re);
    if (!matches) continue;
    // 回环地址（127.0.0.1 等）与文档示例永远豁免
    if (name === '外网 IPv4（非文档示例）') {
      const filtered = matches.filter((m) => !ALLOWED_IP.includes(m));
      if (!filtered.length) continue;
      if (ALLOW_IP_FILES.has(file)) continue;
    }
    // FN Connect 示例域名仅在文档文件中允许
    if (name === 'FN Connect 个人域名' && ALLOW_FNCONNECT_FILES.has(file)) {
      // 文档中的说明性示例（如 https://xxxx.fnos.net）放行
      const filtered = matches.filter((m) => !/\bxxxx\./.test(m));
      if (!filtered.length) continue;
    }
    // FN Connect 个人路径段：示例占位（xxxx / user-0001 / your-name 等中性值）与
    // 通用入口路径（music）豁免，但仅限中性值（审查轮 9 B P1）
    if (name === 'FN Connect 个人路径段') {
      const filtered = matches.filter((m) => !/fnos\.net\/(?:xxxx|user-\d+|your-name|example|music)(?:\/|["'\s)]|$)/i.test(m));
      if (!filtered.length) continue;
    }
    violations++;
    report.push('✗ [' + name + '] ' + file + ' → ' + matches.slice(0, 3).join(', '));
  }
}

console.log('=== FN Music PC 隐私合规检查 ===');
const files = trackedFilesFromIndex() || fallbackFiles();
console.log('扫描 ' + files.length + ' 个被跟踪文件');
for (const f of files) checkFile(f);

if (violations) {
  console.log('\n发现 ' + violations + ' 处隐私违规：');
  report.forEach((r) => console.log('  ' + r));
  console.log('\n请移除上述个人信息后再提交。');
  process.exit(1);
} else {
  console.log('\n✓ 未发现个人信息（IP/凭据/个人配置）');
}