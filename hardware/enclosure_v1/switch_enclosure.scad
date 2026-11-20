// SWitch tabletop voice-button enclosure. Units: mm.
// Print each part separately: base, lid, mic_keeper, fit_coupon.
// Assembly includes illustrative components, not printable parts.
part = "assembly";
$fn = 64;
W=100; D=76; H=48; R=10; wall=2.4; floor_t=2.4;
lid_t=2.6; fit=0.30;
button_d=20.5; button_x=68; button_y=34;
button_under=35; // User-approved assumption; includes terminal envelope.
esp_w=18; esp_l=23.5; esp_t=1.6;
esp_x=25; esp_y=D-wall-esp_l/2-0.6;
esp_seat=10; usb_z=esp_seat+3.1;
usb_w=14; usb_h=10;
mic_w=16.0; mic_l=12.0; mic_t=1.52;
mic_x=25; mic_y=34; mic_clear=0.7;
mic_pocket_w=mic_w+mic_clear; mic_pocket_l=mic_l+mic_clear;
mic_post_dx=12.5; mic_clamp_z=lid_t+3.2;
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
        at_screws() translate([0,0,H-14]) pilot(2.7,16);
    }
}
module mic_mount() {
    // Side guides; front and rear open for soldered wires.
    for(s=[-1,1]) translate([mic_x+s*(mic_pocket_w/2+0.9)-0.9,
                                 mic_y-mic_pocket_l/2,lid_t-0.1])
        cube([1.8,mic_pocket_l,mic_clamp_z-lid_t+0.1]);
    // Corner seats keep PCB sound port off the lid, providing a short plenum.
    for(sx=[-1,1],sy=[-1,1])
        translate([mic_x+sx*(mic_w/2-1.4)-1,
                   mic_y+sy*(mic_l/2-1.2)-0.8,lid_t-0.1])
            cube([2,1.6,0.9]);
    for(s=[-1,1]) translate([mic_x+s*mic_post_dx,mic_y,lid_t-0.1])
        difference() {
            cylinder(d=6,h=mic_clamp_z-lid_t+0.1);
            translate([0,0,0.7]) cylinder(d=1.7,h=5);
        }
}
module lid() {
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
        translate([button_x,button_y,-1]) cylinder(d=button_d,h=lid_t+4);
        at_screws() {
            translate([0,0,-1]) cylinder(d=3.4,h=lid_t+5);
            translate([0,0,-0.1]) cylinder(d=6.3,h=1.4);
        }
        // 35 acoustic apertures; short shallow plenum joins them behind grille.
        for(x=[-6:2:6],y=[-4:2:4])
            translate([mic_x+x,mic_y+y,-1]) cylinder(d=1.35,h=lid_t+2);
        translate([mic_x-7,mic_y-5,1.7]) cube([14,10,lid_t]);
    }
}
module mic_keeper() {
    // Use thin foam only on clear PCB edges to compensate for component height.
    difference() {
        translate([-16,-9,0]) rr(32,18,3,2);
        // U-shaped keeper: open at 6-pad edge; crossbar grips bare hole-side edge.
        // Orient long PCB axis along X, six pads toward -Y, holes toward +Y.
        translate([-9,-10,-1]) cube([18,14,4]);
        for(s=[-1,1]) translate([s*mic_post_dx,0,-1]) cylinder(d=2.2,h=4);

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
module components(explode=0) {
    color([0.08,0.5,0.3]) translate([esp_x-esp_w/2,esp_y-esp_l/2,esp_seat])
        cube([esp_w,esp_l,esp_t]);
    color("silver") translate([esp_x-4.4,D-wall-6,esp_seat+esp_t])
        cube([8.8,7,3.2]);
    color([0.08,0.35,0.65]) translate([mic_x-mic_w/2,mic_y-mic_l/2,
                                         H+lid_t-(lid_t+0.8+mic_t)+explode])
        cube([mic_w,mic_l,mic_t]);
    color("dimgray") translate([button_x,button_y,H-button_under+explode])
        cylinder(d=20,h=button_under+lid_t);
    color([0.95,0.6,0.1]) translate([button_x,button_y,H+lid_t+explode])
        cylinder(d=25,h=4);
}
module assembly(explode=0) {
    color([0.18,0.29,0.35]) base();
    translate([0,0,explode]) {
        color([0.88,0.91,0.90]) translate([0,0,H+lid_t]) mirror([0,0,1]) lid();
        color([0.35,0.45,0.5]) translate([mic_x,mic_y,H+lid_t-mic_clamp_z])
            mirror([0,0,1]) mic_keeper();
    }
    components(explode);
}
if(part=="base") base();
else if(part=="lid") lid();
else if(part=="mic_keeper") mic_keeper();
else if(part=="fit_coupon") fit_coupon();
else if(part=="assembly") assembly();
else if(part=="exploded") assembly(32);
else if(part=="layout") {
    base(); translate([W+10,0,0]) lid();
    translate([W+30,D+16,0]) mic_keeper();
}
