# 本地验证码识别

Framework 0.1.18 提供可选的共享识别服务，并新增 WebUI 人工验证码转发，平台模块声明 `permissions.captcha: true` 后调用。后端只接收图片，平台 Cookie、密码和验证令牌由原会话与官方组件处理。未设置 `CF_CAPTCHA_URL` 时保持人工验证。

配套 ZHS 0.3.16 已接入共享课视频学习、短时试跑和每日复习中的拼图验证。人脸、短信、图形点选、登录及作业考试的额外验证仍由用户处理。识别坐标不代表验证通过，必须由智慧树 `validateSlideToken` 确认后才恢复。

## 启动后端

需要 Python 3.12；虚拟环境和运行文件放在源码之外：

```sh
uv venv "$HOME/.local/share/courseflow-captcha/venv" --python 3.12
uv pip install --python "$HOME/.local/share/courseflow-captcha/venv/bin/python" -r support/captcha/requirements.txt
PYTHONDONTWRITEBYTECODE=1 "$HOME/.local/share/courseflow-captcha/venv/bin/python" support/captcha/server.py --host 127.0.0.1 --port 8190
```

在 Framework 服务环境中设置并重启：

```sh
CF_CAPTCHA_URL=http://127.0.0.1:8190
CF_CAPTCHA_TIMEOUT_MS=10000
```

`CF_CAPTCHA_TIMEOUT_MS` 同时约束排队、请求和读取响应，最高 20000 毫秒。识别按单进程串行复用实例；任务暂停／停止或宿主退出会取消等待及在途请求。后端只绑定本机或容器内部网络，使用独立直连通道，不沿用平台代理。

配套适配器固定使用 ddddocr 1.5.6 和已验证的依赖。1.6.1 发布包自带 `/slide_match` 接口调用了不兼容的关键字参数，实测返回 500，其新版滑块返回值也与旧版边框格式不同；升级依赖前应重新运行合成图片和协议验证。

## Docker

```sh
docker build -t courseflow-captcha:1.5.6 support/captcha
```

可把它加入已有 Compose。API 镜像须包含 Framework 0.1.13 或更高版本；官方既有发行镜像不会因增加识别容器而自动获得新宿主接口。

```yaml
services:
  captcha:
    image: courseflow-captcha:1.5.6
    restart: unless-stopped
    expose: ["8190"]
  api:
    environment:
      CF_CAPTCHA_URL: http://captcha:8190
```

后端提供 `GET /health`、`POST /ocr` 和 `POST /slide_match`；两个 POST 均返回 `{result: ...}`。没有远程 URL 下载或修改全局字符范围的接口。

## 模块调用

| 方法 | 输入 | 输出 |
| --- | --- | --- |
| `cw.captcha.status` | `{session}` | `{available:boolean}`，表示宿主是否配置后端 |
| `cw.captcha.ocr` | `{session,image}` | `{text}` |
| `cw.captcha.slide_match` | `{session,target_image,background_image,simple_target?}` | `{target:[x1,y1,x2,y2],target_x,target_y}` |
| `cw.browser.open` | `{session,url,purpose:"captcha",stage:"open_study"}` | `{page,manual?}`；`manual:true` 表示宿主支持把页面交给 WebUI 人工操作。在官方源下建立只加载验证码组件的空文档 |
| `cw.browser.image` | `{session,page,url}` | `{image,mime}`，返回该验证码页面已经加载的原图 |

图片为标准 Base64，每张最多 2 MiB、最长边 4096 像素。`target_x/target_y` 是透明滑块裁剪时的偏移；模块需同时处理原图与 CSS 显示尺寸的比例以及滑块初始位置。浏览器原图接口与验证码空文档同时要求 `browser:true` 和 `captcha:true`，页面按用户、平台、连接和任务代次隔离。

ZHS 将打开组件、匹配拖动和平台确认分成短调用，总计最多等待 60 秒。同一明确拒绝最多自动验证一次；自动失败、未知结果或不支持的挑战在宿主返回 `manual:true` 时进入人工验证，保留页面最多 300 秒并暂停计时，WebUI 可显示官方弹窗截图并转发拖动/点击。超时或宿主不支持时关闭页面、保留学习检查点并暂停。验证及暂停时间不计入学习时长，确认后重新等待保存窗口。令牌和图片不进入检查点、运行日志或源码仓库。

## 网页人工验证

宿主把验证码页面按任务编号暴露给 Web UI，仅任务所有者可访问：

| 接口 | 说明 |
| --- | --- |
| `GET /api/tasks/:id/captcha` | 返回 `{state:"ready",image,mime,x,y,width,height}`；`image` 是官方弹窗 PNG，`x/y` 是页面 CSS 坐标。加载中返回 `{state:"loading"}`，页面已关闭返回 404 |
| `POST /api/tasks/:id/captcha` | 转发指针操作：`{type:"click",x,y}`、`{type:"drag",from:{x,y},to:{x,y}}`，或实时拖动序列 `press`/`move`/`release`（均带 `x,y`）。WebUI 使用后者在拖动过程中持续刷新画布，避免用户盲拖。坐标使用页面 CSS 像素，写入请求需要 CSRF |

任务响应增加 `manual_captcha:boolean`。前端只在模块进入“等待人工完成验证码”且页面仍打开时显示入口；用户完成拖动/点击后，模块读取官方组件的 `validate` 令牌并继续平台确认。截图只包含官方验证码弹窗，不包含平台 Cookie、其他页面或令牌。

## 管理员验证码拖动测试

管理员页面提供“验证码拖动测试”入口，用于在没有平台账号和任务的情况下验证 WebUI 的截图、坐标映射和指针转发：

| 接口 | 说明 |
| --- | --- |
| `POST /api/admin/captcha-test` | 打开一个无账号的官方易盾页面，使用 `ImageFocusCombine` 拼图组件 |
| `GET /api/admin/captcha-test` | 返回官方弹窗截图和页面 CSS 坐标 |
| `POST /api/admin/captcha-test/input` | 转发 `click`、`drag` 或实时 `press`/`move`/`release` 指针操作 |
| `DELETE /api/admin/captcha-test` | 关闭测试页面 |

测试页不提交任务、不写平台进度；只用于验证拖动/点击链路。关闭 WebUI 测试弹窗会自动删除远端测试页面。

## 验证

```sh
node --test test/captcha.test.ts test/captcha-browser.test.ts
PYTHONDONTWRITEBYTECODE=1 "$HOME/.local/share/courseflow-captcha/venv/bin/python" -m unittest discover -s support/captcha -p test_server.py -v
```

Python 检查使用生成的文字与透明滑块图片；Chromium 检查用本地拦截响应，不访问真实验证码服务。ZHS 的模拟宿主测试覆盖开始学习和保存时触发、平台拒绝、失败关闭、重复挑战上限和计时恢复。以上结果不能替代真实平台的验证码通过率验收。
