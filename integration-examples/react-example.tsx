'use client';
import React, { useEffect, useState } from 'react';
import { createClient, type User } from '@supabase/supabase-js';

// Initialize Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://your-supabase-url',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'your-supabase-anon-key'
);

// Get the proxy URL from env var or use default
const AFFINE_PROXY_URL =
  process.env.NEXT_PUBLIC_AFFINE_PROXY_URL || 'http://localhost:3001';

interface UserSession {
  user: User | null;
  accessToken: string | null;
  loading: boolean;
  error: string | null;
}

export default function AffineIframePage() {
  const [session, setSession] = useState<UserSession>({
    user: null,
    accessToken: null,
    loading: true,
    error: null,
  });

  // Set up Supabase auth listener
  useEffect(() => {
    // Get initial session
    const getInitialSession = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();

        if (error) {
          setSession(prev => ({
            ...prev,
            error: error.message,
            loading: false,
          }));
          return;
        }

        setSession({
          user: data.session?.user || null,
          accessToken: data.session?.access_token || null,
          loading: false,
          error: null,
        });
      } catch (error) {
        console.error('Error getting session:', error);
        setSession(prev => ({
          ...prev,
          error: 'Failed to get session',
          loading: false,
        }));
      }
    };

    getInitialSession();

    // Set up auth listener
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession({
        user: session?.user || null,
        accessToken: session?.access_token || null,
        loading: false,
        error: null,
      });
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Show loading state
  if (session.loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-56px)] w-full">
        <div className="animate-pulse">Loading...</div>
      </div>
    );
  }

  // Show login form if not signed in
  if (!session.user || !session.accessToken) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-56px)] w-full gap-4">
        <h2 className="text-xl font-semibold">Please sign in to view AFFiNE</h2>
        <p className="text-sm text-gray-600">
          You need to authenticate with Supabase to access your workspaces
        </p>
        <button
          onClick={() => supabase.auth.signInWithOAuth({ provider: 'google' })}
          className="px-4 py-2 rounded bg-blue-500 text-white hover:bg-blue-600"
        >
          Sign in with Google
        </button>
      </div>
    );
  }

  // Build the iframe URL with token parameter
  const iframeUrl = new URL(AFFINE_PROXY_URL);
  iframeUrl.searchParams.append('token', session.accessToken);

  return (
    <div className="w-full h-screen flex flex-col">
      {/* Header bar with user info */}
      <header className="bg-white border-b p-2 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span className="font-medium">Signed in as:</span>
          <span>{session.user.email}</span>
        </div>
        <button
          onClick={() => supabase.auth.signOut()}
          className="px-3 py-1 text-sm rounded bg-gray-100 hover:bg-gray-200"
        >
          Sign out
        </button>
      </header>

      {/* AFFiNE iframe */}
      <div className="flex-1 overflow-hidden">
        <iframe
          src={iframeUrl.toString()}
          width="100%"
          height="100%"
          style={{
            border: 'none',
            height: '100%',
            display: 'block',
          }}
          title="AFFiNE"
        />
      </div>
    </div>
  );
}
