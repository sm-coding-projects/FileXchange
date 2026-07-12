#!/usr/bin/env node
/**
 * FileXchange — LAN file sharing server.
 * Zero dependencies: run with `node server.js` and open the printed URL
 * from any device on the same network.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_FILE = path.join(ROOT, 'files.json');
const SWEEP_INTERVAL_MS = 30 * 1000;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** @type {{id:string,name:string,size:number,uploadedAt:number,expiresAt:number|null}[]} */
let files = [];
try {
  files = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  files = files.filter(f => fs.existsSync(path.join(UPLOAD_DIR, f.id)));
} catch (e) {
  files = [];
}

function persist() {
  fs.writeFile(DATA_FILE, JSON.stringify(files, null, 2), () => {});
}

function lanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function sweepExpired() {
  const now = Date.now();
  const expired = files.filter(f => f.expiresAt != null && f.expiresAt <= now);
  if (!expired.length) return;
  files = files.filter(f => !expired.includes(f));
  for (const f of expired) fs.unlink(path.join(UPLOAD_DIR, f.id), () => {});
  persist();
}
setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleUpload(req, res, query) {
  const name = (query.get('name') || 'file').replace(/[\r\n]/g, ' ').slice(0, 255);
  const expiresIn = query.get('expiresIn');
  const ms = expiresIn && expiresIn !== 'never' ? Number(expiresIn) : null;
  const id = crypto.randomBytes(8).toString('hex');
  const dest = path.join(UPLOAD_DIR, id);
  const out = fs.createWriteStream(dest);
  let size = 0;
  let aborted = false;

  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES && !aborted) {
      aborted = true;
      out.destroy();
      fs.unlink(dest, () => {});
      sendJSON(res, 413, { error: 'File too large' });
      req.destroy();
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    const meta = {
      id,
      name,
      size,
      uploadedAt: Date.now(),
      expiresAt: ms && ms > 0 ? Date.now() + ms : null,
    };
    files.unshift(meta);
    persist();
    sendJSON(res, 201, meta);
  });
  out.on('error', () => {
    fs.unlink(dest, () => {});
    if (!aborted) sendJSON(res, 500, { error: 'Write failed' });
  });
  req.on('aborted', () => {
    aborted = true;
    out.destroy();
    fs.unlink(dest, () => {});
  });
}

function handleDownload(req, res, id) {
  const f = files.find(x => x.id === id);
  if (!f) { res.writeHead(404); res.end('Not found'); return; }
  if (f.expiresAt != null && f.expiresAt <= Date.now()) {
    res.writeHead(410); res.end('This file has expired'); return;
  }
  const filePath = path.join(UPLOAD_DIR, f.id);
  fs.stat(filePath, (err, stat) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ascii = f.name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/state' && req.method === 'GET') {
    return sendJSON(res, 200, {
      host: `${lanAddress()}:${PORT}`,
      now: Date.now(),
      files,
    });
  }
  if (p === '/api/upload' && req.method === 'POST') {
    return handleUpload(req, res, url.searchParams);
  }
  const delMatch = p.match(/^\/api\/files\/([a-f0-9]{16})$/);
  if (delMatch && req.method === 'DELETE') {
    const id = delMatch[1];
    const before = files.length;
    files = files.filter(f => f.id !== id);
    if (files.length === before) return sendJSON(res, 404, { error: 'Not found' });
    fs.unlink(path.join(UPLOAD_DIR, id), () => {});
    persist();
    return sendJSON(res, 200, { ok: true });
  }
  const dlMatch = p.match(/^\/f\/([a-f0-9]{16})$/);
  if (dlMatch && req.method === 'GET') {
    return handleDownload(req, res, dlMatch[1]);
  }
  if (req.method === 'GET') return serveStatic(res, p);
  res.writeHead(405); res.end('Method not allowed');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('FileXchange running:');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${lanAddress()}:${PORT}`);
});
