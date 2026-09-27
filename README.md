# schoolInternet · 校园网自动认证守护

> 校园网基于 **Dr.COM（城市热点）** 的 Web Portal 强制认证。本项目在后台自动完成登录，**再也不用打开浏览器手动输账号密码**——掉线自动重连、休眠唤醒后自动恢复。

---

## 它解决什么问题

| 痛点 | 本项目的做法 |
|---|---|
| 每次上网要手动打开浏览器输账号密码 | 后台守护进程自动认证，开机即用 |
| 浏览器不保存 cookie，总要重新登录 | 脚本直接走认证协议，完全不依赖浏览器 |
| 活跃期偶发会话丢失 | 每 40 秒探测一次外网，掉线立即重连 |
| 休眠唤醒后"已连接但无外网" | 检测到睡眠唤醒的时间跳跃，立即重新认证 |

---

## 快速开始

### 1. 填账号密码

编辑 `config.json`：

```json
{
  "account": {
    "username": "240xxxxxx",
    "password": "你的密码填这里",
    "service": "dx"
  }
}
```

- `service` 运营商后缀：`campus`=校园用户、`dx`=电信、`lt`=联通、`yd`=移动。
  本机实测账号为 `240xxxxxx@dx`（电信），所以填 `dx`。
  如果你发现认证失败，也可直接把 `username` 写成带后缀的完整形式（如 `240xxxxxx@dx`），此时 `service` 会被忽略。

### 2. 试一下

```bash
# 查看当前状态（不需要密码）
node src/cli.js status

# 完整诊断（排障用）
node tools/diagnose.js

# 跑一次检测+按需登录
node src/cli.js once

# 启动常驻守护（前台，Ctrl+C 退出）
node src/cli.js daemon
```

### 3. 设为开机自启（推荐）

**管理员 PowerShell** 里执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

之后每次登录 Windows，守护进程会自动在后台运行。

- 立即启动一次：`Start-ScheduledTask -TaskName SchoolNet-AutoAuth`
- 停止：`Stop-ScheduledTask -TaskName SchoolNet-AutoAuth`
- 移除自启：`powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove`

**不想用计划任务**？直接双击 `bin\schoolnet-daemon.exe` 也能静默后台运行（无任何窗口），只是不会开机自动启动。

> **关于"无窗口"实现**：`bin\schoolnet-daemon.exe` 是一个「无控制台子系统」(winexe) 的小程序，
> 由 `native\Launcher.cs` 编译而来，任务就是用 `CreateNoWindow` 拉起 node 守护进程。
> 之所以不用 `.vbs` 脚本：本机 Windows 脚本宿主（`cscript`/`wscript`）不可用，
> 连最简单的脚本都会报"内存资源不足"，所以改用编译型启动器，最可靠。
> 重新编译：`node scripts\build-launcher.js`

### 4. 关于"防重复启动"

守护进程带**单实例锁**（`logs/daemon.lock`）。判定逻辑在 `src/instance.js`：
必须下面三条**同时**成立，才认定有活跃实例并拒绝第二次启动——

1. 锁文件在 2.5 个检测周期内被刷新过（心跳）；
2. 锁里的 PID 现在真的活着，而且映像名是 `node.exe`（防 PID 被别的进程复用）；
3. 该 PID 的命令行确实是 `cli.js ... daemon`（防别的 node 进程顶包）。

任一条不成立就接管锁继续启动，并把接管原因打出来。

> **为什么不能只看心跳**（2026-09-22 踩的坑）：守护进程遇到断电或 `taskkill /F` 这类硬终止时
> 不会执行清理，锁文件原样留着且时间戳还很新。改前只看"锁新不新"，于是进程刚死不到 100 秒时，
> 登录触发的新实例会误判"已有实例在跑"、退出码 3 主动走人 —— 结果两边都没有守护进程，
> 而表面上一切正常。当天 18:08 停摆、18:09:28 启动又被拒，就是这个一分钟盲区造成的。

被拒绝时的提示会说清楚是谁占着、以及怎么确认：

```
⚠️  已有守护进程在运行（PID 15120 进程存活、心跳 15 秒前、命令行已核对），本次不再重复启动。
   要重启：先 taskkill /F /PID 15120 再 schtasks /run /tn SchoolNet-AutoAuth。
   （schtasks /end 停不掉它——只解除任务跟踪，node 进程照跑；硬杀残留的锁会被新判定识别并接管）
退出码 3
```

**怎么重启**，先分清守护进程当下是死是活（`node src/cli.js status` 最后一行）：

| 情况 | 做法 |
|---|---|
| 显示 ❌ 未运行（停摆了） | 直接 `schtasks /run /tn SchoolNet-AutoAuth`，残留锁不用管，新判定会识别 PID 已死并接管 |
| 显示 ✅ 运行中（要换新代码/改配置） | 先 `taskkill /F /PID <status 里那个 PID>`，再 `schtasks /run /tn SchoolNet-AutoAuth` |

改了 `config.json`（如检测间隔）必须走第二种重启才生效——守护进程只在启动时读一次配置。

```bash
node src/cli.js status                    # 先看守护进程一行是 ✅ 还是 ❌
schtasks /run /tn SchoolNet-AutoAuth      # 拉起，走和登录时同一条无窗口路径
node src/cli.js status                    # 再确认变成 ✅ 运行中
```

停掉当前实例**只能直接结束进程**：

```bash
taskkill /F /PID <锁里的PID>      # PID 见 node src/cli.js status 或 type logs\daemon.lock
```

