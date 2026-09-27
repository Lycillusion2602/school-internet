'use strict';
/**
 * 通用工具：日志、HTTP 请求、编码、休眠检测
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const GBK = new TextDecoder('gbk');
const UTF8 = new TextDecoder('utf-8');

/** 简易 GBK/UTF-8 感知解码 */
function decode(buf, charset) {
  const cs = String(charset || '').toLowerCase();
  try {
    if (cs.includes('gbk') || cs.includes('gb2312') || cs.includes('gb18030')) {
      return GBK.decode(buf);
    }
  } catch (_) { /* fallthrough */ }
  return UTF8.decode(buf);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 发一个 GET/POST 请求，返回 { status, headers, text, json }。
 * 关键点：手工处理 gzip、超时、重定向不自动跟随（避免被门户劫持后死循环）。
 */
function request(urlStr, opts = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) {
      return resolve({ ok: false, error: 'BAD_URL:' + urlStr });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const method = opts.method || 'GET';
    const headers = Object.assign({
      'User-Agent': opts.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, opts.headers || {});

    let body = null;
    if (opts.form) {
      body = Object.keys(opts.form).map(k =>
        encodeURIComponent(k) + '=' + encodeURIComponent(opts.form[k])).join('&');
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['Content-Length'] = Buffer.byteLength(body);
    } else if (typeof opts.body === 'string') {
      body = opts.body;
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      timeout: opts.timeout || 6000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        // 手工 gzip 解压
        if (res.headers['content-encoding'] === 'gzip') {
          try { raw = require('zlib').gunzipSync(raw); } catch (_) {}
        } else if (res.headers['content-encoding'] === 'deflate') {
          try { raw = require('zlib').inflateSync(raw); } catch (_) {}
        }
        const text = decode(raw, res.headers['content-type']);
        let json = null;
        try { json = JSON.parse(text.trim()); } catch (_) {}
        resolve({
          ok: true,
          status: res.statusCode,
          headers: res.headers,
          location: res.headers['location'] || '',
          text,
          json,
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    if (body) req.write(body);
    req.end();
  });
}

/** 从 JSONP 文本里抠出 JSON 对象 */
function jsonp(text) {
  if (!text) return null;
  const m = text.match(/^[^(]*\((.*)\)\s*;?\s*$/s) || text.match(/\{.*\}/s);
  if (!m) return null;
  try { return JSON.parse(m[1] !== undefined ? m[1] : m[0]); } catch (_) { return null; }
}

/** 日志器 */
function createLogger(logDir) {
  if (logDir && !fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
  // 日志文件名用「本地」日期，与日志行时间保持一致（避免 UTC 跨日错位）
  const localDate = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const fileOf = () => path.join(logDir || '.', `schoolnet-${localDate()}.log`);

  function write(level, msg) {
    const line = `[${stamp()}] [${level}] ${msg}`;
    if (level === 'ERROR') console.error(line); else console.log(line);
    if (logDir) {
      try { fs.appendFileSync(fileOf(), line + '\n', 'utf8'); } catch (_) {}
    }
  }
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    debug: (m) => { if (process.env.SCHOOLNET_DEBUG === '1') write('DEBUG', m); },
  };
}

/** 清理超过 maxDays 的旧日志 */
function pruneLogs(logDir, maxDays) {
  if (!logDir || !fs.existsSync(logDir)) return;
  const cutoff = Date.now() - maxDays * 86400000;
  for (const f of fs.readdirSync(logDir)) {
    if (!f.startsWith('schoolnet-') || !f.endsWith('.log')) continue;
    const p = path.join(logDir, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (_) {}
  }
}

module.exports = { decode, sleep, request, jsonp, createLogger, pruneLogs };
