# 本机独立部署与真实账号验收

本次目标是 localhost 上的独立 Courseflow 服务。现有 Studia、Courseweave 和旧测试进程保持运行；不导入其账号、数据库或密钥。8099 已被现有进程使用，新服务使用 **http://127.0.0.1:8100**。

## 目录与服务

- 程序版本：`~/.local/share/courseflow-local/releases/`，以版本及提交编号保存。
- 当前版本链接：`~/.local/share/courseflow-local/current`。
- 独立数据：`~/.local/share/courseflow-local/data/`。
- 用户级服务：`~/.config/systemd/user/courseflow-local.service`。
- 首次设置码：在用户服务日志查看；部署时也会写入源码外、仅本人可读的 `~/.local/share/courseflow-local/admin-setup.txt`。

```sh
systemctl --user status courseflow-local
systemctl --user restart courseflow-local
systemctl --user stop courseflow-local
systemctl --user start courseflow-local
journalctl --user -u courseflow-local -n 50 --no-pager
```

用户级服务随用户会话启动。是否退出登录后继续运行取决于主机的用户管理器配置；本次不修改系统级 linger 设置。

## 构建与更新

1. 在智慧树仓库运行 `cargo +stable test --locked` 和 `cargo +stable build --release --locked`。
2. 在框架仓库运行 `npm ci`、`npm run typecheck`、`npm run check:web` 和 `npm test`。Rust release 存在时，测试包含真实子进程的 fixture 契约链路。
3. 将已提交框架代码导出至新的 release 目录，使用 `npm ci --omit=dev` 安装运行依赖。
4. 使用同一 `CF_DATA_DIR` 安装智慧树 release 模块，明确设置 `{"source":"live"}`。不要安装 simulator，也不要复制测试数据库。
5. 停止当前 Courseflow 独立服务，切换 `current` 链接，启动并检查 `/healthz`、首次设置状态和匿名访问边界。

操作模块 CLI 时使用与服务相同的数据目录。不要同时运行两个使用相同数据目录的 HTTP 服务。升级后模块内容指纹应与发布记录一致。

回退程序可将 `current` 切回旧 release，再启动服务；当前数据库版本为 2，旧程序必须能读取该版本。降级前备份数据，不让旧代码直接写入较新数据库。备份同时保存数据库与 `secret.key`，并保留原安装模块。

## 首次登录

在网页输入管理员设置码，创建自己的站点用户名和密码。之后到「平台连接」扫码智慧树。实际部署没有预置平台账号或付费模型密钥。

模型服务在「模型与任务设置」中填写；连接检查会向你选择的服务发送简短请求。未配置模型也可在作业任务暂停后人工补答。

## 逐项验收

先选一门课程、一个未完成视频，做 30–180 秒短时试跑，核对官方页面进度后再扩大任务范围。

| 项目 | 需要与官方页面核对 |
| --- | --- |
| 登录 | 扫码、课程列表、共享课与智慧课程目录；重新扫码后旧任务暂停 |
| 学习 | 原速保存、暂停后不累计停留时长、先修或限额提示、完成状态回读 |
| 复习 | 已完成视频、日期轮换、分钟预算、原状态保留、学习习惯分是否更新 |
| 视频互动 | 官方标注答案、模型或手工补答；额外验证时暂停 |
| 作业考试 | 已有答案保留、人工覆盖开关、草稿保存；明确确认后才交卷 |
| 交卷恢复 | 响应未知时只回读原作答，原任务导出区分已确认和未确认 |
| 掌握度 | 免考与满分跳过，最多三轮，未达满分仍显示未达标 |
| 见面课 | 官方播放器历史加载、原速续播、签到回读；无回放、线下和卡住项有记录 |
| 问答 | 列表、手工草稿、选中发布、回答限额、平台记录编号、避免重复发送 |
| 成绩与导出 | 平台计分规则、实际得分、中文报告、题图和公开解析 |
| 调度 | 同账号排队、显式跨课程并行、人工暂停、夜间暂停与晨间恢复 |

不要用正式考试测试网络故障或重试。共享课已提交考试暂不通过重新开考读取，使用原任务报告。验证码、人脸、未开放活动需在官方页面处理。

部署验收仅表示服务运行、接口与页面可用。首次真实账号登录、学习写入、正式交卷、完整见面课签到和真实模型调用均由用户在新站点测试，不能由离线结果替代。
