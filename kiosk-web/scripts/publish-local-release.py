"""Prepare immutable file-level updates. Publish stable.json only after file sync verifies."""
import hashlib
import json
import shutil
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"backend"))
from updater import safe_path, validate_manifest, atomic_json

ROOT=Path(__file__).resolve().parents[1]
stage=ROOT.parent/"output/windows/SWitch-Windows-Offline"
release=json.loads((ROOT/"release.json").read_text())
version=release["version"]
destination=ROOT/"public/updates/releases"/version
if destination.exists():raise RuntimeError("Release already exists; use a new release version.")
prepared=ROOT.parent/"tmp"/("release-"+version)
if prepared.exists():shutil.rmtree(prepared)
files_root=prepared/"files";files_root.mkdir(parents=True)
files=[]
for file in sorted(stage.rglob("*")):
    if not file.is_file():continue
    path=file.relative_to(stage).as_posix()
    try:safe_path(stage,path)
    except ValueError:continue  # Runtime/browser binaries use a separate full package.
    if "__pycache__" in Path(path).parts:continue
    target=safe_path(files_root,path);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(file,target)
    files.append({"path":path,"size":file.stat().st_size,"sha256":hashlib.sha256(file.read_bytes()).hexdigest()})
manifest={"schema":1,"app":"switch-kiosk-local-v1","version":version,"sequence":release["sequence"],
          "python":"3.14","release":"releases/"+version+"/","files":files}
validate_manifest(manifest,python_version="3.14")
atomic_json(prepared/"manifest.json",manifest)
destination.parent.mkdir(parents=True,exist_ok=True);prepared.replace(destination)
# Do not activate here: an rsync can still be sending immutable files.
candidate=ROOT.parent/"output/windows/stable-candidate.json"
atomic_json(candidate,manifest)
print(json.dumps({"version":version,"files":len(files),"bytes":sum(f["size"] for f in files),"candidate":str(candidate)},indent=2))
