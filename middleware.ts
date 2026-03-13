import { auth } from '@/lib/auth/server';

export default auth.middleware({
  loginUrl: '/auth/sign-in',
});

export const config = {
  matcher: [
    // Protect the main portal — unauthenticated users get redirected to sign-in
    '/((?!auth|api|_next/static|_next/image|favicon.ico).*)',
  ],
};
