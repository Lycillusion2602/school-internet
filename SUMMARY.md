# 校园网自动认证守护 · 项目总结

> 项目路径：`D:\LkWorkplace\schoolInternet`
> 一句话：把"每次上网都要打开浏览器手输账号密码"这件事，变成一个后台自动完成的服务。

---

## 一、需求

校园网是基于 Web 的强制门户（Captive Portal）认证。用户的三个痛点：

1. **每次上网要手动打开浏览器输账号密码** —— 最大痛点。
2. **活跃期偶发会话丢失** —— 用着用着掉线。
3. **休眠唤醒后必现"已连接但无外网"** —— 合盖再打开，必须重新登录。
4. 浏览器**有时不保存 cookie**，导致总要重新输密码。

目标：做一个后台服务，自动完成认证，覆盖以上全部场景。

---

## 二、总体流程

```
看清 skill → 侦查认证协议 → 搭项目骨架 → 写协议/网络/守护模块
    → 填账号密码 → 真实断网实测 → 装开机自启 → 全量复查修 bug
```

---

## 三、阶段一：技术侦查（最关键的一步）

没有靠猜，而是把校园网认证系统"扒"清楚了。这一步决定了后面能否一次写对。

### 3.1 环境侦查

| 项 | 发现 |
|---|---|
| 本机 WLAN IP | `10.16.41.x` |
| 默认网关 | `10.16.0.1` |
| 系统 | Windows 11 (win32)，Shell 为 Git Bash |

### 3.2 定位门户（用户提供了入口 URL）

用户给出：`http://10.10.90.2/a79.htm?wlanuserip=10.16.41.x&wlanacname=`

抓取该页面后，从响应头发现 **`Server: DrcomServer1.0`** —— 确认认证系统是
**Dr.COM（城市热点）**，`a79.htm` 正是它的经典登录页。

### 3.3 从登录页里挖出协议参数

`a79.htm` 是 GBK 编码（需用 `TextDecoder('gbk')` 解码），解码后页面里直接泄露了关键配置：

| 参数 | 值 | 含义 |
|---|---|---|
| `v4serip` | `10.10.90.2` | 认证服务器 |
| `authloginpath` | `/eportal/?c=ACSetting&a=Login` | 登录路径 |
| `authuserfield` | `DDDDD` | 用户名参数名 |
| `authpassfield` | `upass` | 密码参数名 |
| `authloginport` | `801` | 认证端口 |

### 3.4 发现两套认证系统（新旧并存）

- **80 端口** = 老版 Dr.COM（`DrcomServer1.0`）
- **801 端口** = 新版 **nginx + Vue SPA** 的 ePortal

### 3.5 找到可用的真实接口（决定性突破）

反复探测后，锁定两个接口并实测通过：

| 用途 | 接口 |
|---|---|
| **状态查询** | `GET http://10.10.90.2/drcom/chkstatus?callback=dr1` |
| **登录** | `GET http://10.10.90.2:801/eportal/?c=Portal&a=login&...` |
| **登出** | `GET http://10.10.90.2:801/eportal/?c=Portal&a=logout&...` |

**状态接口直接返回了账号**（重要收获）：

```json
dr1({"result":1, "uid":"240xxxxxx@dx", "v46ip":"10.16.41.x", ...})
```

- `result: 1` = 在线
- `uid: "240xxxxxx@dx"` = **账号 240xxxxxx，运营商后缀 @dx（电信）**

登录接口用假密码测试时返回 `dr1003({"result":0,"msg":"IP: 10.16.41.x 已经在线！","ret_code":2})`
—— 接口有效（因为当时已登录，所以提示已在线）。

---

## 四、阶段二：实现

### 4.1 项目结构

```
D:\LkWorkplace\schoolInternet\
├── config.json                    # 唯一需要改的文件（账号密码）
├── config.example.json            # 配置模板（不含真实密码）
├── package.json
├── .gitignore
├── README.md
├── src/
│   ├── cli.js                     # 命令行入口
│   ├── drcom.js                   # Dr.COM 认证协议（登录/登出/状态）
│   ├── net.js                     # 连通性检测、IP 识别、休眠唤醒检测
│   ├── guardian.js                # 守护进程主循环
│   └── util.js                    # HTTP / 日志 / 编码工具
├── bin/
│   ├── schoolnet-daemon.exe       # 无窗口启动器（C# 编译）
│   ├── spawn-daemon.js            # Node 分离式后台启动
│   └── schoolnet.cmd              # Windows 命令行包装器
├── native/
│   └── Launcher.cs                # 无窗口启动器源码
├── scripts/
│   ├── build-launcher.js          # 编译 .exe
│   └── install-autostart.ps1      # 开机自启安装/卸载
├── tools/
│   └── diagnose.js                # 网络与门户诊断
├── docs/                          # 抓包证据
└── logs/                          # 运行日志（按天分文件）
```

### 4.2 各模块职责

- **`util.js`**：HTTP 请求（手工处理 gzip、GBK/UTF-8 解码、超时）、JSONP 解析、日志器。
- **`drcom.js`**：Dr.COM 协议封装 —— `login()` / `logout()` / `getStatus()`；
  自动组装带运营商后缀的账号；自动识别本机 IP。
