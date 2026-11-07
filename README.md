# Courseflow framework

Node.js 课程工作台与平台模块宿主。框架统一负责站点账号、HTTP API、加密存储、模块管理与学习任务；平台协议由独立模块实现，支持 **Node.js 子进程**和 **Rust 等语言编译的二进制**。

界面沿用 Courseweave 的平台侧栏、课程卡片、分章目录和底部任务栏，提供浅色／深色主题与移动导航。平台名称、课程类型、单元和扩展标签来自模块描述，前端不内置智慧树分支。Studia 与 Courseweave 只作为参考工程，不是运行依赖。

## 本机运行

需要 Node.js ≥ 24 和 npm。原生运行 TypeScript，不需要构建前端。

```sh
npm ci
npm start
# http://127.0.0.1:8099
```

首次启动会在终端打印一次性管理员设置码，在网页中创建管理员即可进入工作台。

```sh
npm run dev        # 开发模式，修改服务器源码后自动重启
npm test           # 离线单元与集成测试
npm run typecheck  # TypeScript 检查
npm run check:web  # 浏览器 JavaScript 语法检查
```

网页资源直接从 `web/` 读取，修改后刷新浏览器即可。`argon2` 使用预编译原生模块，安装依赖时需要允许其安装脚本。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CF_BIND` | `127.0.0.1:8099` | HTTP 监听地址 |
| `CF_PUBLIC_URL` | `http://127.0.0.1:8099` | 完整公开源地址，不含路径；用于 Cookie 和来源校验 |
| `CF_DATA_DIR` | `$XDG_DATA_HOME/courseflow` 或 `~/.local/share/courseflow` | 数据与已安装模块，必须放在源码目录外 |
| `CF_LOG` | `info` | `debug`、`info`、`warn`、`error` |
| `CF_QUIET_HOURS_DISABLED_UNTIL` | 未设置 | 开发用临时覆盖，到期 Unix 秒后恢复夜间暂停 |

运行数据包括 `courseflow.db`、`secret.key` 和 `modules/<id>/<version>/`。备份时同时保存数据库和密钥。不要将真实账号、密钥或本机测试数据加入仓库。

## 使用工作台

1. 管理员打开「模块管理」，填写**服务器上的模块目录或 `.tgz` 路径**安装模块；此入口不上传浏览器本地文件。
2. 在「平台连接」中扫码连接账号。每个站点用户管理自己的平台连接。
3. 「所有课程」汇总已连接平台，也可从侧栏打开单个平台；支持搜索和完成状态筛选。
4. 打开课程，选择可学习且尚未完成的单元，点击「开始学习」。底部任务栏与「任务中心」显示执行状态。
5. 在任务中心暂停、继续或停止任务；任务详情提供执行记录。模块设置可以修改 JSON 选项并重新加载模块。

北京时间 **23:00–07:00** 暂停学习任务，连接账号和查看课程不受影响。夜间暂停、人工暂停以及服务重启后的任务均需要手动继续。

### 安装参考模块

Node.js 模拟器无网络、无真实账号，可以验证完整工作流：

```sh
npm run cli -- module add modules/simulator
npm run cli -- module list
```

智慧树模块在独立的相邻仓库 `../courseflow-zhs`。先在该仓库构建清单声明的 release 二进制，再安装。离线验证时显式选择 fixture：

```sh
npm run cli -- module add ../courseflow-zhs
npm run cli -- module config zhs '{"source":"fixture"}'
```

真实平台模式的支持范围与限制见该模块自己的 README。框架测试与 fixture 验证不能代替真实账号验收。

CLI 和网页使用同一套服务：

```sh
npm run cli -- module enable <id>
npm run cli -- module disable <id>
npm run cli -- module remove <id>
npm run cli -- module config <id> '{"option":true}'
npm run cli -- doctor
```

## 工程结构

```text
src/
  main.ts                  CLI 与服务入口
  runtime.ts               运行时装配与统一关闭
  version.ts               框架版本
  core/                    账号、配置、SQLite、加密、会话、时间策略
  modules/                 清单与 DTO、NDJSON RPC、子进程、模块管理、网络宿主
  jobs/engine.ts           学习步骤、检查点、暂停／继续／停止与恢复
  server/
    app.ts                 Fastify 配置与路由注册
    access.ts              统一会话、管理员、CSRF 与来源校验
    context.ts             HTTP 层需要的服务类型
    web.ts                 明确列出的静态网页资源
    routes/                system / auth / platforms / tasks / modules
web/
  index.html               工作台壳与无障碍入口
  style.css                响应式布局与主题
  api.js                   API 客户端与不透明课程 ID 路由
  views.js                 通用界面渲染
  app.js                   状态、导航、交互、局部轮询
spec/module-api-v1.md       框架与平台模块共同实现的协议
modules/simulator/         Node.js 参考模块
scripts/check-web.mjs      网页脚本语法检查
test/                    离线测试与 Rust 模块契约集成
```

分层边界和任务生命周期见 [架构说明](docs/ARCHITECTURE.md)。`createRuntime()` 是 CLI、HTTP 服务和测试共同的装配入口；平台模块不会在宿主进程内挂载路由或直接运行平台业务代码。

## 当前能力与边界

- 模块 API v1：安装校验、框架版本范围、文件 sha256 固定与加载复核、启停、配置、握手、进程重启。
- 平台：二维码连接、课程列表、单元目录、按课程解析的展示标签。当前网页登录入口支持 `qr`；密码和官方浏览器登录尚未接入。
- 任务：实现 `study.step` 驱动、加密检查点、执行记录、手动暂停／继续／停止、夜间暂停。暂停后的旧执行结果不能覆盖新状态；继续会等待上一轮执行退出；重启后未结束任务暂停等待核对。
- 账号：管理员初始化、登录／退出、HttpOnly Cookie、CSRF 与来源校验；平台会话与任务检查点加密保存在服务端。

尚未实现答题／交卷、浏览器与 AI 宿主服务、SSE、自动晨间恢复、账号互斥调度、运行任务的模块版本固定、模块签名、网页上传安装包及旧数据库迁移。模块声明这些能力不会让网页出现可执行的虚假操作；扩展标签显示「待接入」。

Node.js 模块使用权限模型限制文件、网络与进程访问；二进制按模块协议使用宿主服务，这不是操作系统级沙箱。加密格式和密码参数延续 Rust 参考实现，但当前数据库结构独立，不应将旧数据目录直接交给本框架。

编写模块请从 [模块 API v1](spec/module-api-v1.md) 开始：stdout 只输出 NDJSON JSON-RPC，日志写 stderr，所有外部访问经 `cw.*` 宿主服务，未实现的方法返回 `unsupported_operation`。
