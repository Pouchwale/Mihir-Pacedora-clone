import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { UserManagementSection } from "@/components/dashboard/UserManagement";

// Same user management as the admin home page, so both stay in sync
export default function AdminUsersDashboard() {
  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        <Link href="/" className="inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-slate-800 mb-4 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to Library
        </Link>
        <UserManagementSection />
      </div>
    </div>
  );
}
