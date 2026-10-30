/* 本地服务：静态文件 + data.json 读写接口（零依赖，只用 Node 内置模块）
 *
 * 为什么需要它：
 *   1) 浏览器在 file:// 页面里不允许网页调用 showOpenFilePicker / showSaveFilePicker
 *      （File System Access API 只在 http/https 下可用），双击 index.html 打开时
 *      数据只能存在浏览器里。
 *   2) 就算能调用，用户还得手动选一次文件，浏览器重启后授权会被收回，写盘失败时
 *      数据会悄悄留在浏览器里（"导入了几千条，重开又变回几百条"的老问题）。
 *
 * 所以这里再往前一步：服务自己接管 data.json，网页只管把 JSON 丢过来。
 *   GET  /api/data   → 返回 data.json 原文（文件不存在时给一份空结构）
 *   POST /api/data   → 整份覆盖写回 data.json（先写 .tmp 再改名，避免读到写了一半的文件）
 *   GET  /api/health → { ok, file, mtime, channels }，页面用它判断"这家服务支持直连"
 *
 * 安全：默认只监听 127.0.0.1，且对 /api/* 校验 Host 头（防 DNS rebinding），请求体上限 64MB。
 *      放到服务器上对外提供时，用环境变量放开（见 DEPLOY.md）：
 *        HOST=0.0.0.0            监听所有网卡（不配 nginx 才需要）
 *        ALLOWED_HOSTS=报价.example.com,192.168.1.10:8080   允许的 Host（=* 表示不校验）
 *        DATA_TOKEN=一串随机字符  要求 /api/* 带 Authorization: Bearer（页面地址加 ?token= 即可记住）
 *        DATA_FILE=/var/lib/logi/data.json   数据文件换个位置（默认与本文件同目录）
 *
 * 用法：双击「启动服务.bat」，或在本目录执行 `node serve.js`
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(ROOT, 'data.json');
const MAX_BODY = 64 * 1024 * 1024; // 9906 条渠道约 2.6MB，留足余量

// 允许的 Host（默认空 = 只认本机）。每项可写域名或域名:端口，`*` 表示全放开
function normHosts(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim().toLowerCase()).filter(Boolean);
  return String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
const ALLOWED_HOSTS = normHosts(process.env.ALLOWED_HOSTS);
const DATA_TOKEN = String(process.env.DATA_TOKEN || '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// 文件不存在时的兜底结构：与 fsio.defaultData() 同形，store.load 会补齐默认参数
function emptyData() {
  return { version: 1, settings: {}, channels: [], records: [] };
}

function countChannels(obj) {
  return (obj && Array.isArray(obj.channels)) ? obj.channels.length : 0;
}

function readDataFile(file) {
  const exists = fs.existsSync(file);
  if (!exists) return { data: emptyData(), mtime: 0, exists: false };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return { data: emptyData(), mtime: 0, exists: true };
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('DATA_FILE_BROKEN'); }
  const st = fs.statSync(file);
  return { data: data, mtime: st.mtimeMs, exists: true };
}

// 原子写：先写 data.json.tmp 再 rename 覆盖。
// 直接 writeFile 到 data.json 的话，正好在写入过程中刷新页面就可能读到半个 JSON。
function writeDataFile(file, obj) {
  const text = JSON.stringify(obj);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file); // Windows 上 rename 也可覆盖已存在的文件
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
    throw e;
  }
  const st = fs.statSync(file);
  return { bytes: Buffer.byteLength(text), mtime: st.mtimeMs };
}

function sendJson(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, extra || {}));
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('TOO_LARGE'), { code: 'TOO_LARGE' })); try { req.destroy(); } catch (e) {} return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 默认只接受本机 Host：否则恶意网页可以把自己解析到 127.0.0.1 来改写你的 data.json（DNS rebinding）。
// 部署到服务器后由 ALLOWED_HOSTS 放行自己的域名（见 DEPLOY.md）。
function isLocalHost(host) {
  if (!host) return true; // 老客户端可能不发 Host
  const h = String(host).toLowerCase();
  if (h.startsWith('[::1]') || h === '::1') return true;
  const name = h.split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '0.0.0.0';
}

function makeHostChecker(allowed) {
  const list = normHosts(allowed || []);
  if (list.indexOf('*') >= 0) return () => true;         // 显式全放开
  return function hostAllowed(host) {
    if (isLocalHost(host)) return true;
    if (!list.length) return false;
    const h = String(host || '').toLowerCase();
    const name = h.split(':')[0];
    return list.some((item) => item === h || item === name);
  };
}

// 可选的简易令牌：配了 DATA_TOKEN 就必须带 Authorization: Bearer xxx
function makeTokenChecker(token) {
  const want = String(token || '');
  if (!want) return () => true;
  return function tokenOk(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    if (!/^Bearer\s+/i.test(h)) return false;
    return h.replace(/^Bearer\s+/i, '').trim() === want;
  };
}

function createServer(rootDir, opts) {
  const o = opts || {};
  const root = path.resolve(rootDir || ROOT);
  // 默认数据文件跟服务同目录；可用 DATA_FILE 或 opts.dataFile 指到别处（如 /var/lib/logi）
  const dataFile = o.dataFile ? path.resolve(o.dataFile) : (root === path.resolve(ROOT) ? DATA_FILE : path.join(root, 'data.json'));
  const hostAllowed = makeHostChecker(o.allowedHosts != null ? o.allowedHosts : ALLOWED_HOSTS);
  const tokenOk = makeTokenChecker(o.token != null ? o.token : DATA_TOKEN);

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const pathname = decodeURIComponent(url.split('?')[0]) || '/';
    const isApi = pathname === '/api' || pathname.indexOf('/api/') === 0;

    // 只对接口校验 Host / 令牌：静态文件本来就该让所有人看，
    // 而 /api 能改数据，必须挡住"别的域名借浏览器的手打本机"。
    if (isApi) {
      if (!hostAllowed(req.headers.host)) {
        sendJson(res, 403, { ok: false, error: 'HOST_NOT_ALLOWED' });
        return;
      }
      if (!tokenOk(req)) {
        sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        return;
      }
    }

    /* ---------------- 数据接口 ---------------- */
    if (pathname === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'METHOD' }); return; }
      let info = { ok: true, file: dataFile, mtime: 0, channels: 0 };
      try {
        const r = readDataFile(dataFile);
        info.mtime = r.mtime;
        info.channels = countChannels(r.data);
      } catch (e) {
        info.ok = true; // 服务在就算可用，文件坏了由 GET /api/data 报错
        info.fileError = e.message;
      }
      sendJson(res, 200, info);
      return;
    }

    if (pathname === '/api/data') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        let r;
        try {
          r = readDataFile(dataFile);
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e.message });
          return;
        }
        const body = JSON.stringify(r.data);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
          'X-Data-File': encodeURIComponent(dataFile),
          'X-Data-Mtime': String(Math.round(r.mtime || 0)),
          'X-Data-Exists': r.exists ? '1' : '0'
        });
        res.end(body);
        return;
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        readBody(req, MAX_BODY).then((buf) => {
          let obj;
          try {
            obj = JSON.parse(buf.toString('utf8'));
          } catch (e) {
            sendJson(res, 400, { ok: false, error: 'BAD_JSON' });
            return;
          }
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            sendJson(res, 400, { ok: false, error: 'NOT_OBJECT' });
            return;
          }
          try {
            const w = writeDataFile(dataFile, obj);
            sendJson(res, 200, { ok: true, bytes: w.bytes, mtime: w.mtime, channels: countChannels(obj), file: dataFile });
          } catch (e) {
            sendJson(res, 500, { ok: false, error: e.message || 'WRITE_FAILED' });
          }
        }).catch((e) => {
          if (e && e.code === 'TOO_LARGE') sendJson(res, 413, { ok: false, error: 'TOO_LARGE' });
          else sendJson(res, 400, { ok: false, error: 'READ_BODY_FAILED' });
        });
        return;
      }
      sendJson(res, 405, { ok: false, error: 'METHOD' });
      return;
    }

    if (pathname.startsWith('/api/')) { sendJson(res, 404, { ok: false, error: 'NO_SUCH_API' }); return; }

    /* ---------------- 静态文件 ---------------- */
    let rel = pathname;
    if (rel === '/' || rel === '') rel = '/index.html';
    // 只允许读本目录内的文件
    const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 ' + rel);
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'   // 改完 js 刷新就生效，不用清缓存
      });
      res.end(buf);
    });
  });

  return server;
}

