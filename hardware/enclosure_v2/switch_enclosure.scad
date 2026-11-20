// SWitch tabletop voice-button enclosure. Units: mm.
// Print each part separately: base, lid, mic_bracket, fit_coupon.
// Assembly includes illustrative components, not printable parts.
part = "assembly";
$fn = 64;
W=100; D=76; H=48; R=10; wall=2.4; floor_t=2.4;
lid_t=2.6; fit=0.30;
// Nominal Ø3 plastic self-tapping pan-head screws, not modelled threads.
case_pilot_d=2.5; case_clearance_d=3.3;
case_head_d=6.4; case_head_recess=0.6;
button_d=24; button_x=68; button_y=34;
button_under=35; // User-approved assumption; includes terminal envelope.
esp_w=18; esp_l=23.5; esp_t=1.6;
esp_x=25; esp_y=D-wall-esp_l/2-0.6;
esp_seat=10; usb_z=esp_seat+3.1;
usb_w=14; usb_h=10;
mic_w=16.0; mic_l=12.0; mic_t=1.52;
mic_x=25; mic_y=34; mic_clear=0.7;
mic_pocket_w=mic_w+mic_clear; mic_pocket_l=mic_l+mic_clear;
mic_post_dx=12.5; mic_clamp_z=lid_t+3.2;
logo_w=34; logo_h=34*60/393; logo_depth=0.6;
logo_x=10; logo_y=14;
mic_slot_pitch=11.2; // Photo-scaled estimate, NOT a measured hole spacing.
mic_hole_row=3.8; // Row toward +Y, opposite the six solder pads.
mic_board_z=mic_clamp_z+2+0.4; // Bracket + optional 0.4 mm gasket.
screws=[[9,9],[W-9,9],[9,D-9],[W-9,D-9]];

