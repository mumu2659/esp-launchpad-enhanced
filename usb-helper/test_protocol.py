import importlib.util
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('protocol', Path(__file__).with_name('protocol.py'))
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)

class ProtocolTests(unittest.TestCase):
    def test_fixed_launch_command_and_mac_url_guard(self):
        root=Path('/tmp/user name/"quoted $directory')
        command=protocol.launch_command(Path('/tmp/python space/python'),root)
        self.assertEqual(shlex.split(shlex.join(command)),command)
        self.assertEqual(command[-1],'--launch')
        script=protocol.mac_script(command)
        self.assertIn('incoming is not "esp-launchpad-enhanced://recover"',script)
        self.assertNotIn('& incoming',script)
        self.assertEqual(script.count('do shell script'),1)

    def test_incomplete_site_does_not_replace_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            installed=root/'installed';installed.mkdir()
            (installed/'helper.py').write_text('preserve')
            with self.assertRaisesRegex(RuntimeError,'配套网页不完整'):
                protocol.install(Path('/python'),root,root/'missing',installed)
            self.assertEqual((installed/'helper.py').read_text(),'preserve')

    def test_launch_passes_no_url_or_shell_and_closes_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            with patch.object(protocol,'__file__',str(root/'protocol.py')), patch.object(protocol.subprocess,'run') as run:
                run.return_value.returncode=0
                self.assertEqual(protocol.launch(),0)
                args,kwargs=run.call_args
                self.assertEqual(args[0][1:],['-I', '-X', 'utf8',str(root/'helper.py'),'--timeout','60'])
                self.assertEqual(kwargs['stdin'],protocol.subprocess.DEVNULL)
                self.assertNotIn('shell',kwargs)

    def test_desktop_entry_has_no_url_substitution(self):
        entry=protocol.desktop_exec(['/tmp/a b%/python','-I', '-X', 'utf8','/tmp/x/protocol.py','--launch'])
        self.assertIn('a b%%',entry)
        self.assertNotIn('%u',entry)
        self.assertNotIn('%U',entry)

    def test_duplicate_launch_is_ignored_and_lock_is_reusable(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            with protocol.launch_lock(root) as first:
                self.assertTrue(first)
                with protocol.launch_lock(root) as second:
                    self.assertFalse(second)
            with protocol.launch_lock(root) as third:
                self.assertTrue(third)
