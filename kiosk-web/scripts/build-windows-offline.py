"""Create a self-contained, offline Windows x64 kiosk folder and ZIP."""
import argparse
import concurrent.futures
import hashlib
import base64
import json
import shutil
import struct
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT.parent / "tmp/windows-downloads"
OUTPUT = ROOT.parent / "output/windows"
CACHE.mkdir(parents=True, exist_ok=True)
OUTPUT.mkdir(parents=True, exist_ok=True)
SOURCES = {
    "python": {"url":"https://www.python.org/ftp/python/3.14.9/python-3.14.9-embed-amd64.zip","version":"3.14.9"},
    "chrome": {"url":"https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.36/win64/chrome-win64.zip","version":"158.0.8127.36"},
}

def fetch(item):
    url = item["url"]
    dest = CACHE / url.rsplit("/", 1)[1]
    if not dest.exists():
        print("Downloading " + dest.name, flush=True)
        with urllib.request.urlopen(url, timeout=90) as src, dest.with_suffix(".part").open("wb") as out:
            shutil.copyfileobj(src, out)
        dest.with_suffix(".part").replace(dest)
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    if item.get("sha256") and digest != item["sha256"]:
        raise ValueError("Checksum mismatch: " + dest.name)
    with zipfile.ZipFile(dest) as archive:
        if archive.testzip():
            raise ValueError("Invalid ZIP: " + dest.name)
    print("Verified " + dest.name + " " + digest[:12], flush=True)
    return {**item, "sha256":digest,"file":str(dest),"size":dest.stat().st_size}

def pe_amd64(path):
    data = path.read_bytes()
    offset = struct.unpack_from("<I",data,60)[0]
    assert data[:2]==b"MZ" and data[offset:offset+4]==b"PE\0\0"
    assert struct.unpack_from("<H",data,offset+4)[0]==0x8664

