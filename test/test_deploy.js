/* 部署相关：DATA_TOKEN 令牌门禁 + 纯静态托管只读档
 *
 * 覆盖：
 *  - serve.js 设了 DATA_TOKEN 后，/api/* 必须带 Bearer，否则 401；静态 /data.json 仍可不带令牌读取
 *  - 前端 probeHttp 探到 401 时返回 {needsToken:true}，boot 据此带令牌重试或降级
 *  - 前端 createHttpPersistence 带令牌可写，不带则写失败
 *  - 纯静态主机（没有 /api）时，probeStatic 命中 /data.json，createStaticPersistence 只读、写返回 READONLY
 *  - dataFileVm 的 static 分支文案
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const serve = require('../serve.js');
const fsio = require('../js/fsio.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'logi-deploy-')); }

async function withServer(opts, fn) {
  const dir = tmpDir();
  const server = serve.createServer(dir, opts || {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await fn({ base, dir, dataFile: path.join(dir, 'data.json') });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

// 一个"纯静态主机"：只提供 /data.json，任何 /api/* 都 404（模拟没有 Node 后端）
async function withBareStatic(data, fn) {
  const server = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (p === '/data.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
      res.end(data);
    } else if (p.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false}');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>static host</html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await fn({ base }); } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('DATA_TOKEN：未带令牌访问 /api/health 返回 401', async () => {
  await withServer({ token: 's3cr3t' }, async ({ base }) => {
    const r = await fetch(base + '/api/health');
    assert.strictEqual(r.status, 401);
  });
});

test('DATA_TOKEN：带 Bearer 令牌则接口放行', async () => {
  await withServer({ token: 's3cr3t' }, async ({ base, dataFile }) => {
    const r = await fetch(base + '/api/health', { headers: { Authorization: 'Bearer s3cr3t' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).ok, true);

    const w = await fetch(base + '/api/data', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cr3t' },
      body: JSON.stringify({ version: 1, settings: {}, channels: [{ id: 'x' }], records: [] })
    });
    assert.strictEqual(w.status, 200);
    assert.strictEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')).channels.length, 1);
  });
});

test('DATA_TOKEN：写接口不带令牌返回 401（不能改数据）', async () => {
  await withServer({ token: 's3cr3t' }, async ({ base }) => {
    const w = await fetch(base + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(w.status, 401);
  });
});

test('DATA_TOKEN：静态 /data.json 读取不受令牌限制（供只读降级）', async () => {
  await withServer({ token: 's3cr3t' }, async ({ base, dir }) => {
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ version: 1, settings: {}, channels: [{ id: 'pub' }], records: [] }), 'utf8');
    const r = await fetch(base + '/data.json');
    assert.strictEqual(r.status, 200, '只读降级需要能直接 GET 到 data.json');
    assert.strictEqual((await r.json()).channels[0].id, 'pub');
  });
});

test('前端 probeHttp：探到 401 返回 {needsToken:true} 让 boot 决定降级', async () => {
  await withServer({ token: 's3cr3t' }, async ({ base }) => {
    const noTok = await fsio.probeHttp(base);
    assert.ok(noTok && noTok.needsToken === true, '无令牌应返回 needsToken');
    const withTok = await fsio.probeHttp(base, undefined, 's3cr3t');
    assert.ok(withTok && withTok.ok === true, '带令牌应探活成功');
  });
});

test('前端 http 持久化：带令牌能写，无令牌写给拒（返回未写盘）', async () => {
  await withServer({ token: 's3cr3t' }, async ({ base, dataFile }) => {
    const ok = await fsio.createHttpPersistence({ base, token: 's3cr3t' });
    const w1 = await ok.write({ version: 1, settings: {}, channels: [{ id: 'a' }], records: [] });
    assert.strictEqual(w1.target, 'http');
    assert.strictEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')).channels.length, 1);

    const bad = await fsio.createHttpPersistence({ base, token: 'wrong' });
    const w2 = await bad.write({ version: 1, settings: {}, channels: [{ id: 'b' }], records: [] });
    assert.strictEqual(w2.ok, false);
    assert.strictEqual(w2.target, 'idb', '无/错令牌写应标记未写盘');
    assert.strictEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')).channels.length, 1, '无令牌不能改到磁盘');
  });
});

test('纯静态主机：probeStatic 命中 /data.json，createStaticPersistence 只读', async () => {
  const payload = JSON.stringify({ version: 1, settings: { profitRate: 40 }, channels: [{ id: 's1' }], records: [] });
  await withBareStatic(payload, async ({ base }) => {
    const st = await fsio.probeStatic(base);
    assert.ok(st && st.file && st.channels === 1, '应探到 /data.json 且有 1 条渠道');

    const p = await fsio.createStaticPersistence({ file: st.file });
    assert.strictEqual(p.kind, 'static');
    assert.strictEqual(p.readonly, true);
    const d = await p.read();
    assert.strictEqual(d.settings.profitRate, 40);

    const w = await p.write(d);
    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.error, 'READONLY', '静态模式写必须明确失败，不能谎报已保存');
  });
});

test('纯静态主机：probeHttp 失败但 probeStatic 成功，模拟 boot 选档', async () => {
  const payload = JSON.stringify({ version: 1, settings: {}, channels: [{ id: 'z' }], records: [] });
  await withBareStatic(payload, async ({ base }) => {
    const health = await fsio.probeHttp(base);
    assert.strictEqual(health, null, '纯静态没有 /api/health');
    const st = await fsio.probeStatic(base);
    assert.ok(st, '应回退到只读静态档');
  });
});

test('dataFileVm：static 分支文案为"只读模式"', () => {
  const vm = fsio.dataFileVm({ kind: 'static', filePath: '/srv/logi/data.json' });
  assert.strictEqual(vm.isStatic, true);
  assert.strictEqual(vm.needsBind, false);
  assert.match(vm.status, /只读模式/);
  assert.match(vm.hint, /serve\.js/); // 提示需跑 serve.js 才能写
});
