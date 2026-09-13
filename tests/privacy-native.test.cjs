'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

function scan(files) {
  const root = path.join(__dirname, '..', '.review-audit', 'privacy-tests', randomUUID());
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'check-privacy.js'), path.join(root, 'scripts', 'check-privacy.js'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'check-privacy.js')], { encoding: 'utf8' });
}
test('native C# credentials are detected but not printed', () => {
  const value = 'q'.repeat(20);
  const result = scan({ 'native/src/Example.cs': 'string token = "' + value + '";' });
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('native/src/Example.cs'));
  assert.ok(!result.stdout.includes(value));
});
test('scanner checks later address matches after an allowed loopback match', () => {
  const address = [203, 0, 113, 9].join('.');
  const result = scan({ 'native/src/Resources.resw': '<value>127.0.0.1 ' + address + '</value>' });
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes(address));
});
test('C# cookie construction does not join separate lines into a secret', () => {
  const source = [
    'var header = "music-token=" + Escape(value);',
    'request.Headers.Accept.ParseAdd("application/json");'
  ].join('\n');
  assert.equal(scan({ 'native/src/Client.cs': source }).status, 0);
});
test('untracked native build outputs are excluded from source scan', () => {
  const value = 'q'.repeat(20);
  const result = scan({
    'native/src/App/bin/Generated.cs': 'string token = "' + value + '";',
    'native/src/App/Resources.resw': '<value>连接与设置</value>'
  });
  assert.equal(result.status, 0);
});
