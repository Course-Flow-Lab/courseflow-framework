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

模块运行方式和内置题库接口保持不变。语音转写是模块 API v1 的可选能力，原有模块不需要新增权限。未来 App 可在此基础上组合独立前端与后端，不要求引入桌面 SDK、手机 SDK 或额外服务进程。

### 本机来源与课程进度

当公开地址为本机地址时，来源检查允许 `localhost`、`127.0.0.1` 与 `[::1]` 在相同协议及端口下互通；其他站点仍须匹配配置的公开地址。Cookie 和 CSRF 检查保持启用。

课程列表未提供进度时，宿主只复用显式读取目录后缓存的进度，不在获取课程列表时扫描全部课程。目录接口在首次响应的 `course` 中即附加 `unit_progress: {completed,total,unknown}`；全部单元状态已知且非空时，以已完成单元数除以总单元数提供 `progress` 和 `progress_source: "units"`。此值是目录完成度，不代表平台成绩或视频观看时长；平台已提供的百分比（含 0）保持优先。存在未知状态时保留完成数量，不推断完整百分比。结果按用户、平台会话和课程缓存一分钟，供后续课程列表复用；前端将已读取的课程对象同步回同一平台、课程及班级的卡片。相同会话、方法与课程的并发目录请求共用一次分页扫描；失败后可重新查询。

当 `capabilities.deferred_study` 为 `true`，超星目录中标为 `selectable_after_unlock: true` 的章节可与普通单元一起放入 `POST /api/platforms/cx/courses/:id/:rid/study` 的 `unit_ids`。客户端和任务执行器按目录的 `chapter_order` 补选前序未完成的可学单元。平台解锁已选章节后，任务会用实际学习单元替换 `task.units` 中的章节占位。所选内容仍需解锁或人工处理时，处理后可继续原任务。

框架的 `capabilities.auto_prerequisite_quizzes` 和超星模块的同名课程操作均可用时，学习请求可传 `auto_prerequisite_quizzes: true`（`/jobs` 中放在 `options`）。此选项只对选中待解锁章节的超星学习任务生效。框架按目录顺序处理已学完章节中的前置任务点测验，并刷新解锁状态。交卷结果待确认时，框架继续平台已开放的所选内容，原答卷留在同一任务详情供回读。支持补交的超星模块会核对原答卷状态，确认仍为草稿时自动补交一次。


## 站点管理

