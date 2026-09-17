import * as THREE from 'three';
import { OBJLoader, GLTFLoader, ColladaLoader, mergeBufferGeometries, mergeVertices } from 'three-stdlib';

export interface ParseResult {
  geometry: THREE.BufferGeometry;
  detectedSides: string[];
  gltfScene?: THREE.Group;
  animations?: THREE.AnimationClip[];
}

type Side = 'Front' | 'Back' | 'Left' | 'Right' | 'Top' | 'Bottom';
const SIDE_ORDER: Side[] = ['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom'];
const SIDE_MAT_INDEX: Record<Side, number> = { Front: 0, Back: 1, Left: 2, Right: 3, Top: 4, Bottom: 5 };

function safeDecodeBase64(base64: string): string {
  let cleanStr = base64.replace(/\s+/g, '');
  if (cleanStr.includes('%')) {
    try { cleanStr = decodeURIComponent(cleanStr); } catch (e) {}
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(cleanStr)) {
    return cleanStr; // Fallback to raw if not base64 characters
  }
  // Pad if necessary
  while (cleanStr.length % 4 !== 0) {
    cleanStr += '=';
  }
  try {
    return atob(cleanStr);
  } catch (e) {
    console.warn("atob failed. Returning raw string.");
    return cleanStr;
  }
}

