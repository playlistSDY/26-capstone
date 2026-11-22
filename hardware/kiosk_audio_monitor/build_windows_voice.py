"""Build the thin Windows test ZIP, without speech models or API credentials."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import ssl
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = ROOT / "tmp/windows-downloads"
OUT = ROOT / "output/windows"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, help="Private device JSON, never an OpenAI key")
    args = parser.parse_args()
    context = ssl.create_default_context(cafile=str(ROOT / "kiosk-web/backend/certs/cacert.pem"))

    def fetch_json(url):
        with urllib.request.urlopen(url, context=context, timeout=30) as response:
            return json.load(response)

    runtime = CACHE / "python-3.14.9-embed-amd64.zip"
    python_url = "https://www.python.org/ftp/python/3.14.9/" + runtime.name
    CACHE.mkdir(parents=True, exist_ok=True)
    if not runtime.exists():
        with urllib.request.urlopen(python_url, context=context, timeout=90) as response, runtime.open("wb") as output:
            shutil.copyfileobj(response, output)
    digest = base64.b64decode(fetch_json(python_url + ".sigstore")["messageSignature"]["messageDigest"]["digest"]).hex()
    if hashlib.sha256(runtime.read_bytes()).hexdigest() != digest:
        raise ValueError("Python official digest mismatch")
    wheel = next(row for row in fetch_json("https://pypi.org/pypi/pyserial/3.5/json")["urls"] if row["filename"].endswith(".whl"))
    dependency = CACHE / wheel["filename"]
    if not dependency.exists():
        with urllib.request.urlopen(wheel["url"], context=context, timeout=30) as response, dependency.open("wb") as output:
            shutil.copyfileobj(response, output)
    if hashlib.sha256(dependency.read_bytes()).hexdigest() != wheel["digests"]["sha256"]:
        raise ValueError("pySerial digest mismatch")
    stage = OUT / "SWitch-Voice-ThinClient"
    if stage.exists():
        shutil.rmtree(stage)
    target = stage / "hardware/kiosk_audio_monitor"
    target.mkdir(parents=True)
    for filename in ["voice_dashboard.py", "voice_relay.py", "remote-config.example.json"]:
        shutil.copy2(HERE / filename, target / filename)
    shutil.copytree(HERE / "dashboard", target / "dashboard")
    shutil.copy2(ROOT / "kiosk-web/backend/certs/cacert.pem", target / "cacert.pem")
    fonts = stage / "kiosk-web/public/assets/fonts"
    fonts.mkdir(parents=True)
    for filename in ["PretendardVariable.woff2", "Pretendard-LICENSE.txt"]:
        shutil.copy2(ROOT / "kiosk-web/public/assets/fonts" / filename, fonts / filename)
    for source, destination in [(runtime, stage / "runtime"), (dependency, stage / "runtime/Lib/site-packages")]:
        with zipfile.ZipFile(source) as archive:
            if archive.testzip():
                raise ValueError("Invalid dependency ZIP")
            archive.extractall(destination)
    (stage / "runtime/python314._pth").write_text("python314.zip\n.\nLib/site-packages\n../hardware/kiosk_audio_monitor\nimport site\n", encoding="utf-8")
    if args.config:
        config = json.loads(args.config.read_text(encoding="utf-8-sig"))
        if set(config) - {"server_url", "device_token", "serial_port"}:
            raise ValueError("Unexpected fields in private device configuration")
        (stage / "연결설정.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        shutil.copy2(HERE / "remote-config.example.json", stage / "연결설정.json")
    common = ["@echo off", "chcp 65001 >nul", "setlocal", 'cd /d "%~dp0"', "set PYTHONUTF8=1", "set PYTHONIOENCODING=utf-8"]
    for filename, flags in [("마이크_테스트.bat", ' --remote-config "%~dp0연결설정.json"'), ("종료.bat", " --stop")]:
        lines = common + ['"%~dp0runtime\\python.exe" "%~dp0hardware\\kiosk_audio_monitor\\voice_dashboard.py"' + flags, "if errorlevel 1 pause", "endlocal", ""]
        (stage / filename).write_bytes("\r\n".join(lines).encode("utf-8"))
    shutil.copy2(HERE / "서버모드_사용방법.md", stage / "사용방법.txt")
    manifest = {"mode": "server-processing", "runtime": "Python 3.14.9 amd64", "runtime_sha256": digest, "dependencies": {"pyserial": "3.5"}, "files": {str(path.relative_to(stage)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(stage.rglob("*")) if path.is_file() and path.name != "연결설정.json"}}
    (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    output = Path(shutil.make_archive(str(stage), "zip", stage.parent, stage.name))
    print(f"Created {output} ({output.stat().st_size / 1024**2:.1f} MB)")


if __name__ == "__main__":
    main()
