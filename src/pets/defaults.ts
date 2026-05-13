import { PetConfig, DEFAULT_ATLAS } from './types';

// Draw a simple cute creature as a spritesheet
// Each row gets a drawing function that varies with frame index

const CW = 192;
const CH = 208;
const COLS = 8;
const ROWS = 9;

function createSpritesheetCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CW;
  canvas.height = ROWS * CH;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return [canvas, ctx];
}

type FrameDrawer = (ctx: CanvasRenderingContext2D, cx: number, cy: number, frame: number, total: number) => void;

function drawRow(ctx: CanvasRenderingContext2D, row: number, frameCount: number, draw: FrameDrawer) {
  for (let f = 0; f < frameCount; f++) {
    const cx = f * CW;
    const cy = row * CH;
    ctx.save();
    ctx.translate(cx, cy);
    // Clip to cell
    ctx.beginPath();
    ctx.rect(0, 0, CW, CH);
    ctx.clip();
    draw(ctx, cx, cy, f, frameCount);
    ctx.restore();
  }
}

function canvasToDataURL(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/webp', 0.85);
}

// ── Cat Pet ──
function generateCatSpritesheet(): string {
  const [canvas, ctx] = createSpritesheetCanvas();

  // Colors
  const body = '#f4a460';
  const bodyDark = '#d2843e';
  const ears = '#e8915a';
  const eyes = '#2d2d2d';
  const nose = '#ff9999';
  const belly = '#ffe4c4';
  const whiskers = '#ddd';
  const outline = '#5c3a1e';

  function drawCatBody(ctx: CanvasRenderingContext2D, bounceY: number, tailWag: number, blink: number, earWiggle: number) {
    // Tail
    ctx.strokeStyle = body;
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(30, 150 + bounceY);
    ctx.quadraticCurveTo(10 + tailWag * 15, 120 + bounceY, 25 + tailWag * 10, 80 + bounceY);
    ctx.stroke();
    ctx.strokeStyle = bodyDark;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Feet
    ctx.fillStyle = bodyDark;
    roundRect(ctx, 55, 155 + bounceY, 30, 20, 8);
    roundRect(ctx, 105, 155 + bounceY, 30, 20, 8);

    // Body
    ctx.fillStyle = body;
    roundRect(ctx, 48, 90 + bounceY, 95, 75, 25);

    // Belly
    ctx.fillStyle = belly;
    roundRect(ctx, 65, 110 + bounceY, 60, 45, 18);

    // Head
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(96, 68 + bounceY, 40, 0, Math.PI * 2);
    ctx.fill();

    // Ears
    ctx.fillStyle = ears;
    ctx.beginPath();
    ctx.moveTo(62 + earWiggle, 48 + bounceY);
    ctx.lineTo(50 + earWiggle, 8 + bounceY);
    ctx.lineTo(78 + earWiggle, 35 + bounceY);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(130 - earWiggle, 48 + bounceY);
    ctx.lineTo(142 - earWiggle, 8 + bounceY);
    ctx.lineTo(114 - earWiggle, 35 + bounceY);
    ctx.fill();

    // Eyes
    if (blink < 0.9) {
      ctx.fillStyle = eyes;
      ctx.beginPath();
      ctx.arc(80, 62 + bounceY, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(112, 62 + bounceY, 7, 0, Math.PI * 2);
      ctx.fill();
      // Eye shine
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(78, 60 + bounceY, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(110, 60 + bounceY, 2.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Blink line
      ctx.strokeStyle = eyes;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(73, 62 + bounceY);
      ctx.lineTo(87, 62 + bounceY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(105, 62 + bounceY);
      ctx.lineTo(119, 62 + bounceY);
      ctx.stroke();
    }

    // Nose
    ctx.fillStyle = nose;
    ctx.beginPath();
    ctx.moveTo(96, 72 + bounceY);
    ctx.lineTo(91, 78 + bounceY);
    ctx.lineTo(101, 78 + bounceY);
    ctx.fill();

    // Mouth
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(96, 78 + bounceY);
    ctx.quadraticCurveTo(88, 86 + bounceY, 85, 82 + bounceY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(96, 78 + bounceY);
    ctx.quadraticCurveTo(104, 86 + bounceY, 107, 82 + bounceY);
    ctx.stroke();

    // Whiskers
    ctx.strokeStyle = whiskers;
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      const bx = 96 + side * 15;
      ctx.beginPath();
      ctx.moveTo(bx, 74 + bounceY);
      ctx.lineTo(bx + side * 25, 68 + bounceY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx, 76 + bounceY);
      ctx.lineTo(bx + side * 25, 78 + bounceY);
      ctx.stroke();
    }
  }

  // Row 0: Idle — subtle bounce + occasional blink
  drawRow(ctx, 0, 6, (c, x, y, f, t) => {
    const bounceY = Math.sin(f * Math.PI / 3) * 3;
    const blink = f === 0 ? 0.95 : 0;
    drawCatBody(c, bounceY, 0, blink, 0);
  });

  // Row 1: Run right — body shifts + bounce
  drawRow(ctx, 1, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 8;
    const tailWag = Math.sin(f * Math.PI / 4);
    drawCatBody(c, bounceY, tailWag, 0, 0);
  });

  // Row 2: Run left — mirrored
  drawRow(ctx, 2, 8, (c, x, y, f, t) => {
    c.save();
    c.translate(CW / 2, 0);
    c.scale(-1, 1);
    c.translate(-CW / 2, 0);
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 8;
    const tailWag = Math.sin(f * Math.PI / 4);
    drawCatBody(c, bounceY, tailWag, 0, 0);
    c.restore();
  });

  // Row 3: Wave — raised paw
  drawRow(ctx, 3, 4, (c, x, y, f, t) => {
    const waveAngle = Math.sin(f * Math.PI / 2) * 0.5;
    drawCatBody(c, 0, 0, 0, 0);
    // Waving paw
    c.save();
    c.translate(130, 60);
    c.rotate(-0.3 + waveAngle);
    c.fillStyle = bodyDark;
    roundRect(c, -8, -15, 18, 22, 8);
    c.fillStyle = '#e8915a';
    roundRect(c, -4, -12, 10, 10, 5);
    c.restore();
  });

  // Row 4: Jump — big vertical bounce
  drawRow(ctx, 4, 6, (c, x, y, f, t) => {
    const jumpY = f < 3 ? -15 - f * 8 : -15 + (f - 3) * 10;
    drawCatBody(c, jumpY, Math.sin(f * 0.8) * 0.5, 0, 3);
  });

  // Row 5: Failed — dizzy
  drawRow(ctx, 5, 4, (c, x, y, f, t) => {
    const wobble = Math.sin(f * Math.PI / 2) * 5;
    drawCatBody(c, 0, 0, 0, wobble);
    // Dizzy stars above
    if (f % 2 === 0) {
      c.fillStyle = '#ffdd44';
      c.font = '20px sans-serif';
      c.fillText('✦', 130 + wobble, 25);
      c.fillText('✧', 40 - wobble, 20);
    }
  });

  // Row 6: Waiting — slow breathing
  drawRow(ctx, 6, 4, (c, x, y, f, t) => {
    const breathe = Math.sin(f * Math.PI / 2) * 4;
    c.save();
    c.translate(0, breathe * 0.3);
    c.scale(1 + breathe * 0.01, 1 - breathe * 0.01);
    drawCatBody(c, 0, 0, 0, 0);
    c.restore();
  });

  // Row 7: Run fast — bigger strides
  drawRow(ctx, 7, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 12;
    const tailWag = Math.sin(f * Math.PI / 3) * 1.2;
    drawCatBody(c, bounceY, tailWag, 0, 0);
  });

  // Row 8: Review — looking side to side
  drawRow(ctx, 8, 4, (c, x, y, f, t) => {
    const lookX = Math.sin(f * Math.PI / 2) * 10;
    c.save();
    // Shift eyes a bit for "looking" effect
    drawCatBody(c, 0, 0, 0, 0);
    // Eyes looking side
    c.fillStyle = '#2d2d2d';
    c.beginPath();
    c.arc(80 + lookX, 62, 7, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(112 + lookX, 62, 7, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(78 + lookX * 1.2, 60, 2.5, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(110 + lookX * 1.2, 60, 2.5, 0, Math.PI * 2);
    c.fill();
    c.restore();
  });

  return canvasToDataURL(canvas);
}

// ── Blob/Slime Pet ──
function generateBlobSpritesheet(): string {
  const [canvas, ctx] = createSpritesheetCanvas();

  function drawBlob(ctx: CanvasRenderingContext2D, squash: number, bounceY: number, eyeScale: number) {
    const w = 80 + squash * 15;
    const h = 70 - squash * 10;
    const cx = 96;
    const cy = 110 + bounceY;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + h / 2 + 5, w / 2, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    const grad = ctx.createRadialGradient(cx - 10, cy - 10, 5, cx, cy, w / 2);
    grad.addColorStop(0, '#98e898');
    grad.addColorStop(0.6, '#5cba5c');
    grad.addColorStop(1, '#2d8a2d');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Highlight
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.ellipse(cx - 15, cy - 15, w * 0.25, h * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();

    // Eyes
    const eyeY = cy - 8;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx - 18, eyeY, 13 * eyeScale, 15 * eyeScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + 18, eyeY, 13 * eyeScale, 15 * eyeScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(cx - 18, eyeY, 6 * eyeScale, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 18, eyeY, 6 * eyeScale, 0, Math.PI * 2);
    ctx.fill();

    // Mouth
    ctx.strokeStyle = '#1a5c1a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy + 5, 10, 0.1, Math.PI - 0.1);
    ctx.stroke();
  }

  drawRow(ctx, 0, 6, (c, x, y, f, t) => {
    const squash = Math.sin(f * Math.PI / 3) * 0.3;
    drawBlob(c, squash, 0, 1);
  });

  drawRow(ctx, 1, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 10;
    const squash = f % 2 === 0 ? 0.3 : -0.2;
    drawBlob(c, squash, bounceY, 1);
  });

  drawRow(ctx, 2, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 10;
    const squash = f % 2 === 0 ? 0.3 : -0.2;
    drawBlob(c, squash, bounceY, 1);
  });

  drawRow(ctx, 3, 4, (c, x, y, f, t) => {
    drawBlob(c, 0, Math.sin(f * Math.PI / 2) * 5, 1.2);
  });

  drawRow(ctx, 4, 6, (c, x, y, f, t) => {
    const jumpY = f < 3 ? -30 - f * 10 : -30 + (f - 3) * 15;
    drawBlob(c, -0.4, jumpY, 1.1);
  });

  drawRow(ctx, 5, 4, (c, x, y, f, t) => {
    drawBlob(c, -0.5, 0, 0.5);
  });

  drawRow(ctx, 6, 4, (c, x, y, f, t) => {
    drawBlob(c, Math.sin(f * Math.PI / 2) * 0.2, 0, 0.8);
  });

  drawRow(ctx, 7, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 15;
    drawBlob(c, -0.3, bounceY, 1);
  });

  drawRow(ctx, 8, 4, (c, x, y, f, t) => {
    drawBlob(c, 0, 0, 1);
  });

  return canvasToDataURL(canvas);
}

// ── Bird Pet ──
function generateBirdSpritesheet(): string {
  const [canvas, ctx] = createSpritesheetCanvas();

  function drawBird(ctx: CanvasRenderingContext2D, wingAngle: number, bounceY: number, eyeSize: number) {
    const cx = 96;
    const cy = 100 + bounceY;

    // Tail feathers
    ctx.fillStyle = '#e85d3a';
    ctx.beginPath();
    ctx.moveTo(55, cy + 5);
    ctx.lineTo(20, cy - 15);
    ctx.lineTo(40, cy + 15);
    ctx.fill();
    ctx.fillStyle = '#f07050';
    ctx.beginPath();
    ctx.moveTo(50, cy + 5);
    ctx.lineTo(15, cy - 5);
    ctx.lineTo(35, cy + 20);
    ctx.fill();

    // Body
    const bodyGrad = ctx.createRadialGradient(cx - 5, cy - 8, 8, cx, cy, 40);
    bodyGrad.addColorStop(0, '#f5d442');
    bodyGrad.addColorStop(0.7, '#e8a820');
    bodyGrad.addColorStop(1, '#c07810');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 38, 32, 0, 0, Math.PI * 2);
    ctx.fill();

    // Wing
    ctx.save();
    ctx.translate(cx - 8, cy - 5);
    ctx.rotate(wingAngle);
    ctx.fillStyle = '#e8a820';
    ctx.beginPath();
    ctx.ellipse(0, 0, 25, 15, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c07810';
    ctx.beginPath();
    ctx.ellipse(0, 8, 20, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Head
    ctx.fillStyle = '#f5d442';
    ctx.beginPath();
    ctx.arc(cx + 15, cy - 28, 18, 0, Math.PI * 2);
    ctx.fill();

    // Beak
    ctx.fillStyle = '#f5852a';
    ctx.beginPath();
    ctx.moveTo(cx + 33, cy - 28);
    ctx.lineTo(cx + 50, cy - 24);
    ctx.lineTo(cx + 33, cy - 20);
    ctx.fill();

    // Eye
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx + 22, cy - 31, 8 * eyeSize, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(cx + 23, cy - 31, 4.5 * eyeSize, 0, Math.PI * 2);
    ctx.fill();

    // Feet
    ctx.strokeStyle = '#f5852a';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy + 32);
    ctx.lineTo(cx - 5, cy + 48);
    ctx.moveTo(cx - 5, cy + 48);
    ctx.lineTo(cx - 15, cy + 54);
    ctx.moveTo(cx - 5, cy + 48);
    ctx.lineTo(cx, cy + 54);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 10, cy + 32);
    ctx.lineTo(cx + 10, cy + 48);
    ctx.moveTo(cx + 10, cy + 48);
    ctx.lineTo(cx, cy + 54);
    ctx.moveTo(cx + 10, cy + 48);
    ctx.lineTo(cx + 15, cy + 54);
    ctx.stroke();
  }

  drawRow(ctx, 0, 6, (c, x, y, f, t) => {
    const bounceY = Math.sin(f * Math.PI / 3) * 4;
    drawBird(c, 0, bounceY, 1);
  });

  drawRow(ctx, 1, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 8;
    drawBird(c, Math.sin(f * Math.PI / 2) * 0.5, bounceY, 1);
  });

  drawRow(ctx, 2, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 8;
    drawBird(c, Math.sin(f * Math.PI / 2) * 0.5, bounceY, 1);
  });

  drawRow(ctx, 3, 4, (c, x, y, f, t) => {
    drawBird(c, Math.sin(f * Math.PI / 2) * 1.2, 0, 1);
  });

  drawRow(ctx, 4, 6, (c, x, y, f, t) => {
    const jumpY = f < 3 ? -20 - f * 12 : -20 + (f - 3) * 15;
    drawBird(c, 0.8, jumpY, 1);
  });

  drawRow(ctx, 5, 4, (c, x, y, f, t) => {
    drawBird(c, -0.3, 0, 0.6);
  });

  drawRow(ctx, 6, 4, (c, x, y, f, t) => {
    drawBird(c, 0, 0, 0.8);
  });

  drawRow(ctx, 7, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 12;
    drawBird(c, 0.6, bounceY, 1);
  });

  drawRow(ctx, 8, 4, (c, x, y, f, t) => {
    drawBird(c, 0, 0, 1);
  });

  return canvasToDataURL(canvas);
}

