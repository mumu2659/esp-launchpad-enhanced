import importlib.util
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from functools import partial

spec = importlib.util.spec_from_file_location('helper', Path(__file__).with_name('helper.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def port(path, serial='C6-A', location='hub-1'):
    return SimpleNamespace(device=path, serial_number=serial, location=location, description='USB', vid=0x303a, pid=0x1001)


class RecoveryTests(unittest.TestCase):
    def test_multiple_devices_require_explicit_selection(self):
        a, b = port('one'), port('two', 'C6-B')
        self.assertIs(helper.choose_port([a, b], ask=lambda _: '2'), b)
        with self.assertRaises(ValueError):
            helper.choose_port([a, b], ask=lambda _: '0')

    def test_reenumeration_follows_identity_and_uses_only_read_commands(self):
        snapshots = iter([[port('old')], [port('other', 'C6-B')], [port('new')]])
        elapsed = [0]
        commands = []
        def run(command, **_):
            commands.append(command)
            return SimpleNamespace(returncode=1 if len(commands) == 1 else 0, stdout='', stderr='')
        result = helper.stabilize(timeout=5, scan=lambda: next(snapshots), run=run,
                                  now=lambda: elapsed[0], sleep=lambda s: elapsed.__setitem__(0, elapsed[0] + s))
        self.assertEqual(result.device, 'new')
        self.assertEqual([c[c.index('--port') + 1] for c in commands], ['old', 'new'])
        self.assertEqual([c[c.index('--before') + 1] for c in commands], ['no-reset', 'usb-reset'])
        for command in commands:
            self.assertEqual(command[-1], 'flash-id')
            self.assertEqual(command[command.index('--after') + 1], 'no-reset')

    def test_no_device_times_out_without_running_esptool(self):
        elapsed = [0]
        with self.assertRaises(RuntimeError):
            helper.stabilize(timeout=0.2, scan=lambda: [], run=lambda *_: self.fail('opened device'),
                             now=lambda: elapsed[0], sleep=lambda s: elapsed.__setitem__(0, elapsed[0] + s))

    def test_subprocess_timeout_recovers_with_fresh_port(self):
        calls = []
        def run(command, **_):
            calls.append(command)
            if len(calls) == 1:
                raise helper.subprocess.TimeoutExpired(command, 1)
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        helper.stabilize(scan=lambda: [port('usb')], run=run, sleep=lambda _: None)
        self.assertEqual(len(calls), 2)


class ServerTests(unittest.TestCase):
    def test_browser_handoff_checks_origin_readiness_device_and_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            server = helper.HelperServer(('127.0.0.1', 0), partial(helper.SiteHandler, directory=folder))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            origin = f'http://127.0.0.1:{server.server_port}'
            valid = {'chip':'ESP32-C6','mac':'11:22:33:44:55:66','flashId':0x174020,'offlineReady':True}
            headers = {'Origin':origin,'Content-Type':'application/json','X-Launchpad-Handoff':server.handoff_token}
            def rejected(data, sent_headers, code):
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(origin+'/__helper__/handoff',data=json.dumps(data).encode(),headers=sent_headers))
                self.assertEqual(error.exception.code,code)
                error.exception.close()
                self.assertFalse(server.stop_requested.is_set())
            try:
                with urlopen(Request(origin+'/__helper__/session',headers={'X-Launchpad-Client':'1'})) as result:
                    self.assertFalse(json.load(result)['ready'])
                rejected(valid, headers, 409)
                server.busy = False
                rejected(valid, {**headers,'Origin':'https://other.example'},403)
                rejected(valid, {**headers,'X-Launchpad-Handoff':'wrong'},403)
                rejected({**valid,'offlineReady':False},headers,400)
                rejected({**valid,'flashId':True},headers,400)
                server.expected_mac = 'aa:bb:cc:dd:ee:ff'
                rejected(valid,headers,409)
                server.expected_mac = valid['mac']
                with urlopen(Request(origin+'/__helper__/handoff',data=json.dumps(valid).encode(),headers=headers)) as result:
                    self.assertTrue(json.load(result)['accepted'])
                self.assertTrue(server.stop_requested.wait(1))
            finally:
                server.shutdown();server.server_close();worker.join()

    def test_control_requires_local_credentials_and_refuses_busy_instance(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'LAUNCHPAD_HELPER_INSTANCE_DIR': folder}):
            server = helper.HelperServer(('127.0.0.1', 0), partial(helper.SiteHandler, directory=folder))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            helper.register_instance(server)
            url = f'http://127.0.0.1:{server.server_port}/__helper__/shutdown'
            try:
                for headers in ({}, {'Authorization': 'Bearer wrong'},
                                {'Authorization': 'Bearer ' + server.token, 'Origin': 'http://localhost'}):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(Request(url, method='POST', headers=headers))
                    self.assertEqual(error.exception.code, 403)
                    error.exception.close()
                with self.assertRaisesRegex(RuntimeError, '正在恢复'):
                    helper.request_previous_shutdown(server.server_port)
                self.assertFalse(server.stop_requested.is_set())
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(url, method='POST', headers={'Authorization': 'Bearer ' + server.token}))
                self.assertEqual(error.exception.code, 409)
                error.exception.close()
                server.busy = False
                self.assertTrue(helper.request_previous_shutdown(server.server_port))
                self.assertTrue(server.stop_requested.wait(1))
            finally:
                server.shutdown(); server.server_close(); worker.join()
                helper.unregister_instance(server)

    def test_real_second_process_replaces_idle_helper(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'LAUNCHPAD_HELPER_INSTANCE_DIR': folder}):
            root = Path(folder)
            (root / 'index.html').write_text('local site')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port_number = sock.getsockname()[1]
            command = [sys.executable, '-I', '-X', 'utf8', str(Path(helper.__file__).resolve()), '--serve-only',
                       '--no-browser', '--http-port', str(port_number), '--site-dir', folder]
            processes = []
            def wait_for(predicate):
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    result = predicate()
                    if result:
                        return result
                    time.sleep(0.05)
                output.seek(0)
                self.fail('Helper process transition timed out: ' + output.read().decode('utf-8', errors='replace'))
            def registered(previous_token=None):
                try:
                    record = json.loads(helper.instance_file(port_number).read_text())
                    if record['token'] == previous_token:
                        return False
                    request = Request(f'http://127.0.0.1:{port_number}/__helper__/status',
                                      headers={'Authorization': 'Bearer ' + record['token']})
                    with urlopen(request, timeout=1) as response:
                        info = json.load(response)
                    if info.get('app') == 'esp-launchpad-enhanced' and info.get('pid') == record['pid']:
                        return record['token']
                except (OSError, ValueError, KeyError):
                    pass
                return False
            with tempfile.TemporaryFile() as output:
                try:
                    first = subprocess.Popen(command, stdout=output, stderr=output)
                    processes.append(first)
                    # Windows venv launchers may spawn Python under a different PID.
                    first_token = wait_for(lambda: first.poll() is None and registered())
                    second = subprocess.Popen(command, stdout=output, stderr=output)
                    processes.append(second)
                    wait_for(lambda: first.poll() is not None and second.poll() is None and registered(first_token))
                    self.assertEqual(first.returncode, 0)
                    self.assertIsNone(second.poll())
                    with urlopen(f'http://127.0.0.1:{port_number}/') as response:
                        self.assertEqual(response.read(), b'local site')
                    self.assertTrue(helper.request_previous_shutdown(port_number))
                    self.assertEqual(second.wait(timeout=5), 0)
                    self.assertFalse(helper.instance_file(port_number).exists())
                finally:
                    helper.request_previous_shutdown(port_number)
                    for process in processes:
                        if process.poll() is None:
                            process.terminate()
                        process.wait(timeout=5)

    def test_second_instance_stops_before_usb_access(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'index.html').write_text('local site')
            with helper.ThreadingHTTPServer(('127.0.0.1', 0), helper.SiteHandler) as server:
                with patch.object(helper, 'stabilize') as recover:
                    with self.assertRaisesRegex(RuntimeError, '端口已被占用'):
                        helper.main(['--site-dir', folder, '--http-port', str(server.server_port), '--no-browser'])
                    recover.assert_not_called()

    def test_only_site_files_and_local_host_are_served(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'index.html').write_text('local site')
            (root / '.private').write_text('secret')
            (root / 'empty').mkdir()
            server = helper.ThreadingHTTPServer(('127.0.0.1', 0), partial(helper.SiteHandler, directory=folder))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f'http://127.0.0.1:{server.server_port}'
            try:
                with urlopen(url) as response:
                    self.assertEqual(response.read(), b'local site')
                for path in ('/.private', '/%2e%2e/helper.py', '/empty/'):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(url + path)
                    self.assertEqual(error.exception.code, 404)
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(url, headers={'Host': 'external.example'}))
                self.assertEqual(error.exception.code, 403)
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(url, method='POST', data=b'command'))
                self.assertEqual(error.exception.code, 501)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
