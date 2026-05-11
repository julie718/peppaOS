import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface StarfieldBackgroundProps {
  /** Primary star hue (HSL hue value) */
  hue: number;
}

const STAR_COUNT = 3000;
const SHELL_RADIUS = 35;

const starVertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  varying float vAlpha;
  varying float vBright;
  uniform float uTime;
  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (200.0 / -mvPos.z);
    gl_PointSize *= 0.5 + 0.5 * sin(uTime * 2.1 + aPhase);
    gl_Position = projectionMatrix * mvPos;
    vAlpha = 0.35 + 0.65 * sin(uTime * 1.4 + aPhase + 1.2);
    vBright = aSize;
  }
`;

const starFragmentShader = /* glsl */ `
  varying float vAlpha;
  varying float vBright;
  uniform vec3 uColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float alpha = 1.0 - smoothstep(0.1, 1.0, d);
    alpha *= vAlpha * (0.3 + 0.7 * vBright);
    gl_FragColor = vec4(uColor, alpha * 0.75);
  }
`;

export function StarfieldBackground({ hue }: StarfieldBackgroundProps) {
  const pointsRef = useRef<THREE.Points>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  // Convert hue to normalized RGB color
  const starColor = useMemo(() => {
    const c = new THREE.Color();
    c.setHSL(hue / 360, 0.3, 0.7);
    return c;
  }, [hue]);

  const starGeometry = useMemo(() => {
    const phi = Math.PI * (3 - Math.sqrt(5));
    const pos = new Float32Array(STAR_COUNT * 3);
    const sizes = new Float32Array(STAR_COUNT);
    const phases = new Float32Array(STAR_COUNT);

    // 5 concentric shells at varying radii
    const shells = [
      { r: SHELL_RADIUS * 0.5, count: 400 },
      { r: SHELL_RADIUS * 0.7, count: 600 },
      { r: SHELL_RADIUS * 0.85, count: 800 },
      { r: SHELL_RADIUS, count: 800 },
      { r: SHELL_RADIUS * 1.2, count: 400 },
    ];

    let offset = 0;
    for (const shell of shells) {
      for (let i = 0; i < shell.count; i++) {
        const y = 1 - (i / (shell.count - 1)) * 2;
        const r = Math.sqrt(1 - y * y) * shell.r;
        const theta = phi * (offset + i) + (Math.random() - 0.5) * 0.2;
        const idx = (offset + i) * 3;
        pos[idx] = Math.cos(theta) * r;
        pos[idx + 1] = y * shell.r;
        pos[idx + 2] = Math.sin(theta) * r;
        sizes[offset + i] = 0.15 + Math.random() * 0.9;
        phases[offset + i] = Math.random() * Math.PI * 2;
      }
      offset += shell.count;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    return geo;
  }, []);

  const uniformsRef = useRef({ uTime: { value: 0 }, uColor: { value: starColor } });
  const shaderMaterial = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: starVertexShader,
      fragmentShader: starFragmentShader,
      uniforms: uniformsRef.current,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    materialRef.current = mat;
    return mat;
  }, []);

  React.useEffect(() => {
    uniformsRef.current.uColor.value.copy(starColor);
  }, [starColor]);

  useFrame((_, delta) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value += delta;
    }
    if (pointsRef.current) {
      pointsRef.current.rotation.y += delta * 0.008;
      pointsRef.current.rotation.x += delta * 0.003;
    }
  });

  return (
    <group renderOrder={0}>
      <points ref={pointsRef} geometry={starGeometry} material={shaderMaterial} />
    </group>
  );
}
