import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import { get, set, del } from 'idb-keyval';
import type { DielineState } from '@/lib/dieline/types';

const idbStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    return (await get(name)) || null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await set(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    await del(name);
  },
};

interface EditorState {
  // Scene
  bgColor: string;
  bgType: 'solid' | 'gradient' | 'image' | 'transparent';
  bgImage: string | null;
  showGrid: boolean;
  showShadow: boolean;
  showTable: boolean;
  tableTexture: string | null;
  floorImage: string | null;
  enableFloat: boolean;
  punchType: 'none' | 'butterfly' | 'round' | 'd-punch';
  punchSize: number;
  punchPositionY: number;
  cornerStyles: ['none'|'round'|'angle', 'none'|'round'|'angle', 'none'|'round'|'angle', 'none'|'round'|'angle'];
  cornerSizes: [number, number, number, number];
  linkCorners: boolean;
  isAnimationFrozen: boolean;
  isClearPlastic: boolean;
  isOneSideClearPlastic: boolean;
  /** Look of the clear-plastic add-ons: glossy crystal clear or soft frosted (matt) film */
  filmFinish: 'clear' | 'frosted';
  /** Inner laminate seen through windows and clear film */
  innerLayer: 'bopp' | 'met_pet' | 'milky_white' | 'matt_pet';
  /** Floor photo: shown once at its own proportions, or repeated as tiles */
  floorFit: 'single' | 'tile';
  floorSize: number;
  floorTiles: number;
  /** Floor photo placement: offset left/right (X) and forward/back (Z) in scene units, turn in degrees */
  floorOffsetX: number;
  floorOffsetZ: number;
  floorRotation: number;
  /** Background photo: size in % (100 = fills the view) and offset in % of the view (+X right, +Y up) */
  bgScale: number;
  bgOffsetX: number;
  bgOffsetY: number;
  spoutSize: number;

  // Transparent Windows
  windowCutouts: {
    id: string;
    side: string;
    shape: 'rectangle' | 'circle' | 'oval' | 'rounded-rect';
    x: number;       // 0-100 percentage from left
    y: number;       // 0-100 percentage from top
    width: number;   // 0-100 percentage
    height: number;  // 0-100 percentage
    cornerRadius: number; // 0-50 for rounded-rect
  }[];



  // Geometry
  objText: string | null;
  fileName: string | null;
  detectedSides: string[];
  activeSide: string | null;
  facingSide: string | null;

  isLightEditMode: boolean;

  // Lighting
  keyLightIntensity: number;
  keyLightColor: string;
  keyLightPosition: [number, number, number];
  keyLightFocus: number;

  fillLightIntensity: number;
  fillLightColor: string;
  fillLightPosition: [number, number, number];
  fillLightFocus: number;

  rimLightIntensity: number;
  rimLightColor: string;
  rimLightPosition: [number, number, number];
  rimLightFocus: number;

  ambientLightIntensity: number;
  ambientLightColor: string;

  // Model Transform
  scale: number;
  rotation: [number, number, number];
  modelPosition: [number, number, number];
  sizeScale: [number, number, number];

  // Global Textures (from Claude logic)
  textures: {
    front: string | null;
    back: string | null;
    left: string | null;
    right: string | null;
    top: string | null;
    bottom: string | null;
    overall: string | null;
    label: string | null;
  };

  // Materials
  materials: {
    [key: string]: {
      color: string;
      roughness: number;
      metalness: number;
      emissive: number;
      opacity?: number;
      clearcoat?: number;
    };
  };

  // 2D dieline artwork (null until the designer opens the dieline editor). When it has items, the
  // per-side textures are rendered from it.
  dieline: DielineState | null;
  /** Artwork printed on the inside of the film (rendered from the dieline's "Inside" face) */
  insideTextures: { front: string | null; back: string | null; bottom: string | null };
  /** Editor view: the 3D scene or the 2D dieline */
  editorView: '3d' | 'dieline';

  // Custom Templates
  customTemplates: { id: string; name: string; objData: string }[];

  documentData: string | null;
  documentName: string | null;

