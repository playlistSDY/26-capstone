# ESP32 마이크를 PC 스피커로 듣기

ICS-43434의 소리를 USB 시리얼로 보내고, PC 프로그램에서 재생합니다.
USB 마이크 장치로 등록되는 방식이 아니라, 전용 수신 프로그램을 사용하는 테스트입니다.
기존 재생 프로그램은 음성을 파일에 저장하거나 서버로 보내지 않습니다.

## ESP32 수음 → 대화 입력 웹 화면

`마이크_웹.command`를 더블클릭하면 `http://127.0.0.1:18733/`에 로컬 화면이 열립니다. 가운데 ‘나’ 아바타 위 말풍선에는 에이전트에 전달할 말만 표시하고, 오른쪽에는 인식 후보·처리 단계·시간·로그를 나눠 표시합니다. 원래 CLI는 `마이크_STT.command`로 계속 사용할 수 있습니다. 두 프로그램은 같은 USB 포트를 동시에 사용하지 마세요.

웹 화면 오른쪽 위에서 수음을 시작/중지합니다. 웹 서버는 터미널에서 Ctrl+C로 종료하며 자신이 실행한 수음기도 정리합니다. 같은 웹 실행 파일을 다시 열면 기존 서버를 재사용합니다. 새로고침해도 서버가 실행 중이면 최근 전달 이력이 유지됩니다. 이력은 메모리에만 있으며 서버를 종료하면 사라집니다. 원음은 저장하지 않습니다.

### 대화 범위와 지연

필터는 메뉴 허용 목록이나 완성된 주문 문장 검사기가 아닙니다. “그거 말고 다른 걸로 주세요”, “해줘. 2개.”, “아니”, “라떼”, 인사·도움 요청·매장 문의 같은 말을 원문 그대로 전달 대상으로 남깁니다. 명백한 방송/비음성/동행자끼리의 대화만 제외하며, 뜻과 참조는 뒤의 에이전트가 문맥으로 해석합니다. 단일 마이크만으로 대상을 확정할 수는 없습니다.

로컬 Silero VAD·동적 소음 문턱을 사용합니다. 기본 0.45초 무음에서 STT 조각을 나누고, 추가 발화 확인 1초와 의미 판단을 병렬로 진행합니다. 판단 중 말이 다시 시작되면 이전 결과를 폐기합니다. 분명한 단일 메뉴 요청과 일부 단답은 로컬에서 빠르게 판별하고, 나머지는 의미 모델로 전달 대상을 확인합니다. 로컬 패턴에 맞지 않는 말을 차단하지 않습니다. ‘그리고…’ 같은 조각은 최대 6초까지 이어 듣고, 더 말하지 않으면 그 원문도 에이전트의 문맥 해석 대상으로 남깁니다.

실제 ESP 감도 개선을 위해 VAD 모델 입력만 기본 8배 보정하고 피크를 제한합니다. 원음·RMS·스피커 음량을 바꾸지 않습니다. 에너지 문턱이 높다는 이유만으로 작은 발화를 차단하지 않습니다. `--vad-gain 1`로 보정 전을 비교할 수 있으며, 음량 보정이 SNR 자체를 개선하는 것은 아닙니다.

```sh
./마이크_웹.command                      # 웹 화면 + 수음기
./마이크_웹.command --no-start           # 웹만 열고 수음은 버튼으로 시작
./마이크_STT.command                     # 기존 CLI
./마이크_STT.command --button            # 버튼을 누르고 말하기
./마이크_STT.command --join-wait 2        # 추가 발화 대기를 길게 비교
./마이크_STT.command --filter rules       # 보수적인 로컬 규칙 비교
./마이크_STT.command --filter jev         # TYPESAFE_API_KEY를 설정한 경우
./마이크_STT.command --probe-seconds 4    # API 없이 USB 수음만 확인
```

`order-agent/.env`의 `OPENAI_API_KEY`를 읽으며 키를 화면/로그에 표시하지 않습니다. STT 기본 모델은 `gpt-transcribe`, 의미 필터는 `gpt-5.6-luna`입니다. `TYPESAFE_API_KEY`가 있으면 auto 모드가 Jev로 전환됩니다. STT 오디오 API와 의미 필터 텍스트 API에는 각각 요금이 있고, 로컬 빠른 판별에는 별도 의미 API 요금이 없습니다. `OPENAI_STT_MODEL` / `OPENAI_FILTER_MODEL`로 변경할 수 있습니다. Jev 어댑터의 실제 호출은 키가 없어 미검증입니다.

