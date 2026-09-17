const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function convertObj(objPath, textJsonPath, binaryJsonPath) {
  console.log(`Starting conversion of ${path.basename(objPath)}...`);
  
  if (!fs.existsSync(objPath)) {
    console.error(`Error: Source file does not exist at ${objPath}`);
    return;
  }

  const content = fs.readFileSync(objPath, 'utf-8');
  const lines = content.split('\n');

  const positions = [];
  const uvs = [];
  const normals = [];

  const finalPositions = [];
  const finalUvs = [];
  const finalNormals = [];

  // Map of unique vertex definitions to their index in the final arrays
  const uniqueVertices = new Map();
  const indices = [];

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const type = parts[0];

    if (type === 'v') {
      positions.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
    } else if (type === 'vt') {
      uvs.push([parseFloat(parts[1]), parseFloat(parts[2])]);
    } else if (type === 'vn') {
      normals.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
    } else if (type === 'f') {
      const faceVerts = parts.slice(1);
      const faceIndices = [];

      for (const fv of faceVerts) {
        if (!fv) continue;
        const fvParts = fv.split('/');
        
        const pIdx = parseInt(fvParts[0]) - 1;
        const uvIdx = fvParts[1] ? parseInt(fvParts[1]) - 1 : -1;
        const nIdx = fvParts[2] ? parseInt(fvParts[2]) - 1 : -1;

        const key = `${pIdx}_${uvIdx}_${nIdx}`;

        if (!uniqueVertices.has(key)) {
          const newIdx = uniqueVertices.size;
          uniqueVertices.set(key, newIdx);

          const p = positions[pIdx] || [0, 0, 0];
          finalPositions.push(
            parseFloat(p[0].toFixed(4)), 
            parseFloat(p[1].toFixed(4)), 
            parseFloat(p[2].toFixed(4))
          );

          const uv = uvIdx !== -1 ? (uvs[uvIdx] || [0, 0]) : [0, 0];
          finalUvs.push(
            parseFloat(uv[0].toFixed(4)), 
            parseFloat(uv[1].toFixed(4))
          );

          const n = nIdx !== -1 ? (normals[nIdx] || [0, 0, 1]) : [0, 0, 1];
          finalNormals.push(
            parseFloat(n[0].toFixed(4)), 
            parseFloat(n[1].toFixed(4)), 
            parseFloat(n[2].toFixed(4))
          );

          faceIndices.push(newIdx);
        } else {
          faceIndices.push(uniqueVertices.get(key));
        }
      }

      for (let j = 1; j < faceIndices.length - 1; j++) {
        indices.push(faceIndices[0], faceIndices[j], faceIndices[j + 1]);
      }
    }
  }

  // 1. Text JSON Representation
  const textOutput = {
    positions: finalPositions,
    uvs: finalUvs,
    normals: finalNormals,
    indices: indices
  };

  const textJsonStr = JSON.stringify(textOutput);
  fs.writeFileSync(textJsonPath, textJsonStr);

  // 2. Binary Base64 Packed JSON Representation
  const posBuffer = Buffer.from(new Float32Array(finalPositions).buffer);
  const uvBuffer = Buffer.from(new Float32Array(finalUvs).buffer);
  const normBuffer = Buffer.from(new Float32Array(finalNormals).buffer);
  const idxBuffer = Buffer.from(new Uint32Array(indices).buffer);

  const binaryOutput = {
    packed: true,
    positions: posBuffer.toString('base64'),
    uvs: uvBuffer.toString('base64'),
    normals: normBuffer.toString('base64'),
    indices: idxBuffer.toString('base64')
  };

  const binaryJsonStr = JSON.stringify(binaryOutput);
  fs.writeFileSync(binaryJsonPath, binaryJsonStr);

  // Compression measurements
  const gzippedText = zlib.gzipSync(Buffer.from(textJsonStr));
  const gzippedBinary = zlib.gzipSync(Buffer.from(binaryJsonStr));
  
  const objSize = fs.statSync(objPath).size;
  const textJsonSize = fs.statSync(textJsonPath).size;
  const binaryJsonSize = fs.statSync(binaryJsonPath).size;
  const textGzipSize = gzippedText.length;
  const binaryGzipSize = gzippedBinary.length;

  console.log(`\n--- Size Metrics for ${path.basename(objPath)} ---`);
  console.log(`Original OBJ File Size: ${(objSize / 1024).toFixed(2)} KB (${objSize} bytes)`);
  console.log(`Compact Text JSON Size: ${(textJsonSize / 1024).toFixed(2)} KB (${textJsonSize} bytes)`);
  console.log(`Binary Base64 JSON Size: ${(binaryJsonSize / 1024).toFixed(2)} KB (${binaryJsonSize} bytes)`);
  console.log(`Gzipped Text JSON Size: ${(textGzipSize / 1024).toFixed(2)} KB (${textGzipSize} bytes)`);
  console.log(`Gzipped Binary JSON Size: ${(binaryGzipSize / 1024).toFixed(2)} KB (${binaryGzipSize} bytes)`);
  console.log(`Binary Base64 vs Text JSON Size: -${((1 - binaryJsonSize / textJsonSize) * 100).toFixed(1)}% (raw size savings!)`);
  console.log(`Binary Base64 vs Original OBJ Size: -${((1 - binaryJsonSize / objSize) * 100).toFixed(1)}% (raw size savings!)`);
  console.log(`Binary Gzipped vs OBJ Size: -${((1 - binaryGzipSize / objSize) * 100).toFixed(1)}% (wire size savings!)`);

  return { objSize, textJsonSize, binaryJsonSize, textGzipSize, binaryGzipSize };
}

// Convert files in monorepo
const rootDir = path.resolve(__dirname, '..');
const objFile = path.join(rootDir, 'public', '3_gusset_zipper_pouch.obj');
const textJsonFile = path.join(rootDir, 'public', '3_gusset_zipper_pouch.json');
const binaryJsonFile = path.join(rootDir, 'public', '3_gusset_zipper_pouch.bin.json');

convertObj(objFile, textJsonFile, binaryJsonFile);

const kurkureObj = path.join(rootDir, 'public', 'kurkure_pouch.obj');
const kurkureTextJson = path.join(rootDir, 'public', 'kurkure_pouch.json');
const kurkureBinaryJson = path.join(rootDir, 'public', 'kurkure_pouch.bin.json');
if (fs.existsSync(kurkureObj)) {
  convertObj(kurkureObj, kurkureTextJson, kurkureBinaryJson);
}
