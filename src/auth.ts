const COOKIE_NAME = "s";
const COOKIE_MAX_AGE = 365 * 86_400;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(digest);
}

// Ruby: OpenSSL::HMAC.hexdigest('SHA256', SECRET, 'ok') where SECRET is itself a hex
// *string* — Ruby's OpenSSL uses that string's raw ASCII bytes as the HMAC key, not the
// hex-decoded binary. Match that here by encoding keyHex as text, not as hex-decoded bytes.
async function hmacSha256Hex(keyHex: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(sig);
}

// Same derivation as app.rb: SECRET = SHA256("slakteri:" + password); TOKEN = HMAC-SHA256(SECRET, "ok").
export async function computeToken(password: string): Promise<string> {
  const secret = await sha256Hex(`slakteri:${password}`);
  return hmacSha256Hex(secret, "ok");
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("Cookie");
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function isAuthed(request: Request, token: string): boolean {
  return parseCookies(request)[COOKIE_NAME] === token;
}

export function setAuthCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure ? "; Secure" : ""}`;
}

export function clearAuthCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isHttps(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}
