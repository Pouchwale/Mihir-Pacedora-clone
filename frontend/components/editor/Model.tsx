import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useEditorStore } from '@/store/useEditorStore';
import { useShallow } from "zustand/react/shallow";
import { parseModelAsync, parseOBJ, generatePlaceholderPouch } from '@/lib/3d/objParser';

const SIDE_NORMALS: Record<string, THREE.Vector3> = {
  Front: new THREE.Vector3(0, 0, 1),
  Back: new THREE.Vector3(0, 0, -1),
  Left: new THREE.Vector3(-1, 0, 0),
  Right: new THREE.Vector3(1, 0, 0),
  Top: new THREE.Vector3(0, 1, 0),
  Bottom: new THREE.Vector3(0, -1, 0),
};

const MAT_INDEX_TO_SIDE: Record<number, string> = {
  0: 'Front',
  1: 'Back',
  2: 'Left',
  3: 'Right',
  4: 'Top',
  5: 'Bottom',
};

function classifyFaceNormal(normal: THREE.Vector3, detectedSides: string[], fileName?: string): string {
  const nx = Math.abs(normal.x);
  const ny = Math.abs(normal.y);
  const nz = Math.abs(normal.z);

  const hasTop = detectedSides.includes('Top');
  const hasLeftRight = detectedSides.includes('Left') || detectedSides.includes('Right');

  if (ny > nx && ny > nz) {
    if (normal.y < 0) {
      return detectedSides.includes('Bottom') ? 'Bottom' : (normal.z >= 0 ? 'Front' : 'Back');
    } else {
      if (hasTop) {
        return 'Top';
      } else {
        return normal.z >= 0 ? 'Front' : 'Back';
      }
    }
  } else if (nx > nz) {
    if (hasLeftRight) {
      return normal.x > 0 ? 'Right' : 'Left';
    } else {
      return normal.z >= 0 ? 'Front' : 'Back';
    }
  } else {
    return normal.z >= 0 ? 'Front' : 'Back';
  }
}

import { forwardRef, useImperativeHandle } from 'react';

// Resolution of the punch / corner / window alpha masks (higher = smoother cut-out edges)
const MASK_SIZE = 2048;

export type InnerLayer = 'bopp' | 'met_pet' | 'milky_white' | 'matt_pet';

// Inner lining of the pouch. When the inside can be seen (windows or clear film) it shows the chosen
// inner laminate; otherwise it keeps the default foil look.
//  - BOPP / Transparent: glossy clear laminate over the white back of the print (the inside of the
//    pouch is always visible through a window, never the background behind the pouch)
//  - Met PET: shiny silver metallised film
//  - Milky White: opaque milky-white PE
//  - Matt PET: soft frosted, partly see-through film
function innerShellProps(seeThrough: boolean, alphaMap: THREE.Texture | null, innerLayer: InnerLayer = 'bopp') {
  const cutout = (alphaTest: number) => (alphaMap ? { alphaMap, alphaTest } : {});
  if (!seeThrough) return { color: 0xcccccc, roughness: 0.3, metalness: 0.8, ...cutout(0.5) };
  switch (innerLayer) {
    case 'met_pet':
      return { color: 0xe4e7eb, roughness: 0.2, metalness: 1, ...cutout(0.5) };
    case 'milky_white':
      return { color: 0xf6f6f1, roughness: 0.65, metalness: 0, ...cutout(0.5) };
    case 'matt_pet':
      return { color: 0xd5dbe2, roughness: 1, metalness: 0.1, transparent: true, opacity: 0.8, depthWrite: false, ...cutout(0.3) };
    default:
      return { color: 0xf1f3f6, roughness: 0.12, metalness: 0.05, ...cutout(0.5) };
  }
}

