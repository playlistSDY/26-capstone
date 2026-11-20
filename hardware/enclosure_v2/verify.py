"""Optional mesh checks: pip install trimesh networkx numpy."""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import trimesh
import numpy as np

HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'output'/'enclosure_v2'
report={}
for name in ('base','lid','mic_bracket','fit_coupon'):
    mesh=trimesh.load_mesh(OUT/f'{name}.stl')
    solids=len(mesh.split())
    assert mesh.is_watertight and mesh.is_winding_consistent and solids==1 and mesh.volume>0,name
    report[name]={'watertight':True,'winding_consistent':True,'connected_solids':solids,
                  'dimensions_mm':mesh.extents.round(3).tolist(),'volume_mm3':round(float(mesh.volume),2)}
# Verify the actual exported pilot and clearance circle vertices.
for file_name,radius,zlevel in [('base',1.25,34),('lid',1.65,2.6)]:
    vertices=trimesh.load_mesh(OUT/f'{file_name}.stl').vertices
    for x,y in [(9,9),(91,9),(9,67),(91,67)]:
        radii=np.linalg.norm(vertices[:,:2]-[x,y],axis=1)
        assert np.count_nonzero((abs(radii-radius)<0.001)&(abs(vertices[:,2]-zlevel)<0.001))>=32,(file_name,x,y)
report['case_fastener']={'nominal_screw_diameter_mm':3,'pilot_diameter_mm':2.5,'clearance_diameter_mm':3.3,'head_seat_diameter_mm':6.4,'head_seat_depth_mm':0.6,'count':4}
with tempfile.TemporaryDirectory() as folder:
    root=Path(folder)
    check=root/'check.scad'
    check.write_text(f'include <{HERE / "switch_enclosure.scad"}>\n'
                     'intersection() { base(); lid_in_place(); }\n')
    result=root/'overlap.stl'
    subprocess.run([shutil.which('openscad'),'-o',str(result),'-D','part="none"',str(check)],check=True,capture_output=True)
    overlap=trimesh.load_mesh(result)
    # Expected flat contact faces only at the seam.
    assert abs(float(overlap.volume))<1e-6
    assert overlap.extents[2]<1e-6
    report['lid_base_overlap_mm3']=0.0
report['logo']={'width_mm':34,'depth_mm':0.6,'remaining_lid_thickness_mm':2.0}
(OUT/'mesh_validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('PASS: four closed single solids; no volumetric lid/base interference.')
