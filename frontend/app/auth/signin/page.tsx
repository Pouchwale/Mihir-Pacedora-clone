"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { User, Lock, AlertCircle, ArrowRight, ChevronDown } from "lucide-react";

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountType, setAccountType] = useState("Customer");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const result = await signIn("credentials", {
        redirect: false,
        email,
        password,
        accountType,
      });

      if (result?.error) {
        setError(result.error);
      } else {
        router.push("/");
        router.refresh();
      }
    } catch (err) {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 py-12 px-4 sm:px-6 lg:px-8 relative overflow-hidden">
      {/* Background patterns */}
      <div className="absolute inset-0 opacity-5 bg-[radial-gradient(#0f172a_1px,transparent_1px)] [background-size:16px_16px]"></div>
      
      <div className="max-w-md w-full space-y-8 bg-white p-8 rounded-2xl border border-slate-200 shadow-xl relative z-10">
        <div>
          <div className="mx-auto flex justify-center items-center gap-2 group cursor-pointer">
            <img src="/images/logo2.jpg" alt="Icon" className="h-12 w-auto object-contain transition-transform duration-500 ease-out group-hover:scale-105" />
            <img src="/images/logo1-96.png" alt="Gujarat Print Pack Mockup" className="h-12 w-auto object-contain transition-transform duration-500 ease-out group-hover:scale-110 group-hover:-rotate-6" />
          </div>
          <h2 className="mt-6 text-center text-2xl font-black text-slate-900 tracking-tight">
            Sign in to Gujarat Print Pack Mockup
          </h2>
          <p className="mt-2 text-center text-xs text-slate-400">
            Access your private 3D product customization space
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg flex items-start gap-2 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold">Authentication failed: </span>
              {error}
            </div>
          </div>
        )}

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4 rounded-md shadow-sm">
            {/* User ID Field */}
            <div>
              <label htmlFor="email-address" className="sr-only">
                User ID
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  id="email-address"
                  name="email"
                  type="text"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="appearance-none rounded-lg relative block w-full pl-10 pr-3 py-2.5 border border-slate-200 placeholder-slate-400 text-slate-950 focus:outline-none focus:ring-brand-500 focus:border-brand-500 text-sm"
                  placeholder="User ID"
                />
              </div>
            </div>

            {/* Account Types Dropdown */}
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

            {/* Password Field */}
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
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="appearance-none rounded-lg relative block w-full pl-10 pr-3 py-2.5 border border-slate-200 placeholder-slate-400 text-slate-950 focus:outline-none focus:ring-brand-500 focus:border-brand-500 text-sm"
                  placeholder="Password"
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
                "Signing In..."
              ) : (
                <span className="flex items-center gap-1">
                  Sign In <ArrowRight className="w-3.5 h-3.5" />
                </span>
              )}
            </button>
          </div>
        </form>

        <div className="pt-4 border-t border-slate-100 text-center">
          <p className="text-xs text-slate-400">
            Don&apos;t have an account yet?{" "}
            <Link
              href="/auth/register"
              className="font-bold text-brand-600 hover:text-brand-700 transition-colors"
            >
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
