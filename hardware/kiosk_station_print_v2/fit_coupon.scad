include </Users/sdy/Library/Mobile Documents/com~apple~CloudDocs/대학교/2학년 2학기/창캡디/hardware/kiosk_station_print_v2/joints.scad>
$fn=48;
module test_panel() {difference() {translate([-28,-9,0]) cube([56,18,6]);
 for(x=[-22,-12,12,22]) {translate([x,0,-1]) cylinder(d=3.3,h=8);translate([x,0,3]) cylinder(d=7.6,h=4);}
 translate([0,0,-.1]) cylinder(d=4.4,h=2.9);
}}
translate([0,0,8]) test_panel();seam_bar();
