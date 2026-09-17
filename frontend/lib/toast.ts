"use client";

import { create } from "zustand";

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  title: string;
  message?: string;
  tone: ToastTone;
  href?: string;
}

interface ToastState {
  toasts: Toast[];
  show: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

/** Popup notifications shown at the top of the screen (see components/ui/Toaster.tsx). */
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: (toast) => {
    const id = nextId++;
    // Keep at most 4 popups on screen
    set((state) => ({ toasts: [...state.toasts.slice(-3), { ...toast, id }] }));
    setTimeout(() => get().dismiss(id), toast.tone === "error" ? 9000 : 6000);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (title: string, message?: string, href?: string) => useToastStore.getState().show({ title, message, tone: "success", href }),
  error: (title: string, message?: string) => useToastStore.getState().show({ title, message, tone: "error" }),
  info: (title: string, message?: string, href?: string) => useToastStore.getState().show({ title, message, tone: "info", href }),
};
