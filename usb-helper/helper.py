"""Local USB recovery and static Launchpad hosting. No flash/eFuse writes."""
from __future__ import annotations

import argparse
import errno
import http.client
import json
import secrets
import socket
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
from urllib.parse import unquote, urlsplit
import webbrowser

from serial.tools import list_ports

USB_ID = (0x303A, 0x1001)


def native_ports():
    return sorted((p for p in list_ports.comports() if (p.vid, p.pid) == USB_ID), key=lambda p: p.device)


def identity(port):
    if port.serial_number:
        return ('serial', port.serial_number)
    if port.location:
        return ('location', port.location)
    return ('path', port.device)


def choose_port(ports, requested=None, ask=input):
    if requested:
        matches = [p for p in ports if p.device == requested]
        if len(matches) != 1:
            raise ValueError('指定端口当前不是可用的 ESP 原生 USB Serial/JTAG 端口。')
        return matches[0]
    if len(ports) == 1:
        return ports[0]
    print('检测到多个 ESP USB 设备，请选择要恢复的模组：')
    for i, port in enumerate(ports, 1):
        print(f'  {i}. {port.device}  {port.description}  {port.serial_number or "无序列号"}')
    try:
        index = int(ask('输入序号：')) - 1
    except (ValueError, EOFError):
        raise ValueError('未选择设备，已停止。') from None
    if not 0 <= index < len(ports):
        raise ValueError('设备序号无效，已停止。')
    return ports[index]


def esptool_command(port, mode):
    return [sys.executable, '-I', '-X', 'utf8', '-m', 'esptool', '--chip', 'esp32c6',
            '--port', port, '--baud', '115200', '--connect-attempts', '1',
            '--before', mode, '--after', 'no-reset', 'flash-id']


def stabilize(requested=None, timeout=60, *, scan=native_ports,
              run=subprocess.run, now=time.monotonic, sleep=time.sleep, ask=input):
    deadline = now() + timeout
    selected = None
    attempts = 0
    print('正在等待 ESP32-C6 原生 USB。请先断开网页和其他串口工具的连接。', flush=True)
    while now() < deadline:
        ports = scan()
        if selected is None and ports:
            if requested and not any(p.device == requested for p in ports):
                sleep(0.1)
                continue
            selected = identity(choose_port(ports, requested, ask))
        candidates = [p for p in ports if identity(p) == selected]
        if len(candidates) > 1:
            raise RuntimeError('多个端口具有相同设备标识，无法安全选择，请仅连接目标模组。')
        if not candidates:
            sleep(0.1)
            continue
        port = candidates[0]
        attempts += 1
        mode = 'no-reset' if attempts == 1 else 'usb-reset'
        print(f'尝试 {attempts}: {port.device} / {mode}', flush=True)
        try:
            result = run(esptool_command(port.device, mode), capture_output=True,
                         text=True, encoding='utf-8', errors='replace',
                         timeout=max(0.1, min(10, deadline - now())))
            if result.stdout:
                print(result.stdout, end='', flush=True)
            if result.stderr:
                print(result.stderr, end='', flush=True)
            if result.returncode == 0:
                print('USB 下载模式已就绪；esptool 已退出并释放串口。未写入或擦除 Flash。', flush=True)
                match = re.search(r'(?:BASE MAC|MAC)\s*:\s*((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})(?!:)', result.stdout)
                port.chip_mac = match.group(1).lower() if match else None
                return port
        except subprocess.TimeoutExpired:
            # subprocess.run kills and waits for its child before raising.
            print('本轮握手超时，已停止子进程，将重新寻找同一设备。', flush=True)
        sleep(0.2)
    raise RuntimeError('未能在限定时间内稳定设备。请检查线缆、供电和端口占用；可关闭其他串口工具后重试。')


def instance_file(port):
    override = os.environ.get('LAUNCHPAD_HELPER_INSTANCE_DIR')
    if override:
        root = Path(override)
    elif sys.platform == 'darwin':
        root = Path.home() / 'Library/Caches/esp-launchpad-enhanced/instances'
    elif os.name == 'nt':
        root = Path(os.environ['LOCALAPPDATA']) / 'ESP-Launchpad-Enhanced/instances'
    else:
        root = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'esp-launchpad-enhanced/instances'
    return root / f'{port}.json'


def register_instance(server):
    path = instance_file(server.server_port)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.instance-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            json.dump({'app': 'esp-launchpad-enhanced', 'token': server.token,
                       'pid': os.getpid(), 'port': server.server_port}, out)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def unregister_instance(server):
    path = instance_file(server.server_port)
    try:
        if json.loads(path.read_text())['token'] == server.token:
            path.unlink()
    except (OSError, ValueError, KeyError):
        pass


