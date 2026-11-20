"""Export plywood profiles, printable clips and text-free CAD report renders."""
from pathlib import Path
import subprocess
from concurrent.futures import ThreadPoolExecutor
HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'output'/'kiosk_station_v1'
SCAD=HERE/'kiosk_station.scad'
PANELS={'bottom':(430,330,9,1),'side':(330,169,9,1),'right':(262,160,9,1),
 'front':(225,57,6,1),'printer_front_panel':(178,160,6,1),'rear':(412,160,6,1),
 'top':(430,262,9,1),'pc_top':(234,230,12,1),'divider':(318,160,9,1),
 'rear_left_front':(225,91,6,1),'adapter_tray':(171,88,6,1),
 'stand_pad':(160,160,4,1),'lower_adapter_tray':(136,74,6,1),'printer_tray':(153,157,6,1)}
# part selector differs from module name for the printer fascia.
SELECTOR={'printer_front_panel':'printer_front'}
def export_part(name):
 part=SELECTOR.get(name,name)
 subprocess.run(['openscad','-q','-o',str(OUT/f'{name}.stl'),'-D',f'part="{part}"',str(SCAD)],check=True)
 if name in PANELS:
  # Projection only: printer strips / 0.6 mm logo engraving stay in STL.
  wrapper=OUT/f'_{name}_profile.scad'
  wrapper.write_text(f'include <{SCAD}>\nprojection(cut=false) {name if name != "side" else "side_panel"}();\n')
  modules={'bottom':'bottom','side':'side_panel','right':'right_panel','front':'front_panel',
   'rear':'rear_panel','top':'top_panel','pc_top':'pc_top','divider':'divider',
   'rear_left_front':'rear_left_front','adapter_tray':'adapter_tray',
   'stand_pad':'stand_pad','lower_adapter_tray':'lower_adapter_tray','printer_tray':'printer_tray','printer_front_panel':'printer_front_panel'}
  wrapper.write_text(f'include <{SCAD}>\nprojection(cut=false) {modules[name]}();\n')
  subprocess.run(['openscad','-q','-o',str(OUT/f'{name}.dxf'),'-D','part="none"',str(wrapper)],check=True)
  wrapper.unlink()
 return name
SCENES=[('01_완성_예상도','kiosk','0,0,0,66,0,25,1200',(2600,2600)),
 ('02_하부장_외형','assembly','0,0,0,55,0,25,1000',(3000,2100)),
 ('03_내부_배치','cutaway','0,0,0,28,0,25,1000',(3000,2400)),
 ('04_내부_평면','cutaway','0,0,0,0,0,0,1000',(2600,2300)),
 ('05_분해_조립도','exploded','0,0,0,52,0,25,1500',(3000,2600)),
 ('06_스탠드_고정부','retention','0,0,0,30,0,25,500',(2700,2200)),
 ('07_전면_단차','assembly','0,0,0,75,0,0,1000',(3000,2000)),
 ('08_끼움클립_상세','clip_detail','0,0,0,55,0,205,150',(2200,1800))]
def render(scene):
 from PIL import Image
 import numpy as np
 name,part,cam,size=scene
 path=OUT/(name+'.png')
 subprocess.run(['openscad','-q','-o',str(path),'--render',f'--imgsize={size[0]},{size[1]}',
  '--viewall','--autocenter','--projection=o',f'--camera={cam}','--colorscheme=Tomorrow',
  '-D',f'part="{part}"',str(SCAD)],check=True)
 a=np.array(Image.open(path).convert('RGB'));bg=a[0,0].copy();a[np.all(a==bg,axis=2)]=255
 Image.fromarray(a).save(path,dpi=(300,300))
 return name
if __name__=='__main__':
 OUT.mkdir(parents=True,exist_ok=True)
 with ThreadPoolExecutor(max_workers=3) as pool:
  for name in pool.map(export_part,list(PANELS)+['stand_clip','stand_stop','cable_clip','spacer_foot']):print('Exported',name)
 with ThreadPoolExecutor(max_workers=3) as pool:
  for name in pool.map(render,SCENES):print('Rendered',name)
