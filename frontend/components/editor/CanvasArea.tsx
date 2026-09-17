'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useEditorStore } from '@/store/useEditorStore';
import { useShallow } from "zustand/react/shallow";
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Environment, ContactShadows, Lightformer, TransformControls, useTexture } from '@react-three/drei';
import { Model } from './Model';
import { PhysicalStudioLight } from './PhysicalStudioLight';
import { Box, RefreshCw, Crosshair, Hexagon, Play, Pause, Lightbulb, Move, Rotate3D } from 'lucide-react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { GLTFExporter } from 'three-stdlib';
import * as THREE from 'three';

function GLTFExportListener({ modelGroupRef }: { modelGroupRef: React.RefObject<THREE.Group> }) {
  useEffect(() => {
    const handleExport = () => {
      if (!modelGroupRef.current) {
        alert("Model not loaded yet.");
        return;
      }

      const exporter = new GLTFExporter();
      
      // Create a clone to safely modify materials for maximum export compatibility
      const exportScene = modelGroupRef.current.clone();
      
      exportScene.traverse((child: any) => {
        if (child.isMesh && child.material) {
          const downgradeMaterial = (mat: any) => {
            if (mat.isMeshPhysicalMaterial) {
              const stdMat = new THREE.MeshStandardMaterial({
                color: mat.color,
                map: mat.map,
                roughness: mat.roughness,
                metalness: mat.metalness,
                emissive: mat.emissive,
                emissiveIntensity: mat.emissiveIntensity,
                transparent: mat.transparent,
                opacity: mat.opacity,
                side: mat.side,
                alphaTest: mat.alphaTest,
                // alphaMap is dropped by standard GLTF anyway, but we keep the main texture (map)
              });
              // Force the map to be retained
              if (mat.map) stdMat.map = mat.map;
              return stdMat;
            }
            return mat;
          };

          if (Array.isArray(child.material)) {
            child.material = child.material.map(downgradeMaterial);
          } else {
            child.material = downgradeMaterial(child.material);
          }
        }
      });

      exporter.parse(
        exportScene,
        (gltf) => {
          const blob = new Blob([gltf as ArrayBuffer], { type: 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          const currentFileName = useEditorStore.getState().fileName || "design";
          // Replace extension with .glb
          a.download = currentFileName.replace(/\.[^/.]+$/, "") + "_textured.glb";
          a.click();
          URL.revokeObjectURL(url);
        },
        (error) => {
          console.error("GLTF Export error:", error);
          alert("Failed to export 3D Model.");
        },
        { binary: true } // GLB format
      );
    };

    window.addEventListener('export-glb', handleExport);
    return () => window.removeEventListener('export-glb', handleExport);
  }, [modelGroupRef]);

  return null;
}

// Keeps the WebGL clear colour in sync: a solid colour, or transparent so the page background
// (e.g. an uploaded background image) shows behind the model. Unmounting <color attach> alone
// does not clear scene.background, which left the old colour covering background images.
function SceneBackground({ bgType, bgColor }: { bgType: string; bgColor: string }) {
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    scene.background = bgType === 'solid' ? new THREE.Color(bgColor) : null;
  }, [scene, bgType, bgColor]);
  return null;
}

// Optional floor image: a large tiled floor under the model
function StudioFloor({ url }: { url: string }) {
  const texture = useTexture(url);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(6, 6);
  texture.colorSpace = THREE.SRGBColorSpace;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.002, 0]} receiveShadow>
      <circleGeometry args={[12, 64]} />
      <meshStandardMaterial map={texture} roughness={0.85} />
    </mesh>
  );
}

function TableSurface({ textureUrl }: { textureUrl: string }) {
  const texture = useTexture(textureUrl);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return <meshStandardMaterial map={texture} roughness={0.8} />;
}

