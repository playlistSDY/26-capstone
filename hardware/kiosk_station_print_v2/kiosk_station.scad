// SWitch horizontal kiosk cabinet. Units mm, front = -Y.
// FDM modular version: M3x10 screws, flat stand pocket, no overhanging clips.
part="assembly"; $fn=64;
W=430; D=330; H=178; wall=9; floor_t=9; roof_t=9; face_t=6;
PC_H=78; PC_ROOF=12; rear_start=230; printer_front=68;
partition_x=234; partition_t=9;
pc_x=27; pc_y=24; pc_z=19; pc_w=179; pc_d=182.9; pc_h=34.5;
pr_x=270; pr_y=pc_y+50; pr_z=25; pr_w=127; pr_d=133; pr_h=129;
strip_x=30; strip_y=245; strip_z=19;
strip_w=140; strip_d=70; strip_h=100;
tray_z=94; tray_t=6;
front_screws=[[25,23],[215,23],[25,58],[215,58]];
rear_screws=[[25,23],[405,23],[25,155],[405,155]];
stand_w=180; stand_d=180; stand_edge_t=8; clip_gap=8.5; stand_front=26;
stand_left=(partition_x-stand_w)/2;
body_c=[0.13,0.21,0.26]; face_c=[0.91,0.93,0.92]; accent=[0.28,0.40,0.91];
module rr(w,d,r,h) {
 linear_extrude(h) hull() for(x=[r,w-r],y=[r,d-r]) translate([x,y]) circle(r=r);
}
module hole(x,y,d,h) {translate([x,y,-1]) cylinder(d=d,h=h+2);}
// Flat parts: XY dimension is the sheet profile, Z is stock thickness.
module bottom() {
 difference() {
  cube([W,D,floor_t]);
  translate([partition_x,-1,-1]) cube([W-partition_x+1,printer_front+1,floor_t+2]);
  for(x=[22,W-22],y=[86,D-22]) hole(x,y,4.5,floor_t);
  for(x=[pc_x+12,pc_x+pc_w-12],y=[pc_y+12,pc_y+pc_d-12])
   translate([x-2,y-7,-1]) cube([4,14,floor_t+2]);
  for(x=[strip_x+15,strip_x+strip_w-15],y=[strip_y-5,strip_y+strip_d+5])
   translate([x-2,y-6,-1]) cube([4,12,floor_t+2]);
 }
}
module side_panel() {
 difference() {
  union() {
   cube([D,PC_H-floor_t-PC_ROOF,wall]);
   translate([rear_start,0,0]) cube([D-rear_start,H-floor_t-roof_t,wall]);
  }
  for(x=[25:15:190],y=[17:16:40]) translate([x,y,-1]) rr(6,9,2,wall+2);
  for(x=[248:15:303],y=[30:18:138]) translate([x,y,-1]) rr(6,10,2,wall+2);
 }
}
module right_panel() {
 difference() {
  cube([D-printer_front,H-floor_t-roof_t,wall]);
  for(x=[25:16:218],y=[26:20:137]) translate([x,y,-1]) rr(6,12,2,wall+2);
 }
}
module front_panel() {
 difference() {
  cube([partition_x-wall,PC_H-floor_t-PC_ROOF,face_t]);
  for(x=[28:14:205],z=[30:14:45]) translate([x-wall,z-floor_t,-1]) rr(7,8,2,face_t+2);

 }
}
module printer_front_panel() {
 difference() {
  cube([W-wall-(partition_x+partition_t),H-floor_t-roof_t,face_t]);
  translate([264-partition_x-partition_t,18-floor_t,-1]) rr(139,147,4,face_t+2);

 }
}
module rear_panel() {
 difference() {
  cube([W-2*wall,H-floor_t-roof_t,face_t]);

  for(x=[38:15:390],z=[30:22:140]) translate([x-wall,z-floor_t,-1]) rr(6,11,2,face_t+2);
  translate([194-wall,-1,-1]) rr(52,32,5,face_t+2);
 }
}
module top_panel() {
 difference() {
  union() {
   translate([0,rear_start,0]) cube([W,D-rear_start,roof_t]);
   translate([partition_x,printer_front,0]) cube([W-partition_x,rear_start-printer_front,roof_t]);
  }


  translate([260,256,roof_t-0.6]) linear_extrude(0.8)
   resize([130,130*60/393]) import("logo.svg");
 }
}
module pc_top() {
 difference() {
  union() {
   cube([partition_x,rear_start,PC_ROOF]);
   // Upright screw bosses join directly into the platform, not floating hooks.
   for(x=[20,214]) translate([x-7,27,PC_ROOF]) cube([14,14,6.8]);
  }
  translate([102,210,-1]) rr(30,16,5,PC_ROOF+2);
  translate([26,25,PC_ROOF-1.2]) rr(182,182,1,2);
  for(x=[47,67,167,187]) translate([x,213,3]) cylinder(d=2.5,h=PC_ROOF);
  // Front clamp M3x10: 2 mm clamp floor + 8 mm receiving engagement.
  for(x=[20,214]) translate([x,34,10.3]) cylinder(d=2.5,h=10);
 }
}
module stand_front_bar() {
 difference() {
  rr(208,14,2,3);
  for(x=[7,201]) {
   translate([x,7,-1]) cylinder(d=3.3,h=5);
   translate([x,7,2]) cylinder(d=7.2,h=2);
  }
 }
}
module divider() {
 difference() {
  union() {
   cube([D-2*face_t,PC_H-floor_t-PC_ROOF,partition_t]);
   translate([printer_front-face_t,0,0])
    cube([D-printer_front-face_t,H-floor_t-roof_t,partition_t]);
  }
  translate([180,12,-1]) rr(80,28,4,partition_t+2);
  translate([240,105,-1]) rr(55,28,4,partition_t+2);
  for(x=[30:18:145],y=[17:18:35]) translate([x,y,-1]) rr(7,10,2,partition_t+2);
 }
}
module rear_left_front() {
 difference() {
  cube([partition_x-wall,H-PC_H-roof_t,face_t]);
  for(x=[18:18:200],y=[20:18:61]) translate([x,y,-1]) rr(7,10,2,face_t+2);
 }
}
module adapter_tray() {
 difference() {
  cube([171,88,tray_t]);
  for(x=[12:22:151],y=[15:22:70]) translate([x,y,-1]) rr(8,13,2,tray_t+2);
 }
}
module printer_tray() {
 difference() {
  cube([153,157,6]);
  for(x=[8,141],y=[20,120]) translate([x-2,y-7,-1]) cube([4,14,8]);
 }
}
module stand_stop_raw() {
 difference() {
  rr(40,14,2,6);
  for(x=[10,30]) {
   hole(x,7,3.3,6);
   translate([x,7,3]) cylinder(d=7.2,h=4);
  }
 }
}
module stand_stop() {stand_stop_raw();}
module stand_retention(explode=0) {
 // No C clips or elevated pad. The stand's entire underside rests on the pocket.
 for(x=[37,157]) color(accent)
  translate([x,stand_front+stand_d,PC_H+explode]) stand_stop_raw();
 color(accent) translate([13,27,PC_H+6.8+explode]) stand_front_bar();
}
module lower_adapter_tray() {
 difference() {
  cube([136,74,6]);
  translate([132.5,-1,-1]) cube([5,12.5,8]);
  translate([132.5,66.5,-1]) cube([5,9,8]);

  for(x=[18:20:111],y=[16:20:55]) translate([x,y,-1]) rr(7,10,2,8);
 }
}
module soft_foot() {difference(){cylinder(d=22,h=10);translate([0,0,-1])cylinder(d=4.5,h=12);}}
module spacer_foot() {difference(){rr(26,26,3,10);hole(13,13,4.5,10);}}
module cable_clip() {
 difference() {
  rr(30,18,3,5);
  translate([8,-1,2]) cube([14,20,2]);
  for(x=[4,26]) hole(x,9,3.5,5);
 }
}
module shell(sides=true,front=true,rear=true,top=true) {
 color(body_c) bottom();
 if(sides) {
  color(body_c) translate([0,0,floor_t]) rotate([90,0,90]) side_panel();
  color(body_c) translate([W-wall,printer_front,floor_t]) rotate([90,0,90]) right_panel();
 }
 if(front) {
  color(face_c) translate([wall,face_t,floor_t]) rotate([90,0,0]) front_panel();
  color(face_c) translate([partition_x+partition_t,printer_front+face_t,floor_t]) rotate([90,0,0]) printer_front_panel();
  color(body_c) translate([wall,rear_start+face_t,PC_H]) rotate([90,0,0]) rear_left_front();
 }
 if(rear) color(body_c) translate([wall,D,floor_t]) rotate([90,0,0]) rear_panel();
 if(top) {
  color(face_c) translate([0,0,H-roof_t]) top_panel();
  color(face_c) translate([0,0,PC_H-PC_ROOF]) pc_top();
 }
 color(body_c) translate([partition_x,face_t,floor_t]) rotate([90,0,90]) divider();
 color([0.29,0.38,0.41]) translate([248,235,tray_z]) adapter_tray();
 color([0.29,0.38,0.41]) translate([270,240,43]) lower_adapter_tray();


