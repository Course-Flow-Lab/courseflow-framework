# Courseflow 框架

Courseflow 是基于 Node.js 的课程工作台，也是平台模块的宿主。站点账号、平台会话、任务调度、模型调用、加密存储和网页界面由框架统一管理；每个平台是一个独立模块，可用任意语言实现，通过标准输入输出的 NDJSON JSON-RPC 与框架通信。

模块不访问网络、不接触 Cookie 或密钥、不读写数据库：框架替它发请求、保存状态、计时并调度任务。平台协议因此可以各自独立演进，而调度、加密、审计和界面只需要实现一次。框架本身不包含任何平台的协议代码。

界面提供平台侧栏、课程卡片、分章目录、课程功能页、任务详情、底部任务栏、深浅主题和移动导航。Studia 和 Courseweave 仅供开发参考，不是运行依赖。

| 仓库或文档 | 内容 |
| --- | --- |
| 本仓库 | 宿主、网页界面、模块 API 规范 |
| [courseflow-zhs](https://github.com/Course-Flow-Lab/courseflow-zhs) | 智慧树模块。作为外部示例，模块定义、安装命令和平台能力都在它的 README |
| [courseflow-chaoxing](https://github.com/Course-Flow-Lab/courseflow-chaoxing) | 超星独立模块，以旧 chaoxing 为基线并保留 Studia 修正 |
| [courseflow-question-bank](https://github.com/Course-Flow-Lab/courseflow-question-bank) | 平台无关的题库、正确／错误答案记忆和外部数据源接口 |
| [Studia 数据迁移](docs/STUDIA-MIGRATION.md) | 只读预检、全新目录导入及历史档案范围 |
| [模块 API v1](spec/module-api-v1.md) | 清单、RPC、宿主服务、公共数据类型与错误的完整定义 |
| [`modules/simulator`](modules/simulator) | 无网络的 Node.js 参考模块，测试也用它 |

## 运行

需要 Node.js ≥ 24 和 npm。只有声明 `permissions.browser: true` 的模块才需要 Chromium。

```sh
npm ci
npm start
# 默认地址：http://127.0.0.1:8099
```

首次启动在终端打印一次性管理员设置码；在网页创建站点管理员。站点账号与平台账号分别管理，平台账号只能通过模块声明的登录方式连接。

管理员创建完成后，新成员可在登录页点击「注册账号」。默认需要邀请码，管理员可在「注册与邀请」生成邀请码或关闭邀请码要求。

```sh
npm run dev        # 监视模式
npm run typecheck
npm run check:web
npm test
```

网页没有构建步骤，服务器直接提供 `web/` 中明确列出的资源。`argon2` 有原生依赖，安装时需要允许正常的安装脚本。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CF_BIND` | `127.0.0.1:8099` | HTTP 监听地址 |
| `CF_PUBLIC_URL` | 与监听地址对应的本机源地址 | Cookie、来源校验和导出链接使用的完整源地址，不含路径 |
| `CF_DATA_DIR` | `$XDG_DATA_HOME/courseflow` 或 `~/.local/share/courseflow` | 数据库、密钥、已安装模块和浏览器临时资料，放在源码外 |
| `CF_CHROMIUM` | `/usr/bin/chromium` | 官方页面与播放器使用的 Chromium 可执行文件 |
| `CF_LOG` | `info` | 运行日志级别：`debug`、`info`、`warn`、`error`；同时写入终端及私有数据目录的 `logs/` |
| `CF_QUIET_HOURS_DISABLED_UNTIL` | 未设置 | 开发用临时覆盖，值为到期 Unix 秒；实际账号部署不设置 |

备份必须同时保存 `courseflow.db` 和 `secret.key`。数据库的加密内容包括平台会话、模块状态、任务检查点、任务选项、模型密钥、答题记忆和图片来源。不要将运行数据、真实账号或临时文件放进 Git。

## 模块系统

### 模块是什么

模块是框架启动的**独立子进程**，不是链接进来的库：

- 双方在 stdin／stdout 上交换一行一个 JSON 对象（NDJSON，JSON-RPC 2.0）。stdout 只放协议；日志写 stderr；stdin 关闭后模块应以 0 退出。
- 框架持有 HTTP、Cookie 与令牌、加密存储、时钟、模型调用和官方浏览器页面；模块只负责平台协议、响应解析和请求编排。
- 每个调用有 30 秒上限，`platform.describe` 为 5 秒。超时或崩溃只影响该模块，框架按 1／2／5／15／30 秒退避重启，最多 5 次。
- 一个模块进程服务多个站点用户；会话以框架签发的不透明句柄传递，模块不能凭句柄访问其他平台或其他用户。

### 模块清单

模块目录至少包含 `courseflow.module.json` 和入口文件：

```json
{
  "schemaVersion": 1,
  "id": "demo",
  "name": "示例平台",
  "version": "0.1.0",
  "moduleApi": 1,
  "engines": { "framework": ">=0.1.1 <0.2.0" },
  "runtime": { "engine": "node", "entry": "index.mjs", "files": [] },
  "platform": {
    "id": "demo",
    "name": "示例平台",
    "short": "示例",
    "login": ["qr"],
    "operations": ["study"],
    "unit_kinds": ["video"],
    "presentation": { "tabs": [{ "id": "study", "label": "学习目录" }] }
  },
  "permissions": {
    "network": ["example.com", "*.example.com"],
    "browser": false,
    "ai": false,
    "storage": "module"
  }
}
```

规则的要点（完整说明见[规范 §1](spec/module-api-v1.md)）：

- `id` 与 `platform.id` 相同，小写字母开头，2–32 位字母、数字、下划线或连字符。
- `moduleApi` 是整数主版本；框架支持 N 和 N-1，不匹配时拒绝安装并提示两侧版本。
- `engines.framework` 必填且不能为 `*`。当前是比较器，支持比较运算符和 `^`，不要假设完整 npm 范围语法。
- `runtime.engine` 为 `node` 或 `binary`；`runtime.entry` 与 `runtime.files` 只能是模块目录内的相对路径。
- `permissions.network` 是精确主机或 `*.` 子域，不是 URL；根域与子域需要分别声明。
- `presentation` 的 `when` 只支持 `course.kind`、`course.family` 的字符串相等，由框架求值；界面不做平台判断。
- 可选 `keepalive_seconds`（≥ 60）让框架定期调用 `auth.keepalive`，模块只能刷新登录状态，不发学习写入。

### 宿主服务

模块访问外界的唯一途径（[规范 §4](spec/module-api-v1.md)）：

| 服务 | 作用 |
| --- | --- |
| `cw.net.fetch` | 唯一的出网通道。宿主注入会话 Cookie／令牌、执行网络白名单、拒绝模块设置 Cookie／Host、限制重定向、按用户的夜间暂停设置限制非只读阶段，并按 `commit` 记录请求台账 |
| `cw.state` | 按模块、用户、命名空间和键隔离的加密键值存储；`cw.state.get`、`cw.state.set` 是显式别名 |
| `cw.session.identity` | 框架在登录完成时保存的平台身份，不是 Cookie 或令牌 |
| `cw.question_bank.lookup`／`cw.question_bank.record` | 需声明 `question_bank: true`；按当前会话所属用户、平台和课程加密隔离 |
| `cw.ai.generate` | 用站点用户选中的模型生成文本；需要清单 `ai: true`，模块拿不到密钥 |
| `cw.browser.*` | 官方页面的打开、脚本求值和关闭；页面绑定用户、平台与任务代次，需要 `browser: true` |
| `cw.peers.*` | 站内同课程互助的已确认发布编号；双方都开启才可读 |
| `cw.clock.now` | 统一时钟，Unix 秒 |
| `cw.log` | 结构化日志通知，不得包含凭据 |

### 框架调用的方法

| 方法 | 用途 |
| --- | --- |
| `platform.describe` | 返回平台描述符，必须与清单一致，也是加载时的握手 |
| `auth.begin`／`auth.poll`／`auth.complete` | 登录挑战、状态轮询与完成；可选的 `auth.keepalive` 由 `keepalive_seconds` 触发 |
| `catalog.courses`／`catalog.units` | 课程列表与目录 |
| `catalog.papers`／`catalog.score`／`catalog.mastery`／`catalog.meetings` | 试卷列表、成绩、掌握度与见面课 |
| `study.step`、`activity.step` | 可重复执行的短步骤，返回 `in_progress`、`completed`、`needs_human`、`blocked` 或 `unknown` |
| `exam.open`／`exam.write`／`exam.readback`／`exam.review`／`exam.redo`／`exam.heartbeat` | 作答、交卷、回读与只读复核 |

框架只调用模块在 `operations` 中声明的能力；参数、返回值与错误码以[规范 §3](spec/module-api-v1.md) 为准。框架不解释平台业务字段：原生记录、签名参数等放进 `cw.state` 或检查点，不进入公共 DTO（见[规范 §5](spec/module-api-v1.md)）。

### 生命周期

```
安装 → 校验清单（moduleApi、版本范围、权限、路径）
     → 复制清单、入口与 runtime.files，固定 sha256 并写入数据库安装记录
启用 → 启动子进程 → platform.describe（5 秒）→ 就绪，调用按 30 秒限时
崩溃 → 退避重启；连续失败后保持不可用，等待管理员处理
停用 → SIGTERM，5 秒后 SIGKILL
```

模块不可用时相关任务暂停而不是失败；模块更新后，旧任务以 `module_version_changed` 暂停，等待核对，不在原任务里静默换实现。

### 安装与管理

```sh
npm run cli -- module add <目录或 .tgz>
npm run cli -- module list
npm run cli -- module enable <id>
npm run cli -- module disable <id>
npm run cli -- module config <id> '{"key":"value"}'
npm run cli -- module remove <id>
npm run cli -- doctor
```

- 目录安装只复制清单、`runtime.entry` 和 `runtime.files`，构建目录（`target/`、`node_modules/`）不会进入数据目录；npm 格式 `.tgz` 使用 `package/` 根目录。
- 安装后内容指纹写入数据库的模块安装记录，启动时复核。管理员也可以在网页安装入口填写服务器上的路径。
- CLI 与服务必须使用同一个 `CF_DATA_DIR`；不要同时运行两个使用相同数据目录的服务。
- 模块配置整体替换，传 `{}` 即恢复默认值。配置语义属于模块，框架只保存并原样下发。

### 信任边界

- 网络白名单由宿主在每次请求和每次跳转前检查；启用夜间暂停的用户在北京时间 23:00–07:00 不能执行非只读阶段，模块无法绕过。
- Node 引擎在权限模型下运行（默认无 `--allow-net`、无子进程）。`binary` 引擎作为可信进程直接运行，协议权限不是操作系统沙箱；浏览器脚本同属可信模块代码。
- 模块看不到平台凭据、模型密钥和其他平台的会话，也不能读写数据库；它能看到的是宿主下发的会话句柄和请求响应体。
- 目前没有模块签名，也没有网页上传安装包：只支持目录与 `.tgz` 路径安装，安装即可信。

### 版本

`moduleApi` 是主版本闸门，框架支持 N 与 N-1；`engines.framework` 声明模块测试过的框架范围。两类不匹配都在安装时拒绝并写明两侧版本。规范变更记录在[模块 API v1](spec/module-api-v1.md)。

## 编写模块

1. 读[模块 API v1](spec/module-api-v1.md)：清单、消息、宿主服务和错误码。
2. 建清单和入口，先实现 `platform.describe`，让框架完成握手。
3. stdout 只写协议，日志写 stderr，stdin 关闭后以 0 退出；未知方法返回 `unsupported_operation`，不要崩溃。
4. 用 [`modules/simulator`](modules/simulator) 对照最小实现；需要真实平台的参考实现时看 [courseflow-zhs](https://github.com/Course-Flow-Lab/courseflow-zhs)。
5. 在模块仓库里写契约测试：模拟宿主、离线、不需要账号。模块的安装方式、配置项和平台能力写在模块自己的 README，不写进框架。

## 使用

### 站点注册与邀请

管理员在侧栏「注册与邀请」管理新成员注册；手机端可从「我的账号 → 注册与邀请」进入。

1. 「新用户注册必须提供邀请码」默认开启。关闭并保存后，任何人都可使用用户名和密码注册；重新开启不影响已有账号登录。
2. 每次可生成 1–100 个邀请码。格式为 `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`，每位为数字或大写英文字母。每个码可注册一个成员账号，直到使用或撤销前有效。
3. 完整邀请码只在生成后显示，请点击「复制全部」并保存；数据库只存摘要，记录列表无法找回完整内容。可撤销尚未使用的邀请码。
4. 将邀请码交给新成员；对方在登录页点击「注册账号」，填写用户名、密码、确认密码和邀请码即可进入工作台。密码至少 12 个字符；注册始终创建成员，不授予管理员权限。

注册失败不会消耗邀请码。同一码并发注册时只有一次可以成功；注册成功后立即登录。关闭邀请码要求时邀请码为选填，主动填写仍须有效且会在成功后消耗。

| 接口 | 权限与用途 |
| --- | --- |
| `POST /api/auth/register` | 未登录可用；提交 `username`、`password` 和按策略要求的 `invitation_code` |
| `GET /api/admin/registration` | 管理员读取注册设置、邀请码统计和最近 100 条记录 |
| `POST /api/admin/registration` | 管理员保存布尔值 `invitation_required` |
| `POST /api/admin/invitations` | 管理员生成邀请码；`count` 为 1–100，省略时为 1 |
| `POST /api/admin/invitations/:id/revoke` | 管理员撤销未使用的邀请码 |

管理员写入接口需要站点会话和 `x-courseflow-csrf`。邀请码、密码与注册请求体不写入操作日志。

### 课程与任务

界面按模块声明的能力显示，没有该能力的平台不会出现对应入口：

1. 「平台连接」用模块声明的登录方式连接账号，然后打开课程。
2. 在学习目录勾选单元创建学习任务；模块声明试跑能力时也可单独试跑。
3. 每日复习、作业与考试、掌握度、见面课、问答区等入口只在模块声明对应能力时出现。
4. 作答默认保留已有答案、等待人工确认；模型未配置或题目无法生成时在任务详情补答，覆盖原答案需要显式勾选。
5. 成绩分析与执行记录导出平台数据与任务报告（Markdown、Word、JSON、CSV）。
6. 「模型与任务设置」配置个人模型或管理员共享模型；密钥不回显，停用后必须重新选择。
7. 「日志导出」按北京时间选择范围，下载自己的任务日志；管理员还可下载运行日志和操作记录。最长 92 天、单次最多 20 MB。任务详情也提供单项日志下载。

每个用户默认启用北京时间 **23:00–07:00** 夜间暂停，可在「模型与任务设置」取消勾选「启用夜间暂停」。关闭后，该用户的任务可以全天运行；其他用户的设置不受影响。早上或关闭开关后，调度器自动继续仅由夜间策略暂停的任务；人工暂停和服务重启后暂停的任务需要手动继续。查看课程和只读回查不受影响。交卷请求发出前保存持久化锁，结果未知时只回读原作答，不自动重新交卷。

问答区采用互动分看板：提问与回答分别显示平台有效条数和本工作台今日发布数，提供数量调节、可编辑草稿、勾选发布、站内互答开关和可展开的发布记录。首次打开只读取成绩和本地记录，展开「浏览课程讨论」后才加载官方列表；实际发布仍需确认。

运行日志和操作记录从本版本开始保存到 `CF_DATA_DIR/logs/`，不会读取其他服务的日志。操作记录只保留操作类型、时间和结果，不保存请求体或凭据；常见凭据字段与地址查询参数会被隐藏。任务日志包含历史执行事件和新增的播放器诊断，不能把日志中的任务结束当成平台已确认完成。

## 工程结构

```text
src/
  main.ts、runtime.ts、version.ts  入口、装配与版本
  core/                          账号、配置、数据库、加密、会话、偏好
  modules/                       模块安装、协议、进程、HTTP 与宿主服务
  jobs/                          调度、学习、复习、作答与活动编排
  services/                      模型、答题记忆、官方浏览器、报告导出
  server/routes/                 认证、平台、模块、任务、设置和课程功能 API
web/                             无构建步骤的网页资源
spec/module-api-v1.md             模块协议与宿主服务定义
docs/                            架构与本机部署说明
test/                            离线单元与集成测试
modules/simulator/               无网络的 Node.js 参考模块
```

详见[架构说明](docs/ARCHITECTURE.md)与[本机部署](docs/LOCAL-DEPLOYMENT.md)。

## 验证范围

离线测试覆盖模块协议、加密、任务恢复与互斥、人工补答、交卷确认、未知结果防重发、模型接口和参考模块的 fixture 链路。它们不能证明某个真实平台的所有接口都可用；平台验收必须在模块自己的仓库和真实账号上完成。

功能可运行、测试通过和真实平台验收是三种状态，不能互相替代。框架不提供模块签名、网页上传安装包、操作系统级沙箱。0.1.5 提供 Studia 导入工具，仅写入全新数据目录；旧平台会话需要重新连接，历史任务只读封存，不自动恢复执行。