def request_previous_shutdown(port):
    # No PID-based kill: the old helper must authenticate and exit itself.
    try:
        record = json.loads(instance_file(port).read_text())
        if not isinstance(record, dict):
            return False
        if record.get('app') != 'esp-launchpad-enhanced' or record.get('port') != port:
            return False
        token = record['token']
        if not isinstance(token, str) or len(token) != 64:
            return False
        headers = {'Authorization': 'Bearer ' + token}
        def request(method, path):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
            try:
                connection.request(method, path, headers=headers)
                response = connection.getresponse()
                return response.status, response.read(4096)
            finally:
                connection.close()
        status, body = request('GET', '/__helper__/status')
        info = json.loads(body)
        if not isinstance(info, dict):
            return False
        if status != 200 or info.get('app') != 'esp-launchpad-enhanced' or info.get('pid') != record['pid']:
            return False
        if info.get('busy'):
            raise RuntimeError('旧助手正在恢复 USB，请等待当前操作完成后再启动。')
        status, _ = request('POST', '/__helper__/shutdown')
        if status == 409:
            raise RuntimeError('旧助手正在恢复 USB，请等待当前操作完成后再启动。')
        return status == 200
    except (OSError, ValueError, KeyError, http.client.HTTPException):
        return False


class HelperServer(ThreadingHTTPServer):
    allow_reuse_address = os.name != 'nt'

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def __init__(self, *args, **kwargs):
        self.token = secrets.token_hex(32)
        self.busy = True
        self.handoff_token = secrets.token_hex(32)
        self.expected_mac = None
        self.exit_reason = '新助手已接管，本窗口退出。'
        self.stop_requested = threading.Event()
        super().__init__(*args, **kwargs)


def create_server(root, port):
    def bind():
        return HelperServer(('127.0.0.1', port), partial(SiteHandler, directory=str(root)))
    try:
        return bind()
    except OSError as error:
        if error.errno not in (errno.EADDRINUSE, 10048):
            raise
    if not request_previous_shutdown(port):
        raise RuntimeError('端口已被占用，无法确认是可自动关闭的 USB 助手。请手动关闭旧版助手或检查其他程序。')
    print('检测到旧 USB 助手，已请求其退出，正在接管端口…', flush=True)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            return bind()
        except OSError as error:
            if error.errno not in (errno.EADDRINUSE, 10048):
                raise
            time.sleep(0.1)
    raise RuntimeError('旧助手尚未释放端口，请稍后重试。没有强制结束进程。')


class SiteHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript",
                      ".css": "text/css", ".html": "text/html"}

    def allowed(self):
        expected = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        if self.headers.get('Host', '') not in expected:
            self.send_error(403)
            return False
        parts = unquote(urlsplit(self.path).path).replace('\\', '/').split('/')
        if any(part.startswith('.') for part in parts if part):
            self.send_error(404)
            return False
        root = Path(self.directory).resolve()
        path = Path(self.translate_path(self.path)).resolve()
        if not path.is_relative_to(root) or (path.is_dir() and not (path / 'index.html').is_file()):
            self.send_error(404)
            return False
        return True

    def control(self):
        port = self.server.server_port
        if (self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}')
                or self.headers.get('Origin') is not None
                or not secrets.compare_digest(self.headers.get('Authorization', ''),
                                              'Bearer ' + getattr(self.server, 'token', ''))):
            self.send_error(403)
            return False
        return True

    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def browser_client(self):
        port = self.server.server_port
        host = self.headers.get('Host', '')
        origin = self.headers.get('Origin')
        if (host not in (f'localhost:{port}', f'127.0.0.1:{port}')
                or (origin is not None and origin != 'http://' + host)
                or self.headers.get('Sec-Fetch-Site', 'same-origin') not in ('same-origin', 'none')):
            self.send_error(403)
            return False
        return True

    def acknowledge_handoff(self):
        if not self.browser_client():
            return
        if not secrets.compare_digest(self.headers.get('X-Launchpad-Handoff', ''), self.server.handoff_token):
            self.send_error(403)
            return
        if self.server.busy:
            self.reply(409, {'accepted': False})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 2048:
                raise ValueError('length')
            self.connection.settimeout(3)
            info = json.loads(self.rfile.read(length))
            mac = info.get('mac', '').lower()
            valid = (info.get('offlineReady') is True and isinstance(info.get('chip'), str)
                     and info['chip'].startswith('ESP32-C6')
                     and re.fullmatch(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', mac)
                     and type(info.get('flashId')) is int and 0 < info['flashId'] < 0xffffff)
            if not valid:
                raise ValueError('handshake')
            if self.server.expected_mac and mac != self.server.expected_mac:
                self.reply(409, {'accepted': False})
                return
        except (ValueError, AttributeError, OSError):
            self.reply(400, {'accepted': False})
            return
        self.reply(200, {'accepted': True})
        self.wfile.flush()
        self.server.exit_reason = '网页已确认接管，USB 助手自动退出。'
        self.server.stop_requested.set()

    def do_POST(self):
        if self.path == '/__helper__/handoff':
            self.acknowledge_handoff()
            return
        if self.path != '/__helper__/shutdown':
            self.send_error(501)
            return
        if not self.control():
            return
        if self.server.busy:
            self.reply(409, {'busy': True})
            return
        self.reply(200, {'stopping': True})
        self.server.stop_requested.set()

    def do_GET(self):
        if self.path == '/__helper__/session':
            if not self.browser_client():
                return
            if self.headers.get('X-Launchpad-Client') != '1':
                self.send_error(403)
                return
            self.reply(200, {'ready': not self.server.busy, 'token': self.server.handoff_token})
            return
        if self.path == '/__helper__/status':
            if self.control():
                self.reply(200, {'app': 'esp-launchpad-enhanced', 'pid': os.getpid(),
                                 'busy': self.server.busy})
            return
        if self.allowed():
            super().do_GET()

    def do_HEAD(self):
        if self.allowed():
            super().do_HEAD()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def log_message(self, *_):
        pass


def open_browser(url):
    # Prefer Web Serial-capable browsers; default browser is a last resort.
    if sys.platform == 'darwin':
        for app in ('Google Chrome', 'Microsoft Edge'):
            if Path(f'/Applications/{app}.app').exists():
                subprocess.run(['open', '-a', app, url], check=True)
                return
    elif os.name == 'nt':
        for base in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'):
            for relative in ('Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'):
                exe = Path(os.environ.get(base, '')) / relative
                if exe.is_file():
                    subprocess.Popen([str(exe), url])
                    return
    webbrowser.open(url)


def main(argv=None):
    parser = argparse.ArgumentParser(description='ESP Launchpad Enhanced USB 助手')
    parser.add_argument('--doctor', action='store_true', help='检查独立环境，不连接设备')
    parser.add_argument('--prepare-only', action='store_true', help='仅稳定 USB，不启动网页')
    parser.add_argument('--serve-only', action='store_true', help='仅启动网页，不操作 USB')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--port', help='多个设备时明确指定系统串口路径')
    parser.add_argument('--timeout', type=float, default=60)
    parser.add_argument('--http-port', type=int, default=4175)
    parser.add_argument('--site-dir', type=Path, default=Path(__file__).resolve().parent / 'site')
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error('--timeout 必须大于 0')
    if args.prepare_only and args.serve_only:
        parser.error('--prepare-only 与 --serve-only 不能同时使用')
    print(f'ESP Launchpad Enhanced USB 助手 | {platform.system()} {platform.machine()}')
    print(f'Python {platform.python_version()} | esptool {importlib.metadata.version("esptool")}')
    if args.doctor:
        print(f'独立解释器：{sys.executable}\n环境检查通过；没有打开串口。')
        return 0
    if args.prepare_only:
        stabilize(args.port, args.timeout)
        return 0
    root = args.site_dir.resolve()
    if not (root / 'index.html').is_file():
        raise RuntimeError('缺少配套网页，请完整解压 USB 助手启动包。开发时先构建，再指定 --site-dir dist。')
    # Authenticate and retire only an idle helper before touching USB.
    server = create_server(root, args.http_port)
    with server:
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.1}, daemon=True)
        worker.start()
        try:
            register_instance(server)
            if not args.serve_only:
                port = stabilize(args.port, args.timeout)
                server.expected_mac = getattr(port, "chip_mac", None)
            server.busy = False
            mode = 'usb_reset' if args.serve_only else 'no_reset'
            url = f'http://localhost:{server.server_port}/?mode={mode}&helper=1'
            print(f'\n打开：{url}\n请在 Chrome/Edge 中点击“连接设备”。已有授权可直接连接。', flush=True)
            print('等待网页确认接管，成功后助手自动退出；等待期间可按 Ctrl+C 取消。', flush=True)
            if not args.no_browser:
                try:
                    open_browser(url)
                except OSError as error:
                    print(f'无法自动打开浏览器：{error}。请手动打开上面的地址。')
            while not server.stop_requested.wait(0.2):
                pass
            print(server.exit_reason, flush=True)
        finally:
            server.shutdown()
            worker.join()
            unregister_instance(server)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n助手已退出。')
    except (OSError, ValueError, RuntimeError) as error:
        print(f'\n启动失败：{error}', file=sys.stderr)
        sys.exit(1)
