# 框架内置题库

从框架 0.1.6 起，题库核心、加密持久化和数据源接口统一位于本目录。它随框架运行，不启动独立平台进程，不需要安装外部 SDK。管理员可在模块管理看到内置模块状态。

- `index.js`、`index.d.ts`：题目、存储、数据源接口及选项映射。
- `service.ts`：按用户、平台、课程隔离的加密记录，兼容已有答案数据。
- 平台模块不直接访问数据库，通过宿主 RPC 查询和确认答案。

## 模块接入

清单声明 `permissions.question_bank:true`，并要求框架 `>=0.1.6 <0.2.0`。模块使用当前连接或任务会话句柄；所属用户和平台由宿主绑定，不能通过参数更换。

```json
{"method":"cw.question_bank.confirm","params":{"session":"当前会话句柄","course":"课程编号/班级编号","question":{"id":"q1","kind":"single","text":"1 + 1 = ?","options":[{"id":"A","text":"1"},{"id":"B","text":"2"}],"blanks":0},"answer":["B"],"confirmation":{"confirmed":true,"source":"platform","reference":"平台作答或回读编号"}}}
```

只有平台明确判对或公开的标准答案可以这样确认。交卷成功、HTTP 成功、学生原答案、人工填入和模型猜测本身均不能证明答案正确。

`cw.question_bank.lookup {session,course,question,course_kind?}` 返回 `{correct,wrong,updated_at}`。选择题答案使用当前选项编号，内部按完整文字保存；选项换编号或顺序后可映射。判断题使用 `true/false`，填空保留空位顺序，重复文字的选择题拒绝猜测。

兼容接口 `cw.question_bank.record {session,course,question,answer,evidence}` 支持正确与错误组合，`evidence.result` 为 `correct/incorrect`，来源只能为 `platform/reviewed`。`reviewed` 仅用于明确复核过的答案，外部数据源及模型候选不会自动晋升为正确记录。

## 自动收集与复用

框架统一处理所有模块的 `Question.correct_answer`、确认回读后的 `graded_answers` 和复核标准答案。平台模块也可在自己的确认节点调用上述 RPC；智慧树模块已接入。平台没有公布正确答案时不推断或入库。

作业与视频弹题会优先复用同一用户、平台和课程内的已确认答案。原有学生作答仍按原规则保留，不因新增题库被静默覆盖。错误组合会撤销相同的旧正确答案；记录不能跨用户读取。

## 数据源扩展

`QuestionBankProvider`、`Transport`、`Store` 接口仍可复用。内置言溪、TikuAdapter、TikuLike 协议适配器使用调用方注入的请求和凭据，核心不自行出网；候选答案仅返回给调用方，不能充当平台确认。

测试位于框架 `test/question-bank-*.test.*`，全部使用内存、合成数据或无网络模块 RPC。代码采用 MIT 许可，见本目录 `LICENSE`。