def main():
    parser=argparse.ArgumentParser();parser.add_argument("--download-only",action="store_true");args=parser.parse_args()
    meta=json.load(urllib.request.urlopen("https://pypi.org/pypi/Pillow/13.0.0/json"))
    wheel=next(f for f in meta["urls"] if f["filename"].endswith("cp314-cp314-win_amd64.whl"))
    sources={**SOURCES,"pillow":{"url":wheel["url"],"version":"13.0.0","sha256":wheel["digests"]["sha256"]}}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        downloads=dict(zip(sources,pool.map(fetch,sources.values())))
    python_bundle=json.load(urllib.request.urlopen(SOURCES["python"]["url"]+".sigstore"))
    expected=base64.b64decode(python_bundle["messageSignature"]["messageDigest"]["digest"]).hex()
    assert downloads["python"]["sha256"]==expected, "Python official digest mismatch"
    (OUTPUT/"downloads-manifest.json").write_text(json.dumps(downloads,indent=2),encoding="utf-8")
    if args.download_only:return
    stage=OUTPUT/"SWitch-Windows-Offline"
    if stage.exists():shutil.rmtree(stage)
    stage.mkdir()
    shutil.copytree(ROOT/"dist",stage/"web",ignore=shutil.ignore_patterns("downloads","updates",".DS_Store"))
    # Old browser-launcher downloads are migration-only, never part of the offline app.
    shutil.rmtree(stage/"web/downloads",ignore_errors=True)
    shutil.rmtree(stage/"web/updates",ignore_errors=True)
    shutil.copytree(ROOT/"backend",stage/"backend",ignore=shutil.ignore_patterns("__pycache__","test_*"))
    shutil.copy2(ROOT/"public/assets/fonts/Pretendard-LICENSE.txt",stage/"backend/fonts/OFL.txt")
    for name,target in [("python","runtime"),("chrome","browser"),("pillow","runtime/Lib/site-packages")]:
        with zipfile.ZipFile(downloads[name]["file"]) as archive:archive.extractall(stage/target)
    (stage/"runtime/python314._pth").write_text("python314.zip\n.\nLib/site-packages\n../backend\nimport site\n",encoding="utf-8")
    pe_amd64(stage/"runtime/python.exe");pe_amd64(stage/"browser/chrome-win64/chrome.exe")
    common=['@echo off','chcp 65001 >nul','setlocal','cd /d "%~dp0"']
    for file,extra in [("실행.bat",""),("설정.bat"," --settings"),("종료.bat"," --stop")]:
        lines=common+['"%~dp0runtime\\python.exe" "%~dp0backend\\server.py"'+extra,'if errorlevel 1 pause','endlocal','']
        (stage/file).write_bytes("\r\n".join(lines).encode("utf-8"))
    update=common+[
        'if not exist "%~dp0runtime\\python.exe" goto wrongfolder',
        '"%~dp0runtime\\python.exe" "%~dp0backend\\updater.py"',
        'if errorlevel 1 goto failed','timeout /t 3 /nobreak >nul','goto end',
        ':wrongfolder','echo 기존 실행.bat이 있는 폴더에 업데이트 파일을 넣어 주세요.',
        ':failed','pause',':end','endlocal','']
    for name in ["업데이트.bat","업데이트후실행.bat"]:
        (stage/name).write_bytes("\r\n".join(update).encode("utf-8"))
    shutil.copy2(ROOT/"release.json",stage/"release.json")
    (stage/"사용방법.txt").write_text((ROOT/"backend/사용방법.txt").read_text(),encoding="utf-8-sig")
    (stage/"runtime-manifest.json").write_text(json.dumps({k:{a:b for a,b in v.items() if a!="file"} for k,v in downloads.items()},indent=2),encoding="utf-8")
    # Source and dependency manifests for later modifications; Node is not needed to run.
    shutil.copytree(ROOT/"src",stage/"source/src")
    for file in ["package.json","package-lock.json","vite.config.ts","tsconfig.json","index.html","playwright.config.ts","README.md","release.json"]:
        shutil.copy2(ROOT/file,stage/"source"/file)
    shutil.copytree(ROOT/"public",stage/"source/public",ignore=shutil.ignore_patterns("downloads","updates"))
    shutil.copytree(ROOT/"tests",stage/"source/tests")
    shutil.copytree(ROOT/"backend",stage/"source/backend",ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy2(ROOT/"public/assets/fonts/Pretendard-LICENSE.txt",stage/"source/backend/fonts/OFL.txt")
    (stage/"source/scripts").mkdir()
    for file in ["build-windows-offline.py","build-updater-setup.py","check-offline-local.mjs","check-shutdown-local.mjs","receipt-qa.mjs","capture-qa.mjs","publish-local-release.py","import-drink-catalog.py","drink-photo-policy.json","build-sound-pack.py"]:
        shutil.copy2(ROOT/"scripts"/file,stage/"source/scripts"/file)
    notices=stage/"THIRD_PARTY_LICENSES"
    notices.mkdir()
    for package in ["react","react-dom","lucide-react"]:
        shutil.copy2(ROOT/"node_modules"/package/"LICENSE",notices/(package+".txt"))
    # Bundled archives keep all vendor licensing notices; include project notices as well.
    (stage/"THIRD_PARTY_NOTICES.txt").write_text(
        "Python: https://www.python.org/psf/license/ (runtime/LICENSE.txt)\n"
        "Pillow: https://pillow.readthedocs.io/en/stable/about.html#license (runtime/Lib/site-packages/pillow-13.0.0.dist-info/licenses/)\n"
        "Chrome for Testing: https://developer.chrome.com/blog/chrome-for-testing/ (browser/chrome-win64/ABOUT and resources)\n"
        "Pretendard: SIL Open Font License 1.1 (backend/fonts/OFL.txt; web/assets/fonts/Pretendard-LICENSE.txt)\n"
        "React: MIT. Lucide: ISC. Source dependency versions in source/package-lock.json.\n",encoding="utf-8")
    with (stage/"THIRD_PARTY_NOTICES.txt").open("a",encoding="utf-8") as out:
        out.write("Certifi Mozilla CA bundle: MPL-2.0 (backend/certs/LICENSE-certifi.txt; bundle.json)\n"
                  "Source: https://github.com/certifi/python-certifi\n")
    zip_path=OUTPUT/"SWitch-Windows-Offline.zip"
    with zipfile.ZipFile(zip_path,"w",zipfile.ZIP_DEFLATED,compresslevel=5) as archive:
        for file in stage.rglob("*"):
            if file.is_file():archive.write(file,file.relative_to(OUTPUT))
    with zipfile.ZipFile(zip_path) as archive:
        assert archive.testzip() is None
    digest=hashlib.sha256(zip_path.read_bytes()).hexdigest()
    (OUTPUT/"SWitch-Windows-Offline.zip.sha256").write_text(digest+"  "+zip_path.name+"\n")
    print(json.dumps({"zip":str(zip_path),"bytes":zip_path.stat().st_size,"sha256":digest},indent=2))

if __name__=="__main__":main()
