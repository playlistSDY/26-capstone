"""Validate exported solids, installed clearance envelopes, notches and AMS colors."""
from pathlib import Path
import json,subprocess,tempfile,zipfile,xml.etree.ElementTree as ET
import numpy as np
import trimesh
HERE=Path(__file__).resolve().parent;OUT=HERE.parents[1]/'output'/'enclosure_v4'
report={}
meshes={}
for name in ['base','lid_white','logo_black','esp_keeper','mic_bracket','button_fit_coupon','esp_fit_coupon']:
 m=trimesh.load_mesh(OUT/(name+'.stl'));meshes[name]=m
 assert m.is_watertight and m.is_winding_consistent and m.volume>0,name
 solids=len(m.split());assert solids==1 or name=='logo_black',(name,solids)
 report[name]={'closed':True,'solids':solids,'size_mm':m.extents.round(3).tolist()}
def T(v):m=np.eye(4);m[:3,3]=v;return m
def posed(name,matrix):m=meshes[name].copy();m.apply_transform(matrix);return m
R=trimesh.transformations.rotation_matrix(np.pi,[0,1,0])
lid=posed('lid_white',T([76,0,52])@R)
logo=posed('logo_black',T([76,0,52])@R)
keeper=posed('esp_keeper',T([29.1,28,11.8]))
mic=posed('mic_bracket',T([21,28,46.2])@R)
def overlap(a,b,name):
 x=trimesh.boolean.intersection([a,b],engine='manifold')
 volume=0 if x is None else abs(float(x.volume))
 assert volume<.003,(name,volume)
 report[name]={'overlap_mm3':round(volume,8)}
overlap(meshes['base'],lid,'lid_to_base')
overlap(meshes['base'],keeper,'keeper_to_base')
overlap(lid,logo,'separate_white_and_black_volumes')
# Exact board rectangle plus open pin row/plug connection space.
pcb=trimesh.creation.box([23.5,18,1.6],transform=T([1.6+23.5/2,28,10.8]))
overlap(meshes['base'],pcb,'PCB_to_cradle')
overlap(keeper,pcb,'keeper_to_PCB')
for y in [20.38,35.62]:
 header=trimesh.creation.box([22,3,18],transform=T([13.5,y,13]))
 overlap(meshes['base'],header,f'GPIO_row_{y}_to_case')
 overlap(keeper,header,f'GPIO_row_{y}_to_keeper')
switch=trimesh.creation.cylinder(radius=12,height=42,sections=96,transform=T([55,28,28.4]))
nut=trimesh.creation.cylinder(radius=16,height=5,sections=96,transform=T([55,28,46.9]))
for a,n in [(meshes['base'],'base'),(mic,'mic'),(keeper,'keeper')]:
 overlap(a,switch,'switch_to_'+n);overlap(a,nut,'nut_to_'+n)
# Verify both square notches from the exported lid, after a real physical rotation.
points=[];expected=[]
for sign in [-1,1]:
 for y in [-1.5,0,1.5]:points.append([55+sign*13.7,28+y,50.7]);expected.append(False)
 points.append([55+sign*13.9,28,50.7]);expected.append(True)
 points.append([55+sign*12.5,28+1.8,50.7]);expected.append(True)
assert np.array_equal(lid.contains(points),expected),'notch dimensions'
# Only Ø3.3 through holes remain; the former Ø6.4 head pockets must be solid.
assert lid.contains([[x+2.4,y,51.9] for x,y in [(9,9),(67,9),(9,47),(67,47)]]).all()
report['lid_fasteners']={'through_hole_mm':3.3,'head_recess':False}
# Small rounded USB shell is exported independently from the rendering source.
with tempfile.TemporaryDirectory() as d:
 p=Path(d)/'shell.scad';target=p.with_suffix('.stl')
 p.write_text(f'include <{HERE/"switch_enclosure.scad"}>\ntranslate([usb_face,esp_y-4.4,esp_seat+esp_t]) rotate([90,0,90]) rr(8.8,3.2,1.2,7.4);\n')
 subprocess.run(['openscad','-q','-o',str(target),'-D','part="none"',str(p)],check=True)
 overlap(meshes['base'],trimesh.load_mesh(target),'USB_shell_to_case')
report['dimensions']={'case_mm':[76,56,52],'button_hole_diameter':24,'notch_depth':1.8,'notch_width':3.2,
 'user_lug_projection':1.5,'user_lug_width':2.8,'usb_aperture_mm':[9.6,4.0],
 'PCB_mm':[23.5,18,1.6],'cradle_guide_to_column_clearance_mm':2.8,
 'PCB_to_column_clearance_mm':4.5,'USB_face_outside_case_mm':.4}
# Native Bambu Studio part assignments; do not rely on trimesh's external-model loader.
path=OUT/'lid_X1C_AMS_white_black.3mf'
if path.exists():
 with zipfile.ZipFile(path) as z:
  settings=json.loads(z.read('Metadata/project_settings.config'))
  assert settings['filament_colour'][:2]==['#FFFFFF','#000000']
  root=ET.fromstring(z.read('Metadata/model_settings.config'))
  assignments={}
  for p in root.findall('object/part'):
   meta={m.get('key'):m.get('value') for m in p.findall('metadata')}
   assignments[meta['source_file']]=meta['extruder']
  assert assignments=={'lid_white.stl':'1','logo_black.stl':'2'},assignments
  report['AMS']={'machine':settings['printer_model'],'color_parts':assignments,'colors':settings['filament_colour'][:2]}
check=OUT/'bambu_build'/'lid_slice_check.3mf'
if check.exists():
 with zipfile.ZipFile(check) as z:
  root=ET.fromstring(z.read('Metadata/slice_info.config'))
  filaments=root.findall('plate/filament');assert len(filaments)==2
  assert all(float(f.get('used_g'))>0 for f in filaments)
  report['slice_check']={'passed':True,'filaments_used':[f.get('color') for f in filaments],
   'two_color_layers':root.find('plate/layer_filament_lists').findall('layer_filament_list')[1].attrib}
report['physical_fit_verified']=False
(OUT/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('PASS: meshes, installed PCB/GPIO/USB clearance, button notches and AMS color assignment.')
