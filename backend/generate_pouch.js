const fs = require('fs');

function generatePillowPouchObj() {
  const width = 1.0;
  const height = 1.5;
  const depth = 0.25;
  const resX = 20;
  const resY = 30;

  let obj = '';
  
  const verts = [];
  const uvs = [];

  for (let iy = 0; iy <= resY; iy++) {
    const v = iy / resY;
    const y = (v - 0.5) * height;
    const yBulge = Math.cos((v - 0.5) * Math.PI);
    
    for (let ix = 0; ix <= resX; ix++) {
      const u = ix / resX;
      const x = (u - 0.5) * width;
      const xBulge = Math.cos((u - 0.5) * Math.PI);
      const noise = (Math.random() - 0.5) * 0.015 * xBulge * yBulge;
      const z = (xBulge * yBulge * depth) + noise;
      verts.push([x, y, z]);
      uvs.push([u, v]);
    }
  }

  for (let iy = 0; iy <= resY; iy++) {
    const v = iy / resY;
    const y = (v - 0.5) * height;
    const yBulge = Math.cos((v - 0.5) * Math.PI);
    
    for (let ix = 0; ix <= resX; ix++) {
      const u = ix / resX;
      const x = (u - 0.5) * width;
      const xBulge = Math.cos((u - 0.5) * Math.PI);
      const noise = (Math.random() - 0.5) * 0.015 * xBulge * yBulge;
      const z = -(xBulge * yBulge * depth) - noise;
      verts.push([x, y, z]);
      uvs.push([1 - u, v]);
    }
  }

  for (const [x, y, z] of verts) {
    obj += `v ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}\n`;
  }
  for (const [u, v] of uvs) {
    obj += `vt ${u.toFixed(4)} ${v.toFixed(4)}\n`;
  }

  const vertsPerFace = resX + 1;
  
  for (let iy = 0; iy < resY; iy++) {
    for (let ix = 0; ix < resX; ix++) {
      const tl = iy * vertsPerFace + ix + 1;
      const tr = tl + 1;
      const bl = (iy + 1) * vertsPerFace + ix + 1;
      const br = bl + 1;
      obj += `f ${tl}/${tl} ${bl}/${bl} ${tr}/${tr}\n`;
      obj += `f ${tr}/${tr} ${bl}/${bl} ${br}/${br}\n`;
    }
  }

  const backOffset = (resY + 1) * vertsPerFace;
  for (let iy = 0; iy < resY; iy++) {
    for (let ix = 0; ix < resX; ix++) {
      const tl = backOffset + iy * vertsPerFace + ix + 1;
      const tr = tl + 1;
      const bl = backOffset + (iy + 1) * vertsPerFace + ix + 1;
      const br = bl + 1;
      obj += `f ${tl}/${tl} ${tr}/${tr} ${bl}/${bl}\n`;
      obj += `f ${tr}/${tr} ${br}/${br} ${bl}/${bl}\n`;
    }
  }

  for (let iy = 0; iy < resY; iy++) {
    const fTop = iy * vertsPerFace + 1;
    const fBot = (iy + 1) * vertsPerFace + 1;
    const bTop = backOffset + iy * vertsPerFace + 1;
    const bBot = backOffset + (iy + 1) * vertsPerFace + 1;
    obj += `f ${fTop}/${fTop} ${bTop}/${bTop} ${fBot}/${fBot}\n`;
    obj += `f ${bTop}/${bTop} ${bBot}/${bBot} ${fBot}/${fBot}\n`;
  }
  
  for (let iy = 0; iy < resY; iy++) {
    const fTop = iy * vertsPerFace + resX + 1;
    const fBot = (iy + 1) * vertsPerFace + resX + 1;
    const bTop = backOffset + iy * vertsPerFace + resX + 1;
    const bBot = backOffset + (iy + 1) * vertsPerFace + resX + 1;
    obj += `f ${fTop}/${fTop} ${fBot}/${fBot} ${bTop}/${bTop}\n`;
    obj += `f ${bTop}/${bTop} ${fBot}/${fBot} ${bBot}/${bBot}\n`;
  }

  return obj;
}

const obj = generatePillowPouchObj();
fs.writeFileSync('../frontend/public/models/kurkure_pouch.obj', obj);
console.log('Created ../frontend/public/models/kurkure_pouch.obj with ' + obj.length + ' bytes');
