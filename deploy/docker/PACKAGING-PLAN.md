# Courseflow 即用部署仓库草案

状态：方案草案，尚未创建或发布独立 Git 仓库。基于 2026-11-10 的实际源码与既有 Docker 部署。

## 目标和边界

建议建立 `Course-Flow-Lab/courseflow-docker`，面向使用者提供“克隆仓库、填写配置、初始化、启动”的入口。继续使用 API 与 Web 两个容器：API 包含框架、智慧树 Rust 模块、超星 Python 环境和 Chromium；Web 提供静态资源和同源 API 网关。普通使用者无需安装 Node、Rust 或 Python，也无需克隆四个源码仓库。

第一版仅支持已验证的 Linux amd64 + Docker Compose 环境。arm64 在 Rust、Python 原生依赖和 Chromium 均通过原生验收后再提供，不能仅增加 build 参数就宣称支持。TLS 默认接入使用者现有反向代理，另附普通 Nginx 配置示例。

本次应用源码基线为 Framework `a75837c`、WebUI `8f7cd65`、智慧树 `31a7439`、超星 `19d218c`。内置题库源码已经位于 Framework 的 `src/question-bank/`，当前镜像运行不依赖相邻题库仓库。

## 仓库结构

```text
courseflow-docker/
  README.md                     # 最短启动步骤和管理员创建入口
  LICENSE                       # 部署工具自身许可
  .gitignore                    # 排除 .env、数据、备份、日志和设置码
  .env.example                  # URL、回环端口、数据/备份路径、镜像锁文件
  compose.yaml                  # 默认使用预构建镜像，不在目标机编译
  images.lock.env               # API/Web 镜像 digest
  sources.lock.json             # 四个源码 URL、完整提交、基础镜像 digest
  security/chromium-seccomp.json
  security/NOTICE.md             # Moby seccomp 来源、修改和 Apache 许可
  licenses/                     # 各组件许可及必要 NOTICE
  scripts/courseflow            # doctor/init/up/status/setup-code/update/backup/restore
  build/                        # Dockerfile、源码导出、构建与离线打包工具
  examples/nginx.conf            # 普通 HTTP upstream 示例
  docs/{configuration,upgrade,backup,rollback,offline}.md
  tests/                        # 首次启动、更新、恢复的容器验收
  .github/workflows/{check,release}.yml
```

维护者构建工具可下载指定提交的归档，不要求固定的相邻目录。来源、提交和基础镜像集中在锁文件，更新时显式修改。现有 `build-release.py` 是迁移起点，构建输入应由显式指定的源码目录和提交确定。

## 使用者体验

计划提供以下稳定命令；这些命令在当前仓库中尚未实现：

```sh
git clone https://github.com/Course-Flow-Lab/courseflow-docker.git
cd courseflow-docker
cp .env.example .env
# 填写 PUBLIC_URL；默认只在 127.0.0.1 发布网关
./scripts/courseflow doctor
./scripts/courseflow init
./scripts/courseflow up
./scripts/courseflow setup-code
```

`doctor` 检查 Docker/Compose 功能、CPU 架构、端口和目录权限。`init` 先根据锁文件拉取缺失镜像；离线模式则要求已导入同一发布包。`init` 幂等：空数据目录时生成私有数据、安装两个 live 模块并设置镜像内 Python 解释器；已有实例只核验，不能重置账号、密钥或配置。失败初始化保留现场并允许诊断。初始化和更新使用同一实例锁，防止两个写入者同时操作 SQLite。

`PUBLIC_URL` 必须填写真实访问源；本机试用可填写明确的回环 URL。数据目录由初始化命令创建为匹配容器 UID 的 0700，密钥 0600。独立 Compose 项目名称与端口可配置。

启动等待 API 健康后再启动 Web。保留非 root Chromium 用户 namespace 沙箱、现有 seccomp、512 MiB shm、API 内网监听及有上限的容器日志。设置码仅通过使用者主动执行的本机命令显示，不写入 Git、CI 日志或 release 资产。

## 镜像与发布

