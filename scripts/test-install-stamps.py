"""Exercise the real Make recipes with isolated caches and fake installers."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

makefile = Path(__file__).resolve().parents[1] / 'Makefile'
with tempfile.TemporaryDirectory(prefix='few-install-stamps-') as directory:
    root = Path(directory)
    shutil.copyfile(makefile, root / 'Makefile')
    app = root / 'app'
    app.mkdir()
    (app / 'package.json').write_text('{"devDependencies":{"@playwright/test":"1.55.0"}}\n')
    (app / 'package-lock.json').write_text('{}\n')
    binaries = root / 'bin'
    binaries.mkdir()
    for command in ('npm', 'npx'):
        fake = binaries / command
        fake.write_text('#!/bin/sh\necho "$0 $*" >> "$INSTALL_LOG"\nmkdir -p node_modules\nexit "$INSTALL_EXIT"\n')
        fake.chmod(0o755)
    env = dict(os.environ, PATH=f'{binaries}:{os.environ["PATH"]}', INSTALL_LOG=str(root / 'attempts'))
    platform = f'{os.uname().sysname}-{os.uname().machine}'
    dependency_stamp = app / 'node_modules' / f'.platform_{platform}'
    browser_cache = root / 'browsers'
    browser_stamp = browser_cache / f'.installed_{platform}_1.55.0'

    def run(target, status):
        result = subprocess.run(['make', target, f'PLAYWRIGHT_BROWSERS_PATH={browser_cache}'],
                                cwd=root, env=dict(env, INSTALL_EXIT=str(status)),
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        assert (result.returncode == 0) == (status == 0), result.stdout

    for target, stamp in [('ensure-deps', dependency_stamp), ('ensure-playwright', browser_stamp)]:
        run(target, 42)
        assert not stamp.exists(), f'{target}: failed installation stamped success'
        before = len((root / 'attempts').read_text().splitlines())
        run(target, 0)
        assert stamp.exists(), f'{target}: successful retry has no platform/version stamp'
        assert len((root / 'attempts').read_text().splitlines()) == before + 1
        run(target, 0)
        assert len((root / 'attempts').read_text().splitlines()) == before + 1, 'unnecessary reinstall'
        print(f'{target}: failure propagates; retry stamps success; subsequent call uses stamp')
