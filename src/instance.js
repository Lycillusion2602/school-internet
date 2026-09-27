'use strict';
/**
 * instance.js — 守护进程单实例锁
 *
 * 为什么单独成模块：判活逻辑要能在不启动守护进程的前提下被测试。
 *
 * 判定规则（2026-09-22 重写）
 *   只有「锁新鲜」+「PID 真实存活」+「确实是 node 跑着我们的 daemon」三条同时成立，
 *   才认定有实例占用并拒绝启动；任一条不成立即接管锁继续启动。
 *
 *   改前只看锁文件 mtime 是否新于 staleMs（默认 100s）。守护进程若在这段心跳窗口内
 *   硬死（断电、被 taskkill /F，都不走 exit 清理所以锁不删），紧接着被登录触发的新实例
 *   会因为「锁还挺新鲜」自认为重复启动而退出码 3，结果两边都没有守护进程 ——
 *   2026-09-22 18:08 停摆、18:09:28 任务启动又被拒，正是这个盲区。
 *
 * 锁文件字段
 *   { pid, started }  —— started 是本次守护进程的真正启动时刻，心跳只刷新文件 mtime，
 *   不再重写 started（改前心跳用 Date.now() 重写整个 JSON，导致 started 恒等于最后心跳时刻）。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const GBK = new TextDecoder('gbk');
const LOCK_FILE = 'daemon.lock';

function lockPath(root) { return path.join(root, 'logs', LOCK_FILE); }

function readLock(p, now = Date.now()) {
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
  if (!j || !j.pid) return null;
  let mtime = null;
  try { mtime = fs.statSync(p).mtimeMs; } catch (_) { return null; }
  return { pid: Number(j.pid) || null, started: Number(j.started) || null, mtime, ageMs: now - mtime };
}

/** 写锁：started 固定为真正的启动时刻，心跳反复调用也只会刷新 mtime */
function writeLock(p, pid, started) {
  try { fs.writeFileSync(p, JSON.stringify({ pid, started }), 'utf8'); return true; } catch (_) { return false; }
}

function clearLock(p) {
  try { fs.unlinkSync(p); return true; } catch (_) { return false; }
}

