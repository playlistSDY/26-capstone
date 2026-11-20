"""Generate the original SWitch v2 earcons; NumPy is needed only to rebuild assets."""
from pathlib import Path
import hashlib,json,wave
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
DEST=ROOT/'public/assets/sounds/v2'
RATE=48000
rng=np.random.default_rng(20261120)

def tone(f,dur,style='pluck',gain=1):
    t=np.arange(round(dur*RATE))/RATE
    attack=np.minimum(t/.004,1)
    fade=np.minimum((dur-t)/.018,1).clip(0,1)
    if style=='wood':
        signal=(np.sin(2*np.pi*f*t)*.7+np.sin(2*np.pi*f*2.73*t)*.22+rng.normal(0,1,len(t))*.07*np.exp(-t*160))
        env=np.exp(-t*38)*attack*fade
    elif style=='bell':
        signal=np.sin(2*np.pi*f*t)+.24*np.sin(2*np.pi*f*2.01*t)*np.exp(-t*5)+.10*np.sin(2*np.pi*f*3.97*t)*np.exp(-t*10)
        env=np.exp(-t*5)*attack*fade
    elif style=='softbuzz':
        signal=np.sin(2*np.pi*f*t)+.28*np.sin(2*np.pi*f*3*t)+.12*np.sin(2*np.pi*f*5*t)
        env=(np.sin(np.pi*np.minimum(t/.025,.5))*np.minimum((dur-t)/.025,1)).clip(0,1)
    elif style=='tick':
        signal=np.sin(2*np.pi*f*t)+.35*np.sin(2*np.pi*f*2*t)
        env=np.exp(-t*65)*np.minimum(t/.002,1)*fade
    else:
        signal=np.sin(2*np.pi*f*t)+.22*np.sin(2*np.pi*f*2*t)+.08*np.sin(2*np.pi*f*3*t)
        env=np.exp(-t*14)*attack*fade
    return signal*env*gain

def sequence(parts):
    n=max(round(offset*RATE)+len(signal) for offset,signal in parts)+round(.018*RATE)
    result=np.zeros(n)
    for offset,signal in parts:
        start=round(offset*RATE);result[start:start+len(signal)]+=signal
    result-=np.mean(result)
    fade=round(.003*RATE);result[:fade]*=np.linspace(0,1,fade);result[-fade:]*=np.linspace(1,0,fade)
    result=np.tanh(result*1.25)
    return result

sounds={
 'tap':sequence([(0,tone(730,.095,'wood'))]),
 'select':sequence([(0,tone(587.33,.16)),(.075,tone(880,.18))]),
 'add':sequence([(0,tone(523.25,.18)),(.075,tone(659.25,.18)),(.15,tone(1046.5,.25,'bell',.8))]),
 'increase':sequence([(0,tone(1046.5,.07,'tick')),(.045,tone(1396.9,.08,'tick'))]),
 'decrease':sequence([(0,tone(880,.07,'tick')),(.05,tone(659.25,.09,'tick'))]),
 'back':sequence([(0,tone(659.25,.14)),(.10,tone(440,.18))]),
 'remove':sequence([(0,tone(430,.10,'wood')),(.085,tone(285,.12,'wood'))]),
 'scroll':sequence([(0,tone(1180,.045,'tick'))]),
 'read':sequence([(0,tone(1100,.09,'softbuzz')),(.15,tone(1550,.12,'softbuzz'))]),
 'success':sequence([(0,tone(523.25,.42,'bell',.7)),(.10,tone(659.25,.44,'bell',.7)),(.20,tone(783.99,.46,'bell',.65)),(.32,tone(1046.5,.48,'bell',.6))]),
 'error':sequence([(0,tone(310,.16,'softbuzz')),(.23,tone(260,.21,'softbuzz'))]),
 'print':sequence([(0,tone(620,.055,'wood',.5)),(.065,tone(620,.055,'wood',.5)),(.15,tone(880,.12)),(.27,tone(1174.66,.18))]),
}
labels={'tap':'기본 터치','select':'메뉴·옵션 선택','add':'메뉴 담기','increase':'수량 증가','decrease':'수량 감소','back':'이전·취소','remove':'메뉴 삭제','scroll':'목록 스크롤','read':'카드 인식','success':'주문 완료','error':'오류 안내','print':'출력 알림'}
DEST.mkdir(parents=True,exist_ok=True)
metadata=[];preview=[]
for key,samples in sounds.items():
    target=.58 if key=='scroll' else .86
    samples=samples/max(np.max(np.abs(samples)),1e-9)*target
    rms=float(np.sqrt(np.mean(samples*samples)))
    if rms>.32:samples*=.32/rms
    pcm=np.round(samples*32767).astype('<i2')
    file=DEST/(key+'.wav')
    with wave.open(str(file),'wb') as out:
        out.setnchannels(1);out.setsampwidth(2);out.setframerate(RATE);out.writeframes(pcm.tobytes())
    spectrum=np.abs(np.fft.rfft(samples))
    frequencies=np.fft.rfftfreq(len(samples),1/RATE)
    row={'id':key,'label':labels[key],'file':file.name,'durationMs':round(len(samples)/RATE*1000),
         'peak':round(float(np.max(np.abs(samples))),4),'rmsDbFS':round(float(20*np.log10(np.sqrt(np.mean(samples*samples)))),2),
         'spectralCentroidHz':round(float(np.sum(spectrum*frequencies)/np.sum(spectrum))),
         'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}
    metadata.append(row);preview.extend([samples*.75,np.zeros(round(.6*RATE))])
(DEST/'manifest.json').write_text(json.dumps({'pack':'switch-original-sfx-v2','sampleRate':RATE,'channels':1,'license':'Original audio generated for SWitch; project use permitted.','sounds':metadata},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
preview_path=ROOT.parent/'output/audio/SWitch-SFX-Preview.wav';preview_path.parent.mkdir(parents=True,exist_ok=True)
with wave.open(str(preview_path),'wb') as out:
    out.setnchannels(1);out.setsampwidth(2);out.setframerate(RATE);out.writeframes(np.round(np.concatenate(preview)*32767).astype('<i2').tobytes())
(ROOT/'qa/sound-pack.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'sounds':len(metadata),'bytes':sum(p.stat().st_size for p in DEST.iterdir()),'preview':str(preview_path),'levels':[{k:x[k] for k in ['id','durationMs','rmsDbFS','spectralCentroidHz']} for x in metadata]},ensure_ascii=False,indent=2))