현재 웹은 에이전트 호출 전 입력 미리보기입니다. `전달할 말` 이벤트를 표시하며 주문 도구·결제를 실행하지 않습니다. [구성·평가 조건](../../docs/agent/음성입력_필터_시제품.md), [웹 화면 안내](../../docs/agent/음성입력_웹화면.md)를 참조하세요.

### 설치와 검증

`requirements-stt.txt`의 numpy·pyserial·openai·onnxruntime이 필요합니다. GPU·PyTorch는 사용하지 않습니다. 고정 버전 VAD 모델·SHA-256·MIT 라이선스를 `models/`에 포함합니다. 수음 스케치가 이미 올라가 있으면 재업로드할 필요가 없습니다. CLI 선택 옵션 `--event-log`만 로컬 진단 JSONL을 저장하며, 기본 웹은 로그와 대화를 메모리에서 관리합니다.

```sh
.venv/bin/python -m unittest discover -p 'test_*.py'
.venv/bin/python check_voice_noise.py
.venv/bin/python check_speech_gate.py --live       # 실제 모델 호출, 추가 요금
node check_voice_dashboard.mjs                   # kiosk-web의 npm 의존성 사용
```

소음 반복 시험은 `check_voice_noise.py --speech-wav <48kHz 모노 WAV> --noise-wav <현장 소음 WAV>`로 바꿀 수 있습니다. 기본 합성 시험은 실제 카페·다양한 화자 검증을 대신하지 않습니다. 큰 USB 누락·STT 실패·큐 초과·필터 서비스 오류에는 불완전한 말을 임의로 주문으로 만들지 않고 화면에 상태를 표시합니다.

## 1 보드에 오디오 전송 코드 업로드

`kiosk_audio_monitor.ino`를 Arduino IDE로 열어 업로드합니다.
기존 숫자 출력 테스트 스케치 대신 이 스케치를 올려야 PC에서 들을 수 있습니다.

- 보드 패키지: esp32 by Espressif Systems 3.x
- 보드: ESP32S3 Dev Module
- USB Mode: Hardware CDC and JTAG
- USB CDC On Boot: Enabled
- 배선: 마이크 BCLK=4 / LRCL=5 / DOUT=6 / SEL=GND / 3V=3V3 / GND=GND
- 버튼: GPIO7과 GND 사이. LED: GPIO8 → 330Ω → LED +, LED - → GND

업로드 후 Arduino 시리얼 모니터와 시리얼 플로터를 닫습니다.
이 스케치는 이진 음성을 전송하므로 시리얼 모니터에서 글자가 깨져 보이는 것은 정상입니다.
마이크 전원은 3.3V입니다.

## 2 Mac에서 듣기

같은 폴더의 `마이크_듣기.command`를 실행합니다.
처음 실행 시 로컬 가상환경에 pyserial·sounddevice·numpy를 설치합니다.
설치된 실행 환경이 있으면 재사용합니다. 기본 재생 장치는 macOS의 기본 오디오 출력입니다.

버튼을 누르는 동안 마이크 소리가 재생되고 LED가 켜집니다. 놓으면 재생이 멈춥니다.
PC 음량을 낮춰 시작하고 마이크와 스피커를 떨어뜨려 놓으세요. 가까우면 하울링이 생길 수 있습니다.
Ctrl+C로 종료합니다. 블루투스 출력은 유선 출력보다 지연이 클 수 있습니다.

버튼과 관계없이 계속 듣고 싶으면 `마이크_계속듣기.command`를 실행합니다.
이 실행 파일은 저주파 DC 제거와 완충 버퍼를 적용한 상태에서 음량 2배로 계속 재생합니다.
실행 파일 두 개를 동시에 켜지 마세요. USB 포트는 한 프로그램에서 사용합니다.

## Windows 또는 터미널에서 실행

이 폴더에서 다음을 실행합니다.

```sh
python -m venv .venv
```

Windows:

```powershell
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe listen_pc.py --list
.venv\Scripts\python.exe listen_pc.py --port COM3
```

Mac:

```sh
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python listen_pc.py --list
.venv/bin/python listen_pc.py --port /dev/cu.usbmodem101
```

