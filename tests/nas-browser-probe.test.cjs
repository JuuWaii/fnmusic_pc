'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNasReadonlyProbe } = require('../scripts/nas-browser-probe.js');
const origin = 'https://nas.example.invalid';
const client = '/music/static/assets/bdf49c3c3882102fc017ffb661108c63-DxzHiN_b.js';

function fixture() {
  const calls = [];
  const env = {
    href: origin + '/music/', resourceUrls: [origin + client],
    loadApi: async () => ({ w: {
      auth: { me: async () => ({ name: 'PRIVATE_USER', userToken: 'PRIVATE_SESSION' }) },
      track: {
        list: async (params) => { calls.push(params); return { list: [{ guid: 'PRIVATE_TRACK', title: 'PRIVATE_TITLE' }], total: 900 }; },
        metadata: async () => ({ track: { title: 'PRIVATE_TITLE' }, audioSpec: { duration: 9000, path: 'PRIVATE_PATH' } })
      }
    } }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(new Uint8Array(2048), { status: 206, headers: {
        'content-type': 'audio/flac', 'content-range': 'bytes 0-1023/12345'
      } });
    }
  };
  return { env, calls };
}

test('authenticated probe limits collection and emits no user, track, or credential values', async () => {
  const { env, calls } = fixture();
  const result = await runNasReadonlyProbe(env);
  assert.equal(result.completed, true);
  assert.equal(result.stream.sampledBytes, 1024);
  assert.equal(result.stream.partialResponse, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|nas\.example|12345|9000/);
  assert.deepEqual(calls[0], { page: 1, size: 1 });
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.method, 'GET');
});

test('module from another origin is never imported', async () => {
  const { env } = fixture();
  env.resourceUrls = ['https://other.example.invalid' + client];
  env.loadApi = async () => assert.fail('must not import');
  assert.equal((await runNasReadonlyProbe(env)).reason, 'reviewed-client-module-not-loaded');
});

test('auth failure stops before library and hides raw exception details', async () => {
  const { env } = fixture();
  env.loadApi = async () => ({ w: {
    auth: { me: async () => { throw Object.assign(new Error('PRIVATE_SESSION'), { code: 120001, statusCode: 401 }); } },
    track: { list: async () => assert.fail('must not list'), metadata: async () => assert.fail('must not read') }
  } });
  const result = await runNasReadonlyProbe(env);
  assert.equal(result.stage, 'session');
  assert.equal(result.httpStatus, 401);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SESSION/);
});

test('empty library does not attempt a stream request', async () => {
  const { env } = fixture();
  const loaded = await env.loadApi();
  loaded.w.track.list = async () => ({ list: [], total: 0 });
  env.loadApi = async () => loaded;
  env.fetch = async () => assert.fail('must not fetch');
  assert.equal((await runNasReadonlyProbe(env)).reason, 'no-track-available');
});

test('a full response or arbitrary server header is not reported as Range support', async () => {
  const { env } = fixture();
  env.fetch = async () => new Response('abc', { status: 200, headers: {
    'content-type': 'PRIVATE_HEADER', 'content-range': 'PRIVATE_RANGE'
  } });
  const result = await runNasReadonlyProbe(env);
  assert.equal(result.stream.partialResponse, false);
  assert.equal(result.stream.hasValidContentRange, false);
  assert.equal(result.stream.contentType, 'other');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});
