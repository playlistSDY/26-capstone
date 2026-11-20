import hashlib
import json
import ssl
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from updater import apply_release, validate_manifest, safe_path, recover_pending, publisher_ssl_context

class UpdaterTests(unittest.TestCase):
    def test_bundled_roots_work_without_system_certificates(self):
        empty=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        before=empty.cert_store_stats()['x509_ca']
        with patch('updater.ssl.create_default_context',return_value=empty):
            context=publisher_ssl_context()
        self.assertGreater(context.cert_store_stats()['x509_ca'],100)
        self.assertGreater(context.cert_store_stats()['x509_ca'],before)
        self.assertEqual(context.verify_mode,ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_missing_bundle_fails_closed(self):
        with patch('updater.CA_BUNDLE',Path('/missing/switch-ca-bundle.pem')):
            with self.assertRaises(FileNotFoundError):publisher_ssl_context()

    def setUp(self):
        no_launch=patch('subprocess.Popen')
        self.spawn=no_launch.start()
        self.addCleanup(no_launch.stop)
        self.addCleanup(self.spawn.assert_not_called)
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        for name,data in {"runtime/python.exe":b"runtime","backend/server.py":b"VALUE='old'\n",
                          "backend/updater.py":b"VALUE='old-updater'\n","web/index.html":b'<script src="/assets/old.js"></script>',
                          "web/assets/old.js":b"old","release.json":b'{"version":"old"}',"custom-note.txt":b"keep"}.items():
            file=self.root/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(data)
        self.contents={"backend/server.py":b"VALUE='new'\n","backend/updater.py":b"VALUE='new-updater'\n",
                       "web/index.html":b'<script src="/assets/new.js"></script>',"web/assets/new.js":b"new",
                       "release.json":b'{"version":"2026.11.19.4"}'}
        self.manifest={"schema":1,"app":"switch-kiosk-local-v1","version":"2026.11.19.4","sequence":4,
                       "release":"releases/test/","python":f"{sys.version_info.major}.{sys.version_info.minor}",
                       "files":[{"path":p,"sha256":hashlib.sha256(d).hexdigest(),"size":len(d)} for p,d in self.contents.items()]}
    def tearDown(self):self.temp.cleanup()
    def fetch(self,entry,manifest,destination):
        destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(self.contents[entry["path"]])
    def test_changed_files_download_apply_backup_and_noop(self):
        validate_manifest(self.manifest)
        calls=[]
        result=apply_release(self.root,self.manifest,self.fetch,lambda:calls.append("stop"))
        self.assertEqual(result["changed"],5)
        self.assertEqual(calls,["stop"])
        self.assertEqual((self.root/"custom-note.txt").read_bytes(),b"keep")
        self.assertEqual((self.root/"runtime/python.exe").read_bytes(),b"runtime")
        backup=Path(result["backup"])
        self.assertEqual((backup/"backend/server.py").read_text(),"VALUE='old'\n")
        result=apply_release(self.root,self.manifest,self.fetch,lambda:self.fail("no stop for noop"))
        self.assertEqual(result["changed"],0)
    def test_corrupt_download_does_not_stop_running_app(self):
        def bad(e,m,d):d.parent.mkdir(parents=True,exist_ok=True);d.write_bytes(b"broken")
        with self.assertRaises(ValueError):
            apply_release(self.root,self.manifest,bad,lambda:self.fail("must not stop"))
        self.assertEqual((self.root/"backend/server.py").read_text(),"VALUE='old'\n")
    def test_invalid_install_restores_original_without_launching(self):
        with patch('updater.validate_install',side_effect=ValueError('missing asset')):
            with self.assertRaises(ValueError):
                apply_release(self.root,self.manifest,self.fetch,lambda:None)
        self.assertEqual((self.root/"backend/server.py").read_text(),"VALUE='old'\n")
        self.assertFalse((self.root/"web/assets/new.js").exists())
        self.assertEqual(json.loads((self.root/"release.json").read_text())["version"],"old")
    def test_unsafe_paths_duplicate_hashes_and_runtime_updates_rejected(self):
        for path in ["../outside","backend/../../outside","backend//server.py","backend/./server.py",
                     "C:/bad","runtime/python.exe","backend/NUL.txt","backend/bad.py.","/backend/server.py"]:
            with self.subTest(path=path),self.assertRaises(ValueError):safe_path(self.root,path)
        m=json.loads(json.dumps(self.manifest));m["files"].append(m["files"][0])
        with self.assertRaises(ValueError):validate_manifest(m)
        m=json.loads(json.dumps(self.manifest));m["files"][0]["sha256"]="bad"
        with self.assertRaises(ValueError):validate_manifest(m)
        m=json.loads(json.dumps(self.manifest));m["release"]="releases/../"
        with self.assertRaises(ValueError):validate_manifest(m)
    def test_downgrade_is_not_applied(self):
        folder=self.root/".updates";folder.mkdir();(folder/"installed.json").write_text('{"sequence":10}')
        with self.assertRaises(ValueError):apply_release(self.root,self.manifest,self.fetch,lambda:None)
    def test_repeat_update_and_recovery_with_korean_paths_on_cp949(self):
        contents='@echo off\n'.encode('utf-8')
        self.contents['업데이트.bat']=contents
        self.manifest['files'].append({'path':'업데이트.bat','size':len(contents),'sha256':hashlib.sha256(contents).hexdigest()})
        original=Path.read_text
        def windows_read(path,encoding=None,errors=None,**kwargs):
            return original(path,encoding=encoding or 'cp949',errors=errors,**kwargs)
        with patch.object(Path,'read_text',windows_read):
            first=apply_release(self.root,self.manifest,self.fetch,lambda:None)
            second=apply_release(self.root,self.manifest,self.fetch,lambda:self.fail('must not restart'))
            self.assertEqual(second['changed'],0)
            state=json.loads((self.root/'.updates/installed.json').read_text(encoding='utf-8'))
            journal={'transaction':state['transaction'],'backup':str(Path(first['backup']).relative_to(self.root.resolve())),
                     'records':[],'previousState':None}
            (self.root/'.updates/pending.json').write_text(json.dumps(journal,ensure_ascii=False),encoding='utf-8')
            recover_pending(self.root,lambda:self.fail('already committed'))
            self.assertFalse((self.root/'.updates/pending.json').exists())
    def test_interrupted_copy_recovers_from_journal(self):
        backup=self.root/".updates/backups/interrupted/backend";backup.mkdir(parents=True)
        (backup/"server.py").write_text("VALUE='old'\n")
        (self.root/"backend/server.py").write_text("VALUE='half-updated'\n")
        journal={"transaction":"interrupted","backup":".updates/backups/interrupted",
                 "records":[["backend/server.py",True]],"previousState":None}
        (self.root/".updates/pending.json").write_text(json.dumps(journal))
        calls=[];recover_pending(self.root,lambda:calls.append("stop"))
        self.assertEqual((self.root/"backend/server.py").read_text(),"VALUE='old'\n")
        self.assertEqual(calls,["stop"])
        self.assertFalse((self.root/".updates/pending.json").exists())

if __name__=="__main__":unittest.main()
