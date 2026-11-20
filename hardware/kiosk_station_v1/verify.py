"""Validate solids and explicit equipment/stand envelopes (not a load test)."""
from pathlib import Path
import subprocess,tempfile,shutil,json,importlib.util
import trimesh
HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'output'/'kiosk_station_v1'
SCAD=HERE/'kiosk_station.scad'
report={'parts':{}}
for p in sorted(OUT.glob('*.stl')):
 m=trimesh.load_mesh(p)
 assert m.is_watertight and m.is_winding_consistent and m.volume>0,p.name
 assert len(m.split())==1,p.name
 report['parts'][p.name]={'watertight':True,'single_solid':True,'dimensions_mm':m.extents.round(3).tolist()}
def no_overlap(name,code):
 with tempfile.TemporaryDirectory() as folder:
  p=Path(folder)/'check.scad';mesh_path=p.with_suffix('.stl')
  p.write_text(f'include <{SCAD}>\n'+code)
  result=subprocess.run([shutil.which('openscad'),'-q','-o',str(mesh_path),'-D','part="none"',str(p)],capture_output=True,text=True)
  if mesh_path.exists():
   mesh=trimesh.load_mesh(mesh_path)
   assert abs(mesh.volume)<1e-5,(name,mesh.volume)
  else:
   # Quiet OpenSCAD reports an empty intersection with returncode 1, no output.
   assert result.returncode in (0,1) and not result.stderr,(name,result.stderr)
  report[name]={'overlap_mm3':0}
no_overlap('equipment_to_cabinet', '''
intersection() {
 shell();
 union() {
  translate([pc_x,pc_y,pc_z]) cube([pc_w,pc_d,pc_h]);
  translate([pr_x,pr_y,pr_z]) cube([pr_w,pr_d,pr_h]);
  translate([strip_x,strip_y,strip_z]) cube([140,70,100]);
  translate([252,239,100]) cube([166,83,44]);
  translate([278,250,49]) cube([120,55,35]);
 }
}
''')
for offset in [0,5,10,15,20]:
 no_overlap(f'stand_insert_offset_{offset}_mm',f'''
 intersection() {{
  translate([stand_left,stand_front+{offset},PC_H+4]) cube([180,180,8]);
  union() {{
   shell();
   for(x=[stand_left,stand_left+stand_w-30])
    translate([x,stand_front-12,PC_H]) stand_clip_raw();
  }}
 }}
 ''')
# Receipt/cover swing zone: same full front width, 110 mm unobstructed in front.
no_overlap('printer_cover_front_service_zone', '''
intersection() {
 shell();
 translate([pr_x+1,pr_y-110,pr_z+1]) cube([125,110,127]);
}
''')
report['layout']={'cabinet_mm':[430,330,178],'optional_feet_mm':10,'pc_platform_height_mm':78,
 'printer_setback_from_pc_face_mm':50,'stand_base_mm':[180,180],
 'stand_edge_thickness_assumed_mm':8,'clip_gap_mm':8.5,'stand_insert_travel_mm':20,
 'monitor_body_assumed_mm':[235,355,10],'monitor_body_verified':False,
 'physical_load_and_thermal_tests_done':False}
(OUT/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('PASS: closed single solids; equipment envelopes; 20 mm stand insertion; front cover service zone.')
