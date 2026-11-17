# 本地验证码识别

Framework 0.1.13 提供可选的共享识别服务，平台模块声明 `permissions.captcha: true` 后调用。后端只接收图片，平台 Cookie、密码和验证令牌由原会话与官方组件处理。未设置 `CF_CAPTCHA_URL` 时保持人工验证。

配套 ZHS 0.3.8 已接入共享课视频学习、短时试跑和每日复习中的拼图验证。人脸、短信、图形点选、登录及作业考试的额外验证仍由用户处理。识别坐标不代表验证通过，必须由智慧树 `validateSlideToken` 确认后才恢复。

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
| `cw.browser.open` | `{session,url,purpose:"captcha",stage:"open_study"}` | `{page}`，在官方源下建立只加载验证码组件的空文档 |
| `cw.browser.image` | `{session,page,url}` | `{image,mime}`，返回该验证码页面已经加载的原图 |

图片为标准 Base64，每张最多 2 MiB、最长边 4096 像素。`target_x/target_y` 是透明滑块裁剪时的偏移；模块需同时处理原图与 CSS 显示尺寸的比例以及滑块初始位置。浏览器原图接口与验证码空文档同时要求 `browser:true` 和 `captcha:true`，页面按用户、平台、连接和任务代次隔离。

ZHS 将打开组件、匹配拖动和平台确认分成短调用，总计最多等待 60 秒。同一明确拒绝最多自动验证一次；失败、未知结果或不支持的挑战会关闭页面、保留学习检查点并暂停。验证及暂停时间不计入学习时长，确认后重新等待保存窗口。令牌和图片不进入检查点、运行日志或源码仓库。

## 验证

```sh
node --test test/captcha.test.ts test/captcha-browser.test.ts
PYTHONDONTWRITEBYTECODE=1 "$HOME/.local/share/courseflow-captcha/venv/bin/python" -m unittest discover -s support/captcha -p test_server.py -v
```

Python 检查使用生成的文字与透明滑块图片；Chromium 检查用本地拦截响应，不访问真实验证码服务。ZHS 的模拟宿主测试覆盖开始学习和保存时触发、平台拒绝、失败关闭、重复挑战上限和计时恢复。以上结果不能替代真实平台的验证码通过率验收。