// Push the lining slightly outward along the surface normal. Where two panels touch (seals, edges,
// gussets) the far panel's lining otherwise z-fights with the near panel's print and shows as dark
// streaks on the outside of the pouch.
function offsetInnerShell<T extends THREE.Material>(material: T, geometry: THREE.BufferGeometry): T {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const offset = ((geometry.boundingSphere?.radius || 1) * 0.004).toFixed(6);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n  transformed += objectNormal * ${offset};`
    );
  };
  material.customProgramCacheKey = () => `inner-shell-${offset}`;
  return material;
}

// Alpha map for a clear plastic side: printed artwork stays solid, unprinted film is only faintly
// visible, and punch holes / windows are cut out. (Refraction/transmission made the whole side
// see-through, so the dark inside of the pouch showed through the print.)
const FILM_ALPHA = { clear: 46, frosted: 150 }; // visible film where nothing is printed (~18% / ~60%)
export type FilmFinish = keyof typeof FILM_ALPHA;
function buildClearFilmAlphaMap(art: THREE.Texture | null, cutMask: THREE.Texture | null, finish: FilmFinish = 'clear'): THREE.CanvasTexture | null {
  const CLEAR_FILM_ALPHA = FILM_ALPHA[finish] ?? FILM_ALPHA.clear;
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = `rgb(${CLEAR_FILM_ALPHA},${CLEAR_FILM_ALPHA},${CLEAR_FILM_ALPHA})`;
  ctx.fillRect(0, 0, size, size);

  const artImage = (art?.userData?.inkCanvas ?? art?.image) as CanvasImageSource | undefined;
  if (artImage) {
    // White wherever the artwork has ink (its alpha), blended over the film level
    const ink = document.createElement('canvas');
    ink.width = size;
    ink.height = size;
    const inkCtx = ink.getContext('2d');
    if (inkCtx) {
      inkCtx.drawImage(artImage, 0, 0, size, size);
      inkCtx.globalCompositeOperation = 'source-in';
      inkCtx.fillStyle = '#ffffff';
      inkCtx.fillRect(0, 0, size, size);
      ctx.drawImage(ink, 0, 0);
    }
  }

  const cutImage = cutMask?.image as CanvasImageSource | undefined;
  if (cutImage) {
    // The cut mask is white where the side is solid and transparent in holes: flatten it onto black
    // and multiply, so holes and windows become fully invisible
    const cut = document.createElement('canvas');
    cut.width = size;
    cut.height = size;
    const cutCtx = cut.getContext('2d');
    if (cutCtx) {
      cutCtx.fillStyle = '#000000';
      cutCtx.fillRect(0, 0, size, size);
      cutCtx.drawImage(cutImage, 0, 0, size, size);
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(cut, 0, 0);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

// Artwork flattened onto white: unprinted (transparent) parts of the artwork would otherwise tint
// the film black
function buildFilmColorMap(art: THREE.Texture | null): THREE.CanvasTexture | null {
  const artImage = art?.image as CanvasImageSource | undefined;
  if (!artImage) return null;
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(artImage, 0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 16;
  return texture;
}

// Material settings for a clear plastic side (see buildClearFilmAlphaMap).
// Clear: glossy crystal-clear film. Frosted: soft matt, partly see-through film.
function clearFilmProps(alphaMap: THREE.Texture | null, finish: FilmFinish = 'clear', colorMap: THREE.Texture | null = null) {
  const look = finish === 'frosted'
    ? { roughness: 0.85, clearcoat: 0, clearcoatRoughness: 0.5 }
    : { roughness: 0.08, clearcoat: 1.0, clearcoatRoughness: 0.05 };
  return {
    ...look,
    ...(colorMap ? { map: colorMap, emissiveMap: colorMap } : {}),
    metalness: 0,
    transparent: true,
    alphaMap,
    alphaTest: 0.01,
    // Outside only: from inside the pouch (seen through a window) the print must not show mirrored
    side: THREE.FrontSide,
  };
}

// Hide triangles the parser marked as inner surfaces (insideFace = 1). Used when the design has
// windows or clear plastic, so looking through them shows a clear, empty inside with no artwork.
function hideInsideFaces<T extends THREE.Material>(material: T): T {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float insideFace;\nvarying float vInsideFace;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vInsideFace = insideFace;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vInsideFace;')
      .replace('#include <clipping_planes_fragment>', 'if (vInsideFace > 0.5) discard;\n#include <clipping_planes_fragment>');
  };
  material.customProgramCacheKey = () => 'hide-inside-faces';
  return material;
}

// Clear film over a window cut-out. It adds only light (reflections and highlights, stronger at
// grazing angles like real film) and never darkens or tints what is behind it, so the window stays
// fully see-through while still reading as plastic on a plain light background.
function createWindowFilm(alphaMap: THREE.Texture) {
  return new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    metalness: 0,
    roughness: 0.12,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.0,
    transparent: true,
    blending: THREE.AdditiveBlending,
    alphaMap,
    alphaTest: 0.01,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

export const Model = forwardRef<THREE.Group, { wireframe?: boolean }>(({ wireframe = false }, externalRef) => {
  const filmFinish = useEditorStore((s) => s.filmFinish) as FilmFinish;
  const innerLayer = useEditorStore((s) => s.innerLayer) as InnerLayer;
  const insideTextures = useEditorStore((s) => s.insideTextures);
  const {
    scale,
    sizeScale,
    rotation,
    materials,
    enableFloat,
    punchType,
    punchSize,
    punchPositionY,
    cornerStyles,
    cornerSizes,
    isClearPlastic,
    isOneSideClearPlastic,
    spoutSize,
    isAnimationFrozen,
    textures,
    textureTransforms,
    objText,
    fileName,
    setObjModel,
    setDetectedSides,
    detectedSides,
    activeSide,
    setActiveSide,
    setFacingSide,
    windowCutouts
  } = useEditorStore(
    useShallow((s) => ({ scale: s.scale, sizeScale: s.sizeScale, rotation: s.rotation, materials: s.materials, enableFloat: s.enableFloat, punchType: s.punchType, punchSize: s.punchSize, punchPositionY: s.punchPositionY, cornerStyles: s.cornerStyles, cornerSizes: s.cornerSizes, isClearPlastic: s.isClearPlastic, isOneSideClearPlastic: s.isOneSideClearPlastic, spoutSize: s.spoutSize, isAnimationFrozen: s.isAnimationFrozen, textures: s.textures, textureTransforms: s.textureTransforms, objText: s.objText, fileName: s.fileName, setObjModel: s.setObjModel, setDetectedSides: s.setDetectedSides, detectedSides: s.detectedSides, activeSide: s.activeSide, setActiveSide: s.setActiveSide, setFacingSide: s.setFacingSide, windowCutouts: s.windowCutouts }))
  );
  const groupRef = useRef<THREE.Group>(null);

  // Local state for the parsed model data
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [gltfScene, setGltfScene] = useState<THREE.Group | null>(null);
  const [animations, setAnimations] = useState<THREE.AnimationClip[]>([]);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);

  // Local state for HTML Canvas-based textures
  const [canvasTextures, setCanvasTextures] = useState<Record<string, THREE.CanvasTexture | null>>({
    front: null,
    back: null,
    left: null,
    right: null,
    top: null,
    bottom: null,
    overall: null,
    label: null,
  });

  useEffect(() => {
    if (!objText) {
      fetch('/models/3_gusset_zipper_pouch.obj')
        .then(res => res.text())
        .then(text => {
          // Check if objText was populated by ClientMockupEditor while we were fetching
          if (!useEditorStore.getState().objText) {
            setObjModel(text, '3 gusset Zipper Pouch');
          }
        })
        .catch(err => console.error('Failed to load default pouch', err));
    }
  }, [objText, setObjModel]);

  // Asynchronous parse model runner
  useEffect(() => {
    if (!objText) {
      setGeometry(null);
      setGltfScene(null);
      setAnimations([]);
      return;
    }

    let active = true;

    parseModelAsync(objText, fileName || 'model')
      .then((result) => {
        if (active) {
          setGeometry(result.geometry);
          setDetectedSides(result.detectedSides);
          if (result.detectedSides.length > 0 && !useEditorStore.getState().activeSide) {
            const defaultSide = result.detectedSides.includes('Front') ? 'Front' : result.detectedSides[0];
            useEditorStore.getState().setActiveSide(defaultSide);
          }
          setGltfScene(result.gltfScene || null);
          setAnimations(result.animations || []);
        }
      })
      .catch((err) => {
        console.error('Failed to parse 3D model, falling back to placeholder', err);
        try {
          const fallback = parseOBJ(generatePlaceholderPouch());
          if (active) {
            setGeometry(fallback.geometry);
            setDetectedSides(fallback.detectedSides);
            setGltfScene(null);
            setAnimations([]);
          }
        } catch (e) {
          console.error('Fallback model failed too', e);
        }
      });

    return () => {
      active = false;
    };
  }, [objText, fileName, setDetectedSides]);

  // HTML Canvas dynamic texture projection pipeline (Section 5)
  useEffect(() => {
    let active = true;

    const keys = Object.keys(textures) as Array<keyof typeof textures>;
    const promises = keys.map((key) => {
      const url = textures[key];
      if (!url) {
        return Promise.resolve({ key, texture: null });
      }

      return new Promise<{ key: string; texture: THREE.CanvasTexture | null }>((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          if (!active) return resolve({ key, texture: null });

          // The artwork is drawn (with its transforms) onto a transparent "ink" canvas first; clear and
          // frosted film read its transparency. The texture itself is backed with white so unprinted
          // parts of a PNG print white on opaque pouches.
          const inkCanvas = document.createElement('canvas');
          inkCanvas.width = Math.max(1024, img.width);
          inkCanvas.height = Math.max(1024, img.height);
          const canvas = document.createElement('canvas');
          canvas.width = inkCanvas.width;
          canvas.height = inkCanvas.height;
          const ctx = inkCanvas.getContext('2d');
          if (ctx) {
            // Get user-defined transforms
            const transform = textureTransforms[key] || { rotation: 0, flipX: false, flipY: false };

            ctx.save();

            // Move to center to apply transforms
            ctx.translate(canvas.width / 2, canvas.height / 2);

            // Apply rotation (in degrees)
            if (transform.rotation) {
              ctx.rotate((transform.rotation * Math.PI) / 180);
            }

            // Apply flips
            const scaleX = transform.flipX ? -1 : 1;
            const scaleY = transform.flipY ? -1 : 1;

            // If the model is Quad Seal Pouch, the UVs might be inverted for some sides.
            const isQuadSeal = fileName === 'two_side_gusset.obj' || fileName === 'Quad Seal Pouch' || fileName?.includes('two_side_gusset');
            const shouldFlipSystemX = isQuadSeal && (key === 'left' || key === 'right');

            ctx.scale(scaleX * (shouldFlipSystemX ? -1 : 1), scaleY);

            // Draw user uploaded image onto canvas
            ctx.drawImage(img, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);

            ctx.restore();
          }
          const baseCtx = canvas.getContext('2d');
          if (baseCtx) {
            baseCtx.fillStyle = '#ffffff';
            baseCtx.fillRect(0, 0, canvas.width, canvas.height);
            baseCtx.drawImage(inkCanvas, 0, 0);
          }

          // Create Three.js CanvasTexture from canvas
          const texture = new THREE.CanvasTexture(canvas);
          texture.userData.inkCanvas = inkCanvas;
          texture.name = key + '_texture';
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.wrapS = THREE.ClampToEdgeWrapping;
          texture.wrapT = THREE.ClampToEdgeWrapping;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.generateMipmaps = false;
          texture.anisotropy = 16;
          texture.needsUpdate = true;

          resolve({ key, texture });
        };
        img.onerror = () => {
          resolve({ key, texture: null });
        };
        img.src = url;
      });
    });

    Promise.all(promises).then((results) => {
      if (!active) return;
      setCanvasTextures((prev) => {
        const next = { ...prev };
        results.forEach((res) => {
          if (next[res.key] && next[res.key] !== res.texture) {
            next[res.key]?.dispose();
          }
          next[res.key] = res.texture;
        });
        return next;
      });
    });

    return () => {
      active = false;
    };
  }, [textures, textureTransforms, fileName]);

  // Inside-of-film artwork (from the dieline "Inside" face)
  const [insideMaps, setInsideMaps] = useState<Record<string, THREE.Texture | null>>({});
  useEffect(() => {
    let active = true;
    const entries = Object.entries(insideTextures || {});
    Promise.all(entries.map(([side, url]) => new Promise<[string, THREE.Texture | null]>((resolve) => {
      if (!url) return resolve([side, null]);
      new THREE.TextureLoader().load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16; resolve([side, t]); }, undefined, () => resolve([side, null]));
    }))).then((list) => {
      if (!active) return;
      setInsideMaps((prev) => { Object.values(prev).forEach((t) => t?.dispose()); return Object.fromEntries(list); });
    });
    return () => { active = false; };
  }, [insideTextures]);

  // Clean up canvas textures on unmount
  useEffect(() => {
    return () => {
      Object.values(canvasTextures).forEach((tex) => {
        if (tex) tex.dispose();
      });
    };
  }, [canvasTextures]);

  // Helper to draw pouch boundary path with optional corner cuts
  const drawPouchPath = (ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    // Top Left (Index 0)
    if (cornerStyles[0] === 'round') {
      const r = cornerSizes[0] * 4;
      ctx.moveTo(0, r);
      ctx.arcTo(0, 0, r, 0, r);
    } else if (cornerStyles[0] === 'angle') {
      const s = cornerSizes[0] * 4;
      ctx.moveTo(0, s);
      ctx.lineTo(s, 0);
    } else {
      ctx.moveTo(0, 0);
    }

    // Top Right (Index 1)
    if (cornerStyles[1] === 'round') {
      const r = cornerSizes[1] * 4;
      ctx.lineTo(1024 - r, 0);
      ctx.arcTo(1024, 0, 1024, r, r);
    } else if (cornerStyles[1] === 'angle') {
      const s = cornerSizes[1] * 4;
      ctx.lineTo(1024 - s, 0);
      ctx.lineTo(1024, s);
    } else {
      ctx.lineTo(1024, 0);
    }

    // Bottom Right (Index 2)
    if (cornerStyles[2] === 'round') {
      const r = cornerSizes[2] * 4;
      ctx.lineTo(1024, 1024 - r);
      ctx.arcTo(1024, 1024, 1024 - r, 1024, r);
    } else if (cornerStyles[2] === 'angle') {
      const s = cornerSizes[2] * 4;
      ctx.lineTo(1024, 1024 - s);
      ctx.lineTo(1024 - s, 1024);
    } else {
      ctx.lineTo(1024, 1024);
    }

    // Bottom Left (Index 3)
    if (cornerStyles[3] === 'round') {
      const r = cornerSizes[3] * 4;
      ctx.lineTo(r, 1024);
      ctx.arcTo(0, 1024, 0, 1024 - r, r);
    } else if (cornerStyles[3] === 'angle') {
      const s = cornerSizes[3] * 4;
      ctx.lineTo(s, 1024);
      ctx.lineTo(0, 1024 - s);
    } else {
      ctx.lineTo(0, 1024);
    }
    ctx.closePath();
  };

  // Helper to draw punch hole
  const drawPunchHole = (ctx: CanvasRenderingContext2D) => {
    const punchY = punchPositionY;
    const punchX = 512; // Center horizontally
    ctx.beginPath();
    if (punchType === 'butterfly') {
      const punchWidth = 160 * punchSize;
      const punchHeight = 32 * punchSize;
      ctx.roundRect(punchX - punchWidth/2, punchY - punchHeight/2, punchWidth, punchHeight, 16 * punchSize);
      ctx.arc(punchX, punchY - punchHeight/2, 24 * punchSize, 0, Math.PI * 2);
    } else if (punchType === 'round') {
      ctx.arc(punchX, punchY, 32 * punchSize, 0, Math.PI * 2);
    } else if (punchType === 'd-punch') {
      const punchWidth = 200 * punchSize;
      const punchHeight = 50 * punchSize;
      ctx.roundRect(punchX - punchWidth/2, punchY - punchHeight/2, punchWidth, punchHeight, punchHeight/2);
    }
    ctx.fill();
  };

  // Physical width/height of each side. Artwork and masks are stretched over these extents (UVs are
  // normalised per side), so shapes must be drawn with this aspect ratio to look right on the model.
  const sideDims = useMemo(() => {
    const dims: Record<string, { w: number; h: number }> = {};
    const pos = geometry?.getAttribute('position');
    if (!geometry || !pos) return dims;
    const sideNames = ['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom'];
    const sx = sizeScale?.[0] ?? 1, sy = sizeScale?.[1] ?? 1, sz = sizeScale?.[2] ?? 1;
    geometry.groups.forEach((g) => {
      const side = sideNames[g.materialIndex ?? 0];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = g.start; i < g.start + g.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const ex = (maxX - minX) * sx, ey = (maxY - minY) * sy, ez = (maxZ - minZ) * sz;
      if (side === 'Front' || side === 'Back') dims[side] = { w: ex, h: ey };
      else if (side === 'Left' || side === 'Right') dims[side] = { w: ez, h: ey };
      else dims[side] = { w: ex, h: ez };
    });
    return dims;
  }, [geometry, sizeScale]);

  // Helper to draw transparent window shapes. x/y are the window CENTRE in % of the side;
  // width/height are % of the side's width/height. Circles use the side's real aspect ratio.
  const drawWindows = (ctx: CanvasRenderingContext2D, sideWindows: any[], dims?: { w: number; h: number }) => {
    const aspect = dims && dims.w > 0 && dims.h > 0 ? dims.w / dims.h : 1;
    sideWindows.forEach(w => {
      const cx = (w.x / 100) * 1024;
      const cy = (w.y / 100) * 1024;
      const pw = (w.width / 100) * 1024;
      const ph = (w.height / 100) * 1024;

      ctx.beginPath();
      if (w.shape === 'circle') {
        // Diameter = width % of the side width; the same physical size vertically
        const rx = pw / 2;
        ctx.ellipse(cx, cy, rx, rx * aspect, 0, 0, Math.PI * 2);
      } else if (w.shape === 'oval') {
        ctx.ellipse(cx, cy, pw / 2, ph / 2, 0, 0, Math.PI * 2);
      } else if (w.shape === 'rounded-rect') {
        // Equal physical corner radius on both axes (elliptical in canvas space)
        const physicalW = pw, physicalH = ph / aspect;
        const r = Math.min((w.cornerRadius / 100) * Math.min(physicalW, physicalH), physicalW / 2, physicalH / 2);
        const rx = r, ry = r * aspect;
        const x0 = cx - pw / 2, y0 = cy - ph / 2, x1 = cx + pw / 2, y1 = cy + ph / 2;
        ctx.moveTo(x0 + rx, y0);
        ctx.lineTo(x1 - rx, y0);
        ctx.ellipse(x1 - rx, y0 + ry, rx, ry, 0, -Math.PI / 2, 0);
        ctx.lineTo(x1, y1 - ry);
        ctx.ellipse(x1 - rx, y1 - ry, rx, ry, 0, 0, Math.PI / 2);
        ctx.lineTo(x0 + rx, y1);
        ctx.ellipse(x0 + rx, y1 - ry, rx, ry, 0, Math.PI / 2, Math.PI);
        ctx.lineTo(x0, y0 + ry);
        ctx.ellipse(x0 + rx, y0 + ry, rx, ry, 0, Math.PI, Math.PI * 1.5);
        ctx.closePath();
      } else {
        ctx.rect(cx - pw / 2, cy - ph / 2, pw, ph);
      }
      ctx.fill();
    });
  };

  // Generate unified alpha maps per side (both base mask and window mask)
  const sideMasks = useMemo(() => {
    const sides = ['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom'];
    const masks: Record<string, { baseAlphaMap: THREE.CanvasTexture | null; windowAlphaMap: THREE.CanvasTexture | null }> = {};

    const hasPunch = punchType && punchType !== 'none';
    const hasCorner = cornerStyles.some((s: string) => s !== 'none');

    sides.forEach(side => {
      const isFrontBack = side === 'Front' || side === 'Back';
      const sideWindows = windowCutouts ? windowCutouts.filter(w => w.side === side) : [];
      const hasPunchOrCorner = isFrontBack && (hasPunch || hasCorner);
      const hasWindows = sideWindows.length > 0;

      if (!hasPunchOrCorner && !hasWindows) {
        masks[side] = { baseAlphaMap: null, windowAlphaMap: null };
        return;
      }

      let baseAlphaMap: THREE.CanvasTexture | null = null;
      let windowAlphaMap: THREE.CanvasTexture | null = null;

      // 1. Base Alpha Map (solid is white, holes/windows are transparent/black)
      const canvasBase = document.createElement('canvas');
      canvasBase.width = MASK_SIZE;
      canvasBase.height = MASK_SIZE;
      const ctxBase = canvasBase.getContext('2d');
      if (ctxBase) {
        ctxBase.scale(MASK_SIZE / 1024, MASK_SIZE / 1024);
        if (hasPunchOrCorner) {
          ctxBase.fillStyle = '#ffffff';
          drawPouchPath(ctxBase);
          ctxBase.fill();

          ctxBase.globalCompositeOperation = 'destination-out';
          drawPunchHole(ctxBase);
        } else {
          ctxBase.fillStyle = '#ffffff';
          ctxBase.fillRect(0, 0, 1024, 1024);
        }

        if (hasWindows) {
          ctxBase.globalCompositeOperation = 'destination-out';
          drawWindows(ctxBase, sideWindows, sideDims[side]);
        }

        const texBase = new THREE.CanvasTexture(canvasBase);
        texBase.minFilter = THREE.LinearFilter;
        texBase.magFilter = THREE.LinearFilter;
        texBase.generateMipmaps = false;
        texBase.anisotropy = 16;
        baseAlphaMap = texBase;
      }

      // 2. Window Alpha Map (window region is white, rest is transparent)
      if (hasWindows) {
        const canvasWin = document.createElement('canvas');
        canvasWin.width = MASK_SIZE;
        canvasWin.height = MASK_SIZE;
        const ctxWin = canvasWin.getContext('2d');
        if (ctxWin) {
          ctxWin.scale(MASK_SIZE / 1024, MASK_SIZE / 1024);
          if (hasPunchOrCorner) {
            ctxWin.fillStyle = '#ffffff';
            drawPouchPath(ctxWin);
            ctxWin.fill();

            ctxWin.globalCompositeOperation = 'source-in';
            drawWindows(ctxWin, sideWindows, sideDims[side]);

            ctxWin.globalCompositeOperation = 'destination-out';
            drawPunchHole(ctxWin);
          } else {
            ctxWin.fillStyle = '#ffffff';
            drawWindows(ctxWin, sideWindows, sideDims[side]);
          }

          const texWin = new THREE.CanvasTexture(canvasWin);
          texWin.minFilter = THREE.LinearFilter;
          texWin.magFilter = THREE.LinearFilter;
          texWin.generateMipmaps = false;
          texWin.anisotropy = 16;
          windowAlphaMap = texWin;
        }
      }

      masks[side] = { baseAlphaMap, windowAlphaMap };
    });

    return masks;
  }, [punchType, punchSize, punchPositionY, cornerStyles, cornerSizes, windowCutouts, sideDims]);

  // Sides that the Clear / Frosted add-ons turn into film. A spout model's Top is the spout and cap,
  // which stay solid plastic.
  const isSpoutModelFile = !!fileName?.toLowerCase().includes('spout');
  const isClearFilmSide = useCallback(
    (side: string) => (isClearPlastic || (isOneSideClearPlastic && side === 'Front')) && !(isSpoutModelFile && side === 'Top'),
    [isClearPlastic, isOneSideClearPlastic, isSpoutModelFile]
  );

  // Clear plastic alpha maps per side (only for sides that are clear)
  const clearFilmMaps = useMemo(() => {
    const maps: Record<string, { alpha: THREE.CanvasTexture | null; color: THREE.CanvasTexture | null }> = {};
    if (!isClearPlastic && !isOneSideClearPlastic) return maps;
    const isSpoutModel = fileName?.toLowerCase().includes('spout');
    const sideArt: Record<string, THREE.CanvasTexture | null> = {
      Front: canvasTextures.front || canvasTextures.overall,
      Back: canvasTextures.back || canvasTextures.overall,
      Left: canvasTextures.left || canvasTextures.overall,
      Right: canvasTextures.right || canvasTextures.overall,
      Top: isSpoutModel ? (canvasTextures.top || null) : (canvasTextures.top || canvasTextures.overall),
      Bottom: canvasTextures.bottom || canvasTextures.overall,
    };
    Object.keys(sideArt).forEach((side) => {
      if (isClearFilmSide(side)) {
        maps[side] = {
          alpha: buildClearFilmAlphaMap(sideArt[side], sideMasks[side]?.baseAlphaMap ?? null, filmFinish),
          color: buildFilmColorMap(sideArt[side]),
        };
      }
    });
    return maps;
  }, [isClearPlastic, isOneSideClearPlastic, canvasTextures, sideMasks, fileName, filmFinish, isClearFilmSide]);

  useEffect(() => () => {
    Object.values(clearFilmMaps).forEach((m) => { m.alpha?.dispose(); m.color?.dispose(); });
  }, [clearFilmMaps]);

  // Build Materials Array for the 6 groups [Front, Back, Left, Right, Top, Bottom]
  const meshMaterials = useMemo(() => {
    const seeThrough = isClearPlastic || isOneSideClearPlastic || Object.values(sideMasks).some((m) => m.windowAlphaMap);
    const createMat = (config: any, tex: THREE.CanvasTexture | null, isFrontBack: boolean, sideName: string) => {
      const sideMask = sideMasks[sideName];
      const isClearSide = isClearFilmSide(sideName);

      const isGlossyPlastic = (config.metalness ?? 0) < 0.25 && (config.roughness ?? 0.5) <= 0.25;
      const isGlossyMetal = (config.metalness ?? 0) >= 0.7 && (config.roughness ?? 0.5) <= 0.25;
      const effectiveClearcoat = config.clearcoat !== undefined
        ? config.clearcoat
        : isGlossyPlastic ? 1.0 : isGlossyMetal ? 0.35 : 0.0;
      const effectiveClearcoatRoughness = isGlossyPlastic ? 0.05 : 0.08;

      const matProps: any = {
        color: new THREE.Color(config.color),
        roughness: config.roughness,
        metalness: config.metalness,
        clearcoat: effectiveClearcoat,
        clearcoatRoughness: effectiveClearcoatRoughness,
        // Emissive needs a colour: glow with the artwork when present, otherwise the side colour
        emissive: tex ? new THREE.Color('#ffffff') : new THREE.Color(config.color),
        emissiveMap: tex || null,
        emissiveIntensity: config.emissive ?? 0,
        map: tex,
        transparent: (config.opacity ?? 1.0) < 1.0,
        opacity: config.opacity ?? 1.0,
        side: THREE.FrontSide,
        wireframe: false,
        flatShading: false,
      };

      if (sideMask && sideMask.baseAlphaMap) {
        matProps.alphaMap = sideMask.baseAlphaMap;
        matProps.alphaTest = 0.5;
      }

      if (isClearSide) {
        Object.assign(matProps, clearFilmProps(clearFilmMaps[sideName]?.alpha ?? null, filmFinish, clearFilmMaps[sideName]?.color ?? null));
      }

      const material = new THREE.MeshPhysicalMaterial(matProps);
      return seeThrough ? hideInsideFaces(material) : material;
    };

    // Create window overlay materials (clear plastic only in window regions)
    const createWindowMat = (sideName: string) => {
      const sideMask = sideMasks[sideName];
      if (!sideMask || !sideMask.windowAlphaMap) return null;
      return hideInsideFaces(createWindowFilm(sideMask.windowAlphaMap));
    };

    const isSpoutModel = fileName?.toLowerCase().includes('spout');

    const mats = [
      createMat(materials.Front, canvasTextures.front || canvasTextures.overall, true, 'Front'),
      createMat(materials.Back, canvasTextures.back || canvasTextures.overall, true, 'Back'),
      createMat(materials.Left, canvasTextures.left || canvasTextures.overall, false, 'Left'),
      createMat(materials.Right, canvasTextures.right || canvasTextures.overall, false, 'Right'),
      createMat(materials.Top, isSpoutModel ? (canvasTextures.top || null) : (canvasTextures.top || canvasTextures.overall), false, 'Top'),
      createMat(materials.Bottom, canvasTextures.bottom || canvasTextures.overall, false, 'Bottom'),
    ];

    // Build window overlay materials array (same 6 groups)
    const windowOverlays = [
      createWindowMat('Front'),
      createWindowMat('Back'),
      createWindowMat('Left'),
      createWindowMat('Right'),
      createWindowMat('Top'),
      createWindowMat('Bottom'),
    ];

    return { mats, windowOverlays };
  }, [materials, canvasTextures, isClearPlastic, isOneSideClearPlastic, sideMasks, clearFilmMaps, filmFinish, fileName, isClearFilmSide]);

  // Premium brand-aligned wireframe material with depth-offset to perfectly resolve any z-fighting artifacts
  const wireframeMaterial = useMemo(() => {
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color('#4f46e5'),
      wireframe: true,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  }, []);

  // Inner aluminium shell materials for OBJ models (BackSide only, per-side array)
  const innerMaterials = useMemo(() => {
    const sides = ['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom'];
    const seeThrough = isClearPlastic || isOneSideClearPlastic || Object.values(sideMasks).some((m) => m.windowAlphaMap);
    return sides.map(sideName => {
      const isClearSide = isClearFilmSide(sideName);
      if (isClearSide) {
        if (isClearPlastic) {
          // When every side is clear plastic, the inner shell renders the back film/print from the inside
          // so looking through the front shows the back panel and its printed artwork/film!
          const film = clearFilmMaps[sideName];
          const sideMask = sideMasks[sideName];
          const alphaMap = film ? film.alpha : buildClearFilmAlphaMap(null, sideMask?.baseAlphaMap ?? null, filmFinish);
          const filmProps = clearFilmProps(alphaMap, filmFinish, film?.color ?? null);
          // Inner walls of double-walled models would show the print a second time through the film
          return hideInsideFaces(new THREE.MeshPhysicalMaterial({
            ...filmProps,
            side: THREE.BackSide,
            depthWrite: false,
          }));
        }
        // When front only is clear (Clear Front / Frosted Front), front's inner shell is invisible
        // so looking into the pouch is clean and unobstructed
        return new THREE.MeshBasicMaterial({ visible: false });
      }
      const sideMask = sideMasks[sideName];
      const insideMap = insideMaps[sideName.toLowerCase()] ?? null;
      const matProps: any = {
        ...innerShellProps(seeThrough, sideMask?.baseAlphaMap ?? null, innerLayer),
        ...(insideMap ? { map: insideMap, color: 0xffffff, visible: true } : {}),
        side: THREE.BackSide,
      };
      const material = new THREE.MeshStandardMaterial(matProps);
      return geometry ? offsetInnerShell(material, geometry) : material;
    });
  }, [isClearPlastic, isOneSideClearPlastic, sideMasks, geometry, innerLayer, clearFilmMaps, filmFinish, isClearFilmSide, insideMaps]);

  // Sync materials reactively onto the loaded GLTF hierarchy child meshes (Section 2)
  useEffect(() => {
    if (!gltfScene) return;
    const seeThrough = isClearPlastic || isOneSideClearPlastic || Object.values(sideMasks).some((m) => m.windowAlphaMap);

    gltfScene.traverse((child: any) => {
      // Enable layer 1 so spotlights can exclusively illuminate the model
      child.layers.enable(1);

      if (child.isMesh && !child.userData.isInnerShell && !child.userData.isWindowOverlay) {
        const name = (child.name || '').toLowerCase();

        let materialName = '';
        if (child.material) {
          if (Array.isArray(child.material)) {
            materialName = child.material.map((m: any) => m.name).join(' ').toLowerCase();
          } else {
            materialName = (child.material.name || '').toLowerCase();
          }
        }

        let side = 'Front';
        let isSpout = false;

        if (name.includes('spout') || name.includes('cap') || name.includes('lid') || name.includes('nozzle') || materialName.includes('spout') || materialName.includes('cap') || materialName.includes('lid') || materialName.includes('plastic')) {
          isSpout = true;
        } else if (name.includes('front') || materialName.includes('front')) side = 'Front';
        else if (name.includes('back') || materialName.includes('back')) side = 'Back';
        else if (name.includes('left') || materialName.includes('left')) side = 'Left';
        else if (name.includes('right') || materialName.includes('right')) side = 'Right';
        else if (name.includes('top') || name.includes('seal') || materialName.includes('top')) side = 'Top';
        else if (name.includes('bottom') || materialName.includes('bottom')) side = 'Bottom';
        else if (name.includes('gusset') || materialName.includes('gusset')) {
          child.geometry.computeBoundingBox();
          const center = new THREE.Vector3();
          if (child.geometry.boundingBox) {
            child.geometry.boundingBox.getCenter(center);
          }
          side = center.x > 0 ? 'Right' : 'Left';
        }

        const config = (materials as any)[side] || materials.Front;
        let tex = (canvasTextures as any)[side.toLowerCase()] || canvasTextures.overall;
        let meshColor = new THREE.Color(config.color);

        // If a texture is applied, set the base color to white so it doesn't darken the image
        if (tex) {
          meshColor = new THREE.Color('#ffffff');
        }

        let meshRoughness = config.roughness;
        let meshMetalness = config.metalness;

        if (isSpout) {
           tex = null; // Do not cover spout with uploaded images
           // Attempt to preserve the original material color if present
           if (child.material && child.material.color) {
               meshColor = child.material.color.clone();
           } else {
               meshColor = new THREE.Color('#f8f9fa'); // Off-white plastic default
           }
           meshRoughness = 0.5;
           meshMetalness = 0.1;

           // Ensure original position and center are cached
           if (!child.userData.originalPosition) {
             child.userData.originalPosition = child.position.clone();
             if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
             const center = new THREE.Vector3();
             child.geometry.boundingBox.getCenter(center);
             child.userData.geometryCenter = center;
           }

           // Apply custom spout sizing (base 10mm)
           const scaleFactor = spoutSize / 10;
           child.scale.setScalar(scaleFactor);

           // Shift position to keep the spout geometry center invariant
           const center = child.userData.geometryCenter;
           const origPos = child.userData.originalPosition;

           const offset = center.clone().multiplyScalar(1 - scaleFactor);
           offset.applyQuaternion(child.quaternion);
           child.position.copy(origPos).add(offset);
        } else {
           // Reset scale and position for non-spout items in case of re-traversal
           child.scale.setScalar(1);
           if (child.userData.originalPosition) {
             child.position.copy(child.userData.originalPosition);
           }
        }
        const isGlossyPlastic = (meshMetalness ?? 0) < 0.25 && (meshRoughness ?? 0.5) <= 0.25;
        const isGlossyMetal = (meshMetalness ?? 0) >= 0.7 && (meshRoughness ?? 0.5) <= 0.25;
        const effectiveClearcoat = config.clearcoat !== undefined
          ? config.clearcoat
          : isGlossyPlastic ? 1.0 : isGlossyMetal ? 0.35 : 0.0;
        const effectiveClearcoatRoughness = isGlossyPlastic ? 0.05 : 0.08;

        const sideMask = sideMasks[side];
        const matProps: any = {
          color: meshColor,
          roughness: meshRoughness,
          metalness: meshMetalness,
          clearcoat: effectiveClearcoat,
          clearcoatRoughness: effectiveClearcoatRoughness,
          emissive: meshColor.clone(),
          emissiveMap: tex || null,
          emissiveIntensity: config.emissive ?? 0,
          map: tex || null,
          transparent: (config.opacity ?? 1.0) < 1.0,
          opacity: config.opacity ?? 1.0,
          side: THREE.FrontSide, // Default to FrontSide for standard materials
          polygonOffset: side === 'Front' || side === 'Back',
          polygonOffsetFactor: (side === 'Front' || side === 'Back') ? -1 : 0,
          polygonOffsetUnits: (side === 'Front' || side === 'Back') ? -1 : 0,
          flatShading: false,
        };

        if (sideMask && sideMask.baseAlphaMap) {
          matProps.alphaMap = sideMask.baseAlphaMap;
          matProps.alphaTest = 0.5;
        }

        // Spouts and caps stay solid plastic
        const isClear = !isSpout && isClearFilmSide(side);
        if (isClear) {
          // Spouts and other parts without artwork use the plain film level
          const film = !isSpout && tex === ((canvasTextures as any)[side.toLowerCase()] || canvasTextures.overall)
            ? clearFilmMaps[side]
            : undefined;
          const alphaMap = film ? film.alpha : buildClearFilmAlphaMap(null, sideMask?.baseAlphaMap ?? null, filmFinish);
          Object.assign(matProps, clearFilmProps(alphaMap, filmFinish, film?.color ?? null));
        }

        child.material = new THREE.MeshPhysicalMaterial(matProps);

        // Manage inner aluminium shell
        if (!isSpout) {
          let innerShell = child.children.find((c: any) => c.userData.isInnerShell);
          const insideMap = insideMaps[side.toLowerCase()] ?? null;
          const innerMatProps: any = {
            ...innerShellProps(seeThrough, sideMask?.baseAlphaMap ?? null, innerLayer),
            ...(insideMap ? { map: insideMap, color: 0xffffff, visible: true } : {}),
            side: THREE.BackSide,
          };

          if (!innerShell) {
            innerShell = new THREE.Mesh(child.geometry, offsetInnerShell(new THREE.MeshStandardMaterial(innerMatProps), child.geometry));
            innerShell.userData.isInnerShell = true;
            child.add(innerShell);
          } else {
            innerShell.material = offsetInnerShell(new THREE.MeshStandardMaterial(innerMatProps), child.geometry);
          }
          // Show inner shell only on non-clear sides
          innerShell.visible = !isClear;

          // Manage window overlay mesh
          let windowOverlay = child.children.find((c: any) => c.userData.isWindowOverlay);
          if (sideMask && sideMask.windowAlphaMap && !isClear) {
            if (!windowOverlay) {
              windowOverlay = new THREE.Mesh(child.geometry);
              windowOverlay.userData.isWindowOverlay = true;
              child.add(windowOverlay);
            }
            windowOverlay.material = createWindowFilm(sideMask.windowAlphaMap);
            windowOverlay.visible = true;
          } else if (windowOverlay) {
            windowOverlay.visible = false;
          }
        }

        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }, [gltfScene, canvasTextures, materials, isClearPlastic, isOneSideClearPlastic, spoutSize, sideMasks, clearFilmMaps, filmFinish, innerLayer, isClearFilmSide, insideMaps]);

  // GLTF AnimationMixer loop setup (Section 6)
  useEffect(() => {
    if (gltfScene && animations && animations.length > 0) {
      const mixer = new THREE.AnimationMixer(gltfScene);
      animations.forEach((clip) => {
        mixer.clipAction(clip).play();
      });
      mixerRef.current = mixer;
    } else {
      mixerRef.current = null;
    }
    return () => {
      if (mixerRef.current) {
        mixerRef.current.stopAllAction();
      }
    };
  }, [gltfScene, animations]);

  // Clean up cursor on unmount
  useEffect(() => {
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, []);

  // Raycast interaction mapping (Section 3)
  const handleMeshClick = (e: any) => {
    e.stopPropagation();

    if (!groupRef.current || !e.face) return;

    // 1. Calculate face normal in world space
    const worldNormal = e.face.normal.clone().transformDirection(e.object.matrixWorld);

    // 2. Transform world normal to group (model) space
    const invGroupMatrix = groupRef.current.matrixWorld.clone().invert();
    const modelNormal = worldNormal.clone().transformDirection(invGroupMatrix);

    // 3. Classify modelNormal into a side
    const side = classifyFaceNormal(modelNormal, detectedSides, fileName || '');

    console.log(`[Raycast] Clicked on side: ${side} at UV: (${e.uv?.x.toFixed(4)}, ${e.uv?.y.toFixed(4)})`);

    if (detectedSides.includes(side)) {
      setActiveSide(side);
    }
  };

  const handlePointerOver = (e: any) => {
    e.stopPropagation();
    document.body.style.cursor = 'pointer';
  };

  const handlePointerOut = () => {
    document.body.style.cursor = 'auto';
  };

  // Render frame update (Section 4 & 6)
  useFrame(({ clock, camera }, delta) => {
    // 1. Play GLTF animation via AnimationMixer
    if (mixerRef.current && !isAnimationFrozen) {
      mixerRef.current.update(delta);
    }

    // 2. Float animation
    if (enableFloat && !isAnimationFrozen && groupRef.current) {
      const t = clock.getElapsedTime();
      // Oscillate strictly above the floor (from 0.02 to 0.18) to prevent clipping through the grid
      groupRef.current.position.y = (Math.sin(t * 1.5) + 1) * 0.08 + 0.02;
    } else if ((!enableFloat || isAnimationFrozen) && groupRef.current) {
      groupRef.current.position.y = 0;
    }

    // 3. Camera-facing normal vector detection (auto side tracking using O(1) dot-product)
    if (groupRef.current && detectedSides.length > 0) {
      const cameraDir = new THREE.Vector3();
      camera.getWorldDirection(cameraDir);

      let mostFacingSide: string | null = null;
      let minDot = Infinity;

      for (const side of detectedSides) {
        const localNormal = SIDE_NORMALS[side];
        if (!localNormal) continue;

        const worldNormal = localNormal.clone().transformDirection(groupRef.current.matrixWorld);
        const dot = worldNormal.dot(cameraDir);
        if (dot < minDot) {
          minDot = dot;
          mostFacingSide = side;
        }
      }

      if (mostFacingSide && mostFacingSide !== useEditorStore.getState().facingSide) {
        setFacingSide(mostFacingSide);
      }
    }
  });  useImperativeHandle(externalRef, () => groupRef.current!);

  if (!geometry) return null;

  return (
    <group
      ref={groupRef}
      scale={[scale * (sizeScale?.[0] ?? 1), scale * (sizeScale?.[1] ?? 1), scale * (sizeScale?.[2] ?? 1)]}
      rotation={[rotation[0] * Math.PI / 180, rotation[1] * Math.PI / 180, rotation[2] * Math.PI / 180]}
    >
      {/* Dynamic Render: Primitive Scene graph for animated GLTF models, Mesh for static files (to use auto-UVs) */}
      {gltfScene && animations && animations.length > 0 ? (
        <primitive
          object={gltfScene}
          onClick={handleMeshClick}
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
        />
      ) : (
        <>
          {/* Inner aluminium shell (BackSide) - renders the inside of the pouch per-side */}
          <mesh geometry={geometry} material={innerMaterials} />
          {/* Outer material (FrontSide) - renders uploaded photos on outside only */}
          <mesh
            geometry={geometry}
            material={meshMaterials.mats}
            castShadow
            receiveShadow
            onClick={handleMeshClick}
            onPointerOver={handlePointerOver}
            onPointerOut={handlePointerOut}
          />
          {/* Window overlay (clear plastic in window regions) */}
          {meshMaterials.windowOverlays.some(m => m !== null) && (
            <mesh geometry={geometry} material={meshMaterials.windowOverlays.map(m => m || new THREE.MeshBasicMaterial({ visible: false }))} />
          )}
        </>
      )}

      {/* High-fidelity overlay wireframe contour grid (applied uniformly) */}
      {wireframe && (
        <mesh geometry={geometry} material={wireframeMaterial} />
      )}
    </group>
  );
});

Model.displayName = 'Model';
