# Courseflow 模块 API v1

本文描述框架与独立平台模块之间的实际协议。当前框架 `0.1.5` 仅支持 `moduleApi: 1`。新增可选方法使用框架版本范围控制兼容性，不承诺尚未实现的上一代主版本兼容。

模块是常驻子进程，stdin／stdout 使用 UTF-8、每行一个 JSON 对象的 JSON-RPC 2.0。`error.code` 使用稳定字符串；通知没有 `id`。stdout 只能输出协议，日志写 stderr。模块的网络、状态、模型和浏览器操作经宿主服务调用。

## 清单与安装

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
    "operations": ["study", "answer"],
    "unit_kinds": ["video", "document"],
    "max_speed": 1.5,
    "keepalive_seconds": 300,
    "presentation": {
      "tabs": [{ "id": "answer", "label": "作业与考试" }],
      "actions": [{ "id": "trial", "label": "短时试跑", "when": { "course.kind": "shared" } }]
    }
  },
  "permissions": {
    "network": ["example.com", "*.example.com"],
    "browser": false,
    "ai": true,
    "storage": "module"
  }
}
```

- `id` 与 `platform.id` 相同，格式为小写字母开头的 2–32 位字母、数字、下划线或连字符。
- `runtime.engine` 为 `node` 或 `binary`；入口和额外文件只能是模块目录内的相对路径。
- 框架版本范围不能为 `*`。当前使用基本语义版本比较器，支持比较运算和 `^`；不要假设完整 npm 范围语法。
- 网络权限是精确主机或 `*.` 子域规则，不是 URL。根域名与子域规则需要分别声明。
- `when` 由框架判断，仅支持 `course.kind`、`course.family` 的字符串相等；未知条件拒绝安装。
- 可选 `keepalive_seconds` 为不小于 60 的整数。宿主定期对已连接用户调用 `auth.keepalive`，模块应仅刷新登录状态，不发学习写入。

目录安装仅复制清单、入口和 `runtime.files`。npm 格式 `.tgz` 使用 `package/` 根目录。框架固定声明文件的 sha256，保存至数据库的模块安装记录，启动时复核内容。

Node.js 使用权限模型限制文件、网络和子进程。二进制直接作为可信进程运行，协议权限不是操作系统沙箱；不能据此承诺恶意二进制无法读取主机文件。浏览器脚本同样属于可信模块代码。

## 消息与生命周期

```json
{"jsonrpc":"2.0","id":7,"method":"catalog.courses","params":{"session":"s_示例"}}
{"jsonrpc":"2.0","id":7,"result":{"courses":[]}}
{"jsonrpc":"2.0","id":8,"error":{"code":"platform_login_expired","message":"平台登录已过期"}}
{"jsonrpc":"2.0","method":"cw.log","params":{"level":"info","message":"已读取课程"}}
```

请求编号为各方向独立的正整数。进程启动后立即握手，`platform.describe` 超时五秒；普通模块调用超时三十秒，连续超时会终止进程。长任务必须分步骤返回检查点，不能在一次调用内等待整段视频或逐题串行完成整张长试卷。

运行环境包含必要的 `PATH`、`TZ=UTC`、`CF_MODULE_ID`、`CF_MODULE_SETTINGS`。框架每模块保留一个进程；崩溃后按 1、2、5、15、30 秒退避，达到上限等待管理员重新启用。停止先关闭输入并发 SIGTERM，超时再 SIGKILL。

## 框架调用模块

所有认证流量使用宿主签发的不透明 `session`：扫码挑战为 `ch_…`，普通连接为 `s_…`，绑定任务代次的能力句柄为 `j_…`。模块不得解释或自行构造句柄。重新连接后旧句柄失效，任务暂停或停止后旧代次不能访问平台。

### 描述与认证

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `platform.describe` | `module_api`、`framework_version`、`limits.call_timeout_ms` | `module:{name,version,module_api}` 和与清单一致的 `platform` |
| `auth.begin` | `method`、`session` | `challenge:{id,kind,image,expires_at,fields?}` |
| `auth.submit` | `challenge`、`session`、`fields` | `state`：`waiting/connected/failed/expired`，可带 `message` |
| `auth.poll` | `challenge`、`session` | `state`：`waiting/scanned/connected/expired/failed` |
| `auth.complete` | `challenge`、`session` | `display_name`、稳定平台用户标识 `account_raw` |
| `auth.verify` | `session` | 连接身份信息 |
| `auth.keepalive` | `session` | 平台自定义的只读保活结果 |

框架根据平台标识和 `account_raw` 生成账号指纹，扫码 Cookie 由框架保存。`account_raw` 是平台用户标识，不是密码、Cookie 或访问令牌。

`platform.login` 包含 `password` 时，`auth.begin` 应返回 `kind:"password"` 的挑战，并可用 `fields` 描述表单：

```json
{
  "challenge": {
    "id": "ch_…",
    "kind": "password",
    "expires_at": 1700000000,
    "fields": [
      { "name": "username", "label": "账号", "type": "text", "required": true },
      { "name": "password", "label": "密码", "type": "password", "required": true }
    ]
  }
}
```

网页按 `fields` 生成表单，提交到 `POST /api/platforms/:pid/login/:id/submit`，框架再调用模块的 `auth.submit`。凭据只在登录交换期间传给模块，框架不持久化；模块不得记录、缓存或写入 `cw.state`。`auth.submit` 返回 `waiting` 后继续 `auth.poll`；`failed` 时保留挑战供用户重试。

当前网页提供 `qr` 与 `password` 两种登录入口；`browser` 仍保留在协议类型中，尚未提供网页入口。

### 课程与学习

```jsonc
// catalog.courses {session}
{"courses": []}
// catalog.units {session, course}
{"units": []}
// study.step {session, course, unit, checkpoint:null, options:{}}
{"status":"in_progress","progress":{"watched_seconds":30},"wait_ms":30000,"checkpoint":{}}
{"status":"completed","evidence":{"platform_confirmed":true},"checkpoint":{}}
{"status":"needs_ai","questions":[],"reason":"视频弹题需要作答","checkpoint":{}}
{"status":"needs_human","reason":"需要在官方页面处理验证","checkpoint":{}}
{"status":"blocked","reason":"尚未开放","checkpoint":{}}
{"status":"unknown","reason":"保存结果待核对","checkpoint":{}}
```

`checkpoint` 加密落盘后原样传回模块，所有状态都可以返回检查点。`wait_ms` 由宿主限制在六十秒内，等待可取消。模块应先按真实时间等待，再保存进度；任务继续时通过 `options.execution_id` 识别新的执行轮次，不能把暂停时间计入观看时间。

通用选项包括 `operation:study/trial/review`、`speedup`、`max_speed`、`execution_id`、`limit_seconds`、`review_seconds`、`interaction_answers`。速度默认 1，显式允许时最高 1.5；复习固定 1。真实平台的 `completed` 必须以回读或可核验状态为依据；fixture 可返回明确标记的离线证据。

框架 0.1.5 起，`catalog.courses`、`catalog.units`、`catalog.papers` 可返回 `next_cursor`。宿主在下一次调用附带 `cursor`，按顺序合并同名数组；省略或返回 `null` 表示结束。每次调用仍须三十秒内完成，不分页的现有模块无需修改。单次聚合最多两千页、两万项，游标序列化最多 8192 字节；重复游标停止并报错，每页请求前重新检查会话。

### 试卷与作答扩展

| 方法 | 关键参数 | 结果 |
| --- | --- | --- |
| `catalog.papers` | `session,course` | `papers:Paper[]` |
| `catalog.mastery` | `session,course` | `papers:Paper[]` |
| `exam.open` | `paper_id,request_id,continuation?` | `ready,cursor?,attempt` |
| `exam.review` | `paper_id,request_id` | 已提交试卷的只读 `ready,attempt` |
| `exam.redo` | `paper_id,request_id` | 显式重做后的 `ready,attempt` |
| `exam.write` | `attempt_id,answers,preserve_ids?,phase,cursor?` | `done,cursor,draft_supported?` |
| `exam.heartbeat` | `attempt_id,seconds` | `ok` |
| `exam.readback` | `attempt_id` | `confirmed,attempt_id,score?,graded_answers?,review?` |

除特别说明外都携带 `session,course,operation`。`request_id` 固定到任务和轮次，开卷前保存意图；分段读取必须使用同一缓存，`continuation:true` 不得另开作答。`ready:false` 表示还未读齐题目，宿主继续读取，不提前生成或保存答案。

`answers` 为题目编号到字符串数组的映射。`phase` 为 `draft` 或 `submit`。草稿分批执行，每次只发一批并返回游标；`preserve_ids` 排除平台原有作答。掌握度不支持草稿时返回 `draft_supported:false`，仍等待用户确认后提交。

宿主在交卷前持久化操作锁。模块不能把 HTTP 应答视为已确认提交；回读必须返回原 `attempt_id`。`graded_answers` 只能包含平台公开或已判为正确的答案。已提交内容不得通过写入式开卷接口读取。

### 课程活动扩展

| 方法 | 参数／结果 |
| --- | --- |
| `catalog.meetings` | `{session,course}` → `{meetings:[{id,name,replay_available,…}]}` |
| `catalog.score` | `{session,course}` → `{rules,scores,habit,interactive,qa?}` |
| `qa.board` | `{session,course,page?,cursor?}` → `{ready,page,posts,cursor?}` |
| `qa.posts` | `{session,course}` → `{posts}`，仅当前账号及课程 |
| `activity.step` | `{session,course,operation,item_id,checkpoint,options}` → 与学习步骤相同的状态结构 |

问答模型生成与平台写入分开。`needs_ai` 可返回 `prompt`，宿主生成后把 `generated` 放回活动检查点；生成失败等待人工填写。`ask` 的 `options.texts` 必须是用户检查并选中的草稿。

框架 0.1.3 起，见面课的 `needs_human` 会暂停保留当前项，供用户核对后继续；`blocked` 才表示该项无法自动处理并保存跳过原因。`activity.step` 可选返回 `diagnostic` 对象，宿主在内容变化时保存为任务事件并允许导出。诊断只能包含等待阶段、布尔就绪条件和媒体状态等无凭据信息，不得含账号、Cookie、完整页面或带令牌的地址。

发布前保存意图，响应未确认或缺少平台记录编号时返回 `unknown`，不能自动重新发送。同课程互助为双方显式开启的可选行为。

## 模块调用宿主

### `cw.net.fetch`

```json
{
  "session":"j_示例",
  "method":"POST",
  "url":"https://example.com/api",
  "headers":{"Origin":"https://example.com"},
  "body":{"key":"value"},
  "encoding":"json",
  "stage":"save_study",
  "commit":true
}
```

结果为 `{status,headers,body}`，`body` 是 UTF-8 字符串。编码支持 `raw/json/form/query`；阶段为 `read/open_study/save_study/submit`，默认 `read`。用户启用夜间暂停时，非只读阶段在北京时间 23:00–07:00 拒绝；关闭后按正常任务权限执行。

宿主注入对应会话的 Cookie 和令牌，拒绝模块设置 Cookie、Host、Content-Length，限制重定向次数，并在每次跳转前重新检查域名与任务状态。响应最多八 MB。401 映射为登录过期，403／418／429 映射为平台验证。

宿主保存 Cookie 的主机作用范围：没有 `Domain` 属性时只匹配原主机，显式 `Domain` 时匹配该域及子域。传入 Chromium 时保留这一区别，域 Cookie 使用前导点；旧会话缺少 `host_only` 字段时沿用原有的域匹配语义。模块不能读取 Cookie 容器。

请求头的值支持 `${cookie:NAME}` 占位符。宿主在发送前用当前会话中匹配目标主机、路径且未过期的 Cookie 值替换；只替换请求头，不处理 URL 和请求体。占位符缺失时返回 `platform_login_expired`。模块因此可以使用由 Cookie 派生的签名或令牌，而仍然拿不到完整 Cookie 罐。

`commit:true` 在发送前写入通用请求台账，记录应答或未知状态；台账本身不等于业务操作的自动去重锁。交卷使用持久化业务锁，问答使用模块发布意图，不能依赖 HTTP 自动重试实现恢复。

### `cw.state`

```jsonc
// 读取，结果为 {value:任意值或null}
{"namespace":"study","key":"queue","session":"j_示例"}
// 写入，结果为 {}
{"namespace":"study","key":"queue","value":{},"session":"j_示例"}
```

作用域为模块、站点用户、命名空间及键，内容加密存储。存在 `value` 表示写入。`cw.state.get` 和 `cw.state.set` 为显式别名。原生平台记录和签名参数放在此处，不泄漏到公共 DTO。

### 题库宿主服务（框架 ≥ 0.1.5）

清单可选 `permissions.question_bank`，默认 `false`。声明后，完成登录的模块可以使用以下服务：

| 方法 | 参数／结果 |
| --- | --- |
| `cw.question_bank.lookup` | `{session,course,question,course_kind?}` → `{correct:string[]或null,wrong:string[][],updated_at:number或null}` |
| `cw.question_bank.record` | `{session,course,question,answer,evidence}` → `{ok:true}` |

`course` 建议使用 `课程编号/班级编号`；`question` 使用公共题目类型的题干、题型、选项、图片和空数。`evidence` 为 `{result:"correct"或"incorrect",source:"platform"或"reviewed",at?:Unix秒}`；模型或外部题库候选不能作为已确认记录写入。`course_kind` 仅辅助旧 Studia 智慧树指纹兼容，当前支持 `shared`、`smart`。

所属用户及平台从会话获取，传入 `owner` 不会改变作用域，未完成登录的挑战句柄不可使用题库。内容由宿主加密，选项改编号或顺序后按完整文字映射，重复文字拒绝复用，错误组合会撤销相同的旧正确记录。接口与外部适配器定义在独立 [courseflow-question-bank](https://github.com/Course-Flow-Lab/courseflow-question-bank) 仓库。

`cw.session.identity` 在登录挑战期间也可返回宿主已收到的公开身份：数值型 `_uid`／`UID` 对应 `user_id`，数值型 `fid` 对应 `organization_id`。不会返回原 Cookie、令牌或其他用户身份；完成连接前 `account_raw` 可以为空。

### 其他宿主服务

| 服务 | 参数与结果 |
| --- | --- |
| `cw.session.identity` | `{session}` → `{account_raw,display_name,connected_at,user_id?,organization_id?}`，不含 Cookie 或令牌 |
| `cw.clock.now` | `{}` → `{now}`，Unix 秒 |
| `cw.log` | 通知：`{level,message,fields?}`，不得含凭据 |
| `cw.ai.generate` | `{session,prompt}` → `{text}`；需要清单 `ai:true`，使用该用户选中的模型 |
| `cw.browser.open` | `{session,url,purpose?,observe_urls?}` → `{page}`；需要 `browser:true` |
| `cw.browser.evaluate` | `{session,page,expression,stage}` → JSON 可序列化的脚本结果 |
| `cw.browser.close` | `{session,page}` → `{}` |
| `cw.peers.record` | `{session,record}` → `{}`，加密保存已确认的平台发布编号 |
| `cw.peers.list` | `{session,course_id,recruit_id}` → `{questions:string[]}`，双方开启互助才返回同课程问题编号 |

浏览器页面绑定用户、平台和任务代次。`observe_urls` 可监听少量指定路径的官方响应，只向脚本提供加载或错误状态，不返回完整网络凭据。网页加载和媒体播放通过官方页面执行，模块不得伪造已完成签到。

浏览器非只读执行同样遵守所属用户的夜间暂停设置。`/api/bootstrap` 对已登录用户返回个人 `quiet_hours.enabled/active`；未登录时返回默认策略。偏好接口的 `quiet_hours` 为布尔值，默认 `true`。

模型请求使用独立 HTTP 调用，不携带平台 Cookie；模型密钥不通过 RPC 或网页回显。题图由宿主当前账号认证代理，公共路径为 `/api/media/<不透明编号>`。

## 公共数据类型

所有协议业务字段使用 `snake_case`。ID 始终是字符串；课程及班级 ID 不能用斜杠拼接后再拆分。

```ts
interface Course {
  id: string;
  recruit_id: string;
  name: string;
  kind: string;
  kind_label?: string;
  family?: string;
  progress?: number | null;
  outline_available: boolean;
}
interface Unit {
  id: string;
  name: string;
  chapter_id: string;
  chapter_name: string;
  lesson_id: string;
  kind: 'video' | 'audio' | 'document' | 'reading' | 'empty';
  duration_seconds?: number | null;
  watched_seconds?: number | null;
  state: 'not_started' | 'in_progress' | 'completed' | 'unknown';
  video_id?: string | null;
  selectable: boolean;
  selectable_note?: string;
}
interface Paper {
  id: string;
  name: string;
  category: string;
  available: boolean;
  done: boolean;
  can_redo?: boolean;
  can_review?: boolean;
  reason?: string;
  score?: number | null;
  attempts_left?: number | null;
  ends_at?: number | null;
}
interface Question {
  id: string;
  kind: 'single' | 'multiple' | 'judge' | 'blank' | 'essay' | 'unsupported';
  text: string;
  options: Array<{id: string; text: string}>;
  answer: string[];
  correct_answer?: string[];
  explanation?: string;
  images?: string[];
  blanks: number;
}
interface Attempt {
  id: string;
  paper_id: string;
  name: string;
  questions: Question[];
  expires_at: number | null;
}
```

通用宿主可展示更多题型；具体模块仅声明和编码已验证的题型。当前智慧树适配单选、多选和填空，其他题型明确等待官方页面处理，不猜测平台题型编号。公共 DTO 不含 `native` 字段。

## 错误与一致性检查

| 错误码 | 含义 |
| --- | --- |
| `unsupported_operation` | 未提供此方法 |
| `invalid_params` | 参数缺失或格式错误 |
| `platform_login_expired` | 登录过期 |
| `platform_verification_required` | 平台要求额外验证 |
| `platform_protocol_changed` | 响应格式无法识别 |
| `platform_rejected` | 平台拒绝操作 |
| `platform_unavailable` | 网络或平台暂不可用 |
| `no_questions` | 掌握度知识点暂无题目 |
| `not_found` | 当前账号的资源不存在 |
| `module_timeout/module_crashed/module_unavailable` | 模块执行异常 |
| `module_version_changed` | 任务固定的模块版本不再匹配 |
| `net_blocked/quiet_hours/task_cancelled` | 权限、时间或执行代次拒绝 |
| `model_required/model_unavailable/model_not_ready/ai_unavailable/answer_format` | 模型配置、连接或答案格式问题 |
| `browser_unavailable/browser_timeout/browser_closed/browser_page_error` | 官方浏览器不可用或页面异常 |

模块应验证清单与描述一致、未知方法返回有类型错误、分步调用不超过三十秒、stdin 关闭可退出。至少提供一轮无网络、无真实账号的模拟宿主测试，并单独记录真实账号验收范围。
