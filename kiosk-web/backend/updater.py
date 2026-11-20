"""User-triggered file updates for SWitch. Downloads finish before the app is stopped."""
import argparse
import ast
import contextlib
import datetime
import hashlib
import json
import os
import re
import shutil
import ssl
import sys
import time
import traceback
import unicodedata
import urllib.parse
import urllib.request
import uuid
from pathlib import Path, PurePosixPath

APP_ID = "switch-kiosk-local-v1"
PUBLISHER = "https://temp.sdy.world/6bd53630-2b00-4d66-9bab-3810e1e0aa36/updates/"
MANIFEST_URL = PUBLISHER + "stable.json"
CA_BUNDLE = Path(__file__).resolve().parent / "certs/cacert.pem"
MAX_FILE = 50 * 1024 * 1024
MAX_TOTAL = 200 * 1024 * 1024
ROOT_FILES = {"실행.bat","설정.bat","종료.bat","업데이트.bat","업데이트후실행.bat",
              "사용방법.txt","README.md","release.json","THIRD_PARTY_NOTICES.txt"}
RESERVED = {"con","prn","aux","nul"} | {f"{name}{i}" for name in ["com","lpt"] for i in range(1,10)}

def digest(file):
    h=hashlib.sha256()
    with Path(file).open("rb") as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b""):h.update(chunk)
    return h.hexdigest()

def safe_path(root, name):
    if not isinstance(name,str) or not name or "\\" in name or ":" in name:
        raise ValueError("업데이트 파일 경로가 올바르지 않습니다.")
    posix=PurePosixPath(name)
    if posix.as_posix()!=name or posix.is_absolute() or any(part in ["",".",".."] or part.endswith((" ",".")) or
                                 part.split(".")[0].casefold() in RESERVED or
                                 any(ord(c)<32 or c in '<>"|?*' for c in part) for part in posix.parts):
        raise ValueError("허용하지 않는 업데이트 경로입니다.")
    canonical=unicodedata.normalize("NFC",name)
    if posix.parts[0] not in ["backend","web","source","THIRD_PARTY_LICENSES"] and canonical not in ROOT_FILES:
        raise ValueError("프로그램 파일만 업데이트할 수 있습니다.")
    destination=Path(root).joinpath(*posix.parts)
    if not destination.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError("업데이트 경로가 프로그램 폴더 밖을 가리킵니다.")
    return destination

def validate_manifest(value, python_version=None):
    if not isinstance(value,dict) or value.get("schema")!=1 or value.get("app")!=APP_ID:
        raise ValueError("SWitch 업데이트 정보가 아닙니다.")
    if not isinstance(value.get("sequence"),int) or value["sequence"]<1:
        raise ValueError("업데이트 버전을 확인할 수 없습니다.")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}",value.get("version","")):
        raise ValueError("버전 이름이 올바르지 않습니다.")
    release=value.get("release","")
    if not re.fullmatch(r"releases/[A-Za-z0-9._-]{1,80}/",release) or release.split("/")[1] in [".",".."]:
        raise ValueError("배포 경로가 올바르지 않습니다.")
    files=value.get("files")
    if not isinstance(files,list) or not 1<=len(files)<=2000:
        raise ValueError("파일 목록이 올바르지 않습니다.")
    seen=set();total=0
    for entry in files:
        if not isinstance(entry,dict):raise ValueError("파일 정보가 올바르지 않습니다.")
        name=entry.get("path")
        safe_path(Path.cwd(),name)
        folded=unicodedata.normalize("NFC",name).casefold()
        if folded in seen:raise ValueError("중복된 파일 경로입니다.")
        seen.add(folded)
        if not re.fullmatch(r"[a-f0-9]{64}",entry.get("sha256","")) or type(entry.get("size")) is not int or not 0<=entry["size"]<=MAX_FILE:
            raise ValueError("파일 해시 또는 크기가 올바르지 않습니다.")
        total+=entry["size"]
    if total>MAX_TOTAL:raise ValueError("업데이트 크기가 제한을 초과했습니다.")
    names={f["path"] for f in files}
    if not {"backend/server.py","backend/updater.py","web/index.html","release.json"}.issubset(names):
        raise ValueError("필수 실행 파일이 없습니다.")
    if value.get("python")!=(python_version or f"{sys.version_info.major}.{sys.version_info.minor}"):
        raise ValueError("이 버전은 실행 환경 변경이 필요합니다. 전체 패키지를 받아 주세요.")
    return value

class PublisherRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith(PUBLISHER):
            raise ValueError("업데이트 서버 밖으로의 이동을 허용하지 않습니다.")
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def publisher_ssl_context():
    # Embedded Python relies on the Windows root store, which can be incomplete
    # on a newly installed/offline kiosk. Ship Mozilla roots as well as OS roots.
    context=ssl.create_default_context()
    context.load_verify_locations(cafile=str(CA_BUNDLE))
    return context

