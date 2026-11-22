"""Read-only audit of a target-native desktop archive; never extracts files."""
import json
import hashlib
import pathlib
import posixpath
import stat
import subprocess
import sys
import tarfile
import zipfile

archive = pathlib.Path(sys.argv[1])
required = {
    'gate-crossex/release.json', 'gate-crossex/app/LICENSE',
    'gate-crossex/app/SOURCE_NOTICES.md', 'gate-crossex/app/THIRD_PARTY_NOTICES.md',
    'gate-crossex/app/LICENSES/Apache-2.0.txt', 'gate-crossex/app/LICENSES/MIT-Meta.txt',
    'gate-crossex/app/apps/frontend/src/assets/fonts/OFL.txt',
    'gate-crossex/app/apps/frontend/src/assets/exchanges/README.md',
    'gate-crossex/app/CHANGELOG.md', 'gate-crossex/app/README.md',
}
seen = set()
regular = set()
source_root = pathlib.Path(__file__).resolve().parent.parent
tracked = subprocess.check_output(['git', 'ls-tree', '-rz', '--name-only', 'HEAD'], cwd=source_root).decode().split('\0')
compare = {f'gate-crossex/app/{p}': p for p in tracked if p.startswith(('migrations/', 'LICENSES/'))}
for path in required - {'gate-crossex/release.json'}:
    compare[path] = path.removeprefix('gate-crossex/app/')
compare['gate-crossex/app/README.md'] = 'docs/desktop-installation.md'
migration_count = len([p for p in compare.values() if p.startswith('migrations/') and p.endswith('.sql')])
assert migration_count > 0, 'Repository has no tracked migrations'


def verify_content(name, size, read):
    if name in compare:
        expected = subprocess.check_output(['git', 'show', f'HEAD:{compare[name]}'], cwd=source_root)
        assert size == len(expected), f'Content size mismatch: {name}'
        assert hashlib.sha256(read(size + 1)).digest() == hashlib.sha256(expected).digest(), f'Content mismatch: {name}'
    if name.startswith('gate-crossex/app/migrations/'):
        assert name in compare, 'Unexpected migration file'


def inspect(name, mode, link=None):
    canonical = name.rstrip('/')
    assert canonical not in seen, 'Duplicate archive path'
    seen.add(canonical)
    assert '\\' not in name and not name.startswith('/')
    assert all(part not in ('', '.', '..') for part in canonical.split('/'))
    assert canonical == 'gate-crossex' or canonical.startswith('gate-crossex/')
    assert not mode & 0o7000, 'Special file permissions'
    if link is not None:
        assert not link.startswith('/') and '\\' not in link
        target = posixpath.normpath(posixpath.join(posixpath.dirname(canonical), link))
        assert target.startswith('gate-crossex/'), 'Escaping archive link'
    if not canonical.startswith('gate-crossex/app/node_modules/'):
        parts = canonical.split('/')
        assert not any(p in ('.git', '.local-data', 'logs') or p.startswith('.env') for p in parts)
        assert not canonical.endswith(('.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.log'))


if archive.suffix == '.zip':
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            mode = item.external_attr >> 16
            assert stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), 'Special ZIP member'
            inspect(item.filename, mode)
            if not item.is_dir():
                regular.add(item.filename)
                with source.open(item) as stream:
                    verify_content(item.filename, item.file_size, stream.read)
        assert source.getinfo('gate-crossex/release.json').file_size < 65536
        manifest = json.loads(source.read('gate-crossex/release.json'))
else:
    with tarfile.open(archive, 'r:gz') as source:
        for item in source:
            assert item.isfile() or item.isdir() or item.issym(), 'Special TAR member'
            inspect(item.name, item.mode, item.linkname if item.issym() else None)
            if item.isfile():
                regular.add(item.name)
                with source.extractfile(item) as stream:
                    verify_content(item.name, item.size, stream.read)
        assert source.getmember('gate-crossex/release.json').isfile()
        assert source.getmember('gate-crossex/release.json').size < 65536
        manifest = json.load(source.extractfile('gate-crossex/release.json'))
assert (required | set(compare)) <= regular, 'Incomplete or non-regular notices/migrations'
assert ('gate-crossex/runtime/node.exe' if manifest['platform'] == 'win32' else 'gate-crossex/runtime/bin/node') in seen
print(json.dumps({'manifest': manifest, 'entries': len(seen), 'noticesPresent': True, 'pathsSafe': True,
                  'sourceFilesVerified': len(compare), 'migrationFilesVerified': migration_count}))
