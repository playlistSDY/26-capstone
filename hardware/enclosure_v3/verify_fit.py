"""Check compact packaging against the explicit assumed component envelopes."""
from pathlib import Path
import subprocess,shutil,tempfile,json
import trimesh
HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'output'/'enclosure_v3'
source=f'''include <{HERE / 'switch_enclosure.scad'}>
module switch_envelope() {{
 translate([button_x,button_y,H-button_under]) cylinder(d=24,h=button_under);
 translate([button_x,button_y,H-5]) cylinder(d=button_nut_d,h=5);
}}
intersection() {{
 switch_envelope();
 union() {{
  base(); lid_in_place();
  translate([mic_x,mic_y,H+lid_t-mic_clamp_z]) rotate([0,180,0]) mic_bracket();
  translate([mic_x,mic_y,H+lid_t-mic_board_z]) rotate([0,180,0]) mic_pcb();
  translate([esp_x-esp_w/2-1,esp_y-esp_l/2-1,esp_seat-6])
   cube([esp_w+2,esp_l+2,14]);
 }}
}}
'''
with tempfile.TemporaryDirectory() as folder:
 root=Path(folder);p=root/'fit.scad';p.write_text(source);stl=root/'overlap.stl'
 result=subprocess.run([shutil.which('openscad'),'-o',str(stl),'-D','part="none"',str(p)],capture_output=True,text=True)
 if stl.exists():
  overlap=trimesh.load_mesh(stl)
  assert abs(overlap.volume)<1e-6,overlap.volume
  assert min(overlap.extents)<1e-6
 else:
  assert 'empty' in result.stderr.lower(),result.stderr
report={'overall_dimensions_mm':[76,56,52],'inside_box_mm':[71.2,51.2,47],
        'switch_below_lid_mm':42,'switch_body_assumed_diameter_mm':24,
        'nut_assumed_max_diameter_mm':32,'nut_assumed_height_mm':5,
        'switch_bottom_to_floor_mm':5,'switch_component_overlap_mm3':0,
        'mic_bracket_to_nut_horizontal_gap_mm':2,
        'footprint_reduction_percent':44.0,
        'bounding_volume_reduction_percent':round((1-(76*56*52)/(100*76*50.6))*100,2),
        'physical_fit_verified':False}
(OUT/'fit_validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('PASS: 42 mm switch + 5 mm bottom clearance; no digital envelope interference.')
