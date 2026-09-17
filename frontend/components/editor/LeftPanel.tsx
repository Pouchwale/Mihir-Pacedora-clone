'use client';

import { useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Box, LayoutTemplate, Upload, Plus, ChevronDown, ChevronRight, PackageOpen, Trash2 } from 'lucide-react';
import { useEditorStore } from '@/store/useEditorStore';
import { useShallow } from "zustand/react/shallow";

export function LeftPanel() {
  const { setObjModel, customTemplates, addCustomTemplate, removeCustomTemplate } = useEditorStore(
    useShallow((s) => ({ setObjModel: s.setObjModel, customTemplates: s.customTemplates, addCustomTemplate: s.addCustomTemplate, removeCustomTemplate: s.removeCustomTemplate }))
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const presetInputRef = useRef<HTMLInputElement>(null);
  const [showTemplates, setShowTemplates] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) {
          setObjModel(ev.target.result as string, file.name);
        }
      };
      if (file.name.toLowerCase().endsWith('.obj')) {
        reader.readAsText(file);
      } else {
        reader.readAsDataURL(file);
      }
    }
    // reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePresetUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) {
          const nameWithoutExt = file.name.replace(/\.(obj|glb|gltf)$/i, '');
          addCustomTemplate(nameWithoutExt, ev.target.result as string);
        }
      };
      if (file.name.toLowerCase().endsWith('.obj')) {
        reader.readAsText(file);
      } else {
        reader.readAsDataURL(file);
      }
    }
    if (presetInputRef.current) presetInputRef.current.value = '';
  };

  const loadBuiltInModel = async (filePath: string, name: string) => {
    try {
      const res = await fetch(filePath);
      if (filePath.toLowerCase().endsWith('.glb') || filePath.toLowerCase().endsWith('.gltf')) {
        const blob = await res.blob();
        const reader = new FileReader();
        reader.onload = () => {
          if (reader.result) {
            setObjModel(reader.result as string, name);
          }
        };
        reader.readAsDataURL(blob);
      } else {
        const text = await res.text();
        setObjModel(text, name);
      }
    } catch (err) {
      console.error('Failed to load model', err);
    }
  };

  return (
    <div className="w-[220px] bg-white border-r border-slate-200 flex flex-col shrink-0 h-full">
      <div className="p-4 border-b border-slate-200 bg-slate-50">
        <h2 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model Library</h2>
      </div>
      
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          <input 
            type="file" onClick={(e) => { e.currentTarget.value = ""; }} 
            accept=".obj,.glb,.gltf" 
            className="hidden" 
            ref={fileInputRef} 
            onChange={handleFileChange}
          />

          <div 
            className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 bg-white hover:border-brand-500 hover:shadow-sm cursor-pointer transition-all group"
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="bg-slate-50 p-2 rounded-md group-hover:bg-brand-50 group-hover:text-brand-600 transition-colors">
              <Upload className="w-4 h-4 text-slate-500 group-hover:text-brand-600" />
            </div>
            <div>
              <div className="text-xs font-bold text-slate-700 group-hover:text-brand-700 transition-colors">Load Object</div>
              <div className="text-[10px] text-slate-400 mt-0.5 leading-tight">Upload custom .obj or .glb/.gltf</div>
            </div>
          </div>

          <input 
            type="file" onClick={(e) => { e.currentTarget.value = ""; }} 
            accept=".obj,.glb,.gltf" 
            className="hidden" 
            ref={presetInputRef} 
            onChange={handlePresetUpload}
          />

          <div 
            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all group ${showTemplates ? 'border-brand-500 bg-brand-50/30' : 'border-slate-200 bg-white hover:border-brand-500 hover:shadow-sm'}`}
            onClick={() => setShowTemplates(!showTemplates)}
          >
            <div className={`p-2 rounded-md transition-colors ${showTemplates ? 'bg-brand-500 text-white' : 'bg-slate-50 text-slate-500 group-hover:bg-brand-50 group-hover:text-brand-600'}`}>
              <LayoutTemplate className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className={`text-xs font-bold transition-colors ${showTemplates ? 'text-brand-700' : 'text-slate-700 group-hover:text-brand-700'}`}>Templates</div>
              <div className="text-[10px] text-slate-400 mt-0.5 leading-tight">Browse and save presets</div>
            </div>
            {showTemplates ? <ChevronDown className="w-4 h-4 text-brand-500" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
          </div>

          {/* Templates Sub-menu */}
          {showTemplates && (
            <div className="ml-4 pl-3 border-l-2 border-slate-100 space-y-1 py-1">
              {/* Built-in Presets Section */}
              <div className="text-[9px] font-bold uppercase tracking-widest text-slate-300 px-2 pt-1 pb-0.5">Built-in</div>
              
              {[
                { name: 'Quad Seal Pouch', file: '/models/two_side_gusset.obj' },
                { name: 'Center Spout Pouch', file: '/models/center_spout_pouch.glb' },
                { name: 'Center Seal', file: '/models/center_seal.obj' },
                { name: 'Side Spout Pouch', file: '/models/corner_spout_pouch.glb' },
                { name: 'chocolate bar wrapper', file: '/models/chocolate_bar_wrapper.obj' },
                { name: 'Stand-Up Pouch', file: '/models/standup_pouch.glb' },

                { name: 'Three side Seal', file: '/models/three_side_seal.obj' },
              ].map(preset => (
                <div 
                  key={preset.file}
                  className="flex items-center gap-2 p-2 rounded hover:bg-slate-50 cursor-pointer group"
                  onClick={() => {
                    const filename = preset.file.split('/').pop() || preset.name;
                    loadBuiltInModel(preset.file, filename);
                  }}
                >
                  <PackageOpen className="w-3.5 h-3.5 text-slate-400 group-hover:text-brand-500" />
                  <span className="text-xs text-slate-600 font-medium group-hover:text-brand-600">{preset.name}</span>
                </div>
              ))}
              
              {/* Saved Presets Section */}
              {customTemplates.length > 0 && (
                <>
                  <div className="border-t border-slate-100 my-2"></div>
                  <div className="text-[9px] font-bold uppercase tracking-widest text-slate-300 px-2 pt-1 pb-0.5">
                    Saved ({customTemplates.length})
                  </div>
                  {customTemplates.map(template => (
                    <div 
                      key={template.id}
                      className="flex items-center justify-between p-1.5 rounded hover:bg-slate-50 cursor-pointer group/item"
                      onClick={() => setObjModel(template.objData, template.name)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <PackageOpen className="w-3.5 h-3.5 text-brand-400 group-hover/item:text-brand-500 shrink-0" />
                        <span className="text-xs text-slate-600 font-medium group-hover/item:text-brand-600 truncate" title={template.name}>
                          {template.name}
                        </span>
                      </div>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Are you sure you want to remove preset "${template.name}"?`)) {
                            removeCustomTemplate(template.id);
                          }
                        }}
                        className="opacity-0 group-hover/item:opacity-100 p-1 hover:bg-slate-200 hover:text-red-600 rounded text-slate-400 transition-all shrink-0"
                        title="Remove Preset"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </>
              )}

              {/* Upload Preset Button */}
              <div 
                className="flex items-center gap-2 p-2 mt-2 rounded border border-dashed border-slate-300 hover:border-brand-400 hover:bg-brand-50 cursor-pointer group text-slate-500 transition-colors"
                onClick={() => presetInputRef.current?.click()}
              >
                <Plus className="w-3.5 h-3.5 group-hover:text-brand-500" />
                <span className="text-[11px] font-bold group-hover:text-brand-600">Save New Preset</span>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
      
      <div className="p-4 border-t border-slate-100">
        <div className="bg-slate-50 rounded-lg p-3">
          <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-1">Quick Tips</div>
          <div className="text-[10px] text-slate-400 leading-relaxed">
            🖱 Drag to orbit<br/>
            📦 Upload textures in Art tab<br/>
            ✨ Use AI to generate palette
          </div>
        </div>
      </div>
    </div>
  );
}