 color([0.29,0.38,0.41]) translate([257,printer_front+face_t,17]) printer_tray();
 // Continuous 15 mm timber ledges support the existing monitor platform.

 for(x=[22,W-22],y=[86,D-22]) color([0.11,0.12,0.13]) translate([x,y,-10]) soft_foot();
}
module pc() {
 color([0.07,0.08,0.09]) translate([pc_x,pc_y,pc_z]) rr(pc_w,pc_d,3,pc_h);
 // Front I/O is schematic. Keep real unit's vents and port locations clear.
 color([0.18,0.19,0.21]) translate([pc_x+1,pc_y-0.15,pc_z+1]) cube([pc_w-2,0.3,pc_h-2]);
 color([0.45,0.47,0.48]) translate([pc_x+12,pc_y-0.4,pc_z+9]) cube([7,0.5,6]);
 for(x=[42,56]) color([0.18,0.32,0.65]) translate([pc_x+x,pc_y-0.4,pc_z+11]) cube([10,0.5,5]);
 for(x=[85:8:168]) color([0.02,0.03,0.04]) translate([pc_x+x,pc_y-0.4,pc_z+8]) cube([3,0.5,18]);
}
module printer() {
 color([0.12,0.13,0.14]) translate([pr_x,pr_y,pr_z]) rr(pr_w,pr_d,3,pr_h);
 // Front-eject position; the real printer face remains accessible.
 color([0.025,0.03,0.035]) translate([pr_x+6,pr_y-0.6,pr_z+77]) cube([115,1,11]);
 color([0.28,0.32,0.34]) translate([pr_x+12,pr_y-1,pr_z+21]) cube([14,2,9]);
 color(accent) translate([pr_x+15,pr_y-1.1,pr_z+42]) cube([3,1.3,3]);
 // Schematic receipt, retained within the actual 80 mm paper width.
 color([0.99,0.99,0.97]) translate([pr_x+24,pr_y-46,pr_z+76]) cube([79,47,0.25]);
}
module power_strip() {
 // User supplied envelope 140 x 70 x 100, including a conservative plug zone.
 color([0.86,0.87,0.87]) translate([strip_x,strip_y,strip_z]) rr(140,70,5,35);
 for(x=[strip_x+35,strip_x+105]) {
  color([0.3,0.32,0.33]) translate([x,strip_y+35,strip_z+35]) cylinder(d=34,h=1);
  color([0.09,0.10,0.11]) translate([x-17,strip_y+19,strip_z+36]) rr(34,32,4,45);
 }
}
module adapters() {
 // Reserved envelopes, not actual manufacturer dimensions.
 color([0.13,0.14,0.15]) translate([252,239,tray_z+tray_t]) rr(166,83,4,44);
 color([0.12,0.13,0.14]) translate([278,250,49]) rr(120,55,4,35);
}
module path_tube(p,r=2) {for(i=[0:len(p)-2])hull(){translate(p[i])sphere(r=r);translate(p[i+1])sphere(r=r);}}
module cables() {
 color([0.25,0.48,0.72]) path_tube([[190,207,39],[205,222,42],[235,225,40],[310,224,35],[325,208,35]],2);
 color([0.1,0.11,0.12]) path_tube([[290,313,122],[234,316,130],[202,318,117],[135,280,102]],3);
 color([0.1,0.11,0.12]) path_tube([[330,300,67],[234,304,75],[205,303,80],[65,280,102]],3);
 color([0.1,0.11,0.12]) path_tube([[160,300,40],[216,312,26],[216,352,18]],4);
 color([0.25,0.48,0.72]) path_tube([[150,207,38],[150,220,43],[117,218,60],[117,218,100],[115,165,125]],2);
}
module monitor() {
 // Photo-confirmed portrait orientation. 235x355x10 is a clearance assumption;
 // not a verified manufacturer mechanical drawing. Existing stand reused.
 color([0.12,0.14,0.15]) translate([stand_left,stand_front,PC_H-1.2]) rr(stand_w,stand_d,12,stand_edge_t);
 color([0.13,0.15,0.16]) hull() {
  translate([105,150,PC_H+6.8]) cube([20,16,8]);
  translate([105,73,PC_H+173]) cube([20,16,8]);
 }
 translate([-12,20,PC_H+45]) rotate([78,0,0]) {
  color([0.08,0.10,0.12]) rr(235,355,5,10);
  color([0.14,0.26,0.35]) translate([7,10,10]) rr(221,335,2,0.8);
  color(accent) translate([20,27,11]) rr(70,12,3,0.5);
  for(y=[60:60:280]) color([0.83,0.87,0.89]) translate([20,y,11]) rr(195,35,3,0.5);
 }
}
module monitor_cables() {
 // Existing stand internal channel is represented by endpoints only.
 color([0.10,0.11,0.12]) path_tube([[168,97,473],[168,115,487],[140,115,420],[115,90,285],[115,95,251]],2.5);
 // Lower stand outlet to rear platform grommet, then internal PC ports.
 color([0.10,0.11,0.12]) path_tube([[115,151,111],[117,202,103],[117,218,91],[117,218,67],[150,220,45],[150,207,39]],2.5);
}
module components() {pc();printer();power_strip();adapters();}
module assembled(with_monitor=false) {shell();components();stand_retention();if(with_monitor) {monitor(); monitor_cables();}}
module cutaway() {shell(false,false,false,false);components();cables();}
module exploded() {
 color(body_c) bottom();
 color(body_c) translate([-35,0,35]) rotate([90,0,90]) side_panel();
 color(body_c) translate([W+44,printer_front,35]) rotate([90,0,90]) right_panel();
 color(face_c) translate([wall,-44,22]) rotate([90,0,0]) front_panel();
 color(face_c) translate([partition_x+partition_t,printer_front-44,22]) rotate([90,0,0]) printer_front_panel();
 color(body_c) translate([wall,D+65,22]) rotate([90,0,0]) rear_panel();
 color(face_c) translate([0,0,H+95]) top_panel();
 color(face_c) translate([0,0,PC_H+55]) pc_top();
 color(body_c) translate([partition_x+partition_t,face_t,35]) rotate([90,0,90]) divider();
 color([0.29,0.38,0.41]) translate([248,235,135]) adapter_tray();
 color([0.29,0.38,0.41]) translate([257,printer_front+face_t,17]) printer_tray();
}
if(part=="bottom") bottom();
else if(part=="side") side_panel();
else if(part=="right") right_panel();
else if(part=="pc_top") pc_top();
else if(part=="rear_left_front") rear_left_front();
else if(part=="front") front_panel();
else if(part=="printer_front") printer_front_panel();
else if(part=="rear") rear_panel();
else if(part=="top") top_panel();
else if(part=="divider") divider();
else if(part=="adapter_tray") adapter_tray();
else if(part=="printer_tray") printer_tray();
else if(part=="lower_adapter_tray") lower_adapter_tray();



else if(part=="stand_stop") stand_stop();
else if(part=="stand_front_bar") stand_front_bar();
else if(part=="retention") {color(face_c) translate([0,0,PC_H-PC_ROOF]) pc_top(); stand_retention();}
else if(part=="spacer_foot") spacer_foot();
else if(part=="cable_clip") cable_clip();
else if(part=="assembly") assembled();
else if(part=="kiosk") assembled(true);
else if(part=="cutaway") cutaway();
else if(part=="exploded") exploded();
else if(part=="components") {components();cables();}
