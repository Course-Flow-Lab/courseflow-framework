# Studia 数据迁移

框架 0.1.5 新增 `migrate studia`。此前不能直接加载 Studia 数据；现在可以将其导入一个**尚不存在的全新目录**。工具不会合并或覆盖已有 Courseflow 数据，不启动平台请求、登录或学习任务。

## 多用户部署

来源是包含 `studia.db`、`users/` 的旧数据目录，早期 `accounts.json` 也受支持。加密配置需要原始 `secret.key`；若密钥保存在别处，通过 `--key-file` 指定。先停止旧服务或准备一致的完整备份，避免数据库和用户配置在复制时发生变化；SQLite 备份需包含尚未合并的 WAL 内容。

```sh
# 只读预检，不创建目标目录，不打印账号或模型凭据
npm run cli -- migrate studia \
  --source /旧备份/studia-data \
  --destination "$HOME/.local/share/courseflow-imported" \
  --key-file /私有目录/studia-secret.key --dry-run

# 去掉 --dry-run 后导入，仍不修改来源
npm run cli -- migrate studia \
  --source /旧备份/studia-data \
  --destination "$HOME/.local/share/courseflow-imported" \
  --key-file /私有目录/studia-secret.key
```

目标父目录须已存在，目标不能位于 Git 仓库或来源目录内。工具先检查和解密旧数据，再在私有临时目录创建新数据库，成功后整体发布到目标路径。错误密钥、格式异常或目标已存在时停止，不覆盖旧文件。

## 单用户配置

没有站点数据库的本机 `settings.json`／`settings.enc` 使用新站点管理员。将新密码单独写入权限为 0600 的文件，避免放进命令参数和历史记录。

```sh
npm run cli -- migrate studia \
  --source /旧本机配置目录 \
  --destination "$HOME/.local/share/courseflow-imported" \
  --username 管理员用户名 --password-file /私有目录/新站点密码
```

加密的单用户配置还需要 `--key-file`，以及 `--legacy-owner` 指定原加密 AAD 使用的用户编号。没有原密钥或原编号时不能恢复密文。单用户预检允许省略密码文件。

## 导入范围

| 数据 | 处理方式 |
| --- | --- |
| 站点账号 | 保留编号、用户名、角色、禁用状态和创建时间；要求至少一个可用管理员，用户名大小写冲突时停止 |
| 旧密码 | 保留受支持的 PBKDF2-SHA256／Argon2id 摘要，可用原密码登录；新注册仍要求至少十二个字符 |
| 个人模型、已启用共享模型 | 用新 Courseflow 主密钥重新加密；排除旧内置公共模型；不兼容配置只在加密档案中保留 |
| 并发、速度、夜间设置、互答标记 | 转换兼容的个人偏好；并发限制在 1–8，其他旧配置保存在加密档案 |
| 平台登录态 | 仅加密封存，不激活旧 Cookie；登录新站点后重新连接平台 |
| 旧答案记忆 | 加密保存数据库和用户 JSON 题库；智慧树可匹配的旧指纹按原课程范围复用，错误答案不会晋升为正确答案 |
| 旧 MOOC 题库 | 保留原始指纹档案；当前没有 MOOC 模块，暂不自动用于新模块 |
| 历史任务、问答记录、题目与导出报告 | `jobs.json`、`zhs-qa-posts.json`、`ai_results/`、`tiku/`、`exports/` 等按用户加密归档；不写入新任务队列、不重新发布内容 |
| 旧网页会话、邀请码、站点公告、全站调度策略 | 不激活或映射；在新系统重新设置注册策略和调度偏好 |

每个归档文件最多 32 MB，每用户最多 512 MB、两万个文件；不跟随符号链接。目标生成新的 `secret.key`，不要用旧密钥覆盖；后续备份同时保存新数据库和新密钥。迁移档案和运行数据不能提交到 Git。

成功后目标内有 `migration-report.json`，只含统计与处理方式。在单独的本机端口启动新站点检查：

```sh
CF_DATA_DIR="$HOME/.local/share/courseflow-imported" \
CF_BIND=127.0.0.1:8101 CF_PUBLIC_URL=http://127.0.0.1:8101 npm start
```

登录后，「模型与任务设置 → Studia 迁移档案」提供本用户档案的下载入口。JSON 导出隐藏凭据字段；原始配置和平台会话不提供网页下载。列表最多展示一百个文件，完整内容仍保存在加密数据库中。历史记录供查阅，不代表当前平台状态。

## 验证边界

离线测试覆盖只读预检、旧 AES-GCM 配置、旧密码登录、密钥重新加密、题库兼容、档案所有权、错误密钥与目标保护。测试只使用合成数据，没有读取真实账号目录，也没有向本机运行中的站点导入真实 Studia 数据。
