"""Regenerate printable parts and CAD previews with OpenSCAD CLI."""
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / 'output' / 'enclosure_v2'
SCAD = HERE / 'switch_enclosure.scad'

def main():
    cli = shutil.which('openscad')
    if not cli:
        raise SystemExit('Install OpenSCAD and put openscad on PATH.')
    OUT.mkdir(parents=True, exist_ok=True)
    for part in ('base', 'lid', 'mic_bracket', 'fit_coupon'):
        subprocess.run([cli, '-o', str(OUT / f'{part}.stl'), '-D', f'part="{part}"', str(SCAD)], check=True)
    for name, part, camera in (
        ('assembled', 'assembly', '0,0,0,55,0,25,250'),
        ('exploded', 'exploded', '0,0,0,58,0,25,300'),
        ('base_top', 'base', '0,0,0,20,0,0,250'),
        ('lid_inside', 'lid', '0,0,0,25,0,0,250'),
        ('lid_exterior', 'lid_exterior', '0,0,0,0,0,0,250'),
        ('mic_detail', 'mic_detail', '0,0,0,35,0,20,100'),
        ('mic_bracket', 'mic_bracket', '0,0,0,25,0,0,100'),
    ):
        subprocess.run([cli, '-o', str(OUT / f'{name}.png'), '--render', '--imgsize=1400,1000',
                        '--viewall', '--autocenter', f'--camera={camera}', '--colorscheme=Tomorrow',
                        '-D', f'part="{part}"', str(SCAD)], check=True)
    print(f'Exported to {OUT}')

if __name__ == '__main__':
    main()
