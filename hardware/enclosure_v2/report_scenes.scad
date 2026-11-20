// Presentation scenes only; printable geometry stays in switch_enclosure.scad.
include <switch_enclosure.scad>
shot="complete";
body_c=[0.18,0.29,0.35]; lid_c=[0.88,0.91,0.90]; bracket_c=[0.24,0.45,0.52];
module screw(d=3,l=12,hd=6,hh=2.3) {
    color([0.58,0.62,0.65]) {
        translate([0,0,-l]) cylinder(d=d,h=l);
        difference() {
            cylinder(d=hd,h=hh);
            translate([-hd*0.34,-0.35,hh-0.6]) cube([hd*0.68,0.7,0.7]);
            translate([-0.35,-hd*0.34,hh-0.6]) cube([0.7,hd*0.68,0.7]);
        }
    }
}
module esp_board(z=esp_seat) {
    translate([esp_x,esp_y,z]) {
        color([0.04,0.35,0.25]) translate([-esp_w/2,-esp_l/2,0]) cube([esp_w,esp_l,esp_t]);
        for(s=[-1,1],i=[0:8])
            color([0.7,0.66,0.40]) translate([s*7.6-0.7,(i-4)*2.54-0.85,esp_t])
                cube([1.4,1.7,0.15]);
        color([0.10,0.12,0.13]) translate([-4,-6.5,esp_t]) cube([8,8,1.4]);
        color([0.7,0.72,0.73]) translate([-4.4,esp_l/2-5.4,esp_t]) difference() {
            cube([8.8,6,3.2]);
            translate([0.6,4.8,0.5]) cube([7.6,1.4,2.2]);
        }
    }
}
module button_unit(top_z) {
    color([0.22,0.24,0.25]) translate([button_x,button_y,top_z-button_under])
        cylinder(d=20,h=button_under);
    color([0.58,0.61,0.63]) translate([button_x,button_y,top_z]) cylinder(d=25,h=0.6);
    color([0.95,0.6,0.1]) translate([button_x,button_y,top_z+0.6]) cylinder(d=24,h=3.4);
}
module complete() {
    color(body_c) base();
    color(lid_c) lid_in_place();
    esp_board();
    button_unit(H+lid_t);
    at_screws() translate([0,0,H+lid_t-case_head_recess]) screw();
}
module mic_exploded() {
    color(bracket_c) mic_bracket();
    translate([0,0,11]) mic_pcb();
    // Existing mounting holes align with the two inner slots.
    for(s=[-1,1]) {
        translate([s*mic_slot_pitch/2,mic_hole_row,-7]) rotate([180,0,0]) screw(2,6,3.6,1.4);
        color([0.64,0.66,0.68]) translate([s*mic_slot_pitch/2,mic_hole_row,18]) difference() {
            cylinder(d=4.4,h=1.6,$fn=6);
            translate([0,0,-0.1]) cylinder(d=2,h=1.8);
        }
    }
}
module system_exploded() {
    color(body_c) base();
    // Components remain aligned on their original assembly axes.
    esp_board(66);
    color(bracket_c) translate([mic_x,mic_y,95]) rotate([0,180,0]) mic_bracket();
    translate([mic_x,mic_y,83]) rotate([0,180,0]) mic_pcb();
    color(lid_c) lid_in_place(126);
    button_unit(170);
    at_screws() translate([0,0,149]) screw();
}
if(shot=="complete" || shot=="rear") complete();
else if(shot=="base") color(body_c) base();
else if(shot=="esp_mount") { color(body_c) base(); esp_board(); }
else if(shot=="lid") color(lid_c) lid();
else if(shot=="bracket") color(bracket_c) mic_bracket();
else if(shot=="mic_exploded") mic_exploded();
else if(shot=="system_exploded") system_exploded();
