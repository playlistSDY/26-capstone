/*
 * ICS-43434 -> native USB serial -> PC speaker monitor.
 * Arduino-ESP32 3.x / ESP32S3 Dev Module
 * USB Mode: Hardware CDC and JTAG / USB CDC On Boot: Enabled
 *
 * BCLK=4 LRCL=5 DOUT=6 SEL=GND 3V=3V3 GND=GND
 * BUTTON=7 (switch to GND), LED=8 (330 ohm series resistor, active HIGH).
 * Stream: 48 kHz mono signed 16-bit little-endian PCM in CRC-checked frames.
 * The companion PC program decides whether to play based on the button flag.
 */

#include <Arduino.h>
#include <ESP_I2S.h>
#include <string.h>

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
#error "Select ESP32S3 Dev Module."
#endif
#if !ARDUINO_USB_MODE || !ARDUINO_USB_CDC_ON_BOOT
#error "Enable Hardware CDC and JTAG and USB CDC On Boot."
#endif

constexpr uint8_t MIC_BCLK = 4;
constexpr uint8_t MIC_LRCL = 5;
constexpr uint8_t MIC_DOUT = 6;
constexpr uint8_t BUTTON_PIN = 7;
constexpr uint8_t LED_PIN = 8;
constexpr uint32_t SAMPLE_RATE = 48000;
constexpr size_t BLOCK_SAMPLES = 256;

// Matches Python struct '<8sIHBBII' (24 bytes). ESP32 is little-endian.
struct __attribute__((packed)) AudioHeader {
  char magic[8];
  uint32_t sampleRate;
  uint16_t sampleCount;
  uint8_t flags;  // bit 0: button held, bit 1: microphone driver ready
  uint8_t version;
  uint32_t sequence;
  uint32_t crc32;
};
static_assert(sizeof(AudioHeader) == 24, "Unexpected packet header size");

I2SClass mic;
int32_t inputSamples[BLOCK_SAMPLES];
uint8_t packet[sizeof(AudioHeader) + BLOCK_SAMPLES * sizeof(int16_t)];
bool micReady = false;
bool rawPressed = false;
bool buttonPressed = false;
uint32_t rawChangedAt = 0;
uint32_t sequence = 0;
uint32_t lastErrorAt = 0;

uint32_t pcmCrc32(const uint8_t *data, size_t size) {
  uint32_t crc = 0xFFFFFFFF;
  for (size_t i = 0; i < size; ++i) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc >> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
  }
  return ~crc;
}

void updateButton() {
  const bool pressed = digitalRead(BUTTON_PIN) == LOW;
  const uint32_t now = millis();
  if (pressed != rawPressed) {
    rawPressed = pressed;
    rawChangedAt = now;
  }
  if (now - rawChangedAt >= 25) {
    buttonPressed = rawPressed;
  }
  digitalWrite(LED_PIN, buttonPressed ? HIGH : LOW);
}

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  Serial.setTxBufferSize(8192);
  Serial.setTxTimeoutMs(10);
  Serial.begin(921600);
  for (uint8_t i = 0; i < 3; ++i) {
    digitalWrite(LED_PIN, HIGH);
    delay(100);
    digitalWrite(LED_PIN, LOW);
    delay(100);
  }
  mic.setPins(MIC_BCLK, MIC_LRCL, -1, MIC_DOUT);
  micReady = mic.begin(
    I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_32BIT,
    I2S_SLOT_MODE_MONO, I2S_STD_SLOT_LEFT
  );
}

void loop() {
  updateButton();
  if (!micReady) {
    if (Serial && millis() - lastErrorAt >= 1000) {
      Serial.println("ERROR: microphone I2S initialization failed.");
      lastErrorAt = millis();
    }
    delay(1);
    return;
  }

  size_t bytesRead = 0;
  // Keep the button responsive when I2S is temporarily unavailable.
  i2s_channel_read(mic.rxChan(), inputSamples, sizeof(inputSamples), &bytesRead, 10);
  updateButton();
  const size_t count = bytesRead / sizeof(inputSamples[0]);
  if (count == 0) {
    return;
  }

  uint8_t *pcm = packet + sizeof(AudioHeader);
  for (size_t i = 0; i < count; ++i) {
    const int16_t sample = static_cast<int16_t>(inputSamples[i] / 65536);
    pcm[2 * i] = static_cast<uint16_t>(sample) & 0xFF;
    pcm[2 * i + 1] = (static_cast<uint16_t>(sample) >> 8) & 0xFF;
  }

  AudioHeader header = {{'S', 'W', 'P', 'C', 'M', '0', '1', '\n'}, SAMPLE_RATE,
    static_cast<uint16_t>(count), static_cast<uint8_t>(2 | (buttonPressed ? 1 : 0)),
    1, sequence++, pcmCrc32(pcm, count * sizeof(int16_t))};
  memcpy(packet, &header, sizeof(header));
  const size_t packetSize = sizeof(header) + count * sizeof(int16_t);

  // Do not queue old audio indefinitely if the PC is absent or too slow.
  if (Serial && Serial.availableForWrite() >= static_cast<int>(packetSize)) {
    Serial.write(packet, packetSize);
  }
  // No text logs here: this USB port carries binary PCM frames.
}