- **`net.js`**：外网连通性检测（轮询 Google 204 / 微软 / 苹果三个探测地址，
  能识别"被重定向到门户"= 未认证）、本机 IP 识别、休眠唤醒检测。
- **`guardian.js`**：守护进程主循环 —— 周期检测，掉线自动重连，休眠唤醒后恢复。
- **`cli.js`**：命令行入口，提供 `status / login / logout / once / daemon / ip` 命令。
- **`tools/diagnose.js`**：六项体检，排障用。

### 4.3 核心技术设计

- **零第三方依赖**：只用 Node.js 内置模块，不需要 `npm install`。
- **完全不依赖浏览器**：直接走认证协议，与 cookie 无关 —— 从根上解决"cookie 不保存"问题。
- **三重连通性判断**：不只看能不能连，还判断是否被门户劫持。
- **配置示例**（`config.json`）：
  ```json
  {
    "service": "dx",
    "ip": "auto",
    "checkIntervalSec": 40,
    "resumeGapThresholdSec": 90,
    "wakeRecoverWindowSec": 90,
    "wakeRecoverGapSec": 4
  }
  ```

---

## 五、遇到的问题与解决（重点）

### 问题 1：我在没有守护进程运行时执行 logout，导致用户断网 🔴

**经过**：填完密码后，我执行一次性 `logout` 来"模拟掉线测试自动重连"。
但一次性命令执行完就退出 —— **当时根本没有守护进程在常驻**，
没有任何东西负责重连。结果用户断网约一分钟，连对话都断了。

**根因**：操作顺序错了。"自动重连"必须由常驻守护进程（`daemon`）承担。

**解决**：
1. 立即执行 `login` 恢复网络。
2. 改用正确顺序：**先启动守护进程并确认在跑 → 再执行断网测试**。
3. 重测结果：登出后由守护进程**约 24 秒自动重连成功** ✅

**教训**：涉及会中断网络的操作，必须先确保"兜底机制"到位再动手。

---

### 问题 2：PowerShell 脚本中文乱码报错 🟡

**现象**：运行 `install-autostart.ps1` 报 `MissingArrayIndexExpression` 等语法错误。

**根因**：脚本存的是**无 BOM 的 UTF-8**，而 **Windows PowerShell 5.1 默认按 GBK 读取 `.ps1`**，
中文被解析坏。

**解决**：给脚本写入 **UTF-8 BOM**（`\uFEFF`）。之后正常运行。

---

### 问题 3：Git Bash 路径被吞、引号地狱 🟡

**现象**：反斜杠路径被吞（`D:\a\b` → `D:ab`）；`cmd /c start` 报找不到文件；直接调 `csc.exe` 报 CS2032。

**解决**：
- 加 `MSYS_NO_PATHCONV=1` 禁用路径转换；
- **改用 Node 脚本文件传递参数数组**（`spawnSync` / `execFileSync`），
  彻底绕开 shell 引号问题 —— 本机最可靠的调用方式。

---

### 问题 4：VBS 启动器失效 —— 本机 Windows 脚本宿主（WSH）不可用 🔴

这是"进程隐藏"需求里踩的最大的坑。

**经过**：
1. 最初写 `.vbs` 想隐藏窗口 —— 但有 VBScript 语法错误，从未真正工作。
2. 修正语法后，仍报错 **"内存资源不足，无法完成此操作"**。
3. 隔离测试：**最简单的 VBS** 用 `cscript`/`wscript` 运行，**依然报同样的错**。

**根因**：**这台机器的 WSH 本身是坏的/被禁用** —— 环境问题，非脚本问题。VBS 路线走不通。

**解决**：改用系统自带 .NET C# 编译器（`csc.exe`，已验证可用），
编译**无控制台子系统（winexe）的小启动器**：

- 产物：`bin\schoolnet-daemon.exe`，源码：`native\Launcher.cs`
- 编译：`scripts\build-launcher.js`
- 原理：`.exe` 自身无控制台子系统，用 `CreateNoWindow` 拉起 node，**不弹窗**且不依赖 WSH。
- **验证**：读 PE 头确认 `Subsystem = 2 (WINDOWS_GUI)` ✅

---

### 问题 5：守护进程重复启动 🟡

**现象**：计划任务与手动启动并存时出现两个守护进程互相打架。

**解决**：加**单实例锁**。已有实例则拒绝启动，返回退出码 3。

---

### 问题 6：检测间隔调整（用户需求）

用户要求检测间隔从 20 秒调到 **40 秒**。修改 `config.json` 的 `checkIntervalSec`，已生效。

---

### 问题 7：最终复查发现并修复的 7 个隐患