// Helper: Convert Base64 Data URL to ArrayBuffer
function dataURLToArrayBuffer(dataURL: string): ArrayBuffer {
  const parts = dataURL.split(',');
  const base64 = parts.length > 1 ? parts[1] : parts[0];
  const binaryString = safeDecodeBase64(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// Helper: Convert Base64 string directly to Float32Array
function base64ToFloat32Array(base64: string): Float32Array {
  const binaryString = safeDecodeBase64(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

// Helper: Convert Base64 string directly to Uint32Array
function base64ToUint32Array(base64: string): Uint32Array {
  const binaryString = safeDecodeBase64(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Uint32Array(bytes.buffer);
}

// Unified processor: Takes a loaded 3D Group/Scene and extracts/classifies its geometry
function processGroup(
  group: THREE.Group | THREE.Object3D, 
  fileName?: string,
  gltfScene?: THREE.Group,
  animations?: THREE.AnimationClip[]
): ParseResult {
  // 1. Collect ALL meshes and merge them into one geometry, recording their side names
  const geometries: THREE.BufferGeometry[] = [];
  const meshSides: { start: number; count: number; side?: Side }[] = [];
  let currentVertCount = 0;
  let hasAutoUnwrappedData = false;

  group.updateMatrixWorld(true);

  // Models saved by earlier versions of the custom-preset exporter wrote every side part with the
  // WHOLE pouch (same vertex data, no index). Drawing those copies on top of each other hid the
  // artwork of all but the last side. Keep one copy and classify its triangles by direction instead.
  const positionUses = new Map<THREE.BufferAttribute | THREE.InterleavedBufferAttribute, number>();
  group.traverse((child) => {
    const geom = (child as THREE.Mesh).isMesh ? (child as THREE.Mesh).geometry : null;
    if (geom && !geom.index && geom.attributes.position) {
      const attr = geom.attributes.position;
      positionUses.set(attr, (positionUses.get(attr) || 0) + 1);
    }
  });
  const duplicatedSideCopies = new Set(
    Array.from(positionUses.entries()).filter(([, uses]) => uses > 1).map(([attr]) => attr)
  );
  const keptDuplicate = new Set<unknown>();
  // The broken exports kept the original shape in the mesh name (e.g. "standup_pouch"); use it so
  // the repaired model gets the same sides as when it was created.
  let shapeHint = '';
  if (duplicatedSideCopies.size > 0) {
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child.name) shapeHint += ' ' + child.name;
      if (child.parent?.name) shapeHint += ' ' + child.parent.name;
    });
  }
  const shapeName = `${fileName || ''}${shapeHint}`;

  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      if (mesh.userData?.isAutoUnwrapped) {
        hasAutoUnwrappedData = true;
      }
      const sharedPosition = mesh.geometry?.index ? null : mesh.geometry?.attributes.position;
      const isDuplicateCopy = !!sharedPosition && duplicatedSideCopies.has(sharedPosition);
      if (isDuplicateCopy && keptDuplicate.has(sharedPosition)) {
        return; // skip the extra full copies
      }
      if (isDuplicateCopy) keptDuplicate.add(sharedPosition);
      if (mesh.geometry) {
        const clonedGeom = mesh.geometry.clone();
        clonedGeom.applyMatrix4(mesh.matrixWorld);
        
        if (!clonedGeom.attributes.normal) {
          clonedGeom.computeVertexNormals();
        }
        
        const niGeom = clonedGeom.index ? clonedGeom.toNonIndexed() : clonedGeom;

        let side: Side | undefined;
        const name = (mesh.name || '').toLowerCase();
        const parentName = (mesh.parent?.name || '').toLowerCase();
        
        let materialName = '';
        if (mesh.material) {
          if (Array.isArray(mesh.material)) {
            materialName = mesh.material.map(m => m.name).join(' ').toLowerCase();
          } else {
            materialName = (mesh.material.name || '').toLowerCase();
          }
        }

        niGeom.computeBoundingBox();
        const meshCenter = new THREE.Vector3();
        if (niGeom.boundingBox) {
          niGeom.boundingBox.getCenter(meshCenter);
        }

        if (name.includes('front') || parentName.includes('front') || materialName.includes('front')) side = 'Front';
        else if (name.includes('back') || parentName.includes('back') || materialName.includes('back')) side = 'Back';
        else if (name.includes('left') || parentName.includes('left') || materialName.includes('left')) side = 'Left';
        else if (name.includes('right') || parentName.includes('right') || materialName.includes('right')) side = 'Right';
        else if (name.includes('top') || name.includes('seal') || parentName.includes('top') || parentName.includes('seal') || materialName.includes('top')) side = 'Top';
        else if (name.includes('bottom') || parentName.includes('bottom') || materialName.includes('bottom')) side = 'Bottom';
        else if (name.includes('盖子') || name.includes('cap') || name.includes('lid')) side = 'Top';
        else if (name.includes('gusset') || parentName.includes('gusset')) {
          side = meshCenter.x > 0 ? 'Right' : 'Left';
        }
        // A kept copy of a duplicated model covers every side: let triangle directions decide
        if (isDuplicateCopy) side = undefined;

        const count = niGeom.attributes.position.count;
        geometries.push(niGeom);
        meshSides.push({
          start: currentVertCount,
          count: count,
          side: side
        });
        currentVertCount += count;
      }
    }
  });

  if (geometries.length === 0) {
    throw new Error("No mesh found in the 3D model");
  }

  let rawGeo = geometries[0];
  if (geometries.length > 1) {
    const merged = mergeBufferGeometries(geometries, false);
    if (merged) rawGeo = merged;
  }

  // 2. Center the geometry at origin (Y sits on the floor)
  rawGeo.computeBoundingBox();
  const center = new THREE.Vector3();
  rawGeo.boundingBox!.getCenter(center);
  const minY = rawGeo.boundingBox!.min.y;
  rawGeo.translate(-center.x, -minY, -center.z);
  rawGeo.computeBoundingBox();

  if (!rawGeo.attributes.normal) {
    rawGeo.computeVertexNormals();
  }

  // 3. Convert to NON-INDEXED geometry so every triangle owns its own vertices.
  const niGeo = rawGeo.index ? rawGeo.toNonIndexed() : rawGeo.clone();
  niGeo.computeBoundingBox();

  const pos = niGeo.attributes.position;
  const triCount = pos.count / 3;

  // 4. Classify every triangle into a side group
  const triSide: Side[] = new Array(triCount);
  const sideCounts: Record<Side, number> = { Front: 0, Back: 0, Left: 0, Right: 0, Top: 0, Bottom: 0 };

  const shape = shapeName.toLowerCase();
  const isStandUpPouch = shape.includes('stander') || shape.includes('standup');

  const isZipperPouch =
    shape.includes('zipper') ||
    shape.includes('3_gusset') ||
    shape.includes('3 gusset') ||
    shape.includes('two side gusset') ||
    shape.includes('two_side_gusset') ||
    shape.includes('kurkure');

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();

  const bb = niGeo.boundingBox!;
  const modelHeight = bb.max.y - bb.min.y;
  const modelMinY = bb.min.y;

  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    let preassignedSide: Side | undefined;
    for (const ms of meshSides) {
      if (i >= ms.start && i < ms.start + ms.count) {
        preassignedSide = ms.side;
        break;
      }
    }

    vA.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    vB.set(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
    vC.set(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));

    cb.subVectors(vC, vB);
    ab.subVectors(vA, vB);
    const faceNormal = cb.cross(ab).normalize();

    let smoothNormal = faceNormal;
    if (niGeo.attributes.normal) {
      const normAttr = niGeo.attributes.normal;
      const nA = new THREE.Vector3(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
      const nB = new THREE.Vector3(normAttr.getX(i + 1), normAttr.getY(i + 1), normAttr.getZ(i + 1));
      const nC = new THREE.Vector3(normAttr.getX(i + 2), normAttr.getY(i + 2), normAttr.getZ(i + 2));
      smoothNormal = new THREE.Vector3().addVectors(nA, nB).add(nC).normalize();
    }

    const nx = Math.abs(smoothNormal.x);
    const ny = Math.abs(smoothNormal.y);
    const nz = Math.abs(smoothNormal.z);

    let side: Side;
    if (preassignedSide) {
      side = preassignedSide;
      if (isZipperPouch && side === 'Top') {
        side = smoothNormal.z >= 0 ? 'Front' : 'Back';
      }
    } else {
      if (isStandUpPouch) {
        // Stand-Up Pouch has exactly 3 sides: Front, Back, Bottom
        const centerY = (vA.y + vB.y + vC.y) / 3;
        const centerX = (vA.x + vB.x + vC.x) / 3;
        const centerZ = (vA.z + vB.z + vC.z) / 3;
        const relativeY = modelHeight > 0 ? (centerY - modelMinY) / modelHeight : 0;
        
        let threshold = -0.5; // strict threshold for main body to avoid Front bulges
        if (relativeY < 0.08) {
          threshold = -0.24; // Precision threshold to eliminate front starburst
        }

        // Detect inner cavity walls (normals pointing towards the vertical center axis)
        const dotCenter = (centerX * smoothNormal.x) + (centerZ * smoothNormal.z);
        const isInnerWall = dotCenter < -0.001;
        
        if (smoothNormal.y < threshold || (relativeY < 0.15 && isInnerWall)) {
          side = 'Bottom';
        } else {
          side = smoothNormal.z >= 0 ? 'Front' : 'Back';
        }
      } else if (isZipperPouch) {
        // Zipper Pouch / Gusset Pouches
        const centerX = (vA.x + vB.x + vC.x) / 3;
        const modelCenterX = (bb.min.x + bb.max.x) / 2;
        
        if (ny > nx && ny > nz && smoothNormal.y < 0) {
          side = 'Bottom';
        } else if (nx > nz * 0.08) {
          side = centerX > modelCenterX ? 'Right' : 'Left';
        } else {
          side = smoothNormal.z >= 0 ? 'Front' : 'Back';
        }
      } else {
        // Classify by DOMINANT normal axis
        if (ny > nx && ny > nz) {
          side = smoothNormal.y > 0 ? 'Top' : 'Bottom';
        } else if (nx > nz) {
          side = smoothNormal.x > 0 ? 'Right' : 'Left';
        } else {
          side = smoothNormal.z >= 0 ? 'Front' : 'Back';
        }
      }
    }

    triSide[t] = side;
    sideCounts[side]++;
  }

  // Enforce explicit sides for specific built-in presets
  const lowerName = shapeName.toLowerCase().replace(/_/g, ' ');
  let allowedSides: Side[] | null = null;
  
  if (lowerName.includes("3 gusset") || lowerName.includes("3_gusset") || lowerName.includes("kurkure")) {
    allowedSides = ["Front", "Back", "Left", "Right", "Bottom"];
  } else if (lowerName.includes("two side gusset") || lowerName.includes("two_side_gusset")) {
    allowedSides = ["Front", "Back", "Left", "Right"];
  } else if (lowerName.includes("center spout")) {
    allowedSides = ["Front", "Back", "Bottom", "Top"];
  } else if (lowerName.includes("center seal")) {
    allowedSides = ["Front", "Back"];
  } else if (lowerName.includes("corner spout")) {
    allowedSides = ["Front", "Back", "Bottom", "Top"];
  } else if (lowerName.includes("chocolate bar") || lowerName.includes("chocolate")) {
    allowedSides = ["Front", "Back"];
  } else if (lowerName.includes("stander pouch") || lowerName.includes("standup")) {
    allowedSides = ["Front", "Back", "Bottom"];
  } else if (lowerName.includes("three side seal") || lowerName.includes("three_side")) {
    allowedSides = ["Front", "Back"];
  }

  if (allowedSides) {
    for (let t = 0; t < triCount; t++) {
      if (!allowedSides.includes(triSide[t])) {
        const s = triSide[t];
        sideCounts[s]--;
        
        // Fallback extraneous sides to Front/Back
        const i = t * 3;
        vA.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        vB.set(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
        vC.set(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
        cb.subVectors(vC, vB);
        ab.subVectors(vA, vB);
        const faceNormal = cb.cross(ab).normalize();
        
        let smoothNormal = faceNormal;
        if (niGeo.attributes.normal) {
          const normAttr = niGeo.attributes.normal;
          const nA = new THREE.Vector3(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
          const nB = new THREE.Vector3(normAttr.getX(i + 1), normAttr.getY(i + 1), normAttr.getZ(i + 1));
          const nC = new THREE.Vector3(normAttr.getX(i + 2), normAttr.getY(i + 2), normAttr.getZ(i + 2));
          smoothNormal = new THREE.Vector3().addVectors(nA, nB).add(nC).normalize();
        }
        
        const nxFallback = Math.abs(smoothNormal.x);
        const nzFallback = Math.abs(smoothNormal.z);
        let target: Side = smoothNormal.z >= 0 ? 'Front' : 'Back';
        if (allowedSides.includes('Left') && allowedSides.includes('Right') && nxFallback > nzFallback * 0.08) {
          target = smoothNormal.x > 0 ? 'Right' : 'Left';
        } else if (!allowedSides.includes(target)) {
          target = allowedSides[0]; // Absolute fallback if Front/Back also not allowed
        }
        triSide[t] = target;
        sideCounts[target]++;
      }
    }
  }

  // 5. Removed aggressive merging of small groups to ensure custom uploaded models retain all detected sides.

  // 6. Sort triangles so each side's triangles are contiguous
  const sortedTriOrder: number[] = [];
  const groupInfo: { side: Side; start: number; count: number }[] = [];

  for (const side of SIDE_ORDER) {
    if (sideCounts[side] === 0) continue;
    const startTri = sortedTriOrder.length;
    for (let t = 0; t < triCount; t++) {
      if (triSide[t] === side) {
        sortedTriOrder.push(t);
      }
    }
    const numTris = sortedTriOrder.length - startTri;
    groupInfo.push({ side, start: startTri * 3, count: numTris * 3 });
  }

  // 7. Build the final geometry with reordered vertices and fresh per-group UVs
  const totalVerts = pos.count;
  const finalPositions = new Float32Array(totalVerts * 3);
  const finalUVs = new Float32Array(totalVerts * 2);
  const finalNormals = new Float32Array(totalVerts * 3);
  const uvAttr = niGeo.attributes.uv;
  const normAttr = niGeo.attributes.normal;

  // Copy vertex positions in sorted-group order
  for (let i = 0; i < sortedTriOrder.length; i++) {
    const srcTri = sortedTriOrder[i];
    for (let v = 0; v < 3; v++) {
      const srcIdx = srcTri * 3 + v;
      const dstIdx = i * 3 + v;
      finalPositions[dstIdx * 3] = pos.getX(srcIdx);
      finalPositions[dstIdx * 3 + 1] = pos.getY(srcIdx);
      finalPositions[dstIdx * 3 + 2] = pos.getZ(srcIdx);

      if (uvAttr) {
        finalUVs[dstIdx * 2] = uvAttr.getX(srcIdx);
        finalUVs[dstIdx * 2 + 1] = uvAttr.getY(srcIdx);
      }
      if (normAttr) {
        finalNormals[dstIdx * 3] = normAttr.getX(srcIdx);
        finalNormals[dstIdx * 3 + 1] = normAttr.getY(srcIdx);
        finalNormals[dstIdx * 3 + 2] = normAttr.getZ(srcIdx);
      }
    }
  }

  // 8. Compute or normalize per-group UVs
  // Force 3D planar projection for all pouches/spouts to guarantee flawless edge-to-edge image mapping
  // This ignores broken/distorted original UV maps exported from Blender
  if (uvAttr && !lowerName.includes('pouch') && !lowerName.includes('spout')) {
    // If the model already has UV coordinates, KEEP THEM EXACTLY AS DEFINED but normalize them per-group to [0, 1] range
    for (const g of groupInfo) {
      let minU = Infinity, maxU = -Infinity;
      let minV = Infinity, maxV = -Infinity;

      for (let vi = g.start; vi < g.start + g.count; vi++) {
        const u = finalUVs[vi * 2];
        const v = finalUVs[vi * 2 + 1];
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      }

      const rangeU = maxU - minU || 1;
      const rangeV = maxV - minV || 1;

      for (let vi = g.start; vi < g.start + g.count; vi++) {
        const u = finalUVs[vi * 2];
        const v = finalUVs[vi * 2 + 1];
        let normU = (u - minU) / rangeU;
        let normV = (v - minV) / rangeV;
        
        // Mirror bottom side texture horizontally
        if (g.side === 'Bottom' && !hasAutoUnwrappedData) {
          normU = 1 - normU;
        }

        finalUVs[vi * 2] = normU;
        finalUVs[vi * 2 + 1] = normV;
      }
    }
  } else {
    for (const g of groupInfo) {
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;

      for (let vi = g.start; vi < g.start + g.count; vi++) {
        const px = finalPositions[vi * 3];
        const py = finalPositions[vi * 3 + 1];
        const pz = finalPositions[vi * 3 + 2];
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
      }

      const sx = maxX - minX || 1;
      const sy = maxY - minY || 1;
      const sz = maxZ - minZ || 1;

      for (let vi = g.start; vi < g.start + g.count; vi++) {
        const px = finalPositions[vi * 3];
        const py = finalPositions[vi * 3 + 1];
        const pz = finalPositions[vi * 3 + 2];

        let u: number, v: number;

        if (g.side === 'Front' || g.side === 'Back') {
          u = (px - minX) / sx;
          v = (py - minY) / sy;
          if (g.side === 'Back') u = 1 - u;
        } else if (g.side === 'Left' || g.side === 'Right') {
          u = (pz - minZ) / sz;
          v = (py - minY) / sy;
          if (g.side === 'Left') u = 1 - u;
        } else {
          u = (px - minX) / sx;
          v = (pz - minZ) / sz;
          if (g.side === 'Bottom') {
            v = 1 - v;
            u = 1 - u; // Mirror horizontally
          }
        }

        finalUVs[vi * 2] = u;
        finalUVs[vi * 2 + 1] = v;
      }
    }
  }

  // 9. Assemble the final BufferGeometry
  let finalGeo = new THREE.BufferGeometry();
  finalGeo.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
  finalGeo.setAttribute('uv', new THREE.BufferAttribute(finalUVs, 2));
  if (normAttr) {
    finalGeo.setAttribute('normal', new THREE.BufferAttribute(finalNormals, 3));
  }

  finalGeo.clearGroups();
  for (const g of groupInfo) {
    finalGeo.addGroup(g.start, g.count, SIDE_MAT_INDEX[g.side]);
  }

  if (!normAttr) {
    finalGeo.computeVertexNormals();
  }
  
  finalGeo.computeBoundingBox();

  // 10. Normalize size
  const size = new THREE.Vector3();
  finalGeo.boundingBox!.getSize(size);
  // Normalize based on height (Y) to keep all pouches visually consistent in size
  const referenceDimension = size.y > 0 ? size.y : Math.max(size.x, size.z);
  const norm = referenceDimension > 0 ? 2 / referenceDimension : 1;
  if (referenceDimension > 0) {
    finalGeo.scale(norm, norm, norm);
  }

  if (gltfScene) {
    gltfScene.scale.set(norm, norm, norm);
    gltfScene.position.set(-center.x * norm, -minY * norm, -center.z * norm);
  }

  // 11. Build detectedSides list
  let detectedSides: string[] = groupInfo.map(g => g.side);
  
  if (lowerName.includes("spout")) {
    detectedSides = detectedSides.filter(s => s !== 'Top');
  }

  return { geometry: finalGeo, detectedSides, gltfScene, animations };
}

// Synchronous OBJ parsing for complete backward compatibility
export function parseOBJ(text: string, fileName?: string): ParseResult {
  const loader = new OBJLoader();
  const group = loader.parse(text);
  return processGroup(group, fileName);
}

// Asynchronous unified model parser supporting both OBJ, GLB/GLTF, and compact JSON geometry data
export function parseModelAsync(data: string, fileName: string): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const isJson = fileName.toLowerCase().endsWith('.json') || 
                   data.trim().startsWith('{') ||
                   data.trim().startsWith('[');

    const isGlb = !isJson && (
                  fileName.toLowerCase().endsWith('.glb') || 
                  fileName.toLowerCase().endsWith('.gltf') || 
                  data.startsWith('data:'));

    const isDae = !isJson && !isGlb && (
                  fileName.toLowerCase().endsWith('.dae') || 
                  fileName.toLowerCase().endsWith('.dea'));

    if (isJson) {
      try {
        const json = JSON.parse(data);
        const geo = new THREE.BufferGeometry();
        
        if (json.packed) {
          // Decode binary Base64 strings directly to typed arrays
          if (json.positions) {
            geo.setAttribute('position', new THREE.BufferAttribute(base64ToFloat32Array(json.positions), 3));
          }
          if (json.uvs) {
            geo.setAttribute('uv', new THREE.BufferAttribute(base64ToFloat32Array(json.uvs), 2));
          }
          if (json.normals) {
            geo.setAttribute('normal', new THREE.BufferAttribute(base64ToFloat32Array(json.normals), 3));
          }
          if (json.indices) {
            geo.setIndex(new THREE.BufferAttribute(base64ToUint32Array(json.indices), 1));
          }
        } else {
          // Standard text-based float arrays
          if (json.positions) {
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(json.positions), 3));
          }
          if (json.uvs) {
            geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(json.uvs), 2));
          }
          if (json.normals) {
            geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(json.normals), 3));
          }
          if (json.indices) {
            geo.setIndex(new THREE.BufferAttribute(new Uint32Array(json.indices), 1));
          }
        }
        
        const mesh = new THREE.Mesh(geo);
        const group = new THREE.Group();
        group.add(mesh);
        
        resolve(processGroup(group, fileName));
      } catch (err) {
        reject(err);
      }
    } else if (isGlb) {
      try {
        const arrayBuffer = dataURLToArrayBuffer(data);
        const loader = new GLTFLoader();
        loader.parse(
          arrayBuffer,
          '',
          (gltf) => {
            try {
              const result = processGroup(gltf.scene, fileName, gltf.scene, gltf.animations);
              resolve(result);
            } catch (err) {
              reject(err);
            }
          },
          (err) => {
            reject(new Error("Failed to parse GLB/GLTF model"));
          }
        );
      } catch (err) {
        reject(err);
      }
    } else if (isDae) {
      try {
        const loader = new ColladaLoader();
        const collada = loader.parse(data, "");
        const result = processGroup(collada.scene, fileName);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    } else {
      try {
        resolve(parseOBJ(data, fileName));
      } catch (err) {
        reject(err);
      }
    }
  });
}

export function buildMesh(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  return geo;
}

export function generatePlaceholderPouch(): string {
  return `
v -1.0 -1.5 0.2
v 1.0 -1.5 0.2
v -1.0 1.5 0.2
v 1.0 1.5 0.2
v -1.0 -1.5 -0.2
v 1.0 -1.5 -0.2
v -1.0 1.5 -0.2
v 1.0 1.5 -0.2
vt 0 0
vt 1 0
vt 0 1
vt 1 1
f 1/1 2/2 4/4 3/3
f 3/3 4/4 8/8 7/7
f 7/7 8/8 6/6 5/5
f 5/5 6/6 2/2 1/1
f 3/3 7/7 5/5 1/1
f 2/2 6/6 8/8 4/4
  `.trim();
}
