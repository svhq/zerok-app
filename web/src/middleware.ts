import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Middleware for hostname-based routing.
 *
 * Routes:
 * - zerok.app / www.zerok.app → Landing page (/landing)
 * - devnet.zerok.app → App dashboard (/)
 * - testnet.zerok.app → App dashboard (/)
 * - localhost → App dashboard (/) for development
 */
export function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') || '';
  const { pathname } = request.nextUrl;

  // Landing page hostnames (main domain without subdomain)
  const isLandingHost =
    hostname === 'zerok.app' ||
    hostname === 'www.zerok.app' ||
    hostname.startsWith('zerok-') && hostname.includes('.vercel.app'); // Vercel preview for main domain

  // If on landing host and accessing root, rewrite to /landing
  if (isLandingHost && pathname === '/') {
    const url = request.nextUrl.clone();
    url.pathname = '/landing';
    return NextResponse.rewrite(url);
  }

  // All other requests pass through normally
  return NextResponse.next();
}

// Only run middleware on specific paths (performance optimization)
export const config = {
  matcher: [
    // Match root path only (landing page redirect)
    '/',
  ],
};