| # | 问题 | 严重度 | 修复 |
|---|---|---|---|
| 1 | **唤醒恢复窗口太短**：唤醒后 WiFi 重关联要几秒~几十秒，原来 3 次重试(~17s)就放弃 | 🔴 | 新增 `recoverAfterWake()`：在 **90 秒恢复窗口**内持续"探测→认证→等待"直到连通 |
| 2 | **假唤醒误判**：测间隔时含了上一轮认证耗时，长时间恢复会被误判成"又一次睡眠" | 🔴 | 主循环改为**只计量 sleep 前后**的时间差 |
| 3 | **陈旧锁 + PID 复用**：硬关机残留锁文件，PID 被复用会误判"已在运行"而拒绝启动 | 🟡 | 改用**心跳锁**（持续刷新锁文件 mtime） |
| 4 | **计划任务未 `--wait`**：任务不跟踪守护进程，崩溃后不会自动重启 | 🟡 | 动作加 `--wait`，并把"已有实例"(退出码3)视为成功 |
| 5 | `config.json` 的 `$schema` 指向不存在的文件 | 🟢 | 删除 |
| 6 | 日志按 **UTC** 日期命名，与日志行本地时间跨日错位 | 🟢 | 改用本地日期 |
| 7 | `spawn-daemon.js` 写 `daemon.pid`，与 `daemon.lock` 重复 | 🟢 | 移除，统一用 `daemon.lock` |

**唤醒逻辑验证方式**：无法等真实睡眠，故写了**桩模拟测试**，注入受控行为验证 3 个场景 —— 全部通过：

| 场景 | 结果 |
|---|---|
| 唤醒后认证一次即恢复 | ✅ |
| 唤醒后全程不通 | ✅ 耗尽窗口后正确转常规重连（不卡死）|
| 网卡慢慢就绪、需多次尝试 | ✅ 持续重试直到成功 |

---

## 六、实测验证记录

| 验证项 | 结果 |
|---|---|
| `status` 命令 | ✅ 读到在线状态与账号 |
| `ip` 命令 | ✅ 识别 `10.16.41.x` |
| **真实断网 → 自动重连** | ✅ 登出后**约 24 秒**守护进程自动恢复 |
| 开机自启（计划任务） | ✅ 命令行确认为 `node src/cli.js daemon` |
| 单实例锁 | ✅ 二次启动被拒，退出码 3 |
| 无窗口启动器 | ✅ PE 子系统 = WINDOWS_GUI |
| 唤醒恢复逻辑（桩测试） | ✅ 3 场景全过 |

---

## 七、当前状态

```
守护进程  : ✅ 运行中 (PID 37796)，每 40 秒检测一次
心跳锁    : ✅ 正常刷新
计划任务  : ✅ SchoolNet-AutoAuth  Running（--wait 模式，无窗口）
网络状态  : ✅ 在线 240xxxxxx@dx
```

启动日志示例：

```
🚀 守护进程启动
   门户: 10.10.90.2 | 账号: 240xxxxxx@dx | 检测间隔: 40s
   休眠唤醒检测: 开 (阈值 90s，恢复窗口 90s)
```

---

## 八、待验证：睡眠唤醒（用户回来实测）

**方法**：
1. 合盖/睡眠笔记本，**睡够 2 分钟以上**（确保超过 90 秒阈值）。
2. 唤醒后**等 1~2 分钟**。
3. 查看结果（任选）：
   - `node D:\LkWorkplace\schoolInternet\src\cli.js status`
   - 看日志 `logs\schoolnet-<日期>.log`

**预期看到**：

```
💤➡️⏰ 检测到休眠唤醒（睡眠约 X 分钟），开始恢复…
✅ 重新认证成功: ...
✅ 唤醒恢复完成
```

若没看到唤醒记录或恢复失败 —— 调 `config.json` 里的 `wakeRecoverWindowSec`
（恢复窗口，默认 90 秒），以适配本机唤醒后 WiFi 重连较慢的情况。

---

## 九、常用命令速查

| 命令 | 说明 |
|---|---|
| `node src/cli.js status` | 查看状态（不需要密码） |
| `node src/cli.js login` | 立即登录 |
| `node src/cli.js logout` | 登出 |
| `node src/cli.js once` | 检测并按需登录（跑一次） |
| `node src/cli.js daemon` | 常驻守护 |
| `node src/cli.js ip` | 显示本机 IP |
| `node tools/diagnose.js` | 全面诊断排障 |
| `node scripts/build-launcher.js` | 重新编译无窗口启动器 |
| `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove` | 移除开机自启 |

---

## 十、经验教训

1. **先摸清协议再动手**：侦查阶段花的功夫，让后面基本一次写对，没有靠猜。
2. **涉及断网的操作要格外谨慎**：必须先确认"兜底/恢复机制"在位再测试。（问题 1 的教训）
3. **本机环境的坑要记录**：WSH 不可用、Git Bash 吞路径、PowerShell 需 BOM ——
   这些"环境特性"比代码本身更容易让人卡住，用 Node 脚本绕开是最稳的做法。
4. **收尾复查很有价值**：最后一遍通读，揪出 7 个隐患，其中 2 个正好命中用户要测的功能。

---

## 附：安全提示

- 密码以明文存在 `D:\LkWorkplace\schoolInternet\config.json`，
  已加入 `.gitignore`，**请勿分享该文件**。
