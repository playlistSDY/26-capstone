# 마이크 버튼 LED 동작 확인

Arduino-ESP32 3.x용 ESP32-S3 테스트 스케치입니다. 별도 라이브러리 설치는 필요하지 않습니다.
음성 입력은 버튼과 관계없이 계속 측정합니다. 음성 재생, 서버 전송, 음성인식 기능은 포함하지 않습니다.

실제 소리를 PC 스피커로 들으려면 [오디오 모니터 버전](../kiosk_audio_monitor/README.md)을 사용하세요. 배선은 동일합니다.

## 배선

전원을 분리한 상태에서 연결합니다. 표의 숫자는 보드에 인쇄된 GPIO 번호입니다.

| 부품 | 단자 | 연결 |
| --- | --- | --- |
| ICS-43434 | 3V | 3V3 |
| ICS-43434 | GND | GND |
| ICS-43434 | SEL | GND (왼쪽 채널) |
| ICS-43434 | BCLK | GPIO 4 |
| ICS-43434 | LRCL | GPIO 5 |
| ICS-43434 | DOUT | GPIO 6 |
| 푸시버튼 | 평상시 분리된 두 접점 | GPIO 7과 GND |
| 일반 2핀 LED | + (애노드) | GPIO 8 → 330Ω 저항 → LED + |
| 일반 2핀 LED | - (캐소드) | GND |

마이크 3V에는 5V를 연결하지 마세요. LED는 별도 일반 2핀 LED 기준입니다.
4핀 택트스위치는 놓았을 때 끊기고 눌렀을 때 연결되는 두 다리를 사용하세요.

## Arduino IDE 설정

1. 보드 매니저에서 `esp32 by Espressif Systems` 3.x를 사용합니다.
2. `kiosk_hardware_test.ino`를 엽니다. 스케치와 폴더 이름을 동일하게 유지하세요.
3. 보드는 `ESP32S3 Dev Module`을 선택합니다.
4. `USB Mode`는 `Hardware CDC and JTAG`, `USB CDC On Boot`는 `Enabled`로 설정합니다.
5. 실제 보드의 USB 포트를 선택해 업로드합니다. 다른 플래시·PSRAM 설정은 구매 보드 사양을 따릅니다.
6. 시리얼 모니터를 `115200 baud`로 열고, 시작 메시지가 없으면 RESET을 한 번 누릅니다.

처음 업로드가 안 되면 BOOT을 누른 상태로 RESET을 눌렀다 놓고, BOOT을 놓은 뒤 포트를 다시 선택합니다.

## 정상 동작 확인

- 부팅 시 LED가 세 번 깜빡입니다.
- 버튼을 누르는 동안 LED가 켜지고 `BTN:1 LED:1`이 출력됩니다.
- 버튼을 놓으면 LED가 꺼지고 `BTN:0 LED:0`이 출력됩니다.
- 0.2초마다 마이크 크기가 출력됩니다. 가까이서 말하거나 손뼉을 치면 `RMS`, `PEAK`가 조용할 때보다 증가해야 합니다.
- `dBFS`는 디지털 신호 크기입니다. 실제 소음계의 dB SPL 값이 아닙니다. 음량이 커지면 일반적으로 덜 음수인 값이 됩니다.
- `SAMPLES`는 해당 구간의 수신 샘플 수, `NONZERO`는 0이 아닌 원시 샘플의 비율(%)입니다.
- `CLIP`이 자주 증가하면 신호가 포화될 수 있으니 거리를 늘려봅니다.
- `ERR`은 해당 구간의 읽기 오류 수입니다. 타임아웃은 제외합니다.

`I2S initialization: OK`는 ESP32 드라이버 초기화 성공을 뜻하며 마이크 연결을 검출한 결과가 아닙니다.
입력이 계속 0이라면 전원/GND, DOUT=6, BCLK=4, LRCL=5, SEL=GND부터 확인하세요.
`SAMPLES`가 나오더라도 신호가 소리에 반응하지 않으면 연결이 정상이라고 판단할 수 없습니다.

## 참고

- [Espressif Arduino I2S](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/i2s.html)
- [Espressif USB CDC 설정](https://docs.espressif.com/projects/arduino-esp32/en/latest/tutorials/cdc_dfu_flash.html)
