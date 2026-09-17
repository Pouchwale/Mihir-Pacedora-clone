'use client';

import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';
import { useEditorStore } from '@/store/useEditorStore';
import { useShallow } from "zustand/react/shallow";
import * as THREE from 'three';

interface PhysicalStudioLightProps {
  prefix: 'keyLight' | 'fillLight' | 'rimLight' | 'ambientLight';
  position: [number, number, number];
  color: string;
  intensity: number;
  focus?: number;
  type?: 'softbox' | 'tube';
  isEditMode?: boolean;
  isReflection?: boolean;
}

export function PhysicalStudioLight({ prefix, position, color, intensity, focus = 0.5, type = 'softbox', isEditMode = false, isReflection = false }: PhysicalStudioLightProps) {
  const headRef = useRef<THREE.Group>(null);
  const targetObj = useRef(new THREE.Object3D());
  const lightRef = useRef<THREE.SpotLight>(null);
  const { updateLightConfig, modelPosition } = useEditorStore(
    useShallow((s) => ({ updateLightConfig: s.updateLightConfig, modelPosition: s.modelPosition }))
  );

  React.useEffect(() => {
    if (lightRef.current) {
      // Restrict the spotlight to only illuminate layer 1 (the model)
      // This prevents the table/floor from catching the flashlight effect
      lightRef.current.layers.set(1);
    }
  }, []);

  useFrame(() => {
    if (headRef.current) {
      // Look at the model's center (shifted up by 1 to point at the center of the package, not the floor)
      headRef.current.lookAt(modelPosition[0], modelPosition[1] + 1, modelPosition[2]);
    }
    // Update spotlight target matrix
    if (lightRef.current && lightRef.current.target) {
      lightRef.current.target.updateMatrixWorld();
    }
  });

  const poleHeight = Math.max(0.1, position[1]);

  const groupRef = useRef<THREE.Group>(null);

  return (
    <>
      {!isReflection && isEditMode && groupRef.current && (
        <TransformControls
          object={groupRef.current}
          mode="translate"
          showY={false}
          size={1.5}
          onMouseUp={() => {
            if (groupRef.current) {
              const p = groupRef.current.position;
              updateLightConfig(prefix, { position: [p.x, position[1], p.z] });
            }
          }}
        />
      )}
      <group ref={groupRef} position={[position[0], 0, position[2]]}>
        
        {/* Invisible target at the center of the scene for the spotlight */}
        <primitive object={targetObj.current} position={[modelPosition[0] - position[0], modelPosition[1] + 1, modelPosition[2] - position[2]]} />

        {/* Visual Elements of the Stand */}
        <group visible={isEditMode || isReflection}>
          {/* Tripod Base */}
          <group position={[0, 0, 0]}>
            {/* Main Base Tube */}
            <mesh position={[0, 0.3, 0]}>
              <cylinderGeometry args={[0.03, 0.03, 0.6, 16]} />
              <meshStandardMaterial color="#1a1a1a" roughness={0.7} metalness={0.5} />
            </mesh>
            
            {/* Locking Collar at the top of the base */}
            <mesh position={[0, 0.6, 0]}>
              <cylinderGeometry args={[0.035, 0.035, 0.06, 16]} />
              <meshStandardMaterial color="#111" roughness={0.9} />
            </mesh>
            {/* Adjustment Knob on collar */}
            <mesh position={[0.035, 0.6, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.015, 0.015, 0.04, 8]} />
              <meshStandardMaterial color="#0a0a0a" roughness={0.9} />
            </mesh>
            <mesh position={[0.06, 0.6, 0]}>
              <boxGeometry args={[0.01, 0.04, 0.04]} />
              <meshStandardMaterial color="#0a0a0a" roughness={0.9} />
            </mesh>

            {/* Leg Joint Base (Thick collar where legs attach) */}
            <mesh position={[0, 0.15, 0]}>
              <cylinderGeometry args={[0.04, 0.04, 0.1, 16]} />
              <meshStandardMaterial color="#111" roughness={0.9} />
            </mesh>

            {/* 3 Legs */}
            {[0, (Math.PI * 2) / 3, (Math.PI * 4) / 3].map((angle, i) => (
              <group key={i} rotation={[0, angle, 0]}>
                {/* Leg strut angled down and out */}
                <mesh position={[0, 0.08, 0.195]} rotation={[1.14, 0, 0]}>
                  <cylinderGeometry args={[0.012, 0.012, 0.34, 8]} />
                  <meshStandardMaterial color="#1a1a1a" roughness={0.7} metalness={0.5} />
                </mesh>
                {/* Rubber foot at the bottom end of the leg */}
                <mesh position={[0, 0.015, 0.35]}>
                  <cylinderGeometry args={[0.018, 0.015, 0.03, 8]} />
                  <meshStandardMaterial color="#050505" roughness={0.9} />
                </mesh>
                {/* Support strut from base to leg */}
                <mesh position={[0, 0.065, 0.095]} rotation={[1.34, 0, 0]}>
                  <cylinderGeometry args={[0.008, 0.008, 0.135, 8]} />
                  <meshStandardMaterial color="#222" roughness={0.8} />
                </mesh>
              </group>
            ))}
          </group>

          {/* Dynamic Pole (adjustable height, extending from base) */}
          <mesh position={[0, (poleHeight - 0.6) / 2 + 0.6, 0]}>
            <cylinderGeometry args={[0.022, 0.022, Math.max(0.01, poleHeight - 0.6), 16]} />
            <meshStandardMaterial color="#222" roughness={0.5} metalness={0.8} />
          </mesh>
        </group>

        {/* Light Head */}
        <group ref={headRef} position={[0, poleHeight, 0]}>
          <group visible={isEditMode || isReflection}>
            {type === 'tube' ? (
              // Tube Light Housing
              <mesh rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.06, 0.06, 1.5, 16]} />
                <meshStandardMaterial color="#111" />
              </mesh>
            ) : (
              // Stage Spotlight Housing
              <group>
                {/* Swivel Joint at origin (where pole connects) */}
                <mesh rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[0.04, 0.04, 0.08, 16]} />
                  <meshStandardMaterial color="#111" roughness={0.8} />
                </mesh>
                
                {/* Connector Rod from Swivel to Cylinder */}
                <mesh position={[0, 0, 0.05]} rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[0.02, 0.02, 0.1, 16]} />
                  <meshStandardMaterial color="#111" roughness={0.8} />
                </mesh>
                
                {/* Main Cylinder Body */}
                <mesh position={[0, 0, 0.225]} rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[0.15, 0.15, 0.35, 32]} />
                  <meshStandardMaterial color="#151515" roughness={0.8} />
                </mesh>

                {/* Ribbed detail rings */}
                {[0.145, 0.225, 0.305].map((z, i) => (
                  <mesh key={i} position={[0, 0, z]} rotation={[Math.PI / 2, 0, 0]}>
                    <torusGeometry args={[0.155, 0.015, 8, 32]} />
                    <meshStandardMaterial color="#111" roughness={0.9} />
                  </mesh>
                ))}

                {/* Barn Doors */}
                <group position={[0, 0, 0.405]}>
                  {/* Top door */}
                  <mesh position={[0, 0.12, 0.05]} rotation={[-0.4, 0, 0]}>
                    <boxGeometry args={[0.28, 0.15, 0.01]} />
                    <meshStandardMaterial color="#0a0a0a" roughness={0.9} />
                  </mesh>
                  {/* Bottom door */}
                  <mesh position={[0, -0.12, 0.05]} rotation={[0.4, 0, 0]}>
                    <boxGeometry args={[0.28, 0.15, 0.01]} />
                    <meshStandardMaterial color="#0a0a0a" roughness={0.9} />
                  </mesh>
                  {/* Left door */}
                  <mesh position={[-0.12, 0, 0.05]} rotation={[0, 0.4, 0]}>
                    <boxGeometry args={[0.15, 0.28, 0.01]} />
                    <meshStandardMaterial color="#0a0a0a" roughness={0.9} />
                  </mesh>
                  {/* Right door */}
                  <mesh position={[0.12, 0, 0.05]} rotation={[0, -0.4, 0]}>
                    <boxGeometry args={[0.15, 0.28, 0.01]} />
                    <meshStandardMaterial color="#0a0a0a" roughness={0.9} />
                  </mesh>
                </group>
              </group>
            )}

            {/* Glowing Emissive Element */}
            {type === 'tube' ? (
              <mesh 
                rotation={[0, 0, Math.PI / 2]} 
                position={[0, 0, 0.04]}
                scale={isReflection ? [2, 1, 2] : 1}
              >
                <cylinderGeometry args={[0.04, 0.04, 1.48, 16]} />
                <meshBasicMaterial 
                  color={new THREE.Color(color).multiplyScalar(intensity * (isReflection ? 40 : 5))} 
                  toneMapped={false} 
                />
              </mesh>
            ) : (
              <mesh 
                position={[0, 0, 0.4]}
                scale={isReflection ? 4 : 1}
              >
                <circleGeometry args={[0.13, 32]} />
                <meshBasicMaterial 
                  color={new THREE.Color(color).multiplyScalar(intensity * (isReflection ? 40 : 5))} 
                  toneMapped={false} 
                />
              </mesh>
            )}
          </group>

        {/* The Actual SpotLight casting shadows */}
        {!isReflection && (() => {
          const maxAngle = type === 'tube' ? Math.PI / 2 : Math.PI / 2.5;
          const minAngle = type === 'tube' ? Math.PI / 6 : Math.PI / 12;
          const actualAngle = maxAngle - focus * (maxAngle - minAngle);
          const actualPenumbra = 1 - focus * 0.9; // 0.1 sharp to 1.0 soft

          return (
            <spotLight
              ref={lightRef}
              position={[0, poleHeight, 0]}
              color={color}
              intensity={intensity * 10} // Multiply for stronger cinematic effect
              angle={actualAngle}
              penumbra={actualPenumbra}
              decay={1.5}
              distance={20}
              castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-bias={-0.0001}
              target={targetObj.current}
            />
          );
        })()}
      </group>
    </group>
    </>
  );
}
