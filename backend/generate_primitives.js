const fs = require('fs');

function createBoxObj() {
  return `v -0.5 -1.0 0.5
v 0.5 -1.0 0.5
v -0.5 1.0 0.5
v 0.5 1.0 0.5
v -0.5 -1.0 -0.5
v 0.5 -1.0 -0.5
v -0.5 1.0 -0.5
v 0.5 1.0 -0.5
vt 0 0
vt 1 0
vt 0 1
vt 1 1
f 1/1 2/2 4/4 3/3
f 6/1 5/2 7/4 8/3
f 3/1 4/2 8/4 7/3
f 5/1 6/2 2/4 1/3
f 2/1 6/2 8/4 4/3
f 5/1 1/2 3/4 7/3
`;
}

function createCylinderObj() {
  const radius = 0.4;
  const height = 2.0;
  const segments = 32;
  let obj = '';
  const verts = [];
  const uvArr = [];

  // Bottom ring + top ring
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    verts.push([x, -height / 2, z]);
    verts.push([x, height / 2, z]);
    uvArr.push([i / segments, 0]);
    uvArr.push([i / segments, 1]);
  }

  for (const v of verts) {
    obj += 'v ' + v[0].toFixed(4) + ' ' + v[1].toFixed(4) + ' ' + v[2].toFixed(4) + '\n';
  }
  for (const uv of uvArr) {
    obj += 'vt ' + uv[0].toFixed(4) + ' ' + uv[1].toFixed(4) + '\n';
  }

  for (let i = 0; i < segments; i++) {
    const bl = i * 2 + 1;
    const tl = bl + 1;
    const br = bl + 2;
    const tr = tl + 2;
    obj += 'f ' + bl + '/' + bl + ' ' + br + '/' + br + ' ' + tr + '/' + tr + ' ' + tl + '/' + tl + '\n';
  }

  return obj;
}

function createStandUpPouchObj() {
  const width = 1.0;
  const height = 1.4;
  const depth = 0.35;
  const resX = 24;
  const resY = 36;
  let obj = '';
  const verts = [];
  const uvs = [];

  // Front face
  for (let iy = 0; iy <= resY; iy++) {
    const v = iy / resY;
    const y = (v - 0.5) * height;
    const yFactor = Math.pow(Math.cos((v - 0.5) * Math.PI), 1.5);
    // Stand-up pouch has wider bottom
    const widthMod = 1.0 + (1.0 - v) * 0.15;

    for (let ix = 0; ix <= resX; ix++) {
      const u = ix / resX;
      const x = (u - 0.5) * width * widthMod;
      const xBulge = Math.cos((u - 0.5) * Math.PI);
      const z = xBulge * yFactor * depth;
      verts.push([x, y, z]);
      uvs.push([u, v]);
    }
  }

  // Back face
  for (let iy = 0; iy <= resY; iy++) {
    const v = iy / resY;
    const y = (v - 0.5) * height;
    const yFactor = Math.pow(Math.cos((v - 0.5) * Math.PI), 1.5);
    const widthMod = 1.0 + (1.0 - v) * 0.15;

    for (let ix = 0; ix <= resX; ix++) {
      const u = ix / resX;
      const x = (u - 0.5) * width * widthMod;
      const xBulge = Math.cos((u - 0.5) * Math.PI);
      const z = -(xBulge * yFactor * depth);
      verts.push([x, y, z]);
      uvs.push([1 - u, v]);
    }
  }

  for (const [x, y, z] of verts) {
    obj += 'v ' + x.toFixed(4) + ' ' + y.toFixed(4) + ' ' + z.toFixed(4) + '\n';
  }
  for (const [u, v] of uvs) {
    obj += 'vt ' + u.toFixed(4) + ' ' + v.toFixed(4) + '\n';
  }

  const vertsPerFace = resX + 1;

  // Front faces
  for (let iy = 0; iy < resY; iy++) {
    for (let ix = 0; ix < resX; ix++) {
      const tl = iy * vertsPerFace + ix + 1;
      const tr = tl + 1;
      const bl = (iy + 1) * vertsPerFace + ix + 1;
      const br = bl + 1;
      obj += 'f ' + tl + '/' + tl + ' ' + bl + '/' + bl + ' ' + tr + '/' + tr + '\n';
      obj += 'f ' + tr + '/' + tr + ' ' + bl + '/' + bl + ' ' + br + '/' + br + '\n';
    }
  }

  // Back faces
  const backOffset = (resY + 1) * vertsPerFace;
  for (let iy = 0; iy < resY; iy++) {
    for (let ix = 0; ix < resX; ix++) {
      const tl = backOffset + iy * vertsPerFace + ix + 1;
      const tr = tl + 1;
      const bl = backOffset + (iy + 1) * vertsPerFace + ix + 1;
      const br = bl + 1;
      obj += 'f ' + tl + '/' + tl + ' ' + tr + '/' + tr + ' ' + bl + '/' + bl + '\n';
      obj += 'f ' + tr + '/' + tr + ' ' + br + '/' + br + ' ' + bl + '/' + bl + '\n';
    }
  }

  // Left edge stitching
  for (let iy = 0; iy < resY; iy++) {
    const fTop = iy * vertsPerFace + 1;
    const fBot = (iy + 1) * vertsPerFace + 1;
    const bTop = backOffset + iy * vertsPerFace + 1;
    const bBot = backOffset + (iy + 1) * vertsPerFace + 1;
    obj += 'f ' + fTop + '/' + fTop + ' ' + bTop + '/' + bTop + ' ' + fBot + '/' + fBot + '\n';
    obj += 'f ' + bTop + '/' + bTop + ' ' + bBot + '/' + bBot + ' ' + fBot + '/' + fBot + '\n';
  }

  // Right edge stitching
  for (let iy = 0; iy < resY; iy++) {
    const fTop = iy * vertsPerFace + resX + 1;
    const fBot = (iy + 1) * vertsPerFace + resX + 1;
    const bTop = backOffset + iy * vertsPerFace + resX + 1;
    const bBot = backOffset + (iy + 1) * vertsPerFace + resX + 1;
    obj += 'f ' + fTop + '/' + fTop + ' ' + fBot + '/' + fBot + ' ' + bTop + '/' + bTop + '\n';
    obj += 'f ' + bTop + '/' + bTop + ' ' + fBot + '/' + fBot + ' ' + bBot + '/' + bBot + '\n';
  }

  return obj;
}

fs.writeFileSync('../frontend/public/models/box.obj', createBoxObj());
console.log('Created box.obj');

fs.writeFileSync('../frontend/public/models/cylinder.obj', createCylinderObj());
console.log('Created cylinder.obj');

fs.writeFileSync('../frontend/public/models/standup_pouch.obj', createStandUpPouchObj());
console.log('Created standup_pouch.obj');
