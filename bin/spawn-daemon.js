'use strict';
/**
 * 后台启动守护进程（分离式）。
 * 用法: node bin/spawn-daemon.js
 * 让 daemon 脱离当前 shell 常驻运行，stdout/stderr 写入 logs\daemon.out.log。
 * 立即返回，不阻塞。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const LOG_DIR = path.join(ROOT, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const outLog = path.join(LOG_DIR, 'daemon.out.log');
const errLog = path.join(LOG_DIR, 'daemon.err.log');

const out = fs.openSync(outLog, 'a');
const err = fs.openSync(errLog, 'a');

const child = spawn(process.execPath, [CLI, 'daemon'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', out, err],
  windowsHide: true,
});

child.unref();

// 不单独写 PID 文件：守护进程自身的 daemon.lock 已是权威的实例记录。
console.log('daemon 已后台启动，PID=' + child.pid);
console.log('日志: ' + outLog);
