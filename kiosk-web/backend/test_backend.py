import json
import tempfile
import unittest
import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from pathlib import Path
from receipt_renderer import render_receipt
from server import KioskService, FilePrinter, ApiError, handler_for, browser_arguments

ROOT = Path(__file__).resolve().parent

def document():
    return {"id":"order-test-1","number":"024","createdAt":"2026-11-19T07:30:00+00:00","place":"포장","method":"신용·체크카드",
            "total":17200,"items":[{"name":"아메리카노","quantity":2,"unitPrice":3200,"optionsLabel":"ICE · 레귤러"},
              {"name":"카페라떼","quantity":1,"unitPrice":6300,"optionsLabel":"HOT · 라지 · 디카페인 · 샷 1 추가 · 오트밀크"},
              {"name":"바닐라라떼","quantity":1,"unitPrice":4500,"optionsLabel":"ICE · 레귤러 · 덜 달게"}]}

class BackendTests(unittest.TestCase):
    def test_kiosk_launch_hides_testing_banner_in_both_modes(self):
        for setup in [True,False]:
            args=browser_arguments(Path('chrome.exe'),Path('user data'),18731,setup)
            self.assertIn('--disable-infobars',args)
            self.assertIn('--kiosk',args)
            self.assertIn('--user-data-dir=user data',args)
            self.assertIn('kiosk=1',args[-1])
            self.assertEqual('printerSetup=1' in args[-1],setup)
            self.assertNotIn('--no-sandbox',args)
            self.assertNotIn('--ignore-certificate-errors',args)
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.service=KioskService(ROOT,Path(self.tmp.name),FilePrinter())
        self.service.save_settings({"printerName":"개발용 PNG 저장","autoPrint":True})
    def tearDown(self):self.tmp.cleanup()
    def payload(self):return {"requestId":"auto:one","document":document(),"variant":"receipt","kind":"auto"}
    def test_settings_survive_restart_and_validate(self):
        self.service.save_settings({"soundVolume":28,"offsetXmm":1,"fontScale":1.15})
        second=KioskService(ROOT,Path(self.tmp.name),FilePrinter())
        self.assertEqual(second.settings()["soundVolume"],28)
        for value in [{"soundVolume":101},{"printerName":"nonexistent"},{"offsetXmm":99},{"autoPrint":True,"printerName":""}]:
            with self.assertRaises(ApiError):second.save_settings(value)
    def test_total_validation_before_output(self):
        p=self.payload();p["document"]["total"]=1
        with self.assertRaises(ApiError):self.service.print_job(p)
        self.assertEqual(self.service.jobs(),[])
    def test_job_id_is_idempotent_even_after_restart(self):
        first=self.service.print_job(self.payload())
        self.assertEqual(first["state"],"file-saved")
        second=KioskService(ROOT,Path(self.tmp.name),FilePrinter())
        self.assertTrue(second.print_job(self.payload())["duplicate"])
        self.assertEqual(len(list((Path(self.tmp.name)/"receipts").glob("*.png"))),1)
    def test_disabled_auto_does_not_print_but_manual_can(self):
        self.service.save_settings({"autoPrint":False})
        with self.assertRaises(ApiError):self.service.print_job(self.payload())
        p=self.payload();p["kind"]="manual"
        self.assertEqual(self.service.print_job(p)["state"],"file-saved")
    def test_order_printing_does_not_enumerate_printers(self):
        class NoEnumeration(FilePrinter):
            def printers(self,force=False):raise AssertionError("per-order printer enumeration")
        self.service.adapter=NoEnumeration()
        result=self.service.print_job(self.payload())
        self.assertEqual(result["state"],"file-saved")
        self.assertIn("renderMs",result)
        self.assertIn("spoolMs",result)
    def test_failed_handoff_is_not_automatically_replayed(self):
        class Broken(FilePrinter):
            def print(self,request):raise ApiError("uncertain",504)
        self.service.adapter=Broken()
        self.assertEqual(self.service.print_job(self.payload())["state"],"uncertain")
        self.service.adapter=FilePrinter()
        self.assertEqual(self.service.print_job(self.payload())["state"],"uncertain")
    def test_render_long_names_and_options_at_large_scale(self):
        doc=document();doc["items"][0]["name"]="아주 긴 메뉴 이름과 옵션이 있는 음료"*4
        doc["items"][0]["optionsLabel"]="샷 추가 · 오트밀크 · 덜 달게 · "*12
        file=Path(self.tmp.name)/"long.png"
        size=render_receipt(doc,"pickup",{"fontScale":1.3},ROOT/"fonts/Pretendard.ttf",file)
        self.assertEqual(size["widthPx"],576)
        self.assertGreater(size["heightPx"],1000)
        self.assertTrue(file.stat().st_size>1000)
    def test_recovery_marks_an_interrupted_job_uncertain(self):
        with self.service.connect() as db:
            db.execute("INSERT INTO jobs VALUES ('interrupted','processing',1,'{}')")
        second=KioskService(ROOT,Path(self.tmp.name),FilePrinter())
        self.assertEqual(second.jobs()[0]["state"],"uncertain")
    def test_http_rejects_foreign_origins_hosts_and_missing_token(self):
        server=ThreadingHTTPServer(("127.0.0.1",0),lambda *a:None)
        port=server.server_address[1]
        server.RequestHandlerClass=handler_for(self.service,Path(self.tmp.name),port)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f"http://127.0.0.1:{port}"
        try:
            def request(path,headers=None,data=None):
                return urllib.request.urlopen(urllib.request.Request(base+path,data=data,headers=headers or {}),timeout=3)
            with request('/api/status') as r:self.assertEqual(json.load(r)["app"],"switch-kiosk-local-v1")
            for headers,data in [({"Origin":"https://foreign.example"},None),({"Host":"foreign.example"},None),({"Content-Type":"application/json"},b'{}')]:
                with self.assertRaises(urllib.error.HTTPError) as err:request('/api/settings',headers,data)
                self.assertEqual(err.exception.code,403)
            with request('/api/settings',{"Content-Type":"application/json","X-Switch-Token":self.service.token},b'{"soundVolume":19}') as r:
                self.assertEqual(json.load(r)["settings"]["soundVolume"],19)
        finally:server.shutdown();server.server_close()

if __name__=="__main__":unittest.main()
