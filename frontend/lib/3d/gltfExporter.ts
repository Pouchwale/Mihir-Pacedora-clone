import * as THREE from 'three';
import { GLTFExporter } from 'three-stdlib';
import { parseModelAsync } from './objParser';

export async function exportToGLBBase64(data: string, fileName: string): Promise<string> {
  // 1. Parse and unwrap the model
  const result = await parseModelAsync(data, fileName);

  // 2. Assign standard mask groups (materials) for every side
  const materials = [
    new THREE.MeshStandardMaterial({ name: 'Front', color: 0xffffff }),
    new THREE.MeshStandardMaterial({ name: 'Back', color: 0xffffff }),
    new THREE.MeshStandardMaterial({ name: 'Left', color: 0xffffff }),
    new THREE.MeshStandardMaterial({ name: 'Right', color: 0xffffff }),
    new THREE.MeshStandardMaterial({ name: 'Top', color: 0xffffff }),
    new THREE.MeshStandardMaterial({ name: 'Bottom', color: 0xffffff })
  ];

  // GLTFExporter writes each material group of a NON-indexed geometry as a primitive containing
  // all vertices, so every side would contain the whole model. With an index, each side becomes
  // its own primitive holding only its triangles.
  const geometry = result.geometry.clone();
  geometry.deleteAttribute('insideFace'); // editor-only; recomputed when the model is loaded
  if (!geometry.index) {
    const count = geometry.attributes.position.count;
    const index = new Uint32Array(count);
    for (let i = 0; i < count; i++) index[i] = i;
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }

  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = fileName.split('.')[0] || 'Model';
  mesh.userData.isAutoUnwrapped = true;

  // We wrap the mesh in a group to mimic standard GLTF hierarchy if necessary
  const group = new THREE.Group();
  group.add(mesh);

  const exporter = new GLTFExporter();
  const options = { binary: true };

  // 3. Export to binary GLB
  return new Promise((resolve, reject) => {
    exporter.parse(
      group,
      async (gltf) => {
        try {
          const buffer = gltf as ArrayBuffer;
          // 4. Convert ArrayBuffer to Base64 String efficiently
          const blob = new Blob([buffer], { type: 'application/octet-stream' });
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        } catch (e) {
          reject(e);
        }
      },
      (error) => reject(error),
      options
    );
  });
}