// ── Dragon Pet ──
function generateDragonSpritesheet(): string {
  const [canvas, ctx] = createSpritesheetCanvas();

  function drawDragon(ctx: CanvasRenderingContext2D, bounceY: number, wingFlap: number, mouthOpen: number) {
    const cx = 96;
    const cy = 100 + bounceY;

    // Tail
    ctx.strokeStyle = '#4ec94e';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(40, cy + 10);
    ctx.quadraticCurveTo(15, cy - 10, 25, cy - 30);
    ctx.stroke();
    // Tail spike
    ctx.fillStyle = '#3aad3a';
    ctx.beginPath();
    ctx.moveTo(25, cy - 30);
    ctx.lineTo(18, cy - 45);
    ctx.lineTo(32, cy - 32);
    ctx.fill();

    // Body
    const bodyGrad = ctx.createLinearGradient(cx, cy - 20, cx, cy + 30);
    bodyGrad.addColorStop(0, '#5ddb5d');
    bodyGrad.addColorStop(1, '#2ea82e');
    ctx.fillStyle = bodyGrad;
    roundRect(ctx, cx - 30, cy - 18, 65, 48, 20);

    // Belly
    ctx.fillStyle = '#c8f7c8';
    roundRect(ctx, cx - 15, cy + 5, 35, 20, 10);

    // Spikes down back
    ctx.fillStyle = '#3aad3a';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(cx - 15 + i * 18, cy - 18);
      ctx.lineTo(cx - 5 + i * 18, cy - 35);
      ctx.lineTo(cx + 5 + i * 18, cy - 18);
      ctx.fill();
    }

    // Wings
    ctx.save();
    ctx.translate(cx, cy - 5);
    ctx.rotate(-0.2 + wingFlap * 0.6);
    ctx.fillStyle = 'rgba(90,220,90,0.5)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-25, -35, -10, -55);
    ctx.quadraticCurveTo(5, -30, 0, 0);
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,160,40,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Head
    ctx.fillStyle = '#5ddb5d';
    ctx.beginPath();
    ctx.arc(cx + 30, cy - 18, 22, 0, Math.PI * 2);
    ctx.fill();

    // Snout
    ctx.fillStyle = '#5ddb5d';
    ctx.beginPath();
    ctx.ellipse(cx + 48, cy - 12, 14, 10, 0.1, 0, Math.PI * 2);
    ctx.fill();

    // Mouth
    ctx.fillStyle = '#2a602a';
    ctx.beginPath();
    ctx.ellipse(cx + 50, cy - 8, 8, 3 + mouthOpen * 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Nostrils
    ctx.fillStyle = '#2a602a';
    ctx.beginPath();
    ctx.arc(cx + 54, cy - 15, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 58, cy - 13, 2, 0, Math.PI * 2);
    ctx.fill();

    // Eyes
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx + 35, cy - 25, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a3a1a';
    ctx.beginPath();
    ctx.arc(cx + 37, cy - 25, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff0';
    ctx.beginPath(); // slit pupil
    ctx.ellipse(cx + 37, cy - 25, 5, 1.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Horns
    ctx.fillStyle = '#e8d44d';
    ctx.beginPath();
    ctx.moveTo(cx + 18, cy - 35);
    ctx.lineTo(cx + 10, cy - 55);
    ctx.lineTo(cx + 26, cy - 32);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + 30, cy - 36);
    ctx.lineTo(cx + 28, cy - 56);
    ctx.lineTo(cx + 38, cy - 34);
    ctx.fill();

    // Feet
    ctx.fillStyle = '#3aad3a';
    roundRect(ctx, cx - 20, cy + 28, 22, 16, 8);
    roundRect(ctx, cx + 8, cy + 28, 22, 16, 8);
  }

  drawRow(ctx, 0, 6, (c, x, y, f, t) => {
    const bounceY = Math.sin(f * Math.PI / 3) * 3;
    drawDragon(c, bounceY, 0, 0);
  });

  drawRow(ctx, 1, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 10;
    drawDragon(c, bounceY, Math.sin(f * Math.PI / 4) * 0.4, 0);
  });

  drawRow(ctx, 2, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 10;
    drawDragon(c, bounceY, Math.sin(f * Math.PI / 4) * 0.4, 0);
  });

  drawRow(ctx, 3, 4, (c, x, y, f, t) => {
    drawDragon(c, Math.sin(f * Math.PI / 2) * 5, 0.8, 0);
  });

  drawRow(ctx, 4, 6, (c, x, y, f, t) => {
    const jumpY = f < 3 ? -25 - f * 10 : -25 + (f - 3) * 15;
    drawDragon(c, jumpY, 0.6, 0);
  });

  drawRow(ctx, 5, 4, (c, x, y, f, t) => {
    drawDragon(c, 0, -0.1, 1);
    // X eyes
    ctx.fillStyle = '#1a3a1a';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('✕', 97, 77);
  });

  drawRow(ctx, 6, 4, (c, x, y, f, t) => {
    const breathe = Math.sin(f * Math.PI / 2) * 3;
    drawDragon(c, breathe, 0, 0);
    // Zzz
    if (f > 0) {
      ctx.fillStyle = '#aaddff';
      ctx.font = `${10 + f * 3}px sans-serif`;
      ctx.fillText('Z', 135 + f * 8, 40 - f * 8);
    }
  });

  drawRow(ctx, 7, 8, (c, x, y, f, t) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 14;
    drawDragon(c, bounceY, Math.sin(f * Math.PI / 3) * 0.6, 0);
  });

  drawRow(ctx, 8, 4, (c, x, y, f, t) => {
    drawDragon(c, 0, 0, 0);
  });

  return canvasToDataURL(canvas);
}

