"""Trace the supplied raster logo to SVG without substituting a font."""
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
here = Path(__file__).resolve().parent
rgb = np.asarray(Image.open(here/'logo_reference.png').convert('RGB'))
mask = (np.min(rgb,axis=2)<180).astype('uint8')*255
ys,xs=np.where(mask)
x0,y0,x1,y1=xs.min(),ys.min(),xs.max()+1,ys.max()+1
mask=mask[y0:y1,x0:x1]
contours,_=cv2.findContours(mask,cv2.RETR_TREE,cv2.CHAIN_APPROX_SIMPLE)
paths=[]
for c in contours:
 if abs(cv2.contourArea(c))<3:continue
 p=cv2.approxPolyDP(c,0.25,True).reshape(-1,2)
 paths.append('M '+' L '.join(f'{x},{y}' for x,y in p)+' Z')
w,h=x1-x0,y1-y0
svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}mm" height="{h}mm" viewBox="0 0 {w} {h}"><path fill="black" fill-rule="evenodd" d="'+ ' '.join(paths)+'"/></svg>\n'
(here/'logo.svg').write_text(svg)
print(f'Traced {w} x {h} px; aspect ratio {w/h:.4f}')
