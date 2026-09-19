/**
 * Admin session token handling.
 *
 * The admin dashboard and the storefront are the same React app (src/App.tsx),
 * and admin API calls are spread across a dozen components that all use bare
 * `fetch`. Rather than hunt down every call site — where a single miss is an
 * admin feature that silently 401s — the token is attached by a one-time wrapper
 * around `window.fetch`.
 *
 * The wrapper only adds the header when:
 *   - a token is actually stored (so ordinary shoppers send nothing), and
 *   - the request is same-origin and under /api/ (so the token is never sent to
 *     a third party), and
 *   - the caller has not already set its own Authorization header (so the
 *     customer Google flow is left alone).
 */

const TOKEN_KEY = 'ps_admin_token';

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // Private mode or blocked storage. Treated as "not signed in".
    return null;
  }
}

export function setAdminToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    console.warn('[Admin Auth] Could not persist the admin token; storage is unavailable.');
  }
}

export function clearAdminToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Resolves a request input to a URL string without throwing on odd inputs. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request)?.url || '';
}

function isSameOriginApiCall(rawUrl: string): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl, window.location.origin);
    if (url.origin !== window.location.origin) return false;
    return url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

let installed = false;

/**
 * Installs the wrapper. Safe to call more than once — a second call is ignored,
 * which matters because React 18 StrictMode mounts effects twice in development
 * and double-wrapping would nest the patches.
 */
export function installAdminFetch(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = getAdminToken();
    if (!token || !isSameOriginApiCall(urlOf(input))) {
      return originalFetch(input, init);
    }

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    // Never overwrite an Authorization the caller set deliberately — the
    // customer Google sign-in sends its own bearer token to /api/auth.
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    return originalFetch(input, { ...init, headers });
  };
}

export interface AdminLoginResult {
  ok: boolean;
  /** Message suitable for showing to the person trying to sign in. */
  message?: string;
}

/**
 * Exchanges credentials for a signed token.
 *
 * The dashboard previously compared `admin`/`admin` in the browser and told
 * itself it was authenticated, which no server endpoint ever checked. The check
 * now happens server-side and yields a token the API will actually accept.
 */
export async function adminLogin(email: string, password: string): Promise<AdminLoginResult> {
  let response: Response;
  try {
    response = await fetch('/api/customers/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
  } catch {
    return { ok: false, message: 'Could not reach the server. Check your connection and try again.' };
  }

  const data = await response.json().catch(() => null);

  if (response.ok && data?.token) {
    setAdminToken(data.token);
    return { ok: true };
  }

  if (data?.code === 'ADMIN_AUTH_NOT_CONFIGURED') {
    return {
      ok: false,
      message:
        'Admin sign-in is not configured on the server. Set AUTH_SECRET, ADMIN_EMAIL and ADMIN_PASSWORD, then redeploy.'
    };
  }

  return { ok: false, message: data?.error || 'Invalid admin credentials.' };
}
