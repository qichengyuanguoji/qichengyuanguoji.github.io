/* 网页数据直接写进 data.json：服务端 /api/data 接口 + 页面侧 http 持久化
 *
 * 背景：以前页面必须让用户手动选一次 data.json（File System Access API），
 * 浏览器重启后授权还会被收回，写盘失败就悄悄退回浏览器存储。
 * 现在由 serve.js 托管文件，页面 GET/POST /api/data 即可读写项目目录里的 data.json。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serve = require('../serve.js');
const fsio = require('../js/fsio.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logi-api-'));
}

// 起一台指向临时目录的服务（端口 0 = 系统分配），测完关掉
async function withServer(fn) {
  const dir = tmpDir();
  const server = serve.createServer(dir);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await fn({ base, dir, dataFile: path.join(dir, 'data.json') });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections(); // fetch 的 keep-alive 会拖住 close
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

test('GET /api/health：服务在就返回 ok，并报出数据文件与条数', async () => {
  await withServer(async ({ base, dataFile }) => {
    const r = await fetch(base + '/api/health');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(path.resolve(j.file), path.resolve(dataFile));
    assert.strictEqual(j.channels, 0);
  });
});

test('GET /api/data：文件不存在时给空结构，而不是 404', async () => {
  await withServer(async ({ base, dataFile }) => {
    const r = await fetch(base + '/api/data');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('X-Data-Exists'), '0');
    const d = await r.json();
    assert.ok(Array.isArray(d.channels), 'channels 应为数组');
    assert.strictEqual(d.channels.length, 0);
    assert.ok(!fs.existsSync(dataFile), '读接口不应顺手创建文件');
  });
});

test('POST /api/data：整份写回 data.json，GET 能原样读回', async () => {
  await withServer(async ({ base, dataFile }) => {
    const payload = {
      version: 1,
      settings: { profitRate: 25 },
      channels: [{ id: 'a1', name: '海运直航', carrier: '088' }],
      records: []
    };
    const r = await fetch(base + '/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.channels, 1);

    const onDisk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.strictEqual(onDisk.channels.length, 1);
    assert.strictEqual(onDisk.channels[0].name, '海运直航');

    const back = await (await fetch(base + '/api/data')).json();
    assert.strictEqual(back.channels[0].carrier, '088');
    assert.strictEqual(back.settings.profitRate, 25);
  });
});

test('POST /api/data：非法 JSON 返回 400，且不破坏磁盘上已有数据', async () => {
  await withServer(async ({ base, dataFile }) => {
    fs.writeFileSync(dataFile, JSON.stringify({ version: 1, settings: {}, channels: [{ id: 'old' }], records: [] }), 'utf8');
    const r = await fetch(base + '/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{这不是 JSON'
    });
    assert.strictEqual(r.status, 400);
    const onDisk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.strictEqual(onDisk.channels[0].id, 'old', '写失败不能把原文件冲掉');
  });
});

test('POST /api/data：数组/标量直接拒绝写盘', async () => {
  await withServer(async ({ base }) => {
    for (const body of ['[]', '123', '"x"', 'null']) {
      const r = await fetch(base + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.strictEqual(r.status, 400, '应拒绝 ' + body);
    }
  });
});

test('写盘是原子的：先写 .tmp 再改名，不留临时文件', async () => {
  await withServer(async ({ base, dataFile }) => {
    await fetch(base + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, settings: {}, channels: [], records: [] }) });
    assert.ok(fs.existsSync(dataFile));
    assert.ok(!fs.existsSync(dataFile + '.tmp'), '不应残留 data.json.tmp');
  });
});

test('非本机 Host 被拒（防 DNS rebinding 改写 data.json）', async () => {
  await withServer(async ({ base }) => {
    // fetch 不允许改 Host，这里直接用 http 模块发一个带伪造 Host 的请求
    const http = require('node:http');
    const url = new URL(base + '/api/data');
    const code = await new Promise((resolve, reject) => {
      const req = http.request({ host: url.hostname, port: url.port, path: '/api/data', method: 'POST', headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ version: 1, settings: {}, channels: [], records: [] }));
    });
    assert.strictEqual(code, 403);
  });
});

test('未知 /api/* 返回 404，静态文件仍可访问', async () => {
  await withServer(async ({ base, dir }) => {
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>ok</h1>', 'utf8');
    const r1 = await fetch(base + '/api/nope');
    assert.strictEqual(r1.status, 404);
    const r2 = await fetch(base + '/');
    assert.strictEqual(r2.status, 200);
    assert.match(await r2.text(), /ok/);
  });
});

test('页面侧 http 持久化：read 拿到文件内容，write 落盘', async () => {
  await withServer(async ({ base, dataFile }) => {
    fs.writeFileSync(dataFile, JSON.stringify({ version: 1, settings: { volRatio: 6000 }, channels: [{ id: 'c1' }], records: [] }), 'utf8');
    const p = await fsio.createHttpPersistence({ base: base });
    assert.strictEqual(p.kind, 'http');
    assert.strictEqual(p.needsFile, false, 'http 模式不需要选文件');

    const d = await p.read();
    assert.strictEqual(d.settings.volRatio, 6000);
    assert.ok(p.filePath && p.filePath.endsWith('data.json'), '应记录真实文件路径，实际：' + p.filePath);

    d.channels.push({ id: 'c2' });
    const w = await p.write(d);
    assert.strictEqual(w.target, 'http');
    const onDisk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.strictEqual(onDisk.channels.length, 2);
  });
});

test('页面侧 http 持久化：服务挂了也不抛错，只标记未写盘', async () => {
  const p = await fsio.createHttpPersistence({ base: 'http://127.0.0.1:1' });
  const r = await p.write({ version: 1, settings: {}, channels: [], records: [] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.target, 'idb', '应标记成没写进文件，让顶栏亮黄灯');
  assert.ok(p.lastWrite && p.lastWrite.error);
});

test('probeHttp：服务在则可用，不在则返回 null（boot 据此降级）', async () => {
  await withServer(async ({ base }) => {
    const ok = await fsio.probeHttp(base);
    assert.ok(ok && ok.ok === true);
  });
  const dead = await fsio.probeHttp('http://127.0.0.1:1', 300);
  assert.strictEqual(dead, null);
});

test('dataFileVm：http 直连时是"已直连自动保存"，不提示绑定/授权', () => {
  const vm = fsio.dataFileVm({ kind: 'http', filePath: 'D:\\工作空间\\1.02\\data.json' });
  assert.strictEqual(vm.isHttp, true);
  assert.strictEqual(vm.needsBind, false);
  assert.strictEqual(vm.needsPerm, false);
  assert.strictEqual(vm.writeFailed, false);
  assert.match(vm.status, /已直连/);
  assert.strictEqual(vm.filePath, 'D:\\工作空间\\1.02\\data.json');
});

test('dataFileVm：http 模式下写盘失败要明说"未写入"', () => {
  const vm = fsio.dataFileVm({ kind: 'http', lastWrite: { target: 'idb', error: 'HTTP_WRITE_500' } });
  assert.strictEqual(vm.writeFailed, true);
  assert.match(vm.status, /未写入/);
  assert.match(vm.hint, /写回/);
});