> 实测：`schtasks /end /tn SchoolNet-AutoAuth` **停不掉守护进程**。它只让计划任务不再跟踪
> 那个启动器（"模式"变回"就绪"），node 子进程仍在后台跑。要真停就得 `taskkill /F /PID`。
> 硬杀会残留锁文件，但新判定能识别 PID 已死，不影响下次直接接管。

锁文件本身现在可读：`type logs\daemon.lock` 里的 `started` 只记一次真启动时刻，
不再被心跳改写（改前它恒等于最后心跳时刻，看不出实例是刚起的还是快没气儿的）。

改动判活逻辑后跑这个单测，1 秒出结果、不碰真实进程和网络：

```bash
node tools/test-instance.js
```

---

## 命令一览

| 命令 | 说明 |
|---|---|
| `node src/cli.js status` | 查看外网连通 + 认证会话 + **守护进程是否存活** |
| `node src/cli.js login` | 立即登录 |
| `node src/cli.js logout` | 登出 |
| `node src/cli.js once` | 检测并按需登录（跑一次，适合放任务计划） |
| `node src/cli.js daemon` | 常驻守护（掉线重连 + 休眠唤醒恢复） |
| `node src/cli.js ip` | 显示识别到的本机 IP |
| `node tools/diagnose.js` | 全面诊断，定位问题所在环节 |

也可以直接用包装器：`bin\schoolnet.cmd status`。

---

## 工作原理

### 认证协议（本机实测确认）

| 用途 | 接口 |
|---|---|
| 状态查询 | `GET http://10.10.90.2/drcom/chkstatus?callback=dr1` |
| 登录 | `GET http://10.10.90.2:801/eportal/?c=Portal&a=login&...` |
| 登出 | `GET http://10.10.90.2:801/eportal/?c=Portal&a=logout&...` |

- 门户是 **Dr.COM 城市热点**（响应头 `Server: DrcomServer1.0`，登录页 `a79.htm`）。
- 状态接口返回 JSONP：`dr1({"result":1,"uid":"240xxxxxx@dx","v46ip":"10.16.41.x",...})`，`result=1` 表示在线。

### 掉线与休眠判断

- **外网探测**：轮询 3 个连通性检测地址（Google 204 / 微软 / 苹果），
  若被重定向到门户或不返回预期内容 → 判定为未认证。
- **休眠唤醒**：主循环只计量"睡眠窗"本身（`sleep` 前后取时间差，不含认证耗时），
  若单次睡眠窗超过 `resumeGapThresholdSec`（默认 90 秒），判定系统经历过睡眠挂起。
  唤醒瞬间网卡（尤其 WiFi）往往还没重关联，所以不会只试一次就放弃，而是进入
  **恢复窗口**（`wakeRecoverWindowSec`，默认 90 秒）内持续"探测→必要时认证→短暂等待"，
  直到网络真正恢复；窗口内仍失败则转入常规重连。这是解决"休眠唤醒后必现无外网"的关键。

  相关配置（`config.json` → `behavior`）：

  | 参数 | 默认 | 含义 |
  |---|---|---|
  | `resumeGapThresholdSec` | 90 | 睡眠窗超过该秒数即判定为休眠唤醒 |
  | `wakeRecoverWindowSec` | 90 | 唤醒后持续恢复的总时间窗口 |
  | `wakeRecoverGapSec` | 4 | 恢复期间每轮重试的间隔 |

### 目录结构

```
schoolInternet/
├── config.json                    # 唯一需要改的文件（账号密码）
├── config.example.json            # 配置模板（不含真实密码）
├── package.json
├── src/
│   ├── cli.js                     # 命令行入口
│   ├── drcom.js                   # Dr.COM 认证协议（登录/登出/状态）
│   ├── net.js                     # 连通性检测、IP 识别、休眠唤醒检测
│   ├── guardian.js                # 守护进程主循环
│   └── util.js                    # HTTP / 日志 / 编码工具
├── bin/
│   ├── schoolnet-daemon.exe       # 无窗口启动器（编译产物，不入库；跑 node scripts/build-launcher.js 生成）
│   ├── spawn-daemon.js            # Node 分离式后台启动
│   └── schoolnet.cmd              # Windows 命令行包装器
├── native/
│   └── Launcher.cs                # 无窗口启动器源码（winexe）
├── scripts/
│   ├── build-launcher.js          # 编译 schoolnet-daemon.exe
│   └── install-autostart.ps1      # 开机自启安装/卸载
├── tools/
│   └── diagnose.js                # 网络与门户诊断
├── docs/                          # 门户登录页抓样 a79.htm（协议字段参考，已脱敏）
└── logs/                          # 运行日志（自动按天分文件）
```

---

## 排障

登录不成功？按顺序排查：

1. **跑诊断**：`node tools/diagnose.js`
   - 看【2】门户是否可达 → 不可达说明不在校园网内
   - 看【3】状态接口是否读到账号 → 读不到说明认证系统变了
   - 看【5】登录接口自检 → 提示"带有特殊字符的参数"说明接口格式需调整
2. **确认密码正确**、`service` 后缀正确（电信 `dx` / 联通 `lt`）。
3. **确认 IP**：`node src/cli.js ip`，正常应显示 `10.16.x.x`。
4. **看日志**：`logs/schoolnet-YYYY-MM-DD.log`。

> 若学校更换了认证系统（不再是 Dr.COM），`src/drcom.js` 里的接口需要按新系统的抓包结果调整。

---

## 说明

- **零第三方依赖**：只用 Node.js 内置模块，不需要 `npm install`。
- **不需要浏览器**：直接走认证协议，与浏览器 cookie 无关。
- 密码以明文存在 `config.json` 里，请注意不要把这个文件分享出去。
