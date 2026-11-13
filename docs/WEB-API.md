# Web API 与后端嵌入

Framework 是后端，WebUI 是独立客户端。后端不提供根页面或静态资源，只提供 `/api/*` 与 `/healthz`。静态资源托管、监听端口、进程信号和未来 App 的窗口生命周期由外层入口负责。

## 接口契约

- `/api/bootstrap` 无需登录，返回站点初始化状态、注册策略、能力和 `web_api_version: 1`。`/healthz` 同样提供该字段，便于核对发布版本。
- `module_api` 表示平台模块 RPC 版本，与 Web API 独立。当前 WebUI 仅接受数字 `web_api_version: 1`；缺失或不匹配时显示兼容性提示。
- API 使用下文声明的路径和结构；增加字段或新管理接口不改变接口版本。任务执行记录导出统一为纯文本，旧的多格式参数返回 400，前后端须配套更新。
- 错误返回 `{ "error": { "code": "错误代码", "message": "中文说明" } }`。网关可能返回非 JSON 的 502、503、504，前端应显示服务不可用提示。
- 所有不透明 ID 按路径段单独编码，包括中文及斜杠。代理不得解码再拼接或重写 API 路径。

## 会话与同源部署

站点会话继续使用 `cf_session`，属性为 `HttpOnly; SameSite=Strict; Path=/`；公开 URL 为 HTTPS 时增加 `Secure`。写入请求继续要求 `x-courseflow-csrf`，公开注册和已登录接口保留来源校验。前端使用相对 `/api/*` 路径和 `credentials: same-origin`。

`CF_BIND` 是后端实际监听地址，`CF_PUBLIC_URL` 是用户访问前端的完整源地址。生产示例为 `127.0.0.1:8101` 与 `http://127.0.0.1:8100`；开发示例为 `127.0.0.1:8102` 与 `http://127.0.0.1:5173`。开发和生产必须使用不同数据目录。

图片 `/api/media/:id`、报告和日志导出也经同源代理，继续使用站点会话与所有权校验。生成的绝对链接使用公开 URL。前端不持有平台 Cookie、数据库、主密钥或模块运行环境。

## 可导入入口

包根入口导出 `createRuntime()`、配置类型及配置加载工具，不导入 HTTP 服务。`courseflow-framework/http` 导出 `createHttpServer()`。框架当前仍要求 Node.js ≥ 24，未声明移动端运行兼容性。

```ts
import { randomBytes } from 'node:crypto';
import { createRuntime, loadConfig, bindAddress } from 'courseflow-framework';
import { createHttpServer } from 'courseflow-framework/http';

const config = loadConfig();
const runtime = await createRuntime(config);
const setupCode = randomBytes(24).toString('base64url');
const http = createHttpServer(runtime, { ...config, setupCode });
// 首次初始化时仅将设置码告知本机操作者，不通过公开 API 返回。
if (!runtime.db.get('SELECT 1 FROM users LIMIT 1')) console.error(setupCode);
await http.listen(bindAddress(config.bind));

// 由宿主在退出或启动失败时调用；关闭 HTTP 不会自动关闭运行时。
async function close() {
  try { await Promise.all([http.close(), runtime.asr.shutdown()]); }
  finally { await runtime.close(); }
}
```

只需要后端服务时直接调用 `createRuntime(runtimeConfig)`；配置只需数据路径、日志级别和夜间临时覆盖，不需要绑定地址或公开 URL。模块 CLI 使用 `recoverTasks: false`，避免操作模块列表时改写运行中任务状态。运行时关闭可重复调用，即使某个停止步骤失败，也会继续释放剩余资源。

当前开发分支已接入 PR #2 的可选宿主语音转写。`runtime.asr` 由后端创建，`/api/settings` 增加只读的 `asr: { available, backend, model }`；未配置时保持不可用，不影响其他功能。应用退出先停止接收 HTTP 请求并取消转写，再关闭其余运行时；仅关闭 HTTP 服务不会销毁后端。

模块运行方式、数据库结构和内置题库接口保持不变。语音转写是模块 API v1 的可选能力，原有模块不需要新增权限。未来 App 可在此基础上组合独立前端与后端，不要求引入桌面 SDK、手机 SDK 或额外服务进程。

### 本机来源与课程进度

当公开地址为本机地址时，来源检查允许 `localhost`、`127.0.0.1` 与 `[::1]` 在相同协议及端口下互通；其他站点仍须匹配配置的公开地址。Cookie 和 CSRF 检查保持启用。

课程列表未提供进度时，宿主只复用显式读取目录后缓存的进度，不在获取课程列表时扫描全部课程。读取目录且全部单元状态已知时，以已完成单元数除以总单元数缓存 `progress`，列表附加 `progress_source: "units"`。此值是目录完成度，不代表平台成绩或视频观看时长。结果按用户、平台会话和课程缓存一分钟；没有缓存或存在未知状态时保留空进度。相同会话、方法与课程的并发目录请求共用一次分页扫描；失败后可重新查询。


## 站点管理

`/api/admin/*` 仅管理员可访问，所有写入须提供 CSRF 并通过来源检查。普通成员的 `/api/tasks/*` 始终只处理自己的任务。

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/overview` | 启用用户、任务状态与模块概况 |
| `GET /api/admin/users` | 用户列表、任务数量、管理上限和当前有效并发，不含密码哈希 |
| `POST /api/admin/users` | 以 `username`、`password`、`role` 创建账号，无需邀请码 |
| `POST /api/admin/users/:id/status` | 设置布尔值 `disabled`，停用时撤销会话并暂停未结束任务 |
| `POST /api/admin/users/:id/password` | 设置 `password` 并撤销此用户所有站点会话 |
| `POST /api/admin/users/:id/role` | 设置 `role: user 或 admin`；不能降低自己的角色 |
| `POST /api/admin/users/:id/limit` | 设置 `limit: 1–8`，或 `null` 恢复站点默认 |
| `POST /api/admin/users/:id/pause-tasks`、`stop-tasks` | 暂停或停止该用户的全部未结束任务 |
| `GET/POST /api/admin/settings` | 读取或保存 `max_concurrency`、`parallel_study` |
| `GET /api/admin/tasks` | `owner`、`state` 过滤；`offset` 分页，每页 100 项，返回 `total`、`offset`、`limit` |
| `GET /api/admin/tasks/:id` | 任务概况和最近事件，不返回作答正文或凭据 |
| `POST /api/admin/tasks/:id/:action` | `pause`、`resume`、`stop` 或 `move`；排序提供 `direction: up 或 down` |
| `GET /api/admin/tasks/:id/logs` | 下载该任务的纯文本日志 |

管理任务操作同时记录操作者与任务事件。管理员上限和并行许可存于现有 `site_settings`，无需数据库结构或模块协议迁移。默认值保留原有 1–8 项个人并发设置；调度器对停用账号拒绝创建和继续任务。

## 纯文本日志

`/api/logs/export`、`/api/tasks/:id/logs`、`/api/tasks/:id/export` 和 `/api/history/export` 均返回 `text/plain; charset=utf-8`、`.log` 附件与 `Cache-Control: no-store`。管理员可使用 `kind=site_tasks` 导出全站任务日志；成员只能导出自己的任务。任务记录仅接受省略格式或 `format=log/txt`，旧的 `md/docx/json/csv` 参数返回 400。课程记录可通过 `platform`、`course`、`recruit` 过滤，标识须按查询参数编码；所有范围始终受账号权限限制。

试卷和成绩单属于课程数据导出，继续使用各自的格式接口，与执行日志分开。
