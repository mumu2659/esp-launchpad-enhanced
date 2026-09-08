"""Per-user URL launcher. URL input never becomes a command or helper argument."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys

SCHEME = 'esp-launchpad-enhanced'
APP_ID = 'io.github.esp-launchpad-enhanced.usb-helper'
SITE_FILES = ['index.html', 'helper-sw.js', 'enhanced/app.js', 'enhanced/core.mjs',
              'enhanced/handoff.mjs', 'enhanced/launcher.mjs','enhanced/monitor.mjs', 'enhanced/style.css',
              'node_modules/esptool-js/bundle.js', 'node_modules/js-md5/build/md5.min.js',
              'LICENSE', 'node_modules/esptool-js/LICENSE', 'node_modules/js-md5/LICENSE.txt']


def install_root():
    if sys.platform == 'darwin':
        return Path.home() / 'Library/Application Support/ESP Launchpad Enhanced'
    if os.name == 'nt':
        return Path(os.environ['LOCALAPPDATA']) / 'ESP-Launchpad-Enhanced/launcher'
    return Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'esp-launchpad-enhanced'


def launch_command(python, root):
    return [str(python), '-I', '-X', 'utf8', str(root / 'protocol.py'), '--launch']


def mac_script(command):
    # The only accepted URL is fixed; no URL content is interpolated into shell code.
    shell = shlex.join(command) + ' >/dev/null 2>&1 &'
    return ('on open location incoming\n'
            'if incoming is not "esp-launchpad-enhanced://recover" and incoming is not "esp-launchpad-enhanced://recover/" then return\n'
            'do shell script ' + json.dumps(shell) + '\nend open location\n')


def desktop_exec(command):
    # Desktop Entry quoting is not shell quoting; % must be escaped separately.
    def quote(value):
        value = str(value).replace('%', '%%')
        for char in ('\\', '"', '`', '$'):
            value = value.replace(char, '\\' + char)
        return '"' + value.replace('\\', '\\\\') + '"'
    return ' '.join(quote(arg) for arg in command)


def install(python, source, site, root=None):
    root = root or install_root()
    # Validate before replacing any installed files.
    for name in SITE_FILES:
        if not (site / name).is_file():
            raise RuntimeError('配套网页不完整，无法注册启动入口：' + name)
    root.mkdir(parents=True, exist_ok=True)
    for name in ['helper.py', 'protocol.py']:
        target = root / name
        if (source / name).resolve() != target.resolve():
            shutil.copy2(source / name, target)
    for name in SITE_FILES:
        target = root / 'site' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if (site / name).resolve() != target.resolve():
            shutil.copy2(site / name, target)
    command = launch_command(python, root)
    if sys.platform == 'darwin':
        app = root / 'ESP Launchpad Enhanced USB.app'
        script = mac_script(command)
        stamp = root / 'handler.applescript'
        if not app.exists() or not stamp.exists() or stamp.read_text() != script:
            subprocess.run(['osacompile', '-o', str(app), '-e', script], check=True, capture_output=True)
            stamp.write_text(script)
        info = app / 'Contents/Info.plist'
        data = plistlib.loads(info.read_bytes())
        data.update(CFBundleIdentifier=APP_ID, LSUIElement=True,
                    CFBundleURLTypes=[{'CFBundleURLName': APP_ID, 'CFBundleURLSchemes': [SCHEME]}])
        info.write_bytes(plistlib.dumps(data))
        subprocess.run(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
                        '-f', str(app)], check=True, capture_output=True)
    elif os.name == 'nt':
        import winreg
        # pythonw avoids a terminal; the URL is deliberately absent from the command.
        pythonw = python.with_name('pythonw.exe')
        if not pythonw.is_file():
            raise RuntimeError('独立环境缺少 pythonw.exe，请重新运行启动包。')
        value = subprocess.list2cmdline(launch_command(pythonw, root))
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, 'Software\\Classes\\' + SCHEME) as key:
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, 'URL:ESP Launchpad Enhanced USB')
            winreg.SetValueEx(key, 'URL Protocol', 0, winreg.REG_SZ, '')
            with winreg.CreateKey(key, 'shell\\open\\command') as child:
                winreg.SetValueEx(child, '', 0, winreg.REG_SZ, value)
    else:
        if not shutil.which('xdg-mime'):
            raise RuntimeError('未找到 xdg-mime，仍可手动运行 start.command。')
        apps = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'applications'
        apps.mkdir(parents=True, exist_ok=True)
        name = APP_ID + '.desktop'
        (apps / name).write_text('[Desktop Entry]\nType=Application\nName=ESP Launchpad Enhanced USB\n'
                                'NoDisplay=true\nTerminal=false\nExec=' + desktop_exec(command) + '\n'
                                'MimeType=x-scheme-handler/' + SCHEME + ';\n')
        subprocess.run(['xdg-mime', 'default', name, 'x-scheme-handler/' + SCHEME], check=True)
    print('网页唤起入口已注册（当前用户）；换模组后可从网页启动助手。', flush=True)


@contextmanager
def launch_lock(root):
    # OS releases the lock even if the runner crashes; no PID killing or stale-lock guessing.
    with (root / 'launch.lock').open('a+b') as lock:
        if lock.tell() == 0:
            lock.write(b'0');lock.flush()
        lock.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            lock.seek(0)
            if os.name == 'nt':
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def launch():
    root = Path(__file__).resolve().parent
    with launch_lock(root) as acquired:
        return run_helper(root) if acquired else 0


def run_helper(root):
    python = Path(sys.executable)
    if os.name == 'nt':
        python = python.with_name('python.exe')
    # Fixed operation only. stdin is closed so multiple devices fail safely.
    with (root / 'launcher.log').open('w', encoding='utf-8') as out:
        result = subprocess.run([str(python), '-I', '-X', 'utf8', str(root / 'helper.py'), '--timeout', '60'],
                                stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        message = 'USB 助手未完成恢复。请只连接目标模组，关闭占用串口的工具，再重试。详情：' + str(root / 'launcher.log')
        if sys.platform == 'darwin':
            subprocess.run(['osascript', '-e', 'display dialog ' + json.dumps(message) + ' buttons {"好"} default button "好"'])
        elif os.name == 'nt':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, 'ESP Launchpad Enhanced', 0)
        elif shutil.which('notify-send'):
            subprocess.run(['notify-send', 'ESP Launchpad Enhanced', message])
    return result.returncode


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='注册当前用户的网页唤起入口')
    parser.add_argument('--launch', action='store_true')
    parser.add_argument('--site-dir', type=Path)
    args = parser.parse_args()
    if args.launch:
        sys.exit(launch())
    if not args.site_dir:
        parser.error('需要 --site-dir')
    install(Path(sys.executable), Path(__file__).resolve().parent, args.site_dir.resolve())
