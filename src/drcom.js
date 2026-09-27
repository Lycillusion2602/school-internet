'use strict';
/**
 * Dr.COM（城市热点）Portal 协议模块
 * ------------------------------------------------------------------
 * 本机实测确认的接口（2026-09 校园网）：
 *   状态查询: GET  http://10.10.90.2/drcom/chkstatus?callback=dr1
 *   登录:     GET  http://10.10.90.2:801/eportal/?c=Portal&a=login
 *   登出:     GET  http://10.10.90.2:801/eportal/?c=Portal&a=logout
 * 状态接口返回 JSONP：
 *   dr1({"result":1,"uid":"240xxxxxx@dx","v46ip":"10.16.41.x", ...})
 *   result=1 在线，0 离线
 * 登录接口返回 JSONP：
 *   dr1003({"result":1,"msg":"...","ret_code":...})
 *   在线/已在线(ret_code=2) 都按"已连通"处理
 */
const { request, jsonp } = require('./util');
const { detectLocalIP } = require('./net');

const SERVICE_SUFFIX = {
  campus: '',      // 校园用户
  dx: '@dx',       // 电信
  lt: '@lt',       // 联通
  yd: '',          // 移动
};

class DrcomClient {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    const p = cfg.portal || {};
    this.host = p.host || '10.10.90.2';
    this.eportalPort = p.eportalPort || 801;
    this.legacyPort = p.legacyPort || 80;
    this.acct = cfg.account || {};
  }

  base(port) {
    return `http://${this.host}${port ? ':' + port : ''}`;
  }

  /** 组装完整账号（带运营商后缀） */
  fullAccount() {
    let user = String(this.acct.username || '').trim();
    // 如果用户名已自带 @ 后缀，不再追加
    if (user.includes('@')) return user;
    const svc = String(this.acct.service || 'campus').toLowerCase();
    const suffix = SERVICE_SUFFIX[svc] !== undefined ? SERVICE_SUFFIX[svc] : (this.acct.service || '');
    return user + suffix;
  }

  /** 查询在线状态。返回 { online:boolean, uid, raw } */
  async getStatus() {
    const url = `${this.base()}/drcom/chkstatus?callback=dr1&_=${Date.now()}`;
    const r = await request(url, { timeout: 5000 });
    if (!r.ok) return { online: false, error: r.error, raw: null };
    const j = jsonp(r.text);
    if (!j) return { online: false, error: 'BAD_JSONP', raw: r.text.slice(0, 120) };
    return { online: j.result === 1, uid: j.uid || '', raw: j };
  }

  /** 登录。返回 { ok, already, msg, ret_code, raw } */
  async login() {
    const user = this.fullAccount();
    const pass = String(this.acct.password || '');
    if (!pass || pass === 'PASTE_YOUR_PASSWORD_HERE') {
      return { ok: false, msg: '密码未配置，请编辑 config.json 的 account.password', needConfig: true };
    }
    const ip = this.resolveIP();
    const common = [
      'callback=dr1003',
      'login_method=1',
      'user_account=' + encodeURIComponent(user),
      'user_password=' + encodeURIComponent(pass),
      'wlan_user_ip=' + encodeURIComponent(ip),
      'wlan_user_ipv6=',
      'wlan_user_mac=000000000000',
      'wlan_ac_ip=',
      'wlan_ac_name=',
      'jsVersion=4.2.1',
      'v=' + Math.floor(Math.random() * 9000 + 1000),
      'lang=zh',
    ].join('&');
    const url = `${this.base(this.eportalPort)}/eportal/?c=Portal&a=login&${common}`;
    this.log.debug('login -> ' + url.replace(encodeURIComponent(pass), '***'));

    const r = await request(url, { timeout: 8000 });
    if (!r.ok) return { ok: false, msg: '网络请求失败: ' + r.error };

    const j = jsonp(r.text) || {};
    // ret_code: 2 = 已在线；result=1 = 成功
    const already = j.ret_code === 2 || /已经在线/.test(j.msg || '');
    const ok = j.result === 1 || j.result === '1' || already;
    return { ok, already, msg: j.msg || '(无消息)', ret_code: j.ret_code, raw: j };
  }

  /** 登出 */
  async logout() {
    const ip = this.resolveIP();
    const url = `${this.base(this.eportalPort)}/eportal/?c=Portal&a=logout&callback=dr1003` +
      `&login_method=1&user_account=drcom&user_password=drcom&ac_logout=0` +
      `&register_mode=1&wlan_user_ip=${encodeURIComponent(ip)}` +
      `&wlan_user_ipv6=&wlan_user_mac=000000000000&wlan_ac_ip=&wlan_ac_name=&jsVersion=4.2.1&v=${Date.now()}`;
    const r = await request(url, { timeout: 8000 });
    if (!r.ok) return { ok: false, msg: '网络请求失败: ' + r.error };
    const j = jsonp(r.text) || {};
    return { ok: j.result === 1 || j.result === '1', msg: j.msg || '(无消息)', raw: j };
  }

  /** 取用于认证的本机 IP：配置里固定则用固定，否则自动识别 */
  resolveIP() {
    const cfgIp = this.acct.ip;
    if (cfgIp && cfgIp !== 'auto') return cfgIp;
    return detectLocalIP(this.cfg) || '';
  }
}

module.exports = { DrcomClient, SERVICE_SUFFIX };
