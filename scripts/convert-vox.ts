/**
 * Build-time codegen script: reads .vox files from assets/vox/, converts them
 * to the game's VoxelModel grid format, and writes GeneratedVoxelModels.ts.
 *
 * Run with: npm run convert-vox
 *
 * Axis convention:
 *   MagicaVoxel is Z-up; game is Y-up.
 *   gx = mv_x,  gy = mv_z,  gz = mv_y
 *   sizeX = mv_sizeX,  sizeY = mv_sizeZ,  sizeZ = mv_sizeY
 *
 * Special palette indices (same in MagicaVoxel and game):
 *   253 = PAL_TEAM_ACCENT  (paint with slot 253 in MagicaVoxel)
 *   254 = PAL_TEAM_PRIMARY (paint with slot 254 in MagicaVoxel)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ModelEntry {
  meshType: string;
  turretMinY?: number;
  turretMaxY?: number;
}

interface ModelsJson {
  models: Record<string, ModelEntry | Record<string, unknown>>;
}

interface VoxData {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  voxels: { x: number; y: number; z: number; colorIndex: number }[];
  palette: number[]; // index 0 unused; indices 1-255 are hex RRGGBB
}

// ─────────────────────────────────────────────────────────────────────────────
// MagicaVoxel default palette (256 entries, index 0 unused)
// Taken from the official default palette distributed with MagicaVoxel 0.99.7
// ─────────────────────────────────────────────────────────────────────────────
// prettier-ignore
const DEFAULT_PALETTE: number[] = [
  0x000000, // 0: unused
  0xffffff, 0xffccff, 0xff99ff, 0xff66ff, 0xff33ff, 0xff00ff, 0xffcccc, 0xff99cc,
  0xff66cc, 0xff33cc, 0xff00cc, 0xffcc99, 0xff9999, 0xff6699, 0xff3399, 0xff0099,
  0xffcc66, 0xff9966, 0xff6666, 0xff3366, 0xff0066, 0xffcc33, 0xff9933, 0xff6633,
  0xff3333, 0xff0033, 0xffcc00, 0xff9900, 0xff6600, 0xff3300, 0xff0000, 0xffffcc,
  0xffccff, 0xff99ff, 0xff66ff, 0xff33ff, 0xffcccc, 0xff99cc, 0xff66cc, 0xff33cc,
  0xff00cc, 0xffcc99, 0xff9999, 0xff6699, 0xff3399, 0xff0099, 0xffcc66, 0xff9966,
  0xff6666, 0xff3366, 0xff0066, 0xffcc33, 0xff9933, 0xff6633, 0xff3333, 0xff0033,
  0xffcc00, 0xff9900, 0xff6600, 0xff3300, 0xff0000, 0xccffff, 0xccccff, 0xcc99ff,
  0xcc66ff, 0xcc33ff, 0xcc00ff, 0xccffcc, 0xcccccc, 0xcc99cc, 0xcc66cc, 0xcc33cc,
  0xcc00cc, 0xccff99, 0xcc9999, 0xcc6699, 0xcc3399, 0xcc0099, 0xccff66, 0xcc9966,
  0xcc6666, 0xcc3366, 0xcc0066, 0xccff33, 0xcc9933, 0xcc6633, 0xcc3333, 0xcc0033,
  0xccff00, 0xcc9900, 0xcc6600, 0xcc3300, 0xcc0000, 0x99ffff, 0x99ccff, 0x9999ff,
  0x9966ff, 0x9933ff, 0x9900ff, 0x99ffcc, 0x99cccc, 0x9999cc, 0x9966cc, 0x9933cc,
  0x9900cc, 0x99ff99, 0x99cc99, 0x999999, 0x996699, 0x993399, 0x990099, 0x99ff66,
  0x99cc66, 0x999966, 0x996666, 0x993366, 0x990066, 0x99ff33, 0x99cc33, 0x999933,
  0x996633, 0x993333, 0x990033, 0x99ff00, 0x99cc00, 0x999900, 0x996600, 0x993300,
  0x990000, 0x66ffff, 0x66ccff, 0x6699ff, 0x6666ff, 0x6633ff, 0x6600ff, 0x66ffcc,
  0x66cccc, 0x6699cc, 0x6666cc, 0x6633cc, 0x6600cc, 0x66ff99, 0x66cc99, 0x669999,
  0x666699, 0x663399, 0x660099, 0x66ff66, 0x66cc66, 0x669966, 0x666666, 0x663366,
  0x660066, 0x66ff33, 0x66cc33, 0x669933, 0x666633, 0x663333, 0x660033, 0x66ff00,
  0x66cc00, 0x669900, 0x666600, 0x663300, 0x660000, 0x33ffff, 0x33ccff, 0x3399ff,
  0x3366ff, 0x3333ff, 0x3300ff, 0x33ffcc, 0x33cccc, 0x3399cc, 0x3366cc, 0x3333cc,
  0x3300cc, 0x33ff99, 0x33cc99, 0x339999, 0x336699, 0x333399, 0x330099, 0x33ff66,
  0x33cc66, 0x339966, 0x336666, 0x333366, 0x330066, 0x33ff33, 0x33cc33, 0x339933,
  0x336633, 0x333333, 0x330033, 0x33ff00, 0x33cc00, 0x339900, 0x336600, 0x333300,
  0x330000, 0x00ffff, 0x00ccff, 0x0099ff, 0x0066ff, 0x0033ff, 0x0000ff, 0x00ffcc,
  0x00cccc, 0x0099cc, 0x0066cc, 0x0033cc, 0x0000cc, 0x00ff99, 0x00cc99, 0x009999,
  0x006699, 0x003399, 0x000099, 0x00ff66, 0x00cc66, 0x009966, 0x006666, 0x003366,
  0x000066, 0x00ff33, 0x00cc33, 0x009933, 0x006633, 0x003333, 0x000033, 0x00ff00,
  0x00cc00, 0x009900, 0x006600, 0x003300, 0x000000, 0xffffff, 0xffddbb, 0xbb8866,
  0x887755, 0x554433, 0xff8833, 0x77ccff, 0x333333, 0x000000, // 248-255 placeholders
];
// Pad to 256 entries if needed
while (DEFAULT_PALETTE.length < 256) DEFAULT_PALETTE.push(0x888888);

// ─────────────────────────────────────────────────────────────────────────────
// .vox binary parser
// ─────────────────────────────────────────────────────────────────────────────

function parseVox(buf: Buffer): VoxData {
  let pos = 0;

  function u8(): number { return buf[pos++]; }
  function u32(): number { const v = buf.readUInt32LE(pos); pos += 4; return v; }
  function str4(): string { const s = buf.slice(pos, pos + 4).toString('ascii'); pos += 4; return s; }

  const magic = str4();
  if (magic !== 'VOX ') throw new Error(`Not a .vox file (got magic "${magic}")`);
  u32(); // version (150 or 200)

  // Working state
  let sizeX = 0, sizeY = 0, sizeZ = 0;
  const voxels: VoxData['voxels'] = [];
  const palette: number[] = [...DEFAULT_PALETTE];

  function parseChunk(): void {
    const id = str4();
    const contentBytes = u32();
    const childrenBytes = u32();
    const contentEnd = pos + contentBytes;
    const childrenEnd = contentEnd + childrenBytes;

    if (id === 'SIZE') {
      sizeX = u32();
      sizeY = u32();
      sizeZ = u32();
    } else if (id === 'XYZI') {
      const n = u32();
      for (let i = 0; i < n; i++) {
        const x = u8();
        const y = u8();
        const z = u8();
        const c = u8();
        voxels.push({ x, y, z, colorIndex: c });
      }
    } else if (id === 'RGBA') {
      // Palette indices 1-255 are stored at chunk positions 0-254.
      // Position 255 (the 256th entry) is unused per spec.
      for (let i = 0; i < 255; i++) {
        const r = u8(); const g = u8(); const b = u8(); u8(); // skip alpha
        palette[i + 1] = (r << 16) | (g << 8) | b;
      }
      // Skip the last (unused) entry
      pos = contentEnd;
    }

    pos = contentEnd;

    // Parse children
    while (pos < childrenEnd) {
      parseChunk();
    }
    pos = childrenEnd;
  }

  // Root chunk must be MAIN
  const rootId = str4();
  if (rootId !== 'MAIN') throw new Error(`Expected MAIN chunk, got "${rootId}"`);
  const rootContent = u32();
  const rootChildren = u32();
  pos += rootContent; // MAIN has no direct content
  const end = pos + rootChildren;

  while (pos < end) {
    parseChunk();
  }

  if (sizeX === 0) throw new Error('.vox file has no SIZE chunk or no voxels');

  return { sizeX, sizeY, sizeZ, voxels, palette };
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion: MagicaVoxel (Z-up) → game grid (Y-up)
// ─────────────────────────────────────────────────────────────────────────────

interface ConvertedModel {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  gridB64: string;
  palette: number[];
  turretMinY?: number;
  turretMaxY?: number;
}

function convertVox(vox: VoxData, turretMinY?: number, turretMaxY?: number): ConvertedModel {
  // Axis swap: MagicaVoxel Z-up → game Y-up
  // mv_x → game x
  // mv_z → game y  (MagicaVoxel Z is game Y)
  // mv_y → game z  (MagicaVoxel Y is game Z)
  const sizeX = vox.sizeX;
  const sizeY = vox.sizeZ; // mv Z-depth becomes game Y-height
  const sizeZ = vox.sizeY; // mv Y-depth becomes game Z-depth

  const grid = new Uint8Array(sizeX * sizeY * sizeZ);

  for (const v of vox.voxels) {
    const gx = v.x;
    const gy = v.z; // mv Z (height) → game Y
    const gz = v.y; // mv Y (depth)  → game Z
    if (gx < sizeX && gy < sizeY && gz < sizeZ) {
      grid[gx + gz * sizeX + gy * sizeX * sizeZ] = v.colorIndex;
    }
  }

  const gridB64 = Buffer.from(grid).toString('base64');

  return { sizeX, sizeY, sizeZ, gridB64, palette: vox.palette, turretMinY, turretMaxY };
}

// ─────────────────────────────────────────────────────────────────────────────
// TypeScript source emitter
// ─────────────────────────────────────────────────────────────────────────────

function emitGeneratedFile(models: Record<string, ConvertedModel>): string {
  const modelCount = Object.keys(models).length;
  const lines: string[] = [];

  lines.push('// AUTO-GENERATED by scripts/convert-vox.ts — do not edit manually');
  lines.push('// Run `npm run convert-vox` to regenerate from assets/vox/');
  lines.push(`// Generated ${new Date().toISOString()} (${modelCount} model${modelCount !== 1 ? 's' : ''})`);
  lines.push('');
  lines.push("import type { VoxelModel } from './VoxelModels';");
  lines.push('');

  if (modelCount === 0) {
    lines.push('// No .vox models found in assets/vox/. Add entries to assets/vox/models.json to enable.');
    lines.push('');
    lines.push('export const GENERATED_VOXEL_MODELS: Record<string, VoxelModel> = {};');
    return lines.join('\n') + '\n';
  }

  // Deterministic integer hash (same as VoxelModels.ts)
  lines.push('function _intHash(n: number): number {');
  lines.push('  n = (((n >> 16) ^ n) * 0x45d9f3b) | 0;');
  lines.push('  n = (((n >> 16) ^ n) * 0x45d9f3b) | 0;');
  lines.push('  return (n >> 16) ^ n;');
  lines.push('}');
  lines.push('');

  // buildFromVox helper — reconstructs VoxelModel from base64 grid + palette
  lines.push('function _buildFromVox(');
  lines.push('  sizeX: number, sizeY: number, sizeZ: number,');
  lines.push('  gridB64: string,');
  lines.push('  palette: number[],');
  lines.push('  turretMinY?: number, turretMaxY?: number,');
  lines.push('): VoxelModel {');
  lines.push('  // Decode base64 grid (browser has atob; Vite bundles for browser)');
  lines.push('  const raw = atob(gridB64);');
  lines.push('  const grid = new Uint8Array(sizeX * sizeY * sizeZ);');
  lines.push('  for (let i = 0; i < raw.length; i++) grid[i] = raw.charCodeAt(i);');
  lines.push('');
  lines.push('  const solidVoxels: [number, number][] = [];');
  lines.push('  for (let i = 0; i < grid.length; i++) {');
  lines.push('    if (grid[i] !== 0) solidVoxels.push([i, grid[i]]);');
  lines.push('  }');
  lines.push('');
  lines.push('  const gridToSolid = new Int32Array(grid.length).fill(-1);');
  lines.push('  for (let si = 0; si < solidVoxels.length; si++) {');
  lines.push('    gridToSolid[solidVoxels[si][0]] = si;');
  lines.push('  }');
  lines.push('');
  lines.push('  const buildOrder = Array.from({ length: solidVoxels.length }, (_, i) => i);');
  lines.push('  buildOrder.sort((a, b) => {');
  lines.push('    const giA = solidVoxels[a][0];');
  lines.push('    const giB = solidVoxels[b][0];');
  lines.push('    const yA = Math.floor(giA / (sizeX * sizeZ));');
  lines.push('    const yB = Math.floor(giB / (sizeX * sizeZ));');
  lines.push('    if (yA !== yB) return yA - yB;');
  lines.push('    return _intHash(giA) - _intHash(giB);');
  lines.push('  });');
  lines.push('');
  lines.push('  let firstLayerCount = 0;');
  lines.push('  if (buildOrder.length > 0) {');
  lines.push('    const firstY = Math.floor(solidVoxels[buildOrder[0]][0] / (sizeX * sizeZ));');
  lines.push('    for (let i = 0; i < buildOrder.length; i++) {');
  lines.push('      if (Math.floor(solidVoxels[buildOrder[i]][0] / (sizeX * sizeZ)) !== firstY) break;');
  lines.push('      firstLayerCount++;');
  lines.push('    }');
  lines.push('  }');
  lines.push('');
  lines.push('  return {');
  lines.push('    sizeX, sizeY, sizeZ, grid, palette, solidVoxels,');
  lines.push('    totalSolid: solidVoxels.length, gridToSolid,');
  lines.push('    turretMinY, turretMaxY, buildOrder, firstLayerCount,');
  lines.push('  };');
  lines.push('}');
  lines.push('');

  // Emit each model
  lines.push('export const GENERATED_VOXEL_MODELS: Record<string, VoxelModel> = {');
  for (const [meshType, m] of Object.entries(models)) {
    const turretArgs = m.turretMinY != null
      ? `, ${m.turretMinY}${m.turretMaxY != null ? `, ${m.turretMaxY}` : ''}`
      : '';
    // Compact palette: emit as sparse array literal (only defined entries)
    const paletteEntries: string[] = [];
    for (let i = 0; i < m.palette.length; i++) {
      if (m.palette[i] !== undefined && m.palette[i] !== 0) {
        paletteEntries.push(`${i}: 0x${m.palette[i].toString(16).padStart(6, '0').toUpperCase()}`);
      }
    }
    const paletteStr = `[${paletteEntries.map(e => {
      const [idx, val] = e.split(': ');
      return `/* ${idx} */ ${val}`;
    }).join(', ')}]`;

    // Actually emit as dense array for simplicity — easier to reason about
    const densePalette = Array.from({ length: 256 }, (_, i) =>
      m.palette[i] != null ? `0x${m.palette[i].toString(16).padStart(6, '0').toUpperCase()}` : '0x000000'
    );
    const paletteLine = `[${densePalette.join(',')}]`;

    lines.push(`  // meshType: ${meshType} (${m.sizeX}x${m.sizeY}x${m.sizeZ} voxels)`);
    lines.push(`  ${meshType}: _buildFromVox(`);
    lines.push(`    ${m.sizeX}, ${m.sizeY}, ${m.sizeZ},`);
    lines.push(`    '${m.gridB64}',`);
    lines.push(`    ${paletteLine}${turretArgs}`);
    lines.push(`  ),`);
  }
  lines.push('};');

  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  const projectRoot = join(__dirname, '..');
  const voxDir = join(projectRoot, 'assets', 'vox');
  const manifestPath = join(voxDir, 'models.json');
  const outputPath = join(projectRoot, 'src', 'simulation', 'data', 'GeneratedVoxelModels.ts');

  if (!existsSync(manifestPath)) {
    console.error(`Missing manifest: ${manifestPath}`);
    process.exit(1);
  }

  const manifest: ModelsJson = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const models: Record<string, ConvertedModel> = {};

  for (const [filename, rawEntry] of Object.entries(manifest.models)) {
    // Skip comment/example entries (keys or values with $ prefix)
    if (filename.startsWith('$')) continue;
    const entry = rawEntry as ModelEntry;
    if (!entry.meshType || entry.meshType.startsWith('$')) continue;

    const voxPath = join(voxDir, filename);
    if (!existsSync(voxPath)) {
      console.warn(`  [skip] ${filename} — file not found at ${voxPath}`);
      continue;
    }

    process.stdout.write(`  [parse] ${filename} → meshType "${entry.meshType}" ... `);
    try {
      const buf = readFileSync(voxPath);
      const vox = parseVox(buf);
      const turretMinY = entry.turretMinY != null ? entry.turretMinY : undefined;
      const turretMaxY = entry.turretMaxY != null ? entry.turretMaxY : undefined;
      const converted = convertVox(vox, turretMinY, turretMaxY);
      models[entry.meshType] = converted;
      console.log(`${vox.voxels.length} voxels, size ${vox.sizeX}x${vox.sizeY}x${vox.sizeZ} → game ${converted.sizeX}x${converted.sizeY}x${converted.sizeZ}`);
    } catch (e) {
      console.error(`FAILED: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  const source = emitGeneratedFile(models);
  writeFileSync(outputPath, source, 'utf-8');
  console.log(`\nWrote ${outputPath} (${Object.keys(models).length} model${Object.keys(models).length !== 1 ? 's' : ''})`);
}

main();
