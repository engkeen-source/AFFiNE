const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createClient } = require('@supabase/supabase-js');
const cookieParser = require('cookie-parser');
const crypto = require('node:crypto');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://your-project.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'your-anon-key'
);

const app = express();
const PORT = process.env.PORT || 3001;
const AFFINE_BACKEND_URL =
  process.env.AFFINE_BACKEND_URL || 'http://localhost:8080';

// Simple in-memory session store
const sessions = new Map();

// Parse cookies and query parameters
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Middleware to inject Supabase user ID
async function injectSupabaseUserId(req, res, next) {
  try {
    // Get auth token from various sources:
    // 1. URL query parameter (for iframe integration)
    // 2. Authorization header
    // 3. Cookies
    const queryToken = req.query.token;
    const authHeader = req.headers.authorization;
    const cookieToken = req.cookies?.supabase_auth_token;

    // Use the first available token source
    const token =
      queryToken || authHeader?.replace('Bearer ', '') || cookieToken;
    const sessionCookie = req.cookies.proxy_session_id;

    // If a token is present, always verify it to get the latest user
    if (token) {
      console.log('[AUTH] Token found, verifying with Supabase...');
      try {
        // Verify the token with Supabase
        const { data, error } = await supabase.auth.getUser(token);
        const user = data?.user;

        if (user && !error) {
          // Create a unique session ID that includes the user ID
          const newSessionId = crypto
            .createHash('md5')
            .update(`${user.id}-${Date.now()}`)
            .digest('hex');

          console.log(
            `[AUTH] User authenticated: ${user.id} (${user.email || 'no email'})`
          );
          console.log(`[AUTH] Creating new session: ${newSessionId}`);

          // Store session data in memory with the token hash to detect changes
          sessions.set(newSessionId, {
            userId: user.id,
            email: user.email,
            metadata: JSON.stringify({
              name:
                user.user_metadata?.full_name ||
                user.email?.split('@')[0] ||
                'Unknown User',
              avatar: user.user_metadata?.avatar_url,
            }),
            tokenHash: crypto.createHash('md5').update(token).digest('hex'),
          });

          // Inject the user ID header
          req.headers['x-supabase-user-id'] = user.id;

          // Optional: Also inject user email and name for better user creation
          if (user.email) {
            req.headers['x-supabase-user-email'] = user.email;
          }

          const metadata = {
            name:
              user.user_metadata?.full_name ||
              user.email?.split('@')[0] ||
              'Unknown User',
            avatar: user.user_metadata?.avatar_url,
          };

          req.headers['x-supabase-user-metadata'] = JSON.stringify(metadata);

          // Set a cookie to maintain the session
          res.cookie('proxy_session_id', newSessionId, {
            httpOnly: true,
            secure: false, // Set to true in production with HTTPS
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
          });

          // For debugging: Clean up old session if it exists
          if (sessionCookie && sessions.has(sessionCookie)) {
            const oldSession = sessions.get(sessionCookie);
            console.log(
              `[AUTH] Replacing old session for user: ${oldSession.userId} with new user: ${user.id}`
            );
            sessions.delete(sessionCookie);
          }

          next();
          return;
        } else if (error) {
          console.error('[AUTH] Error verifying token:', error.message);
          // Continue to check session cookie as fallback
        }
      } catch (error) {
        console.error('[AUTH] Failed to verify Supabase token:', error);
        // Continue to check session cookie as fallback
      }
    }

    // No valid token or token verification failed, try using session cookie
    if (sessionCookie && sessions.has(sessionCookie)) {
      const sessionData = sessions.get(sessionCookie);
      console.log(
        `[SESSION] Using cached user ID: ${sessionData.userId} from session: ${sessionCookie}`
      );

      // Apply the user ID from the session to this request
      req.headers['x-supabase-user-id'] = sessionData.userId;
      if (sessionData.email) {
        req.headers['x-supabase-user-email'] = sessionData.email;
      }
      if (sessionData.metadata) {
        req.headers['x-supabase-user-metadata'] = sessionData.metadata;
      }

      next();
      return;
    }

    console.log('[AUTH] No authentication found (no token or valid session)');
    next();
  } catch (err) {
    console.error('[ERROR] Error in injectSupabaseUserId middleware:', err);
    next();
  }
}

// Clean up expired sessions periodically
setInterval(
  () => {
    const now = Date.now();
    let count = 0;

    sessions.forEach((session, id) => {
      if (session.expiresAt && session.expiresAt < now) {
        sessions.delete(id);
        count++;
      }
    });

    if (count > 0) {
      console.log(`[CLEANUP] Removed ${count} expired sessions`);
    }
  },
  60 * 60 * 1000
); // Run every hour

// Apply middleware to all requests
app.use(injectSupabaseUserId);

// Special handling for the auth session endpoint which creates users
app.use('/api/auth/session', (req, res, next) => {
  if (req.headers['x-supabase-user-id']) {
    console.log(
      `[API] Auth session request with user ID: ${req.headers['x-supabase-user-id']}`
    );
  } else {
    console.log('[API] Auth session request without user ID');
  }
  next();
});

// Proxy all requests to AFFiNE backend
app.use(
  '/',
  createProxyMiddleware({
    target: AFFINE_BACKEND_URL,
    changeOrigin: true,
    ws: true, // Enable WebSocket proxy
    onProxyReq: (proxyReq, req, _res) => {
      const userId = req.headers['x-supabase-user-id'];
      const path = req.path || req.url?.split('?')[0] || '';

      // Force the x-supabase-user-id header for API requests even if middleware didn't catch it
      if (userId && (path.startsWith('/api/') || path.startsWith('/graphql'))) {
        console.log(`[PROXY] API call to ${path} with user ID: ${userId}`);
        proxyReq.setHeader('x-supabase-user-id', userId);
      } else if (path.startsWith('/api/') || path.startsWith('/graphql')) {
        console.log(`[PROXY] API call to ${path} WITHOUT user ID`);
      }
    },
  })
);

app.listen(PORT, () => {
  console.log(`Supabase-AFFiNE proxy running on port ${PORT}`);
  console.log(`Proxying to AFFiNE backend at ${AFFINE_BACKEND_URL}`);
});