  // Actions
  setBgColor: (color: string) => void;
  setBgType: (type: EditorState['bgType']) => void;
  setBgImage: (url: string | null) => void;
  setTableTexture: (url: string | null) => void;
  setFloorImage: (url: string | null) => void;
  setToggle: (key: string, value: any) => void;
  setLightIntensity: (key: 'keyLightIntensity' | 'fillLightIntensity' | 'rimLightIntensity' | 'ambientLightIntensity', value: number) => void;
  updateLightConfig: (lightPrefix: 'keyLight' | 'fillLight' | 'rimLight' | 'ambientLight', config: { color?: string, position?: [number, number, number], intensity?: number, focus?: number }) => void;
  setScale: (scale: number) => void;
  setRotation: (rotation: [number, number, number]) => void;
  setModelPosition: (modelPosition: [number, number, number]) => void;
  updateMaterial: (group: string, updates: Partial<EditorState['materials'][string]>) => void;
  setMaterialPreset: (presetId: 'plastic_glossy' | 'plastic_matte' | 'aluminium_glossy' | 'aluminium_matte') => void;
  setFilmAddon: (addonId: 'clear_all' | 'clear_front' | 'frosted_all' | 'frosted_front' | 'none') => void;
  setTexture: (slot: keyof EditorState['textures'], url: string | null) => void;
  textureTransforms: Record<string, { rotation: number, flipX: boolean, flipY: boolean }>;
  setTextureTransform: (slot: string, transform: Partial<{ rotation: number, flipX: boolean, flipY: boolean }>) => void;
  setObjModel: (text: string, filename: string) => void;
  setDetectedSides: (sides: string[]) => void;
  setActiveSide: (side: string | null) => void;
  setFacingSide: (side: string | null) => void;
  setAllMaterialColors: (color: string) => void;
  addCustomTemplate: (name: string, objData: string) => void;
  removeCustomTemplate: (id: string) => void;
  setSizeScale: (sizeScale: [number, number, number]) => void;
  setDocument: (name: string | null, data: string | null) => void;
  setDieline: (dieline: DielineState | null | ((prev: DielineState | null) => DielineState | null)) => void;
  addWindowCutout: (cutout: EditorState['windowCutouts'][0]) => void;
  updateWindowCutout: (id: string, updates: Partial<EditorState['windowCutouts'][0]>) => void;
  removeWindowCutout: (id: string) => void;
  resetToDefault: () => void;
  resetLighting: () => void;
  resetModelPosition: () => void;
}

// Default studio lighting: used on first load, when a template opens and by "Reset lighting", so all
// three always give the same result
const DEFAULT_LIGHTING = {
  keyLightIntensity: 1.8,
  keyLightColor: '#ffffff',
  keyLightPosition: [5, 4, 3] as [number, number, number],
  keyLightFocus: 0.5,
  fillLightIntensity: 1.2,
  fillLightColor: '#e6f0ff',
  fillLightPosition: [-4, 2, 4] as [number, number, number],
  fillLightFocus: 0.5,
  rimLightIntensity: 1.5,
  rimLightColor: '#fff0e6',
  rimLightPosition: [2, 3, -4] as [number, number, number],
  rimLightFocus: 0.5,
  ambientLightIntensity: 0.8,
  ambientLightColor: '#ffffff',
};

const MATERIAL_SIDES = ['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom', 'Side'];
// Default finish: glossy printed plastic
const defaultMaterials = (): EditorState['materials'] =>
  Object.fromEntries(MATERIAL_SIDES.map((side) => [side, { color: '#ffffff', roughness: 0.08, metalness: 0.0, emissive: 0, opacity: 1.0, clearcoat: 1.0 }]));