function StudioTable({ tableTexture }: { tableTexture: string | null }) {
  return (
    <group>
      {/* Table Top */}
      <mesh position={[0, -0.1, 0]} receiveShadow>
        <boxGeometry args={[12, 0.2, 8]} />
        {tableTexture ? (
          <TableSurface textureUrl={tableTexture} />
        ) : (
          <meshStandardMaterial color="#e5e5e5" roughness={0.7} />
        )}
      </mesh>
      
      {/* Table Legs */}
      {[
        [-5.5, -4.2, -3.5],
        [5.5, -4.2, -3.5],
        [-5.5, -4.2, 3.5],
        [5.5, -4.2, 3.5]
      ].map((pos, i) => (
        <mesh key={i} position={pos as [number, number, number]} receiveShadow>
          <cylinderGeometry args={[0.15, 0.1, 8, 32]} />
          <meshStandardMaterial color="#d4a373" roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

export function CanvasArea({ template }: { template?: any }) {
  const { 
    bgColor, bgType, bgImage,
    showGrid, 
    showShadow,
    showTable,
    tableTexture,
    floorImage,
    keyLightIntensity, keyLightColor, keyLightPosition, keyLightFocus,
    fillLightIntensity, fillLightColor, fillLightPosition, fillLightFocus,
    rimLightIntensity, rimLightColor, rimLightPosition, rimLightFocus,
    ambientLightIntensity, ambientLightColor,
    setObjModel,
    isAnimationFrozen,
    isLightEditMode,
    setToggle,
    modelPosition,
    setModelPosition,
    rotation,
    setRotation
  } = useEditorStore(
    useShallow((s) => ({ bgColor: s.bgColor, bgType: s.bgType, bgImage: s.bgImage, showGrid: s.showGrid, showShadow: s.showShadow, showTable: s.showTable, tableTexture: s.tableTexture, floorImage: s.floorImage, keyLightIntensity: s.keyLightIntensity, keyLightColor: s.keyLightColor, keyLightPosition: s.keyLightPosition, keyLightFocus: s.keyLightFocus, fillLightIntensity: s.fillLightIntensity, fillLightColor: s.fillLightColor, fillLightPosition: s.fillLightPosition, fillLightFocus: s.fillLightFocus, rimLightIntensity: s.rimLightIntensity, rimLightColor: s.rimLightColor, rimLightPosition: s.rimLightPosition, rimLightFocus: s.rimLightFocus, ambientLightIntensity: s.ambientLightIntensity, ambientLightColor: s.ambientLightColor, setObjModel: s.setObjModel, isAnimationFrozen: s.isAnimationFrozen, isLightEditMode: s.isLightEditMode, setToggle: s.setToggle, modelPosition: s.modelPosition, setModelPosition: s.setModelPosition, rotation: s.rotation, setRotation: s.setRotation }))
  );

  const [isDragging, setIsDragging] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate'>('translate');
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const modelGroupRef = useRef<THREE.Group>(null);
  const modelInnerRef = useRef<THREE.Group>(null);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files?.[0];
    if (file) {
      const lowerName = file.name.toLowerCase();
      if (lowerName.endsWith('.obj') || lowerName.endsWith('.glb') || lowerName.endsWith('.gltf')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          if (ev.target?.result) {
            setObjModel(ev.target.result as string, file.name);
          }
        };
        if (lowerName.endsWith('.obj')) {
          reader.readAsText(file);
        } else {
          reader.readAsDataURL(file);
        }
      }
    }
  }, [setObjModel]);

  const handleResetCamera = () => {
    const controls = controlsRef.current;
    if (!controls) return;
    // Return to the standard front view. OrbitControls.reset() would restore its construction
    // state, which aims at the floor (y = 0) instead of the middle of the pouch.
    controls.object.position.copy(TARGET_MAP.Front.pos);
    controls.target.copy(TARGET_MAP.Front.target);
    controls.update();
  };

  return (
    <div 
      className="flex-1 relative transition-colors duration-500 ease-in-out" 
      style={{ 
        backgroundColor: bgType === 'solid' ? bgColor : 'transparent',
        backgroundImage: bgType === 'image' && bgImage ? `url(${bgImage})` : 'none',
        backgroundSize: 'cover',
        backgroundPosition: 'center'
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drop Zone Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-brand-500/10 backdrop-blur-sm border-2 border-dashed border-brand-500 flex flex-col items-center justify-center pointer-events-none">
          <Box className="w-12 h-12 text-brand-500 mb-4 animate-bounce" />
          <p className="text-brand-700 font-semibold text-lg">Drop OBJ or GLB/GLTF file here</p>
        </div>
      )}

      {/* Canvas Toolbar */}
      <div className="absolute top-4 left-4 z-10 bg-white/90 backdrop-blur border border-white/80 rounded-lg shadow-sm p-1 flex gap-1">

        <button 
          title="Wireframe"
          className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${wireframe ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-white hover:text-slate-900'}`}
          onClick={() => setWireframe(!wireframe)}
        >
          <Hexagon className="w-4 h-4" />
        </button>
        <button 
          title="Auto Rotate"
          className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${autoRotate ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-white hover:text-slate-900'}`}
          onClick={() => setAutoRotate(!autoRotate)}
        >
          <RefreshCw className="w-4 h-4" />
        </button>
        <button 
          title={isAnimationFrozen ? "Play Animation" : "Freeze Animation"}
          className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${isAnimationFrozen ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-white hover:text-slate-900'}`}
          onClick={() => setToggle('isAnimationFrozen', !isAnimationFrozen)}
        >
          {isAnimationFrozen ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
        </button>
        <button 
          title="Reset Camera"
          className="w-8 h-8 rounded flex items-center justify-center text-slate-500 hover:bg-white hover:text-slate-900 transition-colors"
          onClick={handleResetCamera}
        >
          <Crosshair className="w-4 h-4" />
        </button>
      </div>



      <Canvas 
        shadows 
        dpr={[1, 2]}
        camera={{ position: [0, 0, 5], fov: 38 }}
        gl={{ preserveDrawingBuffer: true, toneMappingExposure: 0.7, logarithmicDepthBuffer: true, antialias: true, alpha: true, toneMapping: THREE.ACESFilmicToneMapping }}
      >
        <SceneBackground bgType={bgType} bgColor={bgColor} />
        
        {/* Environment and Lighting */}
        {/* Studio lighting (an uploaded background image is only a backdrop, so the product stays well lit) */}
        <Environment files="/hdri/empty_warehouse_01_1k.hdr" resolution={256} environmentIntensity={ambientLightIntensity * 1.5} />

        {/* Soft ambient fill to preserve shadow detail */}
        <ambientLight intensity={ambientLightIntensity * 0.375} color={ambientLightColor || "#ffffff"} />

        {/* Physical Studio Lights for balanced 360-degree illumination */}
        <PhysicalStudioLight prefix="keyLight" position={keyLightPosition as any} color={keyLightColor} intensity={keyLightIntensity} focus={keyLightFocus} type="softbox" isEditMode={isLightEditMode} />
        <PhysicalStudioLight prefix="fillLight" position={fillLightPosition as any} color={fillLightColor} intensity={fillLightIntensity} focus={fillLightFocus} type="softbox" isEditMode={isLightEditMode} />
        <PhysicalStudioLight prefix="rimLight" position={rimLightPosition as any} color={rimLightColor} intensity={rimLightIntensity} focus={rimLightFocus} type="softbox" isEditMode={isLightEditMode} />

        {/* Applying wireframe property globally to the model scene is easiest by wrapping it or handling it inside Model. 
            For simplicity in this step, we will pass wireframe state via store or props. 
            Since it's local state, we'll pass it as a prop. */}
        {isLightEditMode && (transformMode === 'translate' ? modelGroupRef.current : modelInnerRef.current) ? (
          <TransformControls
            object={transformMode === 'translate' ? modelGroupRef.current! : modelInnerRef.current!}
            mode={transformMode}
            showY={transformMode === 'translate' ? false : true}
            size={1.5}
            onMouseUp={() => {
              if (transformMode === 'translate' && modelGroupRef.current) {
                const p = modelGroupRef.current.position;
                setModelPosition([p.x, p.y, p.z]);
              } else if (transformMode === 'rotate' && modelInnerRef.current) {
                const r = modelInnerRef.current.rotation;
                setRotation([r.x * 180 / Math.PI, r.y * 180 / Math.PI, r.z * 180 / Math.PI]);
              }
            }}
          />
        ) : null}
        <group ref={modelGroupRef} position={modelPosition}>
          <Model ref={modelInnerRef} wireframe={wireframe} />
        </group>
        
        <GLTFExportListener modelGroupRef={modelGroupRef} />
        
        {/* Dynamic Accessory / Spout Model */}
        <OrbitControls 
          ref={controlsRef}
          makeDefault 
          dampingFactor={0.05} 
          autoRotate={autoRotate && !isAnimationFrozen}
          autoRotateSpeed={2}
          target={[0, 1, 0]}
        />
        
        {showGrid && <gridHelper args={[10, 30, '#cccccc', '#dddddd']} position={[0, 0, 0]} material-opacity={0.5} material-transparent />}
        {showTable && <StudioTable tableTexture={tableTexture} />}
        {floorImage && !showTable && <StudioFloor url={floorImage} />}
        {showShadow && (
          <ContactShadows 
            position={[0, 0, 0]} 
            opacity={0.4} 
            scale={10} 
            blur={2} 
            far={4} 
          />
        )}
        <CameraAnimator controlsRef={controlsRef} />
      </Canvas>

    </div>
  );
}

const TARGET_MAP: Record<string, { pos: THREE.Vector3, target: THREE.Vector3 }> = {
  'Front': { pos: new THREE.Vector3(0, 1, 5), target: new THREE.Vector3(0, 1, 0) },
  'Back': { pos: new THREE.Vector3(0, 1, -5), target: new THREE.Vector3(0, 1, 0) },
  'Left': { pos: new THREE.Vector3(-5, 1, 0), target: new THREE.Vector3(0, 1, 0) },
  'Right': { pos: new THREE.Vector3(5, 1, 0), target: new THREE.Vector3(0, 1, 0) },
  'Top': { pos: new THREE.Vector3(0, 6, 0), target: new THREE.Vector3(0, 1, 0) },
  'Bottom': { pos: new THREE.Vector3(0, -4, 0), target: new THREE.Vector3(0, 1, 0) },
};

function CameraAnimator({ controlsRef }: { controlsRef: React.RefObject<OrbitControlsImpl> }) {
  const activeSide = useEditorStore(state => state.activeSide);
  const { camera } = useThree();
  const animState = useRef<{
    active: boolean;
    startTime: number;
    startPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    endPos: THREE.Vector3;
    endTarget: THREE.Vector3;
  } | null>(null);

  useEffect(() => {
    if (activeSide && TARGET_MAP[activeSide] && controlsRef.current) {
      animState.current = {
        active: true,
        startTime: performance.now(),
        startPos: camera.position.clone(),
        startTarget: controlsRef.current.target.clone(),
        endPos: TARGET_MAP[activeSide].pos,
        endTarget: TARGET_MAP[activeSide].target
      };
    }
  }, [activeSide, camera, controlsRef]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const onStart = () => { if (animState.current) animState.current.active = false; };
    controls.addEventListener('start', onStart);
    return () => controls.removeEventListener('start', onStart);
  }, [controlsRef]);

  useFrame(() => {
    if (animState.current?.active && controlsRef.current) {
      const elapsed = (performance.now() - animState.current.startTime) / 1200; // 1.2s duration
      
      if (elapsed >= 1) {
        camera.position.copy(animState.current.endPos);
        controlsRef.current.target.copy(animState.current.endTarget);
        animState.current.active = false;
      } else {
        // easeInOutCubic
        const t = elapsed < 0.5 ? 4 * elapsed * elapsed * elapsed : 1 - Math.pow(-2 * elapsed + 2, 3) / 2;
        camera.position.lerpVectors(animState.current.startPos, animState.current.endPos, t);
        controlsRef.current.target.lerpVectors(animState.current.startTarget, animState.current.endTarget, t);
      }
      controlsRef.current.update();
    }
  });

  return null;
}
