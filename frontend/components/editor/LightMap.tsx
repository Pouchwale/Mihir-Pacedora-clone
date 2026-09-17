'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useEditorStore } from '@/store/useEditorStore';
import { useShallow } from "zustand/react/shallow";
import { Camera, Box } from 'lucide-react';

const MAP_RADIUS = 5; // The maximum X or Z coordinate value we allow dragging to

export function LightMap() {
  const {
    keyLightPosition,
    fillLightPosition,
    rimLightPosition,
    updateLightConfig,
  } = useEditorStore(
    useShallow((s) => ({ keyLightPosition: s.keyLightPosition, fillLightPosition: s.fillLightPosition, rimLightPosition: s.rimLightPosition, updateLightConfig: s.updateLightConfig }))
  );

  const containerRef = useRef<HTMLDivElement>(null);
  
  // State for tracking which light is being dragged
  const [activeLight, setActiveLight] = useState<'keyLight' | 'fillLight' | 'rimLight' | null>(null);

  // Convert 3D [X, Y, Z] to 2D percentages [X%, Y%]
  const toPercentage = (x: number, z: number) => {
    const px = ((x + MAP_RADIUS) / (MAP_RADIUS * 2)) * 100;
    const py = ((z + MAP_RADIUS) / (MAP_RADIUS * 2)) * 100;
    return { left: `${Math.max(0, Math.min(100, px))}%`, top: `${Math.max(0, Math.min(100, py))}%` };
  };

  // Convert Mouse Event to 3D [X, Z]
  const updatePosition = useCallback((clientX: number, clientY: number) => {
    if (!activeLight || !containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    let px = (clientX - rect.left) / rect.width;
    let py = (clientY - rect.top) / rect.height;

    // Clamp between 0 and 1
    px = Math.max(0, Math.min(1, px));
    py = Math.max(0, Math.min(1, py));

    const newX = (px * MAP_RADIUS * 2) - MAP_RADIUS;
    const newZ = (py * MAP_RADIUS * 2) - MAP_RADIUS;

    // We only update X and Z, keeping the original Y (Height)
    let currentPos: [number, number, number] = [0, 0, 0];
    if (activeLight === 'keyLight') currentPos = keyLightPosition;
    if (activeLight === 'fillLight') currentPos = fillLightPosition;
    if (activeLight === 'rimLight') currentPos = rimLightPosition;

    updateLightConfig(activeLight, { position: [newX, currentPos[1], newZ] });
  }, [activeLight, keyLightPosition, fillLightPosition, rimLightPosition, updateLightConfig]);

  // Handle Dragging Events
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (activeLight) {
        updatePosition(e.clientX, e.clientY);
      }
    };
    
    const handlePointerUp = () => {
      setActiveLight(null);
    };

    if (activeLight) {
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    }

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [activeLight, updatePosition]);

  return (
    <div className="w-full flex flex-col gap-2 relative select-none">
      <div 
        ref={containerRef}
        className="w-full aspect-square bg-slate-100 rounded-xl border-2 border-slate-200 relative overflow-hidden shadow-inner"
      >
        {/* Grid lines */}
        <div className="absolute inset-0 grid grid-cols-4 grid-rows-4 opacity-20 pointer-events-none">
          {Array.from({ length: 16 }).map((_, i) => (
            <div key={i} className="border-r border-b border-slate-400" />
          ))}
        </div>

        {/* Center Target (Mockup) */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center opacity-40 pointer-events-none">
          <Box className="w-8 h-8 text-slate-700" />
          <span className="text-[9px] font-bold mt-1 text-slate-700 uppercase tracking-widest">Subject</span>
        </div>

        {/* Camera Position (Bottom Center) */}
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center opacity-40 pointer-events-none">
          <Camera className="w-5 h-5 text-slate-700" />
        </div>

        {/* Draggable Lights */}
        {/* Key Light */}
        <div 
          onPointerDown={() => setActiveLight('keyLight')}
          className="absolute w-8 h-8 -ml-4 -mt-4 bg-brand-500 rounded-full shadow-lg border-2 border-white cursor-grab active:cursor-grabbing flex items-center justify-center text-white font-bold text-[10px] hover:scale-110 transition-transform shadow-brand-500/50 z-10"
          style={toPercentage(keyLightPosition[0], keyLightPosition[2])}
        >
          K
        </div>

        {/* Fill Light */}
        <div 
          onPointerDown={() => setActiveLight('fillLight')}
          className="absolute w-8 h-8 -ml-4 -mt-4 bg-blue-500 rounded-full shadow-lg border-2 border-white cursor-grab active:cursor-grabbing flex items-center justify-center text-white font-bold text-[10px] hover:scale-110 transition-transform shadow-blue-500/50 z-10"
          style={toPercentage(fillLightPosition[0], fillLightPosition[2])}
        >
          F
        </div>

        {/* Rim / Hair Light */}
        <div 
          onPointerDown={() => setActiveLight('rimLight')}
          className="absolute w-8 h-8 -ml-4 -mt-4 bg-yellow-500 rounded-full shadow-lg border-2 border-white cursor-grab active:cursor-grabbing flex items-center justify-center text-white font-bold text-[10px] hover:scale-110 transition-transform shadow-yellow-500/50 z-10"
          style={toPercentage(rimLightPosition[0], rimLightPosition[2])}
        >
          H
        </div>
      </div>
      <div className="flex justify-between items-center px-1">
        <span className="text-[9px] font-medium text-slate-400 flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-brand-500"></div> Key</span>
        <span className="text-[9px] font-medium text-slate-400 flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-blue-500"></div> Fill</span>
        <span className="text-[9px] font-medium text-slate-400 flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-yellow-500"></div> Hair/Rim</span>
      </div>
    </div>
  );
}