建议发布两个 GHCR 镜像 `ghcr.io/course-flow-lab/courseflow-api` 和 `ghcr.io/course-flow-lab/courseflow-webui`；发布前验证组织包发布权限和匿名拉取权限。通过 GitHub Release 触发构建，在 tag 指向固定源码组合后生成镜像 digest 与清单。部署仓库自己的版本表示整套组合，例如 `v0.1.0`，不能只用仍为 0.1.7 的框架包版本区分不同提交。

运行配置锁定 digest。更新命令明确选择发布版本，不能启动时静默追踪 `latest`。离线模式保留 `docker save` 压缩包、SHA-256、镜像 ID 和同一份发布清单，继续支持本机构建、SSH 传输、远端 `docker load`；镜像仓库不是现有 VPS 更新的必要条件。

构建时先安装系统和语言依赖，再写入提交 LABEL 和源码，避免当前 Dockerfile 每次改变 revision LABEL 都重新下载 Chromium。CI 显式运行 Node 24 类型检查及所有 `.test.ts/.test.mjs`、WebUI 检查/测试/构建、Rust locked 测试和构建、超星 unittest；必须断言跨仓库 fixture 依赖存在且测试零跳过。镜像验收复用实际 HTTP 代理、普通用户/管理员权限、CSRF、编码路径、日志下载和 Chromium 沙箱检查。

## 更新、备份和回滚

更新顺序：预拉取/导入并校验新镜像 → 检查当前状态 → 停止 API → 一致备份数据库、WAL、原密钥、模块、发布锁文件与配置 → 按需显式升级模块 → 启动并等待健康 → 检查数据与公网入口 → 标记当前发布。未改变的模块不重装，不覆盖已有模块设置；升级模块时保留原设置。失败时返回上一组镜像和配置，涉及数据变更则恢复配对快照。

**持久备份只保留远端一份、本机一份。** 新快照先写临时目录，校验摘要、SQLite `quick_check`、32 字节密钥和发布清单，通过后原子提升为唯一正式备份，再清除旧快照。创建过程中允许临时同时存在新旧快照；不能先删除唯一可恢复备份。本机同时运行独立实例时，一个备份包分别包含 `localhost/` 和 `remote/`，标明各自来源、密钥与镜像版本，防止交叉恢复。

当前镜像与上一版镜像属于回退发布产物，单独保留，不计作数据备份。恢复时数据库、密钥、模块目录必须来自同一快照；需要保留失败现场时暂存到本次诊断目录，恢复验证完成后清理。禁止删除数据卷的清理命令。通用脚本不能强制读取宿主 `/etc/nginx`；宿主配置备份作为可选运维扩展。

现有 `backup.sh` 目前每次创建时间戳目录，没有验证与保留数量控制；它不能直接视为满足上述唯一备份策略的成品脚本。

## 实施顺序和验收

1. 提取当前 Docker 资产到独立仓库，补齐许可证、变量和源码锁文件；在全新目录构建，不依赖开发工作区。
2. 实现 `doctor/init/up/status/setup-code`，在干净 Linux amd64 环境按 README 从零启动；重复 init 不改变原数据。
3. 实现带实例锁的 update/backup/restore 与仅留一份策略，演练有数据升级、备份校验失败、启动失败和完整恢复。
4. 增加 CI、镜像发布与离线 release 资产，在无登录环境验证镜像拉取；完成后才标注即用版发布。

交付验收：克隆通用仓库后无需相邻源码即可启动；前后端 Web API 1 一致；两个平台模块健康；容器重建保留账号、原密钥和配置；新管理接口保持成员权限边界；恢复演练可重现旧实例；本机与远端各只有一个正式备份包。真实平台登录和学习提交另由使用者验收。

## 官方参考

- [Compose 启动顺序和健康依赖](https://docs.docker.com/compose/how-tos/startup-order/)
- [Compose 环境变量与插值](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
- [GitHub Actions 发布 Docker 镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [Docker 多架构构建](https://docs.docker.com/build/building/multi-platform/)
