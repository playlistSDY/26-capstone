import json
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch
from server import KioskService, FilePrinter, ApiError, handler_for, close_owned_browser, OwnedKioskWindows, WindowsPrinter
from test_backend import document

ROOT=Path(__file__).resolve().parent

class ShutdownTests(unittest.TestCase):
    def test_shutdown_finishes_active_print_and_rejects_new_work(self):
        entered=threading.Event();release=threading.Event();closed=[]
        class BlockingPrinter(FilePrinter):
            def print(self,request):
                entered.set();release.wait(3);return {'state':'file-saved'}
            def shutdown(self):closed.append('printer')
        with tempfile.TemporaryDirectory() as folder:
            service=KioskService(ROOT,Path(folder),BlockingPrinter())
            service.save_settings({'printerName':'개발용 PNG 저장','autoPrint':True})
            service.windows=Mock()
            worker=threading.Thread(target=lambda:service.print_job({'requestId':'one','document':document(),'kind':'auto'}))
            worker.start();self.assertTrue(entered.wait(2))
            service.begin_shutdown()
            cleaner=threading.Thread(target=service.close);cleaner.start()
            try:
                with self.assertRaises(ApiError) as error:service.print_job({})
                self.assertEqual(error.exception.status,503)
                self.assertEqual(closed,[])
                self.assertTrue(cleaner.is_alive())
            finally:
                release.set();worker.join(3);cleaner.join(3)
            self.assertFalse(cleaner.is_alive())
            self.assertEqual(service.jobs()[0]['state'],'file-saved')
            self.assertEqual(closed,['printer'])
            service.windows.close.assert_called_once()
            service.close();self.assertEqual(closed,['printer'])

    def test_shutdown_api_requires_token_and_stops_its_listener(self):
        with tempfile.TemporaryDirectory() as folder:
            service=KioskService(ROOT,Path(folder),FilePrinter())
            server=ThreadingHTTPServer(('127.0.0.1',0),lambda *a:None)
            port=server.server_port;server.RequestHandlerClass=handler_for(service,Path(folder),port)
            worker=threading.Thread(target=server.serve_forever);worker.start()
            def post(token):
                return urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/api/shutdown',data=b'{}',
                    headers={'Content-Type':'application/json','X-Switch-Token':token}),timeout=3)
            try:
                with self.assertRaises(urllib.error.HTTPError) as error:post('wrong')
                self.assertEqual(error.exception.code,403);self.assertFalse(service.stopping.is_set())
                with post(service.token) as response:self.assertEqual(json.load(response),{'stopping':True})
                worker.join(2);self.assertFalse(worker.is_alive());self.assertTrue(service.stopping.is_set())
            finally:
                if worker.is_alive():server.shutdown()
                server.server_close();service.close();worker.join(2)

    def test_windows_closes_only_owned_pid_tree(self):
        process=Mock(pid=43210);process.poll.return_value=None
        process.wait.side_effect=[subprocess.TimeoutExpired('chrome',3),0]
        with patch('server.sys.platform','win32'),patch('server.subprocess.run') as run:
            close_owned_browser(process)
        self.assertEqual(run.call_args_list[0].args[0],['taskkill.exe','/PID','43210','/T'])
        self.assertEqual(run.call_args_list[1].args[0],['taskkill.exe','/PID','43210','/T','/F'])
        process.kill.assert_not_called()
        process.poll.return_value=0
        with patch('server.subprocess.run') as run:close_owned_browser(process)
        run.assert_not_called()

    def test_listener_remains_until_print_cleanup_finishes(self):
        entered=threading.Event();release=threading.Event();cleaned=threading.Event()
        class BlockingPrinter(FilePrinter):
            def print(self,request):entered.set();release.wait(4);return {'state':'file-saved'}
            def shutdown(self):cleaned.set()
        with tempfile.TemporaryDirectory() as folder:
            service=KioskService(ROOT,Path(folder),BlockingPrinter())
            service.save_settings({'printerName':'개발용 PNG 저장','autoPrint':True})
            server=ThreadingHTTPServer(('127.0.0.1',0),lambda *a:None)
            port=server.server_port;server.RequestHandlerClass=handler_for(service,Path(folder),port)
            listener=threading.Thread(target=server.serve_forever);listener.start()
            printer=threading.Thread(target=lambda:service.print_job({'requestId':'one','document':document(),'kind':'auto'}));printer.start()
            self.assertTrue(entered.wait(2))
            try:
                request=urllib.request.Request(f'http://127.0.0.1:{port}/api/shutdown',data=b'{}',
                    headers={'Content-Type':'application/json','X-Switch-Token':service.token})
                with urllib.request.urlopen(request,timeout=2) as r:self.assertTrue(json.load(r)['stopping'])
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/status',timeout=2) as r:self.assertTrue(json.load(r)['stopping'])
                self.assertTrue(listener.is_alive());self.assertFalse(cleaned.is_set())
            finally:
                release.set();printer.join(3);listener.join(3)
                if listener.is_alive():server.shutdown()
                server.server_close();service.close()
            self.assertTrue(cleaned.is_set());self.assertFalse(listener.is_alive())

    def test_reused_windows_stay_owned_and_cannot_open_after_close(self):
        process=Mock();process.poll.return_value=None
        owner=OwnedKioskWindows(Path('chrome.exe'),Path('profile'),18731)
        with patch('server.subprocess.Popen',return_value=process) as launch,patch('server.close_owned_browser') as close:
            owner.open();owner.open(True);owner.close()
            self.assertEqual(launch.call_count,2)
            self.assertIn('printerSetup=1',launch.call_args.args[0][-1])
            self.assertEqual(close.call_count,2)
            with self.assertRaises(ApiError):owner.open()

    def test_printer_worker_exits_on_eof_and_cannot_restart_after_shutdown(self):
        printer=WindowsPrinter(ROOT);process=Mock();process.wait.return_value=0
        printer._process=process
        printer.shutdown();printer.shutdown()
        process.stdin.close.assert_called_once();process.wait.assert_called_once()
        process.terminate.assert_not_called()
        process.stdout.close.assert_called_once()
        with self.assertRaises(ApiError):printer._start()

if __name__=='__main__':unittest.main()
