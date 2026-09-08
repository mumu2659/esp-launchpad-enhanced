"""Package only reviewed launcher files and the built web assets."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
dist = root / 'dist'
if not (dist / 'index.html').is_file():
    raise SystemExit('Run npm run build first')
files = ['打开助手.html', 'start.command', 'start-windows.cmd', 'start-windows.ps1', 'bootstrap_env.py',
         'helper.py', 'protocol.py', 'requirements.lock', 'uv-assets.tsv', 'README.md']
site_files = [dist / name for name in [
    'helper-sw.js', 'enhanced/launcher.mjs','enhanced/monitor.mjs', 'enhanced/handoff.mjs', 'index.html', '.nojekyll', 'LICENSE', 'enhanced/app.js', 'enhanced/core.mjs', 'enhanced/style.css',
    'node_modules/esptool-js/bundle.js', 'node_modules/esptool-js/LICENSE',
    'node_modules/js-md5/build/md5.min.js', 'node_modules/js-md5/LICENSE.txt']]
if not all(p.is_file() for p in site_files):
    raise SystemExit('Incomplete build; run npm run build first')
output = dist / 'downloads' / 'esp-launchpad-enhanced-usb-helper.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as bundle:
    for name in files:
        bundle.write(root / 'usb-helper' / name, 'esp-launchpad-enhanced-usb-helper/' + name)
    bundle.write(root / 'LICENSE', 'esp-launchpad-enhanced-usb-helper/LICENSE')
    for path in site_files:
        bundle.write(path, 'esp-launchpad-enhanced-usb-helper/site/' + path.relative_to(dist).as_posix())
print(f'Built {output} ({output.stat().st_size:,} bytes)')
