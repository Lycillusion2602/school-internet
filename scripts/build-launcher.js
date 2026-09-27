'use strict';
/**
 * 用系统自带的 .NET C# 编译器（csc.exe）构建无窗口启动器。
 * 产物: bin\schoolnet-daemon.exe
 *
 * 为什么需要它：
 *   Task Scheduler 直接运行 node.exe（控制台程序）时，登录会闪一个黑窗口。
 *   本机 Windows Script Host（cscript/wscript）不可用，VBS 方案走不通，
 *   所以改用一个 winexe（无控制台子系统）的小程序来拉起守护进程。
 *
 * 用法: node scripts/build-launcher.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'native', 'Launcher.cs');
const OUT = path.join(ROOT, 'bin', 'schoolnet-daemon.exe');

const cscCandidates = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];

const csc = cscCandidates.find((p) => fs.existsSync(p));
if (!csc) {
  console.error('[ERR] 找不到 csc.exe（.NET Framework 编译器）。');
  process.exit(1);
}
console.log('[..] 编译器:', csc);

if (!fs.existsSync(SRC)) {
  console.error('[ERR] 找不到源码:', SRC);
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// 用 args 数组直接传参，避免 shell 引号问题
const args = [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/out:' + OUT,
  SRC,
];

console.log('[..] 正在编译…');
const r = spawnSync(csc, args, { encoding: 'utf8', windowsHide: true });

if (r.error) {
  console.error('[ERR] 启动编译器失败:', r.error.message);
  process.exit(1);
}
if (r.stdout) console.log(r.stdout.trim());
if (r.stderr) console.error(r.stderr.trim());

if (r.status !== 0 || !fs.existsSync(OUT)) {
  console.error('[ERR] 编译失败，退出码:', r.status);
  process.exit(1);
}

const size = fs.statSync(OUT).size;
console.log('[OK] 已生成:', OUT, '(' + size + ' 字节)');