// ── Custom Pet Generator (used by server API response → frontend) ──

interface CustomPetTags {
  color: string;
  hasWings: boolean;
  hasHorns: boolean;
  isSmall: boolean;
  isRound: boolean;
}

const CUSTOM_COLORS: Record<string, { body: string; bodyDark: string; accent: string; belly: string; eye: string }> = {
  white:  { body: '#f0f0f0', bodyDark: '#d0d0d0', accent: '#e8e8e8', belly: '#ffffff', eye: '#333' },
  black:  { body: '#3a3a3a', bodyDark: '#222222', accent: '#4a4a4a', belly: '#555555', eye: '#fff' },
  red:    { body: '#e85545', bodyDark: '#b83020', accent: '#f07060', belly: '#ffd4cc', eye: '#333' },
  blue:   { body: '#5599dd', bodyDark: '#3366aa', accent: '#77bbff', belly: '#cce5ff', eye: '#333' },
  green:  { body: '#5ddb5d', bodyDark: '#2ea82e', accent: '#7fee7f', belly: '#c8f7c8', eye: '#333' },
  purple: { body: '#9966cc', bodyDark: '#6633aa', accent: '#bb88ee', belly: '#ddccff', eye: '#333' },
  pink:   { body: '#f0a0b0', bodyDark: '#d07080', accent: '#f5c0cc', belly: '#ffe8ec', eye: '#333' },
  orange: { body: '#f4a460', bodyDark: '#d2843e', accent: '#f8c080', belly: '#ffe4c4', eye: '#333' },
  yellow: { body: '#f5d442', bodyDark: '#c8a010', accent: '#fde868', belly: '#fff9cc', eye: '#333' },
  grey:   { body: '#888888', bodyDark: '#666666', accent: '#aaaaaa', belly: '#cccccc', eye: '#333' },
  gray:   { body: '#888888', bodyDark: '#666666', accent: '#aaaaaa', belly: '#cccccc', eye: '#333' },
};