def open_remote(url):
    if not url.startswith(PUBLISHER):raise ValueError("허용되지 않은 업데이트 주소입니다.")
    opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=publisher_ssl_context()),PublisherRedirect())
    return opener.open(urllib.request.Request(url,headers={"Cache-Control":"no-cache","User-Agent":"SWitch-Updater/1"}),timeout=30)

def read_manifest():
    with open_remote(MANIFEST_URL) as response:
        raw=response.read(2*1024*1024+1)
    if len(raw)>2*1024*1024:raise ValueError("업데이트 정보가 너무 큽니다.")
    return validate_manifest(json.loads(raw))

def download(entry, manifest, target):
    url=PUBLISHER+manifest["release"]+"files/"+urllib.parse.quote(entry["path"],safe="/")
    target.parent.mkdir(parents=True,exist_ok=True)
    with open_remote(url) as response,target.open("wb") as out:
        count=0
        while True:
            chunk=response.read(128*1024)
            if not chunk:break
            count+=len(chunk)
            if count>entry["size"]:raise ValueError("다운로드 크기가 일치하지 않습니다.")
            out.write(chunk)
    if target.stat().st_size!=entry["size"] or digest(target)!=entry["sha256"]:
        raise ValueError("다운로드 파일 검증에 실패했습니다: "+entry["path"])

def local_request(path, body=None):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    headers={}
    if body is not None:
        status=local_request("/api/status")
        if status.get("app")!=APP_ID:raise RuntimeError("다른 앱이 실행 포트를 사용 중입니다.")
        headers={"Content-Type":"application/json","X-Switch-Token":status["token"]}
    request=urllib.request.Request("http://127.0.0.1:18731"+path,
                                  data=None if body is None else json.dumps(body).encode(),headers=headers)
    with opener.open(request,timeout=3) as response:return json.load(response)

def stop_server():
    try:status=local_request("/api/status")
    except OSError:return False
    if status.get("app")!=APP_ID:raise RuntimeError("다른 앱이 실행 포트를 사용 중입니다.")
    local_request("/api/shutdown",{})
    for _ in range(100):
        try:local_request("/api/status")
        except OSError:
            time.sleep(1)  # Let the owned browser process release its profile.
            return True
        time.sleep(.1)
    raise RuntimeError("키오스크 종료를 확인하지 못했습니다. 종료.bat 실행 후 다시 시도해 주세요.")

def atomic_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_name(path.name+".new")
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding="utf-8")
    temporary.replace(path)

def validate_install(root):
    for relative in ["backend/server.py","backend/updater.py"]:
        ast.parse((root/relative).read_text(encoding="utf-8"),filename=relative)
    html=(root/"web/index.html").read_text(encoding="utf-8")
    for target in re.findall(r'(?:src|href)="(/[^"]+)"',html):
        file=root/"web"/urllib.parse.unquote(urllib.parse.urlsplit(target).path).lstrip("/")
        if not file.resolve().is_relative_to((root/"web").resolve()) or not file.is_file():
            raise ValueError("화면 실행 파일이 누락됐습니다: "+target)

def restore_files(root,backup,records):
    for relative,existed in reversed(records):
        destination=safe_path(root,relative)
        if existed:shutil.copy2(safe_path(backup,relative),destination)
        elif destination.exists():destination.unlink()

def recover_pending(root,stop=stop_server):
    root=Path(root).resolve();pending=root/".updates/pending.json"
    if not pending.exists():return
    journal=json.loads(pending.read_text(encoding="utf-8"))
    state_file=root/".updates/installed.json"
    state=json.loads(state_file.read_text(encoding="utf-8")) if state_file.exists() else {}
    if state.get("transaction")==journal["transaction"]:
        pending.unlink();return
    backup=(root/journal["backup"]).resolve()
    if not backup.is_relative_to((root/".updates/backups").resolve()):raise ValueError("백업 경로가 올바르지 않습니다.")
    print("중단된 업데이트를 복구합니다.",flush=True)
    stop();restore_files(root,backup,journal["records"])
    if journal["previousState"] is None:state_file.unlink(missing_ok=True)
    else:atomic_json(state_file,journal["previousState"])
    pending.unlink()
    print("복구 완료. 필요할 때 실행.bat으로 키오스크를 실행해 주세요.",flush=True)

