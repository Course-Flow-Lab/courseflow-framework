# Web API 与后端嵌入

Framework 是后端，WebUI 是独立客户端。后端不提供根页面或静态资源，只提供 `/api/*` 与 `/healthz`。静态资源托管、监听端口、进程信号和未来 App 的窗口生命周期由外层入口负责。

## 接口契约

- `/api/bootstrap` 无需登录，返回站点初始化状态、注册策略、能力和 `web_api_version: 1`。`/healthz` 同样提供该字段，便于核对发布版本。
- `module_api` 表示平台模块 RPC 版本，与 Web API 独立。当前 WebUI 仅接受数字 `web_api_version: 1`；缺失或不匹配时显示兼容性提示。
- 现有 API 路径和响应结构保持不变。未来兼容增加字段不提升主版本；破坏客户端兼容性的调整必须更新 Web API 版本并配套发布前端。
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
  try { await http.close(); } finally { await runtime.close(); }
}
```

只需要后端服务时直接调用 `createRuntime(runtimeConfig)`；配置只需数据路径、日志级别和夜间临时覆盖，不需要绑定地址或公开 URL。模块 CLI 使用 `recoverTasks: false`，避免操作模块列表时改写运行中任务状态。运行时关闭可重复调用，即使某个停止步骤失败，也会继续释放剩余资源。

本轮不改动模块运行器、模块协议、数据库结构或内置题库接口。未来 App 可在此基础上组合独立前端与后端，不要求引入桌面 SDK、手机 SDK 或额外服务进程。
