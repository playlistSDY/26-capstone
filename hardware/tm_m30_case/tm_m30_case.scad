// Epson TM-m30 (original), in the factory front-eject configuration.
// X is left to right, Y is front to back, Z is up in assembly coordinates.
part = "assembly"; // [assembly,base,hood,empty,service]
printer_w = 127;
printer_d = 133;
printer_h = 129;
side_clearance = 1.5; // Per side, including at the base guides.
top_clearance = 3;

width = printer_w + 2 * side_clearance + 12;
depth = printer_d + 18; // Extra space behind the nominal printer back.
base_front = 12; // Measured from the foremost point of the closed cover.
hood_front = 18;
floor_t = 4;
roof_t = 3.6;
wall = 3.2;
guide_outer = wall + 0.4;
guide_inner = 6;
guide_h = 7;
rear_stop = printer_d + 1.5;
key_y = depth - 12;
key_d = 6;
key_clearance = 0.45;
roof_z = floor_t + printer_h + top_clearance;
height = roof_z + roof_t;
eps = 0.02;
$fn = 32;

module rounded_plan(w, d, r) {
    translate([r, r]) offset(r = r) square([w - 2*r, d - 2*r]);
}

module base_guide() {
    // The gap captures the key when the hood is lowered vertically.
    difference() {
        translate([guide_outer, hood_front + 2, floor_t - eps])
            cube([guide_inner - guide_outer, depth - hood_front - 5, guide_h + eps]);
        translate([guide_outer - eps, key_y - key_clearance, floor_t - 2*eps])
            cube([guide_inner - guide_outer + 2*eps,
                  key_d + 2*key_clearance, guide_h + 3*eps]);
    }
    // Small stops at the rear corners leave the center clear for wiring.
    translate([guide_outer, rear_stop, floor_t - eps])
        cube([12 - guide_outer, 4, guide_h + eps]);
}

module base() {
    translate([0, base_front, 0])
        linear_extrude(floor_t)
            rounded_plan(width, depth - base_front, 2.5);
    base_guide();
    translate([width, 0, 0]) mirror([1,0,0]) base_guide();
}

module side_vent(y, z) {
    // Both ends are pointed so the openings close at 45 degrees in print.
    translate([-eps, y, z]) rotate([90,0,90])
        linear_extrude(wall + 2*eps)
            polygon([[0,0], [2.5,2.5], [2.5,33.5],
                     [0,36], [-2.5,33.5], [-2.5,2.5]]);
}

module hood_wall() {
    difference() {
        translate([0, hood_front, floor_t])
            cube([wall, depth - hood_front, roof_z - floor_t + eps]);
        for (y = [depth - 78 : 10 : depth - 28]) side_vent(y, 79);
    }
    // A ramp grows inwards from the wall in the upside-down print orientation.
    translate([0, key_y + key_d, floor_t]) rotate([90,0,0])
        linear_extrude(key_d)
            polygon([[wall - eps,0], [guide_inner - key_clearance,0],
                     [guide_inner - key_clearance,guide_h],
                     [wall - eps,guide_h + guide_inner - key_clearance - wall]]);
}

module hood() {
    translate([0, hood_front, roof_z])
        cube([width, depth - hood_front, roof_t]);
    hood_wall();
    translate([width,0,0]) mirror([1,0,0]) hood_wall();
}

// Illustration of the printer front and paper path. Export only base and hood.
module printer_mock(open = false) {
    x = (width - printer_w) / 2;
    color("#292c30")
        translate([x,6,floor_t + 2])
            linear_extrude(printer_h - 2)
                rounded_plan(printer_w, printer_d - 6, 4);
    for (side = [x + 8, x + printer_w - 20], y = [20,110])
        color("#25272a") translate([side,y,floor_t]) cube([12,12,2]);
    color("#3c4148")
        translate([x,0,floor_t + printer_h - 18])
            linear_extrude(18)
                rounded_plan(printer_w, 12, 3);
    if (open) {
        color("#454a51") translate([x,-97,floor_t + 2])
            linear_extrude(7) rounded_plan(printer_w,105,4);
        color("#f0e8d5") translate([x+23,-52,floor_t + 27]) rotate([0,90,0])
            cylinder(r = 22, h = 80);
    } else {
        color("#454a51") translate([x+0.4,2,floor_t+3])
            linear_extrude(printer_h-20) rounded_plan(printer_w-0.8,10,3);
        color("#15191c") translate([x+24,-0.1,floor_t+printer_h-10])
            cube([97,0.6,5]);
        color("#f5edda") translate([x+31,-29,floor_t+printer_h-36])
            rotate([42,0,0]) cube([80,39,0.6]);
        for (z = [16,26])
            color("#767e87") translate([x+8,1.4,floor_t+z]) cube([9,1,6]);
    }
    color("#717a84") translate([x+3,-0.5,floor_t+printer_h-12])
        cube([15,1,10]);
}

if (part == "base") translate([0,-base_front,0]) base();
else if (part == "hood") translate([0,depth,height]) rotate([180,0,0]) hood();
else {
    color("#637783") base();
    color("#8497a3") hood();
    if (part != "empty") printer_mock(part == "service");
}
