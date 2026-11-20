"""Render text-free report images from the actual CAD model."""
from pathlib import Path
import subprocess
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
import numpy as np
HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'output'/'enclosure_v3_report_images'
OUT.mkdir(parents=True,exist_ok=True)
SCENES=[
 ('01_완성_예상도','complete','0,0,0,55,0,25,260',(3000,2200)),
 ('02_USB_C_후면','rear','0,0,0,58,0,205,260',(3000,2200)),
 ('03_본체_내부_구조','base','0,0,0,25,0,15,260',(3000,2200)),
 ('04_ESP32_장착_구조','esp_mount','0,0,0,20,0,5,260',(3000,2200)),
 ('05_뚜껑_내부_구조','lid','0,0,0,32,0,25,260',(3000,2200)),
 ('06_마이크_고정_브래킷','bracket','0,0,0,35,0,25,100',(3000,2200)),
 ('07_마이크_분해_조립도','mic_exploded','0,0,0,60,0,25,100',(2600,3000)),
 ('08_전체_분해_조립도','system_exploded','0,0,0,67,0,25,400',(2600,3600)),
]
def render(item):
 name,shot,cam,size=item
 temp=OUT/(name+'.raw.png')
 subprocess.run(['openscad','-q','-o',str(temp),'--render',f'--imgsize={size[0]*2},{size[1]*2}',
                 '--viewall','--autocenter',f'--camera={cam}','--projection=o','--colorscheme=Tomorrow',
                 '-D','part="none"','-D',f'shot="{shot}"','-D','$fn=128',str(HERE/'report_scenes.scad')],check=True)
 a=np.array(Image.open(temp).convert('RGB'))
 bg=a[0,0].copy(); a[np.all(a==bg,axis=2)]=255
 image=Image.fromarray(a).resize(size,Image.Resampling.LANCZOS)
 image.save(OUT/(name+'.png'),dpi=(300,300));temp.unlink()
 return name
if __name__=='__main__':
 with ThreadPoolExecutor(max_workers=3) as pool:
  for name in pool.map(render,SCENES):print(name)
