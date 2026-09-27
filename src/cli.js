#!/usr/bin/env node
'use strict';
/**
 * schoolnet — 校园网自动认证 CLI
 *
 *   node src/cli.js status    查看当前在线状态
 *   node src/cli.js login     立即登录
 *   node src/cli.js logout    登出
 *   node src/cli.js once      检测+按需登录（跑一次，适合放任务计划）
 *   node src/cli.js daemon    常驻守护（掉线自动重连 + 休眠唤醒恢复）
 *   node src/cli.js ip        显示识别到的本机 IP
 */
const fs = require('fs');
const path = require('path');
const { DrcomClient } = require('./drcom');
const { checkInternet, detectLocalIP } = require('./net');
const { Guardian } = require('./guardian');
const { createLogger, pruneLogs } = require('./util');
const inst = require('./instance');

const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) {
    console.error('找不到 config.json：' + p);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeLogger(cfg) {
  const dir = path.resolve(ROOT, (cfg.log && cfg.log.dir) || './logs');
  const logger = createLogger(dir);
  try { pruneLogs(dir, (cfg.log && cfg.log.maxDays) || 14); } catch (_) {}
  return logger;
}

/**
 * 读取守护锁文件，返回 { pid, started, mtime, ageMs } 或 null。
 * started 是守护进程真正的启动时刻（心跳只刷新 mtime，不再改写它）。
 */
function readLock(lockPath) {
  return inst.readLock(lockPath);
}

function staleMsFor(cfg) {
  // 心跳间隔 = max(10s, 检测周期×0.5)，阈值留 2.5 个周期的余量
  const intervalSec = (cfg.behavior && cfg.behavior.checkIntervalSec) || 40;
  return Math.max(60000, intervalSec * 2500);
}

async function main() {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  const cfg = loadConfig();
  const logger = makeLogger(cfg);
  const client = new DrcomClient(cfg, logger);

  switch (cmd) {
    case 'status': {
      const net = await checkInternet(cfg);
      const st = await client.getStatus();
      console.log('=== 校园网状态 ===');
      console.log('外网连通  :', net.online ? '✅ 正常' : '❌ 不通', '(' + net.detail + ')');
      console.log('认证会话  :', st.online ? '✅ 在线' : '❌ 离线', st.uid ? '账号=' + st.uid : '');
      console.log('本机 IP   :', detectLocalIP(cfg) || '(未识别)');
      console.log('门户      :', cfg.portal.host + ':' + cfg.portal.eportalPort);
      // 守护进程在不在跑单独报出来：以前 status 只看网络，掉线后没人守护也看不出来
      const ds = inst.daemonStatus(readLock(inst.lockPath(ROOT)), { staleMs: staleMsFor(cfg) });
      console.log('守护进程  :', ds.text);
      process.exitCode = net.online && st.online ? 0 : 1;
      break;
    }
    case 'login': {
      const res = await client.login();
      if (res.needConfig) { console.log('❌ ' + res.msg); process.exitCode = 2; break; }
      console.log(res.ok ? (res.already ? '✅ 已在线' : '✅ 登录成功') : '❌ 登录失败', '—', res.msg);
      process.exitCode = res.ok ? 0 : 1;
      break;
    }
    case 'logout': {
      const res = await client.logout();
      console.log(res.ok ? '✅ 已登出' : '❌ 登出失败', '—', res.msg);
      process.exitCode = res.ok ? 0 : 1;
      break;
    }
    case 'ip': {
      console.log(detectLocalIP(cfg) || '(未识别)');
      break;
    }
    case 'once': {
      const g = new Guardian(cfg, logger);
      const ok = await g.ensureOnline('手动 once');
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case 'daemon': {
      // 单实例锁：防止开机自启与手动启动同时拉起多个守护进程。
      // 判活规则见 src/instance.js —— 锁新鲜只是必要条件之一，还必须确认锁里的 PID
      // 真活着、且确实是 node 在跑我们的 daemon，否则一律接管。
      const lockPath = inst.lockPath(ROOT);
      const existing = readLock(lockPath);
      const verdict = inst.evaluate(existing, { staleMs: staleMsFor(cfg), root: ROOT });

      if (verdict.hold) {
        console.log(`⚠️  已有守护进程在运行（${verdict.why}），本次不再重复启动。`);
        if (verdict.note) console.log('   ⚠️  ' + verdict.note);
        console.log(`   要重启：先 taskkill /F /PID ${verdict.pid} 再 schtasks /run /tn SchoolNet-AutoAuth。`);
        console.log('   （schtasks /end 停不掉它——只解除任务跟踪，node 进程照跑；硬杀残留的锁会被新判定识别并接管）');
        process.exitCode = 3;
        break;
      }
      if (existing) console.log(`[..] 锁存在但占用无效（${verdict.why}），接管启动。`);

      fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
      // started 只记一次真正的启动时刻；心跳反复重写只会刷新文件 mtime
      const startedAt = Date.now();
      const writeLock = () => inst.writeLock(lockPath, process.pid, startedAt);
      writeLock();

      // 定期刷新锁文件心跳（独立于主循环，避免主循环卡住时不刷新）
      const intervalSec = (cfg.behavior && cfg.behavior.checkIntervalSec) || 40;
      const heartbeat = setInterval(writeLock, Math.max(10000, intervalSec * 500));
      heartbeat.unref && heartbeat.unref();

      const g = new Guardian(cfg, logger);
      const cleanup = () => { try { clearInterval(heartbeat); inst.clearLock(lockPath); } catch (_) {} };
      const shutdown = () => { logger.info('收到退出信号'); g.stop(); cleanup(); process.exit(0); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.on('exit', cleanup);
      await g.run();
      cleanup();
      break;
    }
    default:
      console.log('未知命令: ' + cmd);
      console.log('可用: status | login | logout | once | daemon | ip');
      process.exitCode = 64;
  }
}

main().catch((e) => {
  console.error('运行出错:', e && e.stack || e);
  process.exit(1);
});

// 兜底：未捕获异常/未处理 Promise 也写日志，避免后台静默崩溃无从排查
process.on('uncaughtException', (e) => {
  try { console.error('[FATAL] uncaughtException:', e && e.stack || e); } catch (_) {}
});
process.on('unhandledRejection', (e) => {
  try { console.error('[FATAL] unhandledRejection:', e && e.stack || e); } catch (_) {}
});
