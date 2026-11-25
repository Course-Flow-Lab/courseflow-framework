#!/usr/bin/env python3
"""Export committed sources, build digest-pinned images, and save a private release bundle."""
import argparse
import concurrent.futures
import datetime
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument('--output', type=Path, required=True)
    for component in ('framework', 'webui', 'zhs', 'cx'):
        parser.add_argument('--' + component + '-ref', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    output = args.output.expanduser().resolve()
    workspace = args.workspace.resolve()
    directories = dict(framework='courseflow-framework', webui='courseflow-webui',
                       zhs='courseflow-zhs', cx='courseflow-chaoxing')
    for name in directories.values():
        if output.is_relative_to(workspace / name):
            parser.error('Release output must be outside source repositories')
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'release.json').exists():
        parser.error('Output already contains a completed release; choose a new directory')
    context = output / 'context'
    context.mkdir(exist_ok=True)
    revisions = {}
    for component, directory in directories.items():
        repo = workspace / directory
        revision = subprocess.check_output(['git', '-C', str(repo), 'rev-parse',
                                            getattr(args, component + '_ref') + '^{commit}'], text=True).strip()
        revisions[component] = revision
        destination = context / ('framework' if component == 'framework' else directory)
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir()
        archive = subprocess.check_output(['git', '-C', str(repo), 'archive', revision])
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(destination, filter='data')
    assets = workspace / 'courseflow-framework/deploy/docker'
    deployment_hashes = {p.name: digest(p) for p in sorted(assets.iterdir()) if p.is_file()}
    shutil.copytree(assets, context / 'deploy', dirs_exist_ok=True)
    shutil.copy2(assets / 'context.dockerignore', context / '.dockerignore')
    webui = context / 'courseflow-webui'
    web_source = workspace / 'courseflow-webui'
    for relative in ('Dockerfile', '.dockerignore', 'deploy/docker-nginx.conf'):
        shutil.copy2(web_source / relative, webui / relative)
        deployment_hashes['webui/' + relative] = digest(web_source / relative)
    bases = {}
    for name, tag in dict(node='node:24-bookworm-slim', rust='rust:1.88-bookworm', nginx='nginx:stable-alpine').items():
        try:
            inspect = subprocess.check_output(['docker', 'image', 'inspect', tag], text=True, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError:
            run('docker', 'pull', '--platform', 'linux/amd64', tag)
            inspect = subprocess.check_output(['docker', 'image', 'inspect', tag], text=True)
        info = json.loads(inspect)[0]
        if info['Architecture'] != 'amd64':
            raise RuntimeError('Expected amd64 base image: ' + tag)
        bases[name] = info['RepoDigests'][0]
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    tag = stamp + '-' + '-'.join(k + v[:7] for k, v in revisions.items())
    images = dict(api='courseflow-api:' + tag, web='courseflow-webui:' + tag)
    env = dict(os.environ)
    # The standard builder supports this Dockerfile without requiring a host plugin.
    if subprocess.run(['docker', 'buildx', 'version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        env['DOCKER_BUILDKIT'] = '0'
    def build(service):
        command = ['docker', 'build', '--platform', 'linux/amd64', '--tag', images[service],
                   '--iidfile', str(output / (service + '.iid')),
                   '--build-arg', 'NODE_IMAGE=' + bases['node']]
        if service == 'api':
            command += ['--build-arg', 'RUST_IMAGE=' + bases['rust'],
                        '--build-arg', 'FRAMEWORK_REVISION=' + revisions['framework'],
                        '--build-arg', 'ZHS_REVISION=' + revisions['zhs'],
                        '--build-arg', 'CX_REVISION=' + revisions['cx'],
                        '--target', 'runtime', '-f', str(context / 'deploy/Dockerfile'), str(context)]
        else:
            command += ['--build-arg', 'NGINX_IMAGE=' + bases['nginx'],
                        '--build-arg', 'WEBUI_REVISION=' + revisions['webui'], str(webui)]
        with (output / (service + '-build.log')).open('w') as log:
            subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        print(service + ' image built', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(build, service) for service in images]
        errors = []
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except Exception as error:
                errors.append(error)
        if errors:
            raise RuntimeError('Image build failed; inspect *-build.log') from errors[0]
    for name in ('compose.yml', 'chromium-seccomp.json', 'backup.sh', 'README.md',
                 'SECCOMP-NOTICE.md', 'SECCOMP-LICENSE'):
        shutil.copy2(context / 'deploy' / name, output / name)
        (output / name).chmod(0o700 if name == 'backup.sh' else 0o600)
    (output / 'release.env').write_text('API_IMAGE=' + images['api'] + '\nWEB_IMAGE=' + images['web'] + '\n')
    archive = output / 'images.tar.gz'
    process = subprocess.Popen(['docker', 'save', *images.values()], stdout=subprocess.PIPE)
    with archive.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', compresslevel=1, mtime=0) as zipped:
        shutil.copyfileobj(process.stdout, zipped, 1024 * 1024)
    if process.wait():
        raise RuntimeError('docker save failed')
    manifest = dict(created_at=stamp, platform='linux/amd64', revisions=revisions,
                    base_images=bases, deployment_assets_sha256=deployment_hashes,
                    images={k: dict(tag=v, id=(output / (k + '.iid')).read_text().strip()) for k, v in images.items()},
                    archive_sha256=digest(archive))
    (output / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
    names = ('images.tar.gz', 'release.json', 'release.env', 'compose.yml',
             'chromium-seccomp.json', 'backup.sh', 'README.md', 'SECCOMP-NOTICE.md', 'SECCOMP-LICENSE')
    (output / 'SHA256SUMS').write_text(''.join(digest(output / name) + '  ' + name + '\n' for name in names))
    print('Release bundle: ' + str(output), flush=True)


if __name__ == '__main__':
    main()
