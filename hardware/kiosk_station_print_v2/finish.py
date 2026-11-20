"""Assemble, validate, render and pack the FDM kit into 210 mm 3MF plates."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json,math,subprocess,zipfile
import numpy as np
import trimesh
from PIL import Image,ImageDraw,ImageFont
HERE=Path(__file__).resolve().parent;OUT=HERE.parents[1]/'output'/'kiosk_station_print_v2'
STL=OUT/'STL';PLATES=OUT/'3MF_plates';IMG=OUT/'images'
for p in [PLATES,IMG]:p.mkdir(exist_ok=True)
manifest=json.loads((OUT/'manifest.json').read_text());parts={p['file']:p for p in manifest['parts']}
def T(v):m=np.eye(4);m[:3,3]=v;return m
def rz(a):return trimesh.transformations.rotation_matrix(math.radians(a),[0,0,1])
def rx(a):return trimesh.transformations.rotation_matrix(math.radians(a),[1,0,0])
meshes={name:trimesh.load_mesh(STL/name) for name in parts}
instances=[]
def inst(file,matrix,group):instances.append({'file':file,'matrix':np.array(matrix),'group':group})
for p in manifest['parts']:
 if not p.get('accessory'):inst(p['file'],p['assembly_matrix'],p['panel'])
for s in manifest['seams']:
 n=s['panel'];x,y=s['center'];p=parts['seam_bar.stl'];stock=manifest['panels'][n]['thickness']
 m=T([x,y,-8 if s['head_top'] else stock+8])@rz(90 if s['axis'] else 0)
 if not s['head_top']:m=m@rx(180)
 inst('seam_bar.stl',np.array(manifest['panels'][n]['matrix'])@m@T(p['raw_origin']),'joints')
Pprint=T([0,24,9])@rx(90)
for c in manifest['corners']:inst('corner_M4.stl',np.array(c)@np.linalg.inv(Pprint)@T(parts['corner_M4.stl']['raw_origin']),'corners')
for s in manifest['supports']:
 file=f'pillar_{s["height"]}.stl';inst(file,T(s['center'])@T(parts[file]['raw_origin']),'supports')
for x in [37,157]:inst('stand_stop.stl',T([x,206,78])@T(parts['stand_stop.stl']['raw_origin']),'retention')
inst('stand_front_bar.stl',T([13,27,84.8])@T(parts['stand_front_bar.stl']['raw_origin']),'retention')
# Ensure every manifest quantity is represented exactly once per installed item.
for name,p in parts.items():assert sum(i['file']==name for i in instances)==p['quantity'],name
assembled=[]
for i in instances:
 m=meshes[i['file']].copy();m.apply_transform(i['matrix']);assembled.append(m)
# Pairwise assembled interference checks. Face contact is allowed, penetration is not.
bounds=np.array([m.bounds for m in assembled]);penetrations=[]
for a in range(len(assembled)):
 for b in range(a+1,len(assembled)):
  overlap=np.minimum(bounds[a,1],bounds[b,1])-np.maximum(bounds[a,0],bounds[b,0])
  if np.any(overlap<1e-4):continue
  inter=trimesh.boolean.intersection([assembled[a],assembled[b]],engine='manifold')
  if inter is not None and abs(inter.volume)>0.02:
   penetrations.append((a,b,instances[a]['file'],instances[b]['file'],round(abs(inter.volume),4)))
(OUT/'pair_interference.json').write_text(json.dumps(penetrations,indent=2)+'\n')
assert not penetrations,penetrations[:12]
# Source functions provide only equipment illustrations; the cabinet uses exported parts.
scene=HERE/'assembly_actual.scad';code=f'include <{HERE / "kiosk_station.scad"}>\n'
code+='view="complete";\nmodule actual_kit() {\n'
for i in instances:
 color=[.88,.91,.90] if i['group'] in ['pc_front','printer_front','pc_top','high_top'] else [.17,.26,.31]
 if i['group'] in ['joints','corners','retention']:color=[.29,.40,.91]
 code+=f'color({color}) multmatrix({i["matrix"].round(8).tolist()}) import("{STL/i["file"]}");\n'
code+='}\n'
code+='''
if(view=="complete") {actual_kit();components();monitor();monitor_cables();}
else if(view=="case") {actual_kit();components();}
else if(view=="stand") {
 stand_retention();
 color([.88,.91,.90]) translate([0,0,66]) pc_top();
 color([.10,.12,.13]) translate([27,26,76.8]) rr(180,180,12,8);
}
else if(view=="split_top") {
'''
for i in instances:
 if i['group'] in ['pc_top','retention']:
  code+=f'color([.8,.86,.87]) multmatrix({i["matrix"].round(8).tolist()}) import("{STL/i["file"]}");\n'
code+='}\nelse if(view=="internals") {components();cables();}\n'
scene.write_text(code)
# Deterministic max-rect style bin placement, with 5 mm per-part brim reserve.
items=[]
for file,p in parts.items():
 for idx in range(p['quantity']):items.append((file,idx,meshes[file].extents[:2]))
items.sort(key=lambda v:-(v[2][0]+10)*(v[2][1]+10))
plates=[]
for file,idx,size in items:
 best=None
 for pi,plate in enumerate(plates):
  for ri,(x,y,w,h) in enumerate(plate['free']):
   for turn in [0,90,45]:
    rotated=meshes[file].copy();rotated.apply_transform(rz(turn))
    iw,ih=rotated.extents[:2]+10
    if iw<=w+1e-4 and ih<=h+1e-4:
     score=(min(w-iw,h-ih),w*h-iw*ih)
     if best is None or score<best[0]:best=(score,pi,ri,turn,iw,ih)
 if best is None:
  plates.append({'free':[(0.,0.,210.,210.)],'items':[]})
  opts=[]
  for ang in [0,90,45]:
   temp=meshes[file].copy();temp.apply_transform(rz(ang));iw,ih=temp.extents[:2]+10
   if iw<=210 and ih<=210:opts.append((max(iw,ih),ang,iw,ih))
  assert opts,file
  _,ang,iw,ih=min(opts);best=((0,0),len(plates)-1,0,ang,iw,ih)
 _,pi,ri,turn,iw,ih=best;plate=plates[pi];x,y,w,h=plate['free'].pop(ri)
 if w-iw>1:plate['free'].append((x+iw,y,w-iw,ih))
 if h-ih>1:plate['free'].append((x,y+ih,w,h-ih))
 m=meshes[file].copy();rot=rz(turn);m.apply_transform(rot)
 lo=m.bounds[0];shift=np.array([23+x+5,23+y+5,0])-lo
 matrix=T(shift)@rot
 plate['items'].append({'file':file,'copy':idx+1,'matrix':matrix.tolist()})
for pi,plate in enumerate(plates,1):
 s=trimesh.Scene()
 for entry in plate['items']:
  name=Path(entry['file']).stem+f'_{entry["copy"]:02d}'
  s.add_geometry(meshes[entry['file']],geom_name=entry['file'],node_name=name,transform=np.array(entry['matrix']))
 data=trimesh.exchange.threemf.export_3MF(s)
 path=PLATES/f'plate_{pi:02d}.3mf';path.write_bytes(data)
 check=trimesh.load(path,force='scene');lo,hi=check.bounds
 assert lo[0]>=23-1e-3 and lo[1]>=23-1e-3 and hi[0]<=233+1e-3 and hi[1]<=233+1e-3
 assert hi[2]<=210 and abs(lo[2])<1e-4
plate_manifest=[{'plate':f'plate_{i+1:02d}.3mf','items':p['items']} for i,p in enumerate(plates)]
(OUT/'plates.json').write_text(json.dumps(plate_manifest,indent=2)+'\n')
(OUT/'assembly_instances.json').write_text(json.dumps([{'file':i['file'],'matrix':i['matrix'].tolist(),'group':i['group']} for i in instances],indent=2)+'\n')
validation={'unique_STL_files':len(parts),'total_printed_pieces':len(instances),'plates':len(plates),
 'maximum_piece_dimension_mm':manifest['max_piece_extent_mm'],'limit_mm':210,
 'all_meshes_watertight':all(m.is_watertight for m in meshes.values()),'assembly_penetrations':0,
 'screws':{'M4x6_machine':manifest['screws_M4x6'],'M3x10':manifest['screws_M3x10']},
 'stand_underside_support':'182 x 182 x 1.2 mm pocket, full-base contact, supported pressure bar above front edge',
 'physical_load_thermal_and_print_tests':False}
(OUT/'validation.json').write_text(json.dumps(validation,indent=2)+'\n')
# Clean, text-free model views.
scenes=[('01_통합_완성도','complete','0,0,0,66,0,25,1300',(2400,2400)),
 ('02_분할_하부장','case','0,0,0,55,0,25,1100',(2800,2100)),
 ('03_바닥밀착_스탠드','stand','0,0,0,40,0,25,600',(2400,2000)),
 ('04_받침판_분할','split_top','0,0,0,20,0,0,600',(2200,2000)),
 ('05_장비_배선','internals','0,0,0,28,0,25,1100',(2800,2200))]
def render(item):
 name,view,cam,size=item;path=IMG/(name+'.png')
 subprocess.run(['openscad','-q','-o',str(path),'--render','--viewall','--autocenter','--projection=o',
  f'--camera={cam}',f'--imgsize={size[0]},{size[1]}','--colorscheme=Tomorrow',
  '-D','part="none"','-D',f'view="{view}"',str(scene)],check=True)
 im=np.array(Image.open(path).convert('RGB'));bg=im[0,0].copy();im[np.all(im==bg,axis=2)]=255
 Image.fromarray(im).save(path,dpi=(300,300));return name
with ThreadPoolExecutor(max_workers=2) as ex:
 for name in ex.map(render,scenes):print('Rendered',name,flush=True)
print(json.dumps(validation,indent=2))
