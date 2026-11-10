// Material presets: typical sheet stock for CNC routing. Thickness in mm, colour for 3D.

export const MATERIAL_TYPES = ['plywood', 'wood', 'board', 'plastic', 'metal', 'foam', 'other'];

export const PRESETS = [
  { name: 'Birch plywood 18', type: 'plywood', thickness: 18, color: '#e3c592' },
  { name: 'Birch plywood 12', type: 'plywood', thickness: 12, color: '#e3c592' },
  { name: 'Birch plywood 9', type: 'plywood', thickness: 9, color: '#e3c592' },
  { name: 'Poplar plywood 15', type: 'plywood', thickness: 15, color: '#e8d6a8' },
  { name: 'Guatambú plywood 18', type: 'plywood', thickness: 18, color: '#ead8a8' },
  { name: 'Cedro plywood 18', type: 'plywood', thickness: 18, color: '#b87556' },
  { name: 'Pine board 18', type: 'wood', thickness: 18, color: '#d9b27c' },
  { name: 'Oak 20', type: 'wood', thickness: 20, color: '#c49a6c' },
  { name: 'Walnut 20', type: 'wood', thickness: 20, color: '#7a5436' },
  { name: 'MDF 18', type: 'board', thickness: 18, color: '#b89f7d' },
  { name: 'MDF 6', type: 'board', thickness: 6, color: '#b89f7d' },
  { name: 'Acrylic 3 (clear)', type: 'plastic', thickness: 3, color: '#cfe8f3' },
  { name: 'Acrylic 5 (black)', type: 'plastic', thickness: 5, color: '#2b2b2b' },
  { name: 'HDPE 10', type: 'plastic', thickness: 10, color: '#f2f2f0' },
  { name: 'Polycarbonate 4', type: 'plastic', thickness: 4, color: '#d6e6ea' },
  { name: 'Aluminium 3', type: 'metal', thickness: 3, color: '#c3c7cc' },
  { name: 'Aluminium composite 3', type: 'metal', thickness: 3, color: '#dfe2e6' },
  { name: 'Brass 2', type: 'metal', thickness: 2, color: '#c9a94e' },
  { name: 'Steel 3', type: 'metal', thickness: 3, color: '#8a9099' },
  { name: 'EVA foam 20', type: 'foam', thickness: 20, color: '#3a3a3a' },
  { name: 'XPS foam 30', type: 'foam', thickness: 30, color: '#9fc7e8' },
  { name: 'Cork 6', type: 'other', thickness: 6, color: '#b88a5a' },
];