`/api/admin/*` 仅管理员可访问，所有写入须提供 CSRF 并通过来源检查。普通成员的 `/api/tasks/*` 始终只处理自己的任务。

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/overview` | 启用用户、任务状态与模块概况 |
| `GET /api/admin/users` | 用户列表、任务数量、管理上限和当前有效并发，不含密码哈希 |
| `POST /api/admin/users` | 以 `username`、`password`、`role` 创建账号，无需邀请码 |
| `POST /api/admin/users/:id/status` | 设置布尔值 `disabled`，停用时撤销会话并暂停未结束任务 |
| `POST /api/admin/users/:id/password` | 设置 `password` 并撤销此用户所有站点会话 |
| `POST /api/admin/users/:id/role` | 设置 `role: user、team 或 admin`；不能降低自己的角色 |
| `POST /api/admin/users/:id/platform-account-limit` | 团队的跨平台账号总上限，`limit: 0–1000`，降低上限保留现有绑定 |
| `POST /api/admin/users/:id/limit` | 设置 `limit: 1–8`，或 `null` 恢复站点默认 |
| `POST /api/admin/users/:id/pause-tasks`、`stop-tasks` | 暂停或停止该用户的全部未结束任务 |
| `GET/POST /api/admin/settings` | 读取或保存 `max_concurrency`、`parallel_study` |
| `GET /api/admin/tasks` | `owner`、`state` 过滤；`sort: updated / created / oldest / state`，默认最近更新；`offset` 分页，每页 100 项，返回 `total`、`offset`、`limit`、`sort` |
| `GET /api/admin/tasks/:id` | 任务概况和最近事件，不返回作答正文或凭据 |
| `DELETE /api/admin/tasks/:id` | 删除任务及其本站输入、队列与事件；执行中的任务先停止，仍在退出的执行器与未核对交卷结果拒绝删除 |
| `POST /api/admin/tasks/:id/:action` | `pause`、`resume`、`stop`、`move` 或 `migrate`。排序提供 `direction`，迁移提供 `to_version` |
| `GET /api/admin/tasks/:id/logs` | 下载该任务的纯文本日志 |
| `POST/GET/DELETE /api/admin/captcha-test` | 启动、读取或关闭无账号的官方验证码拖动测试页面 |
| `POST /api/admin/captcha-test/input` | 向测试页面转发 `click` 或 `drag` 指针操作 |

管理任务操作记录操作者；删除记录保留在审计日志，独立写入凭证和交卷锁不随任务清除。删除只作用于本站，不删除平台进度或作答。排序在分页前完成，同值按创建时间和任务标识稳定排列，队列上移下移仍只控制所属用户的执行顺序。管理员上限和并行许可存于现有 `site_settings`，无需数据库结构或模块协议迁移。默认值保留原有 1–8 项个人并发设置；调度器对停用账号拒绝创建和继续任务。

## 模块升级后的任务迁移

暂停任务保存的模块版本与已安装版本不同时，任务响应附带 `module_update: { from_version, to_version, blocked_reason? }`。`blocked_reason` 表示需要先处理的情况，例如检查点不兼容或交卷结果待核对。

任务所有者调用 `POST /api/tasks/:id/migrate`，管理员可调用 `POST /api/admin/tasks/:id/migrate`。两者请求体均为 `{ "to_version": "0.3.9" }`。服务端重新检查目标版本、原账号、模块兼容性和提交状态。成功返回 `{ task }`，任务保持暂停，原检查点及执行记录保留。之后使用原 `resume` 接口继续。版本在操作前再次变化时返回 409 `module_version_changed`。

## 人工验证码

任务因官方验证码暂停自动处理时，若模块与宿主都支持人工转发，任务响应增加 `manual_captcha: true`，任务详情显示“等待人工完成验证码”。页面只在模块保留验证码期间可用，默认最多 300 秒。

| 接口 | 用途 |
| --- | --- |
| `GET /api/tasks/:id/captcha` | 返回官方验证码弹窗截图 `{state:"ready",image,mime,x,y,width,height}`；加载中为 `{state:"loading"}`，页面已关闭返回 404 |
| `POST /api/tasks/:id/captcha` | 转发指针操作，`{type:"click",x,y}` 或 `{type:"drag",from:{x,y},to:{x,y}}`；坐标是页面 CSS 像素，需要 CSRF |

只有任务所有者可读取或操作；管理员页面默认不代用户完成验证码。截图不包含 Cookie、令牌或弹窗之外的页面内容。用户操作后，模块仍必须通过平台 `validateSlideToken` 才恢复学习。

## 纯文本日志

`/api/logs/export`、`/api/tasks/:id/logs`、`/api/tasks/:id/export` 和 `/api/history/export` 均返回 `text/plain; charset=utf-8`、`.log` 附件与 `Cache-Control: no-store`。管理员可使用 `kind=site_tasks` 导出全站任务日志；成员只能导出自己的任务。任务记录仅接受省略格式或 `format=log/txt`，旧的 `md/docx/json/csv` 参数返回 400。课程记录可通过 `platform`、`course`、`recruit` 过滤，标识须按查询参数编码；所有范围始终受账号权限限制。

试卷和成绩单属于课程数据导出，继续使用各自的格式接口，与执行日志分开。

## 团队与平台绑定

管理员创建用户时，`role` 接受 `user`、`team`、`admin`；可提供数字 `platform_account_limit`，默认 10。公开注册忽略角色选择，仍只创建普通成员。用户列表为团队返回 `account_quota: {limit,used,remaining}`，其余用户为 `null`；响应还包含 `default_team_account_limit`。`/api/bootstrap` 的 `capabilities.team_accounts` 为 `true`。

`GET /api/platforms` 增加同一结构的 `account_quota`；团队的平台描述增加 `accounts: [{id,label,legacy,connected,display_name,connected_at}]`。已停用或卸载的平台若仍有绑定，也保留不可登录的管理卡片，方便移除并释放配额。绑定编号是不透明 ID，不包含平台账号或凭据。

| 接口 | 用途 |
| --- | --- |
| `POST /api/platforms/:pid/accounts` | 团队创建账号位，提供 `label`（1–60 字）；返回 `account` 和更新后的 `account_quota` |
| `DELETE /api/platforms/:pid/accounts/:account` | 移除自己的绑定，停止其未结束任务、撤销会话并释放名额；保留任务历史 |
| `/api/platforms/:pid/login` 及挑战的 `poll`、`submit` | 使用 `?account_id=绑定编号` 指定登录位置，挑战创建后不能切换绑定或平台 |
| `/api/platforms/:pid/disconnect` | 指定 `account_id` 撤销此绑定登录态并暂停任务，保留账号位 |
| `/api/platforms/:pid/courses/*` | 课程、目录、问答、成绩、任务、试卷及数据导出均使用 `account_id` 选择账号 |
| `/api/history/export` | 可同时提供 `platform`、`course`、`recruit` 和 `account_id`，仅导出当前绑定的课程日志 |

除升级前默认连接外，团队请求必须显式选择绑定；绑定必须属于当前用户及 URL 指定平台。所有写入沿用 Cookie、CSRF 和来源校验。新增达到总配额时返回 409 `platform_account_limit`；找不到自己的绑定返回 404；同一平台身份重复绑定返回 409 `platform_account_duplicate`。

任务响应增加 `account_id` 和 `account_label`。已有默认任务的编号为 `null`，继续使用原默认会话；新任务固定绑定，后续继续、补答、确认和回读使用任务记录，不读取界面的当前选择。题图路径已包含不可猜测标识，服务端校验其绑定所属用户，无需给媒体 URL 再传账号参数。

总配额包含未登录账号位。降低上限后保留已有账号，达到上限时禁止新增。已有成员改为团队会登记默认连接；仍有团队新增绑定时，改回其他角色返回 409 `team_accounts_remaining`。数据库版本 4 的升级与回退说明见 [团队账号](TEAM-ACCOUNTS.md)。
