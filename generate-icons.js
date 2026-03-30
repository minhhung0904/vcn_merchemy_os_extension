#!/usr/bin/env node
// generate-icons.js
// Creates 4 PNG icons (16, 32, 48, 128px) for the extension using only Canvas API.
// Run: node generate-icons.js
// Requires: npm install canvas

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const sizes = [16, 32, 48, 128];
const outDir = path.join(__dirname, 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

for (const size of sizes) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background circle with gradient
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#6c63ff');
  grad.addColorStop(1, '#a78bfa');

  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Lightning bolt ⚡ symbol
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(size * 0.55)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚡', size / 2, size / 2 + size * 0.04);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), buffer);
  console.log(`✅ icons/icon${size}.png`);
}

console.log('Icons generated successfully!');
