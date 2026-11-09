import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, bindAddress } from './core/config.ts';
import { configureProxy } from './core/network.ts';
import { createRuntime, VERSION } from './runtime.ts';
import { randomToken } from './core/domain.ts';
import { importStudia } from './core/studia-import.ts';

const HELP = `Courseflow framework ${VERSION}

用法：
  courseflow serve                         启动 HTTP 服务（默认）
  courseflow module list                   列出已安装模块
  courseflow module add <目录|.tgz>        安装或升级模块
  courseflow module enable <id>            启用模块
  courseflow module disable <id>           停用模块
  courseflow module remove <id>            卸载模块
  courseflow module config <id> <json>     设置模块配置并重启
  courseflow doctor                        打印数据目录与配置
  courseflow migrate legacy --source <旧目录> --destination <全新目录> [--key-file <旧密钥>] [--dry-run]

配置（环境变量）：
  CF_BIND         127.0.0.1:8099
  CF_PUBLIC_URL   http://127.0.0.1:8099
  CF_DATA_DIR     $XDG_DATA_HOME/courseflow 或 ~/.local/share/courseflow
  CF_LOG          info | debug | warn | error

首次启动会在终端打印一次性管理员设置码。运行数据必须放在源码目录之外。`;

async function main(): Promise<void> {
  configureProxy();
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'serve';
  if (command === 'migrate') {
    if (!['legacy', 'studia'].includes(argv[1] ?? '')) throw new Error('迁移来源目前仅支持旧站点格式');
    const argument = (name: string) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
    const source = argument('--source'), destination = argument('--destination');
    if (!source || !destination) throw new Error('请显式指定 --source 和 --destination，目标必须是全新目录');
    console.log(JSON.stringify(await importStudia({ source, destination, keyFile: argument('--key-file'), username: argument('--username'), passwordFile: argument('--password-file'), legacyOwner: argument('--legacy-owner'), dryRun: argv.includes('--dry-run') }), null, 2));
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return;
  }
  const config = loadConfig();

  if (command === 'doctor') {
    console.log(
      JSON.stringify(
        {
          version: VERSION,
          data_dir: config.dataDir,
          database: config.dbPath,
          key: config.keyPath,
          modules: config.modulesDir,
          bind: config.bind,
          public_url: config.publicUrl,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'module') {
    const runtime = await createRuntime(config, { recoverTasks: false });
    try {
      const action = argv[1];
      const target = argv[2];
      if (action === 'list') {
        for (const row of runtime.manager.list()) {
          console.log(
            `${row.id.padEnd(12)} ${row.version.padEnd(8)} ${row.engine.padEnd(6)} ` +
              `${row.enabled === 1 ? '已启用' : '已停用'} ${row.running ? '运行中' : '已停止'} ` +
              `${row.sha256.slice(0, 12)} ${row.manifestJson.name}`,
          );
        }
        return;
      }
      if (action === 'add') {
        if (!target) throw new Error('用法：courseflow module add <目录|.tgz>');
        const row = runtime.manager.install(target);
        console.log(`已安装 ${row.id} ${row.version}（${row.sha256.slice(0, 12)}…）`);
        return;
      }
      if (action === 'enable' || action === 'disable') {
        if (!target) throw new Error(`用法：courseflow module ${action} <id>`);
        runtime.manager.setEnabled(target, action === 'enable');
        console.log(`${target} ${action === 'enable' ? '已启用' : '已停用'}`);
        return;
      }
      if (action === 'remove') {
        if (!target) throw new Error('用法：courseflow module remove <id>');
        runtime.manager.remove(target);
        console.log(`${target} 已卸载`);
        return;
      }
      if (action === 'config') {
        const raw = argv[3];
        if (!target || !raw) throw new Error('用法：courseflow module config <id> <json>');
        runtime.manager.configure(target, JSON.parse(raw) as Record<string, unknown>);
        console.log(`${target} 配置已更新`);
        return;
      }
      console.log(HELP);
      return;
    } finally {
      await runtime.close();
    }
  }

  const { createHttpServer } = await import('./server/app.ts');
  const runtime = await createRuntime(config);
  const setupCode = randomToken().slice(0, 32);
  const app = createHttpServer(runtime, { ...config, setupCode });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await app.close(); } finally { await runtime.close(); }
  })();
  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\n收到 ${signal}，正在关闭…\n`);
    try { await close(); process.exitCode = 0; }
    catch (error) { process.stderr.write(`关闭失败：${(error as Error).message}\n`); process.exitCode = 1; }
  };
  const onInterrupt = () => void shutdown('SIGINT');
  const onTerminate = () => void shutdown('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    if (runtime.db.get('SELECT 1 FROM users LIMIT 1') === undefined) {
      // First-run credential: terminal only, never exposed through an API.
      process.stderr.write(`\nCourseflow 管理员设置码：${setupCode}\n\n`);
    }
    for (const row of runtime.manager.list()) {
      if (row.enabled === 1) {
        try {
          await runtime.manager.describe(row.id);
        } catch (error) {
          process.stderr.write(`模块 ${row.id} 未能加载：${(error as Error).message}\n`);
        }
      }
    }
    const { host, port } = bindAddress(config.bind);
    await app.listen({ host, port });
    process.stderr.write(`Courseflow 已监听 ${config.publicUrl}（数据目录 ${config.dataDir}）\n`);
    if (fs.existsSync(path.join(config.modulesDir))) {
      process.stderr.write(`模块目录 ${config.modulesDir}\n`);
    }
  } catch (error) {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    await close();
    throw error;
  }
}

main().catch((error: Error) => {
  process.stderr.write(`启动失败：${error.message}\n`);
  process.exit(1);
});