export function generateCustomPet(name: string, tags: CustomPetTags): PetConfig {
  const [canvas, ctx] = createSpritesheetCanvas();
  const c = CUSTOM_COLORS[tags.color] || CUSTOM_COLORS.orange;

  function drawCreature(ctx: CanvasRenderingContext2D, bounceY: number, extra: number, blink: number) {
    const cx = 96;
    const cy = 100 + bounceY;
    const size = tags.isSmall ? 0.7 : 1;

    // Tail
    if (!tags.isRound) {
      ctx.strokeStyle = c.body;
      ctx.lineWidth = 8 * size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(35, cy + 10);
      ctx.quadraticCurveTo(10 + extra * 10, cy - 10, 25, cy - 25);
      ctx.stroke();
    }

    // Feet
    ctx.fillStyle = c.bodyDark;
    roundRect(ctx, 55, 155 + bounceY, 28 * size, 18 * size, 7);
    roundRect(ctx, 105, 155 + bounceY, 28 * size, 18 * size, 7);

    // Body
    const bodyGrad = ctx.createLinearGradient(cx, cy - 20 * size, cx, cy + 30 * size);
    bodyGrad.addColorStop(0, c.accent);
    bodyGrad.addColorStop(1, c.bodyDark);
    ctx.fillStyle = bodyGrad;
    if (tags.isRound) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, 50 * size, 42 * size, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      roundRect(ctx, cx - 35 * size, cy - 18 * size, 70 * size, 50 * size, 22 * size);
    }

    // Belly
    ctx.fillStyle = c.belly;
    if (tags.isRound) {
      ctx.beginPath();
      ctx.ellipse(cx, cy + 5, 30 * size, 22 * size, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      roundRect(ctx, cx - 18 * size, cy + 5, 36 * size, 22 * size, 12 * size);
    }

    // Wings (if bird/dragon type)
    if (tags.hasWings && !tags.isRound) {
      ctx.save();
      ctx.translate(cx - 5, cy - 10);
      ctx.rotate(-0.2 + extra * 0.5);
      ctx.fillStyle = `${c.accent}88`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(-22, -28, -8, -45);
      ctx.quadraticCurveTo(4, -24, 0, 0);
      ctx.fill();
      ctx.restore();
    }

    // Horns (for dragon type)
    if (tags.hasHorns && !tags.isRound) {
      ctx.fillStyle = '#e8d44d';
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy - 30);
      ctx.lineTo(cx - 16, cy - 50);
      ctx.lineTo(cx, cy - 28);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + 4, cy - 30);
      ctx.lineTo(cx + 2, cy - 50);
      ctx.lineTo(cx + 12, cy - 28);
      ctx.fill();
    }

    // Ears (for cat type — when no wings, no horns, not round)
    if (!tags.hasWings && !tags.hasHorns && !tags.isRound) {
      ctx.fillStyle = c.body;
      ctx.beginPath();
      ctx.moveTo(62, 52);
      ctx.lineTo(52, 18);
      ctx.lineTo(78, 42);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(130, 52);
      ctx.lineTo(140, 18);
      ctx.lineTo(114, 42);
      ctx.fill();
    }

    // Head
    ctx.fillStyle = c.body;
    ctx.beginPath();
    ctx.arc(cx, cy - 22 * size, 36 * size, 0, Math.PI * 2);
    ctx.fill();

    // Eyes
    if (blink < 0.9) {
      ctx.fillStyle = c.eye;
      ctx.beginPath();
      ctx.arc(cx - 14 * size, cy - 27 * size, 6 * size, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + 14 * size, cy - 27 * size, 6 * size, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx - 16 * size, cy - 29 * size, 2 * size, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + 12 * size, cy - 29 * size, 2 * size, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = c.eye;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - 20 * size, cy - 27 * size);
      ctx.lineTo(cx - 8 * size, cy - 27 * size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 8 * size, cy - 27 * size);
      ctx.lineTo(cx + 20 * size, cy - 27 * size);
      ctx.stroke();
    }

    // Nose / beak
    if (tags.hasWings && !tags.hasHorns) {
      // Beak
      ctx.fillStyle = '#f5852a';
      ctx.beginPath();
      ctx.moveTo(cx + 32 * size, cy - 22 * size);
      ctx.lineTo(cx + 48 * size, cy - 18 * size);
      ctx.lineTo(cx + 32 * size, cy - 14 * size);
      ctx.fill();
    } else if (!tags.isRound) {
      ctx.fillStyle = '#ff9999';
      ctx.beginPath();
      ctx.moveTo(cx, cy - 15 * size);
      ctx.lineTo(cx - 4, cy - 10 * size);
      ctx.lineTo(cx + 4, cy - 10 * size);
      ctx.fill();
    }

    // Mouth
    if (!tags.isRound) {
      ctx.strokeStyle = c.bodyDark;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 10 * size);
      ctx.quadraticCurveTo(cx - 6, cy - 4 * size, cx - 8, cy - 6 * size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - 10 * size);
      ctx.quadraticCurveTo(cx + 6, cy - 4 * size, cx + 8, cy - 6 * size);
      ctx.stroke();
    }
  }

  // Draw all 9 rows — simplified procedurally
  drawRow(ctx, 0, 6, (_c, _x, _y, f) => {
    const bounceY = Math.sin(f * Math.PI / 3) * 3;
    drawCreature(_c, bounceY, 0, f === 0 ? 0.9 : 0);
  });

  drawRow(ctx, 1, 8, (_c, _x, _y, f) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 8;
    drawCreature(_c, bounceY, Math.sin(f * 0.5), 0);
  });

  drawRow(ctx, 2, 8, (_c, _x, _y, f) => {
    _c.save();
    _c.translate(CW / 2, 0);
    _c.scale(-1, 1);
    _c.translate(-CW / 2, 0);
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 8;
    drawCreature(_c, bounceY, Math.sin(f * 0.5), 0);
    _c.restore();
  });

  drawRow(ctx, 3, 4, (_c, _x, _y, f) => {
    drawCreature(_c, Math.sin(f * Math.PI / 2) * 4, 0.6, 0);
  });

  drawRow(ctx, 4, 6, (_c, _x, _y, f) => {
    const jumpY = f < 3 ? -20 - f * 8 : -20 + (f - 3) * 12;
    drawCreature(_c, jumpY, 0.5, 0);
  });

  drawRow(ctx, 5, 4, (_c, _x, _y, f) => {
    drawCreature(_c, 0, -0.2, f >= 2 ? 0.95 : 0);
    if (f % 2 === 0) {
      _c.fillStyle = '#ffdd44';
      _c.font = '18px sans-serif';
      _c.fillText('✦', 130, 25);
    }
  });

  drawRow(ctx, 6, 4, (_c, _x, _y, f) => {
    const breathe = Math.sin(f * Math.PI / 2) * 2;
    drawCreature(_c, breathe, 0, 0);
  });

  drawRow(ctx, 7, 8, (_c, _x, _y, f) => {
    const bounceY = Math.abs(Math.sin(f * Math.PI / 4)) * 12;
    drawCreature(_c, bounceY, Math.sin(f * 0.6), 0);
  });

  drawRow(ctx, 8, 4, (_c, _x, _y, f) => {
    drawCreature(_c, 0, 0, 0);
  });

  const sheet = canvasToDataURL(canvas);

  return {
    id: `custom-${Date.now()}`,
    name,
    author: 'AI Generated',
    spritesheet: sheet,
    atlas: DEFAULT_ATLAS,
    thumbnail: sheet,
  };
}

