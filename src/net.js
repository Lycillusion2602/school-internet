'use strict';
/**
 * 网络模块：连通性探测、本机 IP 识别、休眠唤醒检测
 */
const os = require('os');
const { request, sleep } = require('./util');

/**
 * 检测是否有真正的互联网（而非被 Portal 劫持）。
 * 判定：HTTP 204/200 且响应内容符合预期，且没有重定向到门户。
 * 返回 { online:boolean, detail }
 */
async function checkInternet(cfg) {
  const urls = (cfg.healthCheckUrls && cfg.healthCheckUrls.length)
    ? cfg.healthCheckUrls
    : ['http://connectivitycheck.gstatic.com/generate_204'];
  const timeout = (cfg.behavior && cfg.behavior.connectivityTimeoutMs) || 5000;
  const portalHost = cfg.portal && cfg.portal.host;

  for (const url of urls) {
    const r = await request(url, { timeout });
    if (!r.ok) continue;

    // 被重定向到门户 = 未认证
    if (r.status >= 300 && r.status < 400) {
      const loc = r.location || '';
      if (portalHost && loc.includes(portalHost)) return { online: false, detail: '重定向到门户: ' + loc };
      if (/^https?:\/\//.test(loc)) {
        // 跳到别处（也可能被劫持），继续试下一个
        continue;
      }
      continue;
    }

    if (r.status === 204) return { online: true, detail: '204 @ ' + url };
    if (r.status === 200) {
      const t = (r.text || '').trim();
      // connecttest.txt 期望内容 "Microsoft Connect Test"
      if (/connecttest\.com/.test(url)) {
        if (/Microsoft Connect Test/i.test(t)) return { online: true, detail: 'msft 200' };
        continue;
      }
      // apple hotspot 期望 <BODY>Success</BODY>
      if (/captive\.apple\.com/.test(url)) {
        if (/Success/i.test(t)) return { online: true, detail: 'apple 200' };
        continue;
      }
      // 其它 200 视为通
      if (t.length > 0) return { online: true, detail: '200 @ ' + url };
    }
  }
  return { online: false, detail: '所有健康检查均失败' };
}

/**
 * 识别本机在校园网上的 IPv4 地址。
 * 优先返回非内网/非虚拟网卡的 10.x 地址（校园网段）。
 */
function detectLocalIP(cfg) {
  const ifaces = os.networkInterfaces();
  const portalHost = (cfg.portal && cfg.portal.host) || '';
  const candidates = [];
  const VIRTUAL = /vmware|virtualbox|vethernet|hyper-v|loopback|radmin|tap|docker|wsl|bluetooth|wi-?fi direct/i;

  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of (list || [])) {
      const fam = typeof a.family === 'string' ? a.family : (a.family === 4 ? 'IPv4' : '');
      if (fam !== 'IPv4' || a.internal) continue;
      candidates.push({ name, address: a.address });
    }
  }
  if (!candidates.length) return '';

  // 优先 10.x（校园网典型网段）
  const ten = candidates.find(c => c.address.startsWith('10.'));
  if (ten) return ten.address;
  // 其次 172.16-31
  const priv = candidates.find(c => /^172\.(1[6-9]|2\d|3[01])\./.test(c.address) || c.address.startsWith('192.168.'));
  return (priv || candidates[0]).address;
}

/**
 * 休眠唤醒检测器。
 * 原理：setInterval 正常每 checkInterval 触发；若实际间隔远超阈值，
 * 说明系统经历了睡眠/挂起（定时器被冻结）。此时返回 true。
 */
class WakeDetector {
  constructor(thresholdSec = 90) {
    this.thresholdMs = thresholdSec * 1000;
    this.lastTick = Date.now();
  }
  /** 每次循环调用，返回自上次调用以来的实际间隔(ms) */
  tick() {
    const now = Date.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    return gap;
  }
  /** 该间隔是否意味着刚发生过休眠唤醒 */
  wasSuspended(gapMs) {
    return gapMs > this.thresholdMs;
  }
}

module.exports = { checkInternet, detectLocalIP, WakeDetector, sleep };
