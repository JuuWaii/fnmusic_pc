'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNasMediaProbe } = require('../scripts/nas-media-probe.js');

class AudioStub extends EventTarget {
  duration = 30;
  time = 0;
  readyState = 1;
  networkState = 1;
  removed = false;
  pause() { this.paused = true; }
  load() { if (!this.removed) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
  play() { this.paused = false; this.time += 1; return Promise.resolve(); }
  removeAttribute() { this.removed = true; }
  get currentTime() { return this.time; }
  set currentTime(value) { this.time = value; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
}
function fixture() {
  const audio = new AudioStub();
  const calls = [];
  const env = {
    href: 'https://nas.example.invalid/music/', timeoutMs: 1000,
    createAudio: () => audio, isPageVisible: () => true,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const p = new URL(url).pathname;
      if (p.endsWith('/stream')) return new Response('private audio', { status: 206, headers: { 'content-range': 'bytes 4096-5119/12345' } });
      const data = p.endsWith('/me') ? { name: 'PRIVATE_USER' } : p.endsWith('/list') ? { list: [{ guid: 'PRIVATE_GUID', title: 'PRIVATE_TITLE' }] } : { track: { path: 'PRIVATE_PATH' } };
      return Response.json({ code: 0, data });
    }
  };
  return { env, calls, audio };
}
test('nonzero Range and muted seek/play produce only sanitized evidence and release audio', async () => {
  const { env, calls, audio } = fixture();
  const result = await runNasMediaProbe(env);
  assert.equal(result.completed, true);
  assert.equal(result.media.seeked, true);
  assert.equal(result.media.timeAdvanced, true);
  assert.equal(audio.muted, true);
  assert.equal(audio.paused, true);
  assert.equal(audio.removed, true);
  assert.ok(calls.every(c => c.options.redirect === 'error'));
  assert.equal(calls.at(-1).options.headers.Range, 'bytes=4096-5119');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|example\.invalid|12345/);
});
test('a server ignoring Range stops before creating a player', async () => {
  const { env } = fixture();
  const fetch = env.fetch;
  env.fetch = (url, options) => url.includes('/stream?') ? Promise.resolve(new Response('body')) : fetch(url, options);
  env.createAudio = () => assert.fail('player should not start');
  assert.equal((await runNasMediaProbe(env)).reason, 'range-contract-mismatch');
});
test('autoplay rejection is reported promptly and cleans up media', async () => {
  const { env, audio } = fixture();
  audio.load = () => {};
  audio.play = () => Promise.reject(new Error('PRIVATE_AUTOPLAY_ERROR'));
  const result = await runNasMediaProbe(env);
  assert.equal(result.reason, 'play-start-rejected');
  assert.equal(audio.removed, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});
test('a hung media load times out and removes the source', async () => {
  const { env, audio } = fixture();
  env.timeoutMs = 20;
  audio.load = () => {};
  const result = await runNasMediaProbe(env);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.completed, false);
  assert.equal(audio.removed, true);
});
test('authentication failure never requests music', async () => {
  const { env } = fixture();
  let count = 0;
  env.fetch = async () => { count++; return Response.json({ msg: 'PRIVATE_USER' }, { status: 401 }); };
  const result = await runNasMediaProbe(env);
  assert.equal(count, 1);
  assert.equal(result.stage, 'session');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});
test('invalid page URL is handled without exposing it or starting a request', async () => {
  const { env } = fixture();
  env.href = 'PRIVATE_INVALID_URL';
  env.fetch = () => assert.fail('must not request');
  const result = await runNasMediaProbe(env);
  assert.equal(result.completed, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});
test('one cleanup failure still removes the media source and is not reported as success', async () => {
  const { env, audio } = fixture();
  audio.load = () => {};
  audio.play = () => Promise.reject(new Error('autoplay'));
  audio.pause = () => { throw new Error('cleanup'); };
  const result = await runNasMediaProbe(env);
  assert.equal(audio.removed, true);
  assert.equal(result.cleanupSucceeded, false);
  assert.equal(result.completed, false);
});
test('intentional pause after metadata may cancel preload play without failing seek', async () => {
  const { env, audio } = fixture();
  let rejectFirst, count = 0;
  audio.play = () => ++count === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : (audio.time += 1, Promise.resolve());
  audio.pause = () => { audio.paused = true; rejectFirst?.(new Error('interrupted by pause')); };
  const result = await runNasMediaProbe(env);
  assert.equal(result.completed, true);
  assert.equal(result.playStartRejected, undefined);
});
