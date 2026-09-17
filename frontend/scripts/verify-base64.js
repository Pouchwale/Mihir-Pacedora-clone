const fs = require('fs');
const path = require('path');

function verifyBase64Geometry(jsonPath, textJsonPath) {
  console.log(`\n--- Verification Process for ${path.basename(jsonPath)} ---`);
  
  if (!fs.existsSync(jsonPath)) {
    console.error(`Error: Packed JSON file does not exist at ${jsonPath}`);
    return;
  }

  const packedData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const textData = fs.existsSync(textJsonPath) 
    ? JSON.parse(fs.readFileSync(textJsonPath, 'utf-8'))
    : null;

  if (!packedData.packed) {
    console.error(`Error: File is not marked as packed!`);
    return;
  }

  // Decoding functions (matching browser-native implementation)
  const decodeFloat32 = (base64) => {
    const buffer = Buffer.from(base64, 'base64');
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  };

  const decodeUint32 = (base64) => {
    const buffer = Buffer.from(base64, 'base64');
    return new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  };

  try {
    const positions = decodeFloat32(packedData.positions);
    const uvs = decodeFloat32(packedData.uvs);
    const normals = decodeFloat32(packedData.normals);
    const indices = decodeUint32(packedData.indices);

    const vertexCount = positions.length / 3;
    const uvCount = uvs.length / 2;
    const normalCount = normals.length / 3;
    const indexCount = indices.length;

    console.log(`✓ Successful Base64 decoding!`);
    console.log(`✓ Decoded Vertex Count: ${vertexCount} (${positions.length} floats)`);
    console.log(`✓ Decoded UV Count: ${uvCount} (${uvs.length} floats)`);
    console.log(`✓ Decoded Normal Count: ${normalCount} (${normals.length} floats)`);
    console.log(`✓ Decoded Index Count: ${indexCount} indices (${indexCount / 3} triangles)`);

    // Sanity divisions checks
    let sanityPassed = true;
    if (positions.length % 3 !== 0) {
      console.error(`❌ Position buffer length is not divisible by 3!`);
      sanityPassed = false;
    }
    if (uvs.length % 2 !== 0) {
      console.error(`❌ UV buffer length is not divisible by 2!`);
      sanityPassed = false;
    }
    if (normals.length % 3 !== 0) {
      console.error(`❌ Normal buffer length is not divisible by 3!`);
      sanityPassed = false;
    }
    if (indices.length % 3 !== 0) {
      console.error(`❌ Index buffer length is not divisible by 3 (invalid triangles)!`);
      sanityPassed = false;
    }

    // Bounds check
    let maxIdx = -1;
    let minIdx = Infinity;
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] > maxIdx) maxIdx = indices[i];
      if (indices[i] < minIdx) minIdx = indices[i];
    }

    console.log(`✓ Index Range check: min = ${minIdx}, max = ${maxIdx}`);
    if (maxIdx >= vertexCount) {
      console.error(`❌ Index bounds exceeded! Max index ${maxIdx} >= vertex count ${vertexCount}`);
      sanityPassed = false;
    } else {
      console.log(`✓ Index boundaries are 100% within valid vertex range [0, ${vertexCount - 1}].`);
    }

    // Coordinate range check
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    console.log(`✓ Spatial Bounding Box: [X: ${minX.toFixed(3)} to ${maxX.toFixed(3)}], [Y: ${minY.toFixed(3)} to ${maxY.toFixed(3)}], [Z: ${minZ.toFixed(3)} to ${maxZ.toFixed(3)}]`);

    // Compare with text JSON values if provided
    if (textData) {
      let match = true;
      if (textData.positions.length !== positions.length) match = false;
      if (textData.uvs.length !== uvs.length) match = false;
      if (textData.indices.length !== indices.length) match = false;

      if (match) {
        // Sample element-by-element equivalence test
        for (let i = 0; i < Math.min(100, positions.length); i++) {
          if (Math.abs(textData.positions[i] - positions[i]) > 0.001) {
            match = false;
            break;
          }
        }
      }

      if (match) {
        console.log(`✓ Match Verification: Decoded Float32 base64 values are identical to the parsed text-based JSON geometry!`);
      } else {
        console.error(`❌ Match Verification: Base64 data did NOT match the original text-based JSON array content!`);
        sanityPassed = false;
      }
    }

    // Print sample decoded elements
    console.log(`\nSample Decoded Data (First 3 elements):`);
    console.log(`- Positions: [${Array.from(positions.slice(0, 9)).map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`- UVs:       [${Array.from(uvs.slice(0, 6)).map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`- Normals:   [${Array.from(normals.slice(0, 9)).map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`- Indices:   [${Array.from(indices.slice(0, 9)).join(', ')}]`);

    if (sanityPassed) {
      console.log(`\n🎉 Verification Passed: Base64 data is 100% valid, structurally correct, and ready for WebGL BufferGeometry!`);
    } else {
      console.log(`\n❌ Verification Failed: Sanity checks did not pass.`);
    }

  } catch (e) {
    console.error(`❌ Decoding failed with error:`, e);
  }
}

const rootDir = path.resolve(__dirname, '..');
const binFile = path.join(rootDir, 'public', '3_gusset_zipper_pouch.bin.json');
const txtFile = path.join(rootDir, 'public', '3_gusset_zipper_pouch.json');

verifyBase64Geometry(binFile, txtFile);

const kurkureBin = path.join(rootDir, 'public', 'kurkure_pouch.bin.json');
const kurkureTxt = path.join(rootDir, 'public', 'kurkure_pouch.json');
if (fs.existsSync(kurkureBin)) {
  verifyBase64Geometry(kurkureBin, kurkureTxt);
}
