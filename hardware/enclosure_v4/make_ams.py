"""Create a native Bambu Studio X1C project; never submit a print job."""
from pathlib import Path
import json,subprocess,os
HERE=Path(__file__).resolve().parent;OUT=HERE.parents[1]/'output'/'enclosure_v4'
CLI=Path('/Applications/BambuStudio.app/Contents/MacOS/BambuStudio')
PROFILES=CLI.parents[1]/'Resources'/'profiles'/'BBL'
TMP=OUT/'bambu_build';TMP.mkdir(exist_ok=True)
by_name={}
for path in PROFILES.rglob('*.json'):
 try:
  obj=json.loads(path.read_text())
  if 'name' in obj:by_name[obj['name']]=obj
 except (ValueError,UnicodeError):pass
def full(name):
 obj=by_name[name];out=full(obj['inherits']) if obj.get('inherits') else {}
 out.update(obj);out.pop('inherits',None);return out
machine=full('Bambu Lab X1 Carbon 0.4 nozzle')
process=full('0.20mm Standard @BBL X1C')
process.update({'wall_loops':'4','sparse_infill_density':'25%','layer_height':'0.2',
 'initial_layer_print_height':'0.2','enable_prime_tower':'1','curr_bed_type':'Textured PEI Plate'})
for name,obj in [('machine',machine),('process',process)]:
 (TMP/(name+'.json')).write_text(json.dumps(obj,indent=2))
for name,color in [('white','#FFFFFF'),('black','#000000')]:
 obj=full('Generic PLA');obj['filament_colour']=[color]
 (TMP/(name+'.json')).write_text(json.dumps(obj,indent=2))
assembly={'plates':[{'plate_index':1,'plate_name':'Lid / white + black logo','need_arrange':True,
 'objects':[{'path':str(OUT/'lid_white.stl'),'count':1,'filaments':[1],'assemble_index':[1]},
            {'path':str(OUT/'logo_black.stl'),'count':1,'filaments':[2],'assemble_index':[1]}],
 'plate_params':{'print_sequence':'by layer','curr_bed_type':'Textured PEI Plate'}}]}
def item(name,filament=1,group=0):
 result={'path':str(OUT/(name+'.stl')),'count':1,'filaments':[filament]}
 if group:result['assemble_index']=[group]
 return result
full_assembly={'plates':[
 {'plate_index':1,'plate_name':'01 Fit coupons first','need_arrange':True,
  'objects':[item('button_fit_coupon'),item('esp_fit_coupon')]},
 {'plate_index':2,'plate_name':'02 Base and keepers','need_arrange':True,
  'objects':[item('base'),item('esp_keeper'),item('mic_bracket')]},
 dict(assembly['plates'][0],plate_index=3,plate_name='03 Lid + black AMS logo')
]}
(TMP/'full_assemble.json').write_text(json.dumps(full_assembly,indent=2))
(TMP/'assemble.json').write_text(json.dumps(assembly,indent=2))
cmd=[str(CLI),'--debug','2','--load-settings',str(TMP/'machine.json')+';'+str(TMP/'process.json'),
 '--load-filaments',str(TMP/'white.json')+';'+str(TMP/'black.json'),
 '--load-assemble-list',str(TMP/'assemble.json'),'--orient','0','--arrange','1',
 '--allow-multicolor-oneplate','--export-3mf',str(OUT/'lid_X1C_AMS_white_black.3mf')]
full_cmd=list(cmd)
full_cmd[full_cmd.index('--load-assemble-list')+1]=str(TMP/'full_assemble.json')
full_cmd[full_cmd.index('--export-3mf')+1]=str(OUT/'SWitch_v4_X1C_AMS.3mf')
full_result=subprocess.run(full_cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,cwd=TMP)
(TMP/'full_export.log').write_text(full_result.stdout)
if full_result.returncode:print(full_result.stdout);raise SystemExit(full_result.returncode)
result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,cwd=TMP)
(TMP/'export.log').write_text(result.stdout)
print(result.stdout[-6000:]);raise SystemExit(result.returncode)
