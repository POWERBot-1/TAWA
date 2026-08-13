/** Realistic Kenya hardware catalogue seed data. */

export const UNITS = [
  ['piece', 'Piece', 'COUNT'], ['box', 'Box', 'COUNT'], ['packet', 'Packet', 'COUNT'], ['bag', 'Bag', 'COUNT'],
  ['roll', 'Roll', 'COUNT'], ['meter', 'Meter', 'LENGTH'], ['kg', 'Kilogram', 'MASS'], ['litre', 'Litre', 'VOLUME'],
  ['set', 'Set', 'COUNT'], ['carton', 'Carton', 'COUNT'], ['bundle', 'Bundle', 'COUNT'], ['pallet', 'Pallet', 'COUNT'],
  ['length', 'Length', 'LENGTH'], ['sheet', 'Sheet', 'COUNT'], ['drum', 'Drum', 'VOLUME'],
];

// Prices in KES minor units implied via KES major amounts — converted by seeder.
export function catalogFor(code) {
  if (code === 'buildpro') return BUILDPRO;
  return ALPHA;
}

const ALPHA = {
  categories: ['Cement & Concrete', 'Steel & Rebar', 'Roofing', 'Plumbing & PVC', 'Electrical', 'Paint & Finishing', 'Tools', 'Timber & Boards', 'Fasteners', 'Safety'],
  suppliers: [
    { name: 'Blue Nile Cement Distributors', lead: 2, terms: 'NET14', reliability: 0.94, quality: 0.93, fulfilment: 0.96, onTime: 0.92 },
    { name: 'Apex Steel Works EA', lead: 4, terms: 'NET30', reliability: 0.88, quality: 0.9, fulfilment: 0.9, onTime: 0.86 },
    { name: 'Rift Valley Roofing Ltd', lead: 3, terms: 'NET30', reliability: 0.91, quality: 0.89, fulfilment: 0.93, onTime: 0.9 },
    { name: 'Pipe Masters Kenya', lead: 2, terms: 'COD', reliability: 0.92, quality: 0.95, fulfilment: 0.97, onTime: 0.94 },
    { name: 'Coast Paint Industries', lead: 5, terms: 'NET30', reliability: 0.87, quality: 0.91, fulfilment: 0.88, onTime: 0.85 },
  ],
  products: [
    // sku, name, brand, category, unit, cost, retail, wholesale, contractor, min, tax, reorder, max, supplier_idx
    ['CEM-SIM-50', 'Simba Cement 50kg', 'Simba', 'Cement & Concrete', 'bag', 680, 750, 720, 730, 700, 'VAT16', 30, 400, 0],
    ['CEM-RHI-50', 'Rhino Cement 50kg', 'Rhino', 'Cement & Concrete', 'bag', 665, 735, 705, 715, 685, 'VAT16', 30, 400, 0],
    ['STL-Y8', 'Y8 Steel Rebar 12m', 'Apex', 'Steel & Rebar', 'length', 480, 560, 540, 545, 520, 'VAT16', 60, 600, 1],
    ['STL-Y10', 'Y10 Steel Rebar 12m', 'Apex', 'Steel & Rebar', 'length', 720, 830, 800, 810, 770, 'VAT16', 50, 500, 1],
    ['STL-Y12', 'Y12 Steel Rebar 12m', 'Apex', 'Steel & Rebar', 'length', 980, 1120, 1080, 1090, 1030, 'VAT16', 40, 400, 1],
    ['STL-BRC-142', 'BRC Mesh A142 6x2.4m', 'Apex', 'Steel & Rebar', 'sheet', 6200, 7100, 6900, 6950, 6600, 'VAT16', 8, 60, 1],
    ['NAIL-ROOF-25', 'Roofing Nails 2.5" (1kg)', 'Generic', 'Roofing', 'kg', 240, 320, 295, 300, 270, 'VAT16', 40, 300, 2],
    ['ROOF-GC-30', 'Galvanized Corrugated Sheet 2m (30G)', 'RVR', 'Roofing', 'sheet', 780, 950, 910, 920, 850, 'VAT16', 60, 700, 2],
    ['ROOF-IT5-32', 'Box Profile IT5 Sheet 3m (32G)', 'RVR', 'Roofing', 'sheet', 2150, 2450, 2360, 2380, 2250, 'VAT16', 25, 300, 2],
    ['ROOF-RIDGE', 'Ridge Cap 2.4m Galvanized', 'RVR', 'Roofing', 'piece', 620, 780, 745, 750, 690, 'VAT16', 20, 160, 2],
    ['ROOF-GUTTER', 'Gutter 4m PVC', 'RVR', 'Roofing', 'piece', 950, 1180, 1120, 1130, 1050, 'VAT16', 12, 100, 2],
    ['ROOF-FLASH', 'Flashing 2m Galvanized', 'RVR', 'Roofing', 'piece', 540, 690, 655, 660, 600, 'VAT16', 12, 120, 2],
    ['PVC-PIPE-12', 'PVC Pipe 1/2" Class B (6m)', 'PipeMasters', 'Plumbing & PVC', 'length', 320, 420, 395, 400, 360, 'VAT16', 40, 400, 3],
    ['PVC-PIPE-34', 'PVC Pipe 3/4" Class B (6m)', 'PipeMasters', 'Plumbing & PVC', 'length', 430, 560, 530, 535, 480, 'VAT16', 35, 350, 3],
    ['PVC-ELB-12', 'PVC Elbow 1/2"', 'PipeMasters', 'Plumbing & PVC', 'piece', 35, 60, 50, 52, 40, 'VAT16', 120, 1200, 3],
    ['PVC-ELB-34', 'PVC Elbow 3/4"', 'PipeMasters', 'Plumbing & PVC', 'piece', 45, 75, 62, 65, 50, 'VAT16', 120, 1200, 3],
    ['PVC-TEE-12', 'PVC Tee 1/2"', 'PipeMasters', 'Plumbing & PVC', 'piece', 45, 78, 65, 68, 52, 'VAT16', 100, 1000, 3],
    ['PVC-TEE-34', 'PVC Tee 3/4"', 'PipeMasters', 'Plumbing & PVC', 'piece', 55, 92, 78, 80, 62, 'VAT16', 100, 1000, 3],
    ['PVC-SOC-12', 'PVC Socket 1/2"', 'PipeMasters', 'Plumbing & PVC', 'piece', 30, 52, 44, 46, 36, 'VAT16', 120, 1000, 3],
    ['PVC-VALVE-12', 'PVC Ball Valve 1/2"', 'PipeMasters', 'Plumbing & PVC', 'piece', 220, 320, 290, 295, 260, 'VAT16', 25, 200, 3],
    ['PVC-GLUE-250', 'Solvent Cement 250ml', 'PipeMasters', 'Plumbing & PVC', 'piece', 180, 260, 240, 245, 210, 'VAT16', 30, 250, 3],
    ['PVC-GLUE-500', 'Solvent Cement 500ml', 'PipeMasters', 'Plumbing & PVC', 'piece', 290, 400, 370, 375, 330, 'VAT16', 20, 180, 3],
    ['ELE-CBL-25', '2.5mm Twin+Earth Cable 100m', 'East African Cables', 'Electrical', 'roll', 8450, 9800, 9450, 9500, 8900, 'VAT16', 6, 60, null],
    ['ELE-CBL-15', '1.5mm Twin+Earth Cable 100m', 'East African Cables', 'Electrical', 'roll', 5950, 6900, 6650, 6700, 6200, 'VAT16', 6, 60, null],
    ['ELE-BULB-LED', 'LED Bulb 12W B22', 'Philips', 'Electrical', 'piece', 180, 280, 250, 255, 210, 'VAT16', 60, 500, null],
    ['ELE-SKT-DBL', 'Double Socket Outlet 13A', 'Crabtree', 'Electrical', 'piece', 850, 1150, 1080, 1090, 980, 'VAT16', 15, 120, null],
    ['ELE-MCB-32', 'MCB 32A Single Pole', 'ABB', 'Electrical', 'piece', 680, 950, 890, 900, 820, 'VAT16', 15, 120, null],
    ['PNT-SILK-20', 'Silk Vinyl Emulsion 20L', 'Coast', 'Paint & Finishing', 'drum', 5800, 6900, 6650, 6700, 6300, 'VAT16', 10, 80, 4],
    ['PNT-UND-20', 'Wall Undercoat 20L', 'Coast', 'Paint & Finishing', 'drum', 4400, 5400, 5200, 5250, 4900, 'VAT16', 10, 80, 4],
    ['PNT-BRUSH-SET', 'Paint Brush Set (4pc)', 'Generic', 'Paint & Finishing', 'set', 320, 480, 440, 450, 380, 'VAT16', 25, 200, 4],
    ['PNT-ROLLER', 'Paint Roller + Tray', 'Generic', 'Paint & Finishing', 'set', 520, 760, 700, 710, 620, 'VAT16', 25, 200, 4],
    ['PNT-THINNER', 'Paint Thinner 1L', 'Coast', 'Paint & Finishing', 'litre', 340, 480, 450, 455, 400, 'VAT16', 30, 250, 4],
    ['PNT-MASK', 'Masking Tape 2"', 'Generic', 'Paint & Finishing', 'roll', 85, 140, 125, 130, 100, 'VAT16', 60, 400, 4],
    ['TLS-HAMMER', 'Claw Hammer 16oz', 'Stanley', 'Tools', 'piece', 950, 1350, 1280, 1290, 1150, 'VAT16', 10, 80, null],
    ['TLS-WHEEL', 'Heavy-Duty Wheelbarrow', 'Truper', 'Tools', 'piece', 5800, 7200, 6900, 6950, 6500, 'VAT16', 6, 40, null],
    ['TLS-SHOVEL', 'Digging Shovel Round', 'Truper', 'Tools', 'piece', 680, 950, 900, 910, 820, 'VAT16', 12, 100, null],
    ['TLS-TROWEL', 'Brick Trowel 10"', 'Generic', 'Tools', 'piece', 420, 620, 580, 590, 520, 'VAT16', 15, 120, null],
    ['TIM-2X2', 'Cypress Timber 2"x2"x8ft', 'Local Sawmill', 'Timber & Boards', 'length', 95, 140, 130, 132, 115, 'VAT16', 200, 2000, null],
    ['TIM-PLY18', 'Marine Plywood 18mm 8x4ft', 'Comply', 'Timber & Boards', 'sheet', 4200, 4950, 4750, 4780, 4500, 'VAT16', 15, 120, null],
    ['TIM-MDF18', 'MDF Board 18mm 8x4ft', 'PG Bison', 'Timber & Boards', 'sheet', 3800, 4550, 4350, 4380, 4100, 'VAT16', 12, 100, null],
    ['FSN-SCW-450', 'Wood Screws 4x50mm (Box 200)', 'Generic', 'Fasteners', 'box', 380, 550, 520, 525, 460, 'VAT16', 25, 200, null],
    ['FSN-TEK-12', 'Tek Screws #12 (Packet 100)', 'Generic', 'Fasteners', 'packet', 260, 390, 360, 365, 320, 'VAT16', 30, 250, null],
    ['SFY-GLOVES', 'Heavy Duty Gloves', 'Vaultex', 'Safety', 'piece', 180, 280, 260, 265, 230, 'VAT16', 40, 300, null],
    ['SFY-HELMET', 'Safety Helmet', 'Vaultex', 'Safety', 'piece', 450, 680, 640, 645, 580, 'VAT16', 15, 100, null],
    ['SFY-MASK', 'Dust Masks FFP2 (Box 20)', '3M', 'Safety', 'box', 620, 880, 830, 840, 760, 'VAT16', 15, 120, null],
  ],
  relations: [
    // pipe system
    ['PVC-PIPE-12', 'PVC-ELB-12', 'ACCESSORY', 1], ['PVC-PIPE-12', 'PVC-TEE-12', 'ACCESSORY', 1],
    ['PVC-PIPE-12', 'PVC-SOC-12', 'ACCESSORY', 0.9], ['PVC-PIPE-12', 'PVC-VALVE-12', 'ACCESSORY', 0.8],
    ['PVC-PIPE-12', 'PVC-GLUE-250', 'REQUIRED', 1],
    ['PVC-PIPE-34', 'PVC-ELB-34', 'ACCESSORY', 1], ['PVC-PIPE-34', 'PVC-TEE-34', 'ACCESSORY', 1],
    ['PVC-PIPE-34', 'PVC-GLUE-500', 'REQUIRED', 1],
    // roofing system
    ['ROOF-GC-30', 'NAIL-ROOF-25', 'REQUIRED', 1], ['ROOF-GC-30', 'ROOF-RIDGE', 'ACCESSORY', 0.9],
    ['ROOF-GC-30', 'ROOF-GUTTER', 'ACCESSORY', 0.8], ['ROOF-GC-30', 'ROOF-FLASH', 'ACCESSORY', 0.7],
    ['ROOF-IT5-32', 'NAIL-ROOF-25', 'REQUIRED', 1], ['ROOF-IT5-32', 'ROOF-RIDGE', 'ACCESSORY', 0.9],
    ['ROOF-IT5-32', 'FSN-TEK-12', 'BUNDLE', 0.8],
    // paint system
    ['PNT-SILK-20', 'PNT-UND-20', 'REQUIRED', 1], ['PNT-SILK-20', 'PNT-BRUSH-SET', 'FBO', 0.9],
    ['PNT-SILK-20', 'PNT-ROLLER', 'FBO', 0.95], ['PNT-SILK-20', 'PNT-MASK', 'FBO', 0.6],
    ['PNT-SILK-20', 'PNT-THINNER', 'COMPATIBLE', 0.5],
    // alternatives
    ['CEM-SIM-50', 'CEM-RHI-50', 'ALTERNATIVE', 1], ['CEM-RHI-50', 'CEM-SIM-50', 'ALTERNATIVE', 1],
    ['PVC-GLUE-250', 'PVC-GLUE-500', 'ALTERNATIVE', 0.8],
  ],
  synonyms: [
    ['pvc bend', 'pvc elbow'], ['elbow fitting', 'pvc elbow'], ['mabati', 'roofing sheet'],
    ['chuma', 'steel rebar'], ['saruji', 'cement'], ['wire nails', 'nails'], ['gypsum', 'mdf'],
  ],
};

