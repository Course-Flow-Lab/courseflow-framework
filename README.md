# Courseflow 框架

Courseflow 是基于 Node.js 的课程工作台和平台模块宿主。站点账号、平台会话、任务调度、模型配置和加密存储统一由框架管理；平台协议放在独立模块中，可使用 Node.js 子进程或 Rust 等语言的二进制实现。

界面参考 Courseweave，提供平台侧栏、课程卡片、分章目录、课程功能页、任务详情、底部任务栏、深浅主题和移动导航。Studia 和 Courseweave 仅供开发参考，不是运行依赖。

## 运行

需要 Node.js ≥ 24、npm。智慧树的见面课和问答还需要 Chromium；构建智慧树模块需要 Rust ≥ 1.88。

```sh
npm ci
npm start
# 默认地址：http://127.0.0.1:8099
```

首次启动在终端打印管理员设置码。在网页创建站点管理员，再连接平台账号。站点账号与智慧树账号分别管理。

```sh
npm run dev
npm run typecheck
npm run check:web
npm test
```

网页没有构建步骤；服务器直接提供 `web/` 中明确列出的资源。`argon2` 有原生依赖，安装时需要允许正常安装脚本。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CF_BIND` | `127.0.0.1:8099` | HTTP 监听地址 |
| `CF_PUBLIC_URL` | 与监听地址对应的本机源地址 | Cookie、来源校验和导出链接使用的完整源地址，不含路径 |
| `CF_DATA_DIR` | `$XDG_DATA_HOME/courseflow` 或 `~/.local/share/courseflow` | 数据库、密钥、已安装模块和浏览器临时资料，放在源码外 |
| `CF_CHROMIUM` | `/usr/bin/chromium` | 官方页面使用的 Chromium 可执行文件 |
| `CF_LOG` | `info` | 日志级别：`debug`、`info`、`warn`、`error` |
| `CF_QUIET_HOURS_DISABLED_UNTIL` | 未设置 | 开发用临时覆盖，值为到期 Unix 秒；实际账号部署不设置 |

备份必须同时保存 `courseflow.db` 和 `secret.key`。数据库的加密内容包括平台会话、模块状态、任务检查点、任务选项、模型密钥、答题记忆和图片来源。不要将运行数据、真实账号或临时文件放进 Git。

## 安装智慧树模块

先在相邻的 `courseflow-zhs` 仓库构建，再从框架安装：

```sh
# 在 courseflow-zhs 中执行
cargo +stable build --release --locked

# 在 courseflow-framework 中执行；CF_DATA_DIR 必须与服务一致
npm run cli -- module add ../courseflow-zhs
npm run cli -- module config zhs '{"source":"live"}'
```

`live` 是真实平台模式，也是智慧树模块的默认值。仅在单独的离线测试数据目录中使用 `{"source":"fixture"}`。模拟数据不能与真实账号的验收结果混用。

```sh
npm run cli -- module list
npm run cli -- module enable zhs
npm run cli -- module disable zhs
npm run cli -- module config zhs '{"source":"live"}'
npm run cli -- doctor
```

模块目录或 npm 格式 `.tgz` 均可安装。网页安装入口填写服务器上的路径。安装后固定版本及文件指纹；升级平台模块后，旧任务暂停等待核对，不在原任务中静默换实现。

## 使用

1. 在「平台连接」用官方应用扫码，确认登录，然后打开课程。
2. 在学习目录勾选单元，创建学习任务；共享课还可选单视频短时试跑。
3. 「每日复习」选择已完成视频，按分钟预算原速复习；不重置原完成状态。
4. 「作业与考试」「掌握度」选择项目。默认保留已有答案、等待手动交卷确认；模型未配置或题目无法生成时，在任务详情人工补答。覆盖原答案需要明确勾选。
5. 「见面课」通过官方回放播放器原速播放，读取分钟历史续播，以平台签到状态确认结果。线下、未开放和无进展项目记入待处理记录。
6. 「问答区」可筛选问题并发布回答；提问先起草、编辑、勾选，再确认发布。站内同课程互助默认关闭，双方开启后只共享已发布问题编号。
7. 「成绩分析」「执行记录」查看平台数据、导出成绩及任务报告。报告提供 Markdown、Word、JSON 和 CSV；支持题图及平台公开的答案、解析。
8. 在「模型与任务设置」配置个人模型或管理员共享模型。密钥不回显；连接检查可能消耗少量额度。支持 Chat Completions 与 Responses，自动检测仅在明确不支持当前接口时切换格式，不会因鉴权失败改用其他密钥。

默认单任务、原速学习。可调整并发数，并显式允许同账号跨课程并行学习；同一课程保持排队，作答和发布保持账号串行。同一账号即使连接在不同站点用户下，也共享执行互斥。

北京时间 **23:00–07:00** 暂停平台学习和写入，早上自动继续由夜间策略暂停的任务。人工暂停和服务重启后暂停的任务需要手动继续。查看课程和只读回查不受影响。

交卷请求发出前保存持久化锁。响应丢失或结果未知时，任务只回读原作答，不自动重新交卷；在任务详情使用「回读提交结果」。验证码、人脸或官方额外验证需在官方页面处理。

## 工程结构

```text
src/
  main.ts、runtime.ts、version.ts  入口、装配与版本
  core/                          账号、配置、数据库、加密、会话、偏好
  modules/                       模块安装、协议、进程、HTTP 和宿主服务
  jobs/                          调度、学习、复习、作答与活动编排
  services/                      模型、答题记忆、官方浏览器、报告导出
  server/routes/                 认证、平台、模块、任务、设置和课程功能 API
web/                             无构建步骤的网页资源
spec/module-api-v1.md             模块协议与扩展服务
docs/                            架构、功能对照和本机部署说明
test/                            离线单元与集成测试
modules/simulator/               无网络的 Node.js 参考模块
```

详见[架构说明](docs/ARCHITECTURE.md)、[智慧树功能对照](docs/ZHS-PARITY.md)、[本机部署与验收](docs/LOCAL-DEPLOYMENT.md)和[模块 API v1](spec/module-api-v1.md)。

## 验证边界

离线测试覆盖协议、加密、任务恢复与互斥、人工补答、交卷确认、未知结果防重发、模型接口和 Rust fixture 集成。它们不能证明当前真实平台的所有接口都可用；真实账号验收需要逐项对照官方页面。

共享课已提交考试没有已确认的只读查看接口，因此界面只允许从原任务导出本地作答报告，不为查看而重新开考。共享课已提交作业和智慧课程试卷使用只读路径。

当前不提供 SSE、模块签名、网页上传安装包、旧 Studia 数据迁移或操作系统级二进制沙箱。Node.js 模块使用权限模型；二进制模块及其浏览器脚本属于可信安装代码，声明的网络白名单不能替代内核隔离。新部署使用独立数据目录，不能直接接管 Studia 的数据库或密钥。
