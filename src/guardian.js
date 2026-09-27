'use strict';
/**
 * 守护进程：周期性检测网络，掉线自动重连，休眠唤醒后立即恢复。
 */
const { checkInternet, detectLocalIP } = require('./net');
const { DrcomClient } = require('./drcom');
const { sleep } = require('./util');

class Guardian {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    this.client = new DrcomClient(cfg, logger);
    const b = cfg.behavior || {};
    this.intervalMs = (b.checkIntervalSec || 40) * 1000;
    this.maxRetries = b.maxRetriesPerCycle || 3;
    this.backoff = (b.retryBackoffSec && b.retryBackoffSec.length) ? b.retryBackoffSec : [2, 5, 10];
    // 休眠唤醒判定：正常每 intervalMs 检查一次，若单次"睡眠窗"远超阈值 = 系统经历过挂起
    this.detectWake = b.resumeWakeDetect !== false;
    this.wakeThresholdMs = (b.resumeGapThresholdSec || 90) * 1000;
    // 唤醒后的恢复窗口：给网络（尤其 WiFi 重关联）留足时间，避免刚唤醒就放弃
    this.wakeWindowMs = (b.wakeRecoverWindowSec || 90) * 1000;
    this.wakeGapMs = (b.wakeRecoverGapSec || 4) * 1000;
    this.running = false;
    this.stats = { checks: 0, relogins: 0, wakeRecover: 0, fails: 0, startedAt: Date.now() };
  }

  /** 确保在线：先探测，断了就登录；带重试。 */
  async ensureOnline(reason = '') {
    const net = await checkInternet(this.cfg);
    this.stats.checks++;

    if (net.online) {
      this.log.info(`✅ 网络正常 (${net.detail})${reason ? ' [' + reason + ']' : ''}`);
      return true;
    }

    this.log.warn(`⚠️  网络不通 (${net.detail})${reason ? ' [' + reason + ']' : ''} — 开始重连`);
    const ip = detectLocalIP(this.cfg);
    if (ip) this.log.info(`本机 IP: ${ip}`);

    for (let i = 0; i < this.maxRetries; i++) {
      const res = await this.client.login();
      if (res.needConfig) {
        this.log.error('❌ ' + res.msg);
        return false;
      }
      if (res.ok) {
        this.stats.relogins++;
        const tag = res.already ? '已在线' : '登录成功';
        this.log.info(`✅ ${tag}: ${res.msg}`);
        // 登录后二次确认
        await sleep(1200);
        const after = await checkInternet(this.cfg);
        if (after.online) {
          this.log.info(`✅ 认证后网络已通 (${after.detail})`);
          return true;
        }
        this.log.warn(`登录返回成功但网络仍不通，继续重试… (${after.detail})`);
      } else {
        this.log.warn(`登录失败(${i + 1}/${this.maxRetries}): ${res.msg}`);
      }
      if (i < this.maxRetries - 1) {
        const wait = this.backoff[Math.min(i, this.backoff.length - 1)];
        await sleep(wait * 1000);
      }
    }
    this.stats.fails++;
    this.log.error(`❌ 本轮重连失败（已重试 ${this.maxRetries} 次）`);
    return false;
  }

  /**
   * 休眠唤醒后的专用恢复流程。
   * 唤醒瞬间网卡（尤其 WiFi）往往还没重关联，"立刻检测"多半失败；
   * 因此在较长窗口内持续"检测→必要时认证→短暂等待"，直到网络真正恢复。
   */
  async recoverAfterWake(gapMs) {
    this.stats.wakeRecover++;
    const mins = Math.max(1, Math.round(gapMs / 60000));
    this.log.info(`💤➡️⏰ 检测到休眠唤醒（睡眠约 ${mins} 分钟），开始恢复…`);

    const deadline = Date.now() + this.wakeWindowMs;
    let attempt = 0;
    while (Date.now() < deadline && this.running) {
      attempt++;
      const net = await checkInternet(this.cfg);
      this.stats.checks++;
      if (net.online) {
        this.log.info(`✅ 唤醒后网络已恢复 (${net.detail})，第 ${attempt} 次探测`);
        return true;
      }
      this.log.info(`唤醒恢复第 ${attempt} 次：网络未通（${net.detail}），尝试认证…`);
      const res = await this.client.login();
      if (res.needConfig) {
        this.log.error('❌ ' + res.msg);
        return false;
      }
      if (res.ok) {
        this.stats.relogins++;
        this.log.info(`✅ ${res.already ? '会话仍在线' : '重新认证成功'}: ${res.msg}`);
        await sleep(1500);
        const after = await checkInternet(this.cfg);
        if (after.online) {
          this.log.info(`✅ 唤醒恢复完成 (${after.detail})`);
          return true;
        }
      } else {
        this.log.warn(`认证未成功：${res.msg}`);
      }
      await sleep(this.wakeGapMs);
    }

    this.log.warn('唤醒恢复窗口内仍未成功，转常规重连流程');
    return this.ensureOnline('唤醒后常规重连');
  }

  /** 主循环 */
  async run() {
    this.running = true;
    this.log.info('🚀 守护进程启动');
    this.log.info(`   门户: ${this.cfg.portal.host} | 账号: ${this.client.fullAccount()} | 检测间隔: ${this.intervalMs / 1000}s`);
    this.log.info(`   休眠唤醒检测: ${this.detectWake ? '开' : '关'} (阈值 ${this.wakeThresholdMs / 1000}s，恢复窗口 ${this.wakeWindowMs / 1000}s)`);

    // 启动即检查一次
    await this.ensureOnline('启动检查');

    while (this.running) {
      // 只计量"睡眠窗"本身：t0 在 sleep 前取，醒来后立即比较，
      // 这样不含认证耗时，避免把耗时误判成休眠唤醒。
      const t0 = Date.now();
      await sleep(this.intervalMs);
      if (!this.running) break;

      const gap = Date.now() - t0;
      if (this.detectWake && gap > this.wakeThresholdMs) {
        await this.recoverAfterWake(gap);
        continue;
      }
      await this.ensureOnline();
    }
    this.log.info('🛑 守护进程停止');
  }

  stop() {
    this.running = false;
  }
}

module.exports = { Guardian };
