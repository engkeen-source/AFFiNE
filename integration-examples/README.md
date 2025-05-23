# Integrating Supabase Auth with AFFiNE

This guide explains how to use Supabase authentication with AFFiNE, allowing your users to authenticate through Supabase instead of using AFFiNE's built-in authentication.

## Overview

We've modified AFFiNE to accept a Supabase user ID via a custom HTTP header, bypassing AFFiNE's internal authentication. This allows you to:

1. Handle user authentication entirely through Supabase
2. Pass the authenticated user ID to AFFiNE
3. AFFiNE will use this ID for all user-specific data and permissions

## Architecture Options

You have two main options for implementation:

### Option 1: Direct Frontend Integration (Simplest)

- Your frontend application authenticates users with Supabase
- The frontend then injects the Supabase user ID into all requests to AFFiNE
- Best for single-page applications where you control the frontend

### Option 2: Proxy Server (More Robust)

- A proxy server sits between your application and AFFiNE
- It verifies Supabase tokens and injects user IDs into requests
- Better for multiple frontends or when you want centralized auth handling

## Prerequisites

- A Supabase account and project
- AFFiNE backend server with auth modifications
- Node.js and npm/yarn for the proxy server (if using Option 2)

## Setup Instructions

### Backend Modifications (Already Done)

AFFiNE's backend has been modified to:

1. Check for the `x-supabase-user-id` header in all requests
2. Auto-create users if they don't exist
3. Use the ID for all authorization decisions

### Option 1: Direct Frontend Integration

1. Install Supabase JS client in your React app:

````bash
npm install @supabase/supabase-js```
2. Copy the `AffineSupabaseProvider.jsx` component to your project
3. Wrap your application with this provider:

```jsx
// In your app's entry point (e.g., App.js or index.js)
import { AffineSupabaseProvider } from './path/to/AffineSupabaseProvider';

function App() {
  return (
    <AffineSupabaseProvider>
      {/* Your app components */}
    </AffineSupabaseProvider>
  );
}```
4. Use the auth hooks to manage Supabase authentication:

```jsx
import { useSupabaseAuth } from './path/to/AffineSupabaseProvider';

function LoginComponent() {
  const { signIn, signUp, user, loading, signOut } = useSupabaseAuth();

  // Your login UI and logic here
}
````

### Option 2: Proxy Server Setup

1. Install required dependencies:

````bash
npm install express http-proxy-middleware @supabase/supabase-js```
2. Copy the `supabase-auth-proxy.js` file to your project
3. Configure environment variables:```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
AFFINE_BACKEND_URL=http://localhost:3010
PORT=3001```

4. Run the proxy server:

```bash
node supabase-auth-proxy.js```

5. Configure your clients to use the proxy URL instead of directly accessing AFFiNE

## Testing Your Integration

### 1. Test User Authentication

- Sign up/in using Supabase in your frontend
- Check that you get a valid Supabase user ID

### 2. Test AFFiNE API Access

- Make a request to an AFFiNE API endpoint (e.g., fetching workspaces)
- Verify the request includes the `x-supabase-user-id` header
- Confirm the response indicates successful authentication

### 3. New User Test

- Create a new user in Supabase
- Have them authenticate in your app
- Check that they can access AFFiNE without any additional sign-up

## Troubleshooting

### Common Issues:

1. **401 Unauthorized responses**:
   - Check that the `x-supabase-user-id` header is being sent
   - Verify the user ID format is correct
   - Ensure the header name is exactly `x-supabase-user-id`

2. **User creation issues**:
   - Check the backend logs for any errors during auto-creation
   - Verify your Supabase user has necessary attributes

3. **Token verification errors**:
   - Ensure your Supabase project URL and keys are correct
   - Check token expiration time

## Security Considerations

- In production, ensure all connections use HTTPS
- Consider implementing additional checks for the validity of the Supabase user ID
- Review AFFiNE's permissions model to ensure proper access control

## Example Implementation

See the included files:
- `react-supabase-auth/AffineSupabaseProvider.jsx` - Main auth provider
- `react-supabase-auth/AffineWithSupabaseAuth.jsx` - Example implementation
- `supabase-auth-proxy.js` - Proxy server implementation

## Next Steps

- Add custom user profile syncing between Supabase and AFFiNE
- Implement more sophisticated permission models
- Consider adding webhook integration for user lifecycle events
````
