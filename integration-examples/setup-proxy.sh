#!/bin/bash

echo "Setting up the Supabase-AFFiNE Proxy"
echo "===================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js and npm first."
    exit 1
fi

# Create package.json if it doesn't exist
if [ ! -f "package.json" ]; then
    echo "Creating package.json..."
    npm init -y
fi

# Install dependencies
echo "Installing required packages..."
npm install express http-proxy-middleware @supabase/supabase-js cookie-parser

echo ""
echo "Setup complete! Here's how to run the proxy:"
echo ""
echo "1. Set your Supabase environment variables:"
echo "   export SUPABASE_URL=\"https://your-project.supabase.co\""
echo "   export SUPABASE_ANON_KEY=\"your-anon-key\""
echo ""
echo "2. Set your AFFiNE backend URL (default is http://localhost:8080):"
echo "   export AFFINE_BACKEND_URL=\"http://your-affine-backend:port\""
echo ""
echo "3. Run the proxy:"
echo "   node supabase-auth-proxy.js"
echo ""
echo "4. In your Next.js app's .env.local file, add:"
echo "   NEXT_PUBLIC_AFFINE_PROXY_URL=http://localhost:3001"
echo ""
echo "Now your iframe integration should work properly with Supabase authentication!"
echo "" 