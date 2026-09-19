'use client';

import { useState, useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { pouchTypeForModel } from '@/lib/dieline/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { useEditorStore } from '@/store/useEditorStore';
import { useShallow } from "zustand/react/shallow";
import { LightMap } from './LightMap';
import { ImageIcon, Wand2, PaintBucket, Type, Layout, Paperclip, Trash2, FileText, Download, UploadCloud, X, Link as LinkIcon, Unlink, Send, Sparkles, RotateCw, FlipHorizontal, FlipVertical } from 'lucide-react';
import { downloadDataUrl } from "@/lib/download";

interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  imageUrl?: string;
  refImage?: string;
  isLifestyle?: boolean;
}

export function RightPanel() {
  const { data: session } = useSession();
  const isDesigner = !!(session && ['Designer', 'Head of Designer', 'Administrator'].includes((session.user as any)?.accountType));

  const {
    scale, setScale,
    sizeScale = [1, 1, 1], setSizeScale,
    bgColor, bgType, bgImage, setBgColor, setBgType, setBgImage,
    materials, updateMaterial, setAllMaterialColors,
    keyLightIntensity, fillLightIntensity, rimLightIntensity, ambientLightIntensity, setLightIntensity,
    keyLightColor, keyLightPosition, keyLightFocus, fillLightColor, fillLightPosition, fillLightFocus, rimLightColor, rimLightPosition, rimLightFocus, ambientLightColor, updateLightConfig, resetLighting, resetModelPosition,
    showGrid, showShadow, showTable, tableTexture, setTableTexture, floorImage, setFloorImage, enableFloat, punchType, punchSize, punchPositionY, cornerStyles, cornerSizes, linkCorners, isClearPlastic, isOneSideClearPlastic, setToggle,
    textures, textureTransforms, setTexture, setTextureTransform, detectedSides,
    documentData, documentName, setDocument,
    activeSide, facingSide, setActiveSide, fileName, spoutSize,
    windowCutouts, addWindowCutout, updateWindowCutout, removeWindowCutout
  } = useEditorStore(
    useShallow((s) => ({ scale: s.scale, setScale: s.setScale, sizeScale: s.sizeScale, setSizeScale: s.setSizeScale, bgColor: s.bgColor, bgType: s.bgType, bgImage: s.bgImage, setBgColor: s.setBgColor, setBgType: s.setBgType, setBgImage: s.setBgImage, materials: s.materials, updateMaterial: s.updateMaterial, setAllMaterialColors: s.setAllMaterialColors, keyLightIntensity: s.keyLightIntensity, fillLightIntensity: s.fillLightIntensity, rimLightIntensity: s.rimLightIntensity, ambientLightIntensity: s.ambientLightIntensity, setLightIntensity: s.setLightIntensity, keyLightColor: s.keyLightColor, keyLightPosition: s.keyLightPosition, keyLightFocus: s.keyLightFocus, fillLightColor: s.fillLightColor, fillLightPosition: s.fillLightPosition, fillLightFocus: s.fillLightFocus, rimLightColor: s.rimLightColor, rimLightPosition: s.rimLightPosition, rimLightFocus: s.rimLightFocus, ambientLightColor: s.ambientLightColor, updateLightConfig: s.updateLightConfig, resetLighting: s.resetLighting, resetModelPosition: s.resetModelPosition, showGrid: s.showGrid, showShadow: s.showShadow, showTable: s.showTable, tableTexture: s.tableTexture, setTableTexture: s.setTableTexture, floorImage: s.floorImage, setFloorImage: s.setFloorImage, enableFloat: s.enableFloat, punchType: s.punchType, punchSize: s.punchSize, punchPositionY: s.punchPositionY, cornerStyles: s.cornerStyles, cornerSizes: s.cornerSizes, linkCorners: s.linkCorners, isClearPlastic: s.isClearPlastic, isOneSideClearPlastic: s.isOneSideClearPlastic, setToggle: s.setToggle, textures: s.textures, textureTransforms: s.textureTransforms, setTexture: s.setTexture, setTextureTransform: s.setTextureTransform, detectedSides: s.detectedSides, documentData: s.documentData, documentName: s.documentName, setDocument: s.setDocument, activeSide: s.activeSide, facingSide: s.facingSide, setActiveSide: s.setActiveSide, fileName: s.fileName, spoutSize: s.spoutSize, windowCutouts: s.windowCutouts, addWindowCutout: s.addWindowCutout, updateWindowCutout: s.updateWindowCutout, removeWindowCutout: s.removeWindowCutout }))
  );
  const filmFinish = useEditorStore((s) => s.filmFinish);
  const innerLayer = useEditorStore((s) => s.innerLayer);
  const floorFit = useEditorStore((s) => s.floorFit);
  const floorSize = useEditorStore((s) => s.floorSize);
  const floorTiles = useEditorStore((s) => s.floorTiles);
  const floorOffsetX = useEditorStore((s) => s.floorOffsetX);
  const floorOffsetZ = useEditorStore((s) => s.floorOffsetZ);
  const floorRotation = useEditorStore((s) => s.floorRotation);
  const bgScale = useEditorStore((s) => s.bgScale);
  const bgOffsetX = useEditorStore((s) => s.bgOffsetX);
  const bgOffsetY = useEditorStore((s) => s.bgOffsetY);
  const setMaterialPreset = useEditorStore((s) => s.setMaterialPreset);
  const setFilmAddon = useEditorStore((s) => s.setFilmAddon);
  const dieline = useEditorStore((s) => s.dieline);
  const dielinePouchType = pouchTypeForModel(fileName);

  const [unit, setUnit] = useState<'cm' | 'in'>('cm');
  const [windowUnit, setWindowUnit] = useState<'%' | 'cm' | 'in'>('%');
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiResult, setAiResult] = useState<{imageUrl: string} | null>(null);
  const [aiRefImage, setAiRefImage] = useState<string | null>(null);
  const [isDocPanelOpen, setIsDocPanelOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of chat
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistory, isGenerating]);

  const handleAiRefUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        alert("Image is too large. Please select an image under 5MB.");
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setAiRefImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleDocUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isDesigner) return;
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 8 * 1024 * 1024) {
        alert("File is too large. Please select a document under 8MB.");
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        setDocument(file.name, base64String);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveDoc = () => {
    if (!isDesigner) return;
    setDocument(null, null);
  };

  const handleDownloadDoc = () => {
    if (!documentData || !documentName) return;
    if (!downloadDataUrl(documentData, documentName)) {
      alert("The attached file is not a valid document.");
    }
  };

  // Local string inputs for keyboard manual entry
  const [lengthInput, setLengthInput] = useState('');
  const [heightInput, setHeightInput] = useState('');
  const [widthInput, setWidthInput] = useState('');

  // Keep track of which input has focus
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // Sync inputs with sizeScale from store
  useEffect(() => {
    const refDims = [15, 20, 5];
    if (focusedIndex !== 0) {
      const val = refDims[0] * (sizeScale?.[0] ?? 1);
      setLengthInput((unit === 'cm' ? val : val * 0.393701).toFixed(unit === 'cm' ? 1 : 2));
    }
    if (focusedIndex !== 1) {
      const val = refDims[1] * (sizeScale?.[1] ?? 1);
      setHeightInput((unit === 'cm' ? val : val * 0.393701).toFixed(unit === 'cm' ? 1 : 2));
    }
    if (focusedIndex !== 2) {
      const val = refDims[2] * (sizeScale?.[2] ?? 1);
      setWidthInput((unit === 'cm' ? val : val * 0.393701).toFixed(unit === 'cm' ? 1 : 2));
    }
  }, [sizeScale, unit, focusedIndex]);

  const frontMat = materials.Front;

  // Background / floor images: resized to at most 2048px and stored as JPEG to keep designs small
  const handleSceneImageUpload = (onSet: (url: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        onSet(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleTextureUpload = (slot: keyof typeof textures) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          // Max dimension 1024px for optimal 3D mapping and ultra-fast loads
          const MAX_WIDTH = 1024;
          const MAX_HEIGHT = 1024;
          let width = img.width;
          let height = img.height;

          if (width > MAX_WIDTH || height > MAX_HEIGHT) {
            if (width > height) {
              height *= MAX_WIDTH / width;
              width = MAX_WIDTH;
            } else {
              width *= MAX_HEIGHT / height;
              height = MAX_HEIGHT;
            }
          }

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            // Compress to crisp 85% JPEG
            const compressedBase64 = canvas.toDataURL("image/jpeg", 0.85);
            setTexture(slot, compressedBase64);
          } else {
            setTexture(slot, event.target?.result as string);
          }
        };
        img.src = event.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  const handleClearTexture = (slot: keyof typeof textures) => {
    setTexture(slot, null);
  };

  const generateAiDesign = async () => {
    if (!aiPrompt.trim()) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text: aiPrompt,
      refImage: aiRefImage || undefined
    };

    setChatHistory(prev => [...prev, userMessage]);
    setIsGenerating(true);
    setAiPrompt(''); // Clear input after sending
    setAiRefImage(null);

    try {
      // Calling our Nano Banana backend API route
      // This bypasses any browser CORS issues and acts as our bridge to the Gemini Nano Banana model.
      const response = await fetch('/api/nano-banana', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMessage.text,
          refImage: userMessage.refImage
        })
      });

      if (!response.ok) {
        throw new Error("Failed to fetch image from Nano Banana API");
      }

      const data = await response.json();

      const aiMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: `Here is the high-fidelity design generated by Nano Banana AI based on: "${userMessage.text}"`,
        imageUrl: data.imageUrl
      };

      setChatHistory(prev => [...prev, aiMessage]);
      setIsGenerating(false);
    } catch (error) {
      console.error("Failed to generate AI design:", error);
      setIsGenerating(false);

      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: "Failed to generate image. Please try again."
      };
      setChatHistory(prev => [...prev, errorMessage]);
    }
  };

  const generateLifestylePhoto = async () => {

    const canvas = document.querySelector('canvas');
    if (!canvas) {
      alert('Could not capture 3D model.');
      return;
    }

    // Capture the canvas image
    const dataUrl = canvas.toDataURL('image/png');

    // Check if user typed a specific prompt, else use a high-quality default
    const basePrompt = "cinematic product photography, highly realistic lifestyle photo of this packaging, dramatic lighting, sharp focus, 8k resolution, photorealistic";
    const finalPrompt = aiPrompt.trim()
      ? `${basePrompt}. Context: ${aiPrompt.trim()}`
      : `${basePrompt} on a wooden table with beautiful spices and props`;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text: aiPrompt.trim()
        ? `Create lifestyle photo: ${aiPrompt.trim()}`
        : "Create a realistic lifestyle photo using the current 3D canvas.",
      refImage: dataUrl
    };

    setChatHistory(prev => [...prev, userMessage]);
    setIsGenerating(true);
    setAiPrompt('');
    setAiRefImage(null);

    try {
      const response = await fetch('/api/nano-banana', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: finalPrompt,
          refImage: dataUrl
        })
      });

      if (!response.ok) {
        throw new Error("Failed to fetch image from AI API");
      }

      const data = await response.json();

      const aiMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: "Here is your cinematic lifestyle photography! ✨",
        imageUrl: data.imageUrl,
        isLifestyle: true
      };

      setChatHistory(prev => [...prev, aiMessage]);
    } catch (error) {
      console.error("Failed to generate lifestyle photo:", error);
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: "Failed to generate lifestyle photo. Please try again."
      };
      setChatHistory(prev => [...prev, errorMessage]);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="relative w-[320px] bg-white border-l border-slate-200 flex flex-col shrink-0 h-full">
      <Tabs defaultValue="art" className="w-full h-full flex flex-col min-h-0">
        <div className="px-4 pt-3 pb-2 border-b border-slate-200 bg-slate-50">
          <TabsList className="w-full grid grid-cols-3 bg-transparent p-0" variant="line">
            <TabsTrigger value="art" className="text-[10px] font-bold uppercase tracking-widest text-slate-400 data-active:text-brand-600 data-active:bg-transparent data-active:border-b-2 data-active:border-brand-600 rounded-none shadow-none h-10">Art</TabsTrigger>
            <TabsTrigger value="size" className="text-[10px] font-bold uppercase tracking-widest text-slate-400 data-active:text-brand-600 data-active:bg-transparent data-active:border-b-2 data-active:border-brand-600 rounded-none shadow-none h-10">Size</TabsTrigger>
            <TabsTrigger value="ai" className="text-[10px] font-bold uppercase tracking-widest text-slate-400 data-active:text-brand-600 data-active:bg-transparent data-active:border-b-2 data-active:border-brand-600 rounded-none shadow-none h-10">AI Help</TabsTrigger>
          </TabsList>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          {/* ART TAB */}
          <TabsContent value="art" className="p-5 m-0 outline-none">
            <div className="space-y-6">

              {/* Textures */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 mb-3 block">Artwork Manager</span>

                {/* 2D dieline editor: place artwork on the flat keyline (front, back, seals, gusset) */}
                {dielinePouchType ? (
                  <button
                    type="button"
                    onClick={() => setToggle('editorView', 'dieline')}
                    className="w-full mb-4 p-3 rounded-lg border-2 border-brand-200 bg-brand-50/40 hover:bg-brand-50 text-left transition-colors cursor-pointer"
                  >
                    <span className="text-[10px] font-extrabold text-brand-700 uppercase tracking-wider block">Open 2D Dieline / Keyline</span>
                    <span className="text-[9px] text-slate-500 block mt-0.5">
                      {dieline && dieline.items.length > 0
                        ? `${dieline.items.length} item(s) placed on the dieline. Side artwork below is generated from it.`
                        : 'Place artwork on the flat keyline with seals, zipper, bleed and gusset in mm.'}
                    </span>
                  </button>
                ) : (
                  <p className="text-[9px] text-slate-400 mb-4">The 2D dieline editor is available for the Stand-Up Pouch and flat three-side-seal pouches.</p>
                )}

                {/* 3D Realtime Side Sync Status Panel */}
                <div className="mb-4 bg-slate-50 border border-slate-100 rounded-lg p-3 flex justify-between items-center text-xs">
                  <div>
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block mb-0.5">Selected side</span>
                    <span className="font-bold text-slate-700">{activeSide || 'None (Click model or card)'}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block mb-0.5">Camera view</span>
                    <span className="font-bold text-slate-700 flex items-center justify-end gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse"></span>
                      {facingSide || 'Front'}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {[
                    ...(detectedSides.includes('Front') ? [{ id: 'front', label: 'Front' }] : []),
                    ...(detectedSides.includes('Back') ? [{ id: 'back', label: 'Back' }] : []),
                    ...(detectedSides.includes('Left') ? [{ id: 'left', label: 'Left Side' }] : []),
                    ...(detectedSides.includes('Right') ? [{ id: 'right', label: 'Right Side' }] : []),
                    ...(detectedSides.includes('Top') ? [{ id: 'top', label: 'Top' }] : []),
                    ...(detectedSides.includes('Bottom') ? [{ id: 'bottom', label: 'Bottom' }] : [])
                  ].map(slot => {
                    const isSelected = activeSide?.toLowerCase() === slot.id || (slot.id === 'left' && activeSide === 'Left') || (slot.id === 'right' && activeSide === 'Right');
                    const isFacing = facingSide?.toLowerCase() === slot.id || (slot.id === 'left' && facingSide === 'Left') || (slot.id === 'right' && facingSide === 'Right');

                    const mapIdToSide: Record<string, string> = {
                      front: 'Front',
                      back: 'Back',
                      left: 'Left',
                      right: 'Right',
                      top: 'Top',
                      bottom: 'Bottom'
                    };

                    const tTransform = textureTransforms[slot.id] || { rotation: 0, flipX: false, flipY: false };
                    // Front, back and bottom come from the 2D dieline while it has artwork on it
                    const managedByDieline = !!dieline && dieline.items.length > 0 && ['front', 'back', 'bottom'].includes(slot.id);

                    return (
                      <div
                        key={slot.id}
                        className="cursor-pointer"
                        onClick={() => {
                          const side = mapIdToSide[slot.id];
                          if (side) setActiveSide(side);
                        }}
                      >
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">{slot.label}</span>
                        <div className={`relative aspect-square rounded-lg border-2 border-dashed flex flex-col items-center justify-center transition-all group overflow-hidden ${
                          isSelected
                            ? 'border-brand-500 border-solid ring-2 ring-brand-500/20 shadow-md bg-white'
                            : textures[slot.id as keyof typeof textures]
                              ? 'border-solid border-slate-200 bg-white'
                              : 'border-slate-200 bg-slate-50' + ' hover:border-brand-500 hover:bg-brand-50'
                        }`}>
                          {/* Active View / Facing Indicator */}
                          {isFacing && (
                            <div className="absolute top-1.5 left-1.5 bg-emerald-500 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm flex items-center gap-1 shadow-sm select-none z-10">
                              <span className="w-1.5 h-1.5 rounded-full bg-white block animate-pulse"></span>
                              VIEWING
                            </div>
                          )}

                          {isSelected && (
                            <div className="absolute top-1.5 right-1.5 bg-brand-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm flex items-center gap-1 shadow-sm select-none z-10">
                              SELECTED
                            </div>
                          )}

                          {managedByDieline ? (
                            <>
                              {textures[slot.id as keyof typeof textures] && (
                                <img src={textures[slot.id as keyof typeof textures]!} alt={slot.label} className="absolute inset-0 w-full h-full object-cover" />
                              )}
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setToggle('editorView', 'dieline'); }}
                                className="absolute inset-0 bg-slate-900/55 text-white flex flex-col items-center justify-center gap-1 text-[9px] font-bold uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity z-10"
                              >
                                <span>From 2D dieline</span>
                                <span className="bg-white text-slate-800 px-2 py-0.5 rounded normal-case tracking-normal">Edit dieline</span>
                              </button>
                            </>
                          ) : textures[slot.id as keyof typeof textures] ? (
                            <>
                              <img
                                src={textures[slot.id as keyof typeof textures]!}
                                alt={slot.label}
                                className="absolute inset-0 w-full h-full object-cover"
                                style={{
                                  transform: `rotate(${tTransform.rotation}deg) scaleX(${tTransform.flipX ? -1 : 1}) scaleY(${tTransform.flipY ? -1 : 1})`
                                }}
                              />
                              <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center gap-3 transition-opacity z-10">
                                <div className="flex gap-1.5">
                                  <button onClick={(e) => {
                                    e.stopPropagation();
                                    setTextureTransform(slot.id, { rotation: (tTransform.rotation + 90) % 360 });
                                  }} className="bg-white/20 hover:bg-brand-500 text-white p-1.5 rounded transition-colors" title="Rotate 90°">
                                    <RotateCw className="w-3.5 h-3.5" />
                                  </button>
                                  <button onClick={(e) => {
                                    e.stopPropagation();
                                    setTextureTransform(slot.id, { flipX: !tTransform.flipX });
                                  }} className="bg-white/20 hover:bg-brand-500 text-white p-1.5 rounded transition-colors" title="Flip Horizontal">
                                    <FlipHorizontal className="w-3.5 h-3.5" />
                                  </button>
                                  <button onClick={(e) => {
                                    e.stopPropagation();
                                    setTextureTransform(slot.id, { flipY: !tTransform.flipY });
                                  }} className="bg-white/20 hover:bg-brand-500 text-white p-1.5 rounded transition-colors" title="Flip Vertical">
                                    <FlipVertical className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                <div className="flex gap-1.5">
                                  {/* Replace the artwork without removing it first */}
                                  <label
                                    onClick={(e) => e.stopPropagation()}
                                    className="bg-white/90 hover:bg-white text-slate-800 text-[10px] font-bold px-3 py-1.5 rounded transition-colors cursor-pointer"
                                    title="Upload a different image"
                                  >
                                    ⟳ Replace
                                    <input
                                      type="file"
                                      accept="image/*"
                                      className="hidden"
                                      onClick={(e) => { e.currentTarget.value = ""; }}
                                      onChange={handleTextureUpload(slot.id as keyof typeof textures)}
                                    />
                                  </label>
                                  <button onClick={(e) => {
                                    e.stopPropagation();
                                    handleClearTexture(slot.id as keyof typeof textures);
                                  }} className="bg-red-500/90 hover:bg-red-600 text-white text-[10px] font-bold px-3 py-1.5 rounded transition-colors">✕ Remove</button>
                                </div>
                              </div>
                            </>
                          ) : (
                            <>
                              <ImageIcon className="w-5 h-5 text-slate-300 mb-1" />
                              <span className="text-[9px] font-bold text-slate-400 uppercase">Upload</span>
                              <input type="file" onClick={(e) => { e.currentTarget.value = ""; }} accept="image/*" className="absolute inset-0 opacity-0 cursor-pointer" onChange={handleTextureUpload(slot.id as keyof typeof textures)} />
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Optional scene images: background and floor */}
              <div className="mt-4">
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 mb-2 block">Scene images (optional)</span>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    {
                      id: 'background',
                      label: 'Background',
                      image: bgType === 'image' ? bgImage : null,
                      onSet: (url: string) => { setBgImage(url); setBgType('image'); },
                      onClear: () => { setBgImage(null); setBgType('solid'); },
                    },
                    {
                      id: 'floor',
                      label: 'Floor',
                      image: floorImage,
                      onSet: (url: string) => setFloorImage(url),
                      onClear: () => setFloorImage(null),
                    },
                  ].map(slotDef => (
                    <div key={slotDef.id}>
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">{slotDef.label}</span>
                      <div className={`relative aspect-video rounded-lg border-2 flex flex-col items-center justify-center overflow-hidden group ${slotDef.image ? 'border-solid border-slate-200 bg-white' : 'border-dashed border-slate-200 bg-slate-50 hover:border-brand-500 hover:bg-brand-50'}`}>
                        {slotDef.image ? (
                          <>
                            <img src={slotDef.image} alt={`${slotDef.label} image`} className="absolute inset-0 w-full h-full object-cover" />
                            <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex items-center justify-center gap-1.5 transition-opacity">
                              <label className="bg-white/90 hover:bg-white text-slate-800 text-[10px] font-bold px-2 py-1 rounded cursor-pointer">
                                ⟳ Replace
                                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onClick={(e) => { e.currentTarget.value = ""; }} onChange={handleSceneImageUpload(slotDef.onSet)} />
                              </label>
                              <button type="button" onClick={slotDef.onClear} className="bg-red-500/90 hover:bg-red-600 text-white text-[10px] font-bold px-2 py-1 rounded">✕ Remove</button>
                            </div>
                          </>
                        ) : (
                          <>
                            <ImageIcon className="w-4 h-4 text-slate-300 mb-1" />
                            <span className="text-[9px] font-bold text-slate-400 uppercase">Add image</span>
                            <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Add ${slotDef.label.toLowerCase()} image`} className="absolute inset-0 opacity-0 cursor-pointer" onClick={(e) => { e.currentTarget.value = ""; }} onChange={handleSceneImageUpload(slotDef.onSet)} />
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Background photo placement */}
                {bgType === 'image' && bgImage && (
                  <div className="mt-3 p-3 rounded-lg border border-slate-100 bg-slate-50/60 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Background photo</span>
                      <button
                        type="button"
                        aria-label="Reset background photo"
                        onClick={() => { setToggle('bgScale', 100); setToggle('bgOffsetX', 0); setToggle('bgOffsetY', 0); }}
                        className="text-[9px] font-bold text-brand-600 hover:text-brand-700 cursor-pointer"
                      >
                        Reset
                      </button>
                    </div>
                    {[
                      { key: 'bgScale', label: 'Size', value: bgScale, min: 30, max: 300, step: 5, unit: '%' },
                      { key: 'bgOffsetX', label: 'Left / Right', value: bgOffsetX, min: -50, max: 50, step: 1, unit: '%' },
                      { key: 'bgOffsetY', label: 'Down / Up', value: bgOffsetY, min: -50, max: 50, step: 1, unit: '%' },
                    ].map((ctl) => (
                      <label key={ctl.key} className="block">
                        <span className="flex justify-between text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                          <span>{ctl.label}</span><span>{ctl.value}{ctl.unit}</span>
                        </span>
                        <input type="range" min={ctl.min} max={ctl.max} step={ctl.step} value={ctl.value} aria-label={`Background ${ctl.label}`} onChange={(e) => setToggle(ctl.key, Number(e.target.value))} className="w-full accent-brand-600" />
                      </label>
                    ))}
                  </div>
                )}

                {/* Floor photo placement */}
                {floorImage && (
                  <div className="mt-3 p-3 rounded-lg border border-slate-100 bg-slate-50/60 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Floor photo</span>
                      <button
                        type="button"
                        aria-label="Reset floor photo"
                        onClick={() => { setToggle('floorSize', 8); setToggle('floorTiles', 4); setToggle('floorOffsetX', 0); setToggle('floorOffsetZ', 0); setToggle('floorRotation', 0); }}
                        className="text-[9px] font-bold text-brand-600 hover:text-brand-700 cursor-pointer"
                      >
                        Reset
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Floor photo placement">
                      {[
                        { id: 'single', label: 'Single photo', desc: 'Shown once, not repeated' },
                        { id: 'tile', label: 'Repeat (tiles)', desc: 'Pattern across the floor' },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={floorFit === opt.id}
                          onClick={() => setToggle('floorFit', opt.id)}
                          className={`p-2 rounded-md border text-left transition-colors cursor-pointer ${floorFit === opt.id ? 'border-brand-600 bg-brand-50/30' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                        >
                          <div className="text-[10px] font-bold text-slate-700">{opt.label}</div>
                          <div className="text-[8px] text-slate-400">{opt.desc}</div>
                        </button>
                      ))}
                    </div>
                    <label className="block">
                      <span className="flex justify-between text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                        <span>{floorFit === 'tile' ? 'Floor size' : 'Photo size'}</span><span>{floorSize}</span>
                      </span>
                      <input type="range" min={2} max={100} step={1} value={floorSize} aria-label={floorFit === 'tile' ? 'Floor size' : 'Floor photo size'} onChange={(e) => setToggle('floorSize', Number(e.target.value))} className="w-full accent-brand-600" />
                    </label>
                    {[
                      { key: 'floorOffsetX', label: 'Left / Right', value: floorOffsetX, min: -30, max: 30, step: 0.5, unit: '' },
                      { key: 'floorOffsetZ', label: 'Back / Forward', value: floorOffsetZ, min: -30, max: 30, step: 0.5, unit: '' },
                      { key: 'floorRotation', label: 'Rotate', value: floorRotation, min: 0, max: 360, step: 5, unit: '°' },
                    ].map((ctl) => (
                      <label key={ctl.key} className="block">
                        <span className="flex justify-between text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                          <span>{ctl.label}</span><span>{ctl.value}{ctl.unit}</span>
                        </span>
                        <input type="range" min={ctl.min} max={ctl.max} step={ctl.step} value={ctl.value} aria-label={`Floor ${ctl.label}`} onChange={(e) => setToggle(ctl.key, Number(e.target.value))} className="w-full accent-brand-600" />
                      </label>
                    ))}
                    {floorFit === 'tile' && (
                      <label className="block">
                        <span className="flex justify-between text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                          <span>Repeats</span><span>{floorTiles} × {floorTiles}</span>
                        </span>
                        <input type="range" min={2} max={12} step={1} value={floorTiles} onChange={(e) => setToggle('floorTiles', Number(e.target.value))} className="w-full accent-brand-600" />
                      </label>
                    )}
                  </div>
                )}
              </div>

              <div className="h-px bg-slate-100 my-4" />

              {/* Material Presets */}
              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Material Presets</span>
                  <span className="text-[9px] text-slate-400 font-medium">Base finish</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    {
                      id: 'plastic_glossy' as const,
                      label: 'Plastic Glossy',
                      desc: 'High-gloss plastic surface',
                      r: 0.08,
                      m: 0.0,
                      swatch: 'linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #94a3b8 100%)',
                      glossSheen: true,
                    },
                    {
                      id: 'plastic_matte' as const,
                      label: 'Plastic Matte',
                      desc: 'Soft diffused matte surface',
                      r: 0.70,
                      m: 0.0,
                      swatch: 'linear-gradient(135deg, #f8fafc 0%, #94a3b8 100%)',
                      glossSheen: false,
                    },
                    {
                      id: 'aluminium_glossy' as const,
                      label: 'Aluminium Glossy',
                      desc: 'Highly reflective polished foil',
                      r: 0.15,
                      m: 0.95,
                      swatch: 'linear-gradient(135deg, #ffffff 0%, #94a3b8 35%, #ffffff 65%, #475569 100%)',
                      glossSheen: true,
                    },
                    {
                      id: 'aluminium_matte' as const,
                      label: 'Aluminium Matte',
                      desc: 'Satin brushed metallic finish',
                      r: 0.55,
                      m: 0.90,
                      swatch: 'linear-gradient(135deg, #cbd5e1 0%, #64748b 50%, #94a3b8 100%)',
                      glossSheen: false,
                    },
                  ].map(preset => {
                    const front = materials.Front || (materials as any).Overall || {};
                    const isSelected = Math.abs((front.roughness ?? 0.5) - preset.r) <= 0.08 && Math.abs((front.metalness ?? 0) - preset.m) <= 0.15;
                    return (
                      <button
                        type="button"
                        key={preset.id}
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setMaterialPreset(preset.id)}
                        className={`p-2.5 rounded-lg border-2 text-left transition-all cursor-pointer relative group overflow-hidden ${
                          isSelected
                            ? 'border-brand-600 bg-brand-50/40 shadow-xs ring-2 ring-brand-500/20'
                            : 'border-slate-200 bg-slate-50/60 hover:bg-white hover:border-slate-300 hover:shadow-2xs'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1.5 mb-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <div
                              className="w-3.5 h-3.5 rounded-full border border-slate-300/80 shrink-0 shadow-2xs relative overflow-hidden"
                              style={{ background: preset.swatch }}
                            >
                              {preset.glossSheen && (
                                <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/50 to-transparent pointer-events-none" />
                              )}
                            </div>
                            <span className="text-[10px] font-bold text-slate-800 tracking-tight leading-tight truncate">{preset.label}</span>
                          </div>
                          {isSelected && (
                            <span className="w-1.5 h-1.5 rounded-full bg-brand-600 shrink-0" />
                          )}
                        </div>
                        <div className="text-[8px] text-slate-400 leading-normal pl-5">{preset.desc}</div>
                      </button>
                    );
                  })}
                </div>

                {/* Add-ons (optional) */}
                <div className="flex items-center justify-between mt-5 mb-2.5">
                  <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Add-ons (optional)</span>
                  <span className="text-[9px] text-slate-400 font-medium">Clear / Frosted film</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(() => {
                    const scope = isClearPlastic ? 'all' : isOneSideClearPlastic ? 'front' : null;
                    const activeAddon = scope ? `${filmFinish}_${scope}` : null;
                    return [
                      {
                        id: 'clear_all' as const,
                        label: 'Clear Plastic',
                        desc: 'Glossy crystal-clear film on every side. Print stays solid.',
                        icon: (
                          <div className="w-3.5 h-3.5 rounded border border-sky-300 bg-sky-50/80 shadow-3xs flex items-center justify-center shrink-0">
                            <span className="text-[6.5px] font-black text-sky-600">360°</span>
                          </div>
                        ),
                      },
                      {
                        id: 'clear_front' as const,
                        label: 'Clear Front',
                        desc: 'Crystal-clear front, printed opaque back.',
                        icon: (
                          <div className="w-3.5 h-3.5 rounded border border-slate-300 overflow-hidden flex shadow-3xs shrink-0">
                            <div className="w-1/2 h-full bg-sky-100 border-r border-sky-300" />
                            <div className="w-1/2 h-full bg-slate-300" />
                          </div>
                        ),
                      },
                      {
                        id: 'frosted_all' as const,
                        label: 'Frosted / Matt Clear',
                        desc: 'Soft frosted see-through film on every side.',
                        icon: (
                          <div className="w-3.5 h-3.5 rounded border border-slate-300 bg-slate-100 shadow-3xs flex items-center justify-center shrink-0">
                            <span className="text-[6px] font-black text-slate-500">MATT</span>
                          </div>
                        ),
                      },
                      {
                        id: 'frosted_front' as const,
                        label: 'Frosted Front',
                        desc: 'Frosted see-through front, printed opaque back.',
                        icon: (
                          <div className="w-3.5 h-3.5 rounded border border-slate-300 overflow-hidden flex shadow-3xs shrink-0">
                            <div className="w-1/2 h-full bg-slate-100 border-r border-slate-300" />
                            <div className="w-1/2 h-full bg-slate-400" />
                          </div>
                        ),
                      },
                    ].map(addon => {
                      const isOn = activeAddon === addon.id;
                      return (
                        <button
                          type="button"
                          key={addon.id}
                          role="switch"
                          aria-checked={isOn}
                          onClick={() => setFilmAddon(isOn ? 'none' : addon.id)}
                          className={`p-2.5 rounded-lg border-2 text-left transition-all cursor-pointer relative group overflow-hidden ${
                            isOn
                              ? 'border-brand-600 bg-brand-50/30 shadow-xs ring-1 ring-brand-500/20'
                              : 'border-dashed border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span aria-hidden="true" className="contents">{addon.icon}</span>
                              <span className="text-[10px] font-bold text-slate-800 tracking-tight leading-tight truncate">{addon.label}</span>
                            </div>
                            <span
                              className={`text-[8px] font-black px-1.5 py-0.5 rounded shrink-0 shadow-3xs transition-colors ${
                                isOn ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-400 group-hover:bg-slate-200 group-hover:text-slate-600'
                              }`}
                            >
                              {isOn ? 'ON' : 'OFF'}
                            </span>
                          </div>
                          <div className="text-[8px] text-slate-400 leading-normal pl-5">{addon.desc}</div>
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>

              <div className="h-px bg-slate-100 my-4" />

              {/* Surface Properties */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 mb-3 block">Surface Properties</span>
                <div className="space-y-4">
                  {[
                    { label: 'Roughness', val: frontMat.roughness, key: 'roughness' },
                    { label: 'Metalness', val: frontMat.metalness, key: 'metalness' },
                    { label: 'Emissive', val: frontMat.emissive, key: 'emissive' },
                  ].map(prop => (
                    <div key={prop.label} className="flex flex-col gap-2">
                      <div className="flex justify-between items-center">
                        <Label className="text-[11px] text-slate-500 font-medium">{prop.label}</Label>
                        <span className="text-[10px] text-slate-400 font-mono w-8 text-right">{prop.val.toFixed(2)}</span>
                      </div>
                      <Slider
                        value={[prop.val * 100]} max={100} step={1}
                        className={`[&_[role=slider]]:w-3.5 [&_[role=slider]]:h-3.5 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-600`}
                        onValueChange={(val) => {
                          const v = typeof val === 'number' ? val : val[0];
                          ['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom'].forEach(g => updateMaterial(g, { [prop.key]: v / 100 }));
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="h-px bg-slate-100 my-4" />

              {/* Scene Brightness */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 mb-3 block">Environment Lighting</span>
                <div className="space-y-4">
                  <div className="flex flex-col gap-2">
                    <div className="flex justify-between items-center">
                      <Label className="text-[11px] text-slate-500 font-medium">Global Brightness</Label>
                      <span className="text-[10px] text-slate-400 font-mono w-8 text-right">{Math.round((ambientLightIntensity / 0.8) * 50)}%</span>
                    </div>
                    <Slider
                      value={[(ambientLightIntensity / 0.8) * 50]} max={100} step={1}
                      className="[&_[role=slider]]:w-3.5 [&_[role=slider]]:h-3.5 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-600"
                      onValueChange={(val) => {
                        const v = typeof val === 'number' ? val : val[0];
                        // Convert back to ambientLightIntensity scale where 0.8 is 50%
                        setLightIntensity('ambientLightIntensity', (v / 50) * 0.8);
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="h-px bg-slate-100 my-4" />

              {/* Transparent Window Cutouts */}
              {isDesigner && (
              <div>
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 mb-3 block">Transparent Window</span>

                {/* Inner laminate seen through windows and clear film */}
                <div className="mb-3">
                  <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">Pouch inner layer</span>
                  <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Pouch inner layer">
                    {[
                      { id: 'bopp', label: 'BOPP / Transparent', desc: 'Glossy clear laminate inside', swatch: 'linear-gradient(135deg,#ffffff 0%,#e2e8f0 100%)' },
                      { id: 'met_pet', label: 'Met PET', desc: 'Shiny silver metallised', swatch: 'linear-gradient(135deg,#f1f5f9 0%,#94a3b8 50%,#e2e8f0 100%)' },
                      { id: 'milky_white', label: 'Milky White', desc: 'Opaque milky-white PE', swatch: '#f6f6f1' },
                      { id: 'matt_pet', label: 'Matt PET', desc: 'Soft frosted film', swatch: 'linear-gradient(135deg,#f8fafc 0%,#cbd5e1 100%)' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={innerLayer === opt.id}
                        onClick={() => setToggle('innerLayer', opt.id)}
                        className={`p-2 rounded-md border text-left flex items-start gap-2 transition-colors cursor-pointer ${innerLayer === opt.id ? 'border-brand-600 bg-brand-50/30' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                      >
                        <span className="w-4 h-4 rounded-full border border-slate-300 shrink-0 mt-0.5" style={{ background: opt.swatch }} />
                        <span>
                          <span className="block text-[10px] font-bold text-slate-700 leading-tight">{opt.label}</span>
                          <span className="block text-[8px] text-slate-400">{opt.desc}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {windowCutouts.length === 0 && !isClearPlastic && !isOneSideClearPlastic && (
                    <p className="text-[9px] text-slate-400 mt-1.5">Seen through a window or a clear / frosted add-on.</p>
                  )}
                </div>

                {/* Add Window Button */}
                <button
                  onClick={() => {
                    addWindowCutout({
                      id: Math.random().toString(36).substr(2, 9),
                      side: activeSide || 'Front',
                      shape: 'rectangle',
                      // x/y are the window centre
                      x: 50,
                      y: 50,
                      width: 40,
                      height: 30,
                      cornerRadius: 10,
                      anchor: 'center',
                    } as any);
                  }}
                  className="w-full mb-3 py-2 px-3 bg-brand-50 hover:bg-brand-100 text-brand-700 text-[11px] font-bold rounded-lg border border-brand-200 transition-colors flex items-center justify-center gap-1.5"
                >
                  <span className="text-sm">＋</span> Add Window
                </button>
                            {/* Unit Selector */}
                <div className="flex items-center justify-between mb-3 bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                  <span className="text-[10px] text-slate-500 font-bold px-2">Display Unit</span>
                  <div className="flex">
                    {([
                      { id: '%', label: '%' },
                      { id: 'cm', label: 'cm' },
                      { id: 'in', label: 'inch' }
                    ] as const).map(u => (
                      <button
                        key={u.id}
                        onClick={() => setWindowUnit(u.id)}
                        className={`text-[9px] font-extrabold px-2.5 py-1 rounded transition-all ${windowUnit === u.id ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        {u.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Window List */}
                <div className="space-y-3">
                  {windowCutouts.map((win, idx) => {
                    const scaleX = sizeScale?.[0] ?? 1;
                    const scaleY = sizeScale?.[1] ?? 1;
                    const scaleZ = sizeScale?.[2] ?? 1;

                    const lenCm = scaleX * 15;
                    const heightCm = scaleY * 20;
                    const widthCm = scaleZ * 5;

                    const getSideDimensions = (sideName: string) => {
                      switch (sideName) {
                        case 'Left':
                        case 'Right':
                          return { w: widthCm, h: heightCm };
                        case 'Top':
                        case 'Bottom':
                          return { w: lenCm, h: widthCm };
                        case 'Front':
                        case 'Back':
                        default:
                          return { w: lenCm, h: heightCm };
                      }
                    };

                    const dims = getSideDimensions(win.side);
                    const minSide = Math.min(dims.w, dims.h);

                    const getCtrlProps = (key: 'x' | 'y' | 'width' | 'height') => {
                      let val = 0;
                      let max = 100;
                      let suffix = '%';
                      let step = 1;

                      const isW = key === 'x' || key === 'width';
                      const sideDim = isW ? dims.w : dims.h;

                      if (windowUnit === '%') {
                        val = (win as any)[key];
                        max = 100;
                        suffix = '%';
                        step = 1;
                      } else if (windowUnit === 'cm') {
                        val = ((win as any)[key] / 100) * sideDim;
                        max = sideDim;
                        suffix = ' cm';
                        step = 0.1;
                      } else {
                        val = ((win as any)[key] / 100) * sideDim * 0.393701;
                        max = sideDim * 0.393701;
                        suffix = ' in';
                        step = 0.05;
                      }

                      const onChange = (v: number) => {
                        let pct = 0;
                        if (windowUnit === '%') {
                          pct = v;
                        } else if (windowUnit === 'cm') {
                          pct = (v / sideDim) * 100;
                        } else {
                          pct = ((v / 0.393701) / sideDim) * 100;
                        }
                        pct = Math.max(0, Math.min(100, pct));
                        updateWindowCutout(win.id, { [key]: pct });
                      };

                      return { val, max, suffix, step, onChange };
                    };

                    const getCornerProps = () => {
                      let val = win.cornerRadius;
                      let max = 50;
                      let suffix = '%';
                      let step = 1;

                      if (windowUnit === '%') {
                        val = win.cornerRadius;
                        max = 50;
                        suffix = '%';
                        step = 1;
                      } else if (windowUnit === 'cm') {
                        val = (win.cornerRadius / 100) * minSide;
                        max = minSide * 0.5;
                        suffix = ' cm';
                        step = 0.1;
                      } else {
                        val = (win.cornerRadius / 100) * minSide * 0.393701;
                        max = minSide * 0.5 * 0.393701;
                        suffix = ' in';
                        step = 0.05;
                      }

                      const onChange = (v: number) => {
                        let pct = 0;
                        if (windowUnit === '%') {
                          pct = v;
                        } else if (windowUnit === 'cm') {
                          pct = (v / minSide) * 100;
                        } else {
                          pct = ((v / 0.393701) / minSide) * 100;
                        }
                        pct = Math.max(0, Math.min(50, pct));
                        updateWindowCutout(win.id, { cornerRadius: pct });
                      };

                      return { val, max, suffix, step, onChange };
                    };

                    const ctrlX = getCtrlProps('x');
                    const ctrlY = getCtrlProps('y');
                    const ctrlW = getCtrlProps('width');
                    const ctrlH = getCtrlProps('height');
                    const ctrlC = getCornerProps();

                    return (
                      <div key={win.id} className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2.5">
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] font-bold text-slate-600">Window {idx + 1}</span>
                          <button onClick={() => removeWindowCutout(win.id)} className="text-red-400 hover:text-red-600 text-[10px] font-bold px-1.5 py-0.5 rounded hover:bg-red-50 transition-colors">✕ Remove</button>
                        </div>

                        {/* Side Selector */}
                        <div>
                          <Label className="text-[10px] text-slate-400 font-bold mb-1 block">Side</Label>
                          <div className="grid grid-cols-3 gap-1">
                            {['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom'].map(s => (
                              <button key={s} onClick={() => updateWindowCutout(win.id, { side: s })}
                                className={`text-[9px] font-bold py-1 rounded transition-colors ${win.side === s ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-500 hover:bg-slate-100'}`}
                              >{s}</button>
                            ))}
                          </div>
                        </div>

                        {/* Shape Selector */}
                        <div>
                          <Label className="text-[10px] text-slate-400 font-bold mb-1 block">Shape</Label>
                          <div className="grid grid-cols-4 gap-1">
                            {([
                              { id: 'rectangle', label: '▬', tip: 'Rectangle' },
                              { id: 'rounded-rect', label: '▢', tip: 'Rounded' },
                              { id: 'circle', label: '●', tip: 'Circle' },
                              { id: 'oval', label: '⬭', tip: 'Oval' },
                            ] as const).map(sh => (
                              <button key={sh.id} title={sh.tip} onClick={() => updateWindowCutout(win.id, { shape: sh.id })}
                                className={`text-[12px] py-1 rounded transition-colors ${win.shape === sh.id ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-500 hover:bg-slate-100'}`}
                              >{sh.label}</button>
                            ))}
                          </div>
                        </div>

                        {/* Interactive 2D Joystick Pad */}
                        <div className="flex flex-col">
                          <Label className="text-[10px] text-slate-400 font-bold mb-1.5">2D Position Joystick</Label>
                          <div
                            style={{ aspectRatio: `${dims.w} / ${dims.h}`, maxHeight: '11rem' }}
                            className="mx-auto w-full bg-slate-900/5 hover:bg-slate-900/[0.08] active:bg-slate-900/[0.1] border border-slate-200 rounded-xl relative overflow-hidden backdrop-blur-sm cursor-crosshair shadow-inner transition-colors duration-200 flex items-center justify-center"
                            onMouseDown={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();

                              const updatePosFromEvent = (moveEvent: MouseEvent) => {
                                const rawX = ((moveEvent.clientX - rect.left) / rect.width) * 100;
                                const rawY = ((moveEvent.clientY - rect.top) / rect.height) * 100;

                                const x = Math.max(0, Math.min(100, Math.round(rawX)));
                                const y = Math.max(0, Math.min(100, Math.round(rawY)));

                                updateWindowCutout(win.id, { x, y });
                              };

                              updatePosFromEvent(e.nativeEvent);

                              const handleMouseMove = (moveEvent: MouseEvent) => {
                                updatePosFromEvent(moveEvent);
                              };

                              const handleMouseUp = () => {
                                window.removeEventListener('mousemove', handleMouseMove);
                                window.removeEventListener('mouseup', handleMouseUp);
                              };

                              window.addEventListener('mousemove', handleMouseMove);
                              window.addEventListener('mouseup', handleMouseUp);
                            }}
                          >
                            {/* Inner grid lines for visual guidance */}
                            <div className="absolute inset-0 pointer-events-none opacity-[0.03] flex flex-col justify-between p-2">
                              <div className="w-full h-px bg-slate-950" />
                              <div className="w-full h-px bg-slate-950" />
                              <div className="w-full h-px bg-slate-950" />
                            </div>
                            <div className="absolute inset-0 pointer-events-none opacity-[0.03] flex justify-between p-2">
                              <div className="w-px h-full bg-slate-950" />
                              <div className="w-px h-full bg-slate-950" />
                              <div className="w-px h-full bg-slate-950" />
                            </div>

                            {/* Pouch bounds / crosshair center */}
                            <div className="absolute inset-x-0 h-px border-t border-dashed border-slate-200/50 pointer-events-none" />
                            <div className="absolute inset-y-0 w-px border-l border-dashed border-slate-200/50 pointer-events-none" />

                            {/* Dotted window cutout shape preview */}
                            <div
                              style={{
                                left: `${win.x}%`,
                                top: `${win.y}%`,
                                width: `${win.width}%`,
                                height: `${win.shape === 'circle' ? win.width * dims.w / dims.h : win.height}%`,
                                transform: 'translate(-50%, -50%)',
                              }}
                              className={`border-2 border-dashed border-brand-500/50 bg-brand-500/[0.08] pointer-events-none absolute shadow-sm ${
                                win.shape === 'circle' ? 'rounded-full' :
                                win.shape === 'oval' ? 'rounded-[50%]' :
                                win.shape === 'rounded-rect' ? 'rounded-lg' : 'rounded-none'
                              }`}
                            />

                            {/* Position coordinates indicator */}
                            <div className="absolute bottom-1.5 right-2 pointer-events-none text-[8px] font-mono text-slate-500 font-bold bg-white/90 backdrop-blur-[1px] px-1.5 py-0.5 rounded border border-slate-200/50 shadow-sm select-none">
                              {windowUnit === '%' ? (
                                `X: ${win.x.toFixed(0)}%, Y: ${win.y.toFixed(0)}%`
                              ) : windowUnit === 'cm' ? (
                                `X: ${((win.x / 100) * dims.w).toFixed(1)}cm, Y: ${((win.y / 100) * dims.h).toFixed(1)}cm`
                              ) : (
                                `X: ${((win.x / 100) * dims.w * 0.393701).toFixed(2)}in, Y: ${((win.y / 100) * dims.h * 0.393701).toFixed(2)}in`
                              )}
                            </div>

                            {/* Draggable Knob (Joystick head) */}
                            <div
                              style={{
                                left: `${win.x}%`,
                                top: `${win.y}%`,
                                transform: 'translate(-50%, -50%)',
                              }}
                              className={`bg-brand-600 border-2 border-white absolute shadow-md flex items-center justify-center pointer-events-none transition-all duration-200 ${
                                win.shape === 'circle' ? 'w-4 h-4 rounded-full' :
                                win.shape === 'oval' ? 'w-5 h-3.5 rounded-[50%]' :
                                win.shape === 'rounded-rect' ? 'w-5 h-3.5 rounded-[4px]' :
                                'w-5 h-3.5 rounded-none'
                              }`}
                            >
                              <div
                                className={`bg-white transition-all duration-200 ${
                                  win.shape === 'circle' ? 'w-1.5 h-1.5 rounded-full' :
                                  win.shape === 'oval' ? 'w-2.5 h-1 rounded-[50%]' :
                                  win.shape === 'rounded-rect' ? 'w-2.5 h-1 rounded-[1px]' :
                                  'w-2.5 h-1 rounded-none'
                                }`}
                              />
                            </div>
                          </div>
                        </div>

                               <div className="h-px bg-slate-200/60 my-2" />

                        {/* Positioning Section */}
                        <div className="space-y-2.5">
                          <span className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400 block mb-1">Positioning</span>

                          {([
                            { label: 'X Position', key: 'x' as const, ctrl: ctrlX },
                            { label: 'Y Position', key: 'y' as const, ctrl: ctrlY },
                          ]).map(item => (
                            <div key={item.key}>
                              <div className="flex justify-between items-center mb-1">
                                <Label className="text-[10px] text-slate-400 font-medium">{item.label}</Label>
                                <span className="text-[9px] text-slate-400 font-mono font-bold bg-slate-100 px-1 py-0.5 rounded">{item.ctrl.val.toFixed(windowUnit === '%' ? 0 : 2)}{item.ctrl.suffix}</span>
                              </div>
                              <div className="flex gap-2 items-center">
                                <Slider value={[item.ctrl.val]} max={item.ctrl.max} min={0} step={item.ctrl.step}
                                  className="flex-1 [&_[role=slider]]:w-3 [&_[role=slider]]:h-3 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-600"
                                  onValueChange={(v) => item.ctrl.onChange(typeof v === 'number' ? v : v[0])}
                                />
                                <input
                                  type="number"
                                  value={Number(item.ctrl.val.toFixed(windowUnit === '%' ? 0 : 2))}
                                  step={item.ctrl.step}
                                  onChange={(e) => {
                                    const num = Number(e.target.value);
                                    if (!isNaN(num)) {
                                      item.ctrl.onChange(num);
                                    }
                                  }}
                                  className="w-14 h-6 px-1 text-[9px] text-center font-bold font-mono bg-white border border-slate-200 rounded outline-none focus:border-brand-500 shrink-0 shadow-sm"
                                />
                              </div>
                            </div>
                          ))}
                        </div>

                        <div className="h-px bg-slate-200/60 my-2" />

                        {/* Window Dimensions Section */}
                        <div className="space-y-2.5">
                          <span className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400 block mb-1">Window Dimensions (Size)</span>

                          {(win.shape === 'circle'
                            ? [{ label: 'Diameter', key: 'width' as const, ctrl: { ...ctrlW, onChange: (v: number) => {
                                ctrlW.onChange(v);
                                // Same physical size vertically, so the stored height matches the circle
                                const pctW = windowUnit === '%' ? v : windowUnit === 'cm' ? (v / dims.w) * 100 : ((v / 0.393701) / dims.w) * 100;
                                updateWindowCutout(win.id, { height: Math.max(0, Math.min(100, pctW * dims.w / dims.h)) });
                              } } }]
                            : [
                              { label: 'Width', key: 'width' as const, ctrl: ctrlW },
                              { label: 'Height', key: 'height' as const, ctrl: ctrlH },
                            ]).map(item => (
                            <div key={item.key}>
                              <div className="flex justify-between items-center mb-1">
                                <Label className="text-[10px] text-slate-400 font-medium">{item.label}</Label>
                                <span className="text-[9px] text-slate-400 font-mono font-bold bg-slate-100 px-1 py-0.5 rounded">{item.ctrl.val.toFixed(windowUnit === '%' ? 0 : 2)}{item.ctrl.suffix}</span>
                              </div>
                              <div className="flex gap-2 items-center">
                                <Slider value={[item.ctrl.val]} max={item.ctrl.max} min={0} step={item.ctrl.step}
                                  className="flex-1 [&_[role=slider]]:w-3 [&_[role=slider]]:h-3 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-600"
                                  onValueChange={(v) => item.ctrl.onChange(typeof v === 'number' ? v : v[0])}
                                />
                                <input
                                  type="number"
                                  value={Number(item.ctrl.val.toFixed(windowUnit === '%' ? 0 : 2))}
                                  step={item.ctrl.step}
                                  onChange={(e) => {
                                    const num = Number(e.target.value);
                                    if (!isNaN(num)) {
                                      item.ctrl.onChange(num);
                                    }
                                  }}
                                  className="w-14 h-6 px-1 text-[9px] text-center font-bold font-mono bg-white border border-slate-200 rounded outline-none focus:border-brand-500 shrink-0 shadow-sm"
                                />
                              </div>
                            </div>
                          ))}

                          {/* Corner Radius (only for rounded-rect) */}
                          {win.shape === 'rounded-rect' && (
                            <div>
                              <div className="flex justify-between items-center mb-1">
                                <Label className="text-[10px] text-slate-400 font-medium">Corner Radius</Label>
                                <span className="text-[9px] text-slate-400 font-mono font-bold bg-slate-100 px-1 py-0.5 rounded">{ctrlC.val.toFixed(windowUnit === '%' ? 0 : 2)}{ctrlC.suffix}</span>
                              </div>
                              <div className="flex gap-2 items-center">
                                <Slider value={[ctrlC.val]} max={ctrlC.max} min={0} step={ctrlC.step}
                                  className="flex-1 [&_[role=slider]]:w-3 [&_[role=slider]]:h-3 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-600"
                                  onValueChange={(v) => ctrlC.onChange(typeof v === 'number' ? v : v[0])}
                                />
                                <input
                                  type="number"
                                  value={Number(ctrlC.val.toFixed(windowUnit === '%' ? 0 : 2))}
                                  step={ctrlC.step}
                                  onChange={(e) => {
                                    const num = Number(e.target.value);
                                    if (!isNaN(num)) {
                                      ctrlC.onChange(num);
                                    }
                                  }}
                                  className="w-14 h-6 px-1 text-[9px] text-center font-bold font-mono bg-white border border-slate-200 rounded outline-none focus:border-brand-500 shrink-0 shadow-sm"
                                />
                              </div>
                            </div>
                          )}
                        </div>

                      </div>
                    );
                  })}
                </div>
              </div>
              )}
            </div>
          </TabsContent>

          {/* SIZE TAB */}
          <TabsContent value="size" className="p-5 m-0 outline-none">
            <div className="space-y-6">

              {/* DIMENSIONS CONTROLLER */}
              <div>
                 <div className="flex justify-between items-center mb-3">
                  <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Pouch Dimensions</span>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Reset Transform Button */}
                    <button
                      onClick={() => {
                        resetModelPosition();
                      }}
                      className={`text-[9px] font-extrabold px-2 py-1 rounded bg-slate-100 text-slate-600 transition-colors hover:bg-slate-200`}
                    >
                      Reset Defaults
                    </button>

                    {/* Premium unit switcher */}
                    <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200 shrink-0">
                      <button
                        onClick={() => setUnit('cm')}
                        className={`text-[9px] font-extrabold px-2 py-0.5 rounded transition-all ${unit === 'cm' ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        CM
                      </button>
                      <button
                        onClick={() => setUnit('in')}
                        className={`text-[9px] font-extrabold px-2 py-0.5 rounded transition-all ${unit === 'in' ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        INCHES
                      </button>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-50 rounded-xl p-3.5 border border-slate-200/60 space-y-3">
                  {[
                    { label: 'Length (X)', index: 0, step: unit === 'cm' ? 0.5 : 0.2, ref: 15, valStr: lengthInput, setValStr: setLengthInput },
                    { label: 'Height (Y)', index: 1, step: unit === 'cm' ? 0.5 : 0.2, ref: 20, valStr: heightInput, setValStr: setHeightInput },
                    { label: 'Width (Z)', index: 2, step: unit === 'cm' ? 0.2 : 0.1, ref: 5, valStr: widthInput, setValStr: setWidthInput },
                  ].map(dim => {
                    const scaleFactor = sizeScale?.[dim.index] ?? 1;
                    const valInCm = dim.ref * scaleFactor;
                    const currentVal = Number((unit === 'cm' ? valInCm : valInCm * 0.393701).toFixed(unit === 'cm' ? 1 : 2));

                    const handleChange = (newVal: number) => {
                      if (isNaN(newVal) || newVal <= 0) return;
                      const newValInCm = unit === 'cm' ? newVal : newVal * 2.54;
                      const newScale = Math.max(0.1, Math.min(5, newValInCm / dim.ref));
                      const newSizeScale = [...(sizeScale ?? [1, 1, 1])] as [number, number, number];
                      newSizeScale[dim.index] = newScale;
                      setSizeScale(newSizeScale);
                    };

                    const handleTextChange = (text: string) => {
                      dim.setValStr(text);
                      const parsed = parseFloat(text);
                      if (!isNaN(parsed) && parsed > 0) {
                        handleChange(parsed);
                      }
                    };

                    return (
                      <div key={dim.label} className="flex items-center justify-between gap-3">
                        <Label className="text-[10px] text-slate-600 font-bold tracking-wide uppercase shrink-0">{dim.label}</Label>

                        <div className="flex items-center bg-white rounded-lg border border-slate-200 overflow-hidden shadow-sm shrink-0 h-8">
                          {/* Minus Stepper */}
                          <button
                            onClick={() => {
                              const nextVal = Math.max(0.1, currentVal - dim.step);
                              handleChange(nextVal);
                              dim.setValStr(nextVal.toFixed(unit === 'cm' ? 1 : 2));
                            }}
                            className={`px-2.5 h-full text-slate-500 font-extrabold border-r border-slate-200 transition-colors flex items-center justify-center text-xs hover:bg-slate-50`}
                          >
                            -
                          </button>

                          {/* Input */}
                          <input
                            type="text"
                            inputMode="decimal"
                            value={dim.valStr}
                            onFocus={() => {
                              setFocusedIndex(dim.index);
                            }}
                            onBlur={() => setFocusedIndex(null)}
                            onChange={(e) => {
                              handleTextChange(e.target.value);
                            }}
                            className={`w-14 text-center text-xs font-bold text-slate-700 focus:outline-none `}
                          />

                          {/* Plus Stepper */}
                          <button
                            onClick={() => {
                              const nextVal = currentVal + dim.step;
                              handleChange(nextVal);
                              dim.setValStr(nextVal.toFixed(unit === 'cm' ? 1 : 2));
                            }}
                            className={`px-2.5 h-full text-slate-500 font-extrabold border-l border-slate-200 transition-colors flex items-center justify-center text-xs hover:bg-slate-50`}
                          >
                            +
                          </button>

                          {/* Suffix */}
                          <span className="px-2 text-[8px] font-extrabold text-slate-400 bg-slate-50/80 border-l border-slate-200 uppercase flex items-center h-full">
                            {unit}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="h-px bg-slate-100 my-4" />

              <div>
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 mb-3 block">Scale</span>
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between items-center">
                    <Label className="text-[11px] text-slate-500 font-medium">Uniform Zoom</Label>
                    <span className="text-[10px] text-slate-400 font-mono">{Math.round(scale * 100)}%</span>
                  </div>
                  <Slider
                    value={[scale * 100]} min={20} max={200} step={1}
                    className={`[&_[role=slider]]:w-3.5 [&_[role=slider]]:h-3.5 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-600`}
                    onValueChange={(val) => {
                      setScale((typeof val === 'number' ? val : val[0]) / 100);
                    }}
                  />
                </div>
              </div>

              <div className="h-px bg-slate-100 my-4" />

              <div>
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 mb-3 block">Display</span>
                <div className="space-y-3">
                  {[
                    { label: 'Grid', val: showGrid, key: 'showGrid' },
                    { label: 'Contact Shadow', val: showShadow, key: 'showShadow' },
                    { label: 'Display Table', val: showTable, key: 'showTable' },
                    { label: 'Float Animation', val: enableFloat, key: 'enableFloat' },
                  ].map(prop => (
                    <div key={prop.label} className="flex items-center justify-between">
                      <Label className="text-[11px] text-slate-500 font-medium">{prop.label}</Label>
                      <label className={`relative inline-flex items-center cursor-pointer`}>
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={prop.val}
                          onChange={(e) => {
                            setToggle(prop.key as any, e.target.checked);
                          }}
                        />
                        <div className={`w-9 h-5 rounded-full peer peer-focus:outline-none after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all bg-slate-200 peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:bg-brand-600`}></div>
                      </label>
                    </div>
                  ))}

                  {/* Table Texture Upload */}
                  {showTable && (
                    <div className="flex flex-col gap-2 pt-2 pb-2 bg-slate-50/50 p-3 rounded-lg border border-slate-100 animate-in fade-in slide-in-from-top-1">
                      <div className="flex justify-between items-center mb-1">
                        <Label className="text-[11px] text-slate-500 font-medium">Table Surface Material</Label>
                        {tableTexture && (
                          <button
                            onClick={() => setTableTexture(null)}
                            className="text-[9px] text-red-500 hover:bg-red-50 px-1.5 py-0.5 rounded transition-colors font-bold"
                          >
                            Reset
                          </button>
                        )}
                      </div>

                      <label className="flex items-center justify-center gap-2 p-2 border border-dashed border-slate-300 rounded hover:border-brand-400 hover:bg-brand-50 cursor-pointer transition-colors group">
                        <UploadCloud className="w-3.5 h-3.5 text-slate-400 group-hover:text-brand-500 transition-colors" />
                        <span className="text-[10px] font-semibold text-slate-500 group-hover:text-brand-600 transition-colors">Upload Texture</span>
                        <input
                          type="file" onClick={(e) => { e.currentTarget.value = ""; }}
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              const reader = new FileReader();
                              reader.onload = (event) => {
                                if (typeof event.target?.result === 'string') {
                                  setTableTexture(event.target.result);
                                }
                              };
                              reader.readAsDataURL(file);
                            }
                          }}
                        />
                      </label>
                      {tableTexture && (
                        <div className="relative w-full h-16 rounded overflow-hidden border border-slate-200 mt-1">
                          <img src={tableTexture} alt="Table Texture Preview" className="w-full h-full object-cover" />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Punch Type Dropdown */}
                  <div className="flex flex-col gap-3 pt-3 border-t border-slate-100">
                    <div className="flex items-center justify-between">
                      <Label className="text-[11px] text-slate-500 font-medium">Punch Type</Label>
                      <select
                        value={punchType}
                        onChange={(e) => setToggle('punchType' as any, e.target.value)}
                        className={`text-[10px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded px-2 py-1 outline-none cursor-pointer hover:border-brand-400 focus:border-brand-500`}
                      >
                        <option value="none">None</option>
                        <option value="butterfly">Butterfly Punch</option>
                        <option value="round">Round Hole</option>
                        <option value="d-punch">D-Punch</option>
                      </select>
                    </div>

                    {punchType !== 'none' && (
                      <div className="space-y-3 bg-slate-50/50 p-3 rounded-lg border border-slate-100">
                        {/* Size Slider */}
                        <div className="flex flex-col gap-2">
                          <div className="flex justify-between items-center">
                            <Label className="text-[10px] text-slate-500 font-medium">Size Scale</Label>
                            <span className="text-[9px] text-slate-400 font-mono">{punchSize.toFixed(1)}x</span>
                          </div>
                          <Slider
                            value={[punchSize * 100]} min={50} max={200} step={10}
                            className={`[&_[role=slider]]:w-3 [&_[role=slider]]:h-3 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-500`}
                            onValueChange={(val) => {
                              setToggle('punchSize' as any, (typeof val === 'number' ? val : val[0]) / 100);
                            }}
                          />
                        </div>

                        {/* Position Slider */}
                        <div className="flex flex-col gap-2">
                          <div className="flex justify-between items-center">
                            <Label className="text-[10px] text-slate-500 font-medium">Vertical Position</Label>
                            <span className="text-[9px] text-slate-400 font-mono">{punchPositionY}</span>
                          </div>
                          <Slider
                            value={[punchPositionY]} min={10} max={300} step={1}
                            className={`[&_[role=slider]]:w-3 [&_[role=slider]]:h-3 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-500`}
                            onValueChange={(val) => {
                              setToggle('punchPositionY' as any, typeof val === 'number' ? val : val[0]);
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Spout Sizing */}
                  {fileName?.toLowerCase().includes('spout') && (
                    <div className="flex flex-col gap-3 pt-3 border-t border-slate-100">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] text-slate-500 font-medium">Spout Size</Label>
                        <span className="text-[9px] text-slate-400 font-mono">{spoutSize}mm</span>
                      </div>
                      <Slider
                        value={[spoutSize]} min={5} max={30} step={1}
                        className={`[&_[role=slider]]:w-3 [&_[role=slider]]:h-3 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-500`}
                        onValueChange={(val) => {
                          setToggle('spoutSize' as any, typeof val === 'number' ? val : val[0]);
                        }}
                      />
                    </div>
                  )}

                  {/* Corner Style Editor */}
                  <div className="flex flex-col gap-3 pt-3 border-t border-slate-100">
                    <div className="flex items-center justify-between">
                      <Label className="text-[11px] text-slate-500 font-medium">Corner Cuts</Label>
                      <button
                        onClick={() => setToggle('linkCorners' as any, !linkCorners)}
                        className={`p-1.5 rounded-md transition-colors ${linkCorners ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-400 hover:text-slate-600'}`}
                        title={linkCorners ? "Unlink corners to edit individually" : "Link all corners"}
                      >
                        {linkCorners ? <LinkIcon className="w-3 h-3" /> : <Unlink className="w-3 h-3" />}
                      </button>
                    </div>

                    {linkCorners ? (
                      <div className="space-y-3 bg-slate-50/50 p-3 rounded-lg border border-slate-100">
                        <div className="flex justify-between items-center">
                          <Label className="text-[10px] text-slate-500">Style</Label>
                          <select
                            value={cornerStyles[0]}
                            onChange={(e) => {
                              const val = e.target.value;
                              setToggle('cornerStyles' as any, [val, val, val, val]);
                            }}
                            className={`text-[10px] font-bold text-slate-600 bg-white border border-slate-200 rounded px-2 py-1 outline-none cursor-pointer hover:border-brand-400`}
                          >
                            <option value="none">Square</option>
                            <option value="round">Round</option>
                            <option value="angle">Angled</option>
                          </select>
                        </div>
                        {cornerStyles[0] !== 'none' && (
                          <div className="flex flex-col gap-2 pt-1 border-t border-slate-200/50">
                            <div className="flex justify-between items-center">
                              <Label className="text-[10px] text-slate-500">Size</Label>
                              <span className="text-[9px] text-slate-400 font-mono">{cornerSizes[0]}px</span>
                            </div>
                            <Slider
                              value={[cornerSizes[0]]} min={1} max={150} step={1}
                              className="[&_[role=slider]]:w-3 [&_[role=slider]]:h-3 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-500"
                              onValueChange={(val) => {
                                const v = typeof val === 'number' ? val : val[0];
                                setToggle('cornerSizes' as any, [v, v, v, v]);
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: 'Top Left', idx: 0 }, { label: 'Top Right', idx: 1 },
                          { label: 'Bottom Left', idx: 3 }, { label: 'Bottom Right', idx: 2 } // Visual mapping
                        ].map(({ label, idx }) => (
                          <div key={label} className="bg-slate-50/50 p-2 rounded-lg border border-slate-100 flex flex-col gap-2">
                            <div className="flex justify-between items-center mb-1">
                              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>
                            </div>
                            <select
                              value={cornerStyles[idx]}
                              onChange={(e) => {
                                const newStyles = [...cornerStyles];
                                newStyles[idx] = e.target.value as any;
                                setToggle('cornerStyles' as any, newStyles);
                              }}
                              className={`text-[10px] font-medium text-slate-600 bg-white border border-slate-200 rounded px-1.5 py-0.5 outline-none cursor-pointer`}
                            >
                              <option value="none">Square</option>
                              <option value="round">Round</option>
                              <option value="angle">Angled</option>
                            </select>
                            {cornerStyles[idx] !== 'none' && (
                              <div className="pt-1">
                                <Slider
                                  value={[cornerSizes[idx]]} min={1} max={150} step={1}
                                  className="[&_[role=slider]]:w-2.5 [&_[role=slider]]:h-2.5 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-brand-500"
                                  onValueChange={(val) => {
                                    const newSizes = [...cornerSizes];
                                    newSizes[idx] = typeof val === 'number' ? val : val[0];
                                    setToggle('cornerSizes' as any, newSizes);
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

            </div>
          </TabsContent>



          {/* AI TAB */}
          <TabsContent value="ai" className="p-0 m-0 outline-none flex flex-col min-h-[calc(100vh-140px)] relative bg-white">
            <div className="flex-1 p-4 flex flex-col justify-end">
              <div className="space-y-6 pb-4">
                {chatHistory.length === 0 && (
                  <div className="flex flex-col justify-center min-h-[400px] animate-in fade-in slide-in-from-bottom-4 duration-700">
                    <div className="mb-8">
                      <h2 className="text-3xl font-semibold tracking-tight text-slate-800 mb-2">
                        <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-500 via-brand-500 to-purple-500">
                          Hello, Designer
                        </span>
                      </h2>
                      <p className="text-2xl text-slate-400 font-medium tracking-tight">How can I help you package today?</p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {['Minimalist sustainable coffee brand', 'Vibrant organic snack pouch', 'Luxury matte black cosmetic box', 'Earthy tones, clean sans-serif'].map(suggestion => (
                        <button
                          key={suggestion}
                          onClick={() => setAiPrompt(suggestion)}
                          className="text-left p-4 rounded-2xl bg-slate-50 hover:bg-slate-100 transition-colors border border-slate-100 text-xs text-slate-600 font-medium"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {chatHistory.map((msg) => (
                  <div key={msg.id} className={`flex w-full ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.sender === 'ai' && (
                      <div className="mr-3 mt-1 shrink-0">
                        <Sparkles className="w-5 h-5 text-brand-500" />
                      </div>
                    )}

                    <div
                      className={`max-w-[85%] ${
                        msg.sender === 'user'
                          ? 'bg-slate-100 text-slate-800 rounded-3xl rounded-tr-md px-5 py-3.5 text-sm font-medium'
                          : 'text-slate-800 text-sm leading-relaxed mt-1'
                      }`}
                    >
                      {msg.refImage && (
                        <div className="mb-3 rounded-2xl overflow-hidden border border-slate-200">
                          <img src={msg.refImage} alt="Reference" className="w-full max-h-40 object-cover" />
                        </div>
                      )}

                      <p className="whitespace-pre-wrap">{msg.text}</p>

                      {msg.imageUrl && (
                        <div className="mt-4 space-y-4 max-w-sm">
                          <div className="rounded-2xl overflow-hidden border border-slate-200 bg-slate-50 shadow-sm flex items-center justify-center p-2">
                            <img src={msg.imageUrl} alt="AI Generated Design" className="w-full h-auto rounded-xl object-contain" />
                          </div>

                          {!msg.isLifestyle && (
                            <button
                              className="bg-white border border-slate-200 hover:bg-slate-50 shadow-sm text-slate-700 rounded-full py-2 px-4 text-xs font-semibold flex items-center gap-2 transition-colors"
                              onClick={() => {
                                const sideToApply = (activeSide?.toLowerCase() || 'front') as keyof typeof textures;
                                setTexture(sideToApply, msg.imageUrl!);
                              }}
                            >
                              <PaintBucket className="w-3.5 h-3.5 text-brand-500" />
                              Apply to {activeSide || 'Front'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {isGenerating && (
                  <div className="flex w-full justify-start animate-in fade-in duration-500">
                    <div className="mr-3 mt-1 shrink-0">
                      <Sparkles className="w-5 h-5 text-brand-500 animate-pulse" />
                    </div>
                    <div className="mt-2 flex gap-1.5 items-center">
                      <span className="w-2 h-2 bg-gradient-to-r from-blue-400 to-brand-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-2 h-2 bg-gradient-to-r from-brand-400 to-purple-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-2 h-2 bg-gradient-to-r from-purple-400 to-pink-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                )}

                <div ref={chatEndRef} className="h-4" />
              </div>
            </div>

            <div className="sticky bottom-0 p-4 bg-gradient-to-t from-white via-white/90 to-transparent pt-10 shrink-0 z-20">
              <div className="max-w-2xl mx-auto">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex gap-2">
                    <button
                      className="text-[10px] font-bold bg-white border border-brand-200 text-brand-600 hover:bg-brand-50 hover:border-brand-300 px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm transition-all"
                      onClick={generateLifestylePhoto}
                      disabled={isGenerating}
                    >
                      <span>📸</span> Create Lifestyle Photo
                    </button>
                  </div>

                  {aiRefImage && (
                    <div className="relative inline-block border border-slate-200 rounded-xl overflow-hidden bg-slate-50 shadow-sm ml-4">
                      <img src={aiRefImage} alt="Reference" className="w-10 h-10 object-cover" />
                      <button
                        className="absolute top-0.5 right-0.5 bg-slate-800 text-white p-0.5 rounded-full scale-75 hover:bg-slate-900 transition-colors"
                        onClick={() => setAiRefImage(null)}
                        disabled={isGenerating}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex items-end gap-2 bg-slate-100 rounded-[24px] p-2 pr-3 focus-within:bg-slate-200/50 focus-within:shadow-inner transition-all border border-transparent focus-within:border-slate-200">
                  <label className="shrink-0 p-2 text-slate-500 hover:text-slate-800 cursor-pointer transition-colors" title="Upload Image">
                    <ImageIcon className="w-5 h-5" />
                    <input type="file" onClick={(e) => { e.currentTarget.value = ""; }} accept="image/*" className="hidden" onChange={handleAiRefUpload} disabled={isGenerating} />
                  </label>

                  <textarea
                    className="w-full bg-transparent border-none text-sm text-slate-800 resize-none outline-none py-2.5 max-h-40 min-h-[40px] font-medium placeholder:text-slate-500 placeholder:font-normal"
                    rows={1}
                    placeholder="Ask Nano Banana AI..."
                    value={aiPrompt}
                    disabled={isGenerating}
                    onChange={e => {
                      setAiPrompt(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        generateAiDesign();
                      }
                    }}
                  />

                  {aiPrompt.trim() ? (
                    <button
                      className="shrink-0 p-2 mb-0.5 bg-black hover:bg-slate-800 text-white rounded-full transition-all duration-200 animate-in fade-in zoom-in"
                      onClick={generateAiDesign}
                      disabled={isGenerating || !aiPrompt.trim()}
                    >
                      <Send className="w-4 h-4 ml-0.5" />
                    </button>
                  ) : (
                    <div className="shrink-0 p-2 mb-0.5 w-8 h-8" />
                  )}
                </div>
                <p className="text-center text-[10px] text-slate-400 mt-3 font-medium">AI can make mistakes. Verify applied designs.</p>
              </div>
            </div>
          </TabsContent>
        </ScrollArea>
      </Tabs>

      {/* Attach Doc floating button - visible for designers (Designer, Head of Designer, Administrator) */}
      {isDesigner && (
        <div className="absolute top-28 -left-10 z-50">
          <button
            onClick={() => setIsDocPanelOpen(!isDocPanelOpen)}
            className={`w-10 h-10 rounded-l-xl border border-r-0 flex items-center justify-center transition-all duration-300 shadow-md ${
              isDocPanelOpen
                ? 'bg-slate-900 border-slate-900 text-white'
                : documentName
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-600 hover:bg-emerald-100'
                  : 'bg-white border-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
            title={documentName ? `Attachment: ${documentName}` : "Attach Document/Brief"}
          >
            <Paperclip className="w-4 h-4" />
            {documentName && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-emerald-500 rounded-full border border-white animate-pulse" />
            )}
          </button>
        </div>
      )}

      {/* Slide-out Attachment Drawer */}
      {isDocPanelOpen && isDesigner && (
        <div
          className="absolute right-full top-28 mr-2 w-[300px] bg-white border border-slate-200 rounded-2xl shadow-xl p-5 z-40 animate-in fade-in slide-in-from-right-5 duration-300 backdrop-blur-md"
        >
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
              <Paperclip className="w-3.5 h-3.5 text-brand-600" />
              Design brief & specs
            </h3>
            <button
              onClick={() => setIsDocPanelOpen(false)}
              className="p-1 hover:bg-slate-100 rounded-md text-slate-400 hover:text-slate-600 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <p className="text-[10px] text-slate-400 leading-normal mb-4">
            {isDesigner
              ? "Attach a PDF or Word document (brief, dimension spec sheet, brand guidelines) to save alongside the 3D model."
              : "Reference document uploaded by the designer for this custom packaging mockup."
            }
          </p>

          {documentName ? (
            /* Document Attached Card */
            <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 space-y-3.5">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600 shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-slate-700 truncate" title={documentName}>
                    {documentName}
                  </div>
                  <div className="text-[9px] text-slate-400 font-mono mt-0.5">
                    {documentData ? `${(documentData.length * 0.75 / 1024 / 1024).toFixed(2)} MB` : 'Attached'}
                  </div>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleDownloadDoc}
                  className="flex-1 bg-brand-600 hover:bg-brand-700 text-white text-[10px] font-bold py-2 rounded-lg flex items-center justify-center gap-1 transition-colors shadow-3xs cursor-pointer"
                >
                  <Download className="w-3 h-3" /> Download
                </button>
                {isDesigner && (
                  <button
                    onClick={handleRemoveDoc}
                    className="p-2 border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-400 rounded-lg transition-colors flex items-center justify-center aspect-square cursor-pointer"
                    title="Remove brief spec file"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* No Document Zone - Designer only */
            isDesigner && (
              <div className="relative border-2 border-dashed border-slate-200 hover:border-brand-500 rounded-xl p-5 bg-slate-50/50 hover:bg-brand-50/10 flex flex-col items-center justify-center text-center transition-all group overflow-hidden">
                <UploadCloud className="w-8 h-8 text-slate-300 group-hover:text-brand-500 transition-colors mb-2" />
                <span className="text-[10px] font-bold text-slate-600 mb-0.5">
                  Click or drag to upload
                </span>
                <span className="text-[8px] text-slate-400">
                  PDF or DOCX (Max 8MB)
                </span>
                <input
                  type="file" onClick={(e) => { e.currentTarget.value = ""; }}
                  accept=".pdf,.docx"
                  onChange={handleDocUpload}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
