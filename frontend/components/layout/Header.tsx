"use client";

import { Button } from "@/components/ui/button";
import { Download, CheckCircle2, X, Bell, Send, ChevronDown, Paperclip, Trash2, Loader2, AlertCircle } from "lucide-react";
import { useEditorStore } from "@/store/useEditorStore";
import { useShallow } from "zustand/react/shallow";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, useEffect, useRef, useCallback } from "react";
import { UserNav } from "@/components/layout/UserNav";
import Link from "next/link";
import { usePolling } from "@/lib/usePolling";
import { HEAD_OF_DESIGNER, STATUS_LABELS, canDesign, canReview, canShareWithCustomers } from "@/lib/access";
import { toast } from "@/lib/toast";
import { downloadDataUrl } from "@/lib/download";

export function Header({ template }: { template?: any }) {
  const { data: session } = useSession();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  // Auto-save status shown in the header
  const [saveStatus, setSaveStatus] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const [hasAutoSavedThumbnail, setHasAutoSavedThumbnail] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);

  // Auto-generate a thumbnail when the canvas is ready. Only the thumbnail is saved, so this
  // can never overwrite design changes the owner saved in the meantime.
  useEffect(() => {
    const isOwner = session && (session.user as any)?.id === template?.authorId;
    if (template && !template.thumbnail && !template.isDefault && !hasAutoSavedThumbnail && isOwner) {
      const timer = setTimeout(() => {
        const canvas = document.querySelector("canvas");
        let thumbnail: string | null = null;
        try {
          if (canvas) {
            // Flatten onto the scene colour first: a transparent view would become black in JPEG
            const st = useEditorStore.getState();
            const flat = document.createElement("canvas");
            flat.width = canvas.width;
            flat.height = canvas.height;
            const fctx = flat.getContext("2d");
            if (fctx) {
              fctx.fillStyle = st.bgType === "solid" ? st.bgColor : "#f8f9fa";
              fctx.fillRect(0, 0, flat.width, flat.height);
              fctx.drawImage(canvas as HTMLCanvasElement, 0, 0);
              thumbnail = flat.toDataURL("image/jpeg", 0.65);
            }
          }
        } catch (e) {
          console.error("Failed to capture template thumbnail:", e);
        }
        setHasAutoSavedThumbnail(true);
        if (!thumbnail) return;
        fetch(`/api/templates/${encodeURIComponent(template.slug)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thumbnail }),
        }).catch((e) => console.error("Failed to save thumbnail:", e));
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [template, hasAutoSavedThumbnail, session]);

  // Attached Document (Brief/PDF) States
  const [attachedDocName, setAttachedDocName] = useState<string>(template?.documentName || "");
  const [attachedDocData, setAttachedDocData] = useState<string>(template?.documentData || "");

  const storeDocumentName = useEditorStore((state) => state.documentName);
  const storeDocumentData = useEditorStore((state) => state.documentData);
  const setDocument = useEditorStore((state) => state.setDocument);

  // Sync local states when the store changes
  useEffect(() => {
    if (storeDocumentName !== undefined && storeDocumentName !== null) {
      setAttachedDocName(storeDocumentName);
    } else if (storeDocumentName === null) {
      setAttachedDocName("");
    }
    if (storeDocumentData !== undefined && storeDocumentData !== null) {
      setAttachedDocData(storeDocumentData);
    } else if (storeDocumentData === null) {
      setAttachedDocData("");
    }
  }, [storeDocumentName, storeDocumentData]);

  // Sync state if template updates (e.g., loaded dynamically)
  useEffect(() => {
    if (template) {
      setAttachedDocName(template.documentName || "");
      setAttachedDocData(template.documentData || "");
      if (template.documentName || template.documentData) {
        setDocument(template.documentName || null, template.documentData || null);
      }
    }
  }, [template?.documentName, template?.documentData, setDocument]);

  const handleDocChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Check size limit (e.g. 8MB)
    if (file.size > 8 * 1024 * 1024) {
      toast.error("File is too large", "Please select a document under 8MB.");
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      setAttachedDocData(base64String);
      setAttachedDocName(file.name);
      setDocument(file.name, base64String);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveDoc = () => {
    setAttachedDocData("");
    setAttachedDocName("");
    setDocument(null, null);
  };

  const handleDownloadDoc = (dataStr: string, filename: string) => {
    try {
      if (!downloadDataUrl(dataStr, filename)) throw new Error("invalid document");
    } catch (e) {
      console.error("Failed to download document:", e);
      toast.error("Failed to download attached document");
    }
  };

  // Approval flow states
  const [submittingApproval, setSubmittingApproval] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<any>(null);

  // Reviewer (Head of Designer / Customer) local review states
  const [reviewRemarks, setReviewRemarks] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);

  // Fetch approval status for this active template
  const fetchApprovalStatus = async () => {
    if (!template?.slug) return;
    try {
      const res = await fetch(`/api/approvals?slug=${encodeURIComponent(template.slug)}`);
      if (res.ok) {
        const data = await res.json();
        const req = Array.isArray(data) ? data[0] : null;
        // Only update state when the request actually changed, to avoid re-rendering the editor
        // Clear it when the request is no longer visible (e.g. unshared from this customer)
        setApprovalRequest((prev: any) =>
          !req ? null : prev?.id === req.id && prev?.updatedAt === req.updatedAt ? prev : req
        );
      }
    } catch (e) {
      console.error("Error loading template approval status:", e);
    }
  };

  usePolling(fetchApprovalStatus, 30000, !!template?.slug);

  // User roles permissions
  const role = (session?.user as any)?.accountType || "Customer";
  const isAdministrator = role === "Administrator";
  const isHead = role === HEAD_OF_DESIGNER;
  const isDesigner = role === "Designer" || isHead || isAdministrator;
  const isReviewer = canReview(role);
  const isCustomer = role === "Customer";

  // Customer sharing states (who may share is an admin setting)
  const [canShare, setCanShare] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const [selectedCustomerEmail, setSelectedCustomerEmail] = useState<string>("");
  const [sharingDesign, setSharingDesign] = useState(false);

  // Fetch customers if this user may share designs with them (Head of Designer / Administrator)
  useEffect(() => {
    const allowed = !!session && canShareWithCustomers(role);
    setCanShare(allowed);
    if (!allowed) return;
    fetch("/api/customers")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setCustomers(data))
      .catch((err) => console.error("Error fetching customers:", err));
  }, [session, role]);

  // Sync selected customer email when approvalRequest loads
  useEffect(() => {
    if (approvalRequest?.customerEmail) {
      setSelectedCustomerEmail(approvalRequest.customerEmail);
    } else {
      setSelectedCustomerEmail("");
    }
  }, [approvalRequest]);

  // Share design with specific customer account
  const handleShareWithCustomer = async (email: string) => {
    if (!approvalRequest?.id) return;
    setSharingDesign(true);
    try {
      const res = await fetch(`/api/approvals/${approvalRequest.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerEmail: email || null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to share design with customer");

      toast.success(email ? "Design shared" : "Customer access removed", email ? `Shared with ${email}.` : undefined);
      fetchApprovalStatus();
    } catch (e: any) {
      console.error(e);
      toast.error("Sharing failed", e.message);
    } finally {
      setSharingDesign(false);
    }
  };

  const {
    bgColor,
    bgType,
    showGrid,
    showShadow,
    enableFloat,
    keyLightIntensity,
    fillLightIntensity,
    ambientLightIntensity,
    rimLightIntensity,
    scale,
    rotation,
    textures,
    materials,
    fileName,
    objText,
    punchType,
    punchSize,
    punchPositionY,
    cornerStyles,
    cornerSizes,
    linkCorners,
    isAnimationFrozen,
    isClearPlastic,
    spoutSize,
    sizeScale,
    windowCutouts,
    isOneSideClearPlastic
  } = useEditorStore(
    useShallow((s) => ({ bgColor: s.bgColor, bgType: s.bgType, showGrid: s.showGrid, showShadow: s.showShadow, enableFloat: s.enableFloat, keyLightIntensity: s.keyLightIntensity, fillLightIntensity: s.fillLightIntensity, ambientLightIntensity: s.ambientLightIntensity, rimLightIntensity: s.rimLightIntensity, scale: s.scale, rotation: s.rotation, textures: s.textures, materials: s.materials, fileName: s.fileName, objText: s.objText, punchType: s.punchType, punchSize: s.punchSize, punchPositionY: s.punchPositionY, cornerStyles: s.cornerStyles, cornerSizes: s.cornerSizes, linkCorners: s.linkCorners, isAnimationFrozen: s.isAnimationFrozen, isClearPlastic: s.isClearPlastic, spoutSize: s.spoutSize, sizeScale: s.sizeScale, windowCutouts: s.windowCutouts, isOneSideClearPlastic: s.isOneSideClearPlastic }))
  );


  const handleExport = () => {
    const canvas = document.querySelector("canvas");
    if (canvas) {
      const dataUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${template?.name || "promockup"}-render.png`;
      a.click();
    }
  };

  // What was last stored for the heavy fields, so auto-save only uploads them when they change
  const savedModelRef = useRef<string | null>(null);
  const savedDocumentRef = useRef<string | null>(null);
  const lastThumbnailAt = useRef(0);

  const saveToDatabase = async (
    nameToSave: string,
    createNew: boolean,
    options: { withThumbnail?: boolean } = { withThumbnail: true }
  ): Promise<string | null> => {
    setSaving(true);
    try {
      // Read the latest store values at save time (not values captured by an earlier render)
      const st = useEditorStore.getState();
      const editorState = {
        bgColor: st.bgColor,
        bgType: st.bgType,
        bgImage: st.bgImage,
        showGrid: st.showGrid,
        showShadow: st.showShadow,
        showTable: st.showTable,
        tableTexture: st.tableTexture,
        floorImage: st.floorImage,
        enableFloat: st.enableFloat,
        keyLightIntensity: st.keyLightIntensity,
        keyLightColor: st.keyLightColor,
        keyLightPosition: st.keyLightPosition,
        keyLightFocus: st.keyLightFocus,
        fillLightIntensity: st.fillLightIntensity,
        fillLightColor: st.fillLightColor,
        fillLightPosition: st.fillLightPosition,
        fillLightFocus: st.fillLightFocus,
        rimLightIntensity: st.rimLightIntensity,
        rimLightColor: st.rimLightColor,
        rimLightPosition: st.rimLightPosition,
        rimLightFocus: st.rimLightFocus,
        ambientLightIntensity: st.ambientLightIntensity,
        ambientLightColor: st.ambientLightColor,
        scale: st.scale,
        rotation: st.rotation,
        modelPosition: st.modelPosition,
        textures: st.textures,
        textureTransforms: st.textureTransforms,
        materials: st.materials,
        punchType: st.punchType,
        punchSize: st.punchSize,
        punchPositionY: st.punchPositionY,
        cornerStyles: st.cornerStyles,
        cornerSizes: st.cornerSizes,
        linkCorners: st.linkCorners,
        isAnimationFrozen: st.isAnimationFrozen,
        isClearPlastic: st.isClearPlastic,
        spoutSize: st.spoutSize,
        sizeScale: st.sizeScale,
        windowCutouts: st.windowCutouts,
        isOneSideClearPlastic: st.isOneSideClearPlastic,
        filmFinish: st.filmFinish,
        innerLayer: st.innerLayer,
        floorFit: st.floorFit,
        floorSize: st.floorSize,
        floorTiles: st.floorTiles,
        floorOffsetX: st.floorOffsetX,
        floorOffsetZ: st.floorOffsetZ,
        floorRotation: st.floorRotation,
        bgScale: st.bgScale,
        bgOffsetX: st.bgOffsetX,
        bgOffsetY: st.bgOffsetY,
        dieline: st.dieline,
        insideTextures: st.insideTextures,
      };

      // Capturing the 3D view is expensive: at most once a minute during auto-save
      let thumbnail = null;
      const canvas = document.querySelector("canvas");
      if (canvas && (options.withThumbnail || Date.now() - lastThumbnailAt.current > 60000)) {
        try {
          // The 3D view can be transparent (background image); JPEG would turn that black
          const flat = document.createElement("canvas");
          flat.width = canvas.width;
          flat.height = canvas.height;
          const fctx = flat.getContext("2d");
          if (fctx) {
            fctx.fillStyle = st.bgType === "solid" ? st.bgColor : "#f8f9fa";
            fctx.fillRect(0, 0, flat.width, flat.height);
            fctx.drawImage(canvas as HTMLCanvasElement, 0, 0);
            thumbnail = flat.toDataURL("image/jpeg", 0.65);
          }
          lastThumbnailAt.current = Date.now();
        } catch (e) {
          console.error("Failed to capture template thumbnail:", e);
        }
      }

      const documentData = st.documentData || null;
      const documentName = st.documentName || null;
      // A shipped model file does not need to be copied into the database
      const usesShippedModel = !!template?.modelFile && st.fileName === template.modelFile && !template?.hasObjData;

      if (createNew || template?.isDefault) {
        const res = await fetch("/api/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: nameToSave,
            description: `Customized preset created from ${template?.name || "mockup"}`,
            modelFile: st.fileName || template?.modelFile || "",
            objData: usesShippedModel ? null : st.objText || null,
            editorState,
            thumbnail,
            documentData,
            documentName
          })
        });

        if (!res.ok) throw new Error("Failed to create preset");
        const data = await res.json();
        return data.slug;
      } else {
        const res = await fetch(`/api/templates/${template.slug}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: nameToSave,
            modelFile: st.fileName || template?.modelFile || "",
            // Unchanged model / brief are not re-sent (they can be tens of MB)
            ...(st.objText !== savedModelRef.current ? { objData: usesShippedModel ? null : st.objText || null } : {}),
            editorState,
            thumbnail,
            ...(documentData !== savedDocumentRef.current || documentName === null ? { documentData, documentName } : {})
          })
        });

        if (!res.ok) throw new Error("Failed to update preset");
        const saved = await res.json().catch(() => null);
        if (saved?.reviewReset) {
          toast.info("Sent back for review", "This design was approved; your changes need a new review by the Head of Designer.");
          fetchApprovalStatus();
        }
        savedModelRef.current = st.objText;
        savedDocumentRef.current = documentData;
        return template.slug;
      }
    } catch (err) {
      console.error(err);
      return null;
    } finally {
      setSaving(false);
    }
  };

  // ---------------- Auto-save ----------------
  const sessionUserId = (session?.user as any)?.id;
  const ownsTemplate = !!template && template.authorId === sessionUserId;
  // Designers auto-save their own designs; editing a built-in template creates their own copy first.
  // Reviewers looking at someone else's design never auto-save it.
  const autosaveMode: "update" | "copy" | null =
    !session || !canDesign(role) ? null : ownsTemplate ? "update" : template?.isDefault ? "copy" : null;
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);

  const persistedKeys = [
    "bgColor", "bgType", "bgImage", "showGrid", "showShadow", "showTable", "tableTexture", "floorImage", "enableFloat",
    "keyLightIntensity", "keyLightColor", "keyLightPosition", "keyLightFocus", "fillLightIntensity", "fillLightColor",
    "fillLightPosition", "fillLightFocus", "rimLightIntensity", "rimLightColor", "rimLightPosition", "rimLightFocus",
    "ambientLightIntensity", "ambientLightColor", "scale", "rotation", "modelPosition", "textures", "textureTransforms",
    "materials", "punchType", "punchSize", "punchPositionY", "cornerStyles", "cornerSizes", "linkCorners",
    "isAnimationFrozen", "isClearPlastic", "spoutSize", "sizeScale", "windowCutouts", "isOneSideClearPlastic",
    "filmFinish", "innerLayer", "floorFit", "floorSize", "floorTiles",
    "floorOffsetX", "floorOffsetZ", "floorRotation", "bgScale", "bgOffsetX", "bgOffsetY",
    "dieline", "insideTextures",
    "objText", "fileName", "documentData", "documentName",
  ] as const;

  const runAutosave = useCallback(async () => {
    if (!autosaveMode || savingRef.current) return;
    savingRef.current = true;
    dirtyRef.current = false;
    setSaveStatus("saving");
    try {
      if (autosaveMode === "update") {
        const slug = await saveToDatabase(template.name, false, { withThumbnail: false });
        if (!slug) throw new Error("save failed");
        setSaveStatus(dirtyRef.current ? "pending" : "saved");
      } else {
        const slug = await saveToDatabase(`${template.name} - Custom`, true);
        if (!slug) throw new Error("save failed");
        toast.success("Saved as your design", "Your changes to this template are now saved automatically in your own copy.");
        router.replace(`/mockup-detail/${slug}`);
        return; // the copy's page takes over auto-saving
      }
    } catch (e) {
      console.error("Auto-save failed:", e);
      setSaveStatus("error");
      dirtyRef.current = true;
    } finally {
      savingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosaveMode, template?.slug]);

  useEffect(() => {
    if (!autosaveMode) return;
    const st = useEditorStore.getState() as any;
    savedModelRef.current = st.objText;
    savedDocumentRef.current = st.documentData || null;
    let baseline: Record<string, unknown> = Object.fromEntries(persistedKeys.map((k) => [k, st[k]]));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await runAutosave();
        if (dirtyRef.current) schedule(4000); // retry failed saves / save changes made meanwhile
      }, delay);
    };
    // Values the editor settles on while it finishes loading are not user edits
    const armedAt = Date.now() + 1500;
    const unsubscribe = useEditorStore.subscribe((state: any) => {
      const changed = persistedKeys.some((k) => state[k] !== baseline[k]);
      if (!changed) return;
      baseline = Object.fromEntries(persistedKeys.map((k) => [k, state[k]]));
      if (Date.now() < armedAt) return;
      dirtyRef.current = true;
      setSaveStatus("pending");
      schedule(2000);
    });
    const warnIfUnsaved = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || savingRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warnIfUnsaved);
    return () => {
      unsubscribe();
      clearTimeout(timer);
      window.removeEventListener("beforeunload", warnIfUnsaved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosaveMode, runAutosave]);

  // Submit a design to the Head of Designer for review
  const handleSubmitApproval = async () => {
    if (!session) {
      router.push("/auth/signin");
      return;
    }

    setSubmittingApproval(true);
    let navigating = false;
    try {
      // Let a running auto-save finish so the submitted design is up to date
      for (let i = 0; i < 50 && savingRef.current; i++) await new Promise((r) => setTimeout(r, 200));
      const nameToSave = template?.isDefault
        ? `${template.name} - Custom`
        : (template?.name || "Custom 3D Design");

      const ownsTemplate = template?.authorId === (session?.user as any)?.id;
      // Reviewers (Head of Designer / Administrator) submit a designer's design as-is, on the designer's behalf
      const submitOnBehalf = !template?.isDefault && !ownsTemplate && (isHead || isAdministrator);
      // A default template or someone else's design becomes the user's own copy first
      const createsCopy = !!template?.isDefault || (!ownsTemplate && !submitOnBehalf);

      const activeSlug = submitOnBehalf ? template.slug : await saveToDatabase(nameToSave, createsCopy);
      if (!activeSlug) {
        throw new Error("Could not save designer mockup state before submitting");
      }

      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          designName: nameToSave,
          designSlug: activeSlug,
          // On-behalf submissions keep the brief already attached to the designer's design
          ...(submitOnBehalf ? {} : { documentData: attachedDocData || null, documentName: attachedDocName || null })
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Submission failed on server:", errText);
        let errMsg = "Failed to submit approval request";
        try {
          const parsed = JSON.parse(errText);
          if (parsed.message) errMsg = parsed.message;
        } catch (_) {}
        throw new Error(errMsg);
      }

      dirtyRef.current = false;
      toast.success("Design submitted", "The Head of Designer has been notified to review it.");
      fetchApprovalStatus();

      // Open the newly created copy right away (the button stays disabled until the page changes)
      if (createsCopy) {
        navigating = true;
        router.push(`/mockup-detail/${activeSlug}`);
      }
    } catch (e: any) {
      console.error(e);
      toast.error("Failed to submit design for approval", e.message);
    } finally {
      if (!navigating) setSubmittingApproval(false);
    }
  };

  // Review handler: the Head of Designer (or Administrator) or the customer
  const handleReview = async (status: "APPROVED" | "REJECTED", asCustomer = false) => {
    if (!approvalRequest?.id) return;

    if (status === "REJECTED" && !reviewRemarks.trim()) {
      toast.error("Remarks required", asCustomer ? "Please describe the changes you need." : "Please enter remarks explaining the rejection.");
      return;
    }

    setSubmittingReview(true);
    try {
      const res = await fetch(`/api/approvals/${approvalRequest.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          asCustomer
            ? { customerStatus: status, customerRemarks: reviewRemarks }
            : { status, remarks: reviewRemarks }
        ),
      });

      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).message || `Failed to submit review as ${status}`);
      }

      if (asCustomer) {
        toast.success(status === "APPROVED" ? "You approved this design" : "Change request sent", status === "APPROVED" ? "The design team has been notified." : "The design team will update the design.");
      } else {
        toast.success(status === "APPROVED" ? "Design approved" : "Design rejected", status === "APPROVED" ? "You can now share it with a customer." : "The designer has been sent your remarks.");
      }

      setReviewRemarks("");
      fetchApprovalStatus();
    } catch (e: any) {
      console.error(e);
      toast.error("Review submission failed", e.message);
    } finally {
      setSubmittingReview(false);
    }
  };


  return (
    <>
      <header className="h-14 border-b border-slate-200 bg-white flex items-center justify-between px-4 sticky top-0 z-[100] shrink-0 select-none">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 cursor-pointer group" onClick={() => router.push('/')}>
            <img src="/images/logo2.jpg" alt="Icon" className="h-8 w-auto object-contain transition-transform duration-500 ease-out group-hover:scale-105" />
            <img src="/images/logo1-96.png" alt="Gujarat Print Pack Mockup" className="h-8 w-auto object-contain hidden sm:block transition-transform duration-500 ease-out group-hover:scale-110 group-hover:-rotate-6" />
          </div>
          <nav className="hidden md:flex items-center gap-1 ml-4 text-xs font-bold text-slate-400 uppercase tracking-wider">
            <Link href="/" className="px-3 py-1.5 hover:text-slate-600 border-b-2 border-transparent">
              {isCustomer ? "Review Department" : "Library"}
            </Link>
            <span className="px-3 py-1.5 text-slate-900 border-b-2 border-brand-600">Editor</span>
          </nav>

          {template?.name && (
            <div className="hidden lg:flex items-center gap-2 ml-4 px-3 py-1 bg-slate-100 rounded-full border border-slate-200 animate-fade-in">
              <span className="text-[10px] font-bold text-slate-700 tracking-tight truncate max-w-[120px]">{template.name}</span>
              {approvalRequest && (
                <div className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-wider ${
                  approvalRequest.status === "APPROVED"
                    ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                    : approvalRequest.status === "REJECTED"
                    ? "bg-rose-100 text-rose-800 border border-rose-200"
                    : "bg-amber-100 text-amber-800 border border-amber-200"
                }`}
                title={approvalRequest.status === "REJECTED" && approvalRequest.remarks ? `Remarks: "${approvalRequest.remarks}"` : undefined}
                >
                  {approvalRequest.status === "APPROVED" && "✓ Approved"}
                  {approvalRequest.status === "REJECTED" && "✗ Rejected"}
                  {approvalRequest.status === "PENDING" &&
                    `⏳ ${STATUS_LABELS[approvalRequest.status]}`}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Auto-save status */}
          {autosaveMode && saveStatus !== "idle" && (
            <div className="hidden sm:flex items-center gap-1.5 text-[11px] font-semibold text-slate-500" role="status" aria-live="polite">
              {saveStatus === "saving" && (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>)}
              {saveStatus === "pending" && <>Unsaved changes</>}
              {saveStatus === "saved" && (<><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> All changes saved</>)}
              {saveStatus === "error" && (<><AlertCircle className="w-3.5 h-3.5 text-rose-600" /> Couldn&apos;t save, retrying…</>)}
            </div>
          )}

          {/* Designer Approval Button */}
          {isDesigner && (
            <Button
              onClick={handleSubmitApproval}
              disabled={submittingApproval}
              className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5 text-xs font-bold uppercase tracking-wider shadow-sm rounded-md shrink-0 h-9"
            >
              <Send className="w-3.5 h-3.5" />
              {submittingApproval ? "Submitting..." : "Submit for Review"}
            </Button>
          )}

          {/* Export action dropdown */}
          {/* Export action dropdown */}
          <div className="relative">
            <Button
              size="sm"
              onClick={() => setIsExportOpen(!isExportOpen)}
              className="bg-brand-600 hover:bg-brand-700 text-white gap-2 text-xs font-bold uppercase tracking-wider shrink-0 shadow-sm h-9"
            >
              <Download className="w-4 h-4" />
              Export Render
              <ChevronDown className="w-3 h-3 ml-0.5 opacity-60" />
            </Button>

            {/* Invisible backdrop to close dropdown when clicking outside */}
            {isExportOpen && (
              <div
                className="fixed inset-0 z-40"
                onClick={() => setIsExportOpen(false)}
              />
            )}

            {isExportOpen && (
              <div className="absolute right-0 top-full mt-1 w-52 bg-white rounded-lg shadow-xl border border-slate-200 z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
                <button
                  onClick={() => {
                    handleExport();
                    setIsExportOpen(false);
                  }}
                  className="w-full text-left px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-brand-50 hover:text-brand-700 transition-colors flex items-center gap-2.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export as PNG
                </button>
                <div className="h-px bg-slate-100" />
                <button
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('export-glb'));
                    setIsExportOpen(false);
                  }}
                  className="w-full text-left px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-brand-50 hover:text-brand-700 transition-colors flex items-center gap-2.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download 3D Model (.GLB)
                </button>
              </div>
            )}
          </div>

          <span className="text-slate-200">|</span>

          {/* Profile card menu */}
          <UserNav />
        </div>
      </header>

      {/* Review & Remarks bar: Head of Designer / Administrator / assigned customer */}
      {approvalRequest && (() => {
        const status = approvalRequest.status;
        const isAssignedCustomer =
          isCustomer &&
          status === "APPROVED" &&
          approvalRequest.customerEmail?.toLowerCase() === session?.user?.email?.toLowerCase();
        // Heads of Designer can't approve their own designs (another Head or an Administrator must)
        const canReviewStage =
          status === "PENDING" && isReviewer &&
          (isAdministrator || approvalRequest.designerEmail?.toLowerCase() !== session?.user?.email?.toLowerCase());
        const canCustomerDecide = isAssignedCustomer && approvalRequest.customerStatus !== "APPROVED";
        if (!isReviewer && !isAssignedCustomer) return null;

        const dotColor = status === "APPROVED" ? "bg-emerald-500" : status === "REJECTED" ? "bg-rose-500" : "bg-amber-500 animate-pulse";
        const customerDecision =
          approvalRequest.customerStatus === "APPROVED" ? "Customer approved" :
          approvalRequest.customerStatus === "REJECTED" ? "Customer requested changes" :
          approvalRequest.customerEmail ? "Awaiting customer review" : null;

        return (
          <div className="px-4 py-2 bg-slate-50 border-b border-slate-200/80 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs select-none animate-in slide-in-from-top duration-200 z-40 shrink-0 shadow-2xs">
            <div className="flex items-center gap-2.5 flex-wrap">
              {/* Status dot indicator */}
              <div className="flex items-center gap-1.5 bg-white border border-slate-100 rounded-full py-1 px-3 shadow-2xs">
                <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                <span className="font-extrabold text-[9px] text-slate-500 uppercase tracking-widest leading-none">
                  {isAssignedCustomer
                    ? (approvalRequest.customerStatus === "APPROVED" ? "You approved" : approvalRequest.customerStatus === "REJECTED" ? "Changes requested" : "Awaiting your review")
                    : STATUS_LABELS[status] || status}
                </span>
              </div>

              <div className="flex items-center gap-1.5 text-xs text-slate-600 font-semibold tracking-tight flex-wrap">
                {isAssignedCustomer ? (
                  <>
                    <span>Please review this design and approve it or request changes.</span>
                    {approvalRequest.customerRemarks && (
                      <span className="text-slate-400 font-normal italic ml-1">Your remarks: &ldquo;{approvalRequest.customerRemarks}&rdquo;</span>
                    )}
                  </>
                ) : (
                  <>
                    {status === "PENDING" && (
                      <>
                        <span>Submission from</span>
                        <span className="text-slate-900 font-extrabold">{approvalRequest.designerName}</span>
                        <span className="text-slate-400 font-normal">({approvalRequest.designerEmail})</span>
                      </>
                    )}
                    {status === "APPROVED" && <span>This design is approved.</span>}
                    {status === "REJECTED" && <span>This design is rejected.</span>}
                    {approvalRequest.remarks && (
                      <span className={`ml-1 ${status === "REJECTED" ? "text-rose-500 font-bold" : "text-slate-400 font-normal italic"}`}>
                        Head of Designer: &ldquo;{approvalRequest.remarks}&rdquo;
                      </span>
                    )}
                    {/* Remarks from an earlier review step (designs reviewed before the flow was simplified) */}
                    {approvalRequest.headRemarks && (
                      <span className="ml-1 text-slate-400 font-normal italic">
                        Earlier review: &ldquo;{approvalRequest.headRemarks}&rdquo;
                      </span>
                    )}
                    {status === "APPROVED" && customerDecision && (
                      <span className={`ml-1 ${approvalRequest.customerStatus === "REJECTED" ? "text-rose-500 font-bold" : "text-slate-500"}`}>
                        · {customerDecision}
                        {approvalRequest.customerRemarks && <>: &ldquo;{approvalRequest.customerRemarks}&rdquo;</>}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {canShare && status === "APPROVED" && (
                <div className="flex items-center gap-1.5 bg-white border border-slate-200 hover:border-slate-300 rounded-lg px-2.5 py-1.5 shadow-2xs transition-all w-48 select-none">
                  <select
                    aria-label="Share with customer"
                    value={selectedCustomerEmail}
                    onChange={(e) => {
                      const email = e.target.value;
                      setSelectedCustomerEmail(email);
                      handleShareWithCustomer(email);
                    }}
                    disabled={sharingDesign}
                    className="w-full bg-transparent border-0 text-slate-800 focus:outline-none text-[11px] font-bold cursor-pointer"
                  >
                    <option value="">{customers.length ? "Share with Customer" : "No active customer accounts"}</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.email}>
                        {c.name ? `${c.name} (${c.email})` : c.email}
                      </option>
                    ))}
                    {/* Keep the current customer visible even if their account is no longer active */}
                    {selectedCustomerEmail && !customers.some((c) => c.email?.toLowerCase() === selectedCustomerEmail.toLowerCase()) && (
                      <option value={selectedCustomerEmail}>{selectedCustomerEmail} (inactive)</option>
                    )}
                  </select>
                </div>
              )}

              {(canReviewStage || canCustomerDecide) && (
                <>
                  <input
                    type="text"
                    value={reviewRemarks}
                    onChange={(e) => setReviewRemarks(e.target.value)}
                    placeholder={canCustomerDecide ? "Remarks (required to request changes)..." : "Add feedback / remarks (required to reject)..."}
                    className="bg-white border border-slate-200 focus:border-slate-400 rounded-lg px-3 py-1.5 text-xs text-slate-800 placeholder:text-slate-400/80 focus:outline-none focus:ring-0 w-64 shadow-2xs font-medium transition-all"
                  />
                  <Button
                    size="xs"
                    onClick={() => handleReview("APPROVED", canCustomerDecide)}
                    disabled={submittingReview}
                    className="bg-slate-900 hover:bg-slate-800 text-white font-bold px-3.5 py-1.5 uppercase tracking-wider text-[9px] h-8 rounded-lg shadow-2xs transition-colors flex items-center gap-1"
                  >
                    Approve
                  </Button>
                  <Button
                    size="xs"
                    onClick={() => handleReview("REJECTED", canCustomerDecide)}
                    disabled={submittingReview}
                    className="bg-white hover:bg-rose-50 border border-slate-200 hover:border-rose-100 text-slate-600 hover:text-rose-600 font-bold px-3.5 py-1.5 uppercase tracking-wider text-[9px] h-8 rounded-lg shadow-2xs transition-colors"
                  >
                    {canCustomerDecide ? "Request changes" : "Reject"}
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Rejection feedback banner for the designer */}
      {approvalRequest?.status === "REJECTED" && (approvalRequest.remarks || approvalRequest.headRemarks) && isDesigner && !isReviewer && (
        <div className="px-4 py-2 bg-rose-50/50 border-b border-rose-100 flex items-center justify-between text-xs select-none animate-in slide-in-from-top duration-200 z-40 shrink-0 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5 bg-rose-100/60 border border-rose-200 rounded-full py-0.5 px-2.5 shadow-3xs">
              <span className="w-1 h-1 rounded-full bg-rose-500" />
              <span className="font-extrabold text-[8px] text-rose-700 uppercase tracking-wider leading-none">
                Head of Designer feedback
              </span>
            </div>
            <span className="text-slate-700 font-semibold">
              &ldquo;{approvalRequest.remarks || approvalRequest.headRemarks}&rdquo;
            </span>
          </div>
          <span className="hidden sm:inline text-[9px] text-rose-500 font-extrabold tracking-widest uppercase">Please make edits and submit again!</span>
        </div>
      )}

      {/* Customer change request banner for the designer */}
      {approvalRequest?.status === "APPROVED" && approvalRequest.customerStatus === "REJECTED" && isDesigner && !isReviewer && (
        <div className="px-4 py-2 bg-rose-50/50 border-b border-rose-100 flex items-center gap-2.5 text-xs select-none z-40 shrink-0 shadow-2xs">
          <span className="font-extrabold text-[8px] text-rose-700 uppercase tracking-wider">Customer requested changes</span>
          <span className="text-slate-700 font-semibold">&ldquo;{approvalRequest.customerRemarks}&rdquo;</span>
        </div>
      )}

    </>
  );
}
