// Convert lumiOS-icon.svg to icon.ico with multiple sizes
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'assets', 'lumiOS-icon.svg');
const ICO_PATH = path.join(ROOT, 'src-tauri', 'icons', 'icon.ico');

// Standard icon sizes for Windows
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildICO(pngBuffers) {
  const count = pngBuffers.length;
  // ICO header: 2 bytes reserved (0), 2 bytes type (1 = ICO), 2 bytes count
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = count * dirEntrySize;

  // Calculate offsets to image data
  const dataOffset = headerSize + dirSize;
  let imageDataOffset = dataOffset;

  const dirEntries = [];
  const imageData = [];

  for (let i = 0; i < count; i++) {
    const buf = pngBuffers[i];
    const size = buf.length;
    // Width/height: 0 means 256
    const w = SIZES[i] >= 256 ? 0 : SIZES[i];
    const h = SIZES[i] >= 256 ? 0 : SIZES[i];

    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(w, 0);        // width
    entry.writeUInt8(h, 1);        // height
    entry.writeUInt8(0, 2);        // color palette (0 = no palette)
    entry.writeUInt8(0, 3);        // reserved
    entry.writeUInt16LE(1, 4);     // color planes
    entry.writeUInt16LE(32, 6);    // bits per pixel
    entry.writeUInt32LE(size, 8);  // image size
    entry.writeUInt32LE(imageDataOffset, 12); // offset to image data

    dirEntries.push(entry);
    imageData.push(buf);
    imageDataOffset += size;
  }

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = ICO
  header.writeUInt16LE(count, 4); // image count

  return Buffer.concat([header, ...dirEntries, ...imageData]);
}

async function main() {
  console.log(`Reading SVG: ${SVG_PATH}`);
  const svgBuffer = fs.readFileSync(SVG_PATH);

  const pngBuffers = [];
  for (const size of SIZES) {
    console.log(`  Rasterizing ${size}x${size}...`);
    const png = await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toBuffer();
    pngBuffers.push(png);
  }

  console.log(`Building ICO with ${SIZES.length} sizes...`);
  const ico = buildICO(pngBuffers);

  // Backup existing icon if present
  if (fs.existsSync(ICO_PATH)) {
    fs.copyFileSync(ICO_PATH, ICO_PATH + '.bak');
    console.log('  Backed up existing icon.ico → icon.ico.bak');
  }

  fs.writeFileSync(ICO_PATH, ico);
  console.log(`Done — written to ${ICO_PATH} (${ico.length} bytes)`);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
