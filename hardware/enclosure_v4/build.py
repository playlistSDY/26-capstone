"""Export small-box v4 geometry and text-free technical previews."""
from pathlib import Path
import subprocess
from concurrent.futures import ThreadPoolExecutor
HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'output'/'enclosure_v4'
SCAD=HERE/'switch_enclosure.scad'
PARTS={'base':'base','lid_white':'lid','logo_black':'logo','esp_keeper':'esp_keeper',
       'mic_bracket':'mic_bracket','button_fit_coupon':'fit_coupon','esp_fit_coupon':'esp_coupon'}
def export(item):
 name,part=item
 subprocess.run(['openscad','-q','-o',str(OUT/f'{name}.stl'),'-D',f'part="{part}"',str(SCAD)],check=True)
 return name
SCENES=[('01_완성_예상도','assembly','0,0,0,55,0,25,250'),
        ('02_ESP32_내부배치','base','0,0,0,25,0,205,250'),
        ('03_USB_보드_고정구조','esp_detail','0,0,0,50,0,205,180'),
        ('04_버튼홈_로고','lid_exterior','0,0,0,0,0,0,250'),
        ('05_분해도','exploded','0,0,0,58,0,25,300')]
def render(item):
 name,part,cam=item
 subprocess.run(['openscad','-q','-o',str(OUT/f'{name}.png'),'--render','--viewall','--autocenter',
  '--imgsize=1800,1400',f'--camera={cam}','--colorscheme=Tomorrow','-D',f'part="{part}"',str(SCAD)],check=True)
 return name
if __name__=='__main__':
 OUT.mkdir(parents=True,exist_ok=True)
 with ThreadPoolExecutor(max_workers=3) as pool:
  for name in pool.map(export,PARTS.items()):print('Exported',name)
 with ThreadPoolExecutor(max_workers=2) as pool:
  for name in pool.map(render,SCENES):print('Rendered',name)