function execGbk(cmd) {
  try {
    return GBK.decode(cp.execSync(cmd, {
      encoding: 'buffer', timeout: 15000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).trim();
  } catch (e) {
    // tasklist 查无结果时会以非 0 退出并往 stdout 写提示，不能当查询失败
    if (e && e.stdout) { try { return GBK.decode(e.stdout).trim(); } catch (_) {} }
    return null;
  }
}

/**
 * 廉价探测（tasklist，约 10ms）：进程是否存在、映像名是什么。
 * 返回 { probed:false } 表示查询本身失败 —— 此时不可据此判定进程不存在。
 */
function probePid(pid) {
  if (!pid || !Number.isFinite(pid)) return { probed: false };
  const out = execGbk(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
  if (!out) return { probed: false };
  const m = out.match(/^"([^"]+)","(\d+)"/);
  if (m && Number(m[2]) === Number(pid)) return { probed: true, exists: true, name: m[1].toLowerCase() };
  // 「信息: 没有运行的任务匹配指定标准」/「No Running tasks...」
  if (/没有运行的任务|No Running tasks|no task/i.test(out)) return { probed: true, exists: false, name: null };
  return { probed: false };
}

/** 取命令行（PowerShell CIM，约 470ms，只在即将拒绝启动时才调） */
function commandLineOf(pid) {
  const out = execGbk(
    `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine)"`);
  if (!out) return null;
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || null;
}

/** 命令行看起来像是本项目的守护进程？ */
function looksLikeDaemonCmd(cmd) {
  return !!cmd && /cli\.js/i.test(cmd) && /\bdaemon\b/i.test(cmd);
}

/** 从命令行里抠出 cli.js 的绝对路径，据此判断锁主属于哪个安装目录 */
function rootOfCmd(cmd) {
  if (!cmd) return null;
  const m = cmd.match(/"?([A-Za-z]:[\\/][^"]*?cli\.js)"?/i);
  if (!m) return null;
  try { return path.resolve(path.dirname(path.dirname(m[1]))).toLowerCase(); } catch (_) { return null; }
}

function fmtAge(ms) {
  if (ms === null || ms === undefined) return '未知';
  if (ms < 1000) return '不足 1 秒';
  if (ms < 60000) return (ms / 1000).toFixed(0) + ' 秒';
  return (ms / 60000).toFixed(1) + ' 分钟';
}

/**
 * 核心判定。probe/procName/cmdline 可注入，便于单测。
 * @returns {{hold:boolean, code:string, why:string, note?:string, pid?:number}}
 */
function evaluate(lock, opts = {}) {
  const { staleMs = 100000, now = Date.now(), probe = probePid, cmdlineOf = commandLineOf, root = null } = opts;
  if (!lock || !lock.pid) return { hold: false, code: 'NO_LOCK', why: '没有锁文件，可直接启动' };

  const info = probe(lock.pid);
  if (info.probed && !info.exists) {
    return { hold: false, code: 'DEAD_PID', pid: lock.pid, why: `PID ${lock.pid} 已不存在，锁是残留（最后心跳 ${fmtAge(lock.ageMs)}前）` };
  }
  if (info.probed && info.name && info.name !== 'node.exe') {
    return { hold: false, code: 'PID_REUSED', pid: lock.pid, why: `PID ${lock.pid} 已被 ${info.name} 占用，不是守护进程` };
  }
  if (lock.ageMs !== null && lock.ageMs >= staleMs) {
    return { hold: false, code: 'STALE', pid: lock.pid, why: `锁已 ${fmtAge(lock.ageMs)} 未刷新（阈值 ${fmtAge(staleMs)}），视为陈旧` };
  }

  // 走到这里：活着 + 是 node + 锁新鲜。再核一次身份，确认是「我们的」daemon
  const cmd = cmdlineOf(lock.pid);
  if (cmd && !looksLikeDaemonCmd(cmd)) {
    return { hold: false, code: 'NOT_DAEMON', pid: lock.pid, why: `PID ${lock.pid} 是别的 node 进程，不是守护进程` };
  }
  const facts = [];
  if (info.probed && info.exists) facts.push('进程存活');
  else facts.push('进程存在性未能核实');
  facts.push(`心跳 ${fmtAge(lock.ageMs)}前`);
  facts.push(cmd ? '命令行已核对' : '命令行未能核实');
  const out = { hold: true, code: 'HELD', pid: lock.pid, why: `PID ${lock.pid} ${facts.join('、')}` };
  if (root) {
    const owner = rootOfCmd(cmd);
    if (owner && owner !== path.resolve(root).toLowerCase()) {
      out.note = `该实例来自另一份安装目录 ${owner}，与本目录不同；双份同时跑会互相抢认证会话`;
    }
  }
  return out;
}

/** 给 status 用的快速判活：只查锁 + tasklist，不碰 PowerShell */
function daemonStatus(lock, opts = {}) {
  const { staleMs = 100000, now = Date.now(), probe = probePid } = opts;
  if (!lock || !lock.pid) return { running: false, text: '❌ 未运行（没有实例锁）' };
  const info = probe(lock.pid);
  if (info.probed && !info.exists) {
    return { running: false, text: `❌ 未运行（PID ${lock.pid} 已死，${fmtAge(lock.ageMs)}前的残留锁）` };
  }
  if (lock.ageMs !== null && lock.ageMs >= staleMs) {
    return { running: false, text: `❌ 未运行（锁 ${fmtAge(lock.ageMs)}未刷新，PID ${lock.pid} 状态未知）` };
  }
  if (info.probed && info.name && info.name !== 'node.exe') {
    return { running: false, text: `❌ 未运行（锁里的 PID ${lock.pid} 已是 ${info.name}）` };
  }
  const started = lock.started ? `，已跑 ${fmtAge(now - lock.started)}` : '';
  return { running: true, text: `✅ 运行中 PID=${lock.pid}，心跳 ${fmtAge(lock.ageMs)}前${started}` };
}

module.exports = {
  LOCK_FILE, lockPath, readLock, writeLock, clearLock,
  probePid, commandLineOf, looksLikeDaemonCmd, rootOfCmd,
  evaluate, daemonStatus, fmtAge,
};
