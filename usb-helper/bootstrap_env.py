"""Create a private, hash-locked environment; never modify system Python."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parent
    cache = Path(os.environ['LAUNCHPAD_HELPER_CACHE'])
    uv = os.environ['LAUNCHPAD_UV']
    lock = root / 'requirements.lock'
    digest = hashlib.sha256(lock.read_bytes()).hexdigest()[:16]
    env = cache / f'env-{sys.version_info.major}.{sys.version_info.minor}-{digest}'
    python = env / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    marker = env / '.complete'
    if not marker.exists():
        print('正在准备独立的 esptool 环境，首次运行需要联网…', flush=True)
        if not python.exists():
            subprocess.run([uv, 'venv', '--python', sys.executable, str(env)], check=True)
        subprocess.run([uv, 'pip', 'sync', '--python', str(python), '--require-hashes',
                        '--index-url', 'https://pypi.org/simple', str(lock)], check=True)
        marker.write_text(digest, encoding='ascii')
    if sys.argv[1:] == ['--self-test'] and (root / 'test_helper.py').is_file():
        command = [str(python), '-I', '-X', 'utf8', '-m', 'unittest', 'discover', '-s', str(root), '-p', 'test_*.py']
    elif sys.argv[1:] == ['--test-handoff'] and (root.parent / 'tests/handoff.spec.mjs').is_file():
        os.environ['HELPER_PYTHON'] = str(python)
        command = ['npm.cmd' if os.name == 'nt' else 'npm', 'run', 'test:handoff']
        os.chdir(root.parent)
    else:
        arguments = sys.argv[1:]
        register_only = arguments == ['--register-launcher']
        skip = any(flag in arguments for flag in ['--doctor', '--prepare-only', '--serve-only', '--no-register'])
        site = root / 'site'
        if '--site-dir' in arguments:
            site = Path(arguments[arguments.index('--site-dir') + 1]).resolve()
        if register_only or (not skip and (site / 'index.html').is_file()):
            result = subprocess.run([str(python), '-I', '-X', 'utf8', str(root / 'protocol.py'), '--site-dir', str(site)])
            if register_only:
                return result.returncode
            if result.returncode:
                print('网页唤起入口注册失败；本次继续手动启动助手。', flush=True)
        command = [str(python), '-I', '-X', 'utf8', str(root / 'helper.py'), *[a for a in arguments if a != '--no-register']]
    result = subprocess.run(command)
    return result.returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, subprocess.CalledProcessError) as error:
        print(f'环境准备失败：{error}\n请检查网络后重新运行。已下载的缓存会保留。', file=sys.stderr)
        sys.exit(1)