포트 이름은 실제 장치 목록에 맞춰 바꿉니다. Espressif USB 장치가 한 대면 `--port`를 생략해도 됩니다.

## 옵션과 문제 확인

- `--list`: 포트와 오디오 장치 목록만 표시합니다.
- `--output 2`: 장치 목록의 2번 장치로 재생합니다. 번호는 환경마다 다릅니다.
- `--gain 2`: 재생 음량을 2배로 설정합니다. 기본값은 1배입니다. 너무 높이면 소리가 찌그러질 수 있습니다.
- `--buffer-ms 100`: 끊김 완충 시간을 100ms로 늘립니다. 기본값은 60ms이며 늘릴수록 재생이 더 늦게 들립니다.
- `--always`: 버튼과 관계없이 계속 재생합니다. 하울링에 주의하세요.
- `MIC_RMS`가 소리에 따라 변하면 입력 데이터가 반응하는 것입니다.
- `BTN=1`일 때만 소리가 나오는 것이 기본 동작입니다.
- 데이터가 없으면 오디오 전송 스케치가 업로드되었는지와 포트 점유 여부를 확인합니다.
- 소리는 입력되지만 들리지 않으면 기본 오디오 출력과 PC 음량을 확인합니다.
- 48kHz 출력을 지원하지 않는 장치는 `--output`으로 다른 출력 장치를 선택합니다.

USB 전송은 48kHz 모노 16비트 PCM입니다. 연결 중 지연이 계속 쌓이지 않도록 오래된 재생 데이터는 버립니다.
오디오 프레임 CRC를 확인해 부팅 로그나 손상된 데이터가 소음으로 재생되는 것을 줄입니다.

## 팝·퍽 소리 개선 버전

PC 프로그램에 60ms 사전 버퍼, DC 성분 제거, 버튼 전환 및 재생 재개 시 5ms 페이드를 추가했습니다.
버튼을 놓으면 소리가 서서히 줄어든 뒤 무음을 계속 재생해 스트림 타이밍을 유지합니다.
PC 출력은 10ms 단위와 안정성을 우선하는 출력 지연 설정을 사용합니다.
기존 실행 중인 프로그램은 Ctrl+C로 종료하고 실행 파일을 다시 열어야 수정이 적용됩니다.
이번 변경은 PC 코드에만 있으므로 기존 오디오 전송 스케치가 올라가 있으면 보드를 다시 업로드할 필요는 없습니다.

반복되는 팝 소리가 남으면 실행 중 표시되는 다음 누적 수치의 증가 여부를 확인합니다.

- `starve`: PC 재생 버퍼의 음성이 부족했던 횟수. 증가하면 `--buffer-ms 100`으로 시도합니다.
- `out_underflow`: 오디오 드라이버에 재생 데이터를 제때 공급하지 못한 횟수.
- `gaps`: ESP32가 생성한 패킷 중 수신하지 못한 개수. 증가하면 전송 쪽 추가 점검이 필요합니다.
- `bad`: 잘못된 프레임 또는 CRC 검증 실패 횟수. 부팅 로그 뒤 프레임을 다시 찾는 과정에서도 증가할 수 있습니다.
- `dropped`: 지연 누적을 막으려고 PC 버퍼에서 버린 오디오 샘플 프레임 수.
- `clip`: PC의 음량 조절 뒤 허용 범위를 넘은 샘플 수. 증가하면 `--gain`을 낮춥니다.

기본 출력이 AirPods 등 블루투스 장치로 바뀌었으면 `--list`에서 장치를 확인하고 `--output`으로 원하는 스피커를 지정합니다.
증상이 계속되면 이어폰 또는 Mac 내장 스피커와 비교하고, 전원을 분리한 후 마이크 배선과 3.3V 전원 연결을 점검합니다.

## 참고 문서

- [Espressif Arduino I2S](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/i2s.html)
- [Espressif USB CDC 설정](https://docs.espressif.com/projects/arduino-esp32/en/latest/tutorials/cdc_dfu_flash.html)
- [sounddevice 오디오 스트림](https://python-sounddevice.readthedocs.io/en/latest/api/streams.html)
- [sounddevice 재생 끊김과 지연 설정](https://python-sounddevice.readthedocs.io/en/latest/api/misc.html)
- [pySerial API](https://pyserial.readthedocs.io/en/latest/pyserial_api.html)
