// 启动探针：定位 Electron 启动失败阶段（临时调试用）
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const marker = (name) => fs.writeFileSync(path.join(__dirname, '..', 'probe-' + name + '.txt'), name + ' at ' + Date.now());
try { marker('js-ran'); } catch (e) { fs.writeFileSync('probe-js-ran.txt', 'err ' + e.message); }
app.whenReady().then(() => {
  try { marker('ready'); } catch (e) {}
  console.log('PROBE: whenReady OK');
  app.quit();
}).catch((e) => { console.log('PROBE: whenReady FAIL', e); });
setTimeout(() => { console.log('PROBE: timeout 20s'); app.exit(3); }, 20000);
