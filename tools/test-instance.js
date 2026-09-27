'use strict';
/**
 * 单测 src/instance.js 的实例锁判定。
 * 跑法：node tools/test-instance.js
 * 判定分支全部用注入的 probe/commandLineOf，不依赖真实进程、不碰网络、不动在跑的守护进程。
 * 末尾另有几条打真机的探针用例（查自己的 PID），确认 tasklist/PowerShell 解析仍然有效。
 */
const inst = require('../src/instance');

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}  ->  ${got}${ok ? '' : '（期望 ' + want + '）'}`);
}
function ev(pid, ageMs, probe, cmd, root) {
  return inst.evaluate(
    pid ? { pid, started: 1, mtime: Date.now() - ageMs, ageMs } : null,
    { staleMs: 100000, probe, cmdlineOf: () => cmd, root: root || null });
}
const P = (o) => () => o;
const ALIVE_NODE = P({ probed: true, exists: true, name: 'node.exe' });
const DEAD = P({ probed: true, exists: false, name: null });
const NOTEPAD = P({ probed: true, exists: true, name: 'notepad.exe' });
const NOPROBE = P({ probed: false });
const OUR_CMD = '"D:\\nodejs\\node.exe" "D:\\LkWorkplace\\schoolInternet\\src\\cli.js" daemon';

console.log('evaluate() —— 是否拒绝启动（hold=true 表示拒绝）：\n');

// 本次事故的真实场景：锁很新鲜，但锁里的 PID 已经死了
let v = ev(37796, 68000, DEAD, OUR_CMD);
t('新鲜锁 + PID 已死 → 接管【修的就是这个盲区】', v.hold, false);
console.log(`       ${v.code}: ${v.why}`);

v = ev(19752, 16000, ALIVE_NODE, OUR_CMD);
t('新鲜锁 + PID 活着 + 命令行是我们的 daemon → 拒绝', v.hold, true);
console.log(`       ${v.code}: ${v.why}`);

v = ev(4321, 16000, NOTEPAD, null);
t('新鲜锁 + PID 被 notepad.exe 占用（PID 复用）→ 接管', v.hold, false);
console.log(`       ${v.code}: ${v.why}`);

v = ev(4321, 16000, ALIVE_NODE, '"D:\\nodejs\\node.exe" D:\\app\\server.js');
t('新鲜锁 + 是 node 但不是守护进程 → 接管', v.hold, false);
console.log(`       ${v.code}: ${v.why}`);

v = ev(19752, 150000, ALIVE_NODE, OUR_CMD);
t('锁 150s 未刷新（阈值 100s）→ 接管', v.hold, false);
console.log(`       ${v.code}: ${v.why}`);

v = ev(19752, 16000, ALIVE_NODE, null);
t('PowerShell 查不到命令行 → 保守按有效处理，拒绝', v.hold, true);
console.log(`       ${v.code}: ${v.why}`);

v = ev(19752, 16000, NOPROBE, OUR_CMD);
t('tasklist 本身查询失败 → 回退到新鲜度，拒绝', v.hold, true);
console.log(`       ${v.code}: ${v.why}`);

v = ev(null, 0, ALIVE_NODE, null);
t('没有锁文件 → 直接启动', v.hold, false);

v = ev(999, 16000, ALIVE_NODE, OUR_CMD, 'D:/LkWorkplace/schoolInternet');
t('锁主属于本目录 → 无跨目录告警', v.note, undefined);

v = ev(999, 16000, ALIVE_NODE, '"D:\\nodejs\\node.exe" "C:\\backup\\schoolInternet\\src\\cli.js" daemon',
       'D:/LkWorkplace/schoolInternet');
t('锁主来自另一份目录 → 拒绝但给出告警', (v.hold === true && /backup/i.test(v.note || '') && /另一份/.test(v.note)), true);
console.log(`       ${v.note}`);

console.log('\ndaemonStatus() —— status 命令显示用：\n');
const mk = (pid, ageMs) => ({ pid, started: Date.now() - 3600000, mtime: Date.now() - ageMs, ageMs });
console.log('  ' + inst.daemonStatus(mk(19752, 16000), { staleMs: 100000, probe: ALIVE_NODE }).text);
console.log('  ' + inst.daemonStatus(mk(37796, 68000), { staleMs: 100000, probe: DEAD }).text);
console.log('  ' + inst.daemonStatus(null, { staleMs: 100000 }).text);
t('  status: PID 死掉时必须报未运行', inst.daemonStatus(mk(37796, 68000), { probe: DEAD }).running, false);
t('  status: 真活着才报运行中', inst.daemonStatus(mk(19752, 16000), { probe: ALIVE_NODE }).running, true);

console.log('\n真实进程探针（不注入，打真机）：\n');
const me = inst.probePid(process.pid);
t('  自己的 PID 探到 node.exe', me.exists && me.name, 'node.exe');
const ghost = inst.probePid(299999);
t('  不存在的 PID → exists=false 且 probed=true', ghost.probed && ghost.exists === false, true);
const cmd = inst.commandLineOf(process.pid);
t('  自己的命令行取到了', typeof cmd === 'string' && cmd.length > 0, true);
t('  我们的 daemon 命令行被认出', inst.looksLikeDaemonCmd(OUR_CMD), true);
t('  普通 node 命令行不被误认', inst.looksLikeDaemonCmd('"D:\\nodejs\\node.exe" server.js'), false);
console.log('  rootOfCmd:', inst.rootOfCmd(OUR_CMD));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
