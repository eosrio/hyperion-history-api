import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import uuid

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'prepare-public-inputs.py'
ARCHIVE = HERE.parent / 'evidence-prefix-six-20261022' / 'raw-evidence.tar.gz'
MANIFEST = ARCHIVE.parent / 'manifest.json'

def run(name, real_inputs=False, optimized=False):
    args = [sys.executable] + (['-O'] if optimized else []) + [str(SCRIPT),
        str(ARCHIVE) if real_inputs else 'nonexistent-archive', str(MANIFEST) if real_inputs else 'nonexistent-manifest', name]
    env = {key: value for key, value in os.environ.items() if key != 'PYTHONOPTIMIZE'}
    return subprocess.run(args, capture_output=True, text=True, timeout=20, env=env)

class PublicPathGuards(unittest.TestCase):
    def test_invalid_portable_names_fail_before_input_reads_or_creation(self):
        for name in ['C:escape', 'C:/escape', 'C:\\escape', '/escape', '..', '../escape', 'escape/child',
                     'escape\\child', '', 'a' * 65, 'Uppercase', 'con', 'prn', 'aux', 'nul', 'com1', 'lpt9']:
            with self.subTest(name=name):
                result = run(name)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Invalid portable child name', result.stderr)
                self.assertNotIn('nonexistent-manifest', result.stderr)

    def test_nonfresh_directory_is_refused_before_input_reads(self):
        name = 'public-nonfresh-' + uuid.uuid4().hex
        target = HERE / name
        target.mkdir()
        try:
            result = run(name)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Target must be fresh and not a symlink', result.stderr)
            self.assertEqual(list(target.iterdir()), [])
        finally:
            self.assertEqual(target.resolve().parent, HERE)
            target.rmdir()

    def test_dangling_symlink_is_refused_before_input_reads(self):
        name = 'public-symlink-' + uuid.uuid4().hex
        link = HERE / name
        try:
            link.symlink_to(HERE / ('nonexistent-' + uuid.uuid4().hex), target_is_directory=True)
        except OSError as error:
            self.skipTest('Native symlink permission unavailable: ' + str(error))
        try:
            result = run(name)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Target must be fresh and not a symlink', result.stderr)
        finally:
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.parent.resolve(), HERE)
            link.unlink()

    def test_optimized_python_is_refused_before_input_reads(self):
        result = run('public-inputs-fresh', optimized=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('without Python -O or PYTHONOPTIMIZE', result.stderr)

    def test_valid_fresh_name_reproduces_exact_recipe(self):
        name = 'public-guard-valid-' + uuid.uuid4().hex
        result = run(name, real_inputs=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt['selectedRegularMembers'], 54)
        self.assertEqual(receipt['receipt']['sha256'], '5cfe62475ad9ae08ff9b36877c172fce9a98a6a23da143ae469c79f3e5aa5f3b')
        self.assertEqual((HERE / name).resolve().parent, HERE)
        data = (HERE / name / 'public-input-recipe.json').read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), receipt['receipt']['sha256'])
        # Preserve this complete fresh positive-control tree for evidence; no recursive cleanup.

if __name__ == '__main__':
    unittest.main(verbosity=2)
