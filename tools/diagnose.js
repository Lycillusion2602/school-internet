#!/usr/bin/env node
'use strict';
/**
 * 网络与门户诊断工具
 *   node tools/diagnose.js
 * 逐项检查：网卡、门户可达性、各认证接口、外网连通性，输出诊断报告。
 * 用于排障——当自动登录失败时，先跑这个看是哪一环出问题。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { request, jsonp } = require('../src/util');
const { checkInternet, detectLocalIP } = require('../src/net');
const { DrcomClient } = require('../src/drcom');

const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const line = (s) => console.log(s);
const ok = (s) => console.log('  \u2705 ' + s);
const bad = (s) => console.log('  \u274c ' + s);
const warn = (s) => console.log('  \u26a0\ufe0f  ' + s);

(async () => {
  line('================ 校园网诊断报告 ================');
  line('时间: ' + new Date().toLocaleString('zh-CN'));
  line('');

  // 1. 网卡
  line('【1】网络接口');
  const ifaces = os.networkInterfaces();
  const VIRTUAL = /vmware|virtualbox|vethernet|hyper-v|loopback|radmin|tap|docker|wsl|bluetooth|wi-?fi direct/i;
  let hasCampus = false;
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of (list || [])) {
      const fam = typeof a.family === 'string' ? a.family : (a.family === 4 ? 'IPv4' : '');
      if (fam !== 'IPv4' || a.internal) continue;
      const virtual = VIRTUAL.test(name);
      if (!virtual && a.address.startsWith('10.')) hasCampus = true;
      line(`  ${virtual ? '(虚拟) ' : ''}${name}: ${a.address}`);
    }
  }
  const myIp = detectLocalIP(cfg);
  hasCampus ? ok('识别到校园网段 IP: ' + myIp) : warn('未识别到 10.x 校园网 IP（可能不在校园网内）');
  line('');

  // 2. 门户可达性
  const portalHost = cfg.portal.host;
  const eport = cfg.portal.eportalPort;
  line('【2】门户可达性');
  const pRoot = await request(`http://${portalHost}/a79.htm`, { timeout: 5000 });
  if (pRoot.ok) ok(`门户 ${portalHost}:80 可达 (HTTP ${pRoot.status}, server=${pRoot.headers.server || '-'})`);
  else bad(`门户 ${portalHost}:80 不可达: ${pRoot.error}`);

  const p801 = await request(`http://${portalHost}:${eport}/eportal/`, { timeout: 5000 });
  if (p801.ok) ok(`ePortal ${portalHost}:${eport} 可达 (HTTP ${p801.status})`);
  else bad(`ePortal ${portalHost}:${eport} 不可达: ${p801.error}`);
  line('');

  // 3. 状态接口
  line('【3】认证状态接口');
  const client = new DrcomClient(cfg, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  const st = await client.getStatus();
  if (st.raw) {
    ok(`账号: ${st.uid || '(未知)'}`);
    ok(`状态: ${st.online ? '在线' : '离线'}`);
    if (st.raw.oltime !== undefined) ok(`在线时长: ${Math.round((st.raw.oltime || 0) / 60)} 分钟`);
  } else {
    bad('状态接口无响应: ' + (st.error || ''));
  }
  line('');

  // 4. 外网连通
  line('【4】外网连通性');
  const net = await checkInternet(cfg);
  net.online ? ok('外网可达 — ' + net.detail) : bad('外网不可达 — ' + net.detail);
  line('');

  // 5. 登录接口格式自检（用空密码，只看是否返回"参数格式"类错误）
  line('【5】登录接口格式自检');
  const testUrl = `http://${portalHost}:${eport}/eportal/?c=Portal&a=login&callback=dr1003` +
    `&login_method=1&user_account=__selftest__&user_password=__x__` +
    `&wlan_user_ip=${encodeURIComponent(myIp)}&wlan_user_ipv6=&wlan_user_mac=000000000000` +
    `&wlan_ac_ip=&wlan_ac_name=&jsVersion=4.2.1&v=${Math.floor(Math.random() * 9000 + 1000)}&lang=zh`;
  const t = await request(testUrl, { timeout: 6000 });
  if (t.ok) {
    const j = jsonp(t.text) || {};
    if (/特殊字符/.test(j.msg || '')) {
      bad('接口返回"带有特殊字符的参数" — URL 编码有问题，需排查');
    } else if (j.result !== undefined) {
      ok('登录接口正常响应: ' + JSON.stringify(j));
    } else {
      warn('登录接口响应异常: ' + (t.text || '').slice(0, 150));
    }
  } else {
    bad('登录接口不可达: ' + t.error);
  }
  line('');

  // 6. 配置检查
  line('【6】配置检查');
  const pass = cfg.account.password;
  if (!pass || pass === 'PASTE_YOUR_PASSWORD_HERE') warn('config.json 中 password 尚未填写 — 无法执行自动登录');
  else ok('password 已配置');
  ok('账号: ' + (new DrcomClient(cfg, {}).fullAccount()));
  ok('检测间隔: ' + cfg.behavior.checkIntervalSec + 's');
  line('');
  line('================ 诊断结束 ================');
})().catch(e => { console.error('诊断出错:', e); process.exit(1); });
