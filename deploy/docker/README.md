# Docker 开发与历史离线工具

**生产部署统一使用 [courseflow-docker](https://github.com/Course-Flow-Lab/courseflow-docker) 发布的 GHCR 镜像。** 在服务器 `/path/to/courseflow/` 下保存部署配置和数据，执行部署仓库的 `update latest`，拉取并核对 `ghcr.io/course-flow-lab/courseflow-api` 与 `courseflow-webui` 的同版本镜像后固定 registry digest。不要在生产使用下面的本机构建标签、`docker load` 镜像或裸本地镜像 ID。

下文保留旧版开发/离线打包流程供历史维护，不是当前服务器的上线入口。本机源码、输出与备份均放在 `/path/to/workspace/` 内。

由独立 API 与 WebUI 镜像组成。宿主 Nginx 负责 TLS，WebUI 只发布回环端口；SQLite、主密钥和已安装模块保存在镜像外。首次上线默认新建空站点，不导入本机数据。

## 构建固定版本

需要 Python ≥ 3.11、Docker、四个相邻源码仓库。构建机支持标准 Docker builder 或 BuildKit，不要求在 VPS 上编译。发布输出必须位于源码仓库之外：

```sh
python3 deploy/docker/build-release.py \
  --workspace "$HOME/workspace/courseflow" \
  --output "$HOME/workspace/courseflow/state/docker/本次发布" \
  --framework-ref <框架提交> --webui-ref <网页提交> \
  --zhs-ref <智慧树提交> --cx-ref <超星提交>
```

脚本通过 `git archive` 导出指定提交，只叠加当前 Docker 部署文件。临时上下文和构建日志留在发布目录内。镜像固定 `linux/amd64`，Node 24、Rust 1.88 和 Nginx 基础镜像解析为 digest；Rust 在 Debian Bookworm 中构建。发布清单记录源提交、部署文件摘要、镜像 ID、基础镜像 digest 和镜像包摘要。

先运行框架类型检查和全部测试、智慧树与超星的离线测试。镜像构建内执行 WebUI 检查、测试和构建。上线前在独立临时数据目录安装 fixture 模块，检查真实 HTTP 代理、认证、CSRF、编码路径、下载，以及非 root Chromium 沙箱。

## 服务器首次安装

将 `images.tar.gz`、`SHA256SUMS`、`release.json`、`release.env`、`compose.yml`、`chromium-seccomp.json`、`backup.sh`、本说明和 seccomp 许可说明放入服务器 `/path/to/courseflow/releases/<发布名>/`。不要上传构建上下文和本机数据。

```sh
cd /path/to/courseflow/releases/<发布名>
sha256sum -c SHA256SUMS
gzip -dc images.tar.gz | docker load
install -d -m 700 -o 1000 -g 1000 /path/to/courseflow/data
docker compose --env-file release.env -f compose.yml config --quiet
```

首次安装要求数据目录为空；发现既有数据时停止操作并核对，不能覆盖。初始模块安装命令仅在 API 服务未运行时执行：

```sh
docker compose --env-file release.env -f compose.yml run --rm --no-deps -T --interactive=false api node src/main.ts module add /opt/courseflow-modules/zhs
docker compose --env-file release.env -f compose.yml run --rm --no-deps -T --interactive=false api node src/main.ts module config zhs '{"source":"live"}'
docker compose --env-file release.env -f compose.yml run --rm --no-deps -T --interactive=false api node src/main.ts module add /opt/courseflow-modules/cx
docker compose --env-file release.env -f compose.yml run --rm --no-deps -T --interactive=false api node src/main.ts module config cx '{"source":"live","python":"/opt/cx-venv/bin/python"}'
docker compose --env-file release.env -f compose.yml up -d --wait --wait-timeout 120
```

CLI 和服务使用同一个 `/data`。新镜像已包含模块运行文件，只有显式安装才写入数据库；重启不会静默升级模块。首次设置码只从服务器私下查看 API 日志，然后在网页创建管理员。不要把设置码或日志粘贴到公开报告。

默认公开源地址为 `https://courseflow.example.com`，网关为 `127.0.0.1:8100`，API 为容器网络内 `8101`。隔离测试可通过进程环境覆盖 `DATA_DIR`、`PUBLIC_URL`、`WEB_PORT` 并使用独立 Compose 项目名。不要并行运行两个使用相同数据目录的 API。

## 宿主 Nginx

在原 SNI map 中让 `courseflow.example.com` 指向实际的 `127.0.0.1:9443` HTTPS 服务。保留默认 REALITY 路由和 `proxy_protocol on`。Courseflow HTTPS server 继续使用已有证书和 PROXY protocol，仅将 HTTP upstream 改为 `http://127.0.0.1:8100`。

宿主与容器两层代理均不在 `proxy_pass` 后添加 URI，不 rewrite API 路径；保留 Host、Origin、Cookie 和 `%2F`。宿主设置 `proxy_read_timeout 300s`、`proxy_send_timeout 300s`、`client_max_body_size 1m`，并覆盖 X-Forwarded-For 为实际客户端地址。容器保持同源，不添加 CORS 放行。

备份现有配置，执行 `nginx -t` 后 reload。保留公网 80 的 `/var/lib/letsencrypt` HTTP-01 路径和已有证书续期 hook。无需发布新的 API 端口或调整 Hysteria2 的 UDP 443。

## 更新、备份与回退

保留 `/path/to/courseflow/current` 指向当前发布目录。更新前上传并校验新镜像，在当前发布目录运行：

```sh
sh /path/to/courseflow/current/backup.sh
```

此命令短暂停止 API，一致备份数据库、WAL、原主密钥、模块、日志、发布配置和 Nginx 配置，完成后恢复 API。临时 Chromium profiles 不归档。重启会使运行中的任务暂停，需人工核对后恢复；不要用该离线备份方式做高频定时任务。备份含私密数据，目录权限为 0700，归档为 0600，另存一份私有离机备份。

停止旧 API，再执行明确的模块安装/升级操作；模块配置整体替换，设置超星解释器时保留其他既有配置。切换发布链接后重建两个服务：

```sh
docker compose --env-file release.env -f compose.yml up -d --force-recreate --no-build --pull never --wait --wait-timeout 120
```

网关通过 Docker DNS 动态解析 API，容器地址变化不会留住旧 upstream。更新前后核对数据统计、主密钥摘要和模块配置。备份保留策略为远端一份、本机一份：先创建并校验新备份及其离机副本，再删除旧备份；新备份验证失败时保留旧备份。本机同时运行独立实例时，将其快照与远端离机副本放入同一份私有备份包，分别标明来源。当前镜像与上一组回退镜像属于发布产物，单独保留；不自动清理旧 Studia 镜像或数据卷。

首发失败时停止本次容器、恢复 Nginx 备份，保留新数据供排查。后续发布失败则切回上一组镜像和发布配置；只有确需回退数据时才恢复配套数据库、密钥和模块目录，恢复前另存失败现场。禁止 `down -v` 或 `docker system prune --volumes`。

## 上线验收

- `/`、构建资源与 `/version.json` 可访问；前后端均为 Web API 1。
- `/healthz` 报告预期版本，智慧树和超星模块运行正常。
- 未登录接口返回 401；错误 Origin、错误 CSRF 被拒绝；编码路径和下载正常。
- Chromium 以非 root 用户、用户命名空间沙箱启动，退出后不残留进程；容器 DNS、HTTPS 出网可用。
- 重建容器后数据库、原密钥及模块配置仍在。
- 公网入口可用，博客、REALITY、Hysteria2 和证书续期保持正常。

部署验收不执行真实平台任务。真实登录、学习进度和提交结果由用户在官方页面另行核对。ASR 与模型服务保持未配置状态，后续由用户按需设置。