function start(port) {
  const p = port || PORT;
  const server = createServer(ROOT);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('端口 ' + p + ' 已被占用：可能已经在运行了，直接打开 http://localhost:' + p + '/');
    } else {
      console.log('启动失败：' + e.message);
    }
    try { process.stdin.pause(); } catch (err) {}
  });
  server.listen(p, HOST, () => {
    const localUrl = 'http://localhost:' + p + '/';
    console.log('');
    console.log('  国际物流报价助手 已启动');
    console.log('  监听：' + HOST + ':' + p + (HOST === '127.0.0.1' ? '（仅本机可访问）' : '（对外可访问）'));
    console.log('  地址：' + localUrl);
    console.log('  数据文件：' + DATA_FILE + '（网页会自动读写，无需选择文件）');
    console.log('  关掉这个窗口即停止服务。');
    // 放到服务器上跑（systemd / pm2 / 没有终端）时不要试图弹浏览器
    const interactive = process.stdout && process.stdout.isTTY && !process.env.NO_OPEN;
    if (HOST !== '127.0.0.1' && !DATA_TOKEN) {
      console.log('');
      console.log('  ! 正在对外监听但没设 DATA_TOKEN：任何人都能改写 data.json。');
      console.log('    建议 nginx 反代 + Basic Auth，或设 DATA_TOKEN 后从 /?token=xxx 打开一次。');
    }
    console.log('');
    if (!interactive) return;
    if (process.platform === 'win32') exec('start "" "' + localUrl + '"');
    else if (process.platform === 'darwin') exec('open "' + localUrl + '"');
    else exec('xdg-open "' + localUrl + '"');
  });
  return server;
}

if (require.main === module) start();

module.exports = { createServer, start, emptyData, readDataFile, writeDataFile, DATA_FILE, MAX_BODY };
