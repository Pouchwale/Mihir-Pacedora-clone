import { useState, useMemo, useRef, useEffect } from 'react';
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

export const Model = forwardRef<THREE.Group, { wireframe?: boolean }>(({ wireframe = false }, externalRef) => {
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

          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1024, img.width);
          canvas.height = Math.max(1024, img.height);
          const ctx = canvas.getContext('2d');
          if (ctx) {
            // Draw base canvas color
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

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

          // Create Three.js CanvasTexture from canvas
          const texture = new THREE.CanvasTexture(canvas);
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

  // Build Materials Array for the 6 groups [Front, Back, Left, Right, Top, Bottom]
  const meshMaterials = useMemo(() => {
    const createMat = (config: any, tex: THREE.CanvasTexture | null, isFrontBack: boolean, sideName: string) => {
      const sideMask = sideMasks[sideName];
      const isClearSide = isClearPlastic || (isOneSideClearPlastic && sideName === 'Front');

      const matProps: any = {
        color: new THREE.Color(config.color),
        roughness: config.roughness,
        metalness: config.metalness,
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
        matProps.transmission = 1.0;
        matProps.ior = 1.5;
        matProps.thickness = 0.5;
        matProps.roughness = config.roughness;
        matProps.clearcoat = 1.0;
        matProps.clearcoatRoughness = 0.0;
        matProps.transparent = true;
        matProps.side = THREE.DoubleSide;
      }

      return new THREE.MeshPhysicalMaterial(matProps);
    };

    // Create window overlay materials (clear plastic only in window regions)
    const createWindowMat = (sideName: string) => {
      const sideMask = sideMasks[sideName];
      if (!sideMask || !sideMask.windowAlphaMap) return null;
      return new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        transmission: 1.0,
        ior: 1.5,
        thickness: 0.3,
        roughness: 0.05,
        clearcoat: 1.0,
        clearcoatRoughness: 0.0,
        transparent: true,
        opacity: 1.0,
        alphaMap: sideMask.windowAlphaMap,
        alphaTest: 0.01,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
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
  }, [materials, canvasTextures, punchType, cornerStyles, isClearPlastic, isOneSideClearPlastic, sideMasks]);

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
    return sides.map(sideName => {
      const isClearSide = isClearPlastic || (isOneSideClearPlastic && sideName === 'Front');
      if (isClearSide) {
        // Invisible material for clear sides — no inner shell visible
        return new THREE.MeshBasicMaterial({ visible: false });
      }
      const sideMask = sideMasks[sideName];
      const matProps: any = {
        color: 0xcccccc,
        roughness: 0.3,
        metalness: 0.8,
        side: THREE.BackSide,
      };
      if (sideMask && sideMask.baseAlphaMap) {
        matProps.alphaMap = sideMask.baseAlphaMap;
        matProps.alphaTest = 0.5;
      }
      return new THREE.MeshStandardMaterial(matProps);
    });
  }, [isClearPlastic, isOneSideClearPlastic, sideMasks]);

  // Sync materials reactively onto the loaded GLTF hierarchy child meshes (Section 2)
  useEffect(() => {
    if (!gltfScene) return;

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
        const sideMask = sideMasks[side];
        const matProps: any = {
          color: meshColor,
          roughness: meshRoughness,
          metalness: meshMetalness,
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

        const isClear = isClearPlastic || (isOneSideClearPlastic && side === 'Front');
        if (isClear) {
          matProps.transmission = 1.0;
          matProps.ior = 1.5;
          matProps.thickness = 0.5;
          matProps.roughness = meshRoughness;
          matProps.clearcoat = 1.0;
          matProps.clearcoatRoughness = 0.0;
          matProps.transparent = true;
          matProps.side = THREE.DoubleSide; // Clear plastic needs DoubleSide to render inner thickness
        }

        child.material = new THREE.MeshPhysicalMaterial(matProps);

        // Manage inner aluminium shell
        if (!isSpout) {
          let innerShell = child.children.find((c: any) => c.userData.isInnerShell);
          const innerMatProps: any = {
            color: 0xcccccc,
            roughness: 0.3,
            metalness: 0.8,
            side: THREE.BackSide,
          };
          if (sideMask && sideMask.baseAlphaMap) {
            innerMatProps.alphaMap = sideMask.baseAlphaMap;
            innerMatProps.alphaTest = 0.5;
          }

          if (!innerShell) {
            innerShell = new THREE.Mesh(child.geometry, new THREE.MeshStandardMaterial(innerMatProps));
            innerShell.userData.isInnerShell = true;
            child.add(innerShell);
          } else {
            innerShell.material = new THREE.MeshStandardMaterial(innerMatProps);
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
            windowOverlay.material = new THREE.MeshPhysicalMaterial({
              color: 0xffffff,
              transmission: 1.0,
              ior: 1.5,
              thickness: 0.3,
              roughness: 0.05,
              clearcoat: 1.0,
              clearcoatRoughness: 0.0,
              transparent: true,
              alphaMap: sideMask.windowAlphaMap,
              alphaTest: 0.01,
              side: THREE.DoubleSide,
              depthWrite: false,
            });
            windowOverlay.visible = true;
          } else if (windowOverlay) {
            windowOverlay.visible = false;
          }
        }

        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }, [gltfScene, canvasTextures, materials, punchType, cornerStyles, isClearPlastic, isOneSideClearPlastic, spoutSize, sideMasks]);

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