def apply_release(root,manifest,fetch=download,stop=stop_server):
    root=Path(root).resolve()
    if not (root/"runtime/python.exe").is_file() or not (root/"backend/server.py").is_file():
        raise RuntimeError("기존 SWitch 실행 폴더에서 업데이트.bat을 실행해 주세요.")
    work=root/".updates";work.mkdir(exist_ok=True)
    state_file=work/"installed.json"
    installed=json.loads(state_file.read_text(encoding="utf-8")) if state_file.exists() else {}
    release_file=root/"release.json"
    release=json.loads(release_file.read_text(encoding="utf-8")) if release_file.exists() else {}
    if manifest["sequence"]<max(installed.get("sequence",0),release.get("sequence",0)):
        raise ValueError("이전 버전으로 자동 업데이트하지 않습니다.")
    changed=[e for e in manifest["files"] if not safe_path(root,e["path"]).is_file() or digest(safe_path(root,e["path"]))!=e["sha256"]]
    if not changed:
        atomic_json(state_file,{**installed,"version":manifest["version"],"sequence":manifest["sequence"],
                                "managed":[e["path"] for e in manifest["files"]]})
        print("이미 최신 버전입니다.",flush=True)
        return {"version":manifest["version"],"changed":0}
    session=manifest["version"]+"-"+uuid.uuid4().hex[:8]
    staging=work/"staging"/session;backup=work/"backups"/session
    backup.mkdir(parents=True);staging.mkdir(parents=True)
    print(f'{manifest["version"]}: 변경 파일 {len(changed)}개 다운로드',flush=True)
    try:
        for i,entry in enumerate(changed,1):
            destination=safe_path(staging,entry["path"])
            fetch(entry,manifest,destination)
            if destination.stat().st_size!=entry["size"] or digest(destination)!=entry["sha256"]:
                raise ValueError("파일 검증에 실패했습니다: "+entry["path"])
            print(f'  {i}/{len(changed)} {entry["path"]}',flush=True)
        # Validate downloaded Python before interrupting the running kiosk.
        for entry in changed:
            if entry["path"].startswith("backend/") and entry["path"].endswith(".py"):
                ast.parse(safe_path(staging,entry["path"]).read_text(encoding="utf-8"))
        pending=work/"pending.json"
        journal={"transaction":session,"backup":str(backup.relative_to(root)),"records":[],
                 "previousState":installed if state_file.exists() else None}
        atomic_json(pending,journal)
        stop()
        records=[]
        try:
            for entry in changed:
                destination=safe_path(root,entry["path"]);saved=safe_path(backup,entry["path"])
                existed=destination.exists()
                if existed:
                    saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(destination,saved)
                records.append((entry["path"],existed))
                journal["records"]=records;atomic_json(pending,journal)
                destination.parent.mkdir(parents=True,exist_ok=True)
                temporary=destination.with_name(destination.name+".switch-update")
                shutil.copyfile(safe_path(staging,entry["path"]),temporary)
                temporary.replace(destination)
            validate_install(root)
            atomic_json(state_file,{"version":manifest["version"],"sequence":manifest["sequence"],
                                    "managed":[e["path"] for e in manifest["files"]],"backup":str(backup),"transaction":session})
        except Exception:
            print("적용 실패: 이전 파일을 복구합니다.",flush=True)
            try:stop()
            except Exception:pass
            restore_files(root,backup,records)
            pending.unlink(missing_ok=True)
            raise
        pending.unlink(missing_ok=True)
        print("업데이트 완료. 필요할 때 실행.bat으로 키오스크를 실행해 주세요.",flush=True)
        return {"version":manifest["version"],"changed":len(changed),"backup":str(backup)}
    finally:
        shutil.rmtree(staging,ignore_errors=True)

@contextlib.contextmanager
def update_lock(root):
    with (root/".update.lock").open("a+b") as lock:
        if lock.seek(0,2)==0:lock.write(b"1");lock.flush()
        lock.seek(0)
        try:
            if sys.platform=="win32":
                import msvcrt
                msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:raise RuntimeError("업데이트가 이미 실행 중입니다.")
        try:yield
        finally:
            lock.seek(0)
            if sys.platform=="win32":
                msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)
            else:fcntl.flock(lock,fcntl.LOCK_UN)

def main():
    root=Path(__file__).resolve().parents[1]
    with update_lock(root):
        recover_pending(root)
        manifest=read_manifest()
        apply_release(root,manifest)

if __name__=="__main__":
    try:main()
    except Exception as error:
        try:
            log=Path(__file__).resolve().parents[1]/".updates/update-error.log"
            log.parent.mkdir(parents=True,exist_ok=True)
            log.write_text(datetime.datetime.now().astimezone().isoformat()+"\n"+traceback.format_exc(),encoding="utf-8")
        except OSError:pass
        print("업데이트 실패: "+str(error),flush=True)
        if isinstance(getattr(error,"reason",error),ssl.SSLCertVerificationError):
            print("PC의 날짜·시간이 현재와 맞는지 확인해 주세요. 상세 오류: .updates/update-error.log",flush=True)
        print("기존 설정과 주문 기록은 삭제하지 않았습니다.",flush=True)
        sys.exit(1)