// ── Export default pets ──

function generateThumbnail(spritesheet: string): string {
  // Return first frame as thumbnail by reusing the spritesheet — we just create a small canvas
  const img = new Image();
  // Since Image is async, we return the full spritesheet as thumbnail for now.
  // The SpriteAnimator will render at cell-level precision.
  return spritesheet;
}

let _defaults: PetConfig[] | null = null;

export function getDefaultPets(): PetConfig[] {
  if (_defaults) return _defaults;

  const catSheet = generateCatSpritesheet();
  const blobSheet = generateBlobSpritesheet();
  const birdSheet = generateBirdSpritesheet();
  const dragonSheet = generateDragonSpritesheet();

  _defaults = [
    {
      id: 'lumi-cat',
      name: 'Lumi Cat',
      author: 'LumiOS',
      spritesheet: catSheet,
      atlas: DEFAULT_ATLAS,
      thumbnail: catSheet,
    },
    {
      id: 'lumi-blob',
      name: 'Lumi Blob',
      author: 'LumiOS',
      spritesheet: blobSheet,
      atlas: DEFAULT_ATLAS,
      thumbnail: blobSheet,
    },
    {
      id: 'lumi-bird',
      name: 'Lumi Bird',
      author: 'LumiOS',
      spritesheet: birdSheet,
      atlas: DEFAULT_ATLAS,
      thumbnail: birdSheet,
    },
    {
      id: 'lumi-dragon',
      name: 'Lumi Dragon',
      author: 'LumiOS',
      spritesheet: dragonSheet,
      atlas: DEFAULT_ATLAS,
      thumbnail: dragonSheet,
    },
  ];

  return _defaults;
}

// ── Helper ──

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}
