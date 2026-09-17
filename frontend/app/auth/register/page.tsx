"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Mail, Lock, User, AlertCircle, ArrowRight, ChevronDown } from "lucide-react";

export default function Register() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [accountType, setAccountType] = useState("Customer");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      setLoading(false);
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, accountType }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "Registration failed");
      }

      alert(`Account for ${name} (${accountType}) created successfully!`);
      setName("");
      setEmail("");
      setPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setError(err.message || "An error occurred during registration");
    } finally {
      setLoading(false);
    }
  };

  if (status === "loading") {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  if (!session || (session.user as any)?.accountType !== "Administrator") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md text-center border border-slate-200">
          <AlertCircle className="w-12 h-12 text-rose-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Access Denied</h2>
          <p className="text-slate-500 mt-2 text-sm">Only administrators have permission to create new user accounts.</p>
          <Link href="/" className="mt-6 inline-flex items-center justify-center bg-brand-600 text-white px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-colors hover:bg-brand-700">
            Return Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 py-12 px-4 sm:px-6 lg:px-8 relative overflow-hidden">
      {/* Background patterns */}
      <div className="absolute inset-0 opacity-5 bg-[radial-gradient(#0f172a_1px,transparent_1px)] [background-size:16px_16px]"></div>
      
      <div className="max-w-md w-full space-y-8 bg-white p-8 rounded-2xl border border-slate-200 shadow-xl relative z-10">
        <div>
          <div className="mx-auto h-12 w-12 bg-brand-600 rounded-xl flex items-center justify-center text-white font-black text-xl shadow-md">
            P
          </div>
          <h2 className="mt-6 text-center text-2xl font-black text-slate-900 tracking-tight">
            Create User Account
          </h2>
          <p className="mt-2 text-center text-xs text-slate-400">
            As an administrator, you can register new users to the platform
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg flex items-start gap-2 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold">Error: </span>
              {error}
            </div>
          </div>
        )}

        <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-3">
            {/* Full Name */}
            <div>
              <label htmlFor="name" className="sr-only">
                Full Name
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  id="name"
                  name="name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="appearance-none rounded-lg relative block w-full pl-10 pr-3 py-2.5 border border-slate-200 placeholder-slate-400 text-slate-950 focus:outline-none focus:ring-brand-500 focus:border-brand-500 text-sm"
                  placeholder="Full Name"
                />
              </div>
            </div>

            {/* Email Address */}
            <div>
              <label htmlFor="email-address" className="sr-only">
                Email address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Mail className="w-4 h-4" />
                </div>
                <input
                  id="email-address"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="appearance-none rounded-lg relative block w-full pl-10 pr-3 py-2.5 border border-slate-200 placeholder-slate-400 text-slate-950 focus:outline-none focus:ring-brand-500 focus:border-brand-500 text-sm"
                  placeholder="Email address"
                />
              </div>
            </div>

            {/* Account Type Selector */}
            <div>
              <label htmlFor="account-type" className="sr-only">
                Account Type
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <select
                  id="account-type"
                  name="accountType"
                  required
                  value={accountType}
                  onChange={(e) => setAccountType(e.target.value)}
                  className="appearance-none rounded-lg relative block w-full pl-10 pr-10 py-2.5 border border-slate-200 text-slate-950 focus:outline-none focus:ring-brand-500 focus:border-brand-500 text-sm bg-white cursor-pointer"
                >
                  <option value="Administrator">Administrator</option>
                  <option value="Designer">Designer</option>
                  <option value="Head of Designer">Head of Designer</option>
                  <option value="Customer">Customer</option>
                </select>
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-slate-400">
                  <ChevronDown className="w-4 h-4" />
                </div>
              </div>
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="sr-only">
                Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="appearance-none rounded-lg relative block w-full pl-10 pr-3 py-2.5 border border-slate-200 placeholder-slate-400 text-slate-950 focus:outline-none focus:ring-brand-500 focus:border-brand-500 text-sm"
                  placeholder="Password"
                />
              </div>
            </div>

            {/* Confirm Password */}
            <div>
              <label htmlFor="confirmPassword" className="sr-only">
                Confirm Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="appearance-none rounded-lg relative block w-full pl-10 pr-3 py-2.5 border border-slate-200 placeholder-slate-400 text-slate-950 focus:outline-none focus:ring-brand-500 focus:border-brand-500 text-sm"
                  placeholder="Confirm Password"
                />
              </div>
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2.5 px-4 border border-transparent text-xs font-bold uppercase tracking-wider text-white bg-brand-600 hover:bg-brand-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors shadow-sm disabled:opacity-50"
            >
              {loading ? (
                "Creating Account..."
              ) : (
                <span className="flex items-center gap-1">
                  Create Account <ArrowRight className="w-3.5 h-3.5" />
                </span>
              )}
            </button>
          </div>
        </form>

        <div className="pt-4 border-t border-slate-100 text-center">
          <Link
            href="/"
            className="text-xs font-bold text-slate-500 hover:text-slate-700 transition-colors"
          >
            &larr; Back to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
