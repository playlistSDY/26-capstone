"""Create the small manual bootstrap needed when a legacy updater cannot connect."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[1]
OUTPUT=ROOT.parent/"output/windows"
STAGE=OUTPUT/"SWitch-Windows-Offline"
archive_path=OUTPUT/"SWitch-Updater-Setup.zip"
files={"업데이트.bat":STAGE/"업데이트.bat","업데이트후실행.bat":STAGE/"업데이트후실행.bat","backend/updater.py":ROOT/"backend/updater.py"}
for file in (ROOT/"backend/certs").iterdir():
    if file.is_file():files["backend/certs/"+file.name]=file
instructions=(
    "SWitch 업데이트 복구 파일 (SSL / CP949 오류 수정)\r\n\r\n"
    "1. 이 ZIP의 모든 내용을 기존 실행.bat이 있는 SWitch 폴더에 덮어넣으세요.\r\n"
    "   ZIP 안에서 바로 실행하지 말고, backend 폴더도 함께 덮어넣으세요.\r\n"
    "2. 업데이트.bat을 실행하세요. 다운로드·백업·적용까지만 진행하며 키오스크를 실행하지 않습니다.\r\n"
    "3. 키오스크를 사용하려면 별도로 실행.bat을 실행하세요. 다음 업데이트는 업데이트.bat으로 받으세요.\r\n\r\n"
    "SSL 인증서 검증은 유지하며 Mozilla CA 인증서 묶음을 함께 제공합니다.\r\n"
    "한글 경로가 있는 업데이트 기록은 UTF-8로 읽고 저장합니다.\r\n"
    "오류가 계속되면 Windows 날짜·시간을 확인하고 .updates/update-error.log를 확인하세요.\r\n"
    "설정과 주문 기록은 삭제하지 않습니다.\r\n"
)
with zipfile.ZipFile(archive_path,"w",zipfile.ZIP_DEFLATED) as archive:
    for name,file in files.items():archive.write(file,name)
    archive.writestr("설치방법.txt",instructions.encode("utf-8-sig"))
print(json.dumps({"file":str(archive_path),"bytes":archive_path.stat().st_size,
                  "sha256":hashlib.sha256(archive_path.read_bytes()).hexdigest()},indent=2))