module rr(w,d,r,h) {
    linear_extrude(h) offset(r=r) translate([r,r]) square([w-2*r,d-2*r]);
}
module at_screws() { for(p=screws) translate([p[0],p[1],0]) children(); }
module pilot(d,h) { cylinder(d=d,h=h); }
module usb_cut() {
    // Rounded opening through rear wall. Centre height is adjustable.
    translate([esp_x-usb_w/2,D+1,usb_z-usb_h/2])
        rotate([90,0,0]) rr(usb_w,usb_h,2,wall+2);
}
module esp_saddle() {
    // Central support avoids the two GPIO rows; 4 mm clearance below PCB.
    difference() {
        translate([esp_x-5.5,esp_y-esp_l/2+2,floor_t-0.1])
            cube([11,esp_l-4,esp_seat-floor_t+0.1]);
        // Horizontal cable-tie tunnel, 3.2 mm wide, 2.2 mm tall.
        translate([esp_x-7,esp_y-1.6,esp_seat-4.1]) cube([14,3.2,2.2]);
    }
    // Fore/aft end stops touch only the centre of short PCB edges.
    for(s=[-1,1]) translate([esp_x-2,esp_y+s*(esp_l/2+1.1)-0.8,
                                           floor_t-0.1])
        cube([4,1.6,esp_seat+esp_t+0.8-floor_t+0.1]);
}
module base() {
    difference() {
        union() {
            difference() {
                rr(W,D,R,H);
                translate([wall,wall,floor_t])
                    rr(W-2*wall,D-2*wall,R-wall,H+1);
            }
            at_screws() cylinder(d=11,h=H-0.4);
            // Tie screw columns to both adjacent walls.
            for(p=screws) {
                translate([p[0]<W/2 ? wall-0.1 : p[0],p[1]-1.2,floor_t-0.1])
                    cube([9-wall+0.1,2.4,H-floor_t-0.3]);
                translate([p[0]-1.2,p[1]<D/2 ? wall-0.1 : p[1],floor_t-0.1])
                    cube([2.4,9-wall+0.1,H-floor_t-0.3]);
            }
            esp_saddle();
            // Anchors for internal signal-wire bundles (not the external USB cable).
            for(dx=[-10,10]) translate([esp_x+dx-2.5,D-18,floor_t-0.1])
                difference() {
                    cube([5,7,5.1]);
                    translate([-0.1,1.8,1.6]) cube([5.2,3.4,1.9]);
                }
        }
        usb_cut();
        at_screws() {
            translate([0,0,H-14]) pilot(case_pilot_d,16);
            // Lead-in guides the tapping screw into the boss.
            translate([0,0,H-1]) cylinder(d1=case_pilot_d,d2=3.1,h=0.7);
        }
    }
}
module mic_mount() {
    // Two outer posts hold the detachable slotted PCB bracket.
    // No plastic presses on the central microphone chip or the 6-pad edge.
    for(s=[-1,1]) translate([mic_x+s*mic_post_dx,mic_y,lid_t-0.1])
        difference() {
            cylinder(d=6,h=mic_clamp_z-lid_t+0.1);
            translate([0,0,0.7]) cylinder(d=1.7,h=5);
        }
}
module logo_cut() {
    translate([logo_x,logo_y,-0.05]) linear_extrude(logo_depth+0.05)
        resize([logo_w,logo_h]) import("logo.svg");
}
module lid_geometry() {
    // Exterior face is on build plate. All supports extend upward.
    difference() {
        union() {
            rr(W,D,R,lid_t);
            // Registration lip, relieved near the four screw columns.
            difference() {
                translate([wall+fit,wall+fit,lid_t-0.1])
                    rr(W-2*(wall+fit),D-2*(wall+fit),R-wall-fit,1.7);
                translate([wall+fit+1.4,wall+fit+1.4,lid_t-0.2])
                    rr(W-2*(wall+fit+1.4),D-2*(wall+fit+1.4),
                       R-wall-fit-1.4,2);
                at_screws() translate([0,0,lid_t-0.2]) cylinder(d=14.5,h=3);
            }
            mic_mount();
        }
        logo_cut();
        translate([button_x,button_y,-1]) cylinder(d=button_d,h=lid_t+4);
        at_screws() {
            translate([0,0,-1]) cylinder(d=case_clearance_d,h=lid_t+5);
            translate([0,0,-0.1]) cylinder(d=case_head_d,h=case_head_recess+0.1);
        }
        // 35 acoustic apertures; short shallow plenum joins them behind grille.
        for(x=[-6:2:6],y=[-4:2:4])
            translate([mic_x+x,mic_y+y,-1]) cylinder(d=1.35,h=lid_t+2);
        translate([mic_x-7,mic_y-5,1.7]) cube([14,10,lid_t]);
    }
}
// Print underside-up. Reflect the FULL geometry in X so a physical Y half-turn
// restores the intended assembled XY layout and readable exterior lettering.
module lid() {
    translate([W,0,0]) mirror([1,0,0]) lid_geometry();
}
module lid_in_place(top_z=H+lid_t) {
    translate([W,0,top_z]) rotate([0,180,0]) lid();
}
module mic_bracket() {
    // PCB sits on inside face; its Port face points through the open centre.
    // Two M2 bolts + washers + nuts use the PCB's existing mounting holes.
    difference() {
        translate([-16,-10,0]) rr(32,20,3,2);
        // Open edge for the complete 6-pad/header row.
        translate([-8.6,-11,-1]) cube([17.2,8.4,4]);
        // Central acoustic passage, including the offset Port shown in photo.
        translate([-2,-3.4,-1]) cube([4,6.2,4]);
        for(s=[-1,1]) {
            translate([s*mic_post_dx,0,-1]) cylinder(d=2.2,h=4);
            // 4.4 x 3.4 slots accommodate uncertainty in photo-scaled spacing.
            translate([s*mic_slot_pitch/2-2.2,mic_hole_row-1.7,-1])
                rr(4.4,3.4,1.1,4);
        }
    }
}
module fit_coupon() {
    difference() {
        rr(74,34,4,lid_t);
        translate([17,17,-1]) cylinder(d=button_d,h=5);
        translate([38,8,-1]) cube([mic_pocket_w,mic_pocket_l,5]);
        translate([58,8,-1]) rr(usb_w,usb_h,2,5);
    }
}
module mic_pcb() {
    // Photo-based schematic only. Real hole/port positions require measurement.
    color([0.06,0.09,0.12]) difference() {
        translate([-mic_w/2,-mic_l/2,0]) rr(mic_w,mic_l,1.6,mic_t);
        for(s=[-1,1]) translate([s*mic_slot_pitch/2,mic_hole_row,-1])
            cylinder(d=3,h=mic_t+2);
        translate([0,1.5,-1]) cylinder(d=1.2,h=mic_t+2);
        for(i=[0:5]) translate([(i-2.5)*2.54,-3.8,-1])
            cylinder(d=1.2,h=mic_t+2);
    }
    color("silver") translate([-1.6,-0.1,mic_t]) cube([3.2,3.2,1.1]);
}
module mic_detail() {
    color([0.24,0.45,0.52]) mic_bracket();
    // Exploded 5 mm above its actual mounting position for visibility.
    translate([0,0,7.4]) mic_pcb();
}
module components(explode=0) {
    color([0.08,0.5,0.3]) translate([esp_x-esp_w/2,esp_y-esp_l/2,esp_seat])
        cube([esp_w,esp_l,esp_t]);
    color("silver") translate([esp_x-4.4,D-wall-6,esp_seat+esp_t])
        cube([8.8,7,3.2]);
    translate([mic_x,mic_y,H+lid_t-mic_board_z+explode])
        rotate([0,180,0]) mic_pcb();
    color("dimgray") translate([button_x,button_y,H-button_under+explode])
        cylinder(d=20,h=button_under+lid_t);
    color([0.95,0.6,0.1]) translate([button_x,button_y,H+lid_t+explode])
        cylinder(d=25,h=4);
}
module assembly(explode=0) {
    color([0.18,0.29,0.35]) base();
    translate([0,0,explode]) {
        color([0.88,0.91,0.90]) lid_in_place();
        color([0.35,0.45,0.5]) translate([mic_x,mic_y,H+lid_t-mic_clamp_z])
            rotate([0,180,0]) mic_bracket();
    }
    components(explode);
}
if(part=="base") base();
else if(part=="lid") lid();
else if(part=="mic_bracket") mic_bracket();
else if(part=="fit_coupon") fit_coupon();
else if(part=="assembly") assembly();
else if(part=="exploded") assembly(32);
else if(part=="mic_detail") mic_detail();
else if(part=="lid_exterior") lid_in_place(lid_t);
else if(part=="layout") {
    base(); translate([W+10,0,0]) lid();
    translate([W+30,D+16,0]) mic_bracket();
}
