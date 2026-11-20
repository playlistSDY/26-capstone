include <vendor/BOSL2/std.scad>
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
