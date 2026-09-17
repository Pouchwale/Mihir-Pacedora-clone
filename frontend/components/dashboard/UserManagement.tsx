"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Users, Plus, ShieldAlert, ArrowLeft, Key, X, Loader2, PowerOff, Trash2 } from "lucide-react";

export function UserManagementSection() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Password change state
  const [changingPasswordId, setChangingPasswordId] = useState<string | null>(null);
  const [changingPasswordName, setChangingPasswordName] = useState<string>("");
  const [newPassword, setNewPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/auth/signin");
    } else if (status === "authenticated") {
      if ((session?.user as any)?.accountType !== "Administrator") {
        router.push("/");
      } else {
        fetchUsers();
      }
    }
  }, [status, session, router]);

  const fetchUsers = async () => {
    try {
      const res = await fetch("/api/users");
      if (!res.ok) throw new Error("Failed to load users");
      setUsers(await res.json());
      setLoadError(null);
    } catch (e) {
      console.error("Failed to fetch users", e);
      setLoadError("Could not load accounts. Please refresh the page.");
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters long.");
      return;
    }
    
    setIsChangingPassword(true);
    setPasswordError(null);
    
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: changingPasswordId, newPassword }),
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to update password");
      }
      
      // Success
      setChangingPasswordId(null);
      setNewPassword("");
      alert("Password updated successfully.");
    } catch (err: any) {
      setPasswordError(err.message || "An error occurred");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleChangeAccountType = async (id: string, name: string, accountType: string) => {
    if (!confirm(`Change ${name}'s account type to ${accountType}?`)) return;
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, accountType }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Failed to change account type");
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, accountType } : u)));
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, isActive: !currentStatus }),
      });
      if (res.ok) {
        setUsers(users.map(u => u.id === id ? { ...u, isActive: !currentStatus } : u));
      } else {
        const data = await res.json();
        alert(data.message || "Failed to update status");
      }
    } catch (e) {
      console.error("Failed to toggle status", e);
      alert("An error occurred");
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to permanently delete the account for ${name}? This action cannot be undone.`)) {
      return;
    }
    
    try {
      const res = await fetch(`/api/users?id=${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setUsers(users.filter(u => u.id !== id));
      } else {
        const data = await res.json();
        alert(data.message || "Failed to delete account");
      }
    } catch (e) {
      console.error("Failed to delete account", e);
      alert("An error occurred");
    }
  };

  const getBadgeStyle = (type: string) => {
    switch (type) {
      case "Administrator": return "bg-purple-100 text-purple-800 border-purple-200";
      case "Designer": return "bg-blue-100 text-blue-800 border-blue-200";
      case "Head of Designer": return "bg-teal-100 text-teal-800 border-teal-200";
      default: return "bg-slate-100 text-slate-800 border-slate-200";
    }
  };

  if (loading || status === "loading") {
    return (
      <div className="flex items-center justify-center p-12 bg-white rounded-xl border border-slate-200 shadow-sm">
        <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="w-full">
      <div>
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
              <ShieldAlert className="w-6 h-6 text-brand-600" />
              User Management
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              View all active accounts and create new ones for your team.
            </p>
          </div>
          <Link
            href="/auth/register"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold uppercase tracking-wider rounded-lg transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Create Account
          </Link>
        </div>

        {/* Users Table */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-4 font-bold text-slate-700 uppercase tracking-wider text-[11px]">Name</th>
                  <th className="px-6 py-4 font-bold text-slate-700 uppercase tracking-wider text-[11px]">Email</th>
                  <th className="px-6 py-4 font-bold text-slate-700 uppercase tracking-wider text-[11px]">Account Type</th>
                  <th className="px-6 py-4 font-bold text-slate-700 uppercase tracking-wider text-[11px]">Status</th>
                  <th className="px-6 py-4 font-bold text-slate-700 uppercase tracking-wider text-[11px]">Joined Date</th>
                  <th className="px-6 py-4 font-bold text-slate-700 uppercase tracking-wider text-[11px] text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-slate-400">
                      {loadError || "No accounts found."}
                    </td>
                  </tr>
                ) : (
                  users.map((user) => (
                    <tr key={user.id} className={`hover:bg-slate-50/50 transition-colors group ${!user.isActive ? 'opacity-75' : ''}`}>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full border flex items-center justify-center ${user.isActive ? 'bg-slate-100 border-slate-200 text-slate-600' : 'bg-red-50 border-red-100 text-red-500'}`}>
                            <Users className="w-4 h-4" />
                          </div>
                          <span className={`font-bold ${user.isActive ? 'text-slate-900' : 'text-slate-500'}`}>{user.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-slate-600">{user.email}</td>
                      <td className="px-6 py-4">
                        {user.id === (session?.user as any)?.id ? (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest border ${getBadgeStyle(user.accountType)}`}>
                            {user.accountType} (you)
                          </span>
                        ) : (
                          <select
                            aria-label={`Account type for ${user.name}`}
                            value={user.accountType || "Customer"}
                            onChange={(e) => handleChangeAccountType(user.id, user.name, e.target.value)}
                            className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest border cursor-pointer ${getBadgeStyle(user.accountType)}`}
                          >
                            {["Customer", "Designer", "Head of Designer", "Administrator"].map((type) => (
                              <option key={type} value={type}>{type}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest border ${user.isActive ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : 'bg-red-100 text-red-800 border-red-200'}`}>
                          {user.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-slate-500 text-xs">
                        {new Date(user.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                          
                          {user.id !== (session?.user as any)?.id && (
                            <>
                              <button
                                onClick={() => handleToggleActive(user.id, user.isActive)}
                                className={`inline-flex items-center justify-center px-3 py-1.5 text-xs font-bold border rounded-md transition-colors ${user.isActive ? 'text-orange-600 bg-orange-50 hover:bg-orange-100 border-orange-200' : 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100 border-emerald-200'}`}
                                title={user.isActive ? "Deactivate Account" : "Activate Account"}
                              >
                                <PowerOff className="w-3.5 h-3.5" />
                              </button>

                              <button
                                onClick={() => handleDelete(user.id, user.name)}
                                className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-bold text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-md transition-colors"
                                title="Delete Account"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}

                          <button
                            onClick={() => {
                              setChangingPasswordId(user.id);
                              setChangingPasswordName(user.name);
                              setNewPassword("");
                              setPasswordError(null);
                            }}
                            className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-bold text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-md transition-colors"
                            title="Change Password"
                          >
                            <Key className="w-3.5 h-3.5" />
                          </button>
                          
                          {user.accountType !== "Administrator" && user.isActive && (
                            <button
                              onClick={async () => {
                                try {
                                  const res = await fetch("/api/admin/impersonate-token", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ email: user.email }),
                                  });
                                  if (!res.ok) {
                                    const data = await res.json();
                                    alert(data.error || "Failed to authorize account access.");
                                    return;
                                  }
                                  const { token } = await res.json();
                                  
                                  // Logging in as a user replaces this browser's session in every tab,
                                  // so switch in this tab; "Return to Admin" in the banner switches back.
                                  if (!confirm(`Log in as ${user.email}? Use "Return to Admin" in the red banner to switch back.`)) return;
                                  window.location.href = `/admin/impersonate?email=${encodeURIComponent(user.email)}&token=${encodeURIComponent(token)}`;
                                } catch (err) {
                                  console.error("Failed to impersonate", err);
                                  alert("An error occurred while preparing account access.");
                                }
                              }}
                              className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-bold text-brand-600 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-md transition-colors cursor-pointer"
                              title="Access Account in Popup"
                            >
                              Access
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Change Password Modal */}
      {changingPasswordId && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden border border-slate-100 flex flex-col animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-150 flex items-center justify-between">
              <div>
                <h3 className="text-base font-extrabold text-slate-900 tracking-tight">Change Password</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">For {changingPasswordName}</p>
              </div>
              <button 
                onClick={() => setChangingPasswordId(null)}
                className="p-1.5 hover:bg-slate-200 rounded-lg text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handlePasswordSubmit} className="p-6 space-y-4">
              {passwordError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-bold text-red-600">
                  ⚠️ {passwordError}
                </div>
              )}
              
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider block">New Password</label>
                <input
                  type="password"
                  required
                  placeholder="Enter new password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 hover:bg-slate-100/50 focus:bg-white border border-slate-200 focus:border-brand-500 rounded-lg text-sm text-slate-800 focus:outline-none transition-all placeholder:text-slate-400 focus:ring-1 focus:ring-brand-500/20"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100 mt-6">
                <button
                  type="button"
                  disabled={isChangingPassword}
                  onClick={() => setChangingPasswordId(null)}
                  className="px-4 py-2 text-xs font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isChangingPassword}
                  className="px-4 py-2 text-xs font-bold text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-all shadow-md shadow-brand-500/10 disabled:opacity-50 flex items-center gap-1.5"
                >
                  {isChangingPassword ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Update Password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
