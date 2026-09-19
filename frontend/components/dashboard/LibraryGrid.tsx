'use client';

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useRef } from "react";
import { Trash2, Plus, Upload, X, Loader2 } from "lucide-react";
import { STATUS_LABELS } from "@/lib/access";
import { toast } from "@/lib/toast";

interface LibraryGridProps {
  initialTemplates: any[];
  userId?: string | null;
  userRole?: string | null;
  approvalRequests?: any[];
  /** Customer accounts (Head of Designer / Administrator), used to show who a design is shared with */
  customers?: { name: string | null; email: string | null }[];
}

export function LibraryGrid({ initialTemplates, userId, userRole, approvalRequests, customers = [] }: LibraryGridProps) {
  const router = useRouter();
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  // Upload modal state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedModel, setSelectedModel] = useState("two_side_gusset.obj");
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Custom model upload states
  const [uploadMode, setUploadMode] = useState<'preset' | 'file'>('preset');
  const [customModelFile, setCustomModelFile] = useState<File | null>(null);
  const [customModelData, setCustomModelData] = useState<string | null>(null);

  const handleFileSelection = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!['obj', 'gltf', 'glb', 'dae'].includes(extension || '')) {
      setErrorMsg("Unsupported file format. Please upload a .obj, .gltf, .glb, or .dae file.");
      setCustomModelFile(null);
      setCustomModelData(null);
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setErrorMsg("File is too large. Maximum size allowed is 50MB.");
      setCustomModelFile(null);
      setCustomModelData(null);
      return;
    }

    setErrorMsg(null);
    setCustomModelFile(file);

    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        setCustomModelData(event.target.result as string);
      }
    };

    if (extension === 'obj' || extension === 'dae') {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  };

  const resetForm = () => {
    setShowUploadModal(false);
    setName("");
    setDescription("");
    setSelectedModel("3_gusset_zipper_pouch.obj");
    setUploadMode('preset');
    setCustomModelFile(null);
    setCustomModelData(null);
    setErrorMsg(null);
  };

  const BUILTIN_MODELS = [
    { id: "two_side_gusset.obj", name: "Quad Seal Pouch", icon: "📦", desc: "Flat pouch with side gussets for capacity." },
    { id: "center_spout_pouch.glb", name: "Center Spout Pouch", icon: "🧴", desc: "Flexible bag with a top-center liquid spout." },
    { id: "center_seal.obj", name: "Center Seal", icon: "🧻", desc: "Back fin-seal gusseted packaging." },
    { id: "corner_spout_pouch.glb", name: "Side Spout Pouch", icon: "🥛", desc: "Flexible liquid pouch with corner nozzle spout." },
    { id: "chocolate_bar_wrapper.obj", name: "Chocolate Bar Wrapper", icon: "🍫", desc: "Candy or chocolate bar wrapper packaging." },
    { id: "standup_pouch.glb", name: "Stand-Up Pouch", icon: "🛍️", desc: "Classic, versatile stand-up pouch packaging mockup with broad bottom gusset." },

    { id: "three_side_seal.obj", name: "Three Side Seal", icon: "✉️", desc: "Rectangular flat three-side seal pouch." }
  ];

  const [deletedSlugs, setDeletedSlugs] = useState<string[]>([]);

  const handleDelete = async (e: React.MouseEvent, slug: string, name: string) => {
    e.preventDefault();
    e.stopPropagation();

    if (!confirm(`Are you sure you want to permanently delete custom preset "${name}"?`)) {
      return;
    }

    setDeletingSlug(slug);
    try {
      const res = await fetch(`/api/templates/${slug}`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        throw new Error('Failed to delete preset');
      }

      // Hide the card right away; the refresh then updates history and other sections
      setDeletedSlugs((prev) => [...prev, slug]);
      router.refresh();
    } catch (err) {
      console.error(err);
      toast.error('Error deleting preset', 'Please try again.');
    } finally {
      setDeletingSlug(null);
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMsg("Please specify a name for your custom mockup.");
      return;
    }

    if (uploadMode === 'file' && (!customModelFile || !customModelData)) {
      setErrorMsg("Please select a 3D model file to upload.");
      return;
    }

    setUploading(true);
    setErrorMsg(null);

    try {
      let objData = "";
      let modelFile = "";

      if (uploadMode === 'preset') {
        // Fetch the selected built-in model data
        const response = await fetch(`/models/${selectedModel}`);
        if (!response.ok) {
          throw new Error("Failed to load selected 3D model file.");
        }
        if (selectedModel.toLowerCase().endsWith('.glb') || selectedModel.toLowerCase().endsWith('.gltf')) {
          const blob = await response.blob();
          objData = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
        } else {
          objData = await response.text();
        }
        modelFile = selectedModel;
      } else {
        // Use the user uploaded model file
        objData = customModelData!;
        modelFile = customModelFile!.name;
      }

      // Convert the model to a fully unwrapped GLB with baked-in side mask groups
      // three.js is only needed here, so load the exporter on demand instead of on every dashboard visit
      const { exportToGLBBase64 } = await import('@/lib/3d/gltfExporter');
      objData = await exportToGLBBase64(objData, modelFile);
      modelFile = name.trim().replace(/\s+/g, '_').toLowerCase() + '.glb';

      // Submit preset details to the server
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          objData,
          modelFile,
          editorState: {
            bgColor: "#f8f9fa",
            bgType: "solid",
            showGrid: true,
            showShadow: true,
            enableFloat: true,
            keyLightIntensity: 0.8,
            fillLightIntensity: 0.4,
            rimLightIntensity: 0.3,
            ambientLightIntensity: 0.8,
            scale: 1.1,
            rotation: [0, 20, 0],
            textures: {
              front: null,
              back: null,
              left: null,
              right: null,
              top: null,
              bottom: null,
              overall: null,
              label: null
            },
            materials: {
              Front: { color: "#ffffff", roughness: 0.3, metalness: 0.0, emissive: 0 },
              Back: { color: "#ffffff", roughness: 0.3, metalness: 0.0, emissive: 0 },
              Left: { color: "#ffffff", roughness: 0.3, metalness: 0.0, emissive: 0 },
              Right: { color: "#ffffff", roughness: 0.3, metalness: 0.0, emissive: 0 },
              Top: { color: "#ffffff", roughness: 0.3, metalness: 0.0, emissive: 0 },
              Bottom: { color: "#ffffff", roughness: 0.3, metalness: 0.0, emissive: 0 }
            }
          }
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to save preset.");
      }

      const createdTemplate = await res.json();

      // Clear states & navigate to newly created editor page
      resetForm();
      
      router.push(`/mockup-detail/${createdTemplate.slug}`);
      router.refresh();
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Error creating preset. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {/* Premium "Add Custom Preset" Card */}
      {userRole !== "Customer" && (
        userId ? (
          <button
            onClick={() => setShowUploadModal(true)}
            className="group flex flex-col items-center justify-center bg-white hover:bg-slate-50/50 border-2 border-dashed border-slate-200 hover:border-brand-500 rounded-xl p-8 aspect-[16/10] text-center transition-all duration-200 shadow-xs cursor-pointer"
          >
            <div className="w-12 h-12 rounded-full bg-slate-50 group-hover:bg-brand-50 flex items-center justify-center text-slate-400 group-hover:text-brand-600 transition-colors mb-3 border border-slate-100">
              <Plus className="w-6 h-6" />
            </div>
            <span className="font-bold text-slate-700 text-sm tracking-tight group-hover:text-brand-700 transition-colors">
              Add Custom Preset
            </span>
            <span className="text-[11px] text-slate-400 mt-1.5 max-w-[220px] leading-relaxed">
              Create a custom design preset based on a built-in 3D model.
            </span>
          </button>
        ) : (
          <Link
            href="/auth/signin"
            className="group flex flex-col items-center justify-center bg-white hover:bg-slate-50/50 border-2 border-dashed border-slate-200 hover:border-brand-500 rounded-xl p-8 aspect-[16/10] text-center transition-all duration-200 shadow-xs cursor-pointer"
          >
            <div className="w-12 h-12 rounded-full bg-slate-50 group-hover:bg-brand-50 flex items-center justify-center text-slate-400 group-hover:text-brand-600 transition-colors mb-3 border border-slate-100">
              <Plus className="w-6 h-6" />
            </div>
            <span className="font-bold text-slate-700 text-sm tracking-tight group-hover:text-brand-700 transition-colors">
              Sign In to Add Presets
            </span>
            <span className="text-[11px] text-slate-400 mt-1.5 max-w-[220px] leading-relaxed">
              Create an account to customize and save your own 3D design presets.
            </span>
          </Link>
        )
      )}

      {/* Existing Templates Cards List */}
      {initialTemplates.filter((template: any) => !deletedSlugs.includes(template.slug)).map((template: any) => {
        const isOwner = userId && template.authorId === userId;
        const approval = approvalRequests?.find((req) => req.designSlug === template.slug);
        
        return (
          <Link
            key={template.id}
            href={`/mockup-detail/${template.slug}`}
            className="group flex flex-col bg-white border border-slate-200 rounded-2xl overflow-hidden hover:border-brand-500 hover:-translate-y-1.5 hover:-translate-x-1.5 hover:shadow-[6px_6px_0px_0px_#e51b8c] transition-all duration-200 relative"
          >
            {/* Thumbnail area */}
            <div className="relative aspect-[16/10] bg-slate-50 flex items-center justify-center border-b border-slate-100 overflow-hidden shrink-0">
              {template.thumbnail ? (
                <img
                  src={template.thumbnail}
                  alt={template.name}
                  loading="lazy"
                  decoding="async"
                  className={`w-full h-full ${
                    template.isRenderedThumbnail || template.thumbnail.startsWith('data:') 
                      ? 'object-contain p-3 bg-slate-50' 
                      : 'object-cover'
                  } group-hover:scale-105 transition-transform duration-300`}
                />
              ) : (
                <div className="w-full h-full bg-slate-50 flex flex-col items-center justify-center gap-2">
                  <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-400 group-hover:bg-brand-50 group-hover:text-brand-500 transition-colors">
                    <div className="text-sm font-black">3D</div>
                  </div>
                  <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">No Render Preview</div>
                </div>
              )}
              
              {/* Badge Overlay */}
              <div className="absolute top-3 left-3 flex flex-wrap gap-1.5 z-10 pointer-events-none">
                {template.isDefault && (
                  <span className="bg-brand-600 text-white text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded shadow-sm">
                    Default
                  </span>
                )}
                {template.isPublic && !template.isDefault && (
                  <span className="bg-emerald-600 text-white text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded shadow-sm">
                    Public
                  </span>
                )}
                {approval && (() => {
                  // Customers see their own decision; everyone else sees the pipeline stage
                  const shown = userRole === "Customer" ? (approval.customerStatus || "PENDING") : approval.status;
                  const label = userRole === "Customer"
                    ? (shown === "PENDING" ? "Awaiting your review" : shown === "APPROVED" ? "You approved" : "Changes requested")
                    : STATUS_LABELS[shown] || shown;
                  return (
                    <span className={`text-[9px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded shadow-sm border ${
                      shown === "APPROVED"
                        ? "bg-emerald-500 text-white border-emerald-600"
                        : shown === "REJECTED"
                        ? "bg-rose-500 text-white border-rose-600"
                        : "bg-amber-500 text-white border-amber-600 animate-pulse"
                    }`}>
                      {label}
                    </span>
                  );
                })()}
              </div>


              {/* Delete Button overlay */}
              {isOwner && (
                <button
                  onClick={(e) => handleDelete(e, template.slug, template.name)}
                  disabled={deletingSlug === template.slug}
                  className="absolute top-3 right-3 p-2 bg-white/95 hover:bg-red-50 text-slate-500 hover:text-red-600 border border-slate-200 hover:border-red-200 rounded-lg shadow-sm backdrop-blur-xs transition-all duration-150 z-20 disabled:opacity-50"
                  title="Delete Preset"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Body description */}
            <div className="p-4 flex-1 flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-slate-800 text-sm tracking-tight group-hover:text-brand-700 transition-colors">
                  {template.name}
                </h3>
                <p className="mt-1 text-xs text-slate-400 line-clamp-2 leading-relaxed">
                  {template.description || "No description provided."}
                </p>
              </div>

              {approval && userRole === "Head of Designer" && approval.status === "PENDING" ? (
                <div className="mt-4 pt-3 border-t border-slate-100 flex flex-col gap-1.5 text-[11px]">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-bold text-slate-600">Designer: <span className="font-extrabold text-slate-800">{approval.designerName}</span></span>
                    <span className="font-medium text-slate-400">{approval.designerEmail}</span>
                  </div>
                  <div className="pt-2 mt-0.5 border-t border-slate-50/50 text-[10px] text-slate-400 font-medium">
                    Submitted: {new Date(approval.createdAt).toLocaleString()}
                  </div>
                </div>
              ) : approval && (userRole === "Head of Designer" || userRole === "Administrator") && approval.status === "APPROVED" ? (
                <div className="mt-4 pt-3 border-t border-slate-100 flex flex-col gap-1 text-[11px]">
                  <span className="font-bold text-slate-600">Designer: <span className="font-extrabold text-slate-800">{approval.designerName}</span></span>
                  {approval.customerEmail ? (() => {
                    const customer = customers.find((c) => c.email?.toLowerCase() === approval.customerEmail.toLowerCase());
                    return (
                      <span className="font-bold text-slate-600">
                        Customer: <span className="font-extrabold text-slate-800">{customer?.name || approval.customerEmail}</span>
                        {customer?.name && <span className="font-medium text-slate-400"> ({approval.customerEmail})</span>}
                        <span className={`ml-1 font-semibold ${approval.customerStatus === "APPROVED" ? "text-emerald-600" : approval.customerStatus === "REJECTED" ? "text-rose-600" : "text-amber-600"}`}>
                          · {approval.customerStatus === "APPROVED" ? "Approved" : approval.customerStatus === "REJECTED" ? "Requested changes" : "Awaiting review"}
                        </span>
                      </span>
                    );
                  })() : (
                    <span className="font-semibold text-amber-600">Not shared with a customer yet</span>
                  )}
                </div>
              ) : (
                <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-400">
                  <span>Model: <strong className="text-slate-600">{template.modelFile || "Custom upload"}</strong></span>
                  {template.author?.name && (
                    <span className="flex items-center gap-1 font-medium text-slate-500">
                      👤 {template.author.name}
                    </span>
                  )}
                </div>
              )}
            </div>
          </Link>
        );
      })}

      {/* Upload Custom Preset Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden border border-slate-100 flex flex-col animate-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-150 flex items-center justify-between">
              <div>
                <h3 className="text-base font-extrabold text-slate-900 tracking-tight">Add Custom Preset</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">Select a built-in 3D shape or upload your own 3D model file to start</p>
              </div>
              <button 
                onClick={resetForm}
                className="p-1.5 hover:bg-slate-200 rounded-lg text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
 
            {/* Form */}
            <form onSubmit={handleUploadSubmit} className="p-6 space-y-5 flex-1 overflow-y-auto">
              {errorMsg && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-bold text-red-600">
                  ⚠️ {errorMsg}
                </div>
              )}
 
              {/* Name field */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider block">Preset Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. My Premium Standup Brand"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 hover:bg-slate-100/50 focus:bg-white border border-slate-200 focus:border-brand-500 rounded-lg text-sm text-slate-800 focus:outline-none transition-all placeholder:text-slate-400 focus:ring-1 focus:ring-brand-500/20"
                />
              </div>
 
              {/* Description field */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider block">Description (Optional)</label>
                <textarea
                  placeholder="Describe your design preset..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full px-3.5 py-2.5 bg-slate-50 hover:bg-slate-100/50 focus:bg-white border border-slate-200 focus:border-brand-500 rounded-lg text-sm text-slate-800 focus:outline-none transition-all placeholder:text-slate-400 focus:ring-1 focus:ring-brand-500/20 resize-none"
                />
              </div>

              {/* Option Mode Toggle */}
              <div className="flex rounded-lg bg-slate-100 p-1 border border-slate-200">
                <button
                  type="button"
                  onClick={() => {
                    setUploadMode('preset');
                    setErrorMsg(null);
                  }}
                  className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${
                    uploadMode === 'preset'
                      ? 'bg-white text-brand-600 shadow-xs'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  Choose Built-in Model
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUploadMode('file');
                    setErrorMsg(null);
                  }}
                  className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${
                    uploadMode === 'file'
                      ? 'bg-white text-brand-600 shadow-xs'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  Upload Custom 3D Model
                </button>
              </div>
 
              {uploadMode === 'preset' ? (
                /* Built-in Model Selector Grid */
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider block">Select 3D Model template</label>
                  <div className="grid grid-cols-2 gap-3 max-h-[220px] overflow-y-auto pr-1">
                    {BUILTIN_MODELS.map((model) => (
                      <div
                        key={model.id}
                        onClick={() => setSelectedModel(model.id)}
                        className={`p-3 rounded-xl border-2 text-left cursor-pointer transition-all flex flex-col justify-between ${
                          selectedModel === model.id
                            ? "border-brand-600 bg-brand-50/25 shadow-xs"
                            : "border-slate-200 hover:border-slate-300 bg-white"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <span className="text-xl select-none leading-none mt-0.5">{model.icon}</span>
                          <div>
                            <p className="text-xs font-extrabold text-slate-800 tracking-tight leading-tight">{model.name}</p>
                            <p className="text-[9px] text-slate-400 mt-1 leading-normal line-clamp-2">{model.desc}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                /* Custom Model Uploader */
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-700 uppercase tracking-wider block">Upload 3D Model File</label>
                  <div className="border-2 border-dashed border-slate-200 hover:border-brand-500 rounded-xl p-6 bg-slate-50 hover:bg-slate-100/35 transition-all text-center relative flex flex-col items-center justify-center min-h-[140px] group">
                    <input
                      type="file" onClick={(e) => { e.currentTarget.value = ""; }}
                      accept=".obj,.gltf,.glb,.dae"
                      required={uploadMode === 'file'}
                      onChange={handleFileSelection}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    />
                    <div className="w-10 h-10 rounded-full bg-slate-100 group-hover:bg-brand-50 flex items-center justify-center text-slate-400 group-hover:text-brand-600 transition-colors mb-2.5 border border-slate-200">
                      <Upload className="w-5 h-5" />
                    </div>
                    {customModelFile ? (
                      <div className="space-y-1 z-20 pointer-events-none">
                        <p className="text-xs font-extrabold text-slate-800 truncate max-w-[280px]">
                          {customModelFile.name}
                        </p>
                        <p className="text-[10px] text-emerald-600 font-bold">
                          Ready to upload ({(customModelFile.size / 1024 / 1024).toFixed(2)} MB)
                        </p>
                      </div>
                    ) : (
                      <div className="z-20 pointer-events-none">
                        <p className="text-xs font-extrabold text-slate-700">
                          Click or drag file to this area to upload
                        </p>
                        <p className="text-[10px] text-slate-400 mt-1">
                          Support for .obj, .gltf, .glb, or .dae 3D files (Max 50MB)
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
 
              {/* Actions footer */}
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  disabled={uploading}
                  onClick={resetForm}
                  className="px-4 py-2.5 text-xs font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uploading}
                  className="px-4 py-2.5 text-xs font-bold text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-all shadow-md shadow-brand-500/10 cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Creating Preset...
                    </>
                  ) : (
                    <>
                      Create Preset
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