const BUILDPRO = {
  categories: ['Cement & Aggregates', 'Structural Steel', 'Roofing & Iron Sheets', 'Plumbing', 'Electrical Wholesale', 'Corporate Tools'],
  suppliers: [
    { name: 'Lake Cement Industries', lead: 1, terms: 'NET7', reliability: 0.97, quality: 0.95, fulfilment: 0.98, onTime: 0.96 },
    { name: 'Doshi Steel', lead: 3, terms: 'NET30', reliability: 0.92, quality: 0.94, fulfilment: 0.95, onTime: 0.91 },
    { name: 'Mombasa Industrial Supplies', lead: 6, terms: 'NET45', reliability: 0.84, quality: 0.88, fulfilment: 0.86, onTime: 0.8 },
  ],
  products: [
    ['CEM-BT-325', 'Blue Triangle Cement 32.5R 50kg', 'Bamburi', 'Cement & Aggregates', 'bag', 690, 765, 735, 745, 710, 'VAT16', 40, 500, 0],
    ['CEM-BT-425', 'Blue Triangle Cement 42.5R 50kg', 'Bamburi', 'Cement & Aggregates', 'bag', 760, 845, 810, 820, 785, 'VAT16', 30, 400, 0],
    ['AGG-BALL-1T', 'Ballast 3/4" (1 Tonne)', 'Local Quarry', 'Cement & Aggregates', 'pallet', 2400, 3100, 2950, 2980, 2700, 'VAT16', 10, 80, null],
    ['STL-D8-DOSHI', 'D8 Deformed Bar 40ft', 'Doshi', 'Structural Steel', 'length', 520, 610, 585, 590, 550, 'VAT16', 80, 800, 1],
    ['STL-D10-DOSHI', 'D10 Deformed Bar 40ft', 'Doshi', 'Structural Steel', 'length', 760, 880, 850, 855, 800, 'VAT16', 60, 600, 1],
    ['STL-D12-DOSHI', 'D12 Deformed Bar 40ft', 'Doshi', 'Structural Steel', 'length', 1040, 1200, 1150, 1160, 1090, 'VAT16', 50, 500, 1],
    ['STL-ANGLE-40', 'Angle Line 40x40x3mm 6m', 'Doshi', 'Structural Steel', 'length', 1450, 1700, 1640, 1650, 1550, 'VAT16', 20, 200, 1],
    ['STL-PIPE-1', 'GI Pipe 1" 6m Class B', 'Doshi', 'Structural Steel', 'length', 1180, 1390, 1340, 1350, 1260, 'VAT16', 25, 250, 1],
    ['ROOF-APEX-30', 'Apex Corrugated Mabati 2.5m 30G', 'MRM', 'Roofing & Iron Sheets', 'sheet', 980, 1180, 1130, 1140, 1060, 'VAT16', 80, 900, 1],
    ['ROOF-APEX-28', 'Apex Corrugated Mabati 3m 28G', 'MRM', 'Roofing & Iron Sheets', 'sheet', 1540, 1790, 1720, 1730, 1620, 'VAT16', 60, 700, 1],
    ['ROOF-NAIL-3', 'Umbrella Head Roofing Nails 3" (1kg)', 'Generic', 'Roofing & Iron Sheets', 'kg', 260, 340, 315, 320, 285, 'VAT16', 60, 400, null],
    ['ROOF-VALLEY', 'Valley Gutter Pre-painted 2.4m', 'MRM', 'Roofing & Iron Sheets', 'piece', 1150, 1390, 1330, 1340, 1250, 'VAT16', 15, 120, 1],
    ['PLB-CPVC-12', 'CPVC Pipe 1/2" Hot Water (6m)', 'Metro Plastics', 'Plumbing', 'length', 520, 680, 645, 650, 590, 'VAT16', 30, 300, null],
    ['PLB-CPVC-ELB', 'CPVC Elbow 1/2"', 'Metro Plastics', 'Plumbing', 'piece', 55, 95, 82, 85, 68, 'VAT16', 100, 900, null],
    ['PLB-CPVC-TEE', 'CPVC Tee 1/2"', 'Metro Plastics', 'Plumbing', 'piece', 65, 110, 95, 98, 78, 'VAT16', 100, 900, null],
    ['PLB-TAPE-PTFE', 'PTFE Thread Tape (Packet 10)', 'Generic', 'Plumbing', 'packet', 120, 190, 175, 178, 150, 'VAT16', 40, 300, null],
    ['ELE-TRUNK-25', 'PVC Trunking 25x16mm 3m', 'Tracer', 'Electrical Wholesale', 'piece', 180, 260, 245, 248, 220, 'VAT16', 60, 500, null],
    ['ELE-LUG-100', 'Cable Lugs 100mm (Packet 20)', 'Tracer', 'Electrical Wholesale', 'packet', 420, 580, 545, 550, 500, 'VAT16', 25, 200, null],
    ['TLS-MIXER-140', 'Electric Mixer 1400W', 'Ingco', 'Corporate Tools', 'piece', 6800, 8400, 8100, 8150, 7600, 'VAT16', 4, 30, null],
    ['TLS-DRILL-750', 'Impact Drill 750W 13mm', 'Makita', 'Corporate Tools', 'piece', 7200, 8900, 8600, 8650, 8000, 'VAT16', 4, 30, null],
    ['TLS-TROWEL-SET', 'Mason Trowel Set (3pc)', 'Generic', 'Corporate Tools', 'set', 780, 1100, 1040, 1050, 950, 'VAT16', 10, 80, null],
  ],
  relations: [
    ['PLB-CPVC-12', 'PLB-CPVC-ELB', 'ACCESSORY', 1], ['PLB-CPVC-12', 'PLB-CPVC-TEE', 'ACCESSORY', 1],
    ['PLB-CPVC-12', 'PLB-TAPE-PTFE', 'REQUIRED', 1],
    ['ROOF-APEX-30', 'ROOF-NAIL-3', 'REQUIRED', 1], ['ROOF-APEX-30', 'ROOF-VALLEY', 'ACCESSORY', 0.8],
    ['ROOF-APEX-28', 'ROOF-NAIL-3', 'REQUIRED', 1], ['ROOF-APEX-28', 'ROOF-VALLEY', 'ACCESSORY', 0.8],
    ['CEM-BT-325', 'AGG-BALL-1T', 'FBO', 0.9], ['CEM-BT-425', 'AGG-BALL-1T', 'FBO', 0.9],
  ],
  synonyms: [['cpvc bend', 'cpvc elbow'], ['mabati', 'mabati'], ['kokoto', 'ballast'], ['barbati', 'rebar']],
};
