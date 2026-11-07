import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, bindAddress } from './core/config.ts';
import { createRuntime, VERSION } from './runtime.ts';

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

配置（环境变量）：
  CF_BIND         127.0.0.1:8099
  CF_PUBLIC_URL   http://127.0.0.1:8099
  CF_DATA_DIR     $XDG_DATA_HOME/courseflow 或 ~/.local/share/courseflow
  CF_LOG          info | debug | warn | error

首次启动会在终端打印一次性管理员设置码。运行数据必须放在源码目录之外。`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'serve';
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

  const runtime = await createRuntime(config);
  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\n收到 ${signal}，正在关闭…\n`);
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (runtime.db.get('SELECT 1 FROM users LIMIT 1') === undefined) {
    // First-run credential: terminal only, never exposed through an API.
    process.stderr.write(`\nCourseflow 管理员设置码：${runtime.setupCode}\n\n`);
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
  await runtime.app.listen({ host, port });
  process.stderr.write(`Courseflow 已监听 ${config.publicUrl}（数据目录 ${config.dataDir}）\n`);
  if (fs.existsSync(path.join(config.modulesDir))) {
    process.stderr.write(`模块目录 ${config.modulesDir}\n`);
  }
}

main().catch((error: Error) => {
  process.stderr.write(`启动失败：${error.message}\n`);
  process.exit(1);
});
