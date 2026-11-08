# Courseflow 题库接口

平台无关的题库接口与实现，供框架、平台模块和其他程序复用。Node.js SDK 无第三方依赖；其他语言可使用同一份 JSON 数据约定，经 Courseflow 宿主 RPC 调用。

## 职责

- `QuestionBankProvider`：查询外部题库或模型，返回经过题型验证的候选答案。
- `Transport`：由宿主发送请求及注入凭据；适配器只转换请求与响应，不保存密钥。
- `QuestionBank` 与 `Store`：保存平台判定或人工明确复核的正确／错误答案。候选答案不会自动进入已确认记忆。
- `Scope`：按所属用户、平台和课程隔离。题目身份包含题型、正文、选项文字、图片和填空数量；选项重新排序或更换编号后仍能正确映射。

选择题答案使用当前题目的选项编号；判断题使用 `true`／`false`；填空按空位顺序保存；简答使用单项字符串数组。重复的选项文字不会被猜测为可复用答案。错误组合最多保留二十组。

## 使用

```js
import { QuestionBank } from '@courseflow/question-bank';
const rows = new Map();
const bank = new QuestionBank({ get: key => rows.get(key), put: (key, value) => rows.set(key, value) });
const scope = { owner: '用户编号', platform: 'cx', course: '课程和班级编号' };
const question = { kind: 'single', text: '1 + 1 = ?', options: [{ id: 'A', text: '1' }, { id: 'B', text: '2' }], blanks: 0 };
bank.record(scope, question, ['B'], { result: 'correct', source: 'platform' });
console.log(bank.lookup(scope, question).correct);
```

生产环境的 `Store` 应由应用提供权限和加密；上面的内存存储仅演示接口。类型定义见 `index.d.ts`。

外部题库可实现 `QuestionBankProvider`，或使用 `createJsonProvider({ id, request, parse }, transport)`。`queryProviders` 按配置顺序查询，忽略格式不匹配的候选，并通过 `signal` 支持取消。协议、域名、用户自有凭据及请求限额由调用方决定，不内置某家供应商或共享密钥。

内置协议适配器为 `createYanxiProvider`、`createTikuAdapterProvider`、`createTikuLikeProvider`，均要求调用方显式指定地址和传输函数；需要 token 的服务也必须显式传入。地址使用 HTTPS，本机离线测试允许 HTTP。余额查询、token 轮换和模型计费属于调用方，不进入题目与答案接口。

```js
import { createTikuAdapterProvider, queryProviders } from '@courseflow/question-bank';
const provider = createTikuAdapterProvider({ url: 'https://题库服务地址/query' }, transport);
// transport(request, { signal }) 由宿主实现；返回已解析的 JSON
const result = await queryProviders([provider], question, { signal });
```

`candidate(question, raw)` 只匹配明确的选项编号或完整文字，判断题只接受明确的真假值。不使用相似度或随机答案兜底。SDK 自身不发送 HTTP、不配置模型、不执行作业提交；模型也可实现同一个 `QuestionBankProvider` 接口。

## Courseflow 模块 RPC

模块声明 `permissions.question_bank: true` 后，可调用：

- `cw.question_bank.lookup`：`{ session, course, question }` → `{ correct, wrong, updated_at }`。
- `cw.question_bank.record`：`{ session, course, question, answer, evidence }`；`evidence.result` 为 `correct` 或 `incorrect`，`evidence.source` 为 `platform` 或 `reviewed`。

所属用户和平台由宿主根据会话绑定，模块不能传入其他用户的范围。题库接口版本为 1，不包含作业保存或交卷能力。

Courseflow 框架 0.1.5 已把该 SDK 接入原有答案记忆和以上宿主服务，数据库继续由框架加密。框架带有本仓库 0.1.0 的固定源码副本，因此独立克隆框架即可安装；修改 SDK 后需同步副本并运行两侧测试。外部题库适配器供宿主或其他程序接入，当前框架界面尚未提供第三方题库配置页。

## 验证

```sh
npm test
```

测试全部离线，使用内存存储和假传输，不查询真实题库、不调用付费模型、不使用平台账号。
