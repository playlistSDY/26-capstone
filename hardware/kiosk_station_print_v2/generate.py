"""Generate a <=210 mm FDM kit with M3x10 seams and mating corner brackets."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json,math,subprocess,sys
import numpy as np
import trimesh
from shapely.geometry import Point,box,Polygon
from shapely.ops import unary_union
HERE=Path(__file__).resolve().parent;OUT=HERE.parents[1]/'output'/'kiosk_station_print_v2'
RAW=OUT/'_raw';STL=OUT/'STL';GEN=HERE/'generated';SCAD=HERE/'kiosk_station.scad'
for p in [OUT,RAW,STL,GEN]:p.mkdir(parents=True,exist_ok=True)
Rside=np.array([[0,0,1],[1,0,0],[0,1,0]],float)
Rfront=np.array([[1,0,0],[0,0,-1],[0,1,0]],float)
def trans(v):
 m=np.eye(4);m[:3,3]=v;return m
def mat(r,o):
 m=trans(o);m[:3,:3]=r;return m
def rz(a):return trimesh.transformations.rotation_matrix(math.radians(a),[0,0,1])
def rx(a):return trimesh.transformations.rotation_matrix(math.radians(a),[1,0,0])
# name: module, stock thickness, assembled transform, seam screw head on +Z face
P={
 'bottom':('bottom',9,np.eye(4),False),
 'left':('side_panel',9,mat(Rside,[0,0,9]),False),
 'right':('right_panel',9,mat(Rside,[421,68,9]),True),
 'pc_front':('front_panel',6,mat(Rfront,[9,6,9]),True),
 'printer_front':('printer_front_panel',6,mat(Rfront,[243,74,9]),True),
 'rear':('rear_panel',6,mat(Rfront,[9,330,9]),False),
 'high_top':('top_panel',9,trans([0,0,169]),True),
 'pc_top':('pc_top',12,trans([0,0,66]),True),
 'divider':('divider',9,mat(Rside,[234,6,9]),True),
 'rear_front':('rear_left_front',6,mat(Rfront,[9,236,78]),True),
 'upper_tray':('adapter_tray',6,trans([248,235,94]),True),
 'lower_tray':('lower_adapter_tray',6,trans([270,240,43]),True),
 'printer_tray':('printer_tray',6,trans([257,74,17]),True)}
def run(path,out):
 r=subprocess.run(['openscad','-q','-o',str(out),'-D','part="none"',str(path)],capture_output=True,text=True)
 if r.returncode:raise RuntimeError(path.name+': '+r.stderr)
def wrapper(path,code):path.write_text(f'include <{SCAD}>\n'+code)
def raw_job(name):
 mod=P[name][0];path=GEN/f'raw_{name}.scad';wrapper(path,mod+'();\n');run(path,RAW/(name+'.stl'));return name
with ThreadPoolExecutor(max_workers=3) as ex:list(ex.map(raw_job,P))
meshes={n:trimesh.load_mesh(RAW/(n+'.stl')) for n in P}
polys={}
for n,m in meshes.items():
 path=m.section(plane_origin=[0,0,P[n][1]/2],plane_normal=[0,0,1])
 # Keep the original XY frame rather than the path's recentered local basis.
 planar,to3d=path.to_2D();pol=[]
 for poly in planar.polygons_full:
  xy=np.asarray(poly.exterior.coords);xyz=trimesh.transform_points(np.c_[xy,np.zeros(len(xy))],to3d)
  holes=[]
  for ring in poly.interiors:
   a=np.asarray(ring.coords);holes.append(trimesh.transform_points(np.c_[a,np.zeros(len(a))],to3d)[:,:2])
  pol.append(Polygon(xyz[:,:2],holes))
 polys[n]=unary_union(pol)
# Per-panel drill operations: (x,y,head_on_top). Receiving support blocks are piloted.
holes={n:[] for n in P};corners=[];supports=[]
def add_hole_world(n,world):
 p=trimesh.transform_points([world],np.linalg.inv(P[n][2]))[0];T=P[n][1]
 assert min(abs(p[2]),abs(p[2]-T))<0.01,(n,p)
 assert polys[n].covers(Point(p[:2]).buffer(4.3)),('corner lacks material',n,p)
 holes[n].append([float(p[0]),float(p[1]),bool(abs(p[2])<.01)])
def corner(a,b,o,u,w):
 o=np.array(o,float);u=np.array(u,float);w=np.array(w,float);v=np.cross(w,u)
 m=np.eye(4);m[:3,:3]=np.column_stack([u,v,w]);m[:3,3]=o
 add_hole_world(a,o+13*u);add_hole_world(b,o+13*w)
 corners.append(m.tolist())
for y in [50.5,210,300]:corner('bottom','left',[9,y,9],[1,0,0],[0,0,1])
for y in [48.5,120,310]:corner('bottom','divider',[234,y,9],[-1,0,0],[0,0,1])
for y in [100,220,285]:corner('bottom','right',[421,y,9],[-1,0,0],[0,0,1])
for y in [50.5,210]:corner('pc_top','left',[9,y,66],[1,0,0],[0,0,-1])
for y in [48.5,120]:corner('pc_top','divider',[234,y,66],[-1,0,0],[0,0,-1])
for y in [150,288]:corner('high_top','right',[421,y,169],[-1,0,0],[0,0,-1])
corner('high_top','left',[9,288.5,169],[1,0,0],[0,0,-1])
corner('high_top','divider',[243,288,169],[1,0,0],[0,0,-1])
corner('pc_front','left',[9,6,40],[1,0,0],[0,1,0])
corner('pc_front','divider',[234,6,40],[-1,0,0],[0,1,0])
corner('printer_front','divider',[243,74,95],[1,0,0],[0,1,0])
corner('printer_front','right',[421,74,95],[-1,0,0],[0,1,0])
for x,side,u in [(9,'left',[1,0,0]),(421,'right',[-1,0,0]),(234,'divider',[-1,0,0]),(243,'divider',[1,0,0])]:
 corner('rear',side,[x,324,157],u,[0,-1,0])
for x in [80,200,330]:corner('high_top','rear',[x,324,169],[0,-1,0],[0,0,-1])
# Printed support pillars: both ends have 7.3 mm blind pilots.
def support(lo,hi,x,y,z,h):
 add_hole_world(lo,[x-3 if h<=14 and hi else x,y,z]);
 if hi:add_hole_world(hi,[x+3 if h<=14 else x,y,z+h])
 supports.append({'height':h,'center':[x,y,z]})
for x in [51,182]:
 for y in [49,181.9]:support('bottom',None,x,y,9,10)
for x in [45,155]:
 for y in [260,300]:support('bottom',None,x,y,9,10)
for x in [279,388]:
 for y in [84,213]:support('bottom','printer_tray',x,y,9,8)
for x in [278,390]:
 for y in [248,306]:support('bottom','lower_tray',x,y,9,34)
for x in [256,411]:
 for y in [243,315]:support('bottom','upper_tray',x,y,9,85)
# Reserve room for other walls, structural corner braces and support pillars.
obstacles=[]
for name,m in meshes.items():
 verts=trimesh.transform_points(trimesh.bounds.corners(m.bounds),P[name][2])
 obstacles.append((name,np.array([verts.min(0),verts.max(0)])))
for a in corners:
 verts=trimesh.transform_points(trimesh.bounds.corners([[0,-9,0],[24,9,24]]),np.array(a))
 obstacles.append(('corner',np.array([verts.min(0),verts.max(0)])))
for a in supports:
 x,y,z=a['center'];h=a['height']
 obstacles.append(('pillar',np.array([[x-8,y-8,z],[x+8,y+8,z+h]])))
def bar_clear(name,cx,cy,axis,head):
 T=P[name][1]
 M=trans([cx,cy,-8 if head else T+8])@rz(90 if axis else 0)
 if not head:M=M@rx(180)
 b=trimesh.transform_points(trimesh.bounds.corners([[-28,-9,0],[28,9,8]]),P[name][2]@M)
 bounds=np.array([b.min(0),b.max(0)])
 for key,other in obstacles:
  if key==name:continue
  if np.all(np.minimum(bounds[1],other[1])-np.maximum(bounds[0],other[0])>1e-4):return False
 return True
# Select seam join positions in solid stock, away from vents/openings.
seams=[];cells=[];all_holes={n:list(v) for n,v in holes.items()}
for n,m in meshes.items():
 xmin,ymin=m.bounds[0,:2];xmax,ymax=m.bounds[1,:2];T=P[n][1]
 nx=math.ceil((xmax-xmin)/190);ny=math.ceil((ymax-ymin)/190)
 xs=np.linspace(xmin,xmax,nx+1);ys=np.linspace(ymin,ymax,ny+1)
 poly=polys[n];geoms=list(poly.geoms) if hasattr(poly,'geoms') else [poly]
 outline=unary_union([Polygon(g.exterior) for g in geoms]);head=P[n][3]
 def candidates(axis,cut):
  low,high=(ymin,ymax) if axis==0 else (xmin,xmax)
  result=[]
  for c in np.arange(low+10,high-8,1.0):
   cx,cy=(cut,c) if axis==0 else (c,cut)
   rect=box(cx-28,cy-9,cx+28,cy+9) if axis==0 else box(cx-9,cy-28,cx+9,cy+28)
   if not outline.buffer(1e-5).covers(rect):continue
   if not bar_clear(n,cx,cy,axis,head):continue
   pts=[(cx+s,cy) if axis==0 else (cx,cy+s) for s in [-16,16]]
   if not all(poly.covers(Point(p).buffer(4.3)) for p in pts):continue
   if n=='pc_top' and axis==1 and not (35<=c<=199):continue
   # Existing corner holes should not merge into these heads.
   if any(math.dist(p,q[:2])<8 for p in pts for q in all_holes[n]):continue
   result.append((cx,cy))
  if not result:raise RuntimeError(f'No seam anchors: {n} axis{axis} cut{cut}')
  chosen=[result[0]]
  if math.dist(result[-1],result[0])>30:chosen.append(result[-1])
  return chosen
 for axis,cuts in [(0,xs[1:-1]),(1,ys[1:-1])]:
  for cut in cuts:
   for cx,cy in candidates(axis,float(cut)):
    seams.append({'panel':n,'center':[float(cx),float(cy)],'axis':axis,'head_top':head})
    BM=trans([cx,cy,-8 if head else T+8])@rz(90 if axis else 0)
    if not head:BM=BM@rx(180)
    bv=trimesh.transform_points(trimesh.bounds.corners([[-28,-9,0],[28,9,8]]),P[n][2]@BM)
    obstacles.append(('previous_seam',np.array([bv.min(0),bv.max(0)])))
    for s in [-16,16]:
     all_holes[n].append([cx+s if axis==0 else cx,cy if axis==0 else cy+s,head])
 for iy in range(ny):
  for ix in range(nx):
   # 0.25 mm mating seam gap; outside edges retain their nominal position.
   x0=xs[ix]+(.125 if ix else 0);x1=xs[ix+1]-(.125 if ix<nx-1 else 0)
   y0=ys[iy]+(.125 if iy else 0);y1=ys[iy+1]-(.125 if iy<ny-1 else 0)
   if poly.intersection(box(x0,y0,x1,y1)).area<8:continue
   cells.append({'id':f'{n}_{iy+1}{ix+1}','panel':n,'box':[float(x0),float(y0),float(x1),float(y1)]})
# All case fasteners use 3 mm of panel remaining below the recessed head.
for n in P:
 T=P[n][1];mod=P[n][0];code=f'module joined_{n}() {{difference() {{{mod}();\n'
 for x,y,head in all_holes[n]:
  code+=f'translate([{x},{y},-1]) cylinder(d=4.5,h={T+2});\n'
  z=2 if head else -1;h=T if head else T-1
  code+=f'translate([{x},{y},{z}]) cylinder(d=8.6,h={h});\n'
 for seam in [v for v in seams if v['panel']==n]:
  x,y=seam['center'];z=-.1 if seam['head_top'] else T-2.8
  code+=f'translate([{x},{y},{z}]) cylinder(d=4.4,h=2.9);\n'
 code+='}}\n';wrapper(GEN/f'joined_{n}.scad',code)
# Printable accessory source, centered seam bars with captive alignment pin.
access=HERE/'joints.scad'
access.write_text('''include <vendor/BOSL2/std.scad>
include <vendor/BOSL2/threading.scad>
$fn=48; thread_slop=0.075;
module m4_hole(slop=thread_slop) {
 translate([0,0,-0.1]) threaded_rod(d=4,l=4.9,pitch=0.7,internal=true,
  bevel=false,blunt_start=false,anchor=BOTTOM,$slop=slop,$fn=48);
 cylinder(d1=4.7,d2=3.55,h=.45);
}
module seam_bar() {
 difference() {
  hull() for(x=[-26,26],y=[-7,7]) translate([x,y,0]) cylinder(r=2,h=8);
  for(x=[-16,16]) translate([x,0,8]) rotate([180,0,0]) m4_hole();
 }
 cylinder(d=4,h=10.5);
}
module corner_raw() {
 difference() {
  union() {translate([0,-9,0]) cube([24,18,8]);translate([0,-9,0]) cube([8,18,24]);}
  translate([13,0,0]) m4_hole();
  translate([0,0,13]) rotate([0,90,0]) m4_hole();
 }
}
module corner_print() {translate([0,24,9]) rotate([90,0,0]) corner_raw();}
module pillar(h) {
 difference() {
  hull() for(x=[-6,6],y=[-6,6]) translate([x,y,0]) cylinder(r=2,h=h);
  translate([h==8 ? -3 : 0,0,0]) m4_hole();
  translate([h==8 ? 3 : 0,0,h]) rotate([180,0,0]) m4_hole();
 }
}
''')
parts=[]
def piece_job(c):
 n=c['panel'];x0,y0,x1,y1=c['box'];T=P[n][1]
 path=GEN/(c['id']+'.scad')
 path.write_text(f'include <{GEN / ("joined_"+n+".scad")}>\nintersection() {{joined_{n}();translate([{x0},{y0},-1]) cube([{x1-x0},{y1-y0},{meshes[n].bounds[1,2]+2}]);}}\n')
 target=STL/(c['id']+'.stl');run(path,target)
 mesh=trimesh.load_mesh(target);pieces=mesh.split(only_watertight=False)
 # Thin vent-edge offcuts are not retained as separate, unprintable islands.
 debris=[p for p in pieces if abs(p.volume)<2]
 if debris:mesh=trimesh.util.concatenate([p for p in pieces if abs(p.volume)>=2])
 assert len(mesh.split())==1,(c['id'],[(p.volume,p.extents.tolist()) for p in pieces])
 assert mesh.is_watertight and mesh.is_winding_consistent,c['id']
 origin=mesh.bounds[0].copy();mesh.apply_translation(-origin);mesh.export(target)
 assert max(mesh.extents)<=210.001,(c['id'],mesh.extents)
 return {'file':target.name,'panel':n,'quantity':1,'size_mm':mesh.extents.round(3).tolist(),
         'assembly_matrix':(P[n][2]@trans(origin)).round(8).tolist(),'offcut_count':len(debris)}
with ThreadPoolExecutor(max_workers=3) as ex:
 for p in ex.map(piece_job,cells):parts.append(p);print('Part',p['file'],flush=True)
# Export accessories with flat, support-minimizing orientations.
access_defs=[('seam_bar',f'include <{access}>\nseam_bar();',len(seams)),
 ('corner_M4',f'include <{access}>\ncorner_print();',len(corners)),
 ('stand_stop',f'include <{SCAD}>\nstand_stop_raw();',2),
 ('stand_front_bar',f'include <{SCAD}>\nstand_front_bar();',1)]
for h in sorted(set(s['height'] for s in supports)):
 access_defs.append((f'pillar_{h}',f'include <{access}>\npillar({h});',sum(s['height']==h for s in supports)))
for name,code,qty in access_defs:
 path=GEN/(name+'.scad');path.write_text(code);target=STL/(name+'.stl');run(path,target)
 mesh=trimesh.load_mesh(target);origin=mesh.bounds[0].copy();mesh.apply_translation(-origin);mesh.export(target)
 assert mesh.is_watertight and len(mesh.split())==1 and max(mesh.extents)<=210
 parts.append({'file':target.name,'quantity':qty,'size_mm':mesh.extents.round(3).tolist(),'raw_origin':origin.tolist(),'accessory':True})
manifest={'parts':parts,'seams':seams,'corners':corners,'supports':supports,
 'panels':{n:{'module':p[0],'thickness':p[1],'matrix':p[2].tolist(),'head_top':p[3]} for n,p in P.items()},
 'screws_M3x10':6,
 'screws_M4x6':len(seams)*2+len(corners)*2+sum(2 if s['height'] in [8,34,85] else 1 for s in supports),
 'max_piece_extent_mm':max(max(p['size_mm']) for p in parts),'seam_gap_mm':0.25,
 'head_remaining_panel_mm':2,'female_thread':'M4x0.7, modeled, no nuts','head_counterbore_mm':8.6}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'Done: {len(parts)} unique files, {len(seams)} seam bars, {len(corners)} corner braces')