export const useEditorStore = create<EditorState>()(
  persist(
    (set) => ({
      bgColor: '#e9ecef',
  bgType: 'solid',
  bgImage: null,
  showGrid: false,
  showShadow: true,
  showTable: false,
  tableTexture: null,
  floorImage: null,
  enableFloat: false,
  punchType: 'none',
  punchSize: 1.0,
  punchPositionY: 80,
  cornerStyles: ['none', 'none', 'none', 'none'],
  cornerSizes: [20, 20, 20, 20],
  linkCorners: true,
  isAnimationFrozen: false,
  isClearPlastic: false,
  isOneSideClearPlastic: false,
  filmFinish: 'clear',
  innerLayer: 'bopp',
  floorFit: 'single',
  floorSize: 8,
  floorTiles: 4,
  floorOffsetX: 0,
  floorOffsetZ: 0,
  floorRotation: 0,
  bgScale: 100,
  bgOffsetX: 0,
  bgOffsetY: 0,
  spoutSize: 10,
  windowCutouts: [],



  objText: null,
  fileName: null,
  detectedSides: [],
  activeSide: null,
  facingSide: null,

  isLightEditMode: false,

  ...DEFAULT_LIGHTING,

  scale: 1,
  rotation: [0, 0, 0],
  modelPosition: [0, 0, 0],
  sizeScale: [1, 1, 1],

  textures: {
    front: null,
    back: null,
    left: null,
    right: null,
    top: null,
    bottom: null,
    overall: null,
    label: null,
  },

  textureTransforms: {},

  materials: defaultMaterials(),

  dieline: null,
  insideTextures: { front: null, back: null, bottom: null },
  editorView: '3d',

  customTemplates: [],
  documentData: null,
  documentName: null,

  setBgColor: (color) => set({ bgColor: color }),
  setBgType: (type) => set({ bgType: type }),
  setBgImage: (url) => set({ bgImage: url }),
  setTableTexture: (url) => set({ tableTexture: url }),
  setFloorImage: (url) => set({ floorImage: url }),
  setToggle: (key, value) => set((state) => ({ ...state, [key]: value })),
  setLightIntensity: (key, value) => set({ [key]: value }),
  updateLightConfig: (lightPrefix, config) => set((state) => {
    const updates: any = {};
    if (config.intensity !== undefined) updates[`${lightPrefix}Intensity`] = config.intensity;
    if (config.color !== undefined) updates[`${lightPrefix}Color`] = config.color;
    if (config.position !== undefined) updates[`${lightPrefix}Position`] = config.position;
    if (config.focus !== undefined) updates[`${lightPrefix}Focus`] = config.focus;
    return updates;
  }),
  setScale: (scale) => set({ scale }),
  setRotation: (rotation) => set({ rotation }),
  setModelPosition: (modelPosition) => set({ modelPosition }),
  setSizeScale: (sizeScale) => set({ sizeScale }),

  updateMaterial: (group, updates) =>
    set((state) => ({
      materials: {
        ...state.materials,
        [group]: { ...state.materials[group], ...updates },
      },
    })),

  setMaterialPreset: (presetId) =>
    set((state) => {
      const presets: Record<string, { roughness: number; metalness: number; clearcoat?: number }> = {
        plastic_glossy: { roughness: 0.08, metalness: 0.0, clearcoat: 1.0 },
        plastic_matte: { roughness: 0.70, metalness: 0.0, clearcoat: 0.0 },
        aluminium_glossy: { roughness: 0.15, metalness: 0.95, clearcoat: 0.35 },
        aluminium_matte: { roughness: 0.55, metalness: 0.90, clearcoat: 0.0 },
      };
      const cfg = presets[presetId] || presets.plastic_glossy;
      const newMaterials = { ...state.materials };
      MATERIAL_SIDES.forEach((side) => {
        newMaterials[side] = {
          ...(newMaterials[side] || { color: '#ffffff', emissive: 0, opacity: 1.0 }),
          roughness: cfg.roughness,
          metalness: cfg.metalness,
          clearcoat: cfg.clearcoat,
        };
      });
      return { materials: newMaterials };
    }),

  // Film add-ons are exclusive. Designs from before the film add-ons faded the print with opacity;
  // every switch clears that, so the print is always solid.
  setFilmAddon: (addonId) =>
    set((state) => {
      const newMaterials = { ...state.materials };
      MATERIAL_SIDES.forEach((side) => {
        if (newMaterials[side] && (newMaterials[side].opacity ?? 1) < 1) {
          newMaterials[side] = { ...newMaterials[side], opacity: 1.0 };
        }
      });
      if (addonId === 'none') {
        return { isClearPlastic: false, isOneSideClearPlastic: false, materials: newMaterials };
      }
      const isAll = addonId === 'clear_all' || addonId === 'frosted_all';
      return {
        isClearPlastic: isAll,
        isOneSideClearPlastic: !isAll,
        filmFinish: addonId.startsWith('frosted') ? 'frosted' : 'clear',
        materials: newMaterials,
      };
    }),

  setTexture: (slot, url) =>
    set((state) => ({
      textures: {
        ...state.textures,
        [slot]: url
      },
      textureTransforms: {
        ...state.textureTransforms,
        [slot]: { rotation: 0, flipX: false, flipY: false }
      }
    })),

  setTextureTransform: (slot, transform) =>
    set((state) => {
      const current = state.textureTransforms[slot] || { rotation: 0, flipX: false, flipY: false };
      return {
        textureTransforms: {
          ...state.textureTransforms,
          [slot]: { ...current, ...transform }
        }
      };
    }),

  setObjModel: (text, filename) => set((state) => {
    if (state.objText === text && state.fileName === filename) return state; // Ignore double-clicks
    return { objText: text, fileName: filename, detectedSides: [], activeSide: null, facingSide: null };
  }),
  setDetectedSides: (sides) => set({ detectedSides: sides }),

  setActiveSide: (side) => set({ activeSide: side }),

  setFacingSide: (side) => set({ facingSide: side }),

  setAllMaterialColors: (color) =>
    set((state) => {
      const newMats = { ...state.materials };
      Object.keys(newMats).forEach(k => {
        newMats[k] = { ...newMats[k], color };
      });
      return { materials: newMats };
    }),

  addCustomTemplate: (name, objData) =>
    set((state) => ({
      customTemplates: [
        ...state.customTemplates,
        { id: Math.random().toString(36).substr(2, 9), name, objData }
      ]
    })),

  removeCustomTemplate: (id) =>
    set((state) => ({
      customTemplates: state.customTemplates.filter(t => t.id !== id)
    })),

  setDocument: (name, data) => set({ documentName: name, documentData: data }),
  setDieline: (dieline) => set((state) => ({ dieline: typeof dieline === 'function' ? dieline(state.dieline) : dieline })),

  addWindowCutout: (cutout) =>
    set((state) => ({
      windowCutouts: [...state.windowCutouts, cutout]
    })),

  updateWindowCutout: (id, updates) =>
    set((state) => ({
      windowCutouts: state.windowCutouts.map(w => w.id === id ? { ...w, ...updates } : w)
    })),

  removeWindowCutout: (id) =>
    set((state) => ({
      windowCutouts: state.windowCutouts.filter(w => w.id !== id)
    })),

  resetToDefault: () =>
    set({
      // Clear the previously opened model so it can't leak into the next template
      objText: null,
      fileName: null,
      detectedSides: [],
      activeSide: null,
      facingSide: null,
      textureTransforms: {},
      modelPosition: [0, 0, 0],
      bgColor: '#e9ecef',
      bgType: 'solid',
      bgImage: null,
      showGrid: false,
      showShadow: true,
      showTable: false,
      tableTexture: null,
  floorImage: null,
      enableFloat: false,
      punchType: 'none',
      punchSize: 1.0,
      punchPositionY: 80,
      cornerStyles: ['none', 'none', 'none', 'none'],
      cornerSizes: [20, 20, 20, 20],
      linkCorners: true,
      isAnimationFrozen: false,
      isClearPlastic: false,
      isOneSideClearPlastic: false,
      filmFinish: 'clear',
      innerLayer: 'bopp',
      floorFit: 'single',
      floorSize: 8,
      floorTiles: 4,
      floorOffsetX: 0,
      floorOffsetZ: 0,
      floorRotation: 0,
      bgScale: 100,
      bgOffsetX: 0,
      bgOffsetY: 0,
      spoutSize: 10,
      windowCutouts: [],
      ...DEFAULT_LIGHTING,
      scale: 1,
      rotation: [0, 0, 0],
      sizeScale: [1, 1, 1],
      textures: {
        front: null,
        back: null,
        left: null,
        right: null,
        top: null,
        bottom: null,
        overall: null,
        label: null,
      },
      materials: defaultMaterials(),
      documentData: null,
      documentName: null,
      dieline: null,
      insideTextures: { front: null, back: null, bottom: null },
      editorView: '3d',
    }),
    resetLighting: () => set({ ...DEFAULT_LIGHTING }),
    resetModelPosition: () => set({
      modelPosition: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
      sizeScale: [1, 1, 1]
    }),
    }),
    {
      name: 'pacdora-clone-storage',
      storage: createJSONStorage(() => idbStorage),
      partialize: (state) => ({ customTemplates: state.customTemplates, sizeScale: state.sizeScale }),
    }
  )
);
